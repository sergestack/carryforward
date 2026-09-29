import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const installScript = path.join(root, 'install.sh');
const nodeDir = path.dirname(process.execPath);
const sessionId = '11111111-1111-4111-8111-111111111111';

function writeFile(file, body, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode });
}

function cleanEnv(home, extraPath) {
  return {
    HOME: home,
    PATH: `${extraPath}:${nodeDir}:/usr/bin:/bin`,
    TERM: 'dumb',
    TMPDIR: os.tmpdir(),
  };
}

test('install refuses an incomplete extractor and links nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-incomplete-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-incomplete-home-'));
  writeFile(path.join(dir, 'install.sh'), fs.readFileSync(installScript));
  fs.chmodSync(path.join(dir, 'install.sh'), 0o755);
  writeFile(path.join(dir, 'bin', 'carryforward'), '#!/usr/bin/env node\n');
  const res = spawnSync('bash', [path.join(dir, 'install.sh')], {
    encoding: 'utf8',
    env: cleanEnv(home, '/usr/bin'),
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /cli-continues/);
  assert.match(res.stderr, /Nothing was linked/);
  assert.equal(fs.existsSync(path.join(home, '.local', 'bin', 'carryforward')), false);
});

test('install refuses a checksum mismatch and links nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-mismatch-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-mismatch-home-'));
  const vendor = path.join(dir, 'third_party', 'cli-continues');
  writeFile(path.join(dir, 'install.sh'), fs.readFileSync(installScript));
  fs.chmodSync(path.join(dir, 'install.sh'), 0o755);
  writeFile(path.join(dir, 'bin', 'carryforward'), '#!/usr/bin/env node\n');
  for (const rel of [
    'LICENSE',
    'VENDOR.json',
    'package.json',
    'package-lock.json',
    'dist/parsers/claude.js',
    'dist/config/index.js',
    'dist/utils/resume.js',
    'node_modules/chalk/package.json',
    'node_modules/yaml/package.json',
    'node_modules/zod/package.json',
    'node_modules/@clack/prompts/dist/index.mjs',
  ]) {
    writeFile(path.join(vendor, rel), fs.readFileSync(path.join(root, 'third_party', 'cli-continues', rel)));
  }
  writeFile(path.join(vendor, 'dist', 'parsers', 'codex.js'), 'export const replaced = true;\n');
  const res = spawnSync('bash', [path.join(dir, 'install.sh')], {
    encoding: 'utf8',
    env: cleanEnv(home, '/usr/bin'),
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /checksum mismatch/);
  assert.match(res.stderr, /Nothing was linked/);
  assert.equal(fs.existsSync(path.join(home, '.local', 'bin', 'carryforward')), false);
});

test('a fresh install extracts a fixture session without a preinstalled runtime', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-handoff-'));
  const fakeBin = path.join(home, 'fake-bin');
  writeFile(path.join(fakeBin, 'codex'), '#!/bin/sh\necho "codex fixture 0.0.0"\n', 0o755);
  const installed = spawnSync('bash', [installScript], {
    encoding: 'utf8',
    env: cleanEnv(home, '/usr/bin'),
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /bundled cli-continues 4\.1\.1/);
  const link = path.join(home, '.local', 'bin', 'carryforward');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(home, '.local', 'share')), false);

  writeFile(path.join(home, '.codex', 'config.toml'), 'model = "fixture"\n');
  writeFile(path.join(home, '.codex-second', 'config.toml'), 'model = "fixture"\n');
  const session = path.join(
    home,
    '.codex',
    'sessions',
    '2026',
    '01',
    '01',
    `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`,
  );
  writeFile(session, [
    '{"type":"session_meta","payload":{"cwd":"/work/example","timestamp":"2026-01-01T00:00:00Z"}}',
    '{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"Add a greeting function to the example project."}}',
    '{"timestamp":"2026-01-01T00:00:02Z","type":"event_msg","payload":{"type":"agent_message","message":"Added greet() in src/hello.js."}}',
    '{"timestamp":"2026-01-01T00:00:03Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Added greet() in src/hello.js."}}',
    '',
  ].join('\n'));

  const env = cleanEnv(home, `${path.join(home, '.local', 'bin')}:${fakeBin}`);
  const dry = spawnSync(link, [
    '--dry-run',
    'codex:second',
    '--source',
    'codex:default',
    '--session-id',
    sessionId,
  ], { encoding: 'utf8', env, cwd: home });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`Session: ${sessionId}`));
  assert.match(dry.stdout, /Source cwd: \/work\/example/);
  assert.match(dry.stdout, /Destination target: codex:second/);
  assert.match(dry.stdout, /Handoff bytes: [1-9]/);
  assert.match(dry.stdout, /dry run — target was not launched/);
  assert.doesNotMatch(`${dry.stdout}\n${dry.stderr}`, /\/Users\/sk|\/home\/core/);
  assert.equal(fs.existsSync(path.join(home, '.local', 'share')), false);

  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(home, '.codex');
  try {
    const parser = pathToFileURL(path.join(root, 'third_party', 'cli-continues', 'dist', 'parsers', 'codex.js'));
    const mod = await import(parser.href);
    const sessions = await mod.parseCodexSessions();
    const hit = sessions.find((item) => item.id === sessionId);
    assert.ok(hit, 'fixture session was not parsed from the bundled extractor');
    const context = await mod.extractCodexContext(hit);
    assert.match(context.markdown, /Add a greeting function to the example project\./);
    assert.match(context.markdown, /Added greet\(\) in src\/hello\.js\./);
    const resumeUrl = pathToFileURL(path.join(root, 'third_party', 'cli-continues', 'dist', 'utils', 'resume.js'));
    const resume = await import(resumeUrl.href);
    const args = resume.getDefaultHandoffInitArgs('codex', []);
    assert.ok(args.includes('model_reasoning_effort="high"'));
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});
