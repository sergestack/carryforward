import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { matchBoundSession, selectBoundSession } from '../lib/supervisor/bind.js';
import { runSupervised } from '../lib/supervisor/command.js';
import { supervise } from '../lib/supervisor/machine.js';
import { launchChild, stopOwnedChild } from '../lib/supervisor/process.js';
import { classifyQuotaRecord } from '../lib/supervisor/quota.js';
import { readSessionHeader, waitForSupervisedEvent } from '../lib/supervisor/watch.js';

const ACCOUNT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ACCOUNT_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const EMAIL = 'person@example.com';
const TOKEN = 'fixture-token-should-not-leak';
const CREATOR = 'acct-secret-should-not-leak';
const root = path.resolve(import.meta.dirname, '..');

function codex(target, home = `/srv/${target}`) {
  return {
    agent: 'codex',
    target,
    profile: target.split(':')[1],
    handoff: { source: true, destination: true },
    configPath: home,
    installed: true,
    launch: { command: `/opt/codex-bin/${target}`, args: [], env: { CODEX_HOME: home } },
  };
}

function manual(agent, target) {
  return {
    agent,
    target,
    profile: 'default',
    handoff: { source: agent !== 'grok', destination: true },
    configPath: `/srv/${target}`,
    installed: true,
    launch: { command: `/opt/${agent}`, args: [], env: {} },
  };
}

function win(name, remaining, duration) {
  return { name, usedPercent: 100 - remaining, remainingPercent: remaining, durationMinutes: duration, resetsAt: null };
}

function open(target) {
  return {
    target,
    state: 'available',
    source: 'native-cli',
    freshness: 'live',
    cached: false,
    observedAt: '2026-09-29T00:00:00.000Z',
    windows: [win('5-hour', 80, 300), win('7-day', 40, 10080)],
    reason: null,
    error: null,
  };
}

const profiles = [
  codex('codex:default', '/srv/codex default'),
  codex('codex:work', '/srv/codex-work'),
  codex('codex:second', '/srv/codex-second'),
  codex('codex:third', '/srv/codex-third'),
  manual('claude', 'claude:default'),
  manual('grok', 'grok:default'),
];

function evidence(identities = {
  'codex:default': ACCOUNT_A,
  'codex:work': ACCOUNT_B,
  'codex:second': ACCOUNT_B,
  'codex:third': ACCOUNT_C,
}) {
  return {
    identities,
    usage: profiles.filter((profile) => profile.agent === 'codex').map((profile) => open(profile.target)),
  };
}

function quotaOutcome(id = '11111111-1111-4111-8111-111111111111', file = '/srv/rollout-exact.jsonl') {
  return {
    type: 'quota',
    code: 'usage_limit_exceeded',
    session: { id, path: file, cwd: '/work/my project' },
  };
}

function capture() {
  const io = { out: '', err: '' };
  io.stdout = { write(chunk) { io.out += chunk; } };
  io.stderr = { write(chunk) { io.err += chunk; } };
  return io;
}

