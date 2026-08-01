// Regression guard for executable_statusline-command.sh (the per-turn status line).
// Feeds fixture stdin JSON through the ACTUAL script and asserts the rendered segments.
// Offline. Skips cleanly if bash/jq are unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'home', 'private_dot_claude', 'executable_statusline-command.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

// COLUMNS is pinned wide so segment assertions stay on one line regardless of the runner's
// terminal; the wrapping tests below set it themselves.
function run(input, columns = '400') {
  const r = spawnSync('bash', [SCRIPT], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, COLUMNS: columns },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('full fixture renders cwd, model, and cost/usage segments', { skip }, () => {
  const fixture = {
    workspace: { current_dir: '/tmp/fixture-project/alpha/beta/gamma' },
    model: { id: 'claude-sonnet-4-6-20250514', display_name: 'Claude Sonnet 4.6' },
    context_window: { used_percentage: 42 },
    session_name: 'my-session',
    vim: { mode: 'NORMAL' },
    worktree: { name: 'feature-branch' },
    effort: { level: 'high' },
    rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 20 } },
    cost: { total_cost_usd: 1.23, total_lines_added: 10, total_lines_removed: 2, total_duration_ms: 65000 },
    transcript_path: '',
    session_id: '',
  };
  const { status, stdout, stderr } = run(fixture);
  assert.strictEqual(status, 0);
  assert.ok(!stderr.includes('jq:'), `no jq error text on stderr: ${stderr}`);
  assert.ok(stdout.includes('…/alpha/beta/gamma'), 'truncated cwd (last 3 segments) present');
  assert.ok(stdout.includes('sonnet4.6'), 'model id mapped to compact label');
  assert.ok(stdout.includes('my-session'), 'session name segment present');
  assert.ok(stdout.includes('NORMAL'), 'vim mode segment present');
  assert.ok(stdout.includes('feature-branch'), 'worktree name segment present');
  assert.ok(stdout.includes('high'), 'non-default effort level segment present');
  assert.ok(stdout.includes('ctx:42%'), 'context usage segment present');
  assert.ok(stdout.includes('5h:10%'), '5-hour rate limit segment present');
  assert.ok(stdout.includes('7d:20%'), '7-day rate limit segment present');
  assert.ok(stdout.includes('$1.23'), 'session cost segment present');
  assert.ok(stdout.includes('+10') && stdout.includes('-2'), 'lines-changed segment present');
  assert.ok(stdout.includes('1m'), 'session duration segment present');
});

test('minimal/missing-fields JSON does not crash and falls back sanely', { skip }, () => {
  const { status, stdout, stderr } = run({});
  assert.strictEqual(status, 0, `script should exit 0 even with no fields: ${stderr}`);
  assert.ok(!stderr.includes('jq:'), `no jq error text on stderr: ${stderr}`);
  assert.ok(stdout.includes('Claude'), 'falls back to the default model label "Claude"');
  // Segments gated on optional fields (ctx usage, cost, lines changed, duration) must be
  // omitted rather than crash when their inputs are absent.
  assert.ok(!stdout.includes('ctx:'), 'context usage segment omitted without context_window');
  assert.ok(!stdout.includes('$'), 'cost segment omitted without cost.total_cost_usd');
});

