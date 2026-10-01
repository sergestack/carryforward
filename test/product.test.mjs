import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDoctor } from '../lib/doctor/command.js';
import { runUninstall } from '../lib/install/uninstall.js';
import { readFallback, writeFallback } from '../lib/policy/config.js';
import { nodeSatisfies } from '../lib/runtime.js';
import { runSetup } from '../lib/setup/command.js';
import { runStatus } from '../lib/status/command.js';
import { runSupervised } from '../lib/supervisor/command.js';

const root = path.resolve(import.meta.dirname, '..');
const installScript = path.join(root, 'install.sh');
const ACCOUNT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function capture() {
  const io = { out: '', err: '' };
  io.stdout = { write(chunk) { io.out += chunk; } };
  io.stderr = { write(chunk) { io.err += chunk; } };
  return io;
}

function profile(agent, target, extra = {}) {
  const destination = extra.destination ?? (agent === 'codex' || agent === 'claude' || agent === 'grok');
  return {
    agent,
    displayName: extra.displayName || agent[0].toUpperCase() + agent.slice(1),
    profile: target.split(':')[1],
    target,
    status: extra.status || 'detected',
    installed: true,
    configPath: extra.configPath || `/srv/${target}`,
    sessionPath: extra.sessionPath || null,
    handoff: { source: agent === 'codex' || agent === 'claude', destination },
    launch: { command: `/opt/${agent}`, env: {} },
  };
}

function twoPools(extra = {}) {
  return [
    profile('codex', 'codex:default', extra),
    profile('codex', 'codex:east', extra),
    profile('codex', 'codex:second', extra),
    profile('claude', 'claude:default'),
    profile('grok', 'grok:default'),
  ];
}

const IDENTITIES = {
  'codex:default': ACCOUNT_A,
  'codex:east': ACCOUNT_B,
  'codex:second': ACCOUNT_B,
};

test('node version boundaries', () => {
  assert.equal(nodeSatisfies('22.5.0'), true);
  assert.equal(nodeSatisfies('v22.5.1'), true);
  assert.equal(nodeSatisfies('24.1.0'), true);
  assert.equal(nodeSatisfies('22.4.9'), false);
  assert.equal(nodeSatisfies('20.0.0'), false);
});

test('carryforward run without a chain does not create one', async () => {
  const io = capture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-run-'));
  let launched = false;
  const code = await runSupervised(['codex:default'], {
    agents: twoPools(),
    signals: false,
    stdout: io.stdout,
    stderr: io.stderr,
    configHome: home,
    deps: { async launch() { launched = true; } },
  });
  assert.equal(code, 1);
  assert.equal(launched, false);
  assert.match(io.err, /Automatic fallback is not configured/);
  assert.match(io.err, /carryforward setup/);
  assert.match(io.err, /carryforward fallback set \.\.\./);
  assert.equal(fs.existsSync(path.join(home, 'fallback.json')), false);
});

test('status reports pools, manual agents, and readiness', async () => {
  const io = capture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-status-'));
  writeFallback({ version: 1, fallback: ['codex:default', 'codex:east'] }, { configHome: home });
  const code = await runStatus([], {
    agents: twoPools(),
    identities: IDENTITIES,
    usage: [{
      target: 'codex:default',
      state: 'available',
      freshness: 'live',
      windows: [{ name: '5-hour', remainingPercent: 40, usedPercent: 60 }],
    }],
    stdout: io.stdout,
    stderr: io.stderr,
    configHome: home,
  });
  assert.equal(code, 0);
  assert.match(io.out, /codex:default\s+ready\s+5-hour 40% left/);
  assert.match(io.out, /codex:second\s+same allowance/);
  assert.match(io.out, /Quota pools:\n  1  codex:default\n  2  codex:east, codex:second/);
  assert.match(io.out, /claude:default/);
  assert.match(io.out, /Auto-failover: ready/);
  assert.equal(io.out.includes(ACCOUNT_A), false);
  const json = capture();
  assert.equal(await runStatus(['--json'], {
    agents: twoPools(),
    identities: IDENTITIES,
    usage: [],
    stdout: json.stdout,
    stderr: json.stderr,
    configHome: home,
  }), 0);
  const body = JSON.parse(json.out);
  assert.equal(body.version, 1);
  assert.equal(body.autoFailoverReady, true);
  assert.equal(JSON.stringify(body).includes(ACCOUNT_B), false);
  assert.equal(JSON.stringify(body).includes('accountId'), false);
});

