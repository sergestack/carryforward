import { discoverAgents } from '../agents/registry.js';
import { machineProbe } from '../agents/probe.js';
import { validateFallback, readFallback } from '../policy/config.js';
import { collectMany } from '../usage/registry.js';
import { buildSetupPlan, failoverReady } from '../setup/plan.js';

const HELP = `carryforward status — is automatic failover ready?

  carryforward status
  carryforward status --json

Shows installed agents, manual-only profiles, Codex quota pools, the
saved chain, and live Codex usage when a profile can report it.
Account identifiers are not printed.
`;

function streams(options) {
  return {
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr,
  };
}

function parseStatus(argv) {
  let json = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json') {
      json = true;
      continue;
    }
    return { error: `Unknown argument: ${arg}` };
  }
  return { json };
}

async function evidenceFor(codex, options) {
  if (options.identities || options.usage) {
    return { identities: options.identities || {}, usage: options.usage || [] };
  }
  const identities = {};
  try {
    const usage = await collectMany(codex, {
      ...(options.deps || {}),
      captureIdentity(target, accountId) { identities[target] = accountId; },
    });
    return { identities, usage };
  } catch {
    return { identities, usage: [] };
  }
}

function publicWindow(window) {
  return {
    name: window.name,
    usedPercent: window.usedPercent,
    remainingPercent: window.remainingPercent,
    resetsAt: window.resetsAt,
  };
}

function publicUsage(entry) {
  if (!entry) return null;
  return {
    state: entry.state,
    source: entry.source,
    freshness: entry.freshness,
    windows: (entry.windows || []).map(publicWindow),
  };
}

function usageHint(entry) {
  if (!entry || entry.state === 'unknown') return '';
  const window = (entry.windows || []).find((item) => item.name === '5-hour') || entry.windows?.[0];
  if (!window || typeof window.remainingPercent !== 'number') return entry.state || '';
  return `${window.name} ${window.remainingPercent}% left`;
}

function columnWidth(sections) {
  const targets = sections.flatMap((section) => section.profiles.map((profile) => profile.target));
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

function readiness(plan, order, configError) {
  if (configError) return { ready: false, reason: configError };
  const checked = failoverReady(order, plan.groups);
  if (checked.ready) return checked;
  if (plan.state === 'one-pool') {
    return { ready: false, reason: 'Automatic Codex failover requires another independent Codex account.' };
  }
  if (plan.state === 'unverified') {
    return { ready: false, reason: 'Codex quota pools could not be verified.' };
  }
  if (plan.state === 'no-codex') {
    return { ready: false, reason: 'Automatic quota failover currently requires supported live availability data.' };
  }
  return checked;
}

function renderStatus(plan, order, usageByTarget, ready) {
  const lines = ['CarryForward status', ''];
  if (!plan.sections.length) {
    lines.push('No supported agents were found.');
    lines.push('');
  } else {
    lines.push('Agents:', '');
    const width = columnWidth(plan.sections);
    for (const section of plan.sections) {
      lines.push(`  ${section.label}`);
      for (const profile of section.profiles) {
        const hint = usageHint(usageByTarget.get(profile.target));
        const mark = markFor(profile, plan).padEnd(16);
        lines.push(`    ${profile.target.padEnd(width)}${mark}${hint}`.trimEnd());
      }
      lines.push('');
    }
  }
  if (plan.groups.length) {
    lines.push('Quota pools:');
    plan.groups.forEach((group, index) => {
      lines.push(`  ${index + 1}  ${group.profiles.join(', ')}`);
    });
    lines.push('');
  }
  lines.push('Automatic targets:');
  lines.push(order.length ? `  ${order.join(' → ')}` : '  (none)');
  lines.push('');
  if (plan.manualTargets.length) {
    lines.push('Manual only:');
    for (const target of plan.manualTargets) lines.push(`  ${target}`);
    lines.push('');
  }
  lines.push(ready.ready ? 'Auto-failover: ready' : `Auto-failover: not ready`);
  if (!ready.ready && ready.reason) lines.push(ready.reason);
  return `${lines.join('\n')}\n`;
}

function statusJson(plan, order, usageByTarget, ready) {
  return {
    version: 1,
    autoFailoverReady: ready.ready,
    reason: ready.reason || null,
    fallback: order,
    pools: plan.groups.map((group) => ({
      profiles: group.profiles,
      representative: group.representative,
    })),
    agents: plan.sections.map((section) => ({
      name: section.label,
      profiles: section.profiles.map((profile) => ({
        target: profile.target,
        mark: markFor(profile, plan),
        usage: publicUsage(usageByTarget.get(profile.target)),
      })),
    })),
    manual: plan.manualTargets,
  };
}

export async function runStatus(argv, options = {}) {
  const { stdout, stderr } = streams(options);
  const parsed = parseStatus(argv);
  if (parsed.help) {
    stdout.write(HELP);
    return 0;
  }
  if (parsed.error) {
    stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const agents = options.agents || discoverAgents(options.probe || machineProbe());
  let saved;
  let configError = '';
  try {
    saved = options.order ? { fallback: options.order } : readFallback(options);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 1;
  }
  const codex = agents.filter((profile) => profile.agent === 'codex' && profile.handoff?.destination && profile.launch?.command);
  const evidence = await evidenceFor(codex, options);
  const plan = buildSetupPlan(agents, evidence.identities);
  const usageByTarget = new Map((evidence.usage || []).map((entry) => [entry.target, entry]));
  let order = saved.fallback || [];
  let exitCode = 0;
  if (!options.order && order.length) {
    const validated = validateFallback(order, agents);
    if (!validated.ok) {
      configError = validated.errors.join(' ');
      exitCode = 1;
    }
  }
  const ready = readiness(plan, configError ? [] : order, configError);
  const secretValues = Object.values(evidence.identities || {}).filter((id) => typeof id === 'string' && id);
  if (parsed.json) {
    const body = `${JSON.stringify(statusJson(plan, order, usageByTarget, ready), null, 2)}\n`;
    if (secretValues.some((id) => body.includes(id))) {
      stderr.write('CarryForward: refused to print an account identifier.\n');
      return 1;
    }
    stdout.write(body);
    return exitCode;
  }
  const rendered = renderStatus(plan, order, usageByTarget, ready);
  if (secretValues.some((id) => rendered.includes(id))) {
    stderr.write('CarryForward: refused to print an account identifier.\n');
    return 1;
  }
  stdout.write(rendered);
  return exitCode;
}