async function scriptedRun(options) {
  const calls = { launch: [], stop: 0, handoff: [], usage: 0, waitExit: 0, timeline: [] };
  const io = { out: '' };
  let step = 0;
  const outcomes = options.outcomes || [{ type: 'exit', code: 0, signal: null }];
  const userStop = options.userStop || { requested: false };
  const result = await supervise({
    target: options.target || 'codex:default',
    order: options.order || ['codex:default', 'codex:work', 'codex:second', 'claude:default', 'grok:default'],
    profiles: options.profiles || profiles,
    manualDestinations: options.manualDestinations === undefined ? ['claude:default', 'grok:default'] : options.manualDestinations,
    cwd: options.cwd || '/work/my project',
    verbose: Boolean(options.verbose),
    userStop,
    log(line) { io.out += `${line}\n`; },
    deps: {
      now: () => options.now || Date.now(),
      async launch(profile, plan) {
        calls.timeline.push(`launch:${profile.target}`);
        calls.launch.push({
          target: profile.target,
          command: plan?.binary || profile.launch.command,
          args: plan?.args || profile.launch.args || [],
          env: plan?.env || profile.launch.env,
        });
        if (options.launchError && calls.launch.length > 1) throw new Error(`boom ${EMAIL}`);
        return { pid: calls.launch.length, settled: false, result: null, finished: new Promise(() => {}), kill() {}, async waitFor() { return false; } };
      },
      async wait() {
        if (options.interruptOnWait) userStop.requested = true;
        if (step >= outcomes.length) throw new Error('supervisor waited again after the script ended');
        return outcomes[step++];
      },
      async stop() {
        calls.timeline.push('stop');
        calls.stop += 1;
        if (options.stopFails) return { stopped: false };
        return { stopped: true };
      },
      async waitExit() {
        calls.waitExit += 1;
        return { code: 0 };
      },
      async usage() {
        calls.usage += 1;
        return options.evidence || evidence();
      },
      async buildHandoff(request) {
        calls.timeline.push('handoff');
        calls.handoff.push(request);
        if (options.handoffThrows) throw new Error(`extract failed ${EMAIL} ${TOKEN}`);
        if (options.handoffFails) return { ok: false, error: `missing ${EMAIL}` };
        const destination = profiles.find((profile) => profile.target === request.destination);
        return {
          ok: true,
          bytes: 128,
          plan: {
            binary: destination.launch.command,
            args: ['-c', 'model_reasoning_effort="high"', 'read the handoff file'],
            env: destination.launch.env,
          },
        };
      },
    },
  });
  return { result, calls, io };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeRollout(dir, { id, cwd, source = 'cli', thread = 'user', parent = '', timestamp, events = [] }) {
  const folder = path.join(dir, '2026', '09', '29');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `rollout-${id}.jsonl`);
  const header = {
    type: 'session_meta',
    timestamp,
    payload: {
      id,
      session_id: id,
      cwd,
      source,
      timestamp,
      thread_source: thread,
      ...(parent ? { parent_thread_id: parent } : {}),
      creator_account_id: CREATOR,
      creator_user_id: EMAIL,
      base_instructions: TOKEN,
    },
  };
  fs.writeFileSync(file, [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))].join('\n') + '\n');
  return file;
}

function quotaEvent(timestamp, code = 'usage_limit_exceeded', payloadType = 'error') {
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: payloadType,
      codex_error_info: code,
      message: `usage limit for ${EMAIL} token ${TOKEN}`,
    },
  };
}

function heldChild(ms = 5000, code = 0, signal = null) {
  let settled = false;
  let result = null;
  let resolve;
  const finished = new Promise((done) => { resolve = done; });
  const timer = setTimeout(() => {
    settled = true;
    result = { code, signal };
    resolve(result);
  }, ms);
  return {
    pid: 424242,
    get settled() { return settled; },
    get result() { return result; },
    finished,
    kill() {},
    async waitFor() { return settled; },
    cancel() { clearTimeout(timer); },
    finish(nextCode = code, nextSignal = signal) {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      result = { code: nextCode, signal: nextSignal };
      resolve(result);
    },
  };
}

test('only the exact usage_limit_exceeded record is a quota event', () => {
  assert.deepEqual(classifyQuotaRecord(quotaEvent('2026-09-29T00:00:00.000Z')).code, 'usage_limit_exceeded');
  assert.equal(classifyQuotaRecord({
    type: 'event_msg',
    timestamp: '2026-09-29T00:00:00.000Z',
    payload: { type: 'task_complete', error: { codex_error_info: 'usage_limit_exceeded' } },
  }).code, 'usage_limit_exceeded');
  assert.equal(classifyQuotaRecord({ type: 'usage_limit_exceeded', timestamp: '2026-09-29T00:00:00.000Z' }).code, 'usage_limit_exceeded');
  assert.equal(classifyQuotaRecord(quotaEvent('2026-09-29T00:00:00.000Z', 'rate_limit_exceeded')), null);
  assert.equal(classifyQuotaRecord(quotaEvent('2026-09-29T00:00:00.000Z', 'session_budget_exceeded')), null);
  assert.equal(classifyQuotaRecord({
    type: 'event_msg',
    payload: { type: 'error', message: 'You have hit your usage limit' },
  }), null);
  assert.equal(classifyQuotaRecord({
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'usage_limit_exceeded' },
  }), null);
});

test('a session header keeps account and prompt fields out of the bind record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-header-'));
  const file = writeRollout(dir, { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: '/work', timestamp: '2026-09-29T00:00:00.000Z' });
  const header = readSessionHeader(file);
  assert.equal(header.id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(JSON.stringify(header).includes(CREATOR), false);
  assert.equal(JSON.stringify(header).includes(EMAIL), false);
  assert.equal(JSON.stringify(header).includes(TOKEN), false);
});

