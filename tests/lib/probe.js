// One way to ask whether a tool is installed, and one way to turn the answer into a skip.
//
// Seventy-eight test files opened with their own copy of the same probe -- `let toolsOk = true;
// try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk =
// false; }` -- in a dozen spellings, and most of them a `have(cmd)` wrapper around it as well.
// This is that, once.
//
// have(cmd) -> true when `command -v cmd` succeeds under bash. It probes bash as well as cmd,
//   which is what every inline copy did, and it is what a suite that then drives its script
//   through bash needs. Memoised per process: node runs each test file in its own process, so
//   the cache spans one file, and the same tool asked for twice costs one subprocess.
//
// skipUnless(...cmds) -> false when every tool is present, else '<missing> unavailable', joined
//   with '/' when more than one is missing. Use as `const skip = skipUnless('bash', 'jq')`, the
//   shape node:test's `{ skip }` option takes. Where the copies said 'bash/jq unavailable'
//   whatever was missing, this names what is.
//
// What this does not do: it does not run the tool. A `--version` probe also catches a binary
// that is on PATH and broken; nothing in this suite has met one, so presence is the check.
// A probe with a real predicate -- python3 >= 3.10, `import tomllib`, a luac fallback chain --
// stays in the file that needs it.
const { execFileSync } = require('node:child_process');

const memo = new Map();

function have(cmd) {
  if (!memo.has(cmd)) {
    let ok;
    try { execFileSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); ok = true; } catch { ok = false; }
    memo.set(cmd, ok);
  }
  return memo.get(cmd);
}

function skipUnless(...cmds) {
  const missing = cmds.filter((c) => !have(c));
  return missing.length ? `${missing.join('/')} unavailable` : false;
}

module.exports = { have, skipUnless };
