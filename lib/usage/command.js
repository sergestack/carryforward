import { discoverAgents } from '../agents/registry.js';
import { canonicalTargetId, destinationProfiles, profileByTarget } from '../agents/targets.js';
import { machineProbe } from '../agents/probe.js';
import { formatUsage, formatUsageJson } from './format.js';
import { collectMany, collectUsage } from './registry.js';
import { unknownUsage } from './state.js';

const HELP = `carryforward usage — current capacity for discovered profiles

  carryforward usage
  carryforward usage --json
  carryforward usage codex:default
  carryforward usage codex:default --json

Information only. Unknown stays unknown. CarryForward does not switch agents
and does not read credential files.
`;

export async function runUsage(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(HELP);
    return 0;
  }
  const json = argv.includes('--json');
  const positional = argv.filter((arg) => arg !== '--json');
  if (positional.length > 1) {
    stderr.write(`Unknown argument: ${positional[1]}\n`);
    return 1;
  }
  const agents = options.agents || discoverAgents(options.probe || machineProbe());
  const deps = options.deps || {};
  let entries;
  if (positional.length === 1) {
    const profile = profileByTarget(agents, positional[0]);
    if (!profile) {
      stderr.write(`Unknown target '${canonicalTargetId(positional[0])}'.\n`);
      return 1;
    }
    entries = [await collectUsage(profile, deps)];
  } else {
    const profiles = destinationProfiles(agents);
    entries = profiles.length
      ? await collectMany(profiles, deps)
      : [unknownUsage(null, 'No handoff destinations discovered')];
  }
  stdout.write(json ? formatUsageJson(entries) : formatUsage(entries, options.now));
  return 0;
}
