import { canonicalTargetId } from '../agents/targets.js';
import { currentRuntimeByTarget } from './runtime.js';

const REQUIRED_WINDOWS = new Set(['5-hour', '7-day']);
const REQUIRED_MINUTES = new Set([300, 10080]);

function requiredWindow(window) {
  if (!window || typeof window !== 'object') return false;
  if (REQUIRED_WINDOWS.has(window.name)) return true;
  return REQUIRED_MINUTES.has(window.durationMinutes);
}

function remaining(window) {
  if (typeof window.remainingPercent === 'number') return window.remainingPercent;
  if (typeof window.usedPercent === 'number') return 100 - window.usedPercent;
  return null;
}

function poolName(index) {
  let n = index;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Codex ${letters}`;
}

// Labels follow the configured order. The provider id never leaves this function.
function poolLabels(order, identities) {
  const labels = new Map();
  const seen = new Map();
  for (const target of order) {
    const id = identities?.[target];
    if (typeof id !== 'string' || id === '') continue;
    if (!seen.has(id)) seen.set(id, poolName(seen.size));
    labels.set(target, seen.get(id));
  }
  return labels;
}

function classifyMeter(profile, snapshot) {
  if (!profile || profile.handoff?.destination !== true) {
    return { state: 'unusable', scope: null, reason: 'not a handoff destination' };
  }
  if (profile.agent !== 'codex') {
    return { state: 'unknown', scope: null, reason: 'no reliable usage meter' };
  }
  if (!snapshot || snapshot.freshness !== 'live') {
    return { state: 'unknown', scope: null, reason: 'unknown capacity' };
  }
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows.filter(requiredWindow) : [];
  if (windows.length === 0) {
    return { state: 'unknown', scope: null, reason: 'unknown capacity' };
  }
  const exhausted = windows.find((window) => remaining(window) === 0);
  if (exhausted) {
    return { state: 'blocked', scope: 'quota', reason: `${exhausted.name} exhausted` };
  }
  if (windows.some((window) => remaining(window) == null)) {
    return { state: 'unknown', scope: null, reason: 'unknown capacity' };
  }
  if (snapshot.state === 'limited' || snapshot.state === 'exhausted') {
    return { state: 'blocked', scope: 'quota', reason: 'provider rate limit' };
  }
  if (snapshot.state === 'available') {
    return { state: 'available', scope: null, reason: 'available' };
  }
  return { state: 'unknown', scope: null, reason: 'unknown capacity' };
}

function classifyTarget(profile, snapshot, runtime) {
  if (!profile || profile.handoff?.destination !== true) {
    return { state: 'unusable', scope: null, reason: 'not a handoff destination' };
  }
  if (runtime?.kind === 'rate-limit') {
    return { state: 'blocked', scope: 'quota', reason: 'runtime rate limit' };
  }
  if (runtime?.kind === 'profile') {
    return { state: 'blocked', scope: 'profile', reason: 'profile failure' };
  }
  return classifyMeter(profile, snapshot);
}

function propagateQuota(classes, identities) {
  const groups = new Map();
  for (const [target, row] of classes) {
    const id = identities?.[target];
    if (typeof id !== 'string' || id === '') continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(target);
  }
  for (const members of groups.values()) {
    const exhausted = members.some((target) => {
      const row = classes.get(target);
      return row.state === 'blocked' && row.scope === 'quota';
    });
    if (!exhausted) continue;
    for (const target of members) {
      const row = classes.get(target);
      if (row.state === 'unusable') continue;
      if (row.state === 'blocked' && (row.scope === 'quota' || row.scope === 'profile')) continue;
      classes.set(target, { state: 'blocked', scope: 'quota', reason: 'shared quota exhausted' });
    }
  }
}

function placeholder(target) {
  return { target, agent: null, handoff: { destination: false } };
}

export function planFailover(input = {}) {
  const current = input.current ? canonicalTargetId(input.current) : null;
  const order = (input.order || []).map((target) => canonicalTargetId(target));
  const attempted = new Set((input.attempted || []).map((target) => canonicalTargetId(target)));
  const profiles = new Map((input.profiles || []).map((profile) => [profile.target, profile]));
  const usage = new Map((input.usage || []).map((snapshot) => [snapshot.target, snapshot]));
  const runtime = currentRuntimeByTarget(input.runtime);
  const identities = input.identities || {};

  const considered = [];
  for (const target of [...order, current, ...attempted]) {
    if (!target || considered.includes(target)) continue;
    considered.push(target);
  }

  const classes = new Map();
  for (const target of considered) {
    const profile = profiles.get(target) || placeholder(target);
    classes.set(target, classifyTarget(profile, usage.get(target), runtime.get(target)));
  }
  propagateQuota(classes, identities);

  const labels = poolLabels(order, identities);
  const candidates = order.map((target) => {
    const row = classes.get(target);
    let { reason } = row;
    let eligible = row.state === 'available';
    if (attempted.has(target)) {
      eligible = false;
      if (row.state === 'available') reason = 'already attempted';
    }
    if (target === current) {
      eligible = false;
      if (row.state === 'available') reason = 'current target';
    }
    if (input.unknownGroupPolicy === 'skip' && eligible && profiles.get(target)?.agent === 'codex') {
      const currentId = identities[current];
      const groupId = identities[target];
      if (typeof currentId !== 'string' || typeof groupId !== 'string') {
        eligible = false;
        reason = 'quota group unknown';
      }
    }
    const candidate = { target, state: row.state, eligible, reason };
    const pool = labels.get(target);
    if (pool) candidate.pool = pool;
    return candidate;
  });

  return {
    current,
    next: candidates.find((candidate) => candidate.eligible)?.target || null,
    candidates,
  };
}
