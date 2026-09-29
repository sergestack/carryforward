const HEADERS = ['TARGET', 'STATE', 'WINDOW', 'USED', 'LEFT', 'RESETS'];

export function formatReset(iso, now = Date.now()) {
  if (!iso) return '-';
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return '-';
  if (ms <= 0) return 'due';
  const minutes = Math.round(ms / 60000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const remain = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return remain > 0 ? `${hours}h ${remain}m` : `${hours}h`;
  return `${Math.max(remain, 1)}m`;
}

function percent(value) {
  return typeof value === 'number' ? `${value}%` : '-';
}

export function formatUsage(entries, now = Date.now()) {
  const rows = [];
  for (const entry of entries) {
    const windows = entry.windows?.length ? entry.windows : [null];
    windows.forEach((window, index) => {
      rows.push([
        index === 0 ? (entry.target || '-') : '',
        index === 0 ? entry.state : '',
        window?.name || '-',
        percent(window?.usedPercent),
        percent(window?.remainingPercent),
        formatReset(window?.resetsAt, now),
      ]);
    });
  }
  const widths = HEADERS.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length), 1));
  const line = (cols) => cols.map((col, index) => col.padEnd(widths[index])).join('  ').trimEnd();
  return [line(HEADERS), ...rows.map(line), ''].join('\n');
}

export function formatUsageJson(entries) {
  const usage = entries.map((entry) => ({
    target: entry.target,
    state: entry.state,
    source: entry.source,
    freshness: entry.freshness,
    cached: entry.cached,
    observedAt: entry.observedAt,
    windows: entry.windows,
    reason: entry.reason,
    error: entry.error,
  }));
  return `${JSON.stringify({ usage }, null, 2)}\n`;
}
