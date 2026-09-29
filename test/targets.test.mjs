import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexExecutable } from '../lib/agents/codex.js';
import { formatJson, formatTargetsJson } from '../lib/agents/format.js';
import { fileAssignsEnv, wrapperExecTarget } from '../lib/agents/probe.js';
import { discoverAgents } from '../lib/agents/registry.js';
import {
  canonicalTargetId,
  destinationProfiles,
  resolveDestination,
  resolveSource,
  sourceProfiles,
} from '../lib/agents/targets.js';
import { runTargets } from '../lib/agents/targets-command.js';

function probe({ home, env = {}, executables = {}, versions = {}, directories = [], files = [] }) {
  const dirs = new Set(directories);
  const fileSet = new Set(files);
  const addParents = (start) => {
    let dir = path.dirname(start);
    while (dir && !dirs.has(dir)) {
      dirs.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  };
  for (const file of files) addParents(file);
  for (const dir of directories) addParents(dir);
  dirs.add(home);
  return {
    home,
    env,
    which(command) {
      return executables[command] || null;
    },
    version(executable) {
      return versions[executable] ?? null;
    },
    exists(filePath) {
      return dirs.has(filePath) || fileSet.has(filePath);
    },
    isDirectory(filePath) {
      return dirs.has(filePath) && !fileSet.has(filePath);
    },
    listDir(dir) {
      if (!dirs.has(dir) || fileSet.has(dir)) return [];
      const names = new Set();
      for (const item of [...dirs, ...fileSet]) {
        if (path.dirname(item) === dir) names.add(path.basename(item));
      }
      return [...names];
    },
  };
}

function installedHome(home = '/home/other') {
  const exe = {
    codex: '/bin/codex',
    claude: '/bin/claude',
    grok: '/bin/grok',
  };
  return probe({
    home,
    executables: exe,
    versions: {
      [exe.codex]: 'codex-cli 1',
      [exe.claude]: '1.0.0',
      [exe.grok]: 'grok 1',
    },
    files: [
      path.join(home, '.codex', 'config.toml'),
      path.join(home, '.codex-second', 'config.toml'),
      path.join(home, '.codex-work', 'config.toml'),
      path.join(home, '.claude', 'settings.json'),
      path.join(home, '.grok', 'config.toml'),
      path.join(home, '.gemini', 'settings.json'),
    ],
    directories: [
      path.join(home, '.codex', 'sessions'),
      path.join(home, '.codex-second', 'sessions'),
      path.join(home, '.codex-work', 'sessions'),
      path.join(home, '.grok', 'sessions'),
    ],
  });
}

test('dynamic codex profile is a source and a destination', () => {
  const home = '/home/other';
  const agents = discoverAgents(installedHome(home));
  const work = agents.find((agent) => agent.target === 'codex:work');
  assert.equal(work.handoff.source, true);
  assert.equal(work.handoff.destination, true);
  assert.equal(work.launch.env.CODEX_HOME, path.join(home, '.codex-work'));
  assert.equal(resolveDestination(agents, 'codex:work').ok, true);
  assert.equal(resolveSource(agents, 'codex:work').ok, true);
});

test('canonical codex profiles and an arbitrary name', () => {
  const agents = discoverAgents(installedHome());
  assert.deepEqual(
    agents.filter((agent) => agent.agent === 'codex').map((agent) => agent.target),
    ['codex:default', 'codex:second', 'codex:work'],
  );
  for (const id of ['codex:default', 'codex:second', 'codex:team']) {
    if (id === 'codex:team') {
      assert.equal(resolveDestination(agents, id).code, 'unknown');
    } else {
      assert.equal(resolveDestination(agents, id).ok, true);
    }
  }
});

test('legacy aliases resolve and are not themselves target ids', () => {
  const agents = discoverAgents(installedHome());
  assert.equal(canonicalTargetId('codex-main'), 'codex:default');
  assert.equal(canonicalTargetId('codex-second'), 'codex:second');
  assert.equal(canonicalTargetId('claude'), 'claude:default');
  assert.equal(canonicalTargetId('grok'), 'grok:default');
  assert.equal(resolveDestination(agents, 'codex-main').profile.target, 'codex:default');
  assert.equal(resolveDestination(agents, 'codex-second').profile.target, 'codex:second');
  assert.equal(resolveDestination(agents, 'claude').profile.target, 'claude:default');
  assert.equal(resolveDestination(agents, 'grok').profile.target, 'grok:default');
  assert.equal(resolveDestination(agents, 'codex-main').legacy, true);
  assert.ok(agents.every((agent) => agent.target !== 'codex-main' && agent.target !== 'codex-second'));
});

test('invalid profile, config-only, and not-installed cannot be destinations', () => {
  const home = '/home/other';
  const agents = discoverAgents(installedHome(home));
  assert.equal(resolveDestination(agents, 'codex:missing').code, 'unknown');
  assert.equal(resolveDestination(agents, 'gemini:default').code, 'config-only');
  assert.equal(resolveDestination(agents, 'copilot:default').code, 'unknown');
  assert.ok(destinationProfiles(agents).every((agent) => agent.agent !== 'copilot' && agent.agent !== 'gemini'));
});

test('grok is destination-only', () => {
  const agents = discoverAgents(installedHome());
  const grok = agents.find((agent) => agent.target === 'grok:default');
  assert.equal(grok.handoff.source, false);
  assert.equal(grok.handoff.destination, true);
  assert.equal(resolveSource(agents, 'grok').code, 'not-source');
  assert.equal(resolveDestination(agents, 'grok:default').ok, true);
  assert.ok(sourceProfiles(agents).every((agent) => agent.agent !== 'grok'));
});

test('JSON target ids stay agent:profile', () => {
  const agents = discoverAgents(installedHome('/srv/work'));
  const parsed = JSON.parse(formatJson(agents));
  const targets = parsed.agents.map((agent) => agent.target).filter(Boolean);
  assert.ok(targets.includes('codex:default'));
  assert.ok(targets.includes('codex:work'));
  assert.ok(targets.every((id) => /^[a-z]+:[^:]+$/.test(id)));
  const listed = JSON.parse(formatTargetsJson(agents));
  assert.ok(listed.targets.some((agent) => agent.target === 'codex:work' && agent.destination === true && agent.source === true));
  assert.ok(listed.targets.every((agent) => agent.destination === true));
  assert.equal(listed.targets.some((agent) => agent.target === 'gemini:default'), false);
});

test('profile home containing spaces', () => {
  const home = '/home/other person';
  const dir = path.join(home, '.codex-qa lab');
  const exe = '/opt/my bins/codex';
  const agents = discoverAgents(probe({
    home,
    executables: { codex: exe },
    versions: { [exe]: 'codex-cli 3' },
    files: [path.join(dir, 'config.toml')],
    directories: [path.join(dir, 'sessions')],
  }));
  const profile = agents.find((agent) => agent.agent === 'codex' && agent.profile === 'qa lab');
  assert.equal(profile.target, 'codex:qa lab');
  assert.equal(profile.launch.env.CODEX_HOME, dir);
  assert.equal(resolveDestination(agents, 'codex:qa lab').ok, true);
  assert.doesNotMatch(JSON.stringify(profile), /\/Users\/sk/);
});

test('a wrapper that assigns CODEX_HOME is not the launch executable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-codex-'));
  const real = path.join(dir, 'codex-real');
  const wrap = path.join(dir, 'codex-wrap');
  fs.writeFileSync(real, '#!/bin/sh\nprintf "codex-cli 1\\n"\n');
  fs.chmodSync(real, 0o755);
  fs.writeFileSync(wrap, `#!/bin/sh\nexport CODEX_HOME="$HOME/.codex"\nexec "${real}" "$@"\n`);
  fs.chmodSync(wrap, 0o755);
  assert.equal(fileAssignsEnv(wrap, 'CODEX_HOME'), true);
  assert.equal(wrapperExecTarget(wrap, '/home/other'), real);
  assert.equal(codexExecutable({
    which() { return wrap; },
    whichAll() { return [wrap]; },
    assignsEnv: fileAssignsEnv,
    execTarget(file) { return wrapperExecTarget(file, '/home/other'); },
  }), real);
});

test('carryforward targets --json lists only destinations', async () => {
  const agents = discoverAgents(installedHome());
  let out = '';
  const code = await runTargets(['--json'], {
    agents,
    stdout: { write(chunk) { out += chunk; } },
    stderr: { write() {} },
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.targets.map((agent) => agent.target), [
    'codex:default',
    'codex:second',
    'codex:work',
    'claude:default',
    'grok:default',
  ]);
  assert.equal(parsed.targets.find((agent) => agent.target === 'grok:default').source, false);
});
