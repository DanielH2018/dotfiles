export function classifyRun(j) {
  if (!j || typeof j !== 'object') {
    return { status: 'infra_error', text: null, reason: 'no result JSON' };
  }
  if (j.is_error === false && j.subtype === 'success' && typeof j.result === 'string') {
    return { status: 'ok', text: j.result, reason: null };
  }
  const reason = j.is_error
    ? `is_error: ${JSON.stringify(j.result ?? j.api_error_status ?? 'unknown')}`
    : `subtype: ${j.subtype ?? 'missing'}`;
  return { status: 'infra_error', text: null, reason };
}