test('status rejects a chain that uses one quota pool twice', async () => {
  const io = capture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-status-'));
  writeFallback({ version: 1, fallback: ['codex:east', 'codex:second'] }, { configHome: home });
  const code = await runStatus([], {
    agents: twoPools(),
    identities: IDENTITIES,
    usage: [],
    stdout: io.stdout,
    stderr: io.stderr,
    configHome: home,
  });
  assert.equal(code, 0);
  assert.match(io.out, /not ready/);
  assert.match(io.out, /one quota pool/);
});

test('malformed and unsupported config are left unchanged', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-config-'));
  const file = path.join(home, 'fallback.json');
  fs.writeFileSync(file, '{', { mode: 0o600 });
  assert.throws(() => readFallback({ configHome: home }), /Fallback config is unreadable\. CarryForward left the file unchanged/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
  const status = capture();
  assert.equal(await runStatus([], {
    agents: twoPools(),
    identities: {},
    stdout: status.stdout,
    stderr: status.stderr,
    configHome: home,
  }), 1);
  assert.match(status.err, /unreadable/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{');

  const legacy = '{"version":2,"fallback":["codex:default"]}\n';
  fs.writeFileSync(file, legacy, { mode: 0o600 });
  assert.throws(() => readFallback({ configHome: home }), /version 2 is not supported/);
  assert.equal(fs.readFileSync(file, 'utf8'), legacy);
  const doctor = capture();
  assert.equal(await runDoctor([], {
    agents: twoPools(),
    identities: IDENTITIES,
    usage: [{ target: 'codex:default', freshness: 'live', state: 'available', windows: [] }],
    nodeVersion: '22.5.0',
    commandExists: () => true,
    stdout: doctor.stdout,
    stderr: doctor.stderr,
    configHome: home,
    packageInfo: { version: '0.1.0', root: '/opt/carryforward' },
  }), 1);
  assert.match(doctor.err.length ? doctor.err : doctor.out, /not supported|invalid/);
  assert.equal(fs.readFileSync(file, 'utf8'), legacy);
});

test('doctor warns without lsof and fails on an old Node', async () => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-sessions-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-doctor-'));
  writeFallback({ version: 1, fallback: ['codex:default', 'codex:east'] }, { configHome: home });
  const agents = twoPools({ sessionPath: sessions });
  const io = capture();
  const code = await runDoctor([], {
    agents,
    identities: IDENTITIES,
    usage: [{ target: 'codex:default', freshness: 'live', state: 'available', windows: [] }],
    nodeVersion: '22.21.0',
    commandExists: () => false,
    env: { PATH: '/nowhere', SECRET_TOKEN: 'super-secret-value' },
    stdout: io.stdout,
    stderr: io.stderr,
    configHome: home,
    packageInfo: { version: '0.1.0', root: '/opt/carryforward' },
  });
  assert.equal(code, 0);
  assert.match(io.out, /lsof was not found/);
  assert.match(io.out, /Auto-failover\s+ready/);
  assert.equal(io.out.includes('super-secret-value'), false);
  assert.equal(io.out.includes(ACCOUNT_A), false);

  const old = capture();
  const failed = await runDoctor([], {
    agents,
    identities: IDENTITIES,
    usage: [{ target: 'codex:default', freshness: 'live', state: 'available', windows: [] }],
    nodeVersion: '18.20.0',
    commandExists: () => true,
    stdout: old.stdout,
    stderr: old.stderr,
    configHome: home,
    packageInfo: { version: '0.1.0', root: '/opt/carryforward' },
  });
  assert.equal(failed, 1);
  assert.match(old.out, /older than 22\.5\.0/);
});

test('one Codex pool and a clean machine both exit zero', async () => {
  const one = capture();
  assert.equal(await runSetup(['--yes'], {
    agents: [profile('codex', 'codex:default')],
    identities: { 'codex:default': ACCOUNT_A },
    stdout: one.stdout,
    stderr: one.stderr,
    stdin: { isTTY: false },
    configHome: fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-one-')),
  }), 0);
  assert.match(one.out, /another independent Codex account/);

  const empty = capture();
  assert.equal(await runSetup(['--yes'], {
    agents: [],
    identities: {},
    stdout: empty.stdout,
    stderr: empty.stderr,
    stdin: { isTTY: false },
    configHome: fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-empty-')),
  }), 0);
  assert.match(empty.out, /nothing it can launch/);
});

function runInstall(home, env = {}) {
  return spawnSync('bash', [installScript], {
    encoding: 'utf8',
    env: { ...process.env, ...env, HOME: home },
  });
}

function isolatedInstallEnv(t, home, node = 'current') {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-test-bin-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  // Only installer prerequisites; never expose a host tool directory on PATH.
  for (const name of ['bash', 'dirname', 'uname', 'mkdir', 'ln']) {
    const executable = ['/usr/bin', '/bin'].map(dir => path.join(dir, name))
      .find(file => {
        try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
      });
    assert.ok(executable, `Missing installer prerequisite: ${name}`);
    fs.symlinkSync(executable, path.join(bin, name));
  }
  if (node === 'current') fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  else if (node === 'old') fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho v18.20.0\n', { mode: 0o755 });
  else assert.equal(node, 'absent');
  return { HOME: home, PATH: bin, TERM: 'dumb' };
}

function relativeTree(home) {
  const found = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      found.push(path.relative(home, file));
      const stat = fs.lstatSync(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(file);
    }
  }
  walk(home);
  return found.sort();
}

