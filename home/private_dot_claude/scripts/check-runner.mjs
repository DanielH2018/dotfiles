#!/usr/bin/env node
// check-runner.mjs — deterministic acceptance-check grader (no LLM judgment).
//
// Ported from the "frozen checks" pattern (github.com/DanMcInerney/architect-loop):
// author falsifiable acceptance checks, commit them to git BEFORE any agent touches
// code (so the target can't be gamed), then grade them with a plain script instead of
// letting a model self-assess. This is that grader.
//
// Usage:
//   node check-runner.mjs <checks-file> [--frozen]
//
// Checks-file format — one falsifiable check per line; `#` comments and blank lines
// are ignored:
//   - RUN: `command` -> exit:0
//   - RUN: `command` -> match:"literal substring"
//   - RUN: `command` -> exit:0 match:"literal substring"
//
// Grading:
//   exit:N   command's exit code must equal N
//   match:"" combined stdout+stderr must CONTAIN this literal substring (never a regex)
//   A check passes only if every condition on its line holds. Commands run via `bash -c`.
//
// --frozen: before running, assert the checks file is git-tracked with no uncommitted
//   changes — proof the checks weren't edited to fit the result. Any drift => exit 2.
//
// Exit codes (typed, so callers branch on structure not prose):
//   0  all checks passed
//   1  at least one check failed
//   2  --frozen drift (checks file untracked or modified since commit)
//   3  usage / parse error / no runnable checks

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const OK = 0, FAIL = 1, DRIFT = 2, ERROR = 3;

function die(code, msg) {
  process.stderr.write(`check-runner: ${msg}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
const frozen = args.includes('--frozen');
const file = args.find((a) => !a.startsWith('--'));
if (!file) die(ERROR, 'usage: node check-runner.mjs <checks-file> [--frozen]');

let raw;
try {
  raw = readFileSync(file, 'utf8');
} catch {
  die(ERROR, `cannot read checks file: ${file}`);
}

if (frozen) {
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', file]);
  if (tracked.status !== 0) {
    die(DRIFT, `--frozen: ${file} is not committed to git (freeze it before dispatch)`);
  }
  const dirty = spawnSync('git', ['status', '--porcelain', '--', file], { encoding: 'utf8' });
  if ((dirty.stdout || '').trim()) {
    die(DRIFT, `--frozen: ${file} has uncommitted changes — a frozen check was modified`);
  }
}

// Parse: `- RUN: `cmd` -> spec`
const checks = [];
raw.split(/\r?\n/).forEach((line, i) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const m = trimmed.match(/^-\s*RUN:\s*`(.+?)`\s*->\s*(.+)$/);
  if (!m) die(ERROR, `line ${i + 1}: malformed check (expected "- RUN: \`cmd\` -> exit:N|match:\\"..\\"")`);
  const [, cmd, spec] = m;
  const exitM = spec.match(/exit:\s*(\d+)/);
  const matchM = spec.match(/match:\s*"([^"]*)"/);
  if (!exitM && !matchM) die(ERROR, `line ${i + 1}: no condition (need exit:N and/or match:"..")`);
  checks.push({
    cmd,
    exit: exitM ? Number(exitM[1]) : null,
    match: matchM ? matchM[1] : null,
  });
});

if (checks.length === 0) die(ERROR, 'no runnable checks found');

let failed = 0;
const rows = [];
for (const c of checks) {
  const r = spawnSync('bash', ['-c', c.cmd], { encoding: 'utf8' });
  const code = r.status ?? (r.error ? 127 : 0);
  const out = (r.stdout || '') + (r.stderr || '');
  const reasons = [];
  if (c.exit !== null && code !== c.exit) reasons.push(`exit ${code}≠${c.exit}`);
  if (c.match !== null && !out.includes(c.match)) reasons.push(`missing "${c.match}"`);
  const pass = reasons.length === 0;
  if (!pass) failed++;
  rows.push({ pass, cmd: c.cmd, why: reasons.join(', ') });
}

for (const row of rows) {
  const tag = row.pass ? 'PASS' : 'FAIL';
  process.stdout.write(`${tag}  ${row.cmd}${row.why ? `   (${row.why})` : ''}\n`);
}
process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
process.exit(failed === 0 ? OK : FAIL);
