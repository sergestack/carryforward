import { spawn } from 'node:child_process';

export function trackChild(child) {
  let settled = false;
  let result = null;
  const finished = new Promise((resolve) => {
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      result = { code: 1, signal: null, error: err };
      resolve(result);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      result = { code: code ?? 0, signal: signal || null };
      resolve(result);
    });
  });
  return {
    pid: child.pid,
    get settled() { return settled; },
    get result() { return result; },
    finished,
    kill(signal) {
      try { child.kill(signal); } catch { /* already gone */ }
    },
    async waitFor(ms) {
      if (settled) return true;
      await Promise.race([
        finished,
        new Promise((resolve) => setTimeout(resolve, ms)),
      ]);
      return settled;
    },
  };
}

export function launchChild(command, args, { cwd, env, stdio = 'inherit' } = {}) {
  const child = spawn(command, args, { cwd, env, stdio });
  return trackChild(child);
}

export async function stopOwnedChild(handle) {
  if (!handle || handle.settled) return { stopped: true };
  handle.kill('SIGINT');
  if (await handle.waitFor(400)) return { stopped: true };
  handle.kill('SIGTERM');
  if (await handle.waitFor(800)) return { stopped: true };
  handle.kill('SIGKILL');
  await handle.waitFor(800);
  return { stopped: Boolean(handle.settled) };
}

export function restoreTerminal() {
  if (process.stdin.isTTY && process.stdin.isRaw) {
    try { process.stdin.setRawMode(false); } catch { /* nothing to restore */ }
  }
}