test('binding prefers the child file and fails closed when two primaries match', () => {
  const one = { id: 'one', openedByChild: true, bornAfterStart: true, cwdMatches: true, cliSource: true, threadSource: 'user', parentThreadId: '' };
  const other = { ...one, id: 'other' };
  assert.equal(selectBoundSession([one]).session.id, 'one');
  assert.equal(selectBoundSession([one, other]).status, 'ambiguous');
  assert.equal(selectBoundSession([{ ...other, openedByChild: false }], { openFilesAvailable: true }).status, 'pending');
  assert.equal(selectBoundSession([{ ...other, openedByChild: false }], { openFilesAvailable: false }).session.id, 'other');
  const sub = { ...one, id: 'sub', threadSource: 'subagent' };
  assert.equal(selectBoundSession([one, sub]).session.id, 'one');
  assert.equal(selectBoundSession([sub]).status, 'pending');
});

test('an exact session id and path match, and a prefix does not', () => {
  const file = path.join(os.tmpdir(), 'rollout-exact.jsonl');
  fs.writeFileSync(file, '{}\n');
  const sessions = [{ id: 'abc', originalPath: file }, { id: 'abcdef', originalPath: `${file}.other` }];
  assert.equal(matchBoundSession(sessions, { id: 'abc', path: file }).ok, true);
  assert.equal(matchBoundSession(sessions, { id: 'ab', path: file }).ok, false);
  assert.equal(matchBoundSession(sessions, { id: 'abc', path: `${file}.missing` }).ok, false);
  assert.equal(matchBoundSession([{ id: 'abc', originalPath: file }, { id: 'abc', originalPath: file }], { id: 'abc', path: file }).ok, false);
});

test('a supervised child that exits is not replaced', async () => {
  const { result, calls, io } = await scriptedRun({ outcomes: [{ type: 'exit', code: 0, signal: null }] });
  assert.equal(result.state, 'completed');
  assert.equal(result.code, 0);
  assert.deepEqual(result.launches, ['codex:default']);
  assert.equal(calls.handoff.length, 0);
  assert.equal(calls.stop, 0);
  assert.equal(io.out.includes('continuing with'), false);
});

test('a nonzero child exit does not fail over', async () => {
  const { result, calls } = await scriptedRun({ outcomes: [{ type: 'exit', code: 2, signal: null }] });
  assert.equal(result.state, 'completed');
  assert.equal(result.code, 2);
  assert.equal(calls.launch.length, 1);
});

test('a user interrupt does not fail over', async () => {
  const { result, calls } = await scriptedRun({
    interruptOnWait: true,
    outcomes: [quotaOutcome()],
  });
  assert.equal(result.state, 'user_exit');
  assert.equal(result.code, 130);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.stop, 1);
  assert.equal(calls.handoff.length, 0);
});

test('a child SIGINT is a user exit', async () => {
  const { result, calls } = await scriptedRun({ outcomes: [{ type: 'exit', code: null, signal: 'SIGINT' }] });
  assert.equal(result.state, 'user_exit');
  assert.equal(result.code, 130);
  assert.equal(calls.stop, 0);
  assert.equal(calls.launch.length, 1);
});

test('a confirmed rate limit asks the planner and keeps the exact session', async () => {
  const session = quotaOutcome();
  const { result, calls, io } = await scriptedRun({
    outcomes: [session, { type: 'exit', code: 0, signal: null }],
    order: ['codex:work', 'codex:second', 'codex:default'],
  });
  assert.equal(calls.usage, 1);
  assert.equal(calls.handoff[0].sourceTarget, 'codex:default');
  assert.equal(calls.handoff[0].session.id, session.session.id);
  assert.equal(calls.handoff[0].session.path, session.session.path);
  assert.equal(calls.handoff[0].destination, 'codex:work');
  assert.deepEqual(calls.timeline, ['launch:codex:default', 'handoff', 'stop', 'launch:codex:work']);
  assert.equal(result.launches[1], 'codex:work');
  assert.match(io.out, /CarryForward: codex:default reached its current quota\./);
  assert.match(io.out, /CarryForward: continuing with codex:work\./);
  assert.equal(calls.launch[1].command, '/opt/codex-bin/codex:work');
  assert.equal(calls.launch[1].env.CODEX_HOME, '/srv/codex-work');
  assert.equal(calls.launch[1].args.join(' ').includes('Continue the work'), false);
  assert.equal(calls.launch[1].command.includes('wrapper'), false);
  assert.equal(calls.launch[1].command.includes('codex-main'), false);
});

