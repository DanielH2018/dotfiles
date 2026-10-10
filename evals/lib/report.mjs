export function parseThreshold(str) {
  if (str === 'all') return { kind: 'all' };
  const m = /^rate>=(\d+)\/(\d+)$/.exec(str || '');
  if (!m) throw new Error(`bad threshold: ${str}`);
  return { kind: 'rate', num: Number(m[1]), den: Number(m[2]) };
}

export function aggregateCase(caseDef, runs) {
  const k = caseDef.k ?? runs.length;
  const healthyRuns = runs.filter(r => r.status === 'ok');
  const healthy = healthyRuns.length;
  const passes = healthyRuns.filter(r => r.pass === true).length;
  const passRate = healthy ? passes / healthy : 0;
  const allPass = healthy > 0 && passes === healthy;
  const th = parseThreshold(caseDef.threshold);
  const thresholdMet = th.kind === 'all' ? allPass : passRate >= th.num / th.den;

  let status;
  if (healthy < Math.ceil(k / 2)) status = 'INCONCLUSIVE';
  else status = thresholdMet ? 'PASS' : 'FAIL';

  // Every run is billed, infra errors included, so cost sums over all runs, not healthy ones.
  const costUsd = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  return { id: caseDef.id, k, healthy, passes, passRate, allPass, thresholdMet, status, costUsd };
}

// The sweep's total. The --json report stays a bare array of case reports, so a consumer
// recomputes this same sum from each entry's costUsd.
export function sweepCostUsd(caseReports) {
  return caseReports.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
}

export function overallExitCode(caseReports) {
  return caseReports.every(r => r.status === 'PASS') ? 0 : 1;
}

export function formatReport(caseReports) {
  const line = r =>
    `${r.status.padEnd(12)} ${r.id}  (${r.passes}/${r.healthy} healthy pass, rate ${(r.passRate * 100).toFixed(0)}%, $${r.costUsd.toFixed(4)})`;
  return caseReports.map(line).join('\n');
}
