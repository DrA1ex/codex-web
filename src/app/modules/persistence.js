'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { VERSION } = require('../../shared/config');
const {
  nowIso,
  sha256,
  ensureDirSync,
  stripTrailingSep,
  isPidAlive,
} = require('../../shared/utils');
const {
  normalizeQueueItem,
  normalizeQueueOrder,
} = require('../../queue');

function queueBackupPath(queuePath) {
  return `${queuePath}.bak`;
}

async function syncDir(dir) {
  let handle;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch (_) {
    // Some filesystems/platforms do not allow fsync on directories.
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function writeFileDurably(filePath, content) {
  const dir = path.dirname(filePath);
  ensureDirSync(dir);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  let handle;
  try {
    handle = await fsp.open(tmp, 'w', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tmp, filePath);
    await syncDir(dir);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function copyFileDurably(sourcePath, targetPath) {
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fsp.copyFile(sourcePath, tmp);
    let handle;
    try {
      handle = await fsp.open(tmp, 'r');
      await handle.sync();
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    await fsp.rename(tmp, targetPath);
    await syncDir(path.dirname(targetPath));
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function readQueueFile(queuePath) {
  const data = JSON.parse(await fsp.readFile(queuePath, 'utf8'));
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  throw new Error('queue file does not contain an item array');
}

function recoverInterruptedQueueItems(queue) {
  for (const item of queue) {
    if (item.status === 'next') {
      item.status = 'pending';
    } else if (item.status === 'sending' || item.status === 'sent') {
      item.status = 'unknown';
      item.error = 'Previous run exited while this prompt may already have been accepted by Codex.';
    }
    normalizeQueueItem(item);
  }
  return queue;
}

module.exports = {
  async setupPairState(sessionId) {
    const key = sha256(`${stripTrailingSep(this.opts.projectDir)}\n${sessionId}`).slice(0, 32);
    const nextStateDirForPair = path.join(this.opts.stateDir, key);
    if (this.lockAcquired && this.stateDirForPair && this.stateDirForPair !== nextStateDirForPair) {
      this.releaseLock();
    }
    this.stateDirForPair = nextStateDirForPair;
    ensureDirSync(this.stateDirForPair);
    this.queuePath = path.join(this.stateDirForPair, 'queue.json');
    this.statePath = path.join(this.stateDirForPair, 'state.json');
    this.eventsLogPath = path.join(this.stateDirForPair, 'events.log');
    this.jsonRpcLogPath = this.opts.logJsonrpc ? path.join(this.stateDirForPair, 'jsonrpc.log') : null;
    this.lockPath = path.join(this.stateDirForPair, 'app.lock');
    this.debug.stateDirForPair = this.stateDirForPair;
    this.debug.queuePath = this.queuePath;
    await this.acquireLock();
    await this.loadState();
    if (this.syncModelConfigState) await this.syncModelConfigState();
    await this.loadQueue();
    await this.saveState();
  },

  async acquireLock() {
    if (!this.lockPath || this.lockAcquired) return;
    if (fs.existsSync(this.lockPath) && !this.opts.force) {
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')); } catch (_) {}
      if (existing && existing.pid && isPidAlive(existing.pid)) {
        const url = existing.url ? `\nURL: ${existing.url}` : '';
        throw new Error(`Another codex-web instance is already running for this project/session (pid ${existing.pid}).${url}\nUse --force only if this is stale.`);
      }
    }
    fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, url: this.app.url, startedAt: nowIso() }, null, 2));
    this.lockAcquired = true;
  },

  releaseLock() {
    if (!this.lockAcquired || !this.lockPath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (raw.pid === process.pid) fs.unlinkSync(this.lockPath);
    } catch (_) {
      try { fs.unlinkSync(this.lockPath); } catch (_) {}
    }
    this.lockAcquired = false;
  },

  async loadQueue() {
    if (!this.queuePath) return;
    const backupPath = queueBackupPath(this.queuePath);
    const mainExists = fs.existsSync(this.queuePath);
    if (!mainExists && !fs.existsSync(backupPath)) {
      this.queue = [];
      await this.saveQueue();
      return;
    }
    let restoreNotice = null;
    try {
      if (mainExists) {
        this.queue = await readQueueFile(this.queuePath);
      } else {
        this.queue = await readQueueFile(backupPath);
        restoreNotice = {
          output: `[warning] queue file was missing; restored from backup: ${backupPath}`,
          event: `queue file missing; restored from backup=${backupPath}`,
        };
      }
    } catch (err) {
      try {
        this.queue = await readQueueFile(backupPath);
      } catch (backupErr) {
        const backupMessage = fs.existsSync(backupPath) ? ` Backup restore also failed: ${backupErr.message}` : ' No backup was available.';
        const backup = `${this.queuePath}.corrupt.${Date.now()}.bak`;
        try { if (fs.existsSync(this.queuePath)) fs.renameSync(this.queuePath, backup); } catch (_) {}
        this.queue = [];
        await this.saveQueue();
        this.appendOutput(`[error] queue file was corrupted. Backup: ${backup}.${backupMessage}`, 'error');
        this.eventLog('error', `queue file corrupted; backup=${backup}; ${err.message}; restore=${backupErr.message}`);
        return;
      }
      const backup = `${this.queuePath}.corrupt.${Date.now()}.bak`;
      try { if (fs.existsSync(this.queuePath)) fs.renameSync(this.queuePath, backup); } catch (_) {}
      restoreNotice = {
        output: `[warning] queue file was corrupted; restored from backup: ${backupPath}. Corrupt copy: ${backup}`,
        event: `queue file corrupted; restored from backup=${backupPath}; corrupt=${backup}; ${err.message}`,
      };
    }
    recoverInterruptedQueueItems(this.queue);
    await this.saveQueue();
    if (restoreNotice) {
      this.appendOutput(restoreNotice.output, 'system');
      this.eventLog('warn', restoreNotice.event);
    }
  },

  async saveQueue() {
    this.queue = normalizeQueueOrder(this.queue);
    if (!this.queuePath) return;
    await writeFileDurably(this.queuePath, JSON.stringify(this.queue, null, 2));
    try {
      await copyFileDurably(this.queuePath, queueBackupPath(this.queuePath));
    } catch (err) {
      this.eventLog('error', `queue backup refresh failed; backup=${queueBackupPath(this.queuePath)}; ${err.message}`);
    }
    this.broadcast('queue', this.queue);
  },

  async loadState() {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    try {
      const data = JSON.parse(await fsp.readFile(this.statePath, 'utf8'));
      if (!this.opts.modelProvided && Object.prototype.hasOwnProperty.call(data, 'model')) {
        this.opts.model = String(data.model || '').trim();
        this.app.model = this.opts.model;
      }
      if (!this.opts.effortProvided && Object.prototype.hasOwnProperty.call(data, 'effort')) {
        this.opts.effort = String(data.effort || '').trim();
        this.app.effort = this.opts.effort;
      }
      if (data.scheduledRunAt) {
        const ts = Date.parse(data.scheduledRunAt);
        this.app.scheduledRunAt = Number.isFinite(ts) ? new Date(ts).toISOString() : null;
      } else {
        this.app.scheduledRunAt = null;
      }
    } catch (_) {}
  },

  async loadSettings() {
    if (!this.settingsPath || !fs.existsSync(this.settingsPath)) return;
    try {
      const data = JSON.parse(await fsp.readFile(this.settingsPath, 'utf8'));
      if (data.theme === 'light' || data.theme === 'dark') this.app.theme = data.theme;
    } catch (_) {}
  },

  async saveSettings() {
    if (!this.settingsPath) return;
    const data = { theme: this.app.theme || 'dark', updatedAt: nowIso() };
    const tmp = this.settingsPath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
    await fsp.rename(tmp, this.settingsPath);
  },

  async saveState() {
    if (!this.statePath) return;
    const data = {
      version: VERSION,
      projectDir: this.opts.projectDir,
      sessionId: this.app.sessionId,
      sessionTitle: this.app.sessionTitle,
      model: this.opts.model || '',
      effort: this.opts.effort || '',
      scheduledRunAt: this.app.scheduledRunAt || null,
      state: this.app.state,
      updatedAt: nowIso(),
    };
    await fsp.writeFile(this.statePath, JSON.stringify(data, null, 2)).catch(() => {});
  },

  eventLog(level, message) {
    if (!this.eventsLogPath) return;
    fs.appendFile(this.eventsLogPath, `${nowIso()} ${level} ${message}\n`, () => {});
  },

  debugLog(message, data = '') {
    this.eventLog('debug', `${message}${data ? ' ' + data : ''}`);
  }
};
