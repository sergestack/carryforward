import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalTargetId, destinationFailure, isLegacyAlias, resolveDestination } from '../agents/targets.js';

const TARGET_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function fallbackFile(env = process.env, home = os.homedir()) {
  if (env.CARRYFORWARD_CONFIG_HOME) return path.join(env.CARRYFORWARD_CONFIG_HOME, 'fallback.json');
  const base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'carryforward', 'fallback.json');
}

export function configPath(options = {}) {
  if (options.configFile) return options.configFile;
  if (options.configHome) return path.join(options.configHome, 'fallback.json');
  return fallbackFile(options.env, options.home);
}

export function emptyFallback() {
  return { version: 1, fallback: [] };
}

export function readFallback(options = {}) {
  const file = configPath(options);
  if (!fs.existsSync(file)) return emptyFallback();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Fallback config is unreadable. CarryForward left the file unchanged.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Fallback config is unreadable. CarryForward left the file unchanged.');
  }
  if (parsed.version !== 1) {
    const shown = parsed.version === undefined ? 'missing' : String(parsed.version);
    throw new Error(`Fallback config version ${shown} is not supported. CarryForward left the file unchanged.`);
  }
  if (!Array.isArray(parsed.fallback) || parsed.fallback.some((item) => typeof item !== 'string')) {
    throw new Error('Fallback config is unreadable. CarryForward left the file unchanged.');
  }
  return { version: 1, fallback: parsed.fallback };
}

export function writeFallback(config, options = {}) {
  const file = configPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify({ version: 1, fallback: config.fallback }, null, 2)}\n`;
  fs.writeFileSync(file, body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function wellFormedTarget(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split(':');
  if (parts.length !== 2) return false;
  return TARGET_PART.test(parts[0]) && TARGET_PART.test(parts[1]);
}

export function validateFallback(tokens, agents) {
  const errors = [];
  const seen = new Set();
  const fallback = [];
  if (!tokens.length) errors.push('Provide at least one target.');
  for (const token of tokens) {
    const raw = typeof token === 'string' ? token.trim() : '';
    if (!isLegacyAlias(raw) && !wellFormedTarget(raw)) {
      errors.push(`Malformed target '${token}'.`);
      continue;
    }
    const id = canonicalTargetId(raw);
    if (!wellFormedTarget(id)) {
      errors.push(`Malformed target '${token}'.`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`Duplicate target '${id}'.`);
      continue;
    }
    seen.add(id);
    const resolved = resolveDestination(agents, id);
    if (!resolved.ok) {
      errors.push(destinationFailure(resolved, raw));
      continue;
    }
    if (resolved.profile.agent !== 'codex') {
      errors.push(`${id} is manual-only until CarryForward has a reliable usage meter. Hand off with \`carryforward ${id}\`.`);
      continue;
    }
    fallback.push(id);
  }
  return { ok: errors.length === 0, errors, fallback };
}
