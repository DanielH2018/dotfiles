// Behavioral tests for `spares` (executable_spares) — the process-level counterpart to
// agentview.
//
// `ps` cannot answer "is this a working session or an idle spare?". A claimed session
// KEEPS its `--bg-spare` argv after the claim socket is consumed, so every argv scan
// reports live sessions as spares. The daemon roster is the only oracle — but its `pid`
// field is the bg-pty-host, NOT the bg-spare worker underneath it, so joining on pid
// silently misclassifies claimed workers as unclaimed. The join must go through the spare
// id embedded in both socket paths (<id>.pty.sock / <id>.claim.sock).
//
// Seams: SPARES_PROC_DIR (a fake /proc, so no real process is read), SPARES_ROSTER.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { skipUnless } = require('./lib/probe');

const SPARES = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_spares');

const skip = skipUnless('bash', 'jq');

const PAGE_SIZE = (() => {
  try { return Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim()) || 4096; } catch { return 4096; }
})();

const SOCKDIR = '/tmp/cc-daemon-1000/e5567515/spare';
const worker = (id) => `claude bg-spare --bg-spare ${SOCKDIR}/${id}.claim.sock`;
// The real pty-host argv carries the worker's own `--bg-spare` flag after a `--`, so a
// classifier that tests for `--bg-spare` first counts every pty-host as a second worker.
const ptyHost = (id) =>
  `claude bg-pty-host --bg-pty-host ${SOCKDIR}/${id}.pty.sock 200 50 ` +
  `-- /home/daniel/.local/share/claude/versions/2.1.218 --bg-spare ${SOCKDIR}/${id}.claim.sock`;

// A roster entry as the daemon writes it: `pid` is the PTY-HOST, and the only link to the
// worker process is ptySock's spare id.
const rosterEntry = (ptyHostPid, id, { sessionId = `${id}-sess`, cwd = '/home/daniel/dev', name } = {}) => ({
  pid: ptyHostPid,
  sessionId,
  ptySock: `${SOCKDIR}/${id}.pty.sock`,
  cwd,
  dispatch: { source: 'spare', seed: name ? { name } : { intent: '' } },
});

// procs: { pid: { cmd, rssKb } } — written as a fake /proc tree.
// roster: { shortId: entry } | null (null = no roster file at all)
// sessions: { workerPid: { name, status } } — the sessions dir is keyed by WORKER pid,
//           which is the pid the roster does not carry.
function fakeEnv({ procs = {}, roster = {}, sessions = {} }) {
  const home = scratch(os.tmpdir(), 'spares-');
  const pdir = path.join(home, 'proc');
  fs.mkdirSync(pdir, { recursive: true });
  const sdir = path.join(home, 'sessions');
  if (sessions !== null) {
    fs.mkdirSync(sdir, { recursive: true });
    for (const [pid, s] of Object.entries(sessions)) {
      fs.writeFileSync(path.join(sdir, `${pid}.json`), JSON.stringify({ pid: Number(pid), ...s }));
    }
  }
  for (const [pid, spec] of Object.entries(procs)) {
    const d = path.join(pdir, pid);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'cmdline'), spec.cmd.split(' ').join('\0') + '\0');
    // statm: size resident shared text lib data dt — resident is field 2, in pages.
    // Sized with the page size the script will multiply back by (`getconf PAGESIZE`), not a
    // hardcoded 4096: on a real Linux box those agree, but this fixture runs anywhere, and on
    // a 16K-page host (arm64 macOS, and Linux built with CONFIG_ARM64_16K_PAGES) a 4096 fixture
    // reports 4x the rss the test asked for.
    const pages = Math.round((spec.rssKb ?? 4) * 1024 / PAGE_SIZE);
    fs.writeFileSync(path.join(d, 'statm'), `99999 ${pages} 0 0 0 0 0\n`);
  }
  const rosterPath = path.join(home, 'roster.json');
  if (roster !== null) fs.writeFileSync(rosterPath, JSON.stringify({ proto: 1, workers: roster }));
  return { pdir, rosterPath, sdir };
}

