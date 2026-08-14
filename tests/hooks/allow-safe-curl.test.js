// Regression guard for executable_allow-safe-curl.sh (PermissionRequest/Bash).
// Drives the ACTUAL hook and asserts it auto-allows ONLY a plain GET/HEAD curl
// against an allowlisted host, and defers (no decision) for everything else.
// Offline and deterministic. Skips cleanly without bash/jq.
//
// The case lists below are NOT the warrant. A deny-list suite is only ever evidence
// about the options someone thought of, and curl gains options every release -- so
// the load-bearing block is `structure`, which asserts the option table is an
// allowlist, that no laundering or write option was ever added to it, and that the
// single allow() call site stays behind the "we saw an allowlisted URL" guard.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_allow-safe-curl.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

function behavior(command) {
  let out;
  try {
    out = execFileSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) { out = e.stdout || ''; }
  if (!out.trim()) return null; // hook deferred to normal handling
  try { return JSON.parse(out).hookSpecificOutput.decision.behavior; } catch { return null; }
}

const ALLOW = [
  'curl http://10.0.0.161:9090/metrics',
  'curl http://10.0.0.139/api',
  'curl https://10.0.0.215/',
  'curl http://localhost:8080/health',
  'curl http://127.0.0.1:8000/',
  'curl "http://[::1]:3000/x"',              // bracketed IPv6 must be quoted, see below
  'curl HTTP://10.0.0.161/x',                // scheme is case-insensitive
  'curl http://LOCALHOST:8080/',             // so is the host
  '/usr/bin/curl -fsS http://127.0.0.1:8000/',
  'curl -sS http://localhost:8080/health',
  'curl -I https://10.0.0.215/',             // -I is a HEAD
  'curl -k https://10.0.0.161:8443/health',  // self-signed, but pinned to an allowed host
  'curl -X GET -H "Accept: application/json" http://10.0.0.139/api',
  'curl -H"X-Token: 1" http://10.0.0.161/y', // value attached to the short option
  'curl --max-time=5 http://10.0.0.161/y',   // --long=value form
  'curl -s --compressed --retry 3 http://10.0.0.161/y',
  'curl --url "http://10.0.0.161/x" -m 5',
  'curl "http://10.0.0.161:9090/api/v1/query?query=up&step=5m"',
  "curl 'http://10.0.0.161/a?b=1&c=2'",      // ? and & are literal inside quotes
  // Post-k3s reachability: a workload answers at a ClusterIP, a pod IP, or an
  // ingress hostname. None could match the exact-host list, which is why this hook
  // approved nothing at all in the week of 2026-08-07 while 148 curls prompted.
  'curl http://10.43.39.218:9090/api/v1/query',   // ClusterIP
  'curl http://10.42.0.171:3000/health',          // pod IP
  'curl https://prometheus-k8s.local.daniel-hunter.com/api/v1/query',
  'curl -sS https://jellyfin.daniel-hunter.com/health',
  // -G moves --data-urlencode into the query string, so this is a GET. It is the
  // shape roles/k8s/claude-otel/CLAUDE.md prescribes for Loki and Prometheus.
  'curl -s -G http://127.0.0.1:9090/api/v1/query --data-urlencode "query=up"',
  'curl -sG --data-urlencode "query=up" http://10.43.39.218:9090/api/v1/query',
  'curl -s --get --data-urlencode "query=up" http://127.0.0.1:9090/api/v1/query',
  'curl -sS -w "%{http_code}" https://homepage.daniel-hunter.com/',
  // The status-probe idiom: -o is admitted for /dev/null only, so the body is
  // discarded rather than written. 97 calls in the week of 2026-08-07 looked like this.
  'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9090/-/ready',
  'curl -so /dev/null -w "homepage=%{http_code}" https://homepage.daniel-hunter.com/',
  'curl --output /dev/null -w "%{http_code}" http://10.43.39.218:9090/-/ready',
  'curl --output=/dev/null -w "%{http_code}" http://127.0.0.1:9090/-/ready',
  // A backslash inside double quotes is only an escape before $ ` " \ or a newline;
  // before an `n` both characters are literal. The trailing newline on a probe format
  // is the common case, and refusing it approved the single-quoted spelling only.
  'curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:9090/-/ready',
  'curl -so /dev/null -w "homepage=%{http_code}\\n" https://homepage.daniel-hunter.com/',
  // An ESCAPED $ or backtick cannot expand, so it is text like any other.
  'curl -H "X-Literal: \\$HOME" http://10.0.0.161/x',
  'curl -w "\\`literal\\`" http://10.0.0.161/x',
];

