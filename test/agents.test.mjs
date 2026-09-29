import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgents } from '../lib/agents/command.js';
import { formatJson } from '../lib/agents/format.js';
import { which } from '../lib/agents/probe.js';
import { discoverAgents } from '../lib/agents/registry.js';

const root = path.resolve(import.meta.dirname, '..');
const bin = path.join(root, 'bin', 'carryforward');

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

function ids(home) {
  return discoverAgents(probe({ home })).map((agent) => agent.agent);
}

test('no agents installed', () => {
  const home = '/home/nobody';
  const agents = discoverAgents(probe({ home }));
  assert.deepEqual(ids(home), ['codex', 'claude', 'grok', 'gemini', 'opencode', 'copilot']);
  assert.equal(agents.length, 6);
  assert.ok(agents.every((agent) => agent.status === 'not installed' && agent.installed === false));
  assert.doesNotMatch(JSON.stringify(agents), /\/Users\/sk|\/home\/core|sergey/i);
});

test('one agent installed', () => {
  const home = '/home/other';
  const exe = '/usr/local/bin/claude';
  const agents = discoverAgents(
    probe({
      home,
      executables: { claude: exe },
      versions: { [exe]: '1.2.3' },
      files: [path.join(home, '.claude', 'settings.json')],
      directories: [path.join(home, '.claude', 'projects')],
    }),
  );
  const claude = agents.find((agent) => agent.agent === 'claude');
  const rest = agents.filter((agent) => agent.agent !== 'claude');
  assert.equal(claude.status, 'detected');
  assert.equal(claude.profile, 'default');
  assert.equal(claude.version, '1.2.3');
  assert.equal(claude.configPath, path.join(home, '.claude'));
  assert.equal(claude.sessionPath, path.join(home, '.claude', 'projects'));
  assert.equal(claude.launch.env.CLAUDE_CONFIG_DIR, claude.configPath);
  assert.ok(rest.every((agent) => agent.status === 'not installed'));
});

test('multiple different agents', () => {
  const home = '/srv/work';
  const claude = '/bin/claude';
  const grok = '/bin/grok';
  const agents = discoverAgents(
    probe({
      home,
      executables: { claude, grok },
      versions: { [claude]: '9', [grok]: 'grok 1.0' },
      files: [
        path.join(home, '.claude', 'settings.json'),
        path.join(home, '.grok', 'config.toml'),
      ],
      directories: [path.join(home, '.grok', 'sessions')],
    }),
  );
  assert.equal(agents.find((agent) => agent.agent === 'claude').status, 'detected');
  assert.equal(agents.find((agent) => agent.agent === 'grok').status, 'detected');
  assert.equal(agents.find((agent) => agent.agent === 'grok').sessionPath, path.join(home, '.grok', 'sessions'));
  assert.equal(agents.find((agent) => agent.agent === 'gemini').status, 'not installed');
});

test('multiple profiles for one agent come from directories on disk', () => {
  const home = '/home/other';
  const exe = '/bin/codex';
  const wrapper = '/bin/codex-team';
  const agents = discoverAgents(
    probe({
      home,
      executables: { codex: exe, 'codex-team': wrapper },
      versions: { [exe]: 'codex-cli 1', [wrapper]: 'codex-cli 1' },
      files: [
        path.join(home, '.codex', 'config.toml'),
        path.join(home, '.codex-team', 'auth.json'),
        path.join(home, '.unrelated-notes', 'settings.json'),
        path.join(home, '.unrelated-bot', 'config.toml'),
      ],
      directories: [
        path.join(home, '.codex', 'sessions'),
        path.join(home, '.codex-team', 'sessions'),
      ],
    }),
  );
  const codex = agents.filter((agent) => agent.agent === 'codex');
  assert.deepEqual(
    codex.map((agent) => agent.profile),
    ['default', 'team'],
  );
  assert.deepEqual(codex.map((agent) => agent.target), ['codex:default', 'codex:team']);
  assert.equal(codex[0].executablePath, exe);
  assert.equal(codex[1].executablePath, exe);
  assert.equal(codex[1].launch.env.CODEX_HOME, path.join(home, '.codex-team'));
  assert.equal(codex[1].handoff.source, true);
  assert.equal(codex[1].handoff.destination, true);
  assert.equal(agents.filter((agent) => agent.agent === 'claude').length, 1);
  assert.equal(agents.find((agent) => agent.agent === 'claude').status, 'not installed');
  assert.equal(agents.find((agent) => agent.agent === 'grok').status, 'not installed');
});

