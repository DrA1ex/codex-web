'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { COMMAND_REGISTRY, commandHelpPayload } = require('../src/app/commands');

const REQUIRED = ['name', 'argumentHint', 'shortDescription', 'details', 'examples', 'category', 'execution', 'autocomplete', 'requiresArgs'];

test('command metadata registry has required fields and no duplicate command names', () => {
  const names = new Set();
  for (const command of COMMAND_REGISTRY) {
    for (const field of REQUIRED) assert.ok(Object.prototype.hasOwnProperty.call(command, field), `${command.name || '?'} missing ${field}`);
    assert.ok(!names.has(command.name), `duplicate command ${command.name}`);
    names.add(command.name);
    if (command.autocomplete) assert.ok(command.examples.length, `${command.name} autocomplete commands need examples`);
    if (command.requiresArgs) assert.ok(command.argumentHint, `${command.name} requires args but has no hint`);
  }
});

test('help payload is generated from the command registry and distinguishes /stop from /quit', () => {
  const help = commandHelpPayload();
  assert.deepEqual(help.map((entry) => entry.name), COMMAND_REGISTRY.map((entry) => entry.name));
  const stop = help.find((entry) => entry.name === '/stop');
  const quit = help.find((entry) => entry.name === '/quit');
  assert.match(`${stop.shortDescription} ${stop.details}`, /interrupt/i);
  assert.doesNotMatch(`${stop.shortDescription} ${stop.details}`, /shut down/i);
  assert.match(`${quit.shortDescription} ${quit.details}`, /shut down/i);
  assert.notStrictEqual(stop.shortDescription, quit.shortDescription);
});
