function applyCollection(currentValues, patch = {}) {
  const values = Array.isArray(currentValues) ? currentValues : [];
  const map = new Map();
  const currentOrder = [];
  for (const value of values) {
    if (!value?.id) continue;
    const id = String(value.id);
    if (!map.has(id)) currentOrder.push(id);
    map.set(id, value);
  }
  for (const id of patch.remove || []) map.delete(String(id));
  for (const value of patch.upsert || []) {
    if (value?.id) map.set(String(value.id), value);
  }

  if (Array.isArray(patch.order)) {
    const ordered = [];
    const included = new Set();
    for (const id of patch.order) {
      const value = map.get(String(id));
      if (!value) continue;
      ordered.push(value);
      included.add(String(id));
    }
    for (const [id, value] of map) {
      if (!included.has(id)) ordered.push(value);
    }
    return ordered;
  }

  const ordered = currentOrder.map((id) => map.get(id)).filter(Boolean);
  const included = new Set(currentOrder);
  for (const [id, value] of map) {
    if (!included.has(id)) ordered.push(value);
  }
  return ordered;
}

export function applyOutputPatch(snapshot, patch) {
  if (!snapshot || !patch) return { applied: false, gap: false };
  const currentSequence = Number(snapshot.outputSequence) || 0;
  const nextSequence = Number(patch.sequence) || 0;
  if (nextSequence && nextSequence <= currentSequence) return { applied: false, gap: false };
  if (nextSequence && nextSequence !== currentSequence + 1) {
    return { applied: false, gap: true };
  }

  snapshot.output = applyCollection(snapshot.output, patch.output);
  snapshot.outputGroups = applyCollection(snapshot.outputGroups, patch.outputGroups);
  if (patch.outputHistory) snapshot.outputHistory = patch.outputHistory;
  if (nextSequence) snapshot.outputSequence = nextSequence;
  return { applied: true, gap: false };
}
