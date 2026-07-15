'use strict';

const { defineConfig } = require('playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  timeout: 35_000,
  expect: { timeout: 8_000 },
  // Keep one worker for deterministic process-level tests, while allowing balanced sharding by test.
  fullyParallel: true,
  workers: 1,
  retries: 0,
  reporter: [['line']],
});
