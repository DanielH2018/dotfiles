// Pure decision function: combine an invocation result, an assertion result,
// and (optionally) a judge result into a single run outcome.
export function gradeFromParts({ invocation, assertion, judgeResult }) {
  if (!invocation || invocation.status !== 'ok') {
    return { status: 'infra_error', reason: invocation?.reason ?? 'no invocation' };
  }
  if (!assertion.pass) {
    return { status: 'ok', pass: false, text: invocation.text, failures: assertion.failures };
  }
  if (!judgeResult || judgeResult.status !== 'ok') {
    return { status: 'infra_error', reason: judgeResult?.reason ?? 'no judge result', text: invocation.text };
  }
  return { status: 'ok', pass: judgeResult.verdict.pass, text: invocation.text, judgeReason: judgeResult.verdict.reason };
}
