// Minimal VT100/xterm screen model: feed it the bytes a TUI writes to its pty
// and read back what a human would see. Covers the subset fzf/agentview emit
// (cursor moves, erases, alt-screen, scroll region) plus background colour,
// which is the only way to tell which row fzf has selected: agentview sets
// --pointer='▌', the same glyph fzf already draws in the gutter of every other
// row, so the selected row is distinguishable only by --highlight-line's
// background.
//
// Hand-rolled because this repo carries no npm/pip dependencies -- see the note
// in tests/python-suites.test.js about pytest being unavailable on this machine.
const { StringDecoder } = require('node:string_decoder');

const GROUND = 0, ESCAPE = 1, CSI = 2, OSC = 3;

class Screen {
  constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
    this.grid = blank(cols, rows);
    this.alt = null;
    this.row = 0;
    this.col = 0;
    this.top = 0;
    this.bottom = rows - 1;
    this.state = GROUND;
    this.params = '';
    this.bg = null;
    this.decoder = new StringDecoder('utf8');
  }

  write(chunk) {
    const s = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    for (const ch of s) this.feed(ch);
    return this;
  }

  feed(ch) {
    const code = ch.codePointAt(0);
    switch (this.state) {
      case GROUND:
        if (ch === '\x1b') { this.state = ESCAPE; this.params = ''; }
        else if (ch === '\r') this.col = 0;
        else if (ch === '\n' || ch === '\v' || ch === '\f') this.lineFeed();
        else if (ch === '\b') this.col = Math.max(0, this.col - 1);
        else if (ch === '\t') this.col = Math.min(this.cols - 1, (this.col + 8) & ~7);
        else if (code >= 32) this.put(ch);
        return;

      case ESCAPE:
        if (ch === '[') { this.state = CSI; this.params = ''; }
        else if (ch === ']') { this.state = OSC; this.params = ''; }
        else if (ch === 'M') { this.reverseIndex(); this.state = GROUND; }
        else if (ch === '7') { this.saved = [this.row, this.col]; this.state = GROUND; }
        else if (ch === '8') { [this.row, this.col] = this.saved || [0, 0]; this.state = GROUND; }
        else this.state = GROUND; // charset selects, keypad modes: consumed, ignored
        return;

      case CSI:
        if (code >= 0x40 && code <= 0x7e) { this.csi(ch); this.state = GROUND; }
        else this.params += ch;
        return;

      case OSC:
        // OSC runs to BEL or ST; ESC here starts the ST pair, nothing else is valid
        if (ch === '\x07' || ch === '\x1b') this.state = GROUND;
        return;
    }
  }

  csi(final) {
    const priv = this.params.startsWith('?');
    const raw = priv ? this.params.slice(1) : this.params;
    const nums = raw.split(';').map((p) => (p === '' ? 0 : parseInt(p, 10)));
    const n = (i, dflt) => (Number.isFinite(nums[i]) && nums[i] !== 0 ? nums[i] : dflt);

    switch (final) {
      case 'A': this.row = Math.max(0, this.row - n(0, 1)); break;
      case 'B': this.row = Math.min(this.rows - 1, this.row + n(0, 1)); break;
      case 'C': this.col = Math.min(this.cols - 1, this.col + n(0, 1)); break;
      case 'D': this.col = Math.max(0, this.col - n(0, 1)); break;
      case 'E': this.row = Math.min(this.rows - 1, this.row + n(0, 1)); this.col = 0; break;
      case 'F': this.row = Math.max(0, this.row - n(0, 1)); this.col = 0; break;
      case 'G': case '`': this.col = clamp(n(0, 1) - 1, 0, this.cols - 1); break;
      case 'd': this.row = clamp(n(0, 1) - 1, 0, this.rows - 1); break;
      case 'H': case 'f':
        this.row = clamp(n(0, 1) - 1, 0, this.rows - 1);
        this.col = clamp(n(1, 1) - 1, 0, this.cols - 1);
        break;
      case 'J': this.eraseDisplay(nums[0] || 0); break;
      case 'K': this.eraseLine(nums[0] || 0); break;
      case 'X': this.eraseChars(n(0, 1)); break;
      case 'P': this.deleteChars(n(0, 1)); break;
      case '@': this.insertChars(n(0, 1)); break;
      case 'L': this.insertLines(n(0, 1)); break;
      case 'M': this.deleteLines(n(0, 1)); break;
      case 'S': this.scrollUp(n(0, 1)); break;
      case 'T': this.scrollDown(n(0, 1)); break;
      case 'r':
        this.top = clamp(n(0, 1) - 1, 0, this.rows - 1);
        this.bottom = clamp(n(1, this.rows) - 1, 0, this.rows - 1);
        break;
      case 'h': if (priv && nums.includes(1049)) this.enterAlt(); break;
      case 'l': if (priv && nums.includes(1049)) this.leaveAlt(); break;
      case 'm': this.sgr(nums); break;
      default: break; // cursor visibility, DA queries: no effect on the screen
    }
  }

  // Only background is tracked -- it's what distinguishes a selected row.
  sgr(nums) {
    for (let i = 0; i < nums.length; i += 1) {
      const n = nums[i];
      if (n === 0 || n === 49) this.bg = null;
      else if (n === 48 && nums[i + 1] === 2) { this.bg = `rgb:${nums.slice(i + 2, i + 5).join(',')}`; i += 4; }
      else if (n === 48 && nums[i + 1] === 5) { this.bg = `idx:${nums[i + 2]}`; i += 2; }
      else if (n >= 40 && n <= 47) this.bg = `idx:${n - 40}`;
      else if (n >= 100 && n <= 107) this.bg = `idx:${n - 100 + 8}`;
    }
  }

  put(ch) {
    if (this.col >= this.cols) { this.col = 0; this.lineFeed(); }
    this.grid[this.row][this.col] = { ch, bg: this.bg };
    this.col += 1;
  }

  lineFeed() {
    if (this.row === this.bottom) this.scrollUp(1);
    else this.row = Math.min(this.rows - 1, this.row + 1);
  }

  reverseIndex() {
    if (this.row === this.top) this.scrollDown(1);
    else this.row = Math.max(0, this.row - 1);
  }

  scrollUp(count) {
    for (let i = 0; i < count; i += 1) {
      this.grid.splice(this.top, 1);
      this.grid.splice(this.bottom, 0, blankRow(this.cols));
    }
  }

  scrollDown(count) {
    for (let i = 0; i < count; i += 1) {
      this.grid.splice(this.bottom, 1);
      this.grid.splice(this.top, 0, blankRow(this.cols));
    }
  }

  insertLines(count) {
    if (this.row < this.top || this.row > this.bottom) return;
    for (let i = 0; i < count; i += 1) {
      this.grid.splice(this.bottom, 1);
      this.grid.splice(this.row, 0, blankRow(this.cols));
    }
  }

  deleteLines(count) {
    if (this.row < this.top || this.row > this.bottom) return;
    for (let i = 0; i < count; i += 1) {
      this.grid.splice(this.row, 1);
      this.grid.splice(this.bottom, 0, blankRow(this.cols));
    }
  }

  insertChars(count) {
    const line = this.grid[this.row];
    for (let i = 0; i < count; i += 1) { line.splice(this.col, 0, cell(this.bg)); line.pop(); }
  }

  deleteChars(count) {
    const line = this.grid[this.row];
    for (let i = 0; i < count; i += 1) { line.splice(this.col, 1); line.push(cell(this.bg)); }
  }

  eraseChars(count) {
    for (let i = 0; i < count && this.col + i < this.cols; i += 1) this.grid[this.row][this.col + i] = cell(this.bg);
  }

  // Erases fill with the current background (back-colour erase), which is how a
  // full-width row highlight is actually painted.
  eraseLine(mode) {
    const line = this.grid[this.row];
    const [from, to] = mode === 1 ? [0, this.col] : mode === 2 ? [0, this.cols - 1] : [this.col, this.cols - 1];
    for (let i = from; i <= to; i += 1) line[i] = cell(this.bg);
  }

  eraseDisplay(mode) {
    if (mode === 2 || mode === 3) { this.grid = blank(this.cols, this.rows, this.bg); return; }
    if (mode === 0) {
      this.eraseLine(0);
      for (let r = this.row + 1; r < this.rows; r += 1) this.grid[r] = blankRow(this.cols, this.bg);
    } else {
      this.eraseLine(1);
      for (let r = 0; r < this.row; r += 1) this.grid[r] = blankRow(this.cols, this.bg);
    }
  }

  enterAlt() {
    if (this.alt) return;
    this.alt = this.grid;
    this.grid = blank(this.cols, this.rows);
  }

  leaveAlt() {
    if (!this.alt) return;
    this.grid = this.alt;
    this.alt = null;
  }

  line(n) { return this.grid[n].map((c) => c.ch).join('').replace(/\s+$/, ''); }

  text() { return this.grid.map((_, i) => this.line(i)).join('\n'); }

  // Collapses runs of whitespace so assertions survive fzf's padding/margins.
  flat() { return this.text().replace(/\s+/g, ' ').trim(); }

  contains(needle) { return this.flat().includes(needle.replace(/\s+/g, ' ').trim()); }

  bgAt(row, col) { return this.grid[row][col].bg; }

  // The background a row is mostly painted in, or null if it is mostly bare --
  // i.e. "is this the highlighted row".
  rowBg(n) {
    const counts = new Map();
    for (const c of this.grid[n]) counts.set(c.bg, (counts.get(c.bg) || 0) + 1);
    let best = null;
    let bestCount = 0;
    for (const [bg, count] of counts) if (count > bestCount) { best = bg; bestCount = count; }
    return bestCount > this.cols / 2 ? best : null;
  }

  // Row indices whose dominant background differs from the screen's, most
  // commonly the single row fzf has selected.
  highlightedRows() {
    const page = new Map();
    for (let r = 0; r < this.rows; r += 1) {
      const bg = this.rowBg(r);
      page.set(bg, (page.get(bg) || 0) + 1);
    }
    let common = null;
    let commonCount = 0;
    for (const [bg, count] of page) if (count > commonCount) { common = bg; commonCount = count; }
    const out = [];
    for (let r = 0; r < this.rows; r += 1) if (this.rowBg(r) !== common) out.push(r);
    return out;
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cell = (bg = null) => ({ ch: ' ', bg });
const blankRow = (cols, bg = null) => Array.from({ length: cols }, () => cell(bg));
const blank = (cols, rows, bg = null) => Array.from({ length: rows }, () => blankRow(cols, bg));

module.exports = { Screen };
