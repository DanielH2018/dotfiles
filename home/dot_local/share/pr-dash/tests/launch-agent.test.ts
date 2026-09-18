// The always-on design's "The launchd agent": a plist in the repo's `scheduled/`
// directory owns the server's lifecycle, and the operator renders and bootstraps it by hand
// from the commands in its own header. This reads the plist *source* template and
// bin/pr-dash's source, and checks the facts that must agree between them and the server's
// own code. It never calls launchctl, chezmoi, or op, and never spawns a process — except
// `plutil -lint`, a local macOS binary that reads one file and changes nothing — the whole
// point being to catch a drift between the plist and the code it launches without needing a
// real launchd, a real GitHub token, or a real filesystem outside this package.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_STATE_DIR, DIR_MODE } from '../src/payload-store.ts';

// Four levels above the package root (home/dot_local/share/pr-dash), landing on the
// worktree/repo root — the one that contains both `home/` and `scheduled/`. Named once here
// instead of a `../../../../` chain at each use below, so the relationship between the two
// roots is stated once.
const PACKAGE_ROOT = path.join(import.meta.dirname, '..');
const REPO_ROOT = path.join(PACKAGE_ROOT, '..', '..', '..', '..');

// Outside `home/`, so `chezmoi apply` never deploys it: launchd reads a plist only at
// bootstrap, and an auto-deployed copy would let an apply rewrite the file while the loaded
// job kept the old definition. See README.md's `scheduled/` entry for the convention.
const PLIST_PATH = path.join(
  REPO_ROOT,
  'scheduled',
  'com.danielhunter.pr-dash.plist.tmpl',
);
const BIN_PR_DASH_PATH = path.join(REPO_ROOT, 'home', 'dot_local', 'bin', 'executable_pr-dash.tmpl');

const plistText = readFileSync(PLIST_PATH, 'utf8');
const binText = readFileSync(BIN_PR_DASH_PATH, 'utf8');

// The entry point both the agent and the foreground launcher run. Named once so a rename of
// main.ts that updates one file and not the other — or updates both but not this constant —
// fails loudly here instead of leaving the agent pointing at a path that no longer exists.
const ENTRY_POINT = 'src/main.ts';

test('the plist runs the same entry point bin/pr-dash runs', () => {
  assert.ok(
    plistText.includes(`{{ .chezmoi.homeDir }}/.local/share/pr-dash/${ENTRY_POINT}`),
    `expected the plist to run .local/share/pr-dash/${ENTRY_POINT}`,
  );
  assert.ok(
    binText.includes(`/${ENTRY_POINT}`),
    `expected bin/pr-dash to run ${ENTRY_POINT}`,
  );
});

test('the plist and bin/pr-dash agree on the default port', () => {
  // Extracted from each file rather than compared against a literal 8770 written twice in
  // this test — a test that hardcodes the same number in two places can't tell "the files
  // agree" apart from "the test author typed the same digits twice".
  const plistPort = /<key>PR_DASH_PORT<\/key>\s*<string>(\d+)<\/string>/.exec(plistText)?.[1];
  const binPort = /PORT="\$\{PR_DASH_PORT:-(\d+)\}"/.exec(binText)?.[1];
  assert.ok(plistPort !== undefined, 'expected a PR_DASH_PORT string in the plist');
  assert.ok(binPort !== undefined, 'expected a PR_DASH_PORT default in bin/pr-dash');
  assert.strictEqual(plistPort, binPort);
});

test('the plist and bin/pr-dash read PR_DASH_WORK_ORGS from the same chezmoi key, guarded by hasKey', () => {
  // Same shape as the port test: the template expression is extracted from each file and
  // compared, never typed here twice. Both render `prDashWorkOrgs` from the machine-local
  // chezmoi.toml, so a launcher that read a different key — or stopped reading one — would
  // reach the Personal toggle differently from the agent while every unit test stayed
  // green. The `hasKey` guard is what a machine that sets no such key depends on: without
  // it chezmoi fails the render with "map has no entry for key" instead of emitting the
  // empty string parseWorkOrgs reads as no work organizations.
  const plistExpr =
    /<key>PR_DASH_WORK_ORGS<\/key>\s*<string>([^<]*)<\/string>/.exec(plistText)?.[1];
  const binExpr = /^WORK_ORGS_DEFAULT='([^']*)'$/m.exec(binText)?.[1];
  assert.ok(plistExpr !== undefined, 'expected a PR_DASH_WORK_ORGS string in the plist');
  assert.ok(binExpr !== undefined, 'expected a WORK_ORGS_DEFAULT literal in bin/pr-dash');
  assert.strictEqual(plistExpr, binExpr);
  assert.match(
    plistExpr,
    /^\{\{\s*if hasKey \. "prDashWorkOrgs"\s*\}\}\{\{\s*\.prDashWorkOrgs\s*\}\}\{\{\s*end\s*\}\}$/,
    'expected the value to be .prDashWorkOrgs behind a hasKey guard and nothing else',
  );
  assert.match(binText, /export PR_DASH_WORK_ORGS=/, 'expected bin/pr-dash to export PR_DASH_WORK_ORGS');
});

