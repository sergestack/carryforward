import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runSetup } from '../lib/setup/command.js';
import { buildSetupPlan, chooseRepresentative } from '../lib/setup/plan.js';

const ACCOUNT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ACCOUNT_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const NAMES = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  copilot: 'Copilot',
};

function profile(agent, target, status = 'detected') {
  return {
    agent,
    displayName: NAMES[agent] || agent,
    profile: target.split(':')[1],
    target,
    status,
    installed: status === 'detected',
    configPath: status === 'not installed' ? null : `/srv/${target}`,
    handoff: { source: agent !== 'grok', destination: status === 'detected' && agent !== 'opencode' && agent !== 'copilot' },
    launch: status === 'detected' ? { command: `/opt/${agent}`, env: {} } : null,
  };
}

function agents() {
  return [
    profile('codex', 'codex:default'),
    profile('codex', 'codex:east'),
    profile('codex', 'codex:second'),
    profile('claude', 'claude:default'),
    profile('grok', 'grok:default'),
    profile('gemini', 'gemini:default', 'config only'),
  ];
}

const TWO_POOLS = {
  'codex:default': ACCOUNT_A,
  'codex:east': ACCOUNT_B,
  'codex:second': ACCOUNT_B,
};

function capture() {
  const io = { out: '', err: '' };
  io.stdout = { write(chunk) { io.out += chunk; } };
  io.stderr = { write(chunk) { io.err += chunk; } };
  return io;
}

function run(argv, extra = {}) {
  const io = capture();
  const home = extra.home || fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-setup-'));
  const done = runSetup(argv, {
    agents: extra.agents || agents(),
    identities: extra.identities,
    answer: extra.answer,
    answers: extra.answers,
    yes: extra.yes,
    stdin: extra.stdin || { isTTY: false },
    stdout: io.stdout,
    stderr: io.stderr,
    configHome: home,
  });
  return done.then((code) => ({ code, io, home, file: path.join(home, 'fallback.json') }));
}

test('setup suggests one profile per independent Codex quota pool', async () => {
  const { code, io, file } = await run(['--yes'], { identities: TWO_POOLS });
  assert.equal(code, 0);
  assert.equal(io.out, `CarryForward setup

Found:

  Codex
    codex:default    ready
    codex:east       ready
    codex:second     same allowance

  Claude
    claude:default   manual only

  Grok
    grok:default     manual only

codex:east
codex:second

share the same Codex allowance and therefore are not independent automatic fallbacks.

Automatic failover:

  codex:default
       ↓
  codex:east

Claude and Grok can still be selected manually because their remaining
quota cannot currently be verified safely.

Save this configuration? [Y/n]

Saved.

Start with:
  carryforward run codex:default
`);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.fallback, ['codex:default', 'codex:east']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(io.out.includes(ACCOUNT_A), false);
  assert.equal(io.out.includes(ACCOUNT_B), false);
  assert.equal(JSON.stringify(saved).includes(ACCOUNT_A), false);
  assert.equal(io.out.includes('Gemini'), false);
});

test('the pool representative is default, otherwise the lexical profile name', () => {
  const shared = [
    profile('codex', 'codex:zed'),
    profile('codex', 'codex:amy'),
  ];
  assert.equal(chooseRepresentative(shared), 'codex:amy');
  const withDefault = [
    profile('codex', 'codex:zed'),
    profile('codex', 'codex:default'),
  ];
  assert.equal(chooseRepresentative(withDefault), 'codex:default');
  const plan = buildSetupPlan([
    profile('codex', 'codex:early'),
    profile('codex', 'codex:late'),
  ], {
    'codex:early': 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
    'codex:late': '00000000-0000-0000-0000-000000000000',
  });
  assert.deepEqual(plan.order, ['codex:early', 'codex:late']);
  assert.equal(JSON.stringify(plan).includes('zzzzzzzz'), false);
  assert.equal(JSON.stringify(plan).includes('00000000'), false);
});

test('a shared pool is not offered as two backups', async () => {
  const { code, io, file } = await run(['--yes'], {
    agents: [
      profile('codex', 'codex:east'),
      profile('codex', 'codex:second'),
      profile('claude', 'claude:default'),
      profile('grok', 'grok:default'),
    ],
    identities: { 'codex:east': ACCOUNT_B, 'codex:second': ACCOUNT_B },
  });
  assert.equal(code, 0);
  assert.match(io.out, /share the same Codex allowance and therefore are not independent automatic fallbacks/);
  assert.match(io.out, /Automatic Codex failover requires another independent Codex account/);
  assert.match(io.out, /Manual handoffs found:\n  claude:default\n  grok:default/);
  assert.equal(io.out.includes('Save this configuration'), false);
  assert.doesNotMatch(io.out, /\berror\b/i);
  assert.equal(fs.existsSync(file), false);
});