test('a fresh install creates only the carryforward command link', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-install-'));
  const res = runInstall(home, { PATH: `${path.join(home, '.local', 'bin')}:${process.env.PATH}` });
  assert.equal(res.status, 0, res.stderr);
  const link = path.join(home, '.local', 'bin', 'carryforward');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(root, 'bin', 'carryforward')));
  assert.match(res.stdout, /Installed .+ -> .+bin\/carryforward/);
  assert.match(res.stdout, /Next: carryforward setup/);
  assert.deepEqual(relativeTree(home), [
    '.local',
    path.join('.local', 'bin'),
    path.join('.local', 'bin', 'carryforward'),
  ]);
});

test('install preserves config and replaces a carryforward symlink', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-upgrade-'));
  const configDir = path.join(home, '.config', 'carryforward');
  fs.mkdirSync(configDir, { recursive: true });
  const config = path.join(configDir, 'fallback.json');
  fs.writeFileSync(config, '{"version":1,"fallback":["codex:default"]}\n');
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync('/opt/previous-carryforward', path.join(binDir, 'carryforward'));
  const notes = path.join(home, '.local', 'share', 'notes');
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'keep.txt'), 'leave\n');
  const res = runInstall(home, { PATH: `${binDir}:${process.env.PATH}` });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(config, 'utf8'), '{"version":1,"fallback":["codex:default"]}\n');
  assert.equal(fs.realpathSync(path.join(binDir, 'carryforward')), fs.realpathSync(path.join(root, 'bin', 'carryforward')));
  assert.equal(fs.readFileSync(path.join(notes, 'keep.txt'), 'utf8'), 'leave\n');
  assert.equal(fs.existsSync(path.join(home, '.local', 'share', 'carryforward')), false);
});

test('install refuses a regular file and an old Node', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-refuse-'));
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const regular = path.join(binDir, 'carryforward');
  fs.writeFileSync(regular, 'keep\n');
  const refused = spawnSync('bash', [installScript], {
    encoding: 'utf8', env: isolatedInstallEnv(t, home),
  });
  assert.ifError(refused.error);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not a symlink/);
  assert.equal(fs.readFileSync(regular, 'utf8'), 'keep\n');

  const old = spawnSync('bash', [installScript], {
    encoding: 'utf8',
    env: isolatedInstallEnv(t, fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-oldnode-')), 'old'),
  });
  assert.ifError(old.error);
  assert.equal(old.status, 1);
  assert.match(old.stderr, /Found 18\.20\.0/);

  const missing = spawnSync('bash', [installScript], {
    encoding: 'utf8',
    env: isolatedInstallEnv(t, fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-nonode-')), 'absent'),
  });
  assert.ifError(missing.error);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Node was not found/);
});