test('an ambiguous session does not fail over or stop the child', async () => {
  const { result, calls, io } = await scriptedRun({ outcomes: [{ type: 'ambiguous' }] });
  assert.equal(result.state, 'ambiguous_session');
  assert.match(io.out, /automatic failover stopped: active session could not be uniquely identified/);
  assert.equal(calls.handoff.length, 0);
  assert.equal(calls.stop, 0);
  assert.equal(calls.waitExit, 1);
  assert.equal(calls.launch.length, 1);
});

test('a shared quota pool is not spare capacity', async () => {
  const { calls } = await scriptedRun({
    target: 'codex:work',
    order: ['codex:work', 'codex:second', 'codex:default'],
    outcomes: [quotaOutcome('sess-b'), { type: 'exit', code: 0, signal: null }],
  });
  assert.equal(calls.handoff[0].destination, 'codex:default');
  assert.deepEqual(calls.launch.map((launch) => launch.target), ['codex:work', 'codex:default']);
});

test('unknown Claude and Grok are not automatic successors', async () => {
  const { calls } = await scriptedRun({
    order: ['claude:default', 'grok:default', 'codex:work', 'codex:second'],
    outcomes: [quotaOutcome(), { type: 'exit', code: 0, signal: null }],
  });
  assert.equal(calls.handoff[0].destination, 'codex:work');
});

test('a codex profile with an unknown quota group is not selected', async () => {
  const { result, calls, io } = await scriptedRun({
    evidence: evidence({ 'codex:default': ACCOUNT_A }),
    outcomes: [quotaOutcome()],
  });
  assert.equal(result.state, 'no_candidate');
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.handoff.length, 0);
  assert.match(io.out, /No verified automatic fallback is available/);
  assert.match(io.out, /carryforward claude:default/);
  assert.match(io.out, /carryforward grok:default/);
  assert.equal(io.out.includes(ACCOUNT_A), false);
});

test('an attempted target is not selected again and the chain does not loop', async () => {
  const { result, calls } = await scriptedRun({
    order: ['codex:default', 'codex:work', 'codex:third'],
    evidence: evidence({
      'codex:default': ACCOUNT_A,
      'codex:work': ACCOUNT_B,
      'codex:third': ACCOUNT_C,
    }),
    outcomes: [quotaOutcome('sess-a'), quotaOutcome('sess-b'), { type: 'exit', code: 0, signal: null }],
  });
  assert.deepEqual(result.launches, ['codex:default', 'codex:work', 'codex:third']);
  assert.deepEqual(result.attempted, ['codex:default', 'codex:work']);
  assert.equal(calls.handoff[1].destination, 'codex:third');
  assert.equal(result.state, 'completed');
});

test('a second quota with no independent pool stops without another launch', async () => {
  const { result, calls, io } = await scriptedRun({
    order: ['codex:default', 'codex:work', 'codex:second'],
    outcomes: [quotaOutcome('sess-a'), quotaOutcome('sess-b')],
  });
  assert.deepEqual(result.launches, ['codex:default', 'codex:work']);
  assert.equal(result.state, 'no_candidate');
  assert.equal(calls.handoff.length, 1);
  assert.match(io.out, /CarryForward: Codex quota reached\./);
  assert.equal(io.out.includes(ACCOUNT_B), false);
});

test('handoff failure leaves the source running', async () => {
  const { result, calls, io } = await scriptedRun({
    handoffFails: true,
    outcomes: [quotaOutcome()],
  });
  assert.equal(result.state, 'handoff_failed');
  assert.equal(calls.stop, 0);
  assert.equal(calls.launch.length, 1);
  assert.match(io.out, /current session was left running/);
  assert.equal(io.out.includes(EMAIL), false);
});

test('a thrown handoff does not leak the extractor error or replace the source', async () => {
  const { result, calls, io } = await scriptedRun({
    handoffThrows: true,
    outcomes: [quotaOutcome()],
  });
  assert.equal(result.state, 'handoff_failed');
  assert.equal(calls.stop, 0);
  assert.equal(io.out.includes(EMAIL), false);
  assert.equal(io.out.includes(TOKEN), false);
});

