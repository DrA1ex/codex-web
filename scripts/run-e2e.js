#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const playwrightRoot = path.dirname(require.resolve('playwright/package.json'));
const cli = path.join(playwrightRoot, 'cli.js');
const forwarded = process.argv.slice(2);
const timeoutMs = Math.max(
  30_000,
  Number.parseInt(process.env.E2E_FILE_TIMEOUT_MS || process.env.E2E_TEST_TIMEOUT_MS || '180000', 10) || 180_000,
);
const maxTestsPerProcess = Math.max(
  1,
  Number.parseInt(process.env.E2E_MAX_TESTS_PER_PROCESS || '8', 10) || 8,
);
const batchCooldownMs = Math.max(
  0,
  Number.parseInt(process.env.E2E_BATCH_COOLDOWN_MS || '3000', 10) || 0,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function descendantPids(rootPid) {
  if (!rootPid || process.platform === 'win32') return [];
  const result = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  const children = new Map();
  for (const line of result.stdout.split('\n')) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const visit = (pid) => {
    for (const childPid of children.get(pid) || []) {
      visit(childPid);
      found.push(childPid);
    }
  };
  visit(rootPid);
  return found;
}

function signalPid(pid, signal) {
  try { process.kill(pid, signal); }
  catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function killTree(child, signal) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(child.pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    spawnSync('taskkill', args, {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  for (const pid of descendantPids(child.pid)) signalPid(pid, signal);
  signalPid(child.pid, signal);
}

let activeChild = null;
let terminating = false;

function forwardTermination(signal) {
  if (terminating) return;
  terminating = true;
  if (!activeChild) process.exit(signal === 'SIGINT' ? 130 : 143);
  killTree(activeChild, 'SIGTERM');
  setTimeout(() => killTree(activeChild, 'SIGKILL'), 1000);
  setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 2000);
}

function installSignalHandlers() {
  process.on('SIGTERM', () => forwardTermination('SIGTERM'));
  process.on('SIGINT', () => forwardTermination('SIGINT'));
}

async function run(args, label) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      detached: false,
    });
    activeChild = child;

    let settled = false;
    let timedOut = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeChild === child) activeChild = null;
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n[e2e] ${label} exceeded ${timeoutMs} ms; terminating its process tree`);
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 1000);
      setTimeout(() => finish(resolve, 124), 2500);
    }, timeoutMs);

    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code, signal) => {
      if (timedOut) return finish(resolve, 124);
      if (signal) {
        console.error(`[e2e] ${label} exited by signal ${signal}`);
        return finish(resolve, 1);
      }
      finish(resolve, code == null ? 1 : code);
    });
  });
}

function collectCounts(suites, counts = new Map()) {
  for (const suite of suites || []) {
    for (const spec of suite.specs || []) {
      if (!spec.ok) continue;
      counts.set(spec.file, (counts.get(spec.file) || 0) + 1);
    }
    collectCounts(suite.suites, counts);
  }
  return counts;
}

function discoverSpecCounts() {
  const result = spawnSync(process.execPath, [cli, 'test', '--list', '--reporter=json'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || '');
    process.stdout.write(result.stdout || '');
    throw new Error(`Playwright test discovery failed with exit code ${result.status}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Could not parse Playwright discovery output: ${error.message}`);
  }
  return collectCounts(report.suites);
}

function createJobs(counts, limit = maxTestsPerProcess) {
  const jobs = [];
  for (const [file, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const shards = Math.max(1, Math.ceil(count / Math.max(1, limit)));
    for (let shard = 1; shard <= shards; shard += 1) {
      jobs.push({
        file: path.join('e2e', file),
        count,
        shard,
        shards,
      });
    }
  }
  return jobs;
}

async function main() {
  installSignalHandlers();

  // Explicit arguments preserve normal Playwright focused-run semantics.
  if (forwarded.length) return await run(forwarded, 'focused Playwright run');

  // Each shard gets a fresh Playwright worker/browser process. Tests inside the
  // shard still receive independent backend processes, ports, state directories,
  // project directories, and navigations. Limiting shard size avoids long-lived
  // Chromium degradation while avoiding one browser launch per individual test.
  const counts = discoverSpecCounts();
  const jobs = createJobs(counts);
  const totalTests = [...counts.values()].reduce((sum, value) => sum + value, 0);

  for (const [index, job] of jobs.entries()) {
    const suffix = job.shards > 1 ? ` shard ${job.shard}/${job.shards}` : '';
    const label = `${job.file}${suffix}`;
    console.log(`\n[e2e] batch ${index + 1}/${jobs.length}: ${label}`);
    const args = [job.file, '--workers=1'];
    if (job.shards > 1) args.push(`--shard=${job.shard}/${job.shards}`);
    const status = await run(args, label);
    if (status !== 0) return status;
    if (batchCooldownMs > 0 && index < jobs.length - 1) await sleep(batchCooldownMs);
  }

  console.log(`\n[e2e] ${totalTests}/${totalTests} tests passed across ${jobs.length} isolated browser batches`);
  return 0;
}

module.exports = {
  collectCounts,
  createJobs,
  descendantPids,
};

if (require.main === module) {
  main().then((status) => {
    process.exitCode = status;
  }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