test('install and uninstall accept a home path that contains spaces', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward home '));
  const res = runInstall(home, { PATH: `${path.join(home, '.local', 'bin')}:${process.env.PATH}` });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.lstatSync(path.join(home, '.local', 'bin', 'carryforward')).isSymbolicLink(), true);
  const io = capture();
  const code = spawnSync(process.execPath, [path.join(root, 'bin', 'carryforward'), 'uninstall', '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  assert.equal(code.status, 0, code.stderr);
  assert.match(code.stdout, /Would remove:/);
  assert.equal(fs.existsSync(path.join(home, '.local', 'bin', 'carryforward')), true);
  assert.equal(io.out, '');
});

test('uninstall dry-run removes nothing and a real uninstall keeps agent data', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-uninstall-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-root-'));
  const bin = path.join(rootDir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'carryforward'), '#!/bin/sh\n');
  const link = path.join(home, '.local', 'bin', 'carryforward');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(bin, 'carryforward'), link);
  const vendorShare = path.join(home, '.local', 'share', 'carryforward');
  fs.mkdirSync(vendorShare, { recursive: true });
  fs.writeFileSync(path.join(vendorShare, 'keep.txt'), 'vendor\n');
  const notes = path.join(home, '.local', 'share', 'notes');
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'keep.txt'), 'notes\n');
  const cache = path.join(home, '.cache', 'carryforward');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'handoff.md'), 'temp\n');
  const config = path.join(home, '.config', 'carryforward', 'fallback.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, '{"version":1,"fallback":[]}\n');
  const codex = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(path.join(codex, 'keep.jsonl'), 'session\n');

  const preview = capture();
  assert.equal(await runUninstall(['--dry-run'], {
    home,
    root: rootDir,
    env: {},
    stdout: preview.stdout,
    stderr: preview.stderr,
  }), 0);
  assert.match(preview.out, /Would remove:/);
  assert.match(preview.out, new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(preview.out, /Would keep:/);
  assert.match(preview.out, new RegExp(vendorShare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(preview.out.includes(notes), false);
  assert.equal(preview.out.includes('.codex'), false);
  assert.equal(fs.readFileSync(path.join(codex, 'keep.jsonl'), 'utf8'), 'session\n');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);

  const held = capture();
  assert.equal(await runUninstall([], {
    home,
    root: rootDir,
    env: {},
    stdout: held.stdout,
    stderr: held.stderr,
  }), 0);
  assert.match(held.out, /Re-run with carryforward uninstall --yes/);
  assert.equal(fs.existsSync(link), true);

  const removed = capture();
  assert.equal(await runUninstall(['--yes'], {
    home,
    root: rootDir,
    env: {},
    stdout: removed.stdout,
    stderr: removed.stderr,
  }), 0);
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.existsSync(cache), false);
  assert.equal(fs.readFileSync(config, 'utf8'), '{"version":1,"fallback":[]}\n');
  assert.equal(fs.readFileSync(path.join(vendorShare, 'keep.txt'), 'utf8'), 'vendor\n');
  assert.equal(fs.readFileSync(path.join(notes, 'keep.txt'), 'utf8'), 'notes\n');
  assert.equal(fs.readFileSync(path.join(codex, 'keep.jsonl'), 'utf8'), 'session\n');

  assert.equal(await runUninstall(['--delete-config', '--yes'], {
    home,
    root: rootDir,
    env: {},
    stdout: capture().stdout,
    stderr: capture().stderr,
  }), 0);
  assert.equal(fs.existsSync(config), false);
  assert.equal(fs.readFileSync(path.join(codex, 'keep.jsonl'), 'utf8'), 'session\n');
});