test('destination launch failure is reported after the source was stopped', async () => {
  const { result, calls, io } = await scriptedRun({
    launchError: true,
    outcomes: [quotaOutcome()],
  });
  assert.equal(result.state, 'launch_failed');
  assert.equal(calls.stop, 1);
  assert.deepEqual(calls.launch.map((launch) => launch.target), ['codex:default', 'codex:work']);
  assert.match(io.out, /codex:work failed to launch/);
  assert.equal(io.out.includes(EMAIL), false);
});

test('a source that cannot be stopped is not replaced', async () => {
  const { result, calls, io } = await scriptedRun({
    stopFails: true,
    outcomes: [quotaOutcome()],
  });
  assert.equal(result.state, 'launch_failed');
  assert.equal(calls.launch.length, 1);
  assert.match(io.out, /no successor was launched/);
});

test('verbose output names the session and pool without secrets', async () => {
  const { io } = await scriptedRun({
    verbose: true,
    order: ['codex:default', 'codex:work', 'codex:second'],
    outcomes: [quotaOutcome('sess-verbose'), { type: 'exit', code: 0, signal: null }],
  });
  assert.match(io.out, /CarryForward: bound session sess-verbose/);
  assert.match(io.out, /CarryForward: pool Codex A/);
  assert.match(io.out, /CarryForward: runtime event usage_limit_exceeded/);
  assert.match(io.out, /CarryForward: handoff bytes 128/);
  assert.equal(io.out.includes(ACCOUNT_A), false);
  assert.equal(io.out.includes(ACCOUNT_B), false);
  assert.equal(io.out.includes(EMAIL), false);
  assert.equal(io.out.includes(TOKEN), false);
});

test('historical and foreign quota events do not bind this child', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward session '));
  const cwd = path.join(dir, 'my project');
  fs.mkdirSync(cwd, { recursive: true });
  const startedAt = Date.now();
  const old = writeRollout(dir, {
    id: 'old-session',
    cwd,
    timestamp: '2020-01-01T00:00:00.000Z',
    events: [quotaEvent('2020-01-01T00:00:01.000Z')],
  });
  const current = writeRollout(dir, {
    id: 'current-session',
    cwd,
    timestamp: new Date(startedAt + 10).toISOString(),
    events: [quotaEvent('2020-01-01T00:00:03.000Z')],
  });
  const foreign = writeRollout(dir, {
    id: 'foreign-session',
    cwd,
    timestamp: new Date(startedAt + 20).toISOString(),
  });
  const child = heldChild();
  try {
    const pending = waitForSupervisedEvent({
      child,
      sessionsDir: dir,
      cwd,
      startedAt,
      pollMs: 15,
      listOpenFiles: async () => [current],
    });
    await delay(40);
    fs.appendFileSync(foreign, `${JSON.stringify(quotaEvent(new Date().toISOString()))}\n`);
    fs.appendFileSync(old, `${JSON.stringify(quotaEvent(new Date().toISOString()))}\n`);
    fs.appendFileSync(current, `${JSON.stringify(quotaEvent('2020-01-01T00:00:02.000Z'))}\n`);
    await delay(40);
    child.finish();
    const outcome = await pending;
    assert.equal(outcome.type, 'exit');
  } finally {
    child.cancel();
  }
});

test('a current quota event on the uniquely open session is the failover signal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward session '));
  const cwd = path.join(dir, 'my project');
  fs.mkdirSync(cwd, { recursive: true });
  const startedAt = Date.now();
  const current = writeRollout(dir, {
    id: 'current-session',
    cwd,
    timestamp: new Date().toISOString(),
  });
  writeRollout(dir, {
    id: 'other-session',
    cwd,
    timestamp: new Date().toISOString(),
    events: [quotaEvent(new Date().toISOString())],
  });
  const child = heldChild();
  try {
    const pending = waitForSupervisedEvent({
      child,
      sessionsDir: dir,
      cwd,
      startedAt,
      pollMs: 15,
      listOpenFiles: async () => [current],
    });
    await delay(30);
    fs.appendFileSync(current, `${JSON.stringify(quotaEvent(new Date().toISOString()))}\n`);
    const outcome = await pending;
    assert.equal(outcome.type, 'quota');
    assert.equal(outcome.session.id, 'current-session');
    assert.equal(outcome.session.path, current);
    assert.equal(JSON.stringify(outcome).includes(CREATOR), false);
    assert.equal(JSON.stringify(outcome).includes(EMAIL), false);
  } finally {
    child.cancel();
  }
});

