'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERSION = '0.1.0';
const MAX_OUTPUT_LINES = 4000;
const MAX_OUTPUT_ENTRY_CHARS = 200 * 1024;
const MAX_OUTPUT_TOTAL_CHARS = 1200 * 1024;
const OUTPUT_TRUNCATED_MARKER = '\n[output truncated]';
const DEFAULT_MODEL = 'gpt-5.5';
const MODEL_OPTIONS = [
  { value: '', label: `${DEFAULT_MODEL} (default)` },
  { value: 'gpt-5.5', label: 'gpt-5.5' },
  { value: 'gpt-5.4', label: 'gpt-5.4' },
  { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
  { value: 'gpt-5.3-codex-spark', label: 'gpt-5.3-codex-spark' },
];
const EFFORT_OPTIONS = [
  { value: '', label: 'default' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
];

const ENTRY_FILE_CANDIDATES = [
  require.main?.filename,
  process.argv[1] && process.argv[1] !== '-' ? path.resolve(process.argv[1]) : null,
  path.join(__dirname, '..', 'index.js'),
].filter(Boolean);
const ENTRY_FILE = ENTRY_FILE_CANDIDATES.find((file) => fs.existsSync(file)) || path.join(__dirname, '..', 'index.js');
const SCRIPT_DIR = path.dirname(fs.realpathSync(ENTRY_FILE));
const LAUNCH_DIR = process.argv[1] && process.argv[1] !== '-' ? path.dirname(path.resolve(process.argv[1])) : SCRIPT_DIR;
const ASSET_DIRS = [
  path.join(SCRIPT_DIR, 'www'),
  path.join(LAUNCH_DIR, 'www'),
  path.join(process.cwd(), 'www'),
];
const STATIC_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

module.exports = {
  VERSION,
  MAX_OUTPUT_LINES,
  MAX_OUTPUT_ENTRY_CHARS,
  MAX_OUTPUT_TOTAL_CHARS,
  OUTPUT_TRUNCATED_MARKER,
  DEFAULT_MODEL,
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  SCRIPT_DIR,
  ASSET_DIRS,
  STATIC_TYPES,
};
