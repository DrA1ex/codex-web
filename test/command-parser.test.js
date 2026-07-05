'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseComposerCommand, parseScheduleArgument } = require('../src/app/command-parser');

const NOW = new Date(2026, 6, 5, 17, 0, 0, 0);

function ok(text) {
  const parsed = parseComposerCommand(text, { now: NOW });
  assert.equal(parsed?.ok, true, text);
  return parsed;
}

function rejected(text) {
  const parsed = parseComposerCommand(text, { now: NOW });
  assert.equal(parsed?.ok, false, text);
  return parsed;
}

test('parseComposerCommand parses slash commands with arguments', () => {
  assert.equal(ok('/send abc123').args.id, 'abc123');
  assert.equal(ok('/next abc123').args.id, 'abc123');
  assert.equal(ok('/pending').command, '/pending');
  assert.equal(ok('/stop').command, '/stop');
  assert.equal(ok('/sandbox').args.value, '');
  assert.equal(ok('/sandbox read-only').args.value, 'read-only');
  assert.equal(ok('/approval').args.value, '');
  assert.equal(ok('/approval never').args.value, 'never');
  assert.equal(ok('/schedule').args.schedule.action, 'open');
  assert.equal(ok('/schedule reset').args.schedule.action, 'reset');
  assert.equal(ok('/schedule 10m').args.schedule.action, 'set');
  assert.equal(ok('/schedule 15h').args.schedule.action, 'set');
  assert.equal(ok('/schedule 1h 30m').args.schedule.action, 'set');
  assert.equal(ok('/schedule 2026-07-05 18:30').args.schedule.action, 'set');
});

test('parseComposerCommand rejects invalid slash commands and missing bodies', () => {
  assert.equal(rejected('/send').errorCode, 'missing_arg');
  assert.equal(rejected('/next').errorCode, 'missing_arg');
  assert.equal(rejected('/schedule nonsense').errorCode, 'invalid_schedule');
  assert.equal(rejected('/unknown').errorCode, 'unknown_command');
  assert.equal(rejected('/think').errorCode, 'missing_arg');
  assert.equal(rejected('/think!').errorCode, 'missing_arg');
});

test('parseComposerCommand ignores slash text outside command start', () => {
  assert.equal(parseComposerCommand('write a prompt with /send abc123 inside'), null);
  assert.equal(parseComposerCommand('hello /schedule 10m'), null);
  assert.equal(parseComposerCommand('This is not a command: /stop'), null);
  assert.equal(parseComposerCommand('  /send abc123'), null);
});

test('parseScheduleArgument handles relative durations and absolute local forms', () => {
  assert.equal(parseScheduleArgument('', { now: NOW }).schedule.action, 'open');
  assert.equal(parseScheduleArgument('reset', { now: NOW }).schedule.action, 'reset');
  assert.equal(parseScheduleArgument('10m', { now: NOW }).schedule.scheduledRunAt, new Date(2026, 6, 5, 17, 10).toISOString());
  assert.equal(parseScheduleArgument('15h', { now: NOW }).schedule.scheduledRunAt, new Date(2026, 6, 6, 8, 0).toISOString());
  assert.equal(parseScheduleArgument('2d', { now: NOW }).schedule.scheduledRunAt, new Date(2026, 6, 7, 17, 0).toISOString());
  assert.equal(parseScheduleArgument('1h 30m', { now: NOW }).schedule.scheduledRunAt, new Date(2026, 6, 5, 18, 30).toISOString());
  assert.equal(parseScheduleArgument('12:00', { now: NOW }).schedule.scheduledRunAt, new Date(2026, 6, 6, 12, 0).toISOString());
  assert.equal(parseScheduleArgument('15.08 12:00', { now: NOW }).schedule.scheduledRunAt, new Date(2026, 7, 15, 12, 0).toISOString());
  assert.equal(parseScheduleArgument('20.01.2027 12:00', { now: NOW }).schedule.scheduledRunAt, new Date(2027, 0, 20, 12, 0).toISOString());
  assert.equal(parseScheduleArgument('2026-07-05 18:30', { now: NOW }).schedule.scheduledRunAt, new Date(2026, 6, 5, 18, 30).toISOString());
});

test('parseScheduleArgument rejects invalid suffixes, dates, repeated units, zero, and exact past dates', () => {
  for (const value of ['nonsense', '25:00', '1x', '1h nonsense', '1h 30', '0m', '-1h', '1h 30m 10m', '32.01.2027 12:00', '2026-99-99 18:30', '2026-99-05 18:30', '2026-07-05 16:30']) {
    assert.equal(parseScheduleArgument(value, { now: NOW }).ok, false, value);
  }
});
