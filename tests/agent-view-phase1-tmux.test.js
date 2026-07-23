// Integration test (skip-unless-tmux) for the Agent View Phase 1 tmux backend. A real tmux
// round-trip: av_capture_locator (the ACTUAL helper) runs inside a real pane and yields a
// locator; parsing it the way av_activate_locator does and running `select-pane` must focus
// that pane. The hermetic agentview tests only stub tmux, so this proves the format actually
// round-trips against real tmux. Skips without bash+tmux.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_agent-view-register.sh');
function have(cmd) { try { execFileSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } }
const skip = !have('bash') ? 'bash unavailable' : !have('tmux') ? 'tmux unavailable' : false;

test('capture in a real pane -> select-pane focuses it (tmux round-trip)', { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-tmux-'));
  const sock = path.join(tmp, 'sock');
  const loc = path.join(tmp, 'loc');
  const T = (...a) => execFileSync('tmux', ['-S', sock, ...a], { encoding: 'utf8' });
  try {
    // av_capture_locator reports tmux's ACTIVE pane. Run it as the sole pane's command
    // (bash -c, so no rc files interfere) and wait for it to finish BEFORE splitting — at
    // that instant there's one pane, so it deterministically captures it. tmux sets $TMUX
    // for the pane, so the helper takes its tmux path.
    const cap = `bash -c "source '${HELPER}'; av_capture_locator > '${loc}'; sleep 300"`;
    T('new-session', '-d', '-s', 'vsess', '-x', '200', '-y', '50', cap);
    execFileSync('bash', ['-c', 'for _ in $(seq 1 100); do [ -s "$0" ] && exit 0; sleep 0.05; done; exit 1', loc]);
    const locator = fs.readFileSync(loc, 'utf8');
    T('split-window', '-t', 'vsess', 'sleep 300');            // a 2nd pane, now the active one

    assert.match(locator, /^tmux:.*:vsess:%\d+$/, `well-formed tmux:<socket>:<session>:<pane> (got '${locator}')`);
    // Parse EXACTLY as av_activate_locator does: pane = after last ':', socket = drop :<session>.
    const rest = locator.slice(locator.indexOf(':') + 1);
    const pane = rest.slice(rest.lastIndexOf(':') + 1);
    const sockParsed = rest.slice(0, rest.lastIndexOf(':')).replace(/:[^:]*$/, '');
    assert.strictEqual(sockParsed, sock, 'socket parses back out of the locator');

    const firstPane = T('list-panes', '-t', 'vsess', '-F', '#{pane_id}').split('\n')[0];
    assert.strictEqual(pane, firstPane, 'captured id is the pane the command ran in');
    const activeBefore = T('display', '-p', '-F', '#{pane_id}').trim();
    assert.notStrictEqual(activeBefore, pane, 'the split parked focus on the OTHER pane');

    T('select-pane', '-t', pane);                             // the jump av_activate_locator performs
    const activeAfter = T('display', '-p', '-F', '#{pane_id}').trim();
    assert.strictEqual(activeAfter, pane, 'select-pane -t <captured id> focused the captured pane');
  } finally {
    try { execFileSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* server already gone */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
