import path from 'node:path';
import { uniquePaths } from './profiles.js';
import { agentRow } from './row.js';

function configDir(home) {
  return path.join(home, '.gemini');
}

function isGeminiHome(probe, dir) {
  return (
    probe.exists(path.join(dir, 'settings.json')) ||
    probe.exists(path.join(dir, 'projects.json')) ||
    probe.isDirectory(path.join(dir, 'tmp'))
  );
}

// Gemini CLI stores state in <home>/.gemini. GEMINI_CLI_HOME replaces the
// home directory, not the .gemini folder itself.
export function discover(probe) {
  const exe = probe.which('gemini');
  const homes = uniquePaths([
    probe.env.GEMINI_CLI_HOME || '',
    probe.home,
  ]);
  const dirs = homes
    .map((home) => configDir(home))
    .filter((dir) => probe.isDirectory(dir) && isGeminiHome(probe, dir));

  if (dirs.length === 0) {
    return [
      agentRow({
        agent: 'gemini',
        displayName: 'Gemini',
        executable: exe,
        version: exe ? probe.version(exe) : null,
        handoffSource: false,
        handoffDestination: true,
      }),
    ];
  }

  return dirs.map((dir) => {
    const tmp = path.join(dir, 'tmp');
    const parent = path.dirname(dir);
    return agentRow({
      agent: 'gemini',
      displayName: 'Gemini',
      profile: parent === probe.home ? 'default' : path.basename(parent),
      executable: exe,
      version: exe ? probe.version(exe) : null,
      configPath: dir,
      sessionPath: probe.isDirectory(tmp) ? tmp : null,
      env: { GEMINI_CLI_HOME: parent },
      handoffSource: false,
      handoffDestination: true,
    });
  });
}
