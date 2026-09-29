import fs from 'node:fs';
import { discoverAgents } from '../agents/registry.js';
import { machineProbe } from '../agents/probe.js';
import { readFallback, validateFallback } from '../policy/config.js';
import { collectMany } from '../usage/registry.js';
import { commandOnPath, nodeSatisfies, packageInfo } from '../runtime.js';
import { buildSetupPlan, failoverReady } from '../setup/plan.js';

const HELP = `carryforward doctor — check this install

  carryforward doctor

Checks Node, the CarryForward install, discovered agents, session directories,
lsof, fallback config, and whether automatic Codex failover is ready.
Optional agents and a missing lsof are warnings. Account identifiers
and environment values are not printed.
`;

const LSOF_WARNING = 'lsof was not found; automatic failover will not bind a Codex session by the open rollout file, and CarryForward will stop instead of guessing when more than one new session could match.';

function streams(options) {
  return {
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr,
  };
}

function sessionNote(profile) {
  if (profile.status !== 'detected') return null;
  if (!profile.sessionPath) {
    return profile.agent === 'codex' ? `${profile.target} has no session directory` : null;
  }
  try {
    fs.accessSync(profile.sessionPath, fs.constants.R_OK);
    return null;
  } catch {
    return `${profile.target} session directory is not readable`;
  }
}

async function usageState(codex, options) {
  if (options.usageError) return { ok: false, usage: [], identities: options.identities || {} };
  if (options.usage) {
    return {
      ok: options.usage.some((entry) => entry.freshness === 'live'),
      usage: options.usage,
      identities: options.identities || {},
    };
  }
  if (options.identities) return { ok: false, usage: [], identities: options.identities };
  if (!codex.length) return { ok: true, usage: [], identities: {} };
  const identities = {};
  try {
    const usage = await collectMany(codex, {
      ...(options.deps || {}),
      captureIdentity(target, accountId) { identities[target] = accountId; },
    });
    const live = usage.some((entry) => entry.freshness === 'live');
    return { ok: live, usage, identities };
  } catch {
    return { ok: false, usage: [], identities };
  }
}

export async function runDoctor(argv, options = {}) {
  const { stdout, stderr } = streams(options);
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(HELP);
    return 0;
  }
  if (argv.length) {
    stderr.write(`Unknown argument: ${argv[0]}\n`);
    return 1;
  }

  const checks = [];
  const warnings = [];
  const nodeVersion = options.nodeVersion || process.versions.node;
  if (nodeSatisfies(nodeVersion)) checks.push(['ok', 'Node.js', nodeVersion]);
  else {
    checks.push(['fail', 'Node.js', nodeVersion]);
    warnings.push(`Node.js ${nodeVersion} is older than 22.5.0. Install Node.js 22.5 or newer.`);
  }

  let info;
  try {
    info = options.packageInfo || packageInfo();
    checks.push(['ok', 'CarryForward', `${info.version}  ${info.root}`]);
  } catch {
    checks.push(['fail', 'CarryForward', 'unreadable']);
    warnings.push('CarryForward package metadata could not be read.');
    info = null;
  }

  const agents = options.agents || discoverAgents(options.probe || machineProbe());
  const detected = agents.filter((profile) => profile.status === 'detected');
  const names = [...new Set(detected.map((profile) => profile.displayName || profile.agent))];
  if (names.length) checks.push(['ok', 'Agents', names.join(', ')]);
  else {
    checks.push(['warn', 'Agents', 'none found']);
    warnings.push('No supported agents were found.');
  }

  const sessionProblems = agents.map(sessionNote).filter(Boolean);
  if (sessionProblems.length) {
    checks.push(['warn', 'Sessions', 'check']);
    warnings.push(...sessionProblems);
  } else checks.push(['ok', 'Sessions', 'readable']);

  const exists = options.commandExists || ((name) => commandOnPath(name, options.env || process.env));
  if (exists('lsof')) checks.push(['ok', 'lsof', 'found']);
  else {
    checks.push(['warn', 'lsof', 'missing']);
    warnings.push(LSOF_WARNING);
  }

  let saved = null;
  try {
    saved = readFallback(options);
    if (saved.fallback.length) checks.push(['ok', 'Config', 'version 1']);
    else {
      checks.push(['warn', 'Config', 'missing']);
      warnings.push('Automatic fallback is not configured. Run carryforward setup.');
    }
  } catch (err) {
    checks.push(['fail', 'Config', 'invalid']);
    warnings.push(err.message);
  }

  let fallbackOk = false;
  if (saved?.fallback.length) {
    const validated = validateFallback(saved.fallback, agents);
    if (validated.ok) {
      fallbackOk = true;
      checks.push(['ok', 'Fallback', validated.fallback.join(' → ')]);
    } else {
      checks.push(['fail', 'Fallback', 'invalid']);
      warnings.push(...validated.errors);
    }
  } else if (saved) checks.push(['warn', 'Fallback', 'not configured']);

  const codex = agents.filter((profile) => (
    profile.agent === 'codex' && profile.status === 'detected' && profile.handoff?.destination && profile.launch?.command
  ));
  const usage = await usageState(codex, options);
  if (!codex.length) {
    checks.push(['warn', 'Codex usage', 'no Codex profile']);
    warnings.push('No Codex profile was found. Automatic quota failover needs Codex.');
  } else if (!usage.ok) {
    checks.push(['warn', 'Codex usage', 'unavailable']);
    warnings.push('Live Codex usage could not be read. Automatic failover stays unavailable until a profile reports live quota.');
  } else checks.push(['ok', 'Codex usage', 'live']);

  const identities = usage.identities || options.identities || {};
  const plan = buildSetupPlan(agents, identities);
  const ready = saved && fallbackOk ? failoverReady(saved.fallback, plan.groups) : { ready: false, reason: '' };
  if (ready.ready) checks.push(['ok', 'Auto-failover', 'ready']);
  else {
    checks.push(['warn', 'Auto-failover', 'not ready']);
    if (codex.length && plan.groups.length < 2 && !plan.missing) {
      warnings.push('Automatic Codex failover requires another independent Codex account.');
    } else if (plan.missing && plan.groups.length < 2 && codex.length) {
      warnings.push('Codex quota pools could not be verified.');
    }
  }

  const secretValues = Object.values(identities).filter((id) => typeof id === 'string' && id);
  const width = Math.max(...checks.map((row) => row[1].length), 8);
  const lines = ['CarryForward doctor', ''];
  for (const [level, name, detail] of checks) {
    lines.push(`${level.padEnd(6)}${name.padEnd(width + 2)}${detail}`);
  }
  if (warnings.length) {
    lines.push('', 'Warnings:');
    for (const warning of warnings) lines.push(`  ${warning}`);
  }
  const rendered = `${lines.join('\n')}\n`;
  if (secretValues.some((id) => rendered.includes(id))) {
    stderr.write('CarryForward: refused to print an account identifier.\n');
    return 1;
  }
  stdout.write(rendered);
  return checks.some((row) => row[0] === 'fail') ? 1 : 0;
}
