// One way to run a script from a test and get back what it did.
//
// run(cmd, args, { cwd, env, input, timeout }) -> { stdout, stderr, code, signal }
//
// Every field is raw. `code` is the exit status as the OS reported it, null when a signal
// ended the child (and `signal` says which); `stdout` and `stderr` are the whole of each
// stream, on success as much as on failure. Nothing is trimmed, nothing is asserted, and a
// child that could not be started at all -- ENOENT, EACCES -- throws rather than reading as
// an exit code, because a test that wanted `code === 1` must not be satisfied by a script it
// never ran.
//
// Fourteen test files carried the same wrapper around execFileSync -- `try { const stdout =
// execFileSync(...); return { code: 0, stdout, stderr: '' }; } catch (e) { return { code:
// e.status, stdout: e.stdout || '', stderr: e.stderr || '' }; }` -- which is a spawnSync with
// the exit code recovered from the exception, and stderr thrown away whenever the exit code
// was 0. spawnSync returns all of it without the detour, so this is what those wrappers were
// reaching for, and this file is the only place it needs to be written.
//
// What this does not do: it does not merge the streams, resolve the command through a
// shell, or supply defaults for env (unset means the parent's, as with every child_process
// call). A wrapper that wants `out: (stdout + stderr).trim()` keeps doing that on top.
const { spawnSync } = require('node:child_process');

function run(cmd, args = [], { cwd, env, input, timeout } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, env, input, timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.error) throw r.error;
  return { stdout: r.stdout, stderr: r.stderr, code: r.status, signal: r.signal };
}

module.exports = { run };
