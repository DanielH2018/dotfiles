// Regression guard for the screen model in tests/lib/vt.js.
// The model is what every pty-driven test reads its assertions off, so a gap
// here fails those tests for a reason that has nothing to do with the code
// under test -- and the pty suites are tier B, so it stays hidden until someone
// sets UI_TIER_B=1. Escape sequences the model gets wrong belong here first.
const { test } = require('node:test');
const assert = require('node:assert');
const { Screen } = require('./lib/vt');

const draw = (bytes, cols = 20, rows = 3) => new Screen(cols, rows).write(bytes);

// ESC ( B is two bytes. Consuming only the '(' leaves the 'B' to be printed,
// which is what put a stray B on the tmux status line instead of the session name.
test('a charset select is consumed whole, not printed', () => {
  assert.equal(draw('\x1b(Bok').text().split('\n')[0].trim(), 'ok');
});

test('every charset designator is consumed, for both halves of the set', () => {
  for (const seq of ['\x1b(B', '\x1b)0', '\x1b*A', '\x1b+B', '\x1b(0']) {
    assert.equal(draw(`${seq}x`).text().split('\n')[0].trim(), 'x', `leaked: ${JSON.stringify(seq)}`);
  }
});

// The escape that follows must still be parsed as an escape -- a charset select
// that swallowed one byte too many would eat the ESC and print the rest.
test('a charset select does not swallow the sequence after it', () => {
  const s = draw('\x1b(B\x1b[2;3Hhi');
  assert.equal(s.text().split('\n')[1].trim(), 'hi');
});

test('an SGR run around a charset select still sets the background', () => {
  const s = draw('\x1b[48;2;1;2;3m\x1b(Bz');
  assert.equal(s.text().split('\n')[0].trim(), 'z');
  assert.equal(s.grid[0][0].bg, 'rgb:1,2,3');
});
