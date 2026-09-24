#!/usr/bin/env node
'use strict';
// embed.js: copy migration_gate.py into the heredoc of .github/workflows/migration-gate.yml.
//
// The reusable workflow runs an embedded copy of the script rather than checking dotfiles
// out, so that a caller's `uses: ...migration-gate.yml@<sha>` pins the code that runs (the
// workflow header has the reasoning). The script stays a real file so the unit tests in
// tests/migration-gate.test.js can run it; this keeps the two identical.
//
// Usage:
//   node .github/migration-gate/embed.js           rewrite the workflow's embedded copy
//   node .github/migration-gate/embed.js --check   exit 1 when the copy has drifted
//
// The slot is the lines strictly between `cat > "$gate" <<'MIGRATION_GATE_PY'` and the
// closing `MIGRATION_GATE_PY`. Every non-empty script line is indented to the opener's
// column, which the YAML block scalar strips again, so the runner writes the script's
// exact bytes. An empty line stays empty: YAML reads it as an empty line of the block.

const fs = require('node:fs');
const path = require('node:path');
const { spliceBetween, firstDiffLine } = require('../../bin/gen-lib.js');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(__dirname, 'migration_gate.py');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'migration-gate.yml');
const TAG = 'MIGRATION_GATE_PY';

function render(workflowText, scriptText) {
  if (scriptText.split('\n').some((l) => l.trim() === TAG)) {
    throw new Error(`embed.js: the script contains a line reading ${TAG}, which would end the heredoc early`);
  }
  return spliceBetween(workflowText, {
    label: 'embed.js',
    begin: { test: (l) => l.trimEnd().endsWith(`<<'${TAG}'`), name: `<<'${TAG}'` },
    end: { test: (l) => l.trim() === TAG, name: TAG },
    where: 'the workflow',
  }, (beginLine) => {
    const indent = beginLine.match(/^\s*/)[0];
    return scriptText.replace(/\n$/, '').split('\n')
      .map((l) => (l === '' ? '' : indent + l)).join('\n');
  });
}

function main(argv) {
  const committed = fs.readFileSync(WORKFLOW, 'utf8');
  const generated = render(committed, fs.readFileSync(SCRIPT, 'utf8'));
  const rel = path.relative(REPO, WORKFLOW);
  if (!argv.includes('--check')) {
    if (generated !== committed) fs.writeFileSync(WORKFLOW, generated);
    process.stdout.write(`embed.js: wrote ${rel}\n`);
    return 0;
  }
  if (generated === committed) {
    process.stdout.write(`embed.js --check: ${rel} is up to date.\n`);
    return 0;
  }
  const diff = firstDiffLine(generated, committed);
  process.stderr.write(`embed.js --check: ${rel} is out of date. Run \`node .github/migration-gate/embed.js\` and commit the result.\n`);
  if (diff) {
    process.stderr.write(`  first difference at line ${diff.lineNo}:\n    generated: ${diff.expected}\n    committed: ${diff.got}\n`);
  }
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { render };
