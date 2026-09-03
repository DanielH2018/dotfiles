// One way to read a constant's value out of a shell script from a test.
//
// A test that restates a number the script already defines drifts the moment the script
// changes, and the drift is usually silent rather than red: install-tmux.test.js stubs
// `echo "tmux 3.7b"` to make the script take its already-current branch, so bumping
// TMUX_VERSION would leave the stub exercising the upgrade path instead -- still green,
// testing the wrong thing. The rule this helper serves is narrow: derive the test's
// INPUTS from the script, keep its expected OUTPUTS literal. An expectation computed from
// the same formula the script uses asserts nothing, so it catches nothing.
//
// Most of these scripts cannot be sourced to ask bash directly -- they execute on load,
// and several are .tmpl files that are not valid shell until chezmoi renders them -- so
// the assignment line is extracted and evaluated on its own. That is a parse, so it is a
// loud one: a name that is missing, or assigned more than once, throws rather than quietly
// yielding a default that would make the caller's test vacuous. The duplicate check is not
// hypothetical -- play-sound.sh carried its default volume in two places, where editing one
// would have made invalid input play at a different volume from the default.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

// Matches `NAME=value`, `NAME="value"`, and `NAME="${OVERRIDE:-value}"`, at any indent.
const assignment = (name) => new RegExp(`^\\s*(?:readonly\\s+|export\\s+|local\\s+)?${name}=(.*)$`);

function shConst(file, name) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => !l.trimStart().startsWith('#'));
  const re = assignment(name);
  const hits = lines.filter((l) => re.test(l));
  if (hits.length === 0) {
    throw new Error(`${file} assigns no ${name} -- if it was renamed, update this test with it`);
  }
  if (hits.length > 1) {
    // Two assignments means two homes for one value, which is the drift this helper exists
    // to prevent. Refuse to guess which one the caller meant.
    throw new Error(`${file} assigns ${name} ${hits.length} times; it needs a single home:\n${hits.join('\n')}`);
  }
  const rhs = hits[0].match(re)[1].trim();
  // Evaluate the right-hand side alone in an EMPTY environment, so `${X:-50}` yields the
  // default rather than whatever the test runner happens to have exported for X.
  //
  // `env` is resolved through PATH rather than named as /usr/bin/env: node on Windows is a
  // native binary, so an absolute POSIX path is not a path it can spawn and every caller of
  // this helper threw ENOENT there. Git Bash puts its own env.exe on PATH, and that one does
  // resolve the /bin/bash below. On Linux and macOS this is the same binary either way.
  return execFileSync('env', ['-i', '/bin/bash', '-c', `printf '%s' ${rhs}`], {
    encoding: 'utf8',
  });
}

// The same value as a number, for the callers that compute a test input from it.
function shConstInt(file, name) {
  const raw = shConst(file, name);
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} in ${file} is not an integer: ${JSON.stringify(raw)}`);
  return n;
}

module.exports = { shConst, shConstInt };