const DEFER = [
  // The domain match is anchored to the END of the host. These are the shapes a
  // naive contains-check would hand to an attacker-controlled name.
  'curl http://daniel-hunter.com.attacker.net/x',
  'curl http://evil-daniel-hunter.com/x',
  'curl http://notdaniel-hunter.com/x',
  'curl https://prometheus-k8s.local.daniel-hunter.com.evil.net/x',
  // The CIDR arms are numeric, so a hostname that merely looks like one fails.
  'curl http://10.43.39.218.evil.com/x',
  'curl http://10.44.0.1/x',                 // adjacent range, not the cluster's
  'curl http://10.43.999.1/x',               // octet out of range
  'curl http://10.43.0/x',                   // too few octets
  // --data-urlencode without -G is a POST body, not a GET.
  'curl --data-urlencode "query=up" http://127.0.0.1:9090/api/v1/query',
  'curl -X POST --data-urlencode "q=1" http://127.0.0.1:9090/x',
  // ...and the @file form still reads a file into the request wherever it appears.
  'curl -G --data-urlencode @/etc/passwd http://127.0.0.1:9090/x',
  // -o is pinned to /dev/null. Every other target is still a disk write, in each
  // spelling the parser accepts: separate word, attached to a short cluster, and both
  // long forms. These are the cases the exception lives or dies on.
  'curl -o /home/ubuntu/.ssh/authorized_keys https://prometheus-k8s.local.daniel-hunter.com/x',
  'curl -o /tmp/x http://127.0.0.1:9090/metrics',
  'curl -so/tmp/x http://127.0.0.1:9090/metrics',
  'curl --output /tmp/x http://127.0.0.1:9090/metrics',
  'curl --output=/tmp/x http://127.0.0.1:9090/metrics',
  'curl -o /dev/null/../../tmp/x http://127.0.0.1:9090/metrics',
  'curl -o "/dev/null x" http://127.0.0.1:9090/metrics',
  // The sibling write primitives stay out of the tables altogether.
  'curl -O http://127.0.0.1:9090/metrics',
  'curl --output-dir /tmp -o /dev/null http://127.0.0.1:9090/metrics',
  // An UNescaped $ or backtick inside double quotes still expands before curl runs,
  // and still bails. Escaping is what makes the character inert, not quoting.
  'curl -H "X-Sub: $(whoami)" http://10.0.0.161/x',
  'curl -w "`whoami`" http://10.0.0.161/x',
  'curl "http://10.0.0.161/$PATH"',
  // Consuming an escaped quote must not let the closing quote go missing: this ends
  // inside an unterminated string, which is a parse the hook must not act on.
  'curl "http://10.0.0.161/x\\"',
  // Same, but with the token continuing afterwards rather than ending -- the escaped
  // quote swallows the rest of the line into the string instead of closing it.
  'curl "http://10.0.0.161/x\\" -o /tmp/y',
  // A doubled backslash escapes ITSELF, so the quote that follows really does close
  // and the options after it are read normally. -o /tmp/y is then a disk write.
  'curl "http://10.0.0.161/x\\\\" -o /tmp/y',
  // ...and an escape cannot smuggle userinfo past the authority check either.
  'curl "http://10.0.0.161\\@evil.com/x"',
  // Redirects still defeat the host check, allowlisted host or not.
  'curl -L https://prometheus-k8s.local.daniel-hunter.com/x',

  // host is not on the allowlist, in each way a substring check would miss
  'curl http://evil.com/x',
  'curl http://10.0.0.1610/x',               // allowlist entry is a prefix of this host
  'curl http://10.0.0.161.evil.com/x',
  'curl http://evil.com/10.0.0.161',         // allowed host appears only in the path
  'curl http://10.0.0.161@evil.com/x',       // userinfo: connects to evil.com
  'curl http://127.0.0.2/x',
  'curl http://10.0.0.16/x',
  'curl http://10.0.0.161:notaport/x',
  // every URL is checked, not just the first
  'curl http://10.0.0.161/x http://evil.com/y',
  'curl --url http://evil.com/x',
  'curl --url=http://evil.com/x',
  // schemes with no authority, or no authority curl would honour
  'curl file:///etc/shadow',
  'curl dict://10.0.0.161/x',
  'curl gopher://10.0.0.161/x',
  // options that make the host check a lie
  'curl -L http://10.0.0.161/x',             // an allowed host can redirect anywhere
  'curl --location http://10.0.0.161/x',
  'curl --resolve 10.0.0.161:80:1.2.3.4 http://10.0.0.161/x',
  'curl --connect-to 10.0.0.161:80:evil.com:80 http://10.0.0.161/x',
  'curl -x http://evil.com http://10.0.0.161/x',
  'curl --proxy http://evil.com http://10.0.0.161/x',
  'curl --unix-socket /var/run/docker.sock http://localhost/containers/json',
  'curl -K /tmp/cfg http://10.0.0.161/x',    // reads url/output out of a file
  'curl --config /tmp/cfg http://10.0.0.161/x',
  'curl http://10.0.0.161/x --next http://evil.com/y',
  // write primitives
  'curl -o /tmp/x http://10.0.0.161/x',
  'curl -O http://10.0.0.161/x',
  'curl -sSo /tmp/x http://10.0.0.161/x',    // hidden at the end of a short cluster
  'curl --output-dir /tmp -O http://10.0.0.161/x',
  'curl --create-dirs -o /tmp/a/b http://10.0.0.161/x',
  'curl -D /tmp/h http://10.0.0.161/x',
  'curl --trace-ascii /tmp/t http://10.0.0.161/x',
  'curl --stderr /tmp/e http://10.0.0.161/x',
  'curl "http://10.0.0.161/x" "http://10.0.0.161/y" -o out',  // allowed URLs, still writes
  // read-a-file-into-the-request primitives
  'curl -T /etc/passwd http://10.0.0.161/x',
  'curl -F file=@/etc/passwd http://10.0.0.161/x',
  'curl -d @/etc/passwd http://10.0.0.161/x',
  'curl --data-binary @/etc/passwd http://10.0.0.161/x',
  'curl -H @/etc/shadow http://10.0.0.161/x',  // -H reads a file when the value starts with @
  'curl -w @/tmp/f http://10.0.0.161/x',
  'curl -b /etc/passwd http://10.0.0.161/x',
  'curl -u admin:pw http://10.0.0.161/x',
  // methods other than GET/HEAD
  'curl -X POST http://10.0.0.161/x',
  'curl -X DELETE http://10.0.0.161/x',
  'curl --request PUT http://10.0.0.161/x',
  'curl --request=POST http://10.0.0.161/x',
  // an option this script does not name is not a decision
  'curl --zzz-unknown http://10.0.0.161/x',
  'curl -Z http://10.0.0.161/x',
  'curl -- http://10.0.0.161/x',
  // a value-taking option with its value missing would swallow the URL
  'curl -m',
  'curl --header',
  'curl --header http://10.0.0.161/x',
  // shell metacharacters: the shell expands these AFTER the decision
  'curl http://10.0.0.161/x; id',
  'curl "http://10.0.0.161/x" && id',
  'curl http://10.0.0.161/x | tee /etc/passwd',
  'curl http://10.0.0.161/x > /etc/passwd',
  'curl http://10.0.0.161/x & id',
  'curl http://10.0.0.161/x\nid',            // a newline is a separator too
  'curl $URL',
  'curl "http://10.0.0.161/${HOME}"',        // expands inside double quotes
  'curl "http://10.0.0.161/$(id)"',
  'curl http://10.0.0.161/`id`',
  'curl http://10.0.0.161/a*',               // glob: reaches curl as args never validated
  'curl http://[::1]:3000/x',                // unquoted brackets are a glob
  'curl ~/x',
  'curl "http://10.0.0.161/x',               // unbalanced quote
  // not this command at all
  'curl',
  'curl -sS',
  'curlie http://10.0.0.161/x',              // a wrapper with options nobody has read
  'env curl http://10.0.0.161/x',
  'sudo curl http://10.0.0.161/x',
  'wget http://10.0.0.161/x',
];

