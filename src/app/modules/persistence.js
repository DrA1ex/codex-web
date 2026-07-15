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
  randomId,
} = require('../../shared/utils');
const {
  normalizeQueueItem,
  normalizeQueueOrder,
  transitionQueueItem,
} = require('../../queue');
const {
  appendJsonLine,
  loadCompletedArchiveIndex,
  readCompletedArchivePage,
  truncateArchive,
} = require('../completed-archive');

const RECENT_COMPLETED_LIMIT = 50;

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
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomId(4)}`;
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
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}.${randomId(4)}`;
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
      transitionQueueItem(item, 'pending', { force: true });
    } else if (item.status === 'sending' || item.status === 'sent') {
      transitionQueueItem(item, 'unknown', { force: true });
      item.error = 'Previous run exited while this prompt may already have been accepted by Codex.';
    }
    normalizeQueueItem(item);
  }
  return queue;
}

function lockStatMatches(left, right) {
  if (!left || !right) return false;
  return left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function cloneQueueItem(item) {
  return JSON.parse(JSON.stringify(item));
}

function archiveMetaPayload(ctx) {
  return {
    version: 1,
    totalCompleted: ctx.completedArchiveTotal,
    updatedAt: nowIso(),
  };
}

function queueItemTime(item) {
  const time = Date.parse(item?.finishedAt || item?.createdAt || '');
  return Number.isFinite(time) ? time : 0;
}

function completedQueuePage(queue, before = null, limit = 10) {
  const entries = (queue || [])
    .map((item, index) => ({ item, index, time: queueItemTime(item) }))
    .filter((entry) => entry.item.status === 'completed')
    .sort((left, right) => left.time - right.time || left.index - right.index);
  let end = entries.length;
  if (before?.id) {
    const cursorIndex = entries.findIndex((entry) => String(entry.item.id) === String(before.id));
    if (cursorIndex < 0) return { items: [], hasMore: false, cursor: null, totalCompleted: entries.length };
    end = cursorIndex;
  }
  const pageLimit = Math.max(1, Math.min(200, Number(limit) || 10));
  const start = Math.max(0, end - pageLimit);
  const items = entries.slice(start, end).map((entry) => entry.item);
  return {
    items,
    hasMore: start > 0,
    cursor: items[0] ? { id: items[0].id, finishedAt: items[0].finishedAt || null } : null,
    totalCompleted: entries.length,
  };
}

module.exports = {
  async setupPairState(sessionId, sessionTitle = null) {
    const key = sha256(`${stripTrailingSep(this.opts.projectDir)}\n${sessionId}`).slice(0, 32);
    const nextStateDirForPair = path.join(this.opts.stateDir, key);
    if (this.lockAcquired && this.stateDirForPair && this.stateDirForPair !== nextStateDirForPair) {
      this.releaseLock();
    }
    this.stateDirForPair = nextStateDirForPair;
    ensureDirSync(this.stateDirForPair);
    this.queuePath = path.join(this.stateDirForPair, 'queue.json');
    this.statePath = path.join(this.stateDirForPair, 'state.json');
    this.completedArchivePath = path.join(this.stateDirForPair, 'completed.jsonl');
    this.completedArchiveMetaPath = path.join(this.stateDirForPair, 'completed.meta.json');
    this.eventsLogPath = path.join(this.stateDirForPair, 'events.log');
    this.jsonRpcLogPath = this.opts.logJsonrpc ? path.join(this.stateDirForPair, 'jsonrpc.log') : null;
    this.lockPath = path.join(this.stateDirForPair, 'app.lock');
    this.debug.stateDirForPair = this.stateDirForPair;
    this.debug.queuePath = this.queuePath;
    await this.acquireLock();
    await this.loadState();
    if (this.syncModelConfigState) await this.syncModelConfigState();
    await this.loadCompletedArchive();
    await this.loadQueue();
    await this.saveState({ sessionId, sessionTitle: sessionTitle || this.app.sessionTitle });
  },

  async acquireLock() {
    if (!this.lockPath || this.lockAcquired) return;
    ensureDirSync(path.dirname(this.lockPath));
    const ownerNonce = randomId(16);
    const payload = JSON.stringify({
      pid: process.pid,
      nonce: ownerNonce,
      url: this.app.url,
      startedAt: nowIso(),
    }, null, 2);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      let handle;
      try {
        handle = await fsp.open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(payload);
        await handle.sync();
        await handle.close();
        this.lockOwnerNonce = ownerNonce;
        this.lockAcquired = true;
        return;
      } catch (err) {
        if (handle) await handle.close().catch(() => {});
        if (err.code !== 'EEXIST') throw err;
      }

      let before;
      let after;
      let existing = null;
      try {
        before = await fsp.stat(this.lockPath);
        existing = JSON.parse(await fsp.readFile(this.lockPath, 'utf8'));
        after = await fsp.stat(this.lockPath);
      } catch (_) {
        continue;
      }
      if (!lockStatMatches(before, after)) continue;
      if (existing?.pid && isPidAlive(existing.pid)) {
        const url = existing.url ? `\nURL: ${existing.url}` : '';
        throw new Error(`Another codex-web instance is already running for this project/session (pid ${existing.pid}).${url}\nA live lock cannot be overridden; --force only removes stale locks.`);
      }
      try {
        const current = await fsp.stat(this.lockPath);
        if (lockStatMatches(after, current)) await fsp.unlink(this.lockPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    throw new Error('Could not acquire queue lock because it changed repeatedly');
  },

  releaseLock() {
    if (!this.lockAcquired || !this.lockPath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (raw.pid === process.pid && raw.nonce === this.lockOwnerNonce) fs.unlinkSync(this.lockPath);
    } catch (_) {
      // Never delete a lock whose ownership cannot be verified.
    }
    this.lockAcquired = false;
    this.lockOwnerNonce = null;
  },

  async loadCompletedArchive() {
    if (!this.completedArchivePath) return;
    const loaded = await loadCompletedArchiveIndex(this.completedArchivePath, RECENT_COMPLETED_LIMIT);
    this.archivedCompletedIds = loaded.ids;
    this.completedArchiveTotal = loaded.total;
    this.completedArchiveRecent = loaded.recent;
    if (!fs.existsSync(this.completedArchivePath)) {
      await writeFileDurably(this.completedArchivePath, '');
    }
    await this.persistence.enqueue('archive-meta', async () => {
      await writeFileDurably(this.completedArchiveMetaPath, JSON.stringify(archiveMetaPayload(this), null, 2));
    });
  },

  async archiveCompletedItem(item) {
    if (!item || item.status !== 'completed' || !this.completedArchivePath) return false;
    const snapshot = cloneQueueItem(item);
    await this.persistence.enqueue('completed-archive', async () => {
      const isNew = !this.archivedCompletedIds.has(String(snapshot.id));
      await appendJsonLine(this.completedArchivePath, { op: isNew ? 'insert' : 'update', item: snapshot, archivedAt: nowIso() });
      if (isNew) {
        this.archivedCompletedIds.add(String(snapshot.id));
        this.completedArchiveTotal += 1;
      }
      const existingIndex = this.completedArchiveRecent.findIndex((candidate) => candidate.id === snapshot.id);
      if (existingIndex >= 0) this.completedArchiveRecent[existingIndex] = snapshot;
      else this.completedArchiveRecent.push(snapshot);
      if (this.completedArchiveRecent.length > RECENT_COMPLETED_LIMIT) {
        this.completedArchiveRecent.splice(0, this.completedArchiveRecent.length - RECENT_COMPLETED_LIMIT);
      }
      await writeFileDurably(this.completedArchiveMetaPath, JSON.stringify(archiveMetaPayload(this), null, 2));
    });
    return true;
  },

  async finalizeCompletedQueueItem(item) {
    if (!item || item.status !== 'completed' || !this.completedArchivePath) return false;
    const index = this.queue.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) this.queue.splice(index, 1);
    try {
      await this.archiveCompletedItem(item);
      await this.saveQueue({ skipArchive: true });
      return true;
    } catch (err) {
      if (!this.queue.some((candidate) => candidate.id === item.id)) {
        this.queue.splice(Math.max(0, index), 0, item);
        this.queue = normalizeQueueOrder(this.queue);
      }
      throw err;
    }
  },

  async loadCompletedArchivePage(body = {}) {
    if (!this.completedArchivePath) return completedQueuePage(this.queue, body.before || null, body.limit || 50);
    return await readCompletedArchivePage(this.completedArchivePath, {
      before: body.before || null,
      limit: body.limit || 50,
      totalCompleted: this.completedArchiveTotal,
    });
  },

  completedArchiveSnapshot() {
    if (!this.completedArchivePath) return completedQueuePage(this.queue, null, 10);
    const items = this.completedArchiveRecent.slice(-10);
    return {
      items,
      hasMore: this.completedArchiveTotal > items.length,
      cursor: items[0] ? { id: items[0].id, finishedAt: items[0].finishedAt || null } : null,
      totalCompleted: this.completedArchiveTotal,
    };
  },

  async clearCompletedArchive() {
    if (!this.completedArchivePath) return 0;
    const removed = this.completedArchiveTotal;
    await this.persistence.enqueue('completed-archive', async () => {
      await truncateArchive(this.completedArchivePath);
      this.archivedCompletedIds = new Set();
      this.completedArchiveRecent = [];
      this.completedArchiveTotal = 0;
      await writeFileDurably(this.completedArchiveMetaPath, JSON.stringify(archiveMetaPayload(this), null, 2));
    });
    this.broadcast('queue', this.queue);
    return removed;
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

  async saveQueue(options = {}) {
    this.queue = normalizeQueueOrder(this.queue);
    if (!this.queuePath) return;

    if (!options.skipArchive && this.completedArchivePath) {
      const eligible = this.queue.filter((item) => item.status === 'completed' && item.id !== this.currentItemId);
      if (eligible.length) {
        const ids = new Set(eligible.map((item) => item.id));
        this.queue = this.queue.filter((item) => !ids.has(item.id));
        try {
          for (const item of eligible) await this.archiveCompletedItem(item);
        } catch (err) {
          const existing = new Set(this.queue.map((item) => item.id));
          for (const item of eligible) {
            if (!existing.has(item.id)) this.queue.push(item);
          }
          this.queue = normalizeQueueOrder(this.queue);
          throw err;
        }
      }
    }

    const snapshot = JSON.stringify(this.queue, null, 2);
    const queuePath = this.queuePath;
    const backupPath = queueBackupPath(queuePath);
    await this.persistence.enqueue('queue', async (revision) => {
      await writeFileDurably(queuePath, snapshot);
      this.queueRevision = revision;
      try {
        await copyFileDurably(queuePath, backupPath);
      } catch (err) {
        this.eventLog('error', `queue backup refresh failed; backup=${backupPath}; ${err.message}`);
      }
    });
    this.broadcast('queue', this.queue);
  },

  async loadState() {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    try {
      const data = JSON.parse(await fsp.readFile(this.statePath, 'utf8'));
      if (!this.opts.modelProvided && Object.prototype.hasOwnProperty.call(data, 'model')) {
        this.opts.model = String(data.model || '').trim();
        this.app.model = this.opts.model;
        this.app.configSources.model = 'saved';
      }
      if (!this.opts.effortProvided && Object.prototype.hasOwnProperty.call(data, 'effort')) {
        this.opts.effort = String(data.effort || '').trim();
        this.app.effort = this.opts.effort;
        this.app.configSources.effort = 'saved';
      }
      if (data.scheduledRunAt) {
        const ts = Date.parse(data.scheduledRunAt);
        this.app.scheduledRunAt = Number.isFinite(ts) ? new Date(ts).toISOString() : null;
      } else {
        this.app.scheduledRunAt = null;
      }
    } catch (err) {
      this.eventLog('error', `state load failed: ${err.message}`);
    }
  },

  async loadSettings() {
    if (!this.settingsPath || !fs.existsSync(this.settingsPath)) return;
    try {
      const data = JSON.parse(await fsp.readFile(this.settingsPath, 'utf8'));
      if (data.theme === 'light' || data.theme === 'dark') this.app.theme = data.theme;
      if (!this.opts.sandboxProvided && ['read-only', 'workspace-write', 'danger-full-access'].includes(data.sandbox)) {
        this.opts.sandbox = data.sandbox;
        this.app.sandbox = data.sandbox;
        this.app.configSources.sandbox = 'saved';
      }
      if (!this.opts.approvalPolicyProvided && ['on-request', 'never', 'untrusted', 'on-failure'].includes(data.approvalPolicy)) {
        this.opts.approvalPolicy = data.approvalPolicy;
        this.app.approvalPolicy = data.approvalPolicy;
        this.app.configSources.approvalPolicy = 'saved';
      }
    } catch (err) {
      this.eventLog('error', `settings load failed: ${err.message}`);
    }
  },

  async saveSettings() {
    if (!this.settingsPath) return;
    const data = {
      theme: this.app.theme || 'dark',
      sandbox: this.opts.sandbox || this.app.sandbox || 'workspace-write',
      approvalPolicy: this.opts.approvalPolicy || this.app.approvalPolicy || 'on-request',
      updatedAt: nowIso(),
    };
    const content = JSON.stringify(data, null, 2);
    await this.persistence.enqueue('settings', async () => {
      await writeFileDurably(this.settingsPath, content);
    });
  },

  async saveState(overrides = {}) {
    if (!this.statePath) return;
    const data = {
      version: VERSION,
      projectDir: this.opts.projectDir,
      sessionId: Object.prototype.hasOwnProperty.call(overrides, 'sessionId') ? overrides.sessionId : this.app.sessionId,
      sessionTitle: Object.prototype.hasOwnProperty.call(overrides, 'sessionTitle') ? overrides.sessionTitle : this.app.sessionTitle,
      model: this.opts.model || '',
      effort: this.opts.effort || '',
      scheduledRunAt: this.app.scheduledRunAt || null,
      state: this.app.state,
      updatedAt: nowIso(),
    };
    const content = JSON.stringify(data, null, 2);
    await this.persistence.enqueue('state', async () => {
      await writeFileDurably(this.statePath, content);
    });
  },

  reportPersistenceFailure(operation, err) {
    const message = `${operation} failed: ${err.message || String(err)}`;
    this.eventLog('error', message);
    this.appendOutput(`[error] ${message}`, 'error');
    this.broadcastAll();
  },

  eventLog(level, message) {
    if (!this.eventsLogPath) return;
    fs.appendFile(this.eventsLogPath, `${nowIso()} ${level} ${message}\n`, () => {});
  },

  debugLog(message, data = '') {
    this.eventLog('debug', `${message}${data ? ' ' + data : ''}`);
  },
};
