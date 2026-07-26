// The Windows-side seams agentview reaches by ABSOLUTE path, in one place.
//
// A test that builds a temp HOME is not isolated. Three of agentview's inputs are
// absolute /mnt/c paths with no $HOME in them, so a temp HOME does not move them and
// a PATH stub cannot shadow them -- they are invoked by full path:
//
//   AGENT_VIEW_WINDIR      /mnt/c/Users/$USER/.claude/agent-view   (read AND pruned)
//   AGENT_VIEW_WEZTERM_WIN /mnt/c/Program Files/WezTerm/wezterm.exe
//   AGENT_VIEW_WIN_CLAUDE  /mnt/c/Users/$USER/.local/bin/claude.exe
//
// Left unpinned on a real dev box all three resolve to live machine state: the picker
// renders the operator's actual Windows sessions beside the fixtures (which is what broke
// every row-position assertion in the ui/hotkeys suites), gather_windows_rows deletes
// registry entries older than its 7-day prune, and the wezterm/claude binaries are real
// executables that spawn real terminal tabs.
//
// AGENT_VIEW_WIN_GITBASH is deliberately NOT here: its default is a native C:\ path handed
// to wezterm.exe as an argument, never executed from WSL, so pinning wezterm covers it.
//
// tests/agentview-seams.test.js re-derives this list from the script and fails if a new
// /mnt/ seam appears without landing here.
const fs = require('node:fs');
const path = require('node:path');

// Answers the roster query with an empty list. Enough to keep gather_windows_rows on its
// normal path without contributing rows.
const INERT_WIN_CLAUDE = "#!/bin/bash\nprintf '[]'\n";

// Reached only through `[ -x "$WEZTERM_WIN" ]` guards, so a path that does not exist is a
// stronger default than a stub that does: every wezterm branch returns early instead of
// running. Tests that want the branch taken pass weztermBody.
const ABSENT = 'no-such-wezterm.exe';

/**
 * Build the three AGENT_VIEW_* seam vars, with stubs written into `bin`.
 *
 * @param {object}   o
 * @param {string}   o.bin           scratch dir on PATH; stubs are written here
 * @param {function} o.scratch       caller's tracked temp-dir factory, so cleanup stays theirs
 * @param {string}  [o.windir]       existing registry dir; default a fresh empty one
 * @param {string}  [o.winClaudeBody] bash source for the claude.exe stub
 * @param {string}  [o.weztermBody]  bash source for the wezterm.exe stub; omit to leave it absent
 * @returns {{env: object, windir: string, winClaude: string, wezterm: string}}
 */
function agentviewWinSeams({ bin, scratch, windir, winClaudeBody, weztermBody } = {}) {
  if (!bin) throw new Error('agentviewWinSeams: bin is required');
  if (!windir && typeof scratch !== 'function') {
    throw new Error('agentviewWinSeams: pass windir, or a scratch() to make one');
  }

  const dir = windir || scratch('av-win-');

  const winClaude = path.join(bin, 'claude-win.exe');
  fs.writeFileSync(winClaude, winClaudeBody || INERT_WIN_CLAUDE, { mode: 0o755 });

  const wezterm = path.join(bin, weztermBody ? 'wezterm-win.sh' : ABSENT);
  if (weztermBody) fs.writeFileSync(wezterm, weztermBody, { mode: 0o755 });

  return {
    windir: dir,
    winClaude,
    wezterm,
    env: {
      AGENT_VIEW_WINDIR: dir,
      AGENT_VIEW_WIN_CLAUDE: winClaude,
      AGENT_VIEW_WEZTERM_WIN: wezterm,
    },
  };
}

// The seam names this helper is responsible for. The meta-test compares this against what
// it finds in the script, so the two cannot drift apart silently.
agentviewWinSeams.SEAMS = ['AGENT_VIEW_WINDIR', 'AGENT_VIEW_WEZTERM_WIN', 'AGENT_VIEW_WIN_CLAUDE'];

module.exports = { agentviewWinSeams };
