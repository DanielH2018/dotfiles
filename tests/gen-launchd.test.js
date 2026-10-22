// bin/gen-launchd renders scheduled/*.plist.tmpl from scheduled/launchd.json. The lib tests
// pin the shapes launchd and work-laptop-config's catch-up.sh read (a dict calendar against
// an array of one, an omitted RunAtLoad against false), that a chezmoi action survives
// unescaped, and the manifest errors that would otherwise drop a field in silence. The
// end-to-end trio runs the real binary green against the committed tree, red against a
// hand-edited template, and red against a generated template with no manifest entry.
// tests/scheduled-launchd.test.js still checks every rendered definition, generated or not.
const { test } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require('../bin/gen-launchd-lib.js');
const { repoPath } = require('./lib/paths');
const { scratch } = require('./lib/tmp');

const BIN = repoPath('bin', 'gen-launchd');
const job = (extra) => ({
  label: 'com.daniel.x', plist: 'scheduled/com.daniel.x.plist.tmpl', program: ['/bin/x'], ...extra,
});
const keyThen = (text, key) => text.slice(text.indexOf(`<key>${key}</key>`) + key.length + 11).trimStart();

// --- lib.renderJob --------------------------------------------------------------------------

test('a calendar object renders a dict and an array of one stays an array', () => {
  assert.match(keyThen(lib.renderJob(job({ calendar: { weekday: 1, hour: 9, minute: 0 } })), 'StartCalendarInterval'), /^<dict>/);
  assert.match(keyThen(lib.renderJob(job({ calendar: [{ weekday: 3, hour: 7, minute: 30 }] })), 'StartCalendarInterval'), /^<array>\n\t\t<dict>/);
});

test('a weekday list expands to one calendar entry per day', () => {
  const text = lib.renderJob(job({ calendar: [{ weekday: [1, 2], hour: 8, minute: 5 }] }));
  assert.deepStrictEqual([...text.matchAll(/<key>Weekday<\/key>\n\t+<integer>(\d)/g)].map((m) => m[1]), ['1', '2']);
});

test('an omitted at_load renders no RunAtLoad key, and false renders <false/>', () => {
  assert.doesNotMatch(lib.renderJob(job()), /RunAtLoad/);
  assert.match(keyThen(lib.renderJob(job({ at_load: false })), 'RunAtLoad'), /^<false\/>/);
});

test('command becomes a zsh -lc argv and the log path both standard streams', () => {
  const text = lib.renderJob({ label: 'com.daniel.x', plist: 'scheduled/com.daniel.x.plist.tmpl', command: 'exec x', log_path: '/l/x.log' });
  assert.match(text, /<string>\/bin\/zsh<\/string>\n\t\t<string>-lc<\/string>\n\t\t<string>exec x<\/string>/);
  assert.match(keyThen(text, 'StandardOutPath'), /^<string>\/l\/x\.log/);
  assert.match(keyThen(text, 'StandardErrorPath'), /^<string>\/l\/x\.log/);
});

test('a chezmoi action survives unescaped while & < > are escaped', () => {
  const text = lib.renderJob(job({ env: { A: '{{ if hasKey . "k" }}{{ .k }}{{ end }}', B: 'a&b<c>' } }));
  assert.match(text, /<string>\{\{ if hasKey \. "k" \}\}\{\{ \.k \}\}\{\{ end \}\}<\/string>/);
  assert.match(text, /<string>a&amp;b&lt;c&gt;<\/string>/);
});

test('a note renders as a comment above its key, env notes included', () => {
  const text = lib.renderJob(job({ env: { P: '1' }, keep_alive: true, notes: { KeepAlive: ['why one', 'why two'], 'env.P': ['port'] } }));
  assert.match(text, /\t<!-- why one\n\t     why two -->\n\t<key>KeepAlive<\/key>/);
  assert.match(text, /\t\t<!-- port -->\n\t\t<key>P<\/key>/);
});

test('renderJob rejects a manifest that would drop or corrupt a field', () => {
  const cases = [
    [job({ keepalive: true }), /unknown key\(s\) keepalive/],
    [job({ plist: 'scheduled/other.plist.tmpl' }), /must end in \/com\.daniel\.x\.plist\.tmpl/],
    [job({ command: 'exec x' }), /exactly one of command and program/],
    [job({ calendar: { weekday: [1, 2], hour: 8 } }), /needs the array form/],
    [job({ calendar: [{ hour: 8, minit: 5 }] }), /unknown calendar key 'minit'/],
    [job({ notes: { KeepAlive: ['x'] } }), /a note names 'KeepAlive'/],
    [job({ why: ['a -- b'] }), /cannot contain "--"/],
  ];
  for (const [bad, err] of cases) assert.throws(() => lib.renderJob(bad), err);
});

// work-laptop-config renders plain .plist files through these two exports.
test('normalise takes another plist suffix, and value renders the entries it returns', () => {
  const { entries } = lib.normalise({ label: 'com.daniel.x', plist: 'L/com.daniel.x.plist', command: 'exec x' },
    { suffix: '.plist' });
  assert.match(lib.value(Object.fromEntries(entries), 0).join('\n'), /^<dict>\n\t<key>Label<\/key>\n\t<string>com\.daniel\.x<\/string>/);
  assert.throws(() => lib.normalise(job(), { suffix: '.plist' }), /must end in \/com\.daniel\.x\.plist$/);
});

// --- End-to-end: the real tree, then two ways for it to drift -------------------------------

test('gen-launchd --check passes against the committed tree right now', () => {
  const out = execFileSync('node', [BIN, '--check'], { encoding: 'utf8' });
  assert.match(out, /com\.danielhunter\.pr-dash\.plist\.tmpl is up to date/);
});

// A copy of the generator and scheduled/ in a temp dir, so the red cases cannot touch this tree.
function stage(t) {
  const dir = scratch(os.tmpdir(), 'gen-launchd-', t);
  fs.mkdirSync(path.join(dir, 'bin'));
  for (const f of ['gen-launchd', 'gen-launchd-lib.js', 'gen-lib.js']) {
    fs.copyFileSync(repoPath('bin', f), path.join(dir, 'bin', f));
  }
  fs.cpSync(repoPath('scheduled'), path.join(dir, 'scheduled'), { recursive: true });
  return dir;
}

test('gen-launchd --check fails on a hand edit to a generated template', (t) => {
  const dir = stage(t);
  const tmpl = path.join(dir, 'scheduled', 'com.danielhunter.pr-dash.plist.tmpl');
  fs.writeFileSync(tmpl, fs.readFileSync(tmpl, 'utf8').replace('<integer>10</integer>', '<integer>11</integer>'));
  const r = spawnSync('node', [path.join(dir, 'bin', 'gen-launchd'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /pr-dash\.plist\.tmpl is out of date/);
  assert.match(r.stderr, /committed: .*<integer>11<\/integer>/);
});

test('gen-launchd --check fails on a generated template the manifest does not list', (t) => {
  const dir = stage(t);
  fs.copyFileSync(
    path.join(dir, 'scheduled', 'com.danielhunter.pr-dash.plist.tmpl'),
    path.join(dir, 'scheduled', 'com.daniel.orphan.plist.tmpl'),
  );
  const r = spawnSync('node', [path.join(dir, 'bin', 'gen-launchd'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /com\.daniel\.orphan\.plist\.tmpl says it is generated/);
});
