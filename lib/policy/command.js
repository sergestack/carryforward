import { discoverAgents } from '../agents/registry.js';
import { machineProbe } from '../agents/probe.js';
import { canonicalTargetId, profileByTarget } from '../agents/targets.js';
import { collectMany } from '../usage/registry.js';
import { readFallback, validateFallback, writeFallback } from './config.js';
import { formatPlan, formatPlanJson } from './format.js';
import { planFailover } from './plan.js';

const FALLBACK_HELP = `carryforward fallback — automatic failover order

  carryforward fallback
  carryforward fallback --json
  carryforward fallback set <target> <target> ...

The chain is planning order only. CarryForward does not launch a successor.
Targets without a reliable usage meter are manual-only and are rejected
here. Hand those off by name, for example \`carryforward claude:default\`.

Config: $CARRYFORWARD_CONFIG_HOME/fallback.json, or
$XDG_CONFIG_HOME/carryforward/fallback.json, or ~/.config/carryforward/fallback.json.
`;

const NEXT_HELP = `carryforward next — plan the next verified target

  carryforward next <current-target>
  carryforward next <current-target> --json
  carryforward next <current-target> --attempted <target>
  carryforward next <current-target> --rate-limited <target>
  carryforward next <current-target> --profile-failed <target>

Planning only. Nothing is launched.
Unknown, blocked, and unusable targets are skipped.
--rate-limited records a confirmed current rate-limit rejection.
It does not watch a process. A historical limit is not a rejection.
`;

function streams(options) {
  return {
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr,
  };
}

function agentsOf(options) {
  return options.agents || discoverAgents(options.probe || machineProbe());
}

export async function runFallback(argv, options = {}) {
  const { stdout, stderr } = streams(options);
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(FALLBACK_HELP);
    return 0;
  }
  const json = argv.includes('--json');
  const args = argv.filter((arg) => arg !== '--json');
  if (args[0] === 'set') {
    const validated = validateFallback(args.slice(1), agentsOf(options));
    if (!validated.ok) {
      stderr.write(`${validated.errors.join('\n')}\n`);
      return 1;
    }
    writeFallback({ version: 1, fallback: validated.fallback }, options);
    const saved = { version: 1, fallback: validated.fallback };
    stdout.write(json ? `${JSON.stringify(saved, null, 2)}\n` : formatFallback(saved));
    return 0;
  }
  if (args.length) {
    stderr.write(`Unknown argument: ${args[0]}\n`);
    return 1;
  }
  let saved;
  try {
    saved = readFallback(options);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 1;
  }
  stdout.write(json ? `${JSON.stringify(saved, null, 2)}\n` : formatFallback(saved));
  return 0;
}

function formatFallback(config) {
  if (!config.fallback.length) {
    return 'No automatic fallback is configured.\n\nRun:\n\n  carryforward setup\n\nor:\n\n  carryforward fallback set <target> <target> ...\n';
  }
  const lines = config.fallback.map((target, index) => `${index + 1}. ${target}`);
  return `${lines.join('\n')}\n`;
}

function parseNext(argv) {
  const attempted = [];
  const runtime = [];
  let json = false;
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--attempted' || arg === '--rate-limited' || arg === '--profile-failed') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) return { error: `${arg} needs a target` };
      i += 1;
      if (arg === '--attempted') attempted.push(value);
      if (arg === '--rate-limited') runtime.push({ target: value, kind: 'rate-limit', current: true });
      if (arg === '--profile-failed') runtime.push({ target: value, kind: 'profile', current: true });
      continue;
    }
    if (arg.startsWith('--')) return { error: `Unknown argument: ${arg}` };
    positional.push(arg);
  }
  if (positional.length !== 1) return { error: 'Usage: carryforward next <target>' };
  return { json, attempted, runtime, target: positional[0] };
}

export async function runNext(argv, options = {}) {
  const { stdout, stderr } = streams(options);
  const parsed = parseNext(argv);
  if (parsed.help) {
    stdout.write(NEXT_HELP);
    return 0;
  }
  if (parsed.error) {
    stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const agents = agentsOf(options);
  const currentProfile = profileByTarget(agents, parsed.target);
  if (!currentProfile) {
    stderr.write(`Unknown target '${canonicalTargetId(parsed.target)}'.\n`);
    return 1;
  }
  let saved;
  try {
    saved = readFallback(options);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 1;
  }
  const order = saved.fallback;
  const attempted = parsed.attempted.map((target) => canonicalTargetId(target));
  const runtime = parsed.runtime.map((item) => ({ ...item, target: canonicalTargetId(item.target) }));
  const needed = [];
  for (const target of [currentProfile.target, ...order, ...attempted]) {
    if (!needed.includes(target)) needed.push(target);
  }
  const profiles = needed.map((target) => profileByTarget(agents, target) || {
    target,
    agent: null,
    handoff: { destination: false },
  });
  const identities = {};
  const measurable = profiles.filter((profile) => profile.launch?.command && profile.configPath);
  const usage = measurable.length
    ? await collectMany(measurable, {
      ...(options.deps || {}),
      captureIdentity(target, accountId) {
        identities[target] = accountId;
      },
    })
    : [];
  const plan = planFailover({
    current: currentProfile.target,
    order,
    attempted,
    profiles,
    usage,
    identities,
    runtime,
  });
  stdout.write(parsed.json ? formatPlanJson(plan) : formatPlan(plan));
  return 0;
}
