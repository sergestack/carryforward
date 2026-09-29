// One discovered profile. `usage.supported` is reserved for a later phase.
// `target` is `${agent}:${profile}` whenever a profile home exists.
// Destination handoff also requires an executable. Source handoff requires
// a parser CarryForward actually calls.
export function agentRow({
  agent,
  displayName,
  profile = null,
  executable = null,
  version = null,
  configPath = null,
  sessionPath = null,
  env = null,
  handoffSource = false,
  handoffDestination = false,
}) {
  const installed = Boolean(executable);
  let status = 'not installed';
  if (installed && configPath) status = 'detected';
  else if (installed) status = 'binary only';
  else if (configPath) status = 'config only';

  const target = profile ? `${agent}:${profile}` : null;
  const source = Boolean(handoffSource && configPath && target);
  const destination = Boolean(handoffDestination && installed && configPath && target);

  return {
    agent,
    displayName,
    profile,
    target,
    installed,
    executablePath: executable || null,
    version: installed ? version || null : null,
    configPath,
    sessionPath,
    launch: installed
      ? { command: executable, args: [], env: env || {} }
      : null,
    handoff: { source, destination },
    usage: { supported: false },
    status,
  };
}
