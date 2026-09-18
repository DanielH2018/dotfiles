// Guards the launchd job definitions under scheduled/.
//
// These had no test of any kind. Their Windows counterparts do — tests/scheduled-tasks.test.js
// exists because the Task Scheduler exports baked the exporting machine into every definition,
// which pinned each task to one box. The plists carried the identical defect and nobody had
// looked: /Users/daniel was written out in ProgramArguments, StandardOutPath and
// StandardErrorPath, because launchd expands neither $HOME nor ~ anywhere in a plist and
// StandardOutPath in particular must be absolute.
//
// They are also the only scheduled definitions here that are installed BY HAND, out of a
// copy-pasted comment block. So nothing checked that a plist parses, that its Label matches
// the filename launchctl will bootstrap it by, or that the program it names exists in the
// tree — three ways to get a job that loads and silently never runs.
//
// Not deployed by chezmoi (they live outside `home/`, deliberately — see any of their
// headers), so these render through `chezmoi execute-template` the way the activate block
// in each header does, and assert against the render.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, chezmoiAvailable } = require('./lib/render');
const { srcPath, repoPath } = require('./lib/paths');

const DIR = repoPath('scheduled');

const skip = chezmoiAvailable ? false : 'chezmoi unavailable';
const havePython = (() => {
  const r = spawnSync('python3', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
})();
const skipXml = skip || (havePython ? false : 'python3 unavailable');

function sources() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.plist.tmpl')).sort();
}

let cache;
function definitions() {
  cache ??= sources().map((name) => ({
    name,
    raw: fs.readFileSync(path.join(DIR, name), 'utf8'),
    xml: renderTemplate(fs.readFileSync(path.join(DIR, name), 'utf8'), { source: null, cwd: repoPath() }),
  }));
  return cache;
}

// A plist string's <key>NAME</key><string>VALUE</string> pairs, and the <array> members
// that follow a key. Deliberately regex rather than a plist parser: the suite has no
// dependencies and adding one for four files is not worth it.
function stringValues(xml, key) {
  const at = xml.indexOf(`<key>${key}</key>`);
  if (at === -1) return [];
  const after = xml.slice(at + key.length + 11);
  const arr = after.match(/^\s*<array>([\s\S]*?)<\/array>/);
  if (arr) return [...arr[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const one = after.match(/^\s*<string>([^<]*)<\/string>/);
  return one ? [one[1]] : [];
}

test('the launchd definitions are found', { skip }, () => {
  const names = sources();
  assert.ok(names.length >= 3,
    `expected the scheduled/ plists, got ${names.join(', ') || '(none)'}`);
});

test('every definition is well-formed XML', { skip: skipXml }, () => {
  for (const { name, xml } of definitions()) {
    const r = spawnSync(
      'python3',
      ['-c', 'import sys,xml.dom.minidom; xml.dom.minidom.parseString(sys.stdin.buffer.read())'],
      { input: xml, encoding: 'utf8' },
    );
    assert.strictEqual(r.status, 0, `${name}: ${r.stderr}`);
  }
});

// The whole point of templating them. A literal /Users/<name> renders identically on every
// machine, which is what made these single-machine files.
test('no definition hardcodes a home directory', { skip }, () => {
  for (const { name, raw } of definitions()) {
    const body = raw.slice(raw.indexOf('<!DOCTYPE'));
    assert.doesNotMatch(body, /\/Users\//,
      `${name} hardcodes a macOS home path — template it with {{ .chezmoi.homeDir }}`);
  }
});

// launchctl bootout takes the LABEL; the activate blocks all write the filename. A label
// that disagrees with its filename leaves a job that bootstraps and cannot be unloaded by
// the documented command — the reverse operation silently failing, which is worse than an
// error, because the job keeps running.
test('every Label matches its filename', { skip }, () => {
  for (const { name, xml } of definitions()) {
    const stem = name.replace(/\.plist\.tmpl$/, '');
    assert.deepStrictEqual(stringValues(xml, 'Label'), [stem],
      `${name}: Label must equal the filename stem, or launchctl bootout <label> is wrong`);
  }
});

// A plist naming a program that does not exist loads fine and fails at its first run, into
// a log nobody reads. Resolve each absolute program path back to the source that deploys it.
test('every program a definition runs exists in this repo', { skip }, () => {
  const home = renderTemplate('{{ .chezmoi.homeDir }}', { source: null, cwd: repoPath() });
  for (const { name, xml } of definitions()) {
    const args = stringValues(xml, 'ProgramArguments');
    assert.ok(args.length > 0, `${name} has no ProgramArguments`);

    // Either the plist runs a binary directly, or it runs a shell with a -c payload. Take
    // the first token that looks like a path under $HOME from whichever shape it is.
    const candidates = args.flatMap((a) => a.split(/\s+/)).filter((t) => t.startsWith(home));
    for (const abs of candidates) {
      const rel = abs.slice(home.length + 1);
      // ~/.local/bin/foo is deployed from home/dot_local/bin/executable_foo.
      const m = rel.match(/^\.local\/bin\/(.+)$/);
      if (m) {
        const src = srcPath('dot_local', 'bin', `executable_${m[1]}`);
        assert.ok(fs.existsSync(src),
          `${name} runs ~/${rel}, which nothing in this repo deploys (looked for ${src})`);
      }
      // Anything else (~/.claude/scheduled/run-skill.sh comes from work-laptop-config) is
      // out of this repo's reach and is documented as such in the plist's own header.
    }
  }
});

// The assertions above only ever run against files that pass them, so each needs one input
// it must reject. Same reason the .pre-commit-config.yaml rules are paired: a check that
// fires on nothing and a check that is correct look identical from the passing side.
test('the machine-pinning and Label checks reject a bad plist', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchd-guard-'));
  try {
    const bad = [
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '  <key>Label</key><string>com.daniel.something-else</string>',
      '  <key>ProgramArguments</key><array><string>/Users/daniel/.local/bin/nope</string></array>',
      '</dict></plist>',
    ].join('\n');

    assert.match(bad, /\/Users\//, 'the home-path check would not have flagged this');
    assert.notDeepStrictEqual(stringValues(bad, 'Label'), ['com.daniel.expected'],
      'the Label check would not have flagged this');

    // And the parser half: a truncated plist must fail, or the XML test proves nothing.
    if (havePython) {
      const r = spawnSync(
        'python3',
        ['-c', 'import sys,xml.dom.minidom; xml.dom.minidom.parseString(sys.stdin.buffer.read())'],
        { input: '<plist><dict>', encoding: 'utf8' },
      );
      assert.notStrictEqual(r.status, 0, 'malformed XML parsed cleanly');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