test('public files do not carry a personal identity', () => {
  const forbidden = /\/Users\/|\/home\//;
  const login = /sergestack/i;
  const copyrightLine = 'Copyright (c) 2026 sergestack';
  const copyrightFiles = new Set([
    path.join(root, 'LICENSE'),
    path.join(root, 'README.md'),
    path.join(root, 'NOTICE.md'),
  ]);
  const files = [
    path.join(root, 'LICENSE'),
    path.join(root, 'README.md'),
    path.join(root, 'install.sh'),
    path.join(root, 'package.json'),
    path.join(root, 'NOTICE.md'),
    path.join(root, 'bin', 'carryforward'),
  ];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else if (name.endsWith('.js')) files.push(file);
    }
  }
  walk(path.join(root, 'lib'));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, forbidden, file);
    const stripped = copyrightFiles.has(file)
      ? text.replaceAll(copyrightLine, '').replaceAll('https://github.com/sergestack/carryforward', '')
      : text;
    assert.doesNotMatch(stripped, login, file);
  }
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /MIT License/);
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 sergestack/);
  const notice = fs.readFileSync(path.join(root, 'NOTICE.md'), 'utf8');
  assert.match(notice, /Yigit Konur/);
  assert.match(notice, /MIT/);
  assert.match(notice, /CarryForward is MIT licensed/);
  const license = fs.readFileSync(path.join(root, 'third_party', 'cli-continues', 'LICENSE'), 'utf8');
  assert.match(license, /Copyright \(c\) 2025-2026 Yigit Konur/);
});

test('the repository source does not name a previous product', () => {
  const banned = [
    ['agent', 'next'].join('-'),
    ['Agent', 'Next'].join(' '),
    ['rel', 'ief'].join(''),
    ['Rel', 'ief'].join(''),
    ['REL', 'IEF'].join(''),
  ];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue;
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(file);
        continue;
      }
      const text = fs.readFileSync(file);
      for (const needle of banned) assert.equal(text.includes(needle), false, file);
    }
  }
  walk(root);
});

test('an empty home can run help, setup, status, doctor, and agents', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-fresh-'));
  const env = isolatedInstallEnv(t, home);
  const installed = spawnSync('bash', [installScript], { encoding: 'utf8', env });
  assert.ifError(installed.error);
  assert.equal(installed.status, 0, installed.stderr);
  const bin = path.join(home, '.local', 'bin', 'carryforward');
  const help = spawnSync(bin, ['--help'], { encoding: 'utf8', env });
  assert.ifError(help.error);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /carryforward setup/);
  const setup = spawnSync(bin, ['setup'], { encoding: 'utf8', env });
  assert.ifError(setup.error);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /nothing it can launch/);
  assert.equal(fs.existsSync(path.join(home, '.config', 'carryforward', 'fallback.json')), false);
  const status = spawnSync(bin, ['status'], { encoding: 'utf8', env });
  assert.ifError(status.error);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /No supported agents were found/);
  const doctor = spawnSync(bin, ['doctor'], { encoding: 'utf8', env });
  assert.ifError(doctor.error);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /CarryForward doctor/);
  assert.match(doctor.stdout, /cli-continues 4\.1\.1/);
  assert.match(doctor.stdout, /none found/);
  const agents = spawnSync(bin, ['agents'], { encoding: 'utf8', env });
  assert.ifError(agents.error);
  assert.equal(agents.status, 0, agents.stderr);
  assert.match(agents.stdout, /not installed/);
  // Prove agent discovery still works when we explicitly install a fixture.
  fs.writeFileSync(path.join(env.PATH, 'gemini'), '#!/bin/sh\necho gemini-fixture-1.0\n', { mode: 0o755 });
  const withGemini = spawnSync(bin, ['status'], { encoding: 'utf8', env });
  assert.ifError(withGemini.error);
  assert.equal(withGemini.status, 0, withGemini.stderr);
  assert.match(withGemini.stdout, /gemini:default\s+manual only/);
  assert.doesNotMatch(withGemini.stdout, /No supported agents were found/);
  const created = relativeTree(home);
  assert.ok(created.every((file) => file === '.local' || file.startsWith(`.local${path.sep}`)));
  assert.equal(created.includes(path.join('.local', 'bin', 'carryforward')), true);
});

test('main help leads with setup and status', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-help-'));
  const res = spawnSync(path.join(root, 'bin', 'carryforward'), ['--help'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Getting started/);
  assert.match(res.stdout, /carryforward setup/);
  assert.match(res.stdout, /carryforward status/);
  assert.match(res.stdout, /carryforward run <target>/);
  assert.doesNotMatch(res.stdout, /--allow-large|--simulate-rate-limit/);
  const status = spawnSync(path.join(root, 'bin', 'carryforward'), ['status', '--help'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /carryforward status --json/);
});
