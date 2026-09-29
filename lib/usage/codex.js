import { spawn } from 'node:child_process';
import { quotaAccountId } from '../policy/identity.js';
import { errorUsage, unknownUsage, usageSnapshot, windowName } from './state.js';

const DEFAULT_TIMEOUT_MS = 12000;

function asPercent(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) return null;
  return number;
}

function asPositive(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

function roundPercent(value) {
  return Math.round(value * 1000) / 1000;
}

// Official Codex app-server `account/rateLimits/read` result.
// Ignores account identifiers. A missing slot stays missing.
export function parseCodexRateLimits(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, reason: 'malformed' };
  }
  const rateLimits = result.rateLimits;
  if (!rateLimits || typeof rateLimits !== 'object' || Array.isArray(rateLimits)) {
    return { ok: false, reason: 'malformed' };
  }
  const windows = [];
  for (const slot of ['primary', 'secondary']) {
    if (!(slot in rateLimits) || rateLimits[slot] == null) continue;
    const raw = rateLimits[slot];
    if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'malformed' };
    const used = asPercent(raw.usedPercent);
    if (used == null) continue;
    const duration = asPositive(raw.windowDurationMins);
    const resets = asPositive(raw.resetsAt);
    windows.push({
      name: windowName(duration, slot),
      usedPercent: used,
      remainingPercent: roundPercent(100 - used),
      resetsAt: resets ? new Date(resets * 1000).toISOString() : null,
      durationMinutes: duration,
    });
  }
  const reached = rateLimits.rateLimitReachedType;
  const rateLimited = (reached != null && reached !== '')
    || rateLimits.spendControlReached === true
    || rateLimits.ordinaryUsageAllowed === false
    || result.ordinaryUsageAllowed === false;
  return { ok: true, windows, rateLimited };
}

export async function collectCodexUsage(profile, deps = {}) {
  const command = profile?.launch?.command;
  const home = profile?.configPath;
  if (!profile?.target) return unknownUsage(null, 'Codex profile has no target id');
  if (!command || !home) {
    return unknownUsage(profile.target, 'Codex profile has no executable or home, so live usage was not queried');
  }
  const exchange = deps.exchange || liveCodexExchange;
  try {
    const result = await exchange({
      command,
      home,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const accountId = quotaAccountId(result);
    if (accountId && typeof deps.captureIdentity === 'function') {
      deps.captureIdentity(profile.target, accountId);
    }
    const parsed = parseCodexRateLimits(result);
    if (!parsed.ok) {
      return errorUsage(profile.target, 'malformed provider response');
    }
    const snapshot = usageSnapshot({
      target: profile.target,
      source: 'native-cli',
      freshness: 'live',
      observedAt: new Date().toISOString(),
      windows: parsed.windows,
      rateLimited: parsed.rateLimited,
      reason: parsed.windows.length ? null : 'Codex returned no quota windows',
    });
    return snapshot;
  } catch (err) {
    const timeout = err && /timeout/i.test(String(err.message || err));
    return errorUsage(profile.target, timeout ? 'timeout' : 'usage command failed');
  }
}

export function liveCodexExchange({ command, home, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server', '--stdio'], {
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buffer = '';
    const messages = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 300).unref?.();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('timeout')), timeoutMs);
    child.on('error', (err) => finish(reject, err));
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith('{')) continue;
        try { messages.push(JSON.parse(line)); } catch { /* ignore non-json */ }
      }
    });
    child.stdin.write(`${JSON.stringify({
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'carryforward', title: 'carryforward', version: '0.1.0' } },
    })}\n`);
    const waitId = (id) => new Promise((res, rej) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const hit = messages.find((message) => message.id === id);
        if (hit) {
          clearInterval(poll);
          if (hit.error) rej(new Error('usage command failed'));
          else res(hit.result);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(poll);
          rej(new Error('timeout'));
        }
      }, 30);
    });
    waitId(1).then(() => {
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      child.stdin.write(`${JSON.stringify({ method: 'account/rateLimits/read', id: 2 })}\n`);
      return waitId(2);
    }).then((result) => finish(resolve, result)).catch((err) => finish(reject, err));
  });
}
