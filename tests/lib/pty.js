// Drives a real TUI in a real pty and reads back the rendered screen.
//
// script(1) is the pty provider: node has no stdlib pty and this repo carries no
// native modules. `script` allocates the pty, forwards our stdin into it, and
// copies pty output to its stdout -- which is what we parse. stty sizes the pty
// from inside, since script would otherwise inherit the pipe's (absent) winsize
// and full-screen apps like fzf would size themselves wrong.
const { spawn } = require('node:child_process');
const { Screen } = require('./vt');

const CSI = '\x1b[';

const KEYS = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  space: ' ',
  backspace: '\x7f',
  up: `${CSI}A`,
  down: `${CSI}B`,
  right: `${CSI}C`,
  left: `${CSI}D`,
  home: `${CSI}H`,
  end: `${CSI}F`,
  pageup: `${CSI}5~`,
  pagedown: `${CSI}6~`,
  // xterm modifier encoding; 5 = ctrl. tmux's no-prefix C-Left bind reads these.
  'ctrl-up': `${CSI}1;5A`,
  'ctrl-down': `${CSI}1;5B`,
  'ctrl-right': `${CSI}1;5C`,
  'ctrl-left': `${CSI}1;5D`,
};

// Replies a real terminal would send. Order matters: the DA2 pattern (ESC[>c)
// must be tried before the DA1 one (ESC[c), which would otherwise match it.
const QUERIES = [
  [/\x1b\[6n/g, (screen) => `${CSI}${screen.row + 1};${screen.col + 1}R`],
  [/\x1b\[\?6n/g, (screen) => `${CSI}?${screen.row + 1};${screen.col + 1};1R`],
  [/\x1b\[5n/g, `${CSI}0n`],
  [/\x1b\[>[0-9;]*c/g, `${CSI}>0;276;0c`],
  [/\x1b\[[0-9;]*c/g, `${CSI}?1;2c`],
  [/\x1b\[\?u/g, `${CSI}?0u`],                      // kitty keyboard protocol: unsupported
  [/\x1b\[\?2026\$p/g, `${CSI}?2026;2$y`],          // synchronized output: supported
  [/\x1bP\+q[0-9a-fA-F;]*\x1b\\/g, ''],             // XTGETTCAP: silence is a valid "no"
  [/\x1b\]1[01];\?(?:\x07|\x1b\\)/g, '\x1b]11;rgb:0000/0000/0000\x1b\\'],
];

// 'ctrl-r' -> 0x12, 'alt-1' -> ESC 1, 'enter' -> CR
function encode(key) {
  if (KEYS[key]) return KEYS[key];
  const ctrl = /^(?:ctrl|c)-(.)$/i.exec(key);
  if (ctrl) return String.fromCharCode(ctrl[1].toLowerCase().charCodeAt(0) - 96);
  const alt = /^(?:alt|m)-(.+)$/i.exec(key);
  if (alt) return `\x1b${encode(alt[1])}`;
  if (key.length === 1) return key;
  throw new Error(`unknown key: ${key}`);
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

class Term {
  constructor(argv, { cols = 100, rows = 30, env = process.env, cwd } = {}) {
    this.screen = new Screen(cols, rows);
    this.exit = null;
    this.raw = '';

    const cmd = argv.map(shellQuote).join(' ');
    const inner = `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${cmd}`;
    this.child = spawn('script', ['-qfc', inner, '/dev/null'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: { TERM: 'xterm-256color', ...env },
      cwd,
    });
    this.pending = '';
    this.child.stdout.on('data', (d) => {
      this.raw += d.toString('utf8');
      this.screen.write(d);
      this.answerQueries(d.toString('latin1'));
    });
    this.child.stderr.on('data', () => {});
    this.child.on('exit', (code) => { this.exit = code; });
    this.child.stdin.on('error', () => {}); // child can exit mid-write; not a test failure
  }

  // A pty is a pipe, not a terminal: nothing answers the capability and cursor
  // queries an app sends at startup. fzf's --height mode blocks on the DSR reply
  // (ESC[6n) and renders nothing until it arrives, so the harness has to play
  // terminal here. Unanswered queries look exactly like a hung app.
  answerQueries(chunk) {
    this.pending += chunk;
    for (const [pattern, reply] of QUERIES) {
      this.pending = this.pending.replace(pattern, () => {
        const answer = typeof reply === 'function' ? reply(this.screen) : reply;
        try { this.child.stdin.write(answer); } catch { /* child gone */ }
        return '';
      });
    }
    // Keep only a possible partial escape sequence for the next chunk.
    if (this.pending.length > 32) this.pending = this.pending.slice(-32);
  }

  send(...keys) {
    for (const k of keys) this.child.stdin.write(encode(k));
    return this;
  }

  type(text) {
    this.child.stdin.write(text);
    return this;
  }

  // SGR mouse: what a terminal sends when the user actually clicks a cell.
  // row/col are 1-based, matching the wire format.
  click(row, col, { button = 0 } = {}) {
    this.child.stdin.write(`${CSI}<${button};${col};${row}M`);
    this.child.stdin.write(`${CSI}<${button};${col};${row}m`);
    return this;
  }

  scroll(row, col, direction = 'up') {
    this.child.stdin.write(`${CSI}<${direction === 'up' ? 64 : 65};${col};${row}M`);
    return this;
  }

  text() { return this.screen.text(); }

  // Polls the parsed screen rather than sleeping a fixed interval, so a slow
  // machine costs latency instead of a false failure.
  // 10s rather than 5: node --test runs files in parallel, and every one of these waits
  // is on a real process (fzf, tmux, zsh) whose startup stretches under that contention.
  // The cost of a high ceiling is only paid by tests that genuinely fail.
  async waitFor(match, { timeout = 10000, interval = 20 } = {}) {
    const test = typeof match === 'function' ? match
      : match instanceof RegExp ? (s) => match.test(s.flat())
        : (s) => s.contains(match);
    const deadline = Date.now() + timeout;
    for (;;) {
      if (test(this.screen)) return this.screen;
      if (Date.now() >= deadline) {
        const what = typeof match === 'function' ? 'predicate' : String(match);
        throw new Error(
          `timed out after ${timeout}ms waiting for: ${what}\n`
          + `exit=${this.exit}\n--- screen ---\n${this.text()}\n--- end ---`,
        );
      }
      await sleep(interval);
    }
  }

  async waitForExit({ timeout = 5000 } = {}) {
    const deadline = Date.now() + timeout;
    while (this.exit === null && Date.now() < deadline) await sleep(20);
    return this.exit;
  }

  stop() {
    try { process.kill(-this.child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tier B: suites that boot a real tmux server or an interactive shell pay ~1s of
// startup per test, which would quadruple the default run. They stay opt-in so
// `node --test` remains fast enough to sit in a pre-commit hook.
const tierB = () => (process.env.UI_TIER_B ? false : 'tier B (set UI_TIER_B=1)');

// True only for util-linux script(1): BSD/macOS script has no --version and exits 1 on it.
// Term above is util-linux-only (-qfc, and it drives stty from inside the -c string), so this
// stays the availability probe for the TUI suites.
function ptyAvailable() {
  try {
    require('node:child_process').execFileSync('script', ['--version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Why every pty suite here is gated on the util-linux flavour rather than on `script` merely
// being on PATH, which is what BSD/macOS has: the two share no command form (util-linux takes
// the command as a -c string, BSD takes it as trailing argv after the typescript file), and
// more importantly BSD script tcgetattr's its OWN stdin and exits 1 with
// "tcgetattr/ioctl: Operation not supported on socket" when that stdin is a pipe. Every caller
// here is a node child_process with piped stdio, so on macOS it cannot allocate the pty at all
// -- not a quoting difference that could be papered over per flavour. A macOS run reads exit 1
// from the harness, which is indistinguishable from the script under test failing.
module.exports = { Term, encode, ptyAvailable, tierB, sleep };
