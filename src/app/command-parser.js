'use strict';

const { commandByName } = require('./commands');

function usageFor(command) {
  const meta = commandByName(command);
  if (!meta) return 'Type /help to see available commands.';
  return `${meta.name}${meta.argumentHint ? ` ${meta.argumentHint}` : ''}`;
}

function commandError(command, raw, errorCode, message, usage = usageFor(command)) {
  return { ok: false, command, errorCode, message, usage, raw };
}

function splitCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (!raw.startsWith('/')) return null;
  const match = raw.match(/^(\/\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return commandError(raw, raw, 'unknown_command', `Unknown command: ${raw}`, 'Type /help to see available commands.');
  return { raw, command: match[1], rest: String(match[2] || '').trim() };
}

function parseDurationArgument(input, now = new Date()) {
  const text = String(input || '').trim();
  if (!text) return null;
  const unitMs = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  const parts = text.split(/\s+/);
  const seen = new Set();
  let total = 0;
  for (const part of parts) {
    const match = part.match(/^(\d+)([mhd])$/);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isSafeInteger(amount) || amount <= 0 || seen.has(unit)) return null;
    seen.add(unit);
    total += amount * unitMs[unit];
  }
  if (total <= 0) return null;
  return new Date(now.getTime() + total);
}

function validLocalDate(year, month, day, hour, minute) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) return null;
  return date;
}

function parseClock(text, now) {
  const match = String(text || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  let date = validLocalDate(now.getFullYear(), now.getMonth() + 1, now.getDate(), hour, minute);
  if (!date) return null;
  if (date.getTime() <= now.getTime()) date = validLocalDate(now.getFullYear(), now.getMonth() + 1, now.getDate() + 1, hour, minute);
  return date;
}

function parseDotDate(text, now) {
  const match = String(text || '').trim().match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const explicitYear = match[3] ? Number(match[3]) : null;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  let year = explicitYear || now.getFullYear();
  let date = validLocalDate(year, month, day, hour, minute);
  if (!date) return null;
  if (!explicitYear && date.getTime() <= now.getTime()) date = validLocalDate(year + 1, month, day, hour, minute);
  return date;
}

function parseIsoLike(text) {
  const match = String(text || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return validLocalDate(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
}

function schedulePayload(date) {
  return { action: 'set', scheduledRunAt: date.toISOString() };
}

function parseScheduleArgument(argument, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const text = String(argument || '').trim();
  if (!text) return { ok: true, schedule: { action: 'open' } };
  if (text === 'reset') return { ok: true, schedule: { action: 'reset' } };

  const date = parseDurationArgument(text, now)
    || parseClock(text, now)
    || parseDotDate(text, now)
    || parseIsoLike(text);

  if (!date) return { ok: false, errorCode: 'invalid_schedule', message: 'Invalid schedule value.', usage: '/schedule 10m | /schedule 1h 30m | /schedule 12:00 | /schedule reset' };
  if (date.getTime() <= now.getTime()) return { ok: false, errorCode: 'past_schedule', message: 'Schedule time must be in the future.', usage: '/schedule 10m | /schedule 1h 30m | /schedule 12:00 | /schedule reset' };
  return { ok: true, schedule: schedulePayload(date) };
}

function parseComposerCommand(text, options = {}) {
  const original = String(text || '');
  if (!original) return null;
  if (original[0] !== '/') return null;
  const split = splitCommand(original);
  if (!split) return null;
  if (!split.ok && split.ok === false) return split;

  const meta = commandByName(split.command);
  if (!meta) return commandError(split.command, split.raw, 'unknown_command', `Unknown command: ${split.command}`, 'Type /help to see available commands.');

  const args = {};
  if (meta.requiresArgs && !split.rest) {
    const argName = meta.argumentHint.replace(/[<>\[\]]/g, '') || 'argument';
    return commandError(split.command, split.raw, 'missing_arg', `Missing argument: ${argName}`, usageFor(split.command));
  }

  if (split.command === '/send' || split.command === '/next') {
    if (!split.rest) return commandError(split.command, split.raw, 'missing_arg', 'Missing argument: id', usageFor(split.command));
    if (!/^[-_.:\w]+$/.test(split.rest)) return commandError(split.command, split.raw, 'invalid_arg', 'Invalid queue item id.', usageFor(split.command));
    args.id = split.rest;
  } else if (split.command === '/think' || split.command === '/think!') {
    if (!split.rest) return commandError(split.command, split.raw, 'missing_arg', split.command === '/think!' ? '/think! needs a follow-up prompt.' : '/think needs a note to send to the active prompt.', usageFor(split.command));
    args.text = split.rest;
  } else if (split.command === '/schedule') {
    const parsedSchedule = parseScheduleArgument(split.rest, options);
    if (!parsedSchedule.ok) return commandError('/schedule', split.raw, parsedSchedule.errorCode, parsedSchedule.message, parsedSchedule.usage);
    args.schedule = parsedSchedule.schedule;
  } else if (split.command === '/sandbox' || split.command === '/approval') {
    args.value = split.rest || '';
  } else if (split.rest) {
    return commandError(split.command, split.raw, 'unexpected_arg', `${split.command} does not accept arguments.`, usageFor(split.command));
  }

  return { ok: true, command: split.command, args, raw: split.raw, execution: meta.execution };
}

module.exports = {
  parseComposerCommand,
  parseScheduleArgument,
  parseDurationArgument,
};
