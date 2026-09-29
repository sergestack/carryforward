import { formatJson, formatTable } from './format.js';
import { machineProbe } from './probe.js';
import { discoverAgents } from './registry.js';

const HELP = `carryforward agents — show coding agents visible on this machine

  carryforward agents
  carryforward agents --json

Reads PATH and known config locations. Does not log in, read credentials,
or switch agents. TARGET is the id used by handoff when that profile can
be launched. Run \`carryforward targets\` for destinations only.
`;

export async function runAgents(argv, options = {}) {
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
  const probe = options.probe || machineProbe();
  const agents = discoverAgents(probe);
  stdout.write(argv.includes('--json') ? formatJson(agents) : formatTable(agents));
  return 0;
}
