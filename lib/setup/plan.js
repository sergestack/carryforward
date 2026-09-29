// Quota-pool representative, in order:
// 1. the profile named "default", when that pool has one
// 2. otherwise the profile name that sorts first (localeCompare)
// The provider account id is used only to group profiles. It is not a sort key
// and it is never copied onto the returned plan.

const AGENT_ORDER = ['codex', 'claude', 'grok', 'gemini', 'opencode', 'copilot'];

function detected(profile) {
  return profile?.status === 'detected' && Boolean(profile.target);
}

function agentRank(agent) {
  const index = AGENT_ORDER.indexOf(agent);
  return index === -1 ? AGENT_ORDER.length : index;
}

export function chooseRepresentative(members) {
  const canonical = members.find((profile) => profile.profile === 'default');
  if (canonical) return canonical.target;
  const sorted = [...members].sort((a, b) => (
    String(a.profile).localeCompare(String(b.profile)) || a.target.localeCompare(b.target)
  ));
  return sorted[0].target;
}

export function groupCodexPools(profiles, identities = {}) {
  const groups = [];
  const byIdentity = new Map();
  let missing = 0;
  for (const profile of profiles) {
    const id = identities[profile.target];
    if (typeof id !== 'string' || id === '') {
      missing += 1;
      continue;
    }
    let group = byIdentity.get(id);
    if (!group) {
      group = { members: [] };
      byIdentity.set(id, group);
      groups.push(group);
    }
    group.members.push(profile);
  }
  return {
    missing,
    groups: groups.map((group) => ({
      profiles: group.members.map((profile) => profile.target),
      representative: chooseRepresentative(group.members),
    })),
  };
}

function codexDestinations(agents) {
  return agents.filter((profile) => (
    profile.agent === 'codex'
    && detected(profile)
    && profile.handoff?.destination
    && profile.configPath
    && profile.launch?.command
  ));
}

function labelFor(agent, profiles) {
  return profiles.find((profile) => profile.displayName)?.displayName || agent;
}

export function failoverReady(order, groups) {
  if (!order || order.length < 2) {
    return { ready: false, reason: 'Automatic fallback is not configured.' };
  }
  const owner = new Map();
  for (const group of groups) {
    for (const target of group.profiles) owner.set(target, group);
  }
  const seen = new Set();
  for (const target of order) {
    const group = owner.get(target);
    if (!group) return { ready: false, reason: `${target} has no verified quota pool.` };
    if (seen.has(group)) {
      return { ready: false, reason: 'The saved order lists two profiles from one quota pool.' };
    }
    seen.add(group);
  }
  return { ready: true, reason: '' };
}

export function buildSetupPlan(agents, identities = {}) {
  const visible = agents.filter(detected);
  const agentNames = [...new Set(visible.map((profile) => profile.agent))];
  agentNames.sort((a, b) => agentRank(a) - agentRank(b));

  const codex = codexDestinations(agents);
  const grouped = groupCodexPools(codex, identities);
  const manual = visible.filter((profile) => profile.agent !== 'codex' && profile.handoff?.destination);

  const sections = agentNames.map((agent) => {
    const profiles = visible.filter((profile) => profile.agent === agent);
    return {
      agent,
      label: labelFor(agent, profiles),
      profiles: profiles.map((profile) => ({
        target: profile.target,
        role: agent === 'codex'
          ? 'codex'
          : (profile.handoff?.destination ? 'manual' : 'discovery'),
      })),
    };
  });

  const order = grouped.groups.map((group) => group.representative);
  let state = 'ready';
  if (!sections.length) state = 'empty';
  else if (!codex.length) state = 'no-codex';
  else if (grouped.missing && grouped.groups.length < 2) state = 'unverified';
  else if (order.length < 2) state = 'one-pool';

  return {
    state,
    sections,
    groups: grouped.groups,
    missing: grouped.missing,
    order: state === 'ready' ? order : [],
    manualTargets: manual.map((profile) => profile.target),
    manualNames: [...new Set(manual.map((profile) => profile.displayName || profile.agent))],
  };
}

function columnWidth(plan) {
  const targets = plan.sections.flatMap((section) => section.profiles.map((profile) => profile.target));
  const longest = targets.reduce((width, target) => Math.max(width, target.length), 0);
  return Math.max(17, longest + 2);
}

function markFor(profile, plan) {
  if (profile.role === 'manual') return 'manual only';
  if (profile.role === 'discovery') return 'discovery only';
  for (const group of plan.groups) {
    if (group.representative === profile.target) return 'ready';
    if (group.profiles.includes(profile.target)) return 'same allowance';
  }
  return 'quota unknown';
}

function nameList(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

export function manualSentence(names) {
  const pronoun = names.length === 1 ? 'its' : 'their';
  return `${nameList(names)} can still be selected manually because ${pronoun} remaining\nquota cannot currently be verified safely.`;
}

export function chainLines(order) {
  const lines = ['Automatic failover:', ''];
  order.forEach((target, index) => {
    if (index) lines.push('       ↓');
    lines.push(`  ${target}`);
  });
  return lines;
}

export function renderSetup(plan) {
  const lines = ['CarryForward setup', ''];
  if (!plan.sections.length) {
    lines.push('CarryForward found nothing it can launch.');
    lines.push('');
    lines.push('Automatic quota failover currently requires supported live availability data.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('Found:', '');
  const width = columnWidth(plan);
  for (const section of plan.sections) {
    lines.push(`  ${section.label}`);
    for (const profile of section.profiles) {
      lines.push(`    ${profile.target.padEnd(width)}${markFor(profile, plan)}`);
    }
    lines.push('');
  }

  for (const group of plan.groups) {
    if (group.profiles.length < 2) continue;
    lines.push(...group.profiles);
    lines.push('');
    lines.push('share the same Codex allowance and therefore are not independent automatic fallbacks.');
    lines.push('');
  }

  if (plan.state === 'ready') {
    lines.push(...chainLines(plan.order));
    lines.push('');
    if (plan.manualNames.length) {
      lines.push(manualSentence(plan.manualNames));
      lines.push('');
    }
    if (plan.missing) {
      lines.push('Profiles without a verified quota pool were left out of the automatic chain.');
      lines.push('');
    }
  } else if (plan.state === 'one-pool') {
    lines.push('Automatic Codex failover requires another independent Codex account.');
    lines.push('');
    if (plan.manualTargets.length) {
      lines.push('Manual handoffs found:');
      for (const target of plan.manualTargets) lines.push(`  ${target}`);
      lines.push('');
    }
  } else if (plan.state === 'unverified') {
    lines.push('Codex quota pools could not be verified, so no automatic order was saved.');
    lines.push('');
  } else if (plan.state === 'no-codex') {
    lines.push('CarryForward can currently perform manual handoffs for supported agents. Automatic quota failover currently requires supported live availability data.');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
