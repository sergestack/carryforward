import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectCodexUsage } from '../lib/usage/codex.js';
import { fallbackFile, readFallback } from '../lib/policy/config.js';
import { runFallback, runNext } from '../lib/policy/command.js';
import { formatPlan, formatPlanJson } from '../lib/policy/format.js';
import { planFailover } from '../lib/policy/plan.js';
import { normalizeRuntimeEvidence } from '../lib/policy/runtime.js';
import { quotaAccountId } from '../lib/policy/identity.js';
import { resolveDestination } from '../lib/agents/targets.js';

const ACCOUNT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function codex(target) {
  return {
    agent: 'codex',
    target,
    handoff: { source: true, destination: true },
    configPath: `/srv/${target}`,
    launch: { command: '/bin/codex' },
  };
}

function other(agent, target, destination = true) {
  return {
    agent,
    target,
    handoff: { source: false, destination },
    configPath: `/srv/${target}`,
    launch: destination ? { command: `/bin/${agent}` } : null,
  };
}

function win(name, remaining, duration) {
  return {
    name,
    usedPercent: 100 - remaining,
    remainingPercent: remaining,
    durationMinutes: duration,
    resetsAt: null,
  };
}

function snap(target, windows, state = 'available', extra = {}) {
  return {
    target,
    state,
    source: 'native-cli',
    freshness: 'live',
    cached: false,
    observedAt: '2026-09-28T00:00:00.000Z',
    windows,
    reason: null,
    error: null,
    ...extra,
  };
}

function open(target, remaining5 = 90, remaining7 = 50) {
  return snap(target, [win('5-hour', remaining5, 300), win('7-day', remaining7, 10080)]);
}

const profiles = [
  codex('codex:default'),
  codex('codex:work'),
  codex('codex:second'),
  other('claude', 'claude:default'),
  other('grok', 'grok:default'),
  other('gemini', 'gemini:default', false),
];

function plan(overrides) {
  return planFailover({
    current: 'codex:default',
    order: ['codex:default', 'codex:work', 'codex:second'],
    profiles,
    identities: {
      'codex:default': ACCOUNT_A,
      'codex:work': ACCOUNT_B,
      'codex:second': ACCOUNT_B,
    },
    ...overrides,
  });
}

function capture() {
  const io = { out: '', err: '' };
  io.stdout = { write(chunk) { io.out += chunk; } };
  io.stderr = { write(chunk) { io.err += chunk; } };
  return io;
}

test('skipping an unknown quota group is opt-in and leaves the default planner unchanged', () => {
  const skipped = plan({
    usage: [open('codex:default'), open('codex:work')],
    identities: { 'codex:default': ACCOUNT_A },
    unknownGroupPolicy: 'skip',
  });
  assert.equal(skipped.next, null);
  assert.equal(skipped.candidates.find((candidate) => candidate.target === 'codex:work').reason, 'quota group unknown');

  const missingCurrent = plan({
    usage: [open('codex:default', 0), open('codex:work')],
    identities: { 'codex:work': ACCOUNT_B },
    unknownGroupPolicy: 'skip',
  });
  assert.equal(missingCurrent.next, null);

  const unchanged = plan({
    usage: [open('codex:default'), open('codex:work')],
    identities: {},
  });
  assert.equal(unchanged.next, 'codex:work');
  assert.equal(unchanged.candidates.find((candidate) => candidate.target === 'codex:work').eligible, true);
});

test('an available later target is selected when the current one is blocked', () => {
  const result = plan({
    usage: [
      snap('codex:default', [win('5-hour', 0, 300), win('7-day', 40, 10080)], 'limited'),
      open('codex:work'),
      open('codex:second'),
    ],
    identities: {
      'codex:default': ACCOUNT_A,
      'codex:work': ACCOUNT_B,
      'codex:second': 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    },
  });
  assert.equal(result.next, 'codex:work');
  assert.equal(result.candidates[0].eligible, false);
  assert.equal(result.candidates[1].eligible, true);
});

test('a blocked target is skipped', () => {
  const result = plan({
    usage: [open('codex:default', 0, 40), open('codex:work', 0, 40), open('codex:second')],
    identities: {
      'codex:default': ACCOUNT_A,
      'codex:work': ACCOUNT_B,
      'codex:second': 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    },
  });
  assert.equal(result.next, 'codex:second');
  assert.equal(result.candidates[1].state, 'blocked');
  assert.equal(result.candidates[1].reason, '5-hour exhausted');
});

test('an unknown target is skipped', () => {
  const result = plan({
    usage: [
      open('codex:default', 0, 10),
      snap('codex:work', [], 'unknown', { freshness: 'none', source: 'unavailable' }),
      open('codex:second'),
    ],
  });
  assert.equal(result.next, 'codex:second');
  assert.equal(result.candidates[1].state, 'unknown');
  assert.equal(result.candidates[1].eligible, false);
});

