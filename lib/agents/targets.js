// Old command names. They are not target ids and are not listed as profiles.
export const LEGACY_ALIASES = {
  claude: 'claude:default',
  'codex-main': 'codex:default',
  'codex-second': 'codex:second',
  grok: 'grok:default',
};

export function isLegacyAlias(token) {
  return Object.prototype.hasOwnProperty.call(LEGACY_ALIASES, token);
}

export function canonicalTargetId(token) {
  if (!token) return token;
  return LEGACY_ALIASES[token] || token;
}

export function profileByTarget(agents, token) {
  const id = canonicalTargetId(token);
  return agents.find((agent) => agent.target === id) || null;
}

export function destinationProfiles(agents) {
  return agents.filter((agent) => agent.handoff?.destination);
}

export function sourceProfiles(agents) {
  return agents.filter((agent) => agent.handoff?.source);
}

function unresolved(agents, token) {
  const id = canonicalTargetId(token);
  const profile = agents.find((agent) => agent.target === id) || null;
  return { id, profile, legacy: isLegacyAlias(token) };
}

export function resolveDestination(agents, token) {
  const { id, profile, legacy } = unresolved(agents, token);
  if (!profile) return { ok: false, code: 'unknown', id, legacy };
  if (profile.handoff.destination) return { ok: true, code: 'ok', id, profile, legacy };
  if (!profile.installed && profile.configPath) return { ok: false, code: 'config-only', id, profile, legacy };
  if (!profile.installed) return { ok: false, code: 'not-installed', id, profile, legacy };
  return { ok: false, code: 'not-destination', id, profile, legacy };
}

export function resolveSource(agents, token) {
  const { id, profile, legacy } = unresolved(agents, token);
  if (!profile) return { ok: false, code: 'unknown', id, legacy };
  if (profile.handoff.source) return { ok: true, code: 'ok', id, profile, legacy };
  return { ok: false, code: 'not-source', id, profile, legacy };
}

export function destinationFailure(result, token) {
  const name = result.legacy ? `${token} (${result.id})` : result.id;
  if (result.code === 'config-only') return `${name} has config but no executable, so it cannot be a destination.`;
  if (result.code === 'not-installed') return `${name} is not installed.`;
  if (result.code === 'not-destination') return `${name} cannot receive a handoff.`;
  return `Unknown target '${name}'. Run \`carryforward targets\` for launchable profiles.`;
}
