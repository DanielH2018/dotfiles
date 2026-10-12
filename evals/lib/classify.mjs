// costUsd is the call's `total_cost_usd`, carried on every outcome — a failed call is
// still billed. It is 0 when the field is absent (an exec or parse failure never reached
// the API). Hermetic calls run with --bare, which skips the OTEL exporter config, so this
// field is the only record of what a sweep cost.
//
// priced is false when the field is absent. A call killed at its timeout, or one whose
// output did not parse, lands here with costUsd 0 but may still have billed up to its
// --max-budget-usd, so the --max-total-usd cap charges such a call that ceiling instead.
export function classifyRun(j) {
  if (!j || typeof j !== 'object') {
    return { status: 'infra_error', text: null, reason: 'no result JSON', costUsd: 0, priced: false };
  }
  const priced = Number.isFinite(j.total_cost_usd);
  const costUsd = priced ? j.total_cost_usd : 0;
  if (j.is_error === false && j.subtype === 'success' && typeof j.result === 'string') {
    return { status: 'ok', text: j.result, reason: null, costUsd, priced };
  }
  const reason = j.is_error
    ? `is_error: ${JSON.stringify(j.result ?? j.api_error_status ?? 'unknown')}`
    : `subtype: ${j.subtype ?? 'missing'}`;
  return { status: 'infra_error', text: null, reason, costUsd, priced };
}
