// Behavior tests for the os-darwin bootstrap scripts, driven under the PATH-shim sandbox.
//
// The suite is split by the guard each script renders behind; chezmoi-scripts.test.js lists the
// files. These scripts render empty off macOS, and CI runs on Linux, so each test
// strips the darwin guard and renders the body with the real chezmoi, the way renderWslBody in
// chezmoi-scripts.test.js does. A template error inside the body still fails here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderTemplate } = require('../lib/render');
const {
  SCRIPTS_DIR, skip, tmpdir, readLog, runSh,
} = require('../lib/chezmoi-scripts');

function renderDarwinBody(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.match(lines[0], /eq \.chezmoi\.os "darwin"/, `${path.basename(file)}: expected a darwin guard on line 1`);
  return renderTemplate(lines.slice(1).filter((l) => l.trim() !== '{{ end -}}').join('\n'));
}

// os-darwin/run_onchange_after_install-brew-bundle.sh.tmpl ----------------------------------
{
  const BB_SRC = path.join(SCRIPTS_DIR, 'os-darwin', 'run_onchange_after_install-brew-bundle.sh.tmpl');

  // The brew stub records whether node is on PATH at the moment `brew bundle` runs, which is
  // when the Brewfile's `npm` rows need it. The fnm stub prints the PATH export `fnm env` would.
  function bbSandbox({ fnm }) {
    const dir = tmpdir('brew-bundle-');
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'Brewfile'), '');
    fs.writeFileSync(path.join(dir, 'brew'),
      '#!/bin/sh\n[ "$1" = bundle ] && echo "bundle node=$(command -v node || echo none)" >> "$STUB_LOG"\nexit 0\n',
      { mode: 0o755 });
    if (fnm) {
      fs.mkdirSync(path.join(dir, 'fnm-node'));
      fs.writeFileSync(path.join(dir, 'fnm-node', 'node'), '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'fnm'),
        `#!/bin/sh\necho 'export PATH="${path.join(dir, 'fnm-node')}:$PATH"'\n`, { mode: 0o755 });
    }
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, renderDarwinBody(BB_SRC));
    return { scriptFile, env: { PATH: dir, HOME: dir, STUB_LOG: logFile }, logFile, dir };
  }

  // Without node on PATH the corepack row failed, the run exited 1, and chezmoi re-ran the
  // whole bundle on every apply.
  test('install-brew-bundle.sh.tmpl: brew bundle runs with fnm\'s node on PATH', { skip }, () => {
    const { scriptFile, env, logFile, dir } = bbSandbox({ fnm: true });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(readLog(logFile).trim(), `bundle node=${path.join(dir, 'fnm-node', 'node')}`);
  });

  test('install-brew-bundle.sh.tmpl: a Mac without fnm yet still runs the bundle', { skip }, () => {
    const { scriptFile, env, logFile } = bbSandbox({ fnm: false });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(readLog(logFile).trim(), 'bundle node=none');
  });
}
