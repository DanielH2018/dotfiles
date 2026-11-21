// The Claude desktop app's Terminal panel gets the icon-free starship config: common.sh points
// STARSHIP_CONFIG at it when TERM_PROGRAM=claude-desktop, and the rendered config carries no
// Nerd Font glyph other than the powerline separators the panel draws itself.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have } = require('../lib/probe');
const { srcPath } = require('../lib/paths');
const { renderFile, chezmoiAvailable } = require('../lib/render');

const COMMON = srcPath('dot_config', 'shell', 'common.sh');
const PLAIN = srcPath('dot_config', 'starship-plain.toml.tmpl');
const skipBash = have('bash') ? false : 'no bash available';
const skipChezmoi = chezmoiAvailable ? false : 'no chezmoi available';
const BASH = skipBash ? '' : execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();

function starshipConfigUnder(termProgram) {
  const home = scratch(os.tmpdir(), 'starship-plain-');
  fs.mkdirSync(path.join(home, '.config'));
  fs.writeFileSync(path.join(home, '.config', 'starship-plain.toml'), '');
  return execFileSync(BASH, ['-c', `. "${COMMON}" 2>/dev/null; echo "[\${STARSHIP_CONFIG:-}]"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: scratch(os.tmpdir(), 'starship-plain-bin-'), TERM_PROGRAM: termProgram },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().replace(home, '~');
}

test('the Claude panel gets the plain starship config', { skip: skipBash }, () => {
  assert.strictEqual(starshipConfigUnder('claude-desktop'), '[~/.config/starship-plain.toml]');
});

test('other terminals keep the default starship config', { skip: skipBash }, () => {
  assert.strictEqual(starshipConfigUnder('WezTerm'), '[]');
});

test('the plain config has no Nerd Font icons and keeps a prompt character', { skip: skipChezmoi }, () => {
  const plain = renderFile(PLAIN);
  const icons = [...plain].filter((c) => {
    const cp = c.codePointAt(0);
    return (cp >= 0xe000 && cp <= 0xf8ff && !(cp >= 0xe0b0 && cp <= 0xe0b7)) || cp >= 0xf0000;
  });
  assert.deepStrictEqual(icons, []);
  assert.match(plain, /^success_symbol = '\[>\]/m);
});