test('two open primary sessions fail closed when a current quota event arrives', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-ambiguous-'));
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const startedAt = Date.now();
  const first = writeRollout(dir, { id: 'first-session', cwd, timestamp: new Date().toISOString() });
  const second = writeRollout(dir, { id: 'second-session', cwd, timestamp: new Date().toISOString() });
  const child = heldChild();
  try {
    const pending = waitForSupervisedEvent({
      child,
      sessionsDir: dir,
      cwd,
      startedAt,
      pollMs: 15,
      listOpenFiles: async () => [first, second],
    });
    await delay(30);
    fs.appendFileSync(first, `${JSON.stringify(quotaEvent(new Date().toISOString()))}\n`);
    const outcome = await pending;
    assert.equal(outcome.type, 'ambiguous');
  } finally {
    child.cancel();
  }
});

test('an empty file listing does not bind a concurrent session by birth time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-empty-lsof-'));
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const startedAt = Date.now() - 500;
  const foreign = writeRollout(dir, { id: 'foreign-session', cwd, timestamp: new Date().toISOString() });
  const child = heldChild(80);
  try {
    const pending = waitForSupervisedEvent({
      child,
      sessionsDir: dir,
      cwd,
      startedAt,
      pollMs: 15,
      listOpenFiles: async () => [],
    });
    fs.appendFileSync(foreign, `${JSON.stringify(quotaEvent(new Date().toISOString()))}\n`);
    const outcome = await pending;
    assert.equal(outcome.type, 'exit');
  } finally {
    child.cancel();
  }
});

test('without a file listing, two new cli sessions are ambiguous', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-no-lsof-'));
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const startedAt = Date.now() - 500;
  const first = writeRollout(dir, { id: 'first-session', cwd, source: 'cli', timestamp: new Date().toISOString() });
  writeRollout(dir, { id: 'second-session', cwd, source: 'cli', timestamp: new Date().toISOString() });
  const child = heldChild();
  try {
    const pending = waitForSupervisedEvent({
      child,
      sessionsDir: dir,
      cwd,
      startedAt,
      pollMs: 15,
      listOpenFiles: async () => null,
    });
    await delay(30);
    fs.appendFileSync(first, `${JSON.stringify(quotaEvent(new Date().toISOString()))}\n`);
    const outcome = await pending;
    assert.equal(outcome.type, 'ambiguous');
  } finally {
    child.cancel();
  }
});

test('a rate_limit_exceeded record is not quota exhaustion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-retry-'));
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const file = writeRollout(dir, { id: 'retry-session', cwd, timestamp: new Date().toISOString() });
  const child = heldChild(120);
  try {
    const outcome = await (async () => {
      const pending = waitForSupervisedEvent({
        child,
        sessionsDir: dir,
        cwd,
        startedAt: Date.now() - 100,
        pollMs: 15,
        listOpenFiles: async () => [file],
      });
      fs.appendFileSync(file, `${JSON.stringify(quotaEvent(new Date().toISOString(), 'rate_limit_exceeded'))}\n`);
      return pending;
    })();
    assert.equal(outcome.type, 'exit');
  } finally {
    child.cancel();
  }
});

test('stopOwnedChild stops only the process it was given', async () => {
  const sleeper = `setInterval(() => {}, 1000);`;
  const target = launchChild(process.execPath, ['-e', sleeper], { stdio: 'ignore' });
  const other = launchChild(process.execPath, ['-e', sleeper], { stdio: 'ignore' });
  try {
    const stopped = await stopOwnedChild(target);
    assert.equal(stopped.stopped, true);
    assert.equal(alive(target.pid), false);
    assert.equal(alive(other.pid), true);
  } finally {
    try { process.kill(other.pid, 'SIGKILL'); } catch { /* already gone */ }
    await other.finished;
  }
});

test('stopOwnedChild escalates to SIGKILL when the child ignores interrupt', async () => {
  const stubborn = `process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 500);`;
  const target = launchChild(process.execPath, ['-e', stubborn], { stdio: 'ignore' });
  await delay(80);
  assert.equal(alive(target.pid), true);
  const stopped = await stopOwnedChild(target);
  assert.equal(stopped.stopped, true);
  assert.equal(target.result?.signal, 'SIGKILL');
  assert.equal(alive(target.pid), false);
});

