import path from 'node:path';
import { agentRow } from './row.js';

function configDir(probe) {
  const base = probe.env.XDG_CONFIG_HOME || path.join(probe.home, '.config');
  return path.join(base, 'opencode');
}

function dataDir(probe) {
  const base = probe.env.XDG_DATA_HOME || path.join(probe.home, '.local', 'share');
  return path.join(base, 'opencode');
}

// OpenCode has one data directory (XDG) plus an optional config directory.
// A second account would be a different XDG home, not a guessed folder name.
export function discover(probe) {
  const exe = probe.which('opencode');
  const config = configDir(probe);
  const data = dataDir(probe);
  const hasConfig = probe.exists(path.join(config, 'opencode.json'));
  const hasData = probe.isDirectory(data);

  if (!exe && !hasConfig && !hasData) {
    return [agentRow({ agent: 'opencode', displayName: 'OpenCode', handoffSource: false, handoffDestination: false })];
  }

  return [
    agentRow({
      agent: 'opencode',
      displayName: 'OpenCode',
      profile: hasConfig || hasData ? 'default' : null,
      executable: exe,
      version: exe ? probe.version(exe) : null,
      configPath: hasConfig ? config : null,
      sessionPath: hasData ? data : null,
      env: {},
      handoffSource: false,
      handoffDestination: false,
    }),
  ];
}
