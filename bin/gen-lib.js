'use strict';
// Shared plumbing for the bin/gen-* generators: splicing a rendered block into the slot a
// file declares, and the regenerate-and-diff report behind each generator's `--check`.
//
// gen-hooks, gen-lint-files and the since-deleted gen-skill-router each carried their own
// copy of both (#563).
// The copies had already drifted apart in how they reported a missing marker, and a fix to
// one never reached the other two.
//
// No fs access lives here except process output in reportCheck. The splice is a total
// function of its arguments, like the rest of the *-lib.js files.

// Replace the lines strictly between the one line matching `begin.test` and the one line
// matching `end.test`, keeping both marker lines and everything outside them.
//
// The markers are predicates rather than strings so a generator can match its own syntax,
// such as the chezmoi `{{/* */}}` comment in settings.base.json.
// `render(beginLine)` receives the begin marker's line, which gen-hooks reads for its
// indentation, and returns the new interior as one string.
//
// Throws when either marker is missing or doubled, or when the end marker comes first. The
// generator fills the slot the file declares; it does not invent where the slot goes.
//
//   label     the generator name, which prefixes every error
//   begin/end { test(line) -> bool, name: '<marker as the error prints it>' }
//   where     what the file is called in the error ('the template')
//   hint      an optional sentence appended to the missing-marker error
function spliceBetween(text, { label, begin, end, where, hint }, render) {
  const lines = text.split('\n');
  const begins = [];
  const ends = [];
  lines.forEach((l, i) => {
    if (begin.test(l)) begins.push(i);
    if (end.test(l)) ends.push(i);
  });
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(
      `${label}: expected exactly one ${begin.name} and one ${end.name} marker in ${where}, `
      + `found ${begins.length} and ${ends.length}.${hint ? ` ${hint}` : ''}`,
    );
  }
  if (ends[0] < begins[0]) throw new Error(`${label}: end marker appears before begin marker.`);
  const block = render(lines[begins[0]]);
  return [...lines.slice(0, begins[0] + 1), block, ...lines.slice(ends[0])].join('\n');
}

// The first line on which two texts differ, 1-based, or null when they are equal.
function firstDiffLine(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const n = Math.max(al.length, bl.length);
  for (let i = 0; i < n; i += 1) {
    if (al[i] !== bl[i]) {
      return { lineNo: i + 1, expected: al[i] ?? '(end of file)', got: bl[i] ?? '(end of file)' };
    }
  }
  return null;
}

// The `--check` verdict for one generated file. Prints the up-to-date line on stdout, or the
// out-of-date line plus the first differing line on stderr, and returns whether the file was
// up to date. The caller decides the exit code, because gen-lint-files checks two files
// before exiting.
//
//   tool      the generator name, as in `bin/<tool>`
//   rel       the checked file, relative to the repo root
//   summary   optional, printed in parentheses after "is up to date"
function reportCheck({ tool, rel, summary }, generated, committed) {
  if (generated === committed) {
    process.stdout.write(`${tool} --check: ${rel} is up to date${summary ? ` (${summary})` : ''}.\n`);
    return true;
  }
  const diff = firstDiffLine(generated, committed);
  process.stderr.write(`${tool} --check: ${rel} is out of date. Run \`bin/${tool}\` and commit the result.\n`);
  if (diff) {
    process.stderr.write(`  first difference at line ${diff.lineNo}:\n`);
    process.stderr.write(`    generated: ${diff.expected}\n`);
    process.stderr.write(`    committed: ${diff.got}\n`);
  }
  return false;
}

module.exports = { spliceBetween, firstDiffLine, reportCheck };