test('an unusable target is skipped', () => {
  const result = plan({
    order: ['gemini:default', 'codex:work'],
    current: 'codex:default',
    usage: [open('codex:default', 0, 10), open('codex:work')],
    identities: { 'codex:default': ACCOUNT_A, 'codex:work': ACCOUNT_B },
  });
  assert.equal(result.next, 'codex:work');
  assert.equal(result.candidates[0].state, 'unusable');
  assert.equal(result.candidates[0].reason, 'not a handoff destination');
});

test('the current target is excluded', () => {
  const result = plan({ usage: [open('codex:default'), open('codex:work'), open('codex:second')] });
  assert.equal(result.next, 'codex:work');
  assert.equal(result.candidates[0].eligible, false);
  assert.equal(result.candidates[0].reason, 'current target');
  assert.equal(result.candidates[0].state, 'available');
});

test('an attempted target is excluded', () => {
  const result = plan({
    attempted: ['codex:work'],
    usage: [open('codex:default', 0, 10), open('codex:work'), open('codex:second')],
    identities: {
      'codex:default': ACCOUNT_A,
      'codex:work': ACCOUNT_B,
      'codex:second': 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    },
  });
  assert.equal(result.next, 'codex:second');
  assert.equal(result.candidates[1].reason, 'already attempted');
  assert.equal(result.candidates[1].eligible, false);
});

test('configured order wins over profile name order', () => {
  const result = plan({
    current: 'codex:default',
    order: ['codex:second', 'codex:work'],
    usage: [open('codex:default', 0, 10), open('codex:work'), open('codex:second')],
    identities: {
      'codex:default': ACCOUNT_A,
      'codex:work': ACCOUNT_B,
      'codex:second': 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    },
  });
  assert.equal(result.next, 'codex:second');
  assert.deepEqual(result.candidates.map((candidate) => candidate.target), ['codex:second', 'codex:work']);
});

test('a zero 5-hour window blocks the target', () => {
  const result = plan({
    usage: [open('codex:default'), open('codex:work', 0, 63), open('codex:second')],
    identities: {
      'codex:default': ACCOUNT_A,
      'codex:work': ACCOUNT_B,
      'codex:second': 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    },
  });
  assert.equal(result.candidates.find((candidate) => candidate.target === 'codex:work').reason, '5-hour exhausted');
  assert.equal(result.next, 'codex:second');
});

test('a provider rate limit with remaining windows still blocks', () => {
  const result = plan({
    usage: [
      open('codex:default', 0, 10),
      snap('codex:work', [win('5-hour', 80, 300), win('7-day', 40, 10080)], 'limited'),
      open('codex:second'),
    ],
    identities: {
      'codex:default': ACCOUNT_A,
      'codex:work': ACCOUNT_B,
      'codex:second': 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    },
  });
  assert.equal(result.candidates.find((candidate) => candidate.target === 'codex:work').reason, 'provider rate limit');
  assert.equal(result.next, 'codex:second');
});

test('a zero weekly window blocks the target', () => {
  const result = plan({
    usage: [open('codex:default'), open('codex:work', 100, 0), open('codex:second')],
    identities: {
      'codex:default': ACCOUNT_A,
      'codex:work': ACCOUNT_B,
      'codex:second': 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    },
  });
  assert.equal(result.candidates.find((candidate) => candidate.target === 'codex:work').reason, '7-day exhausted');
  assert.equal(result.next, 'codex:second');
});

test('an unknown extra bucket does not block a profile with remaining required windows', () => {
  const result = plan({
    usage: [
      open('codex:default', 0, 10),
      snap('codex:work', [win('5-hour', 80, 300), win('7-day', 40, 10080), win('model-x', 0, 15)]),
    ],
    order: ['codex:default', 'codex:work'],
    identities: { 'codex:default': ACCOUNT_A, 'codex:work': ACCOUNT_B },
  });
  assert.equal(result.next, 'codex:work');
  assert.equal(result.candidates[1].state, 'available');
});

test('a current runtime rate limit overrides a live meter and blocks the shared pool', () => {
  const result = plan({
    usage: [open('codex:default'), open('codex:work'), open('codex:second')],
    runtime: [{ target: 'codex:work', kind: 'rate-limit', current: true }],
  });
  assert.equal(result.candidates.find((candidate) => candidate.target === 'codex:work').reason, 'runtime rate limit');
  assert.equal(result.candidates.find((candidate) => candidate.target === 'codex:second').reason, 'shared quota exhausted');
  assert.equal(result.next, null);
});

