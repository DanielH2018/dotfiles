// .github/migration-gate/migration_gate.py is the merge-time half of rules/sql.md's "every
// migration must be reversible" (issue #659). Project repos run it through the reusable
// workflow .github/workflows/migration-gate.yml. Each shape it supports gets a red/green pair
// here, built as real git history in a scratch repo and judged through the script's own
// command line, so the diff selection (added files, merge-base, globs) is exercised along with
// the per-shape rule.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./lib/run');
const { scratch } = require('./lib/tmp');
const { skipUnless } = require('./lib/probe');
const { repoPath } = require('./lib/paths');
const { render } = require('../.github/migration-gate/embed.js');

const skip = skipUnless('python3');
const SCRIPT = repoPath('.github', 'migration-gate', 'migration_gate.py');
const WORKFLOW = repoPath('.github', 'workflows', 'migration-gate.yml');

// Git exports GIT_DIR and friends into hooks; a fixture repo must not inherit them, or its
// commits land in this repository instead (the pre-push gate runs this suite from a hook).
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
Object.assign(ENV, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
});
delete ENV.GITHUB_ACTIONS;

function git(dir, ...args) {
  const r = run('git', args, { cwd: dir, env: ENV });
  assert.strictEqual(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-gpg-sign', '--allow-empty', '-m', 'c');
  return git(dir, 'rev-parse', 'HEAD');
}

// A repo whose base commit holds `before`, and whose HEAD adds `added` on top. Returns the
// gate's verdict on that diff.
function gate(t, added, { before = { 'README': 'x\n' }, paths = [] } = {}) {
  const dir = scratch(os.tmpdir(), 'migration-gate-', t);
  git(dir, 'init', '-q', '-b', 'main');
  const base = commit(dir, before);
  commit(dir, added);
  const args = [SCRIPT, '--base', base, ...paths.flatMap((p) => ['--path', p])];
  const r = run('python3', args, { cwd: dir, env: ENV });
  return { ...r, out: r.stdout + r.stderr };
}

function red(t, files, why, opts) {
  const r = gate(t, files, opts);
  assert.strictEqual(r.code, 1, `expected a violation:\n${r.out}`);
  assert.match(r.out, why);
}

function green(t, files, opts) {
  const r = gate(t, files, opts);
  assert.strictEqual(r.code, 0, `expected a pass:\n${r.out}`);
  return r.out;
}

// --- paired .sql files -------------------------------------------------------------------

test('an .up.sql with no .down.sql sibling fails', { skip }, (t) => {
  red(t, { 'db/migrations/001_users.up.sql': 'CREATE TABLE users (id int);\n' },
    /FAIL\s+db\/migrations\/001_users\.up\.sql: no sibling db\/migrations\/001_users\.down\.sql/);
});

test('an .up.sql passes with its .down.sql, including one that predates the diff', { skip }, (t) => {
  green(t, {
    'migrations/001_users.up.sql': 'CREATE TABLE users (id int);\n',
    'migrations/001_users.down.sql': 'DROP TABLE users;\n',
  });
  green(t, { 'migrations/002_x.up.sql': 'CREATE TABLE x (id int);\n' },
    { before: { 'migrations/002_x.down.sql': 'DROP TABLE x;\n' } });
});

test('a Flyway V file fails with no U undo file and passes with one', { skip }, (t) => {
  red(t, { 'migration/V2__add_email.sql': 'ALTER TABLE users ADD email text;\n' },
    /no Flyway undo file migration\/U2__add_email\.sql/);
  green(t, {
    'migration/V2__add_email.sql': 'ALTER TABLE users ADD email text;\n',
    'migration/U2__add_email.sql': 'ALTER TABLE users DROP email;\n',
  });
});

// --- single-file .sql sections -----------------------------------------------------------

test('a dbmate file whose down section holds only the template comment fails', { skip }, (t) => {
  red(t, { 'db/migrations/20260924_users.sql':
    '-- migrate:up\nCREATE TABLE users (id int);\n\n-- migrate:down\n-- nothing yet\n' },
  /no `-- migrate:down`/);
});

test('dbmate and goose files with a statement in the down section pass', { skip }, (t) => {
  green(t, {
    'db/migrations/20260924_users.sql': '-- migrate:up\nCREATE TABLE users (id int);\n-- migrate:down\nDROP TABLE users;\n',
    'db/migrations/00002_orders.sql': '-- +goose Up\nCREATE TABLE o (id int);\n-- +goose Down\n-- +goose StatementBegin\nDROP TABLE o;\n-- +goose StatementEnd\n',
  });
});

// --- Alembic -----------------------------------------------------------------------------

test('an Alembic revision whose downgrade() only passes fails', { skip }, (t) => {
  red(t, { 'alembic/migrations/versions/ab12_users.py':
    'def upgrade():\n    op.create_table("users")\n\n\ndef downgrade():\n    pass\n' },
  /downgrade\(\) only passes, raises or has a docstring/);
});

test('an Alembic revision with a real downgrade() passes', { skip }, (t) => {
  green(t, { 'alembic/migrations/versions/ab12_users.py':
    'def upgrade():\n    op.create_table("users")\n\n\ndef downgrade():\n    """Drop it."""\n    op.drop_table("users")\n' });
});

// --- Rails -------------------------------------------------------------------------------

test('a Rails migration with only def up, or a down that raises Irreversible, fails', { skip }, (t) => {
  red(t, { 'db/migrate/20260924_add_email.rb':
    'class AddEmail < ActiveRecord::Migration[7.1]\n  def up\n    add_column :users, :email, :string\n  end\nend\n' },
  /no def down and no def change/);
  red(t, { 'db/migrate/20260924_drop_legacy.rb':
    'class DropLegacy < ActiveRecord::Migration[7.1]\n  def up\n    drop_table :legacy\n  end\n\n  def down\n    raise ActiveRecord::IrreversibleMigration\n  end\nend\n' },
  /only raises ActiveRecord::IrreversibleMigration/);
});

test('a Rails migration with def change or a working def down passes', { skip }, (t) => {
  green(t, {
    'db/migrate/20260924_add_email.rb': 'class AddEmail < ActiveRecord::Migration[7.1]\n  def change\n    add_column :users, :email, :string\n  end\nend\n',
    'db/migrate/20260925_add_name.rb': 'class AddName < ActiveRecord::Migration[7.1]\n  def up\n    add_column :users, :name, :string\n  end\n\n  def down\n    remove_column :users, :name\n  end\nend\n',
  });
});

// --- JavaScript / TypeScript -------------------------------------------------------------

test('a knex migration that exports only up fails', { skip }, (t) => {
  red(t, { 'migrations/20260924_users.js':
    'exports.up = (knex) => knex.schema.createTable("users", (t) => t.increments());\n' },
  /no down export or method/);
});

test('knex and TypeORM migrations with a down pass', { skip }, (t) => {
  green(t, {
    'migrations/20260924_users.js': 'exports.up = (k) => k.schema.createTable("u");\nexports.down = (k) => k.schema.dropTable("u");\n',
    'src/migration/1727_users.ts': 'export class Users1727 {\n  public async up(q) { await q.query("CREATE TABLE u (id int)"); }\n  public async down(q) { await q.query("DROP TABLE u"); }\n}\n',
  });
});

// --- the irreversible marker -------------------------------------------------------------

test('the irreversible marker with a reason passes a migration that has no down step', { skip }, (t) => {
  const out = green(t, { 'db/migrations/003_drop.up.sql':
    '-- migration-gate: irreversible: drops legacy_orders after the 2026-09 export\nDROP TABLE legacy_orders;\n' });
  assert.match(out, /marked irreversible: drops legacy_orders after the 2026-09 export/);
});

test('the irreversible marker with no reason, or misspelled, fails', { skip }, (t) => {
  red(t, { 'db/migrations/003_drop.up.sql': '-- migration-gate: irreversible:\nDROP TABLE legacy_orders;\n' },
    /marker gives no reason/);
  red(t, { 'db/migrate/20260924_drop.rb': '# migration-gate: irreversible because reasons\nclass D; def up; end; end\n' },
    /marker is misspelled/);
});

// --- what the gate leaves alone ----------------------------------------------------------

test('a diff that adds no migration passes, even with an .up.sql outside the globs', { skip }, (t) => {
  const out = green(t, {
    'src/app.py': 'print("hi")\n',
    'docs/001_notes.up.sql': 'SELECT 1;\n',
  });
  assert.match(out, /0 added file\(s\)/);
});

test('an edit to an existing migration is not judged, only an added one', { skip }, (t) => {
  green(t, { 'migrations/001_users.up.sql': 'CREATE TABLE users (id bigint);\n' },
    { before: { 'migrations/001_users.up.sql': 'CREATE TABLE users (id int);\n' } });
});

test('Django migrations and package markers are reported as not judged', { skip }, (t) => {
  const out = green(t, {
    'app/migrations/__init__.py': '',
    'app/migrations/0001_initial.py': 'from django.db import migrations, models\n\n\nclass Migration(migrations.Migration):\n    operations = []\n',
  });
  assert.match(out, /not judged\s+app\/migrations\/0001_initial\.py: Django migration/);
  assert.match(out, /not judged\s+app\/migrations\/__init__\.py/);
});

test('--path replaces the default globs', { skip }, (t) => {
  red(t, { 'schema/changes/001.up.sql': 'CREATE TABLE a (id int);\n' }, /no sibling/,
    { paths: ['schema/changes/**'] });
  green(t, { 'db/migrations/001.up.sql': 'CREATE TABLE a (id int);\n' },
    { paths: ['schema/changes/**'] });
});

// --- the reusable workflow ---------------------------------------------------------------

test("the workflow's embedded script is the committed migration_gate.py", () => {
  // The workflow runs its own copy so that a caller's @<sha> pin covers the code; the unit
  // tests above exercise the file. A drift between them means CI runs untested code.
  const r = run('node', [repoPath('.github', 'migration-gate', 'embed.js'), '--check']);
  assert.strictEqual(r.code, 0, r.stderr);
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  const stale = render(yml, fs.readFileSync(SCRIPT, 'utf8').replace('import ast', 'import ast  # x'));
  assert.notStrictEqual(stale, yml, 'the render did not change when the script did, so --check could never fail');
});

test('the workflow is callable, read-only, and pins every action to a commit', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(yml, /^ {2}workflow_call:$/m);
  assert.match(yml, /^permissions:\n {2}contents: read$/m);
  const uses = [...yml.matchAll(/^\s*- uses: (\S+)(.*)$/gm)];
  assert.ok(uses.some((m) => m[1].startsWith('actions/checkout@')), 'the workflow no longer checks out the caller');
  for (const [line, ref, comment] of uses) {
    assert.match(ref, /@[0-9a-f]{40}$/, `not pinned to a commit: ${line.trim()}`);
    assert.match(comment, /# v\d+\.\d+\.\d+/, `a SHA pin with no version comment: ${line.trim()}`);
  }
  for (const glob of ['**/migrations/**', '**/migration/**', '**/db/migrate/**']) {
    assert.ok(yml.includes(`          ${glob}\n`), `the paths default no longer lists ${glob}`);
  }
});
