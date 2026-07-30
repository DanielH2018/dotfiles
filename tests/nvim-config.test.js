// Parse + policy checks for the Neovim config. It is Lua that nvim only loads at runtime,
// so a syntax slip in a rarely-touched plugin spec surfaces as a startup error on some
// future machine, and an install-policy regression never surfaces at all.
//
// The policy worth guarding: treesitter parsers are cloned from GitHub and compiled with the
// system C toolchain, and `auto_install = true` did that for whatever filetype a buffer
// happened to be — so opening one unfamiliar file fetched and built code unprompted. The
// languages this config actually supports are installed explicitly instead.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const NVIM = path.join(REPO, 'home', 'dot_config', 'nvim');

function have(cmd, arg) {
  try { execFileSync(cmd, [arg], { stdio: 'ignore' }); return true; } catch { return false; }
}
// Same probe order as the wezterm tests: DEVCOM.Lua's lua.exe sits outside PATH on Windows.
function findLua() {
  const win = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Lua', 'bin', 'lua.exe');
  if (fs.existsSync(win)) return win;
  for (const c of ['lua5.4', 'lua']) if (have(c, '-v')) return c;
  return '';
}
const lua = findLua();
const skip = !lua ? 'lua unavailable' : false;

function luaFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return luaFiles(p);
    return e.name.endsWith('.lua') ? [p] : [];
  });
}
const read = (rel) => fs.readFileSync(path.join(NVIM, rel), 'utf8');
const treesitter = read(path.join('lua', 'plugins', 'treesitter.lua'));

test('every Lua file in the config parses', { skip }, () => {
  const files = luaFiles(NVIM);
  assert.ok(files.length > 5, `expected the config to be found, got ${files.length} files`);
  for (const f of files) {
    // loadfile compiles without executing — the specs reference `vim`, which only exists
    // inside nvim, so running them here would fail for the wrong reason.
    const r = spawnSync(lua, ['-e', `local fn, err = loadfile(${JSON.stringify(f)}); if not fn then io.stderr:write(err) os.exit(1) end`], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${path.relative(REPO, f)}: ${r.stderr}`);
  }
});

test('treesitter never installs a parser for a filetype nobody asked for', { skip }, () => {
  assert.match(treesitter, /auto_install\s*=\s*false/, 'auto_install must stay off');
  assert.doesNotMatch(treesitter, /auto_install\s*=\s*true/);
  assert.match(treesitter, /ensure_installed\s*=\s*\{/, 'the explicit list is what replaces auto_install');
});

test('every filetype the config formats has a parser installed', { skip }, () => {
  // If conform will reformat it and an LSP will diagnose it, treesitter has to be able to
  // parse it — otherwise turning auto_install off silently drops highlighting for a
  // language that is plainly in use. Left of the arrow is a vim filetype, right is the
  // treesitter parser name (they differ often enough to be worth writing down).
  const FT_TO_PARSER = {
    python: 'python',
    javascript: 'javascript',
    javascriptreact: 'tsx',
    typescript: 'typescript',
    typescriptreact: 'tsx',
    json: 'json',
    jsonc: 'jsonc',
    yaml: 'yaml',
    terraform: 'terraform',
    hcl: 'hcl',
    lua: 'lua',
    sh: 'bash',
  };
  const formatting = read(path.join('lua', 'plugins', 'formatting.lua'));
  const start = formatting.indexOf('{', formatting.indexOf('formatters_by_ft')) + 1;
  const block = formatting.slice(start, formatting.indexOf('format_on_save'));
  const fts = [...block.matchAll(/^\s*(\w+)\s*=\s*\{/gm)].map((m) => m[1]);
  assert.ok(fts.length > 5, `expected to find the formatter filetypes, got ${fts.join(',')}`);

  const installed = [...treesitter.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  for (const ft of fts) {
    const parser = FT_TO_PARSER[ft];
    assert.ok(parser, `formatters_by_ft gained "${ft}" — add it to FT_TO_PARSER and to ensure_installed`);
    assert.ok(installed.includes(parser), `filetype "${ft}" is formatted but parser "${parser}" is not installed`);
  }
  // The languages the LSP servers and the java ftplugin cover, which formatters_by_ft
  // does not name.
  for (const parser of ['java', 'markdown', 'sql']) {
    assert.ok(installed.includes(parser), `parser "${parser}" is used by an LSP server or ftplugin`);
  }
  // treesitter's own runtime needs these; leaving them out breaks :InspectTree and help.
  for (const parser of ['query', 'vim', 'vimdoc']) {
    assert.ok(installed.includes(parser), `parser "${parser}" is needed by treesitter itself`);
  }
});

test('the lazy.nvim bootstrap clones a pinned branch, not the default', { skip }, () => {
  // This clone runs before any plugin management exists, so it is the one fetch nothing
  // else can constrain.
  const init = read('init.lua');
  assert.match(init, /--branch=stable/, 'the bootstrap clone must name a branch');
});
