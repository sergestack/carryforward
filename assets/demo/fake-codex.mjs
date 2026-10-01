#!/usr/bin/env node
// Fictional provider only. All supervision and handoff remain in the real CLI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import assert from 'node:assert/strict';

const home = process.env.HOME;
const profile = path.basename(process.env.CODEX_HOME || '').replace('.codex-', '');
const auditFile = path.join(home, 'audit.jsonl');
const audit = (event, extra = {}) => fs.appendFileSync(auditFile, JSON.stringify({ event, profile, ...extra }) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const say = text => console.log(text);
if (process.argv.includes('--version')) {
  say('codex-cli 0.0.0-demo');
} else if (process.argv.includes('app-server')) {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (!request.id) return;
    const result = request.method === 'account/rateLimits/read'
      ? { accountId: `fictional-pool-${profile}`, rateLimits: { primary: { usedPercent: profile === 'alpha' ? 100 : 12, windowDurationMins: 300 } } }
      : {};
    audit(request.method);
    say(JSON.stringify({ id: request.id, result }));
  });
} else if (profile === 'alpha') {
  const id = '11111111-1111-4111-8111-111111111111';
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const file = path.join(process.env.CODEX_HOME, 'sessions', `rollout-${stamp}-${id}.jsonl`);
  const fd = fs.openSync(file, 'a'); // Keep open for production PID/file binding.
  const append = (type, payload) => fs.writeSync(fd, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n');
  append('session_meta', { id, cwd: process.cwd(), source: 'cli', timestamp: new Date().toISOString() });
  append('event_msg', { type: 'user_message', message: 'Add retry logic to API client' });
  append('event_msg', { type: 'agent_message', message: 'src/client.js already inspected. Found request handler. Retry implementation was in progress. Next: add exponential backoff and run tests.' });
  audit('alpha-started');
  process.on('SIGINT', () => { audit('alpha-stopped', { signal: 'SIGINT' }); fs.closeSync(fd); process.exit(0); });
  say('\nCodex · alpha\n');
  say('Working on: Add retry logic to API client\n');
  await sleep(650); say('✓ Reading src/client.js');
  await sleep(750); say('✓ Found request handler');
  await sleep(700); say('✓ Implementing retry logic...');
  await sleep(900);
  append('event_msg', { type: 'error', codex_error_info: 'usage_limit_exceeded', message: 'You have hit your usage limit.' });
  audit('structured-quota-appended', { elapsedMs: 3000 });
  setInterval(() => {}, 1000);
} else if (profile === 'beta') {
  const bootstrap = process.argv.at(-1);
  const file = bootstrap.match(/^Payload file: (.+)$/m)?.[1];
  assert.ok(file && file.startsWith(home + path.sep), 'payload must be isolated');
  const payload = fs.readFileSync(file, 'utf8');
  assert.equal(crypto.createHash('sha256').update(payload).digest('hex'), bootstrap.match(/^Payload sha256: (.+)$/m)?.[1]);
  for (const text of ['codex:alpha', '11111111-1111-4111-8111-111111111111', 'Add retry logic to API client', 'src/client.js already inspected', 'Retry implementation was in progress']) assert.ok(payload.includes(text), `missing context: ${text}`);
  assert.ok(fs.readFileSync(auditFile, 'utf8').includes('alpha-stopped'), 'Alpha must stop before Beta');
  audit('beta-context-verified', { exactSession: true, sha256Verified: true });
  fs.unlinkSync(file);
  await sleep(900); say('\nCodex · beta\n');
  await sleep(800); say('Context received from codex:alpha\n');
  await sleep(800); say('✓ src/client.js already inspected');
  await sleep(650); say('✓ Retry implementation was in progress\n');
  await sleep(800); say('Continuing...\n');
  await sleep(1150); say('✓ Added exponential backoff');
  await sleep(900); say('✓ Tests passing');
  audit('beta-completed');
  await sleep(450);
} else {
  throw new Error('Unexpected demo profile');
}
