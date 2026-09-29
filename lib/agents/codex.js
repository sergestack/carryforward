import path from 'node:path';
import { byProfile, profileName, siblingDirs, uniquePaths } from './profiles.js';
import { agentRow } from './row.js';

const ROOT = '.codex';

function isCodexHome(probe, dir) {
  return (
    probe.exists(path.join(dir, 'config.toml')) ||
    probe.exists(path.join(dir, 'auth.json')) ||
    probe.isDirectory(path.join(dir, 'sessions'))
  );
}

// Profile wrappers often export CODEX_HOME and would hide every other profile.
// Prefer a codex executable that leaves CODEX_HOME to the caller.
export function codexExecutable(probe) {
  const all = typeof probe.whichAll === 'function'
    ? probe.whichAll('codex')
    : [probe.which('codex')].filter(Boolean);
  for (const file of all) {
    const assigns = typeof probe.assignsEnv === 'function' && probe.assignsEnv(file, 'CODEX_HOME');
    if (!assigns) return file;
    const underlying = typeof probe.execTarget === 'function' ? probe.execTarget(file) : null;
    if (underlying && !probe.assignsEnv(underlying, 'CODEX_HOME')) return underlying;
  }
  return null;
}

export function discover(probe) {
  const exe = codexExecutable(probe);
  const fromEnv = uniquePaths(probe.env.CODEX_HOME ? [probe.env.CODEX_HOME] : []);
  const homes = uniquePaths([...fromEnv, ...siblingDirs(probe, ROOT)]).filter((dir) => {
    if (!probe.isDirectory(dir)) return false;
    if (fromEnv.includes(dir)) return true;
    return isCodexHome(probe, dir);
  });

  if (homes.length === 0) {
    return [
      agentRow({
        agent: 'codex',
        displayName: 'Codex',
        executable: exe,
        version: exe ? probe.version(exe) : null,
        handoffSource: true,
        handoffDestination: true,
      }),
    ];
  }

  return homes
    .map((dir) => {
      const profile = profileName(dir, ROOT);
      const sessions = path.join(dir, 'sessions');
      return agentRow({
        agent: 'codex',
        displayName: 'Codex',
        profile,
        executable: exe,
        version: exe ? probe.version(exe) : null,
        configPath: dir,
        sessionPath: probe.isDirectory(sessions) ? sessions : null,
        env: { CODEX_HOME: dir },
        handoffSource: true,
        handoffDestination: true,
      });
    })
    .sort(byProfile);
}
