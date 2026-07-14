function applyCollection(currentValues, patch = {}) {
  const values = Array.isArray(currentValues) ? currentValues : [];
  const map = new Map(values.filter((value) => value?.id).map((value) => [String(value.id), value]));
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

  return values
    .map((value) => map.get(String(value.id)))
    .filter(Boolean)
    .concat([...map].filter(([id]) => !values.some((value) => String(value.id) === id)).map(([, value]) => value));
}

export function applyOutputPatch(snapshot, patch) {
  if (!snapshot || !patch) return { applied: false, gap: false };
  const currentSequence = Number(snapshot.outputSequence) || 0;
  const nextSequence = Number(patch.sequence) || 0;
  if (nextSequence && nextSequence <= currentSequence) return { applied: false, gap: false };
  if (nextSequence && currentSequence && nextSequence !== currentSequence + 1) {
    return { applied: false, gap: true };
  }

  snapshot.output = applyCollection(snapshot.output, patch.output);
  snapshot.outputGroups = applyCollection(snapshot.outputGroups, patch.outputGroups);
  if (patch.outputHistory) snapshot.outputHistory = patch.outputHistory;
  if (nextSequence) snapshot.outputSequence = nextSequence;
  return { applied: true, gap: false };
}