function run({ procs, roster, sessions, args = [] }) {
  const { pdir, rosterPath, sdir } = fakeEnv({ procs, roster, sessions });
  const res = { code: 0, stdout: '', stderr: '' };
  try {
    res.stdout = execFileSync('bash', [SPARES, ...args], {
      env: {
        ...process.env,
        SPARES_PROC_DIR: pdir, SPARES_ROSTER: rosterPath, SPARES_SESSIONS_DIR: sdir,
      },
      encoding: 'utf8',
    });
  } catch (e) {
    res.code = e.status ?? 1;
    res.stdout = e.stdout ?? '';
    res.stderr = e.stderr ?? '';
  }
  return res;
}

const asJson = (r) => JSON.parse(r.stdout);
const rowFor = (rows, id) => rows.find((x) => x.spare === id);

test('classifies a spare id present in the roster as claimed', { skip }, () => {
  const r = run({
    procs: { 200: { cmd: worker('aaaa1111') }, 100: { cmd: ptyHost('aaaa1111') } },
    roster: { s1: rosterEntry(100, 'aaaa1111') },
    args: ['--json'],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(rowFor(asJson(r).rows, 'aaaa1111').state, 'claimed');
});

test('classifies a spare id absent from the roster as an unclaimed spare', { skip }, () => {
  const r = run({
    procs: { 200: { cmd: worker('bbbb2222') }, 100: { cmd: ptyHost('bbbb2222') } },
    roster: {},
    args: ['--json'],
  });
  assert.equal(rowFor(asJson(r).rows, 'bbbb2222').state, 'spare');
});

// The regression this tool exists to prevent: the roster's `pid` is the pty-host, so a
// pid-keyed join finds no match for the worker and reports a live session as idle.
test('joins on spare id, not pid, so a claimed worker is never reported as a spare', { skip }, () => {
  const r = run({
    procs: { 114408: { cmd: worker('d96b3760') }, 114336: { cmd: ptyHost('d96b3760') } },
    roster: { eb734fd7: rosterEntry(114336, 'd96b3760') }, // pid 114336 != worker 114408
    args: ['--json'],
  });
  const row = rowFor(asJson(r).rows, 'd96b3760');
  assert.equal(row.state, 'claimed');
  assert.equal(row.pid, 114408, 'row must report the worker pid');
  assert.equal(row.ptyHostPid, 114336);
});

test('reports the session id, name and cwd from the roster', { skip }, () => {
  const r = run({
    procs: { 200: { cmd: worker('cccc3333') }, 100: { cmd: ptyHost('cccc3333') } },
    roster: { s1: rosterEntry(100, 'cccc3333', { sessionId: 'abc-123', cwd: '/srv/app', name: 'TQ Githooks' }) },
    args: ['--json'],
  });
  const row = rowFor(asJson(r).rows, 'cccc3333');
  assert.equal(row.session, 'abc-123');
  assert.equal(row.name, 'TQ Githooks');
  assert.equal(row.cwd, '/srv/app');
});

test('counts claimed and unclaimed separately in the summary', { skip }, () => {
  const r = run({
    procs: {
      201: { cmd: worker('aaaa1111') }, 101: { cmd: ptyHost('aaaa1111') },
      202: { cmd: worker('bbbb2222') }, 102: { cmd: ptyHost('bbbb2222') },
      203: { cmd: worker('cccc3333') }, 103: { cmd: ptyHost('cccc3333') },
    },
    roster: { s1: rosterEntry(101, 'aaaa1111'), s2: rosterEntry(102, 'bbbb2222') },
    args: ['--json'],
  });
  const out = asJson(r);
  assert.equal(out.summary.claimed, 2);
  assert.equal(out.summary.spare, 1);
});

test('sums rss per state so idle spares can be costed', { skip }, () => {
  const r = run({
    procs: {
      201: { cmd: worker('aaaa1111'), rssKb: 500 * 1024 }, 101: { cmd: ptyHost('aaaa1111'), rssKb: 100 * 1024 },
      202: { cmd: worker('bbbb2222'), rssKb: 400 * 1024 }, 102: { cmd: ptyHost('bbbb2222'), rssKb: 100 * 1024 },
    },
    roster: { s1: rosterEntry(101, 'aaaa1111') },
    args: ['--json'],
  });
  const out = asJson(r);
  assert.equal(rowFor(out.rows, 'aaaa1111').rssKb, 500 * 1024);
  // an unclaimed spare costs its worker + its pty-host
  assert.equal(out.summary.spareRssKb, 500 * 1024);
});

// Reporting everything as "spare" with no roster would be the exact dangerous wrong answer.
test('marks state unknown and fails when the roster is unreadable', { skip }, () => {
  const r = run({
    procs: { 200: { cmd: worker('bbbb2222') }, 100: { cmd: ptyHost('bbbb2222') } },
    roster: null,
    args: ['--json'],
  });
  assert.notEqual(r.code, 0, 'must not exit 0 when it cannot classify');
  assert.equal(rowFor(asJson(r).rows, 'bbbb2222').state, 'unknown');
});

test('emits no rows when no bg-spare processes exist', { skip }, () => {
  const r = run({ procs: { 1: { cmd: '/sbin/init' } }, roster: {}, args: ['--json'] });
  const out = asJson(r);
  assert.equal(out.rows.length, 0);
  assert.equal(out.summary.claimed, 0);
  assert.equal(out.summary.spare, 0);
});

test('ignores a pty-host that has no bg-spare worker under it', { skip }, () => {
  const r = run({
    procs: { 100: { cmd: ptyHost('dddd4444') } },
    roster: {},
    args: ['--json'],
  });
  assert.equal(asJson(r).rows.length, 0, 'rows are keyed on live workers, not sockets');
});

// The sessions dir is keyed by worker pid — the one id the roster never carries — so this
// only resolves once the pty-host/worker join is right.
test('reports session name and status from the sessions dir, keyed by worker pid', { skip }, () => {
  const r = run({
    procs: { 114408: { cmd: worker('d96b3760') }, 114336: { cmd: ptyHost('d96b3760') } },
    roster: { eb734fd7: rosterEntry(114336, 'd96b3760') },
    sessions: { 114408: { name: 'TQ Githooks', status: 'busy' } },
    args: ['--json'],
  });
  const row = rowFor(asJson(r).rows, 'd96b3760');
  assert.equal(row.name, 'TQ Githooks');
  assert.equal(row.status, 'busy');
});

test('leaves status null when the sessions dir has no entry for the worker', { skip }, () => {
  const r = run({
    procs: { 200: { cmd: worker('aaaa1111') }, 100: { cmd: ptyHost('aaaa1111') } },
    roster: { s1: rosterEntry(100, 'aaaa1111') },
    sessions: {},
    args: ['--json'],
  });
  assert.equal(rowFor(asJson(r).rows, 'aaaa1111').status, null);
});

test('counts busy and idle claimed sessions in the summary', { skip }, () => {
  const r = run({
    procs: {
      201: { cmd: worker('aaaa1111') }, 101: { cmd: ptyHost('aaaa1111') },
      202: { cmd: worker('bbbb2222') }, 102: { cmd: ptyHost('bbbb2222') },
    },
    roster: { s1: rosterEntry(101, 'aaaa1111'), s2: rosterEntry(102, 'bbbb2222') },
    sessions: { 201: { name: 'A', status: 'busy' }, 202: { name: 'B', status: 'idle' } },
    args: ['--json'],
  });
  const out = asJson(r);
  assert.equal(out.summary.busy, 1);
  assert.equal(out.summary.idle, 1);
});

test('default output is a human table naming both states', { skip }, () => {
  const r = run({
    procs: {
      201: { cmd: worker('aaaa1111') }, 101: { cmd: ptyHost('aaaa1111') },
      202: { cmd: worker('bbbb2222') }, 102: { cmd: ptyHost('bbbb2222') },
    },
    roster: { s1: rosterEntry(101, 'aaaa1111', { name: 'Some Session' }) },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /aaaa1111.*claimed/);
  assert.match(r.stdout, /bbbb2222.*spare/);
  assert.match(r.stdout, /Some Session/);
});
