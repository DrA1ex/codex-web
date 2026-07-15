#!/usr/bin/env node
'use strict';

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
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
const resultRoot = path.resolve(process.env.E2E_OUTPUT_DIR || 'test-results/e2e-batches');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostParallelism() {
  if (typeof os.availableParallelism === 'function') return os.availableParallelism();
  return os.cpus()?.length || 1;
}

function resolveParallelProcesses(value = process.env.E2E_PARALLEL_PROCESSES, available = hostParallelism()) {
  const fallback = Math.min(2, Math.max(1, available));
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, Math.max(1, available));
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

const activeChildren = new Set();
let terminating = false;

function terminateActiveChildren(signal) {
  for (const child of activeChildren) killTree(child, signal);
}

function forwardTermination(signal) {
  if (terminating) return;
  terminating = true;
  if (!activeChildren.size) process.exit(signal === 'SIGINT' ? 130 : 143);
  terminateActiveChildren('SIGTERM');
  const killTimer = setTimeout(() => terminateActiveChildren('SIGKILL'), 1000);
  const exitTimer = setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 2000);
  killTimer.unref?.();
  exitTimer.unref?.();
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
    activeChildren.add(child);

    let settled = false;
    let timedOut = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n[e2e] ${label} exceeded ${timeoutMs} ms; terminating its process tree`);
      killTree(child, 'SIGTERM');
      const killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 1000);
      const settleTimer = setTimeout(() => finish(resolve, 124), 2500);
      killTimer.unref?.();
      settleTimer.unref?.();
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

function jobLabel(job) {
  const suffix = job.shards > 1 ? ` shard ${job.shard}/${job.shards}` : '';
  return `${job.file}${suffix}`;
}

async function runJobPool(jobs, concurrency, execute, options = {}) {
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, jobs.length));
  const cooldownMs = Math.max(0, options.cooldownMs || 0);
  let cursor = 0;
  let failedStatus = 0;

  async function worker(slot) {
    while (!failedStatus) {
      const index = cursor;
      cursor += 1;
      if (index >= jobs.length) return;
      const status = await execute(jobs[index], index, slot);
      if (status !== 0) {
        failedStatus = status;
        return;
      }
      if (cooldownMs > 0 && cursor < jobs.length) await sleep(cooldownMs);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, index) => worker(index + 1)));
  return failedStatus;
}

async function main() {
  installSignalHandlers();

  // Explicit arguments preserve normal Playwright focused-run semantics.
  if (forwarded.length) return await run(forwarded, 'focused Playwright run');

  // A batch owns one Playwright worker/browser process. Batches are independent:
  // every test creates a fresh backend, mock server, port, state directory, project
  // directory, and navigation. Running multiple batches in parallel is therefore
  // safe as long as their artifact directories are separate.
  const counts = discoverSpecCounts();
  const jobs = createJobs(counts);
  const totalTests = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const parallelProcesses = Math.min(resolveParallelProcesses(), jobs.length);

  await fsp.rm(resultRoot, { recursive: true, force: true });
  await fsp.mkdir(resultRoot, { recursive: true });

  const executionLabel = parallelProcesses === 1
    ? 'running serially'
    : `running ${parallelProcesses} batches in parallel`;
  console.log(`[e2e] ${totalTests} tests in ${jobs.length} browser batches; ${executionLabel}`);

  const status = await runJobPool(jobs, parallelProcesses, async (job, index, slot) => {
    const label = jobLabel(job);
    console.log(`\n[e2e] batch ${index + 1}/${jobs.length} (slot ${slot}/${parallelProcesses}): ${label}`);
    const outputDir = path.join(resultRoot, `batch-${String(index + 1).padStart(2, '0')}`);
    const args = [job.file, '--workers=1', `--output=${outputDir}`];
    if (job.shards > 1) args.push(`--shard=${job.shard}/${job.shards}`);
    return await run(args, label);
  }, { cooldownMs: batchCooldownMs });

  if (status !== 0) {
    terminateActiveChildren('SIGTERM');
    const killTimer = setTimeout(() => terminateActiveChildren('SIGKILL'), 1000);
    killTimer.unref?.();
    return status;
  }

  const completionMode = parallelProcesses === 1 ? 'serial' : `${parallelProcesses} parallel`;
  console.log(`\n[e2e] ${totalTests}/${totalTests} tests passed across ${jobs.length} isolated browser batches (${completionMode})`);
  return 0;
}

module.exports = {
  collectCounts,
  createJobs,
  descendantPids,
  jobLabel,
  resolveParallelProcesses,
  runJobPool,
};

if (require.main === module) {
  main().then((status) => {
    process.exitCode = status;
  }).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