test('branch segment appears when cwd is inside a real git repo', { skip }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-git-'));
  try {
    execFileSync('git', ['-C', repoDir, 'init', '-q']);
    const branch = execFileSync('git', ['-C', repoDir, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

    const { status, stdout, stderr } = run({ workspace: { current_dir: repoDir }, model: { id: 'claude-opus-4-6' } });
    assert.strictEqual(status, 0, `script should exit 0 inside a git repo: ${stderr}`);
    assert.ok(stdout.includes(branch), `branch name "${branch}" surfaced in the status line`);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// --- context segment: real window, not the CLI's understated context_window_size ---------------
// The payload's used_percentage divides by context_window_size, which the CLI derives from a
// compiled model table. Models absent from it (claude-opus-5 in 2.1.218) fall back to 200000, so
// a 1M session reads ctx:100% at a fifth of its real usage. These pin the recomputation.

const GREEN = '\x1b[38;2;166;227;161m';
const YELLOW = '\x1b[38;2;249;226;175m';
const RED = '\x1b[38;2;243;139;168m';

// The override is read from the ambient environment, so every case sets it explicitly —
// otherwise these assertions flip depending on the developer's own shell. XDG_CACHE_HOME is
// redirected per call for the same reason, and so that the learned-window cache these cases
// write never touches the developer's real one.
function runCtx({ model, tokens, size, pctOverride, compactWindow }) {
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-ctx-'));
  try {
    const env = { ...process.env, XDG_CACHE_HOME: cacheHome };
    if (pctOverride === undefined) delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    else env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(pctOverride);
    if (compactWindow === undefined) delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    else env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(compactWindow);
    const input = JSON.stringify({
      model: { id: model },
      context_window: { total_input_tokens: tokens, context_window_size: size },
    });
    const r = spawnSync('bash', [SCRIPT], { input, encoding: 'utf8', env });
    return r.stdout || '';
  } finally {
    fs.rmSync(cacheHome, { recursive: true, force: true });
  }
}

test('opus-5 uses its real 1M window, not the payload 200k fallback', { skip }, () => {
  // 403,481 tokens is the largest request observed in this user's transcripts.
  const out = runCtx({ model: 'claude-opus-5', tokens: 403481, size: 200000 });
  assert.ok(out.includes('ctx:40%'), `expected 40% of 1M, got: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('ctx:100%'), 'must not pin at 100% on the understated window');
  assert.ok(out.includes(`${GREEN}ctx:40%`), 'well clear of compaction, so green');
});

test('a genuine 200k model still reports against 200k', { skip }, () => {
  const out = runCtx({ model: 'claude-sonnet-4-6', tokens: 150000, size: 200000 });
  assert.ok(out.includes('ctx:75%'), `expected 75% of 200k, got: ${JSON.stringify(out)}`);
  assert.ok(out.includes(`${YELLOW}ctx:75%`), 'approaching the compaction point, so yellow');
});

test('red tier is reachable and tracks the real compaction threshold', { skip }, () => {
  // With the 85% override, a 1M window compacts at 833,000 tokens (83%), so 85% is past it.
  const out = runCtx({ model: 'claude-opus-5', tokens: 850000, size: 200000, pctOverride: 85 });
  assert.ok(out.includes(`${RED}ctx:85%`), `expected red at/after compaction, got: ${JSON.stringify(out)}`);
});

test('unknown future model escalates when tokens exceed the declared window', { skip }, () => {
  // A request cannot exceed its own window, so 300k against a declared 200k proves the
  // declared size wrong. Degrade to the 1M tier rather than pinning the bar at 100%.
  const out = runCtx({ model: 'claude-opus-9', tokens: 300000, size: 200000 });
  assert.ok(out.includes('ctx:30%'), `expected escalation to the 1M tier, got: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('ctx:100%'), 'must not pin at 100% for an unrecognised model');
});

test('unknown model within its declared window trusts the payload size', { skip }, () => {
  const out = runCtx({ model: 'claude-opus-9', tokens: 100000, size: 200000 });
  assert.ok(out.includes('ctx:50%'), `expected 50% of the declared 200k, got: ${JSON.stringify(out)}`);
});

function label(id) {
  const r = spawnSync('bash', [SCRIPT], {
    input: JSON.stringify({ model: { id, display_name: 'Fallback Name' } }), encoding: 'utf8',
  });
  return (r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
}

test('model labels are derived per family, including releases postdating the script', { skip }, () => {
  const cases = [
    ['claude-opus-5', 'opus5'],
    ['claude-opus-4-8', 'opus4.8'],
    ['claude-opus-4-5', 'opus4.5'],
    ['claude-sonnet-5', 'sonnet5'],
    ['claude-sonnet-4-6', 'sonnet4.6'],
    ['claude-fable-5', 'fable5'],
    ['claude-mythos-5', 'mythos5'],
    ['claude-haiku-4-5-20251001', 'haiku4.5'],   // trailing date stamp is not a version part
    ['claude-3-5-sonnet', 'sonnet'],             // legacy id: version precedes the family
    ['opus[1m]', 'opus'],
    ['claude-opus-6', 'opus6'],                  // unreleased; must work with no code change
    ['claude-sonnet-5-2', 'sonnet5.2'],
  ];
  for (const [id, want] of cases) {
    assert.ok(new RegExp(`\\b${want.replace('.', '\\.')}\\b`).test(label(id)),
      `${id} should render as "${want}", got: ${JSON.stringify(label(id).trim())}`);
  }
  // "claude-opus-4-5" also contains "-5"; the derivation must not collapse it to opus5.
  assert.ok(!/\bopus5\b/.test(label('claude-opus-4-5')), 'opus-4-5 must not be mislabelled opus5');
  // A family this script does not know falls back to the payload's display name.
  assert.ok(label('some-other-vendor-model').includes('Fallback Name'), 'unknown family falls back');
});

test('colour tiers follow CLAUDE_CODE_AUTO_COMPACT_WINDOW, not the real window', { skip }, () => {
  // The deployed config sets window=726000 + pct=85, so the client compacts at
  // min(floor(706000*0.85), 706000-13000) = 600100 — 60% of the real 1M window.
  // Without honouring the env var the bar would put red at 83% and miss it entirely.
  const at = (tokens) => runCtx({
    model: 'claude-opus-5', tokens, size: 200000, pctOverride: 85, compactWindow: 726000,
  });
  assert.ok(at(650000).includes(`${RED}ctx:65%`), 'past the 60% compaction point is red');
  assert.ok(at(550000).includes(`${YELLOW}ctx:55%`), 'approaching it is yellow');
  assert.ok(at(300000).includes(`${GREEN}ctx:30%`), 'well below it is green');
  // The percentage itself stays a fraction of the real window, not of the compaction window.
  assert.ok(at(600000).includes('ctx:60%'), '600k of 1M reads as 60%, not 82%');
});

test('a compaction window larger than the real one is ignored', { skip }, () => {
  // PY clamps to min(real, configured), so a too-large value must not inflate the threshold.
  const out = runCtx({
    model: 'claude-sonnet-4-6', tokens: 150000, size: 200000, pctOverride: 85, compactWindow: 726000,
  });
  assert.ok(out.includes(`${YELLOW}ctx:75%`), `200k model keeps its own threshold, got: ${JSON.stringify(out.trim())}`);
});

test('an unknown model learns its real window from proof, and remembers it', { skip }, () => {
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-ctx-'));
  try {
    const env = { ...process.env, XDG_CACHE_HOME: cacheHome };
    delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    const render = (tokens) => {
      const r = spawnSync('bash', [SCRIPT], {
        input: JSON.stringify({
          model: { id: 'claude-newfamily-9' },
          context_window: { total_input_tokens: tokens, context_window_size: 200000 },
        }),
        encoding: 'utf8', env,
      });
      return r.stdout || '';
    };

    // 300k tokens against a declared 200k window is proof the declared size is wrong.
    assert.ok(render(300000).includes('ctx:30%'), 'escalates to the 1M tier on proof');

    const cacheFile = path.join(cacheHome, 'claude-statusline', 'context-windows');
    assert.ok(fs.existsSync(cacheFile), 'escalation is persisted');
    assert.match(fs.readFileSync(cacheFile, 'utf8'), /claude-newfamily-9\t1000000/);

    // The correction must now hold from token 0, not only after re-crossing 200k.
    assert.ok(render(100000).includes('ctx:10%'),
      'remembered window applies below the crossover (would be 50% without the cache)');
  } finally {
    fs.rmSync(cacheHome, { recursive: true, force: true });
  }
});

test('a genuinely 200k unknown model is not escalated without proof', { skip }, () => {
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-ctx-'));
  try {
    const env = { ...process.env, XDG_CACHE_HOME: cacheHome };
    delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    const r = spawnSync('bash', [SCRIPT], {
      input: JSON.stringify({
        model: { id: 'claude-newfamily-8' },
        context_window: { total_input_tokens: 100000, context_window_size: 200000 },
      }),
      encoding: 'utf8', env,
    });
    assert.ok((r.stdout || '').includes('ctx:50%'), 'trusts the declared window absent contrary evidence');
    assert.ok(!fs.existsSync(path.join(cacheHome, 'claude-statusline', 'context-windows')),
      'nothing is written when no escalation occurred');
  } finally {
    fs.rmSync(cacheHome, { recursive: true, force: true });
  }
});

// Wrapping. Claude Code truncates any status line row wider than the terminal rather than
// wrapping it, so segments that don't fit must be moved to a row of their own by the script.
const WIDE_FIXTURE = {
  workspace: { current_dir: '/tmp/fixture-project/alpha/beta/gamma' },
  model: { id: 'claude-sonnet-4-6-20250514' },
  context_window: { used_percentage: 42 },
  session_name: 'my-session',
  vim: { mode: 'NORMAL' },
  worktree: { name: 'feature-branch' },
  effort: { level: 'high' },
  rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 20 } },
  cost: { total_cost_usd: 1.23, total_lines_added: 10, total_lines_removed: 2, total_duration_ms: 65000 },
};

for (const columns of ['40', '60', '80', '120']) {
  test(`no rendered row exceeds COLUMNS=${columns}`, { skip }, () => {
    const { stdout } = run(WIDE_FIXTURE, columns);
    for (const line of stdout.split('\n')) {
      assert.ok(stripAnsi(line).length < Number(columns),
        `row wider than the terminal: ${stripAnsi(line).length} >= ${columns}`);
    }
    // Rows cost viewport, and the narrowest terminals are the ones with least to spare.
    // Pins the count so a future segment can't quietly grow the status line to a paragraph.
    assert.ok(stdout.split('\n').length <= 4,
      `status line grew to ${stdout.split('\n').length} rows at ${columns} columns`);
  });
}

test('wrapping preserves every segment and splits only between them', { skip }, () => {
  const wide = stripAnsi(run(WIDE_FIXTURE, '400').stdout);
  assert.ok(!wide.includes('\n'), 'a wide terminal still renders a single row');

  const narrow = run(WIDE_FIXTURE, '40').stdout;
  assert.ok(narrow.includes('\n'), 'a narrow terminal wraps onto more than one row');
  assert.strictEqual(stripAnsi(narrow).split('\n').join(''), wide,
    'joined rows reproduce the unwrapped line exactly — nothing dropped or reordered');
  // A break inside a segment would leave an orphaned SGR sequence on the next row.
  for (const line of narrow.split('\n')) {
    assert.ok(!line.startsWith('\x1b[0m'), `row starts mid-segment: ${JSON.stringify(line)}`);
  }
});

test('no trailing newline, which would render as a blank status row', { skip }, () => {
  assert.ok(!run(WIDE_FIXTURE, '40').stdout.endsWith('\n'));
});

test('a segment wider than the whole terminal is truncated, not left to overflow', { skip }, () => {
  const deep = '/tmp/' + ['a', 'b', 'c'].map((ch) => ch.repeat(30)).join('/');
  const { stdout } = run({ workspace: { current_dir: deep }, model: { id: 'claude-opus-5' } }, '20');
  const rows = stdout.split('\n').map(stripAnsi);
  assert.ok(rows.every((l) => l.length < 20), `rows: ${JSON.stringify(rows)}`);
  assert.ok(rows[0].endsWith('…'), 'the over-wide path segment is ellipsised');
});

test('truncating an over-wide segment never splits a character', { skip }, () => {
  // Under a non-UTF-8 locale bash slices by byte, so the cut can land inside a sequence.
  const deep = '/tmp/' + ['α', 'β', 'γ'].map((ch) => ch.repeat(20)).join('/');
  for (const LC_ALL of ['C.UTF-8', 'C']) {
    for (const COLUMNS of ['20', '24', '28']) {
      const r = spawnSync('bash', [SCRIPT], {
        input: JSON.stringify({ workspace: { current_dir: deep }, model: { id: 'claude-opus-5' } }),
        env: { ...process.env, LC_ALL, COLUMNS },
      });
      const row = r.stdout.toString('binary');
      assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(r.stdout),
        `invalid UTF-8 at LC_ALL=${LC_ALL} COLUMNS=${COLUMNS}: ${JSON.stringify(row)}`);
    }
  }
});

test('an unset or garbage COLUMNS falls back to a sane width instead of one column', { skip }, () => {
  for (const columns of [undefined, '', 'not-a-number', '0']) {
    const env = { ...process.env };
    if (columns === undefined) delete env.COLUMNS; else env.COLUMNS = columns;
    const r = spawnSync('bash', [SCRIPT], { input: JSON.stringify(WIDE_FIXTURE), encoding: 'utf8', env });
    const rows = (r.stdout || '').split('\n').map(stripAnsi);
    assert.strictEqual(r.status, 0, `COLUMNS=${JSON.stringify(columns)} should not crash`);
    assert.ok(rows.some((l) => l.length > 40),
      `COLUMNS=${JSON.stringify(columns)} degraded to a tiny width: ${JSON.stringify(rows)}`);
  }
});

test('falls back to used_percentage when the raw token count is absent', { skip }, () => {
  const r = spawnSync('bash', [SCRIPT], {
    input: JSON.stringify({ model: { id: 'claude-opus-5' }, context_window: { used_percentage: 42 } }),
    encoding: 'utf8',
  });
  assert.ok((r.stdout || '').includes('ctx:42%'), 'older payload shape still renders');
});