test('auto-allows plain GET/HEAD curl against an allowlisted host', { skip }, () => {
  for (const cmd of ALLOW) {
    assert.strictEqual(behavior(cmd), 'allow', `expected ALLOW for: ${cmd}`);
  }
});

test('defers for any other host, option, or method', { skip }, () => {
  for (const cmd of DEFER) {
    assert.strictEqual(behavior(cmd), null, `expected DEFER for: ${cmd}`);
  }
});

const src = fs.readFileSync(HOOK, 'utf8');

// The option tables are the only place an option is named, so reading them IS the
// check rather than a sample of it.
function shortTable(name) {
  const m = new RegExp(`^${name}='([^']*)'`, 'm').exec(src);
  assert.ok(m, `${name} must stay a single-quoted literal`);
  return m[1];
}
function longTable(name) {
  const fn = src.slice(src.indexOf(`${name}() {`));
  const body = /case \$1 in([\s\S]*?)return 0 ;;/.exec(fn);
  assert.ok(body, `${name} must stay a single case statement`);
  return body[1].replace(/\\\s*\n/g, ' ').split('|')
    .map(s => s.trim().replace(/\)$/, '')).filter(Boolean);
}

// An unnamed option must never be a decision, whatever it is called. This is the
// property the DEFER list can only sample.
test('defers for arbitrary unnamed options', { skip }, () => {
  const invented = ['--a', '--zz', '--out', '--data-raw', '--upload', '--socks5',
    '--proxy1.0', '--cert', '--engine', '--dump-header', '--remote-name',
    '--location-trusted', '--config-file', '--form-string', '--netrc-file'];
  for (const opt of invented) {
    const cmd = `curl ${opt} http://10.0.0.161/x`;
    assert.strictEqual(behavior(cmd), null, `expected DEFER for: ${cmd}`);
  }
  // Every ASCII letter the tables do not name, swept rather than listed, so a letter
  // added to a table without a test edit shows up here.
  const named = shortTable('BOOL_SHORT') + shortTable('VALUE_SHORT');
  for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (named.includes(c)) continue;
    const cmd = `curl -${c} http://10.0.0.161/x`;
    assert.strictEqual(behavior(cmd), null, `expected DEFER for unnamed short option: ${cmd}`);
  }
});

