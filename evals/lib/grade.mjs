// Pure decision function: combine an invocation result, an assertion result,
// and (optionally) a judge result into a single run outcome.
//
// needsJudge=false is for a case with no `rubric` — one whose pass/fail is fully
// expressible as regex (no emojis, a file:line-shaped reference, a markdown link vs. a
// raw path), where a live model-judge call would just be a second read of the same
// invocation text a regex already decided. Defaults true so every existing rubric-bearing
// case (rules-sentence-clarity, the skill/agent cases) is unaffected — assertion pass
// alone has never been sufficient for those, and still isn't.
export function gradeFromParts({ invocation, assertion, judgeResult, needsJudge = true }) {
  if (!invocation || invocation.status !== 'ok') {
    return { status: 'infra_error', reason: invocation?.reason ?? 'no invocation' };
  }
  if (!assertion.pass) {
    return { status: 'ok', pass: false, text: invocation.text, failures: assertion.failures };
  }
  if (!needsJudge) {
    return { status: 'ok', pass: true, text: invocation.text };
  }
  if (!judgeResult || judgeResult.status !== 'ok') {
    return { status: 'infra_error', reason: judgeResult?.reason ?? 'no judge result', text: invocation.text };
  }
  return { status: 'ok', pass: judgeResult.verdict.pass, text: invocation.text, judgeReason: judgeResult.verdict.reason };
}
