import { canonicalTargetId } from '../agents/targets.js';
import { planFailover } from '../policy/plan.js';

function setState(run, next) {
  run.state = next;
  run.states.push(next);
  if (run.verbose) run.log(`CarryForward: state ${next}`);
}

function finish(run, code) {
  return {
    state: run.state,
    states: run.states,
    attempted: [...run.attempted],
    launches: run.launches,
    code,
  };
}

export async function supervise(input) {
  const run = {
    state: 'starting',
    states: [],
    attempted: [],
    launches: [],
    verbose: Boolean(input.verbose),
    log: input.log || (() => {}),
  };
  const userStop = input.userStop || { requested: false };
  let target = canonicalTargetId(input.target);
  let launchPlan = null;

  while (true) {
    if (userStop.requested) {
      setState(run, 'user_exit');
      return finish(run, 130);
    }
    setState(run, launchPlan ? 'starting_next' : 'starting');
    const profile = input.profiles.find((item) => item.target === target);
    const startedAt = input.deps.now ? input.deps.now() : Date.now();
    let handle;
    try {
      handle = await input.deps.launch(profile, launchPlan, { cwd: input.cwd });
    } catch {
      setState(run, 'launch_failed');
      run.log(`CarryForward: ${target} failed to launch.`);
      return finish(run, 1);
    }
    run.launches.push(target);
    setState(run, 'running');
    const outcome = await input.deps.wait(handle, {
      profile,
      cwd: input.cwd,
      startedAt,
      userStop,
    });
    if (outcome.type === 'user_stop' || userStop.requested) {
      await input.deps.stop(handle);
      setState(run, 'user_exit');
      return finish(run, 130);
    }
    if (outcome.type === 'exit') {
      if (outcome.signal === 'SIGINT' || outcome.signal === 'SIGTERM') {
        setState(run, 'user_exit');
        return finish(run, 130);
      }
      setState(run, 'completed');
      return finish(run, outcome.code ?? (outcome.signal ? 1 : 0));
    }
    if (outcome.type === 'ambiguous') {
      run.log('CarryForward: automatic failover stopped: active session could not be uniquely identified');
      run.log('The current session was left running. CarryForward does not guess which session is active.');
      setState(run, 'ambiguous_session');
      await input.deps.waitExit(handle);
      return finish(run, 1);
    }
    if (outcome.type !== 'quota') {
      setState(run, 'completed');
      return finish(run, 0);
    }

    setState(run, 'limit_confirmed');
    if (!run.attempted.includes(target)) run.attempted.push(target);
    setState(run, 'planning');
    const evidence = await input.deps.usage(input.profiles);
    const plan = planFailover({
      current: target,
      order: input.order,
      attempted: run.attempted,
      profiles: input.profiles,
      usage: evidence.usage,
      identities: evidence.identities,
      runtime: [{ target, kind: 'rate-limit', current: true }],
      unknownGroupPolicy: 'skip',
    });
    if (run.verbose) {
      const pool = plan.candidates.find((candidate) => candidate.target === target)?.pool;
      if (pool) run.log(`CarryForward: pool ${pool}`);
      run.log('CarryForward: runtime event usage_limit_exceeded');
      run.log(`CarryForward: bound session ${outcome.session.id}`);
      run.log(`CarryForward: next ${plan.next || 'none'}`);
    }
    if (!plan.next) {
      run.log('CarryForward: Codex quota reached.');
      run.log('No verified automatic fallback is available.');
      const others = (plan.candidates || []).filter((candidate) => candidate.target !== target);
      const unknown = others.some((candidate) => candidate.state === 'unknown' || /unknown/.test(candidate.reason || ''));
      run.log(unknown
        ? 'Unknown quota cannot be used automatically. Use a manual handoff.'
        : 'Another independent Codex quota pool is required before automatic failover can continue.');
      if (input.manualDestinations?.length) {
        run.log('Manual handoffs:');
        for (const id of input.manualDestinations) run.log(`  carryforward ${id}`);
      }
      setState(run, 'no_candidate');
      await input.deps.waitExit(handle);
      return finish(run, 1);
    }
    if (userStop.requested) {
      await input.deps.stop(handle);
      setState(run, 'user_exit');
      return finish(run, 130);
    }

    setState(run, 'building_handoff');
    let handoff;
    try {
      handoff = await input.deps.buildHandoff({
        sourceTarget: target,
        session: outcome.session,
        destination: plan.next,
      });
    } catch {
      handoff = { ok: false };
    }
    if (!handoff?.ok) {
      run.log(`CarryForward: ${target} reached its current quota.`);
      run.log('CarryForward: handoff failed, so the current session was left running.');
      setState(run, 'handoff_failed');
      await input.deps.waitExit(handle);
      return finish(run, 1);
    }
    if (run.verbose) run.log(`CarryForward: handoff bytes ${handoff.bytes}`);
    if (userStop.requested) {
      await input.deps.stop(handle);
      setState(run, 'user_exit');
      return finish(run, 130);
    }

    setState(run, 'stopping_source');
    let stopped;
    try {
      stopped = await input.deps.stop(handle);
    } catch {
      stopped = { stopped: false };
    }
    if (!stopped?.stopped) {
      run.log('CarryForward: the exhausted session could not be stopped, so no successor was launched.');
      setState(run, 'launch_failed');
      return finish(run, 1);
    }
    if (userStop.requested) {
      setState(run, 'user_exit');
      return finish(run, 130);
    }
    run.log(`CarryForward: ${target} reached its current quota.`);
    run.log(`CarryForward: continuing with ${plan.next}.`);
    target = plan.next;
    launchPlan = handoff.plan;
  }
}
