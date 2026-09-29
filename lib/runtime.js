import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function packageInfo() {
  const root = packageRoot();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return { root, version: String(pkg.version), name: pkg.name };
}

export function nodeSatisfies(version, minimum = '22.5.0') {
  const parse = (value) => String(value).replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  const got = parse(version);
  const need = parse(minimum);
  for (let i = 0; i < 3; i += 1) {
    if (got[i] > need[i]) return true;
    if (got[i] < need[i]) return false;
  }
  return true;
}

export function commandOnPath(name, env = process.env) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