test('a historical rate limit does not override a live meter', () => {
  const evidence = normalizeRuntimeEvidence([
    { target: 'codex:work', kind: 'rate-limit', current: false },
    { target: 'codex:second', kind: 'rate-limit' },
  ]);
  assert.equal(evidence[0].current, false);
  assert.equal(evidence[1].current, false);
  const result = plan({
    usage: [open('codex:default', 0, 10), open('codex:work'), open('codex:second')],
    runtime: evidence,
    identities: {
      'codex:default': ACCOUNT_A,
      'codex:work': ACCOUNT_B,
      'codex:second': 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    },
  });
  assert.equal(result.next, 'codex:work');
  assert.equal(result.candidates[1].state, 'available');
});

test('duplicate fallback targets are rejected and nothing is written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-fallback-'));
  const io = capture();
  const code = await runFallback(['set', 'codex:default', 'codex-main'], {
    agents: profiles,
    configHome: dir,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 1);
  assert.match(io.err, /Duplicate target 'codex:default'/);
  assert.equal(fs.existsSync(path.join(dir, 'fallback.json')), false);
});

test('an invalid target is rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-fallback-'));
  const io = capture();
  const code = await runFallback(['set', 'codex:', 'not a target'], {
    agents: profiles,
    configHome: dir,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 1);
  assert.match(io.err, /Malformed target 'codex:'/);
  assert.match(io.err, /Malformed target 'not a target'/);
  assert.equal(fs.existsSync(path.join(dir, 'fallback.json')), false);
});

test('a manual-only target is rejected from the automatic chain and remains a destination', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-fallback-'));
  const io = capture();
  const code = await runFallback(['set', 'claude:default', 'grok:default'], {
    agents: profiles,
    configHome: dir,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 1);
  assert.match(io.err, /claude:default is manual-only/);
  assert.match(io.err, /grok:default is manual-only/);
  assert.equal(resolveDestination(profiles, 'claude:default').ok, true);
  assert.equal(resolveDestination(profiles, 'grok:default').ok, true);
  const skipped = plan({
    order: ['claude:default'],
    usage: [open('codex:default', 0, 10), { target: 'claude:default', state: 'unknown', freshness: 'none', windows: [] }],
    identities: {},
  });
  assert.equal(skipped.next, null);
  assert.equal(skipped.candidates[0].state, 'unknown');
  assert.equal(skipped.candidates[0].eligible, false);
});

test('an arbitrary codex profile name can join the chain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-fallback-'));
  const agents = [codex('codex:default'), codex('codex:laptop')];
  const io = capture();
  const code = await runFallback(['set', 'codex:laptop', 'codex:default'], {
    agents,
    configHome: dir,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 0, io.err);
  assert.deepEqual(readFallback({ configHome: dir }).fallback, ['codex:laptop', 'codex:default']);
});

test('no fallback configured yields no next target', () => {
  const result = planFailover({
    current: 'codex:default',
    order: [],
    profiles,
    usage: [open('codex:work')],
  });
  assert.equal(result.next, null);
  assert.deepEqual(result.candidates, []);
});

test('every blocked candidate yields null', () => {
  const result = plan({
    usage: [open('codex:default', 0, 0), open('codex:work', 10, 0), open('codex:second', 0, 20)],
  });
  assert.equal(result.next, null);
  assert.ok(result.candidates.every((candidate) => candidate.eligible === false));
});

test('plan JSON uses the stable candidate schema', () => {
  const result = plan({
    usage: [open('codex:default', 0, 10), open('codex:work'), open('codex:second')],
    identities: {},
  });
  const parsed = JSON.parse(formatPlanJson(result));
  assert.deepEqual(Object.keys(parsed), ['current', 'next', 'candidates']);
  assert.equal(parsed.current, 'codex:default');
  assert.equal(parsed.next, 'codex:work');
  assert.deepEqual(Object.keys(parsed.candidates[1]), ['target', 'state', 'eligible', 'reason']);
  assert.equal(parsed.candidates[1].eligible, true);
  assert.match(formatPlan(result), /NEXT {2}codex:work/);
});

test('the same account maps to one pool and a different account maps to another', () => {
  const result = plan({ usage: [open('codex:default'), open('codex:work'), open('codex:second')] });
  const pools = Object.fromEntries(result.candidates.map((candidate) => [candidate.target, candidate.pool]));
  assert.equal(pools['codex:work'], pools['codex:second']);
  assert.notEqual(pools['codex:default'], pools['codex:work']);
  assert.equal(pools['codex:default'], 'Codex A');
  assert.equal(pools['codex:work'], 'Codex B');
});

