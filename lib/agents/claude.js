import path from 'node:path';
import { byProfile, profileName, siblingDirs, uniquePaths } from './profiles.js';
import { agentRow } from './row.js';

const ROOT = '.claude';

function isClaudeHome(probe, dir) {
  return (
    probe.exists(path.join(dir, 'settings.json')) ||
    probe.exists(path.join(dir, 'history.jsonl')) ||
    probe.isDirectory(path.join(dir, 'projects'))
  );
}

export function discover(probe) {
  const exe = probe.which('claude');
  const fromEnv = uniquePaths(probe.env.CLAUDE_CONFIG_DIR ? [probe.env.CLAUDE_CONFIG_DIR] : []);
  const homes = uniquePaths([...fromEnv, ...siblingDirs(probe, ROOT)]).filter((dir) => {
    if (!probe.isDirectory(dir)) return false;
    if (fromEnv.includes(dir)) return true;
    return isClaudeHome(probe, dir);
  });

  if (homes.length === 0) {
    return [
      agentRow({
        agent: 'claude',
        displayName: 'Claude',
        executable: exe,
        version: exe ? probe.version(exe) : null,
        handoffSource: true,
        handoffDestination: true,
      }),
    ];
  }

  return homes
    .map((dir) => {
      const projects = path.join(dir, 'projects');
      const executable = exe;
      return agentRow({
        agent: 'claude',
        displayName: 'Claude',
        profile: profileName(dir, ROOT),
        executable,
        version: executable ? probe.version(executable) : null,
        configPath: dir,
        sessionPath: probe.isDirectory(projects) ? projects : null,
        env: { CLAUDE_CONFIG_DIR: dir },
        handoffSource: true,
        handoffDestination: true,
      });
    })
    .sort(byProfile);
}
