import path from 'node:path';
import { byProfile, profileName, siblingDirs } from './profiles.js';
import { agentRow } from './row.js';

const ROOT = '.grok';

function isGrokHome(probe, dir) {
  return probe.exists(path.join(dir, 'config.toml')) || probe.isDirectory(path.join(dir, 'sessions'));
}

// Grok's documented config directory is ~/.grok. Extra profiles are other
// ~/.grok-* directories that contain the same markers. There is no separate
// home variable in the current CLI.
export function discover(probe) {
  const exe = probe.which('grok');
  const homes = siblingDirs(probe, ROOT).filter((dir) => isGrokHome(probe, dir));

  if (homes.length === 0) {
    return [
      agentRow({
        agent: 'grok',
        displayName: 'Grok',
        executable: exe,
        version: exe ? probe.version(exe) : null,
        handoffSource: false,
        handoffDestination: true,
      }),
    ];
  }

  return homes
    .map((dir) => {
      const sessions = path.join(dir, 'sessions');
      return agentRow({
        agent: 'grok',
        displayName: 'Grok',
        profile: profileName(dir, ROOT),
        executable: exe,
        version: exe ? probe.version(exe) : null,
        configPath: dir,
        sessionPath: probe.isDirectory(sessions) ? sessions : null,
        env: {},
        handoffSource: false,
        handoffDestination: true,
      });
    })
    .sort(byProfile);
}
