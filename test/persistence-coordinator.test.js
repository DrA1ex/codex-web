'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { PersistenceCoordinator } = require('../src/app/persistence-coordinator');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('PersistenceCoordinator serializes writes for the same resource in revision order', async () => {
  const coordinator = new PersistenceCoordinator();
  const events = [];

  const first = coordinator.enqueue('queue', async (revision) => {
    events.push(`start-${revision}`);
    await sleep(30);
    events.push(`end-${revision}`);
  });
  const second = coordinator.enqueue('queue', async (revision) => {
    events.push(`start-${revision}`);
    events.push(`end-${revision}`);
  });

  await Promise.all([first, second]);
  assert.deepEqual(events, ['start-1', 'end-1', 'start-2', 'end-2']);
});

test('PersistenceCoordinator keeps independent resources concurrent and drainable', async () => {
  const coordinator = new PersistenceCoordinator();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let settingsRan = false;

  coordinator.enqueue('queue', async () => { await gate; });
  await coordinator.enqueue('settings', async () => { settingsRan = true; });
  assert.equal(settingsRan, true);

  release();
  await coordinator.drain();
  assert.equal(coordinator.chains.size, 0);
});
