import { formatTargets, formatTargetsJson } from './format.js';
import { machineProbe } from './probe.js';
import { discoverAgents } from './registry.js';

const HELP = `carryforward targets — profiles CarryForward can hand a session to

  carryforward targets
  carryforward targets --json

A target id is agent:profile, from discovery. Config-only and missing
tools are omitted. SOURCE says whether CarryForward can also read that profile's
sessions.
`;

export async function runTargets(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(HELP);
    return 0;
  }
  const unknown = argv.filter((arg) => arg !== '--json');
  if (unknown.length > 0) {
    stderr.write(`Unknown argument: ${unknown[0]}\n`);
    return 1;
  }
  const agents = options.agents || discoverAgents(options.probe || machineProbe());
  stdout.write(argv.includes('--json') ? formatTargetsJson(agents) : formatTargets(agents));
  return 0;
}
