import path from 'node:path';
import { byProfile, profileName, siblingDirs, uniquePaths } from './profiles.js';
import { agentRow } from './row.js';

const ROOT = '.copilot';

function isCopilotHome(probe, dir) {
  return (
    probe.isDirectory(path.join(dir, 'session-state')) ||
    probe.exists(path.join(dir, 'config.json'))
  );
}

export function discover(probe) {
  const exe = probe.which('copilot');
  const fromEnv = uniquePaths(probe.env.COPILOT_HOME ? [probe.env.COPILOT_HOME] : []);
  const homes = uniquePaths([...fromEnv, ...siblingDirs(probe, ROOT)]).filter((dir) => {
    if (!probe.isDirectory(dir)) return false;
    if (fromEnv.includes(dir)) return true;
    return isCopilotHome(probe, dir);
  });

  if (homes.length === 0) {
    return [
      agentRow({
        agent: 'copilot',
        displayName: 'Copilot',
        executable: exe,
        version: exe ? probe.version(exe) : null,
        handoffSource: false,
        handoffDestination: false,
      }),
    ];
  }

  return homes
    .map((dir) => {
      const sessions = path.join(dir, 'session-state');
      const executable = exe;
      return agentRow({
        agent: 'copilot',
        displayName: 'Copilot',
        profile: profileName(dir, ROOT),
        executable,
        version: executable ? probe.version(executable) : null,
        configPath: dir,
        sessionPath: probe.isDirectory(sessions) ? sessions : null,
        env: { COPILOT_HOME: dir },
        handoffSource: false,
        handoffDestination: false,
      });
    })
    .sort(byProfile);
}
