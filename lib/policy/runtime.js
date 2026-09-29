// Normalized evidence from a confirmed current runtime rejection.
// Historical records are kept in the list and ignored by the planner.

export function normalizeRuntimeEvidence(input) {
  const list = Array.isArray(input) ? input : [];
  const evidence = [];
  for (const item of list) {
    if (!item || typeof item.target !== 'string' || item.target.trim() === '') continue;
    if (item.kind !== 'rate-limit' && item.kind !== 'profile') continue;
    evidence.push({
      target: item.target.trim(),
      kind: item.kind,
      current: item.current === true,
    });
  }
  return evidence;
}

export function currentRuntimeByTarget(input) {
  const map = new Map();
  for (const item of normalizeRuntimeEvidence(input)) {
    if (!item.current) continue;
    map.set(item.target, item);
  }
  return map;
}
