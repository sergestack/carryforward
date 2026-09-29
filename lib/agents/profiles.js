import path from 'node:path';

export function cleanPath(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (trimmed.length > 1 && trimmed.endsWith(path.sep)) return trimmed.slice(0, -1);
  return trimmed;
}

export function uniquePaths(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const cleaned = cleanPath(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

export function profileName(dir, rootName) {
  const base = path.basename(dir);
  if (base === rootName) return 'default';
  const prefix = `${rootName}-`;
  if (base.startsWith(prefix)) return base.slice(prefix.length);
  return base;
}

export function siblingDirs(probe, rootName) {
  return probe
    .listDir(probe.home)
    .filter((name) => name === rootName || name.startsWith(`${rootName}-`))
    .map((name) => path.join(probe.home, name))
    .filter((dir) => probe.isDirectory(dir));
}

export function byProfile(a, b) {
  if (a.profile === 'default') return -1;
  if (b.profile === 'default') return 1;
  return String(a.profile).localeCompare(String(b.profile));
}
