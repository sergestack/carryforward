import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const bin = path.join(root, 'bin', 'carryforward');

function run(args, home) {
  return spawnSync(bin, args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

test('--help uses carryforward and does not print the old identity', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carryforward-help-'));
  const res = run(['--help'], home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^carryforward — keep Codex work moving when one account reaches its limit/);
  assert.match(res.stdout, /carryforward setup/);
  assert.match(res.stdout, /carryforward status/);
  assert.match(res.stdout, /carryforward --status/);
  assert.doesNotMatch(`${res.stdout}\n${res.stderr}`, /sergestack|\/Users\/|\/home\//i);
});

test('launcher source has no machine-specific developer identity', () => {
  const src = fs.readFileSync(bin, 'utf8');
  assert.doesNotMatch(src, /\/Users\/|\/home\/|sergestack|Yigit|yigitkonur/i);
});
