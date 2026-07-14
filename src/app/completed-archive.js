'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const readline = require('node:readline');

async function appendJsonLine(filePath, value) {
  const handle = await fsp.open(filePath, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function archiveItemFromRecord(record) {
  if (!record || typeof record !== 'object') return null;
  return record.item && typeof record.item === 'object' ? record.item : record;
}

async function loadCompletedArchiveIndex(filePath, recentLimit = 50) {
  const ids = new Set();
  const insertionOrder = [];
  const latestById = new Map();
  if (!filePath || !fs.existsSync(filePath)) {
    return { ids, total: 0, recent: [] };
  }

  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const item = archiveItemFromRecord(JSON.parse(line));
      if (!item?.id) continue;
      const id = String(item.id);
      if (!ids.has(id)) insertionOrder.push(id);
      ids.add(id);
      latestById.set(id, item);
    } catch (_) {
      // A damaged line should not make the rest of an append-only archive unreadable.
    }
  }
  const recent = insertionOrder.slice(-recentLimit).map((id) => latestById.get(id)).filter(Boolean);
  return { ids, total: ids.size, recent };
}

async function* reverseLines(filePath, chunkSize = 64 * 1024) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    let position = stat.size;
    let carry = '';
    while (position > 0) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      const text = buffer.subarray(0, bytesRead).toString('utf8') + carry;
      const parts = text.split('\n');
      carry = parts.shift() || '';
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (parts[index]) yield parts[index];
      }
    }
    if (carry) yield carry;
  } finally {
    await handle.close();
  }
}

async function readCompletedArchivePage(filePath, options = {}) {
  const beforeId = options.before?.id ? String(options.before.id) : null;
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 10));
  const totalCompleted = Math.max(0, Number(options.totalCompleted) || 0);
  if (!filePath || !fs.existsSync(filePath)) {
    return { items: [], hasMore: false, cursor: null, totalCompleted: 0 };
  }

  const latestUpdates = new Map();
  const seenInsertions = new Set();
  const descending = [];
  let beforeFound = !beforeId;
  let hasMore = false;

  for await (const line of reverseLines(filePath)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const item = archiveItemFromRecord(record);
    const id = item?.id ? String(item.id) : '';
    if (!id) continue;
    if (record?.op === 'update') {
      if (!latestUpdates.has(id)) latestUpdates.set(id, item);
      continue;
    }
    if (seenInsertions.has(id)) continue;
    seenInsertions.add(id);
    const latestItem = latestUpdates.get(id) || item;

    if (!beforeFound) {
      if (id === beforeId) beforeFound = true;
      continue;
    }
    if (descending.length < limit) {
      descending.push(latestItem);
      continue;
    }
    hasMore = true;
    break;
  }

  if (beforeId && !beforeFound) {
    return { items: [], hasMore: false, cursor: null, totalCompleted };
  }
  const items = descending.reverse();
  return {
    items,
    hasMore,
    cursor: items[0] ? { id: items[0].id, finishedAt: items[0].finishedAt || null } : null,
    totalCompleted,
  };
}

async function truncateArchive(filePath) {
  const handle = await fsp.open(filePath, 'w', 0o600);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

module.exports = {
  appendJsonLine,
  loadCompletedArchiveIndex,
  readCompletedArchivePage,
  truncateArchive,
};
