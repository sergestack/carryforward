function line(widths, cols) {
  return cols.map((col, index) => String(col).padEnd(widths[index])).join('  ').trimEnd();
}

export function formatPlan(plan) {
  const next = plan.next || 'none';
  const showPool = plan.candidates.some((candidate) => candidate.pool);
  const headers = showPool
    ? ['TARGET', 'STATE', 'POOL', 'ELIGIBLE', 'REASON']
    : ['TARGET', 'STATE', 'ELIGIBLE', 'REASON'];
  const rows = plan.candidates.map((candidate) => {
    const eligible = candidate.eligible ? 'yes' : 'no';
    return showPool
      ? [candidate.target, candidate.state, candidate.pool || '-', eligible, candidate.reason]
      : [candidate.target, candidate.state, eligible, candidate.reason];
  });
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length), 1));
  const body = rows.length ? rows.map((row) => line(widths, row)) : ['(no fallback configured)'];
  return [`NEXT  ${next}`, '', line(widths, headers), ...body, ''].join('\n');
}

export function formatPlanJson(plan) {
  return `${JSON.stringify({
    current: plan.current,
    next: plan.next,
    candidates: plan.candidates.map((candidate) => {
      const row = {
        target: candidate.target,
        state: candidate.state,
        eligible: candidate.eligible,
        reason: candidate.reason,
      };
      if (candidate.pool) row.pool = candidate.pool;
      return row;
    }),
  }, null, 2)}\n`;
}
