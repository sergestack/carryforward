// Run: rtk node assets/demo/record.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const out = import.meta.dirname;
const repo = path.resolve(out, '../..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-demo-'));
const home = path.join(sandbox, 'home');
const bin = path.join(sandbox, 'bin');
const cwd = path.join(home, 'example');
for (const dir of [bin, cwd, ...['alpha', 'beta'].map(p => path.join(home, `.codex-${p}`, 'sessions')), path.join(home, '.config/carryforward')]) fs.mkdirSync(dir, { recursive: true });
// Strict PATH allowlist: no real Codex executable or user wrappers.
for (const [name, target] of Object.entries({ node: process.execPath, carryforward: path.join(repo, 'bin/carryforward'), ps: '/usr/bin/ps', lsof: '/usr/bin/lsof' })) {
  if (fs.existsSync(target)) fs.symlinkSync(target, path.join(bin, name));
}
fs.copyFileSync(path.join(out, 'fake-codex.mjs'), path.join(bin, 'codex'));
fs.chmodSync(path.join(bin, 'codex'), 0o755);
fs.writeFileSync(path.join(home, '.config/carryforward/fallback.json'), JSON.stringify({ version: 1, fallback: ['codex:alpha', 'codex:beta'] }));
// Build env from scratch; inherit no credentials, configuration, or sessions.
const env = { HOME: home, PATH: bin, TERM: 'xterm-256color', LANG: 'C.UTF-8', TMPDIR: sandbox };
const events = [{ t: 0, text: '$ carryforward run codex:alpha\n' }];
const start = performance.now();
await new Promise(resolve => setTimeout(resolve, 650));
const child = spawn(path.join(bin, 'carryforward'), ['run', 'codex:alpha'], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stdout.on('data', data => events.push({ t: (performance.now() - start) / 1000, text: data.toString() }));
child.stderr.on('data', data => { stderr += data; });
const timeout = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 20000);
try {
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  assert.equal(code, 0, stderr + events.map(e => e.text).join(''));
  assert.equal(stderr, '');
  const transcript = events.map(e => e.text).join('');
  for (const line of ['CarryForward: codex:alpha reached its current quota.', 'CarryForward: continuing with codex:beta.', 'Context received from codex:alpha', '✓ Tests passing']) assert.ok(transcript.includes(line));
  assert.doesNotMatch(transcript, /\/home\/|\/tmp\/|@|11111111/);
  const audit = fs.readFileSync(path.join(home, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const name of ['structured-quota-appended', 'alpha-stopped', 'beta-context-verified', 'beta-completed']) assert.ok(audit.some(e => e.event === name));
  const duration = (performance.now() - start) / 1000;
  assert.ok(duration >= 10 && duration <= 15, `duration: ${duration}`);
  fs.writeFileSync(path.join(out, 'recording.json'), JSON.stringify({ duration, events, audit }, null, 2) + '\n');
  console.log(`Verified real CLI failover and context transfer; captured ${duration.toFixed(2)} seconds.`);
} finally {
  clearTimeout(timeout);
  fs.rmSync(sandbox, { recursive: true, force: true });
}
