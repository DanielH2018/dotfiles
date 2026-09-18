// Drives the real zsh keybindings in a real pty: the rendered dot_zshrc.tmpl, real
// fzf widgets, real keys, assertions against the rendered line editor.
//
// The rc under test is chezmoi's own render of the template (execute-template is
// read-only -- it never touches the deployed ~/.zshrc), so these exercise the config
// as it actually ships rather than a fixture approximating it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFile } = require('../lib/render');
const { Term, ptySkip, tierB } = require('../lib/pty');
const { scratch } = require('../lib/tmp');
const { have } = require('../lib/probe');

const ROOT = path.join(__dirname, '..', '..');
const ZSHRC_SRC = path.join(ROOT, 'home', 'dot_zshrc.tmpl');
const COMMON_SRC = path.join(ROOT, 'home', 'dot_config', 'shell', 'common.sh');

const missing = (t) => !have(t);

// Rendered once, and only when the tier is on -- chezmoi is the only thing that can
// turn the template into the rc the shell actually gets.
const gate = tierB();
let rendered = null;
let renderError = null;
if (!gate && !missing('chezmoi')) {
  try {
    rendered = renderFile(ZSHRC_SRC, { source: null, cwd: ROOT });
  } catch (e) { renderError = e.message; }
}

const skip = gate
  || ptySkip()
  || (missing('zsh') ? 'zsh unavailable'
    : missing('fzf') ? 'fzf unavailable'
      : missing('chezmoi') ? 'chezmoi unavailable'
        : !rendered ? `chezmoi execute-template failed: ${renderError}` : false);

const PROMPT = 'ZP>';

// starship installs a precmd that repaints PROMPT on every line, so a fixed prompt
// has to outlive it -- and the tests need one fixed string to synchronise on. Only
// the prompt is replaced; every bindkey and widget under test is the real one.
const PROMPT_OVERRIDE = `
precmd_functions=()
PROMPT='${PROMPT} '
RPROMPT=''
`;

function makeEnv({ history = [] } = {}) {
  const home = scratch(os.tmpdir(), 'zshui-');
  fs.mkdirSync(path.join(home, '.config', 'shell'), { recursive: true });
  fs.copyFileSync(COMMON_SRC, path.join(home, '.config', 'shell', 'common.sh'));
  fs.writeFileSync(path.join(home, '.zshrc'), rendered + PROMPT_OVERRIDE);

  // EXTENDED_HISTORY is set in the rc, so write the format it expects.
  if (history.length) {
    const ts = 1700000000;
    fs.writeFileSync(path.join(home, '.zsh_history'),
      history.map((h, i) => `: ${ts + i}:0;${h}`).join('\n') + '\n');
  }

  const env = { ...process.env, HOME: home, ZDOTDIR: home };
  delete env.TMUX;
  delete env.FZF_DEFAULT_OPTS;
  return { home, env };
}

async function shell(t, cfg, cwd) {
  const term = new Term(['zsh', '-i'], { cols: 100, rows: 24, env: cfg.env, cwd: cwd || cfg.home });
  t.after(() => term.stop());
  await term.waitFor(PROMPT, { timeout: 15000 });
  return term;
}

test('ctrl-r puts the chosen history line on the prompt without running it', { skip }, async (t) => {
  const cfg = makeEnv({ history: ['echo pear-ctrlr-entry', 'echo decoy-entry'] });
  const term = await shell(t, cfg);

  term.send('ctrl-r');
  await term.waitFor((s) => s.contains('pear-ctrlr-entry'));   // fzf is up, showing history

  term.type('pear-ctrlr');
  // Wait for the query to actually filter: pressing enter before it lands accepts
  // whatever fzf still had selected.
  await term.waitFor((s) => !s.contains('decoy-entry'));
  term.send('enter');

  // Back at the prompt with the line loaded -- fzf-history-widget must not execute it.
  await term.waitFor((s) => new RegExp(`${PROMPT} echo pear-ctrlr-entry`).test(s.flat()));
  assert.ok(!term.screen.contains('pear-ctrlr-entry\npear'), 'the line must not have run');
});

test('ctrl-t inserts the chosen file path into the command line', { skip }, async (t) => {
  const cfg = makeEnv();
  fs.writeFileSync(path.join(cfg.home, 'quince-target.txt'), 'x\n');
  fs.writeFileSync(path.join(cfg.home, 'decoy-file.txt'), 'x\n');
  const term = await shell(t, cfg);

  term.type('echo MARKER-');
  term.send('ctrl-t');
  await term.waitFor((s) => s.contains('quince-target.txt'));

  term.type('quince-target');
  await term.waitFor((s) => !s.contains('decoy-file'));
  term.send('enter');                       // accept in fzf: inserts the path at the cursor
  await term.waitFor((s) => new RegExp(`${PROMPT} echo MARKER-\\S*quince-target\\.txt`).test(s.flat()));

  term.send('enter');                       // run the assembled line
  await term.waitFor(() => term.text().split('\n')
    .some((l) => /^MARKER-\S*quince-target\.txt$/.test(l.trim())));
});

test('alt-c changes directory to the chosen one', { skip }, async (t) => {
  const cfg = makeEnv();
  fs.mkdirSync(path.join(cfg.home, 'sorrel-dir'));
  fs.mkdirSync(path.join(cfg.home, 'decoy-dir'));
  const term = await shell(t, cfg);

  term.send('alt-c');
  await term.waitFor((s) => s.contains('sorrel-dir'));

  term.type('sorrel-dir');
  await term.waitFor((s) => !s.contains('decoy-dir'));
  term.send('enter');                       // fzf-cd-widget runs the cd itself

  term.type('pwd');
  term.send('enter');
  await term.waitFor((s) => /\/sorrel-dir/.test(s.flat()));
});

// bindkey '^[[1;5D' backward-word in dot_zshrc.tmpl -- the same key tmux conditionally
// passes through (see tmux-binds-ui.test.js).
test('ctrl-left moves back a word in the line editor', { skip }, async (t) => {
  const cfg = makeEnv();
  const term = await shell(t, cfg);

  term.type('echo one two');
  await term.waitFor('echo one two');
  term.send('ctrl-left');
  term.type('X');
  term.send('enter');

  await term.waitFor((s) => /(^| )one Xtwo( |$)/.test(s.flat()));
});

test('up-arrow searches history by the prefix already typed', { skip }, async (t) => {
  const cfg = makeEnv({ history: ['echo damson-history-entry', 'ls -la', 'echo other'] });
  const term = await shell(t, cfg);

  term.type('echo damson');
  await term.waitFor('echo damson');
  term.send('up');

  await term.waitFor((s) => new RegExp(`${PROMPT} echo damson-history-entry`).test(s.flat()));
});
