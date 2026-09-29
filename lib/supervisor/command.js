import os from 'node:os';
import path from 'node:path';
import { discoverAgents } from '../agents/registry.js';
import { machineProbe } from '../agents/probe.js';
import { destinationFailure, destinationProfiles, profileByTarget, resolveDestination } from '../agents/targets.js';
import { readFallback } from '../policy/config.js';
import { planFailover } from '../policy/plan.js';
import { collectMany } from '../usage/registry.js';
import { supervise } from './machine.js';
import { launchChild, restoreTerminal, stopOwnedChild } from './process.js';
import { waitForSupervisedEvent } from './watch.js';

const HELP = `carryforward run — supervise a Codex session and fail over on quota

  carryforward run <codex-target>
  carryforward run <codex-target> --verbose
  carryforward run <codex-target> --simulate-rate-limit

Only a Codex process started by this command is supervised.
carryforward <target> stays a manual handoff and does not opt in.
Direct codex launches are not monitored.
--simulate-rate-limit plans the switch and does not launch or stop anything.
`;

function streams(options) {
  return {
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr,
  };
}

function parseRun(argv) {
  let verbose = false;
  let simulate = false;
  const positional = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--verbose') { verbose = true; continue; }
    if (arg === '--simulate-rate-limit') { simulate = true; continue; }
    if (arg.startsWith('--')) return { error: `Unknown argument: ${arg}` };
    positional.push(arg);
  }
  if (positional.length !== 1) return { error: 'Usage: carryforward run <codex-target>' };
  return { verbose, simulate, target: positional[0] };
}

async function liveEvidence(profiles, deps) {
  const identities = {};
  const measurable = profiles.filter((profile) => profile.agent === 'codex' && profile.launch?.command && profile.configPath);
  const usage = measurable.length
    ? await collectMany(measurable, {
      ...(deps || {}),
      captureIdentity(target, accountId) { identities[target] = accountId; },
    })
    : [];
  return { usage, identities };
}

function manualDestinations(agents) {
  return destinationProfiles(agents)
    .filter((profile) => profile.agent !== 'codex')
    .map((profile) => profile.target);
}

export async function runSupervised(argv, options = {}) {
  const { stdout, stderr } = streams(options);
  const log = (line) => stdout.write(`${line}\n`);
  const parsed = parseRun(argv);
  if (parsed.help) {
    stdout.write(HELP);
    return 0;
  }
  if (parsed.error) {
    stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const agents = options.agents || discoverAgents(options.probe || machineProbe());
  const resolved = resolveDestination(agents, parsed.target);
  if (!resolved.ok) {
    stderr.write(`${destinationFailure(resolved, parsed.target)}\n`);
    return 1;
  }
  const current = resolved.profile;
  if (current.agent !== 'codex') {
    stderr.write(`${current.target} cannot be supervised. Automatic failover is Codex-only. Hand off manually with \`carryforward ${current.target}\`.\n`);
    return 1;
  }
  let saved;
  try {
    saved = options.order ? { fallback: options.order } : readFallback(options);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 1;
  }
  if (!options.order && saved.fallback.length === 0) {
    stderr.write('Automatic fallback is not configured.\n\nRun:\n\n  carryforward setup\n\nor:\n\n  carryforward fallback set ...\n');
    return 1;
  }
  const profiles = destinationProfiles(agents);
  if (parsed.simulate) {
    const evidence = await (options.deps?.usage
      ? options.deps.usage(profiles)
      : liveEvidence(profiles, options.deps));
    const plan = planFailover({
      current: current.target,
      order: saved.fallback,
      profiles,
      usage: evidence.usage,
      identities: evidence.identities,
      runtime: [{ target: current.target, kind: 'rate-limit', current: true }],
      unknownGroupPolicy: 'skip',
    });
    let handoff = null;
    if (options.boundSession && plan.next) {
      const build = options.deps?.buildHandoff;
      if (!build) {
        stderr.write('CarryForward: simulation has no handoff planner.\n');
        return 1;
      }
      handoff = await build({
        sourceTarget: current.target,
        session: options.boundSession,
        destination: plan.next,
      });
      if (!handoff?.ok) {
        stderr.write('CarryForward: simulation handoff failed. No process was launched.\n');
        return 1;
      }
    }
    const secretValues = Object.values(evidence.identities || {}).filter(Boolean);
    const rendered = JSON.stringify({ plan, handoff });
    if (secretValues.some((id) => rendered.includes(id))) {
      stderr.write('CarryForward: refused to print an account identifier.\n');
      return 1;
    }
    log('CarryForward: simulation only. No process was launched.');
    log(`CarryForward: ${current.target} would be treated as quota exhausted.`);
    log(`CarryForward: next ${plan.next || 'none'}`);
    for (const candidate of plan.candidates) {
      log(`${candidate.target}  ${candidate.state}  ${candidate.eligible ? 'yes' : 'no'}  ${candidate.reason}${candidate.pool ? `  ${candidate.pool}` : ''}`);
    }
    if (handoff?.plan) {
      log(`CarryForward: handoff session ${options.boundSession.id}`);
      log(`Launch executable: ${handoff.plan.binary || '(none)'}`);
      const home = handoff.plan.env?.CODEX_HOME;
      if (home) log(`CODEX_HOME: ${home}`);
    } else if (plan.next) {
      const destination = profileByTarget(agents, plan.next);
      log(`Launch executable: ${destination?.launch?.command || '(none)'}`);
      const home = destination?.launch?.env?.CODEX_HOME;
      if (home) log(`CODEX_HOME: ${home}`);
    } else if (manualDestinations(agents).length) {
      log('Manual handoffs:');
      for (const id of manualDestinations(agents)) log(`  carryforward ${id}`);
    }
    return 0;
  }

  const userStop = { requested: false };
  const onSignal = () => { userStop.requested = true; };
  if (options.signals !== false) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }
  try {
    const deps = options.deps || {};
    const result = await supervise({
      target: current.target,
      order: saved.fallback,
      profiles,
      manualDestinations: manualDestinations(agents),
      cwd: options.cwd || process.cwd(),
      verbose: parsed.verbose,
      userStop,
      log,
      deps: {
        now: deps.now || (() => Date.now()),
        async launch(profile, plan, ctx) {
          if (deps.launch) return deps.launch(profile, plan, ctx);
          const command = plan?.binary || profile.launch.command;
          const args = plan?.args || profile.launch?.args || [];
          const env = { ...process.env, ...(plan?.env || profile.launch?.env || {}) };
          return launchChild(command, args, { cwd: ctx.cwd, env, stdio: 'inherit' });
        },
        wait(handle, ctx) {
          if (deps.wait) return deps.wait(handle, ctx);
          return waitForSupervisedEvent({
            child: handle,
            sessionsDir: path.join(ctx.profile.configPath, 'sessions'),
            cwd: ctx.cwd,
            startedAt: ctx.startedAt,
            userStop: ctx.userStop,
          });
        },
        stop(handle) {
          return deps.stop ? deps.stop(handle) : stopOwnedChild(handle);
        },
        waitExit(handle) {
          if (deps.waitExit) return deps.waitExit(handle);
          return handle.finished;
        },
        usage(list) {
          return deps.usage ? deps.usage(list) : liveEvidence(list, deps);
        },
        buildHandoff(request) {
          if (!deps.buildHandoff) return { ok: false, error: 'handoff is unavailable' };
          return deps.buildHandoff(request);
        },
      },
    });
    return result.code;
  } finally {
    if (options.signals !== false) {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
    restoreTerminal();
  }
}

export function defaultCwd() {
  return process.cwd() || os.homedir();
}