test('a successor process receives its own CODEX_HOME when the path has spaces', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward home '));
  const home = path.join(dir, 'codex home');
  const work = path.join(dir, 'work dir');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const marker = path.join(dir, 'seen home.txt');
  const handle = launchChild(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], process.env.CODEX_HOME || "")', marker], {
    cwd: work,
    env: { CODEX_HOME: home },
    stdio: 'ignore',
  });
  const result = await handle.finished;
  assert.equal(result.code, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), home);
});

test('carryforward run simulates a switch without launching', async () => {
  const io = capture();
  let spawned = false;
  const home = '/srv/codex default';
  const code = await runSupervised(['codex:work', '--simulate-rate-limit', '--verbose'], {
    agents: profiles,
    order: ['codex:default', 'codex:work', 'codex:second', 'claude:default', 'grok:default'],
    signals: false,
    stdout: io.stdout,
    stderr: io.stderr,
    boundSession: { id: 'sess-exact', path: '/srv/exact.jsonl' },
    deps: {
      async usage() { return evidence(); },
      async launch() { spawned = true; },
      async stop() { spawned = true; },
      async buildHandoff(request) {
        assert.equal(request.session.id, 'sess-exact');
        assert.equal(request.destination, 'codex:default');
        return { ok: true, plan: { binary: '/opt/codex-bin/codex:default', env: { CODEX_HOME: home }, args: ['context only'] } };
      },
    },
  });
  assert.equal(code, 0);
  assert.equal(spawned, false);
  assert.match(io.out, /simulation only/);
  assert.match(io.out, /shared quota exhausted/);
  assert.match(io.out, /handoff session sess-exact/);
  assert.match(io.out, /CODEX_HOME: \/srv\/codex default/);
  assert.equal(io.out.includes(ACCOUNT_A), false);
  assert.equal(io.out.includes(ACCOUNT_B), false);
  assert.equal(io.out.includes('Continue the work'), false);
});

test('carryforward run rejects non-codex targets and unknown arguments', async () => {
  const io = capture();
  const claude = await runSupervised(['claude:default'], {
    agents: profiles,
    order: [],
    signals: false,
    stdout: io.stdout,
    stderr: io.stderr,
    deps: { async launch() { throw new Error('launched'); } },
  });
  assert.equal(claude, 1);
  assert.match(io.err, /claude:default cannot be supervised/);
  const unknown = capture();
  assert.equal(await runSupervised(['nope:missing'], { agents: profiles, signals: false, stdout: unknown.stdout, stderr: unknown.stderr }), 1);
  assert.match(unknown.err, /Unknown target 'nope:missing'/);
  const extra = capture();
  assert.equal(await runSupervised(['codex:default', '--go'], { agents: profiles, signals: false, stdout: extra.stdout, stderr: extra.stderr }), 1);
  const help = capture();
  assert.equal(await runSupervised(['--help'], { stdout: help.stdout, stderr: help.stderr, signals: false }), 0);
  assert.match(help.out, /carryforward run <codex-target>/);
});

