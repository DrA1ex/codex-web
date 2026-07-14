'use strict';

function stableJson(value) {
  return JSON.stringify(value);
}

function byId(values) {
  return new Map((values || []).filter((value) => value?.id).map((value) => [String(value.id), value]));
}

function sameOrder(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function diffCollection(previousValues, nextValues) {
  const previous = byId(previousValues);
  const next = byId(nextValues);
  const upsert = [];
  const remove = [];

  for (const [id, value] of next) {
    const oldValue = previous.get(id);
    if (!oldValue || stableJson(oldValue) !== stableJson(value)) upsert.push(value);
  }
  for (const id of previous.keys()) {
    if (!next.has(id)) remove.push(id);
  }

  const previousOrder = (previousValues || []).map((value) => String(value.id));
  const nextOrder = (nextValues || []).map((value) => String(value.id));
  return {
    upsert,
    remove,
    order: sameOrder(previousOrder, nextOrder) ? null : nextOrder,
  };
}

function createOutputPatch(previousPayload, nextPayload, sequence) {
  const previous = previousPayload || { output: [], outputGroups: [], outputHistory: { hasMore: false } };
  const output = diffCollection(previous.output, nextPayload.output);
  const groups = diffCollection(previous.outputGroups, nextPayload.outputGroups);
  const historyChanged = stableJson(previous.outputHistory || {}) !== stableJson(nextPayload.outputHistory || {});

  return {
    sequence,
    output: {
      upsert: output.upsert,
      remove: output.remove,
      order: output.order,
    },
    outputGroups: {
      upsert: groups.upsert,
      remove: groups.remove,
      order: groups.order,
    },
    outputHistory: historyChanged ? nextPayload.outputHistory : null,
  };
}

module.exports = { createOutputPatch };