test('setup succeeds when Codex is absent', async () => {
  const { code, io, file } = await run(['--yes'], {
    agents: [profile('claude', 'claude:default'), profile('grok', 'grok:default')],
    identities: {},
  });
  assert.equal(code, 0);
  assert.match(io.out, /manual handoffs for supported agents/);
  assert.match(io.out, /supported live availability data/);
  assert.doesNotMatch(io.out, /\berror\b/i);
  assert.equal(fs.existsSync(file), false);
});

test('an unverified Codex profile is not treated as another account', async () => {
  const { io, file } = await run(['--yes'], {
    identities: { 'codex:default': ACCOUNT_A },
  });
  assert.match(io.out, /could not be verified, so no automatic order was saved/);
  assert.equal(io.out.includes(ACCOUNT_A), false);
  assert.equal(fs.existsSync(file), false);
});

test('verified accounts are saved when another profile has no identity', async () => {
  const { io, file } = await run(['--yes'], {
    agents: [
      profile('codex', 'codex:default'),
      profile('codex', 'codex:work'),
      profile('codex', 'codex:extra'),
    ],
    identities: { 'codex:default': ACCOUNT_A, 'codex:work': ACCOUNT_C },
  });
  assert.match(io.out, /codex:extra\s+quota unknown/);
  assert.match(io.out, /left out of the automatic chain/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).fallback, ['codex:default', 'codex:work']);
});

test('declining can switch the profile that represents a shared pool', async () => {
  const { code, io, file } = await run([], {
    identities: TWO_POOLS,
    answers: ['n', 'codex:second', 'y'],
  });
  assert.equal(code, 0);
  assert.match(io.out, /Quota pool profiles: codex:east, codex:second \[codex:east\]/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).fallback, ['codex:default', 'codex:second']);
});

test('an unknown pool profile does not save', async () => {
  const { code, io, file } = await run([], {
    identities: TWO_POOLS,
    answers: ['n', 'codex:nope'],
  });
  assert.equal(code, 0);
  assert.match(io.out, /Unknown profile/);
  assert.equal(fs.existsSync(file), false);
});

test('declining independent profiles leaves an existing file untouched', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-setup-'));
  const body = '{"version":1,"fallback":["codex:keep"]}\n';
  fs.writeFileSync(path.join(home, 'fallback.json'), body, { mode: 0o600 });
  const io = capture();
  const code = await runSetup([], {
    agents: agents(),
    identities: TWO_POOLS,
    answer: 'n',
    stdin: { isTTY: false },
    stdout: io.stdout,
    stderr: io.stderr,
    configHome: home,
  });
  assert.equal(code, 0);
  assert.match(io.out, /No configuration saved/);
  assert.equal(io.out.includes('Saved.'), false);
  assert.equal(fs.readFileSync(path.join(home, 'fallback.json'), 'utf8'), body);
});

test('declining a chain with no alternate profile explains fallback set', async () => {
  const { io, file } = await run([], {
    agents: [profile('codex', 'codex:default'), profile('codex', 'codex:work')],
    identities: { 'codex:default': ACCOUNT_A, 'codex:work': ACCOUNT_C },
    answer: 'n',
  });
  assert.match(io.out, /carryforward fallback set <target> \.\.\./);
  assert.equal(io.out.includes('Quota pool profiles'), false);
  assert.equal(fs.existsSync(file), false);
});

test('enter accepts the suggested order', async () => {
  const { file } = await run([], { answer: '', identities: TWO_POOLS });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).fallback, ['codex:default', 'codex:east']);
});

test('a non-interactive setup does not save without --yes', async () => {
  const { code, io, file } = await run([], {
    identities: TWO_POOLS,
    stdin: { isTTY: false },
  });
  assert.equal(code, 0);
  assert.match(io.out, /pass --yes/);
  assert.equal(fs.existsSync(file), false);
});

test('setup help and unknown arguments', async () => {
  const io = capture();
  assert.equal(await runSetup(['--help'], { stdout: io.stdout, stderr: io.stderr, identities: {} }), 0);
  assert.match(io.out, /profile named default/);
  assert.match(io.out, /carryforward setup --yes/);
  const bad = capture();
  assert.equal(await runSetup(['--go'], { stdout: bad.stdout, stderr: bad.stderr }), 1);
  assert.match(bad.err, /Unknown argument: --go/);
});

test('nothing launchable prints no invented Codex order', async () => {
  const { code, io, file } = await run(['--yes'], {
    agents: [profile('claude', 'claude:default', 'not installed')],
    identities: {},
  });
  assert.equal(code, 0);
  assert.match(io.out, /nothing it can launch/);
  assert.equal(io.out.includes('Automatic failover:'), false);
  assert.equal(fs.existsSync(file), false);
});

test('setup writes under a config path that contains spaces', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward setup '));
  const { code, file } = await run(['--yes'], { home, identities: TWO_POOLS });
  assert.equal(code, 0);
  assert.equal(file.includes(' '), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).fallback, ['codex:default', 'codex:east']);
});
