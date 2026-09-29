// Pure availability rules. A meter only counts when this observation is live.
export function availabilityState(input) {
  const freshness = input?.freshness || 'none';
  const windows = Array.isArray(input?.windows) ? input.windows : [];
  if (freshness !== 'live') return input?.error ? 'error' : 'unknown';
  const known = windows.filter((window) =>
    typeof window.remainingPercent === 'number' || typeof window.usedPercent === 'number');
  if (known.length === 0) return input?.error ? 'error' : 'unknown';
  const usedUp = (window) => window.remainingPercent === 0 || window.usedPercent === 100;
  const exhausted = known.filter(usedUp).length;
  if (exhausted === known.length) return 'exhausted';
  if (exhausted > 0 || input.rateLimited === true) return 'limited';
  if (known.some((window) => remainingOf(window) > 0)) return 'available';
  return 'unknown';
}

function remainingOf(window) {
  if (typeof window.remainingPercent === 'number') return window.remainingPercent;
  if (typeof window.usedPercent === 'number') return 100 - window.usedPercent;
  return 0;
}

export function windowName(durationMinutes, fallback) {
  if (typeof durationMinutes !== 'number' || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return fallback;
  }
  if (durationMinutes % 1440 === 0) {
    const days = durationMinutes / 1440;
    return days === 1 ? '1-day' : `${days}-day`;
  }
  if (durationMinutes % 60 === 0) {
    const hours = durationMinutes / 60;
    return hours === 1 ? '1-hour' : `${hours}-hour`;
  }
  return `${durationMinutes}m`;
}

export function usageSnapshot(fields) {
  const draft = {
    freshness: fields.freshness || 'none',
    windows: fields.windows || [],
    rateLimited: Boolean(fields.rateLimited),
    error: fields.error ?? null,
  };
  return {
    target: fields.target,
    state: fields.state || availabilityState(draft),
    source: fields.source || 'unavailable',
    freshness: draft.freshness,
    cached: false,
    observedAt: fields.observedAt || null,
    windows: draft.windows,
    reason: fields.reason ?? null,
    error: draft.error,
  };
}

export function unknownUsage(target, reason) {
  return usageSnapshot({
    target,
    source: 'unavailable',
    freshness: 'none',
    reason,
  });
}

export function errorUsage(target, error) {
  return usageSnapshot({
    target,
    source: 'native-cli',
    freshness: 'none',
    error,
  });
}