test('the carryforward run command is wired and does not launch from help', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-run-help-'));
  const bin = path.join(root, 'bin', 'carryforward');
  const help = spawnSync(bin, ['run', '--help'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /supervise a Codex session/);
  const missing = spawnSync(bin, ['run'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Usage: carryforward run <codex-target>/);
  const src = ['bind.js', 'command.js', 'machine.js', 'process.js', 'quota.js', 'watch.js']
    .map((name) => fs.readFileSync(path.join(root, 'lib', 'supervisor', name), 'utf8'))
    .join('\n');
  const launcher = fs.readFileSync(bin, 'utf8');
  assert.doesNotMatch(src, /pkill|killall|node-pty/);
  assert.match(src, /stdio: 'inherit'/);
  assert.match(launcher, /preset: 'full'/);
  assert.match(launcher, /buildPrompt\(sourceTarget, matched\.session, info\.context\.markdown, false\)/);
  assert.match(launcher, /process\.argv\[2\] === 'run'/);
});

test('a real child file descriptor binds that rollout and not a concurrent one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward real '));
  const homeA = path.join(dir, 'codex home');
  const homeB = path.join(dir, 'other home');
  const cwd = path.join(dir, 'work dir');
  fs.mkdirSync(homeA, { recursive: true });
  fs.mkdirSync(homeB, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const script = path.join(dir, 'fake codex.js');
  fs.writeFileSync(script, `
    const fs = require('fs');
    const path = require('path');
    const home = process.env.CODEX_HOME;
    const id = process.env.FAKE_ID;
    const mode = process.env.FAKE_MODE;
    if (process.env.FAKE_MARKER) fs.writeFileSync(process.env.FAKE_MARKER, home);
    const folder = path.join(home, 'sessions', '2026', '09', '29');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'rollout-' + id + '.jsonl');
    const now = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify({
      type: 'session_meta',
      timestamp: now,
      payload: {
        id, session_id: id, cwd: process.cwd(), source: 'cli', timestamp: now, thread_source: 'user',
        creator_account_id: ${JSON.stringify(CREATOR)},
        creator_user_id: ${JSON.stringify(EMAIL)}
      }
    }) + '\\n');
    const fd = fs.openSync(file, 'a');
    if (mode === 'quota') {
      setTimeout(() => {
        fs.writeSync(fd, JSON.stringify({
          type: 'event_msg',
          timestamp: new Date().toISOString(),
          payload: { type: 'error', codex_error_info: 'usage_limit_exceeded', message: ${JSON.stringify(`limit ${EMAIL} ${TOKEN}`)} }
        }) + '\\n');
      }, 100);
      setTimeout(() => process.exit(0), 5000);
      setInterval(() => {}, 1000);
    } else {
      fs.closeSync(fd);
      process.exit(0);
    }
  `);
  const decoy = writeRollout(path.join(homeA, 'sessions'), {
    id: 'decoy-session',
    cwd,
    timestamp: '2020-01-01T00:00:00.000Z',
    events: [quotaEvent('2020-01-01T00:00:01.000Z')],
  });
  const local = [
    codex('codex:default', homeA),
    codex('codex:work', homeB),
    manual('claude', 'claude:default'),
    manual('grok', 'grok:default'),
  ];
  local[0].launch.command = process.execPath;
  local[1].launch.command = process.execPath;
  const calls = [];
  const io = { out: '' };
  const result = await supervise({
    target: 'codex:default',
    order: ['codex:default', 'codex:work'],
    profiles: local,
    manualDestinations: ['claude:default', 'grok:default'],
    cwd,
    verbose: true,
    log(line) { io.out += `${line}\n`; },
    deps: {
      now: () => Date.now(),
      launch(profile, plan, ctx) {
        const home = plan?.env?.CODEX_HOME || profile.launch.env.CODEX_HOME;
        calls.push(home);
        return launchChild(process.execPath, [script], {
          cwd: ctx.cwd,
          stdio: 'ignore',
          env: {
            ...process.env,
            CODEX_HOME: home,
            FAKE_ID: profile.target === 'codex:default' ? 'child-session' : 'next-session',
            FAKE_MODE: plan ? 'exit' : 'quota',
            FAKE_MARKER: path.join(dir, `${profile.target}.home`),
          },
        });
      },
      wait(handle, ctx) {
        return waitForSupervisedEvent({
          child: handle,
          sessionsDir: path.join(ctx.profile.configPath, 'sessions'),
          cwd: ctx.cwd,
          startedAt: ctx.startedAt,
          userStop: ctx.userStop,
          pollMs: 25,
        });
      },
      stop: stopOwnedChild,
      waitExit: (handle) => handle.finished,
      async usage() {
        return {
          identities: { 'codex:default': ACCOUNT_A, 'codex:work': ACCOUNT_B },
          usage: [open('codex:default'), open('codex:work')],
        };
      },
      async buildHandoff(request) {
        assert.equal(request.session.id, 'child-session');
        assert.equal(request.session.id === 'decoy-session', false);
        fs.appendFileSync(decoy, `${JSON.stringify(quotaEvent(new Date().toISOString()))}\n`);
        return {
          ok: true,
          bytes: 64,
          plan: { binary: process.execPath, args: [script], env: { CODEX_HOME: homeB } },
        };
      },
    },
  });
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.launches, ['codex:default', 'codex:work']);
  assert.equal(fs.readFileSync(path.join(dir, 'codex:default.home'), 'utf8'), homeA);
  assert.equal(fs.readFileSync(path.join(dir, 'codex:work.home'), 'utf8'), homeB);
  assert.match(io.out, /bound session child-session/);
  assert.equal(io.out.includes(CREATOR), false);
  assert.equal(io.out.includes(EMAIL), false);
  assert.equal(io.out.includes(TOKEN), false);
  assert.equal(io.out.includes(ACCOUNT_A), false);
  assert.equal(io.out.includes(ACCOUNT_B), false);
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