test('shared quota exhaustion blocks the sibling profile', () => {
  const result = plan({
    usage: [open('codex:default', 0, 10), open('codex:work', 0, 40), open('codex:second')],
  });
  assert.equal(result.candidates.find((candidate) => candidate.target === 'codex:second').reason, 'shared quota exhausted');
  assert.equal(result.next, null);
});

test('a profile-specific failure does not block its quota sibling', () => {
  const result = plan({
    usage: [open('codex:default', 0, 10), open('codex:work'), open('codex:second')],
    runtime: [{ target: 'codex:work', kind: 'profile', current: true }],
  });
  assert.equal(result.candidates.find((candidate) => candidate.target === 'codex:work').reason, 'profile failure');
  assert.equal(result.next, 'codex:second');
  assert.equal(result.candidates.find((candidate) => candidate.target === 'codex:second').state, 'available');
});

test('account identity never appears in rendered output or JSON', () => {
  const result = plan({
    usage: [open('codex:default', 0, 10), open('codex:work'), open('codex:second')],
    runtime: [{ target: 'codex:work', kind: 'rate-limit', current: true }],
  });
  const rendered = `${formatPlan(result)}\n${formatPlanJson(result)}`;
  assert.doesNotMatch(rendered, new RegExp(ACCOUNT_A));
  assert.doesNotMatch(rendered, new RegExp(ACCOUNT_B));
  assert.doesNotMatch(rendered, /accountId|email|@/);
  assert.match(rendered, /Codex B/);
});

test('quota account ids that look like email or tokens are ignored', () => {
  assert.equal(quotaAccountId({ accountId: ACCOUNT_A }), ACCOUNT_A);
  assert.equal(quotaAccountId({ accountId: 'person@example.com' }), null);
  assert.equal(quotaAccountId({ accountId: 'eyJhbGciOiJub25lIn0.payload' }), null);
  assert.equal(quotaAccountId({}), null);
});

test('the usage snapshot keeps the account id out of its own result', async () => {
  let captured = null;
  const snapshot = await collectCodexUsage(codex('codex:default'), {
    exchange: async () => ({
      accountId: ACCOUNT_A,
      ordinaryUsageAllowed: false,
      rateLimits: {
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1_800_000_000 },
      },
    }),
    captureIdentity(_target, accountId) { captured = accountId; },
  });
  assert.equal(captured, ACCOUNT_A);
  assert.equal(snapshot.state, 'limited');
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(ACCOUNT_A));
});

test('carryforward next plans from the isolated config without printing identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-next-'));
  const agents = [codex('codex:default'), codex('codex:work'), codex('codex:second'), other('claude', 'claude:default')];
  const saved = capture();
  const setCode = await runFallback(['set', 'codex:default', 'codex:work', 'codex:second'], {
    agents,
    configHome: dir,
    stdout: saved.stdout,
    stderr: saved.stderr,
  });
  assert.equal(setCode, 0, saved.err);
  const homes = {
    '/srv/codex:default': ACCOUNT_A,
    '/srv/codex:work': ACCOUNT_B,
    '/srv/codex:second': ACCOUNT_B,
  };
  const io = capture();
  const code = await runNext(['codex:default', '--json', '--rate-limited', 'codex:default'], {
    agents,
    configHome: dir,
    deps: {
      exchange: async ({ home }) => ({
        accountId: homes[home],
        rateLimits: {
          primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 46, windowDurationMins: 10080, resetsAt: 1_800_000_000 },
        },
      }),
    },
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 0, io.err);
  assert.doesNotMatch(io.out, new RegExp(`${ACCOUNT_A}|${ACCOUNT_B}`));
  const parsed = JSON.parse(io.out);
  assert.equal(parsed.next, 'codex:work');
  assert.equal(parsed.candidates[0].state, 'blocked');
  assert.equal(parsed.candidates[0].reason, 'runtime rate limit');
  assert.equal(parsed.candidates[1].pool, parsed.candidates[2].pool);
  assert.notEqual(parsed.candidates[0].pool, parsed.candidates[1].pool);
});

test('fallback config uses CARRYFORWARD_CONFIG_HOME ahead of XDG', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-home-'));
  const xdg = path.join(home, 'xdg');
  const override = path.join(home, 'override');
  assert.equal(
    fallbackFile({ XDG_CONFIG_HOME: xdg }, home),
    path.join(xdg, 'carryforward', 'fallback.json'),
  );
  assert.equal(
    fallbackFile({ CARRYFORWARD_CONFIG_HOME: override, XDG_CONFIG_HOME: xdg }, home),
    path.join(override, 'fallback.json'),
  );
  assert.equal(
    fallbackFile({}, home),
    path.join(home, '.config', 'carryforward', 'fallback.json'),
  );
});