test('executable exists but config does not', () => {
  const home = '/home/other';
  const exe = '/opt/gemini';
  const gemini = discoverAgents(
    probe({
      home,
      executables: { gemini: exe },
      versions: { [exe]: '0.9.0' },
    }),
  ).find((agent) => agent.agent === 'gemini');
  assert.equal(gemini.status, 'binary only');
  assert.equal(gemini.installed, true);
  assert.equal(gemini.profile, null);
  assert.equal(gemini.configPath, null);
  assert.equal(gemini.version, '0.9.0');
  assert.equal(gemini.launch.env && Object.keys(gemini.launch.env).length, 0);
});

test('config exists but executable does not', () => {
  const home = '/home/other';
  const gemini = discoverAgents(
    probe({
      home,
      files: [path.join(home, '.gemini', 'settings.json')],
    }),
  ).find((agent) => agent.agent === 'gemini');
  assert.equal(gemini.status, 'config only');
  assert.equal(gemini.installed, false);
  assert.equal(gemini.profile, 'default');
  assert.equal(gemini.executablePath, null);
  assert.equal(gemini.launch, null);
  assert.equal(gemini.version, null);
});

test('paths containing spaces resolve under the given home', () => {
  const home = '/home/other person';
  const exe = '/opt/my bins/codex';
  const config = path.join(home, '.codex');
  const agents = discoverAgents(
    probe({
      home,
      env: { CODEX_HOME: `${config}/` },
      executables: { codex: exe },
      versions: { [exe]: 'codex-cli 9' },
      files: [path.join(config, 'config.toml')],
      directories: [path.join(config, 'sessions')],
    }),
  );
  const codex = agents.filter((agent) => agent.agent === 'codex');
  assert.equal(codex.length, 1);
  assert.equal(codex[0].configPath, config);
  assert.equal(codex[0].executablePath, exe);
  assert.equal(codex[0].sessionPath, path.join(config, 'sessions'));
  assert.doesNotMatch(JSON.stringify(agents), /\/Users\/sk|\/home\/core/);
});

test('which finds a command in a PATH entry that contains spaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward bin '));
  const exe = path.join(dir, 'opencode');
  fs.writeFileSync(exe, '#!/bin/sh\nprintf "opencode 1\\n"\n');
  fs.chmodSync(exe, 0o755);
  assert.equal(which('opencode', dir), exe);
  assert.equal(which('missing', dir), null);
});

test('JSON output is stable', async () => {
  const home = '/home/other';
  const exe = '/bin/claude';
  const input = probe({
    home,
    executables: { claude: exe },
    versions: { [exe]: '1.0.0' },
    files: [path.join(home, '.claude', 'history.jsonl')],
  });
  let out = '';
  let err = '';
  const code = await runAgents(['--json'], {
    probe: input,
    stdout: { write(chunk) { out += chunk; } },
    stderr: { write(chunk) { err += chunk; } },
  });
  assert.equal(code, 0);
  assert.equal(err, '');
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed), ['agents']);
  const claude = parsed.agents.find((agent) => agent.agent === 'claude');
  assert.deepEqual(Object.keys(claude), [
    'agent',
    'displayName',
    'profile',
    'target',
    'installed',
    'executablePath',
    'version',
    'configPath',
    'sessionPath',
    'launch',
    'handoff',
    'usage',
    'status',
  ]);
  assert.equal(claude.usage.supported, false);
  assert.equal(claude.status, 'detected');
  assert.equal(out, formatJson(parsed.agents));
});

test('unknown agents flag fails', async () => {
  let err = '';
  const code = await runAgents(['--nope'], {
    probe: probe({ home: '/home/other' }),
    stdout: { write() {} },
    stderr: { write(chunk) { err += chunk; } },
  });
  assert.equal(code, 1);
  assert.match(err, /Unknown argument: --nope/);
});

test('carryforward agents --help exits 0', () => {
  const res = spawnSync(bin, ['agents', '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /carryforward agents --json/);
  assert.doesNotMatch(res.stdout, /\/Users\/sk|\/home\/core/);
});
