#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'codex-web')];

function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__MACOSX') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(fullPath);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
  }
}

collect(path.join(root, 'src'));
collect(path.join(root, 'www'));
collect(path.join(root, 'scripts'));
collect(path.join(root, 'test'));

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Syntax checked: ${files.length} files`);
