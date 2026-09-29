import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCodexUsage, parseCodexRateLimits } from '../lib/usage/codex.js';
import { formatReset, formatUsage, formatUsageJson } from '../lib/usage/format.js';
import { collectMany, collectUsage } from '../lib/usage/registry.js';
import { availabilityState } from '../lib/usage/state.js';
import { runUsage } from '../lib/usage/command.js';

function limits(primary, secondary, extra = {}) {
  return {
    ordinaryUsageAllowed: true,
    accountId: 'should-not-leak',
    rateLimits: {
      limitId: 'codex',
      planType: 'plus',
      rateLimitReachedType: null,
      primary,
      secondary,
      ...extra.rateLimits,
    },
    ...extra.top,
  };
}

function window(used, minutes, resetsAt = 1_800_000_000) {
  return { usedPercent: used, windowDurationMins: minutes, resetsAt };
}

test('live available usage keeps every returned window', () => {
  const parsed = parseCodexRateLimits(limits(window(7, 300), window(46, 10080)));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.windows.map((item) => item.name), ['5-hour', '7-day']);
  assert.equal(parsed.windows[0].remainingPercent, 93);
  assert.equal(parsed.windows[1].usedPercent, 46);
  const state = availabilityState({ freshness: 'live', windows: parsed.windows });
  assert.equal(state, 'available');
});

test('exhausted quota and a partial limit', () => {
  const both = parseCodexRateLimits(limits(window(100, 300), window(100, 10080)));
  assert.equal(availabilityState({ freshness: 'live', windows: both.windows }), 'exhausted');
  const one = parseCodexRateLimits(limits(window(100, 300), window(20, 10080)));
  assert.equal(availabilityState({ freshness: 'live', windows: one.windows }), 'limited');
});

test('a missing window is omitted instead of invented', () => {
  const parsed = parseCodexRateLimits(limits(window(10, 300), undefined));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.windows.map((item) => item.name), ['5-hour']);
  assert.equal(parsed.windows[0].resetsAt.startsWith('2027-'), true);
});

test('zero and one hundred percent stay exact', () => {
  const parsed = parseCodexRateLimits(limits(window(0, 300, null), window(100, 10080, null)));
  assert.equal(parsed.windows[0].usedPercent, 0);
  assert.equal(parsed.windows[0].remainingPercent, 100);
  assert.equal(parsed.windows[0].resetsAt, null);
  assert.equal(parsed.windows[1].remainingPercent, 0);
  assert.equal(formatReset(null), '-');
});

test('malformed provider response is not a meter', () => {
  assert.equal(parseCodexRateLimits(null).ok, false);
  assert.equal(parseCodexRateLimits('nope').ok, false);
  assert.equal(parseCodexRateLimits({ rateLimits: 'nope' }).ok, false);
  assert.equal(parseCodexRateLimits({ rateLimits: { primary: 'bad' } }).ok, false);
});

test('unknown, historical, and timeout do not become available', () => {
  assert.equal(availabilityState({
    freshness: 'historical',
    windows: [{ usedPercent: 100, remainingPercent: 0 }],
  }), 'unknown');
  assert.equal(availabilityState({
    freshness: 'none',
    windows: [{ usedPercent: 0, remainingPercent: 100 }],
  }), 'unknown');
  assert.equal(availabilityState({ freshness: 'none', error: 'timeout', windows: [] }), 'error');
  assert.equal(availabilityState({
    freshness: 'live',
    rateLimited: true,
    windows: [{ usedPercent: 40, remainingPercent: 60 }],
  }), 'limited');
});

test('profiles stay separate, including an arbitrary home with spaces', async () => {
  const seen = [];
  const exchange = async ({ home }) => {
    seen.push(home);
    const used = home.endsWith('work') ? 80 : 1;
    return limits(window(used, 300), null);
  };
  const first = await collectCodexUsage({
    target: 'codex:default',
    agent: 'codex',
    configPath: '/home/other person/.codex',
    launch: { command: '/opt/my bins/codex' },
  }, { exchange });
  const second = await collectCodexUsage({
    target: 'codex:work',
    agent: 'codex',
    configPath: '/srv/codex homes/work',
    launch: { command: '/opt/my bins/codex' },
  }, { exchange });
  assert.deepEqual(seen, ['/home/other person/.codex', '/srv/codex homes/work']);
  assert.equal(first.target, 'codex:default');
  assert.equal(first.windows[0].usedPercent, 1);
  assert.equal(second.target, 'codex:work');
  assert.equal(second.windows[0].usedPercent, 80);
  assert.equal(second.state, 'available');
});

