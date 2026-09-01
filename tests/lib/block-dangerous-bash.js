// Harness for the block-dangerous-bash hook suites (tests/hooks/block-dangerous-bash*.test.js).
// Feeds a command through the ACTUAL hook on stdin and returns its deny / allow / ask decision.
// Offline and deterministic; `skip` is set when bash or jq is unavailable.
const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_block-dangerous-bash.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

// One bash per case, and the case lists in block-dangerous-bash-vectors.js are ~145 long: run them in lanes rather than
// end to end. The hook is a pure stdin->stdout decision with no shared state, so the only
// thing serial execution bought was ~10s of process-startup wait (this was the whole suite's
// slowest file). Failures still surface in list order — see `decide` below.
// In the source tree the library is `executable_cmdparse.sh`; chezmoi drops the prefix on
// apply, so the hook's default sibling path (`cmdparse.sh`) resolves only once deployed.
// Without this seam every case in the block-dangerous-bash suites ran with the source lookup FAILING, which
// collapses the hook's scan set to the whole-string SCAN alone — a configuration that never
// ships. The suite passed 145 cases against it and reported nothing, including the pinned
// newline test in block-dangerous-bash-normalization.test.js, which kept asserting a gap that the deployed hook no longer has.
// CMDPARSE and CMDPARSE_SHADOW are stripped rather than left unset for the reason spelled
// out in cmdparse-shadow.test.js: an inherited ambient value makes an off-by-default case
// pass for the wrong reason.
const HOOK_ENV = (() => {
  const e = { ...process.env, CMDPARSE_LIB: path.join(path.dirname(HOOK), 'executable_cmdparse.sh') };
  delete e.CMDPARSE_SHADOW;
  delete e.CMDPARSE;
  return e;
})();

function runHook(command, env = {}) {
  return new Promise((resolve) => {
    const p = spawn('bash', [HOOK], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...HOOK_ENV, ...env } });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(''));            // bash missing/unspawnable -> no decision
    p.on('close', () => resolve(out));
    p.stdin.on('error', () => {});               // hook may exit before reading all of stdin
    p.stdin.end(JSON.stringify({ tool_input: { command } }));
  });
}
function decision(stdout) {
  if (!stdout.trim()) return null;
  try { return JSON.parse(stdout).hookSpecificOutput.permissionDecision; } catch { return null; }
}
const LANES = Math.min(8, os.availableParallelism());
// Decisions for `commands`, indexed to match, so callers assert in list order.
async function decide(commands, env = {}) {
  const out = Array.from({ length: commands.length });
  let next = 0;
  await Promise.all(Array.from({ length: LANES }, async () => {
    while (next < commands.length) {
      const i = next++;
      out[i] = decision(await runHook(commands[i], env));
    }
  }));
  return out;
}

module.exports = { HOME, HOOK, skip, HOOK_ENV, runHook, decision, decide };