test('KeepAlive is bare <true/>, with no SuccessfulExit override', () => {
  // The idle exit (main-lib.ts's createIdleExit) exits status 0 by design. A dict form —
  // <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict> — reads that clean
  // exit as "do not restart", which would leave the port dead until the next login with
  // nothing in this suite noticing. This is the mutation that would silently kill the
  // always-on property, so it gets its own test rather than riding along with the rest of
  // the plist's structure.
  assert.match(plistText, /<key>KeepAlive<\/key>\s*<true\/>/);
  // A plain `!includes('SuccessfulExit')` would also fire on this very test's own comment
  // above, and on the plist's own explanatory comment naming the key it warns against — so
  // this checks for the actual XML key node, not any mention of the word.
  assert.ok(
    !/<key>SuccessfulExit<\/key>/.test(plistText),
    'expected no SuccessfulExit key at all',
  );
});

test('the agent PATH includes /opt/homebrew/bin, where op lives', () => {
  // src/token.ts invokes `op` by bare name through execFile, and launchd hands a job
  // PATH=/usr/bin:/bin:/usr/sbin:/sbin with nothing else. Without /opt/homebrew/bin here,
  // the first /api/prs comes back as a 500 carrying an ENOENT rather than a token.
  assert.match(plistText, /<key>PATH<\/key>\s*<string>[^<]*\/opt\/homebrew\/bin[^<]*<\/string>/);
});

test('the Label is com.danielhunter.pr-dash', () => {
  assert.match(plistText, /<key>Label<\/key>\s*<string>com\.danielhunter\.pr-dash<\/string>/);
});

test('the plist template is well-formed XML', () => {
  // Deleting RunAtLoad, ThrottleInterval and the closing </dict> all at once left this
  // whole suite green while `plutil -lint` reported "Close tag on line 38 does not match
  // open tag dict". launchctl bootstrap refuses a plist like that and the dashboard simply
  // never starts. The lint runs on the raw .tmpl because the template braces sit inside
  // <string> text, so an unrendered template is still valid XML.
  if (process.platform !== 'darwin') return;
  execFileSync('plutil', ['-lint', PLIST_PATH], { stdio: 'pipe' });
});

test('ThrottleInterval is 10 seconds', () => {
  // It bounds how long the port sits unheld after an idle exit — the window in which the
  // bookmark gets ERR_CONNECTION_REFUSED — so a change to it moves that gap.
  assert.match(plistText, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
});

test('RunAtLoad is true', () => {
  // Removing it is in fact benign under this job's unconditional KeepAlive, which starts
  // the job at load anyway. Pinned so a change to it is a deliberate one.
  assert.match(plistText, /<key>RunAtLoad<\/key>\s*<true\/>/);
});

test("the activate block's mkdir creates the same directory the log paths name", () => {
  // The header's install commands are the only thing that creates this directory before the
  // process spawns: launchd creates the log file but not its parent, and the payload store
  // gets there only after the first successful fetch. A mkdir naming a different directory
  // means the documented install leaves the job unable to write its log at all.
  const stateDirSuffix = DEFAULT_STATE_DIR.slice(homedir().length);
  const mkdir = `mkdir -p -m ${DIR_MODE.toString(8)} ~${stateDirSuffix}`;
  assert.ok(
    plistText.includes(mkdir),
    `expected the activate block to run \`${mkdir}\``,
  );
});

test("the log paths' directory matches payload-store's DEFAULT_STATE_DIR", () => {
  // Imported rather than repeated as a literal, so the plist and the payload store's own
  // idea of where state lives cannot drift apart silently.
  const stateDirSuffix = DEFAULT_STATE_DIR.slice(homedir().length);
  const expectedLogPath = `{{ .chezmoi.homeDir }}${stateDirSuffix}/agent.log`;
  assert.ok(
    plistText.includes(`<key>StandardOutPath</key>\n\t<string>${expectedLogPath}</string>`),
    `expected StandardOutPath to be ${expectedLogPath}`,
  );
  assert.ok(
    plistText.includes(`<key>StandardErrorPath</key>\n\t<string>${expectedLogPath}</string>`),
    `expected StandardErrorPath to be ${expectedLogPath}`,
  );
});