test('structure: the option table is an allowlist and stays one', { skip }, () => {
  // Each of these would defeat the host check or reintroduce the disk write that
  // put curl in the ask list to begin with.
  const shorts = shortTable('BOOL_SHORT') + shortTable('VALUE_SHORT');
  for (const c of 'LOJdFTKbux') {
    assert.ok(!shorts.includes(c), `-${c} must not be in a short-option table (found in "${shorts}")`);
  }
  const longs = new Set([...longTable('long_bool'), ...longTable('long_value')]);
  for (const opt of ['location', 'location-trusted', 'resolve', 'connect-to', 'proxy',
    'preproxy', 'unix-socket', 'abstract-unix-socket', 'config', 'next',
    'output-dir', 'remote-name', 'remote-header-name', 'create-dirs', 'dump-header',
    'trace', 'trace-ascii', 'stderr', 'upload-file', 'data', 'data-binary', 'data-raw',
    'form', 'form-string', 'cookie', 'cookie-jar', 'user', 'netrc', 'netrc-file']) {
    assert.ok(!longs.has(opt), `--${opt} must not be in a long-option table`);
  }

  // -o/--output is the ONE write primitive admitted, and only for the literal
  // /dev/null (DECIDED 2026-08-14: 67 status probes a week were refused for this
  // option alone, and -I is not a substitute -- it still prints response headers).
  // The invariant did not go away, it narrowed: the exception has to stay pinned to
  // that exact value, so assert the pin rather than the option's absence.
  assert.ok(shorts.includes('o'), '-o is admitted deliberately; see check_value');
  assert.ok(longs.has('output'), '--output is admitted deliberately; see check_value');
  const pin = /output \| o\)\s*\n\s*\[\[ \$value == \/dev\/null \]\] \|\| return 1/.exec(src);
  assert.ok(pin, '-o/--output must be pinned to exactly /dev/null in check_value');

  // One allow() call site, and it only runs once a URL has been checked. Without
  // this guard `curl -sS` alone would auto-approve.
  const callSites = src.match(/^[^#\n]*\ballow\b\s*$/gm) || [];
  assert.deepStrictEqual(callSites.map(s => s.trim()), ['((SAW_URL == 1)) && allow']);

  // The host list is pinned so widening it is a deliberate edit here too.
  const hosts = /ALLOWED_HOSTS=\(([\s\S]*?)\n\)/.exec(src);
  assert.ok(hosts, 'ALLOWED_HOSTS must stay a literal array');
  const entries = hosts[1].split('\n').map(l => l.replace(/#.*/, '').trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepStrictEqual(entries, [
    'localhost', '127.0.0.1', '[::1]', '10.0.0.161', '10.0.0.139', '10.0.0.215',
  ]);

  // Nothing in here turns command text back into commands.
  assert.ok(!/\b(eval|exec)\b/.test(src), 'the hook must not eval or exec');
});
