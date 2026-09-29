const HEADERS = ['TARGET', 'AGENT', 'PROFILE', 'VERSION', 'STATUS'];

function cells(agent) {
  return [
    agent.target ?? '-',
    agent.displayName,
    agent.profile ?? '-',
    agent.version ?? '-',
    agent.status,
  ];
}

export function formatTable(agents) {
  const rows = agents.map(cells);
  const widths = HEADERS.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const line = (cols) => cols.map((col, index) => col.padEnd(widths[index])).join('  ').trimEnd();
  return [line(HEADERS), ...rows.map(line), ''].join('\n');
}

export function formatJson(agents) {
  return `${JSON.stringify({ agents }, null, 2)}\n`;
}

const TARGET_HEADERS = ['TARGET', 'SOURCE', 'DESTINATION', 'VERSION'];

export function formatTargets(agents) {
  const rows = agents
    .filter((agent) => agent.handoff?.destination)
    .map((agent) => [
      agent.target,
      agent.handoff.source ? 'yes' : 'no',
      'yes',
      agent.version ?? '-',
    ]);
  const widths = TARGET_HEADERS.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length), 1),
  );
  const line = (cols) => cols.map((col, index) => col.padEnd(widths[index])).join('  ').trimEnd();
  return [line(TARGET_HEADERS), ...rows.map(line), ''].join('\n');
}

export function formatTargetsJson(agents) {
  const targets = agents.filter((agent) => agent.handoff?.destination).map((agent) => ({
    target: agent.target,
    agent: agent.agent,
    profile: agent.profile,
    source: agent.handoff.source,
    destination: true,
    executablePath: agent.executablePath,
    version: agent.version,
    configPath: agent.configPath,
    sessionPath: agent.sessionPath,
    launch: agent.launch,
  }));
  return `${JSON.stringify({ targets }, null, 2)}\n`;
}
