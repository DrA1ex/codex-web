'use strict';

const path = require('node:path');
const { VERSION } = require('./config');
const { homeExpand, normalizeProjectDir, toBool } = require('./utils');

function parseArgs(argv) {
  const opts = {
    host: '127.0.0.1',
    port: 0,
    noOpen: false,
    stateDir: '~/.local/state/codex-limit-watch-web',
    codexBin: 'codex',
    projectDir: process.cwd(),
    allSessions: false,
    sessionPickerLimit: 50,
    watchInterval: 30,
    countdown: 5,
    model: '',
    effort: '',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalResponse: 'accept-for-session',
    network: true,
    logJsonrpc: false,
    debug: false,
    force: false,
    modelProvided: false,
    effortProvided: false,
    addDirs: [],
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a === '--host') opts.host = next();
    else if (a === '--port') opts.port = Number(next());
    else if (a === '--no-open') opts.noOpen = true;
    else if (a === '--state-dir') opts.stateDir = next();
    else if (a === '--codex-bin') opts.codexBin = next();
    else if (a === '--project-dir') opts.projectDir = next();
    else if (a === '--all-sessions') opts.allSessions = true;
    else if (a === '--session-picker-limit') opts.sessionPickerLimit = Number(next());
    else if (a === '--watch-interval') opts.watchInterval = Number(next());
    else if (a === '--countdown') opts.countdown = Number(next());
    else if (a === '--model' || a === '-m') { opts.model = next(); opts.modelProvided = true; }
    else if (a === '--effort') { opts.effort = next(); opts.effortProvided = true; }
    else if (a === '--sandbox') opts.sandbox = next();
    else if (a === '--approval-policy') opts.approvalPolicy = next();
    else if (a === '--approval-response') opts.approvalResponse = next();
    else if (a === '--network') opts.network = toBool(next(), true);
    else if (a === '--log-jsonrpc') opts.logJsonrpc = true;
    else if (a === '--debug') opts.debug = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--add-dir') opts.addDirs.push(next());
    else if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
    else positional.push(a);
  }
  opts.sessionId = positional[0] || null;
  opts.port = Number.isFinite(opts.port) ? opts.port : 0;
  opts.watchInterval = Math.max(5, Number(opts.watchInterval) || 30);
  opts.countdown = Math.max(0, Number(opts.countdown) || 0);
  opts.sessionPickerLimit = Math.max(1, Number(opts.sessionPickerLimit) || 50);
  opts.projectDir = normalizeProjectDir(opts.projectDir);
  opts.stateDir = path.resolve(homeExpand(opts.stateDir));
  opts.addDirs = opts.addDirs.map((d) => normalizeProjectDir(d));
  validateOptions(opts);
  return opts;
}

function validateOptions(opts) {
  const sandboxes = new Set(['read-only', 'workspace-write', 'danger-full-access']);
  if (!sandboxes.has(opts.sandbox)) throw new Error(`Unsupported --sandbox: ${opts.sandbox}`);
  const approvals = new Set(['on-request', 'never', 'untrusted', 'on-failure']);
  if (!approvals.has(opts.approvalPolicy)) throw new Error(`Unsupported --approval-policy: ${opts.approvalPolicy}`);
  const responses = new Set(['manual', 'accept', 'accept-for-session', 'decline', 'cancel']);
  if (!responses.has(opts.approvalResponse)) throw new Error(`Unsupported --approval-response: ${opts.approvalResponse}`);
  const efforts = new Set(['', 'low', 'medium', 'high', 'xhigh']);
  if (!efforts.has(opts.effort)) throw new Error(`Unsupported --effort: ${opts.effort}`);
}

function printHelp() {
  console.log(`Codex Limit Watch Web ${VERSION}\n\nUsage:\n  codex-limit-watch-web [session_id] [options]\n\nOptions:\n  --host 127.0.0.1\n  --port 0\n  --no-open\n  --state-dir ~/.local/state/codex-limit-watch-web\n  --codex-bin codex\n  --project-dir <dir>\n  --all-sessions\n  --session-picker-limit 50\n  --watch-interval 30\n  --countdown 5\n  --model gpt-5.5\n  --effort low|medium|high|xhigh\n  --sandbox read-only|workspace-write|danger-full-access\n  --approval-policy on-request|never|untrusted|on-failure\n  --approval-response manual|accept|accept-for-session|decline|cancel\n  --network true|false\n  --add-dir <dir>\n  --log-jsonrpc\n  --debug\n`);
}

module.exports = { parseArgs, validateOptions, printHelp };
