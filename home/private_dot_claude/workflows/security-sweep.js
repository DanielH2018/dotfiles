export const meta = {
  name: 'security-sweep',
  description: 'Parallel multi-dimension security review of changed code, with adversarial verification of each high/critical finding',
  phases: [
    { title: 'Scope', detail: 'determine changed files to review' },
    { title: 'Review', detail: 'one security-reviewer per security dimension' },
    { title: 'Verify', detail: 'adversarially refute each high/critical finding' },
  ],
}

// Usage:
//   /security-sweep                       -> reviews changed files vs origin/main...HEAD
//   /security-sweep on ref HEAD~1         -> pass {ref:"HEAD~1..HEAD"} as args
//   /security-sweep on paths [a.ts,b.ts]  -> pass {paths:[...]} to review an explicit set
// args (all optional): { ref?: string, paths?: string[] }

const DIMENSIONS = [
  { key: 'authz',       lens: 'authentication, authorization, session/token handling, RBAC enforcement (authorized vs merely authenticated)' },
  { key: 'crypto',      lens: 'cryptographic operations, key management/rotation, PAN/CVV handling, weak hashing (MD5/SHA1)' },
  { key: 'exposure',    lens: 'PII/PAN/CVV in logs/errors/responses, SQL injection (incl. dynamic SQL), cross-tenant data leakage, data masking' },
  { key: 'input',       lens: 'input validation, ISO 8583 field parsing & bounds, malformed-message handling, TLS/cert validation' },
  { key: 'secrets',     lens: 'hardcoded secrets/credentials/API keys, secret-manager vs env usage, config-driven security drift' },
  { key: 'concurrency', lens: 'double-spend in auth paths, TOCTOU in balance/limit checks, lock ordering, race conditions' },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          reachability: { type: 'string', enum: ['external-input', 'internal-only', 'unknown'] },
          file: { type: 'string' },
          line: { type: 'string' },
          title: { type: 'string' },
          detail: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'confidence', 'reachability', 'file', 'title', 'detail'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    real: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['real', 'reasoning'],
}

const ref = (args && args.ref) ? args.ref : 'origin/main...HEAD'

// Scope: an explicit paths arg skips the scope agent entirely (also lets a caller
// pass [] to dry-run/validate the workflow with zero agents).
phase('Scope')
let files
if (args && Array.isArray(args.paths)) {
  files = args.paths
} else {
  const scope = await agent(
    `List the source files changed in this branch for security review. Run \`git diff --name-only ${ref}\`; if that errors or is empty, try \`git diff --name-only HEAD~1\`. Return only real source files — exclude lockfiles, generated code, vendored deps, and docs.`,
    { label: 'scope', phase: 'Scope', schema: { type: 'object', additionalProperties: false, properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] } }
  )
  files = (scope && scope.files) || []
}

log(`Security sweep: ${files.length} file(s) in scope across ${DIMENSIONS.length} dimensions`)
if (files.length === 0) {
  return { confirmed: [], filesReviewed: 0, note: 'No files in scope — nothing to review.' }
}

const fileList = files.join('\n')

// Pipeline: each dimension reviews independently, then its high/critical findings are
// adversarially verified as soon as that dimension's review returns (no barrier).
const reviewed = await pipeline(
  DIMENSIONS,
  d => agent(
    `Security-review the changed files below, focusing ONLY on the "${d.key}" dimension: ${d.lens}.\n\nFiles:\n${fileList}\n\nRead each file and its diff vs ${ref}. Report EVERY finding, including theoretical issues in internal-only code paths — do not withhold anything at discovery time; a separate arbiter pass decides what to act on. For each finding give file, line, severity, an explicit confidence rating (HIGH/MEDIUM/LOW), reachability (whether the path takes external/untrusted input, or is internal-only), why it matters (PCI-DSS/SOC2/security impact), and a suggested fix.`,
    { label: `review:${d.key}`, phase: 'Review', agentType: 'general-purpose', schema: FINDINGS_SCHEMA }
  ),
  (review, d) => {
    const all = (review && review.findings) || []
    const toVerify = all.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH')
    const unverified = all.filter(f => !(f.severity === 'CRITICAL' || f.severity === 'HIGH'))
    return parallel([
      ...toVerify.map(f => () =>
        agent(
          `Adversarially verify this security finding — try to REFUTE it. Read the actual code at ${f.file}:${f.line || '?'} and decide whether it is a REAL, exploitable or compliance-violating issue, or a false positive. Default to real=false if uncertain, or if the code path takes no external/untrusted input.\n\n[${f.severity}] ${f.title}\n${f.detail}`,
          { label: `verify:${d.key}:${f.file}`, phase: 'Verify', agentType: 'general-purpose', schema: VERDICT_SCHEMA }
        ).then(v => ({ ...f, dimension: d.key, verdict: v }))
          .catch(e => ({ ...f, dimension: d.key, verdict: { real: false, reasoning: 'verification failed: ' + (e?.message || e) } }))
      ),
      ...unverified.map(f => () => Promise.resolve({ ...f, dimension: d.key, unverified: true })),
    ])
  }
)

const flatFindings = reviewed.flat().filter(Boolean)
const verified = flatFindings.filter(f => f.verdict)
const unverified = flatFindings.filter(f => f.unverified)

const confirmed = verified
  .filter(f => f.verdict.real)
  .sort((a, b) => (a.severity === 'CRITICAL' ? 0 : 1) - (b.severity === 'CRITICAL' ? 0 : 1))

const unverifiedBySeverity = unverified.reduce((acc, f) => {
  acc[f.severity] = (acc[f.severity] || 0) + 1
  return acc
}, {})
log(`Confirmed ${confirmed.length} high/critical finding(s) after adversarial verification; ${unverified.length} finding(s) skipped verification (${Object.entries(unverifiedBySeverity).map(([s, n]) => `${n} ${s}`).join(', ') || 'none'})`)

return {
  ref,
  filesReviewed: files.length,
  confirmedCount: confirmed.length,
  confirmed,
  unverifiedCount: unverified.length,
  unverified,
}