test('timeout and malformed live calls become errors without leaking the payload', async () => {
  const timed = await collectCodexUsage({
    target: 'codex:default',
    configPath: '/home/other/.codex',
    launch: { command: '/bin/codex' },
  }, { exchange: async () => { throw new Error('timeout'); } });
  assert.equal(timed.state, 'error');
  assert.equal(timed.error, 'timeout');
  assert.deepEqual(timed.windows, []);
  const bad = await collectCodexUsage({
    target: 'codex:default',
    configPath: '/home/other/.codex',
    launch: { command: '/bin/codex' },
  }, { exchange: async () => ({ accountId: 'secret-account', token: 'bearer secret' }) });
  assert.equal(bad.state, 'error');
  assert.equal(bad.error, 'malformed provider response');
  assert.doesNotMatch(JSON.stringify(bad), /secret-account|bearer|token/);
});

test('providers without a live meter stay unknown', async () => {
  const entries = await collectMany([
    { agent: 'claude', target: 'claude:default' },
    { agent: 'grok', target: 'grok:default' },
    { agent: 'gemini', target: 'gemini:default' },
    { agent: 'opencode', target: 'opencode:default' },
    { agent: 'copilot', target: 'copilot:default' },
  ]);
  assert.ok(entries.every((entry) => entry.state === 'unknown'));
  assert.ok(entries.every((entry) => entry.windows.length === 0));
  assert.match(entries[0].reason, /OAuth credentials/);
  assert.match(entries[1].reason, /auth\.json/);
});

test('usage JSON schema hides internal flags and credentials', async () => {
  const agents = [
    {
      agent: 'codex',
      target: 'codex:default',
      configPath: '/home/other/.codex',
      handoff: { destination: true },
      launch: { command: '/bin/codex' },
    },
    { agent: 'claude', target: 'claude:default', handoff: { destination: true } },
  ];
  let out = '';
  const code = await runUsage(['--json'], {
    agents,
    now: Date.parse('2026-09-28T12:00:00Z'),
    deps: {
      exchange: async () => limits(window(7, 300, 1_800_000_000), window(46, 10080, null)),
    },
    stdout: { write(chunk) { out += chunk; } },
    stderr: { write() {} },
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed), ['usage']);
  const codex = parsed.usage[0];
  assert.deepEqual(Object.keys(codex), [
    'target', 'state', 'source', 'freshness', 'cached', 'observedAt', 'windows', 'reason', 'error',
  ]);
  assert.equal(codex.target, 'codex:default');
  assert.equal(codex.state, 'available');
  assert.equal(codex.source, 'native-cli');
  assert.equal(codex.freshness, 'live');
  assert.equal(codex.cached, false);
  assert.equal(codex.windows[1].resetsAt, null);
  assert.equal(parsed.usage[1].state, 'unknown');
  assert.equal(parsed.usage[1].freshness, 'none');
  assert.doesNotMatch(out, /accountId|bearer|auth\.json|secret/);
  const table = formatUsage(parsed.usage, Date.parse('2026-09-28T12:00:00Z'));
  assert.match(table, /codex:default\s+available\s+5-hour/);
  assert.match(table, /claude:default\s+unknown/);
});

test('a single target is selected without querying the others', async () => {
  const seen = [];
  const agents = [
    { agent: 'codex', target: 'codex:default', configPath: '/a', handoff: { destination: true }, launch: { command: '/bin/codex' } },
    { agent: 'codex', target: 'codex:second', configPath: '/b', handoff: { destination: true }, launch: { command: '/bin/codex' } },
  ];
  let out = '';
  const code = await runUsage(['codex-second'], {
    agents,
    deps: {
      exchange: async ({ home }) => {
        seen.push(home);
        return limits(window(3, 300), null);
      },
    },
    stdout: { write(chunk) { out += chunk; } },
    stderr: { write() {} },
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, ['/b']);
  assert.match(out, /codex:second/);
  assert.doesNotMatch(out, /codex:default/);
});
