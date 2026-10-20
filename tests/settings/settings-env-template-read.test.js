// Pins the Read() denies that replaced `Read(**/.env.*)`: the committed templates
// `.env.example`, `.env.sample` and `.env.template` are readable, and every other
// `.env.<suffix>` stays denied.
//
// Claude Code compiles each Read() deny twice, once with the `ignore` package for the Read
// tool and once into a Seatbelt regex for the sandbox's read deny. `globRegex` below is
// that second compiler, copied from Claude Code 2.1.282 (`fu`, then `C0`'s `(/.*)?$`
// suffix). It escapes `^`, so a negated class compiles to a positive one; the shape test
// below keeps every class positive and free of a leading `!`, which `ignore` reads as a
// negation.
//
// Both layers match case-insensitively, which is why each letter is written `[eE]`. `denied`
// runs every name through both flags and requires them to agree.
//
// JS cannot model one Seatbelt fault: measured with sandbox-exec, a range that crosses from
// upper to lower case (`[F-d]`, `[Z-a]`) matches `e`. The last test pins every range inside
// one band that crosses no case boundary. The same corpus was run through sandbox-exec
// against the rendered rules, and the live check after `chezmoi apply` is the final word.
const { test } = require('node:test');
const assert = require('node:assert');
const { renderFile, chezmoiAvailable } = require('../lib/render');
const { srcPath } = require('../lib/paths');

const TMPL = srcPath('.chezmoitemplates', 'settings.base.json');
const skip = chezmoiAvailable ? false : 'chezmoi unavailable';

function globRegex(glob, flags) {
  const body = glob
    .replace(/[.^$+{}()|\\]/g, '\\$&')
    .replace(/\[([^\]]*?)$/g, '\\[$1')
    .replace(/\*\*\//g, '__GLOBSTAR_SLASH__')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/__GLOBSTAR_SLASH__/g, '(.*/)?')
    .replace(/__GLOBSTAR__/g, '.*');
  return new RegExp(`^${body}(/.*)?$`, flags);
}

let envRules = null;
function envDenies() {
  if (envRules) return envRules;
  const deny = JSON.parse(renderFile(TMPL)).permissions.deny;
  envRules = deny
    .map((r) => /^Read\((.*)\)$/.exec(r))
    .filter((m) => m && m[1].startsWith('**/.env'))
    .map((m) => m[1]);
  return envRules;
}

function denied(name) {
  const p = `/Users/x/Repositories/airflow/.claude/worktrees/cap-click/${name}`;
  const sandbox = envDenies().some((g) => globRegex(g, '').test(p));
  const readTool = envDenies().some((g) => globRegex(g, 'i').test(p));
  assert.strictEqual(sandbox, readTool, `the two layers disagree on ${name}`);
  return sandbox;
}

test('the committed env templates are readable', { skip }, () => {
  // Upper case names the same file on APFS, so it is allowed too.
  const names = ['.env.example', '.env.sample', '.env.template', '.env.EXAMPLE', 'sub/dir/.env.example'];
  for (const name of names) assert.ok(!denied(name), `denied: ${name}`);
});

test('every other .env file stays denied', { skip }, () => {
  const names = [
    '.env', '.env.', '.env.local', '.env.production', '.env.development', '.env.staging',
    '.env.test', '.env.prod2', '.env.dev.local', '.env.LOCAL', '.env.e', '.env.exampl',
    '.env.examples', '.env.example.local', '.env.example2', '.env.exbmple', '.env.Exzz',
    '.env.s', '.env.sample2', '.env.samples', '.env.t', '.env.templat', '.env.template.bak',
    '.env.~', '.env. space', '.env.{x', '.env.[x', '.env.@', '.env.`x', '.env.z', '.env.Z',
    '.env.0', 'sub/dir/.env.local', '.env.local/inner',
  ];
  for (const name of names) assert.ok(denied(name), `readable: ${name}`);
});

test('no class range crosses a case boundary, which Seatbelt misreads', { skip }, () => {
  const bands = [[' ', '@'], ['A', 'Z'], ['[', '`'], ['a', 'z'], ['{', '~']];
  for (const g of envDenies()) {
    for (const cls of g.match(/\[[^\]]*\]/g) || []) {
      for (const [, from, to] of cls.slice(1, -1).matchAll(/(.)-(.)/g)) {
        const ok = bands.some(([lo, hi]) => from >= lo && to <= hi);
        assert.ok(ok, `range ${from}-${to} in ${g} crosses a band`);
      }
    }
  }
});

test('every character class is positive, so both compilers read it the same way', { skip }, () => {
  assert.ok(envDenies().length > 2, 'found the .env Read() denies');
  for (const g of envDenies()) {
    for (const cls of g.match(/\[[^\]]*\]/g) || []) {
      assert.doesNotMatch(cls, /^\[[!^]/, `negated class in ${g}`);
    }
  }
});
