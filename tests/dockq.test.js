// Regression guard for home/dot_local/bin/executable_dockq.
// dockq carries a blanket `Bash(dockq:*)` allow rule on the unsandboxed path, and that rule
// is defensible only while the verbs stay a closed set of reads and `inspect` can never
// print Config.Env, and while the caller's environment cannot choose the docker binary or
// daemon. dockq looks docker up in fixed directories, never $PATH, so the tests load it as a
// module and point DOCKER_DIRS at a fake `docker` that prints the argv it was given. An
// empty stdout proves docker was never started. For `inspect` the fake goes further: it holds a
// container whose environment carries a canary, prints all of it when no --format is given,
// and otherwise renders `{{json .Path}}` against it -- so the test sees what a real daemon
// would return, not just the template.
// The registry verbs, `tags` and `digest`, are tested against a fake registry further down.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');
const { run } = require('./lib/run');

const DOCKQ = srcPath('dot_local', 'bin', 'executable_dockq');

let skip = false;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
} catch {
  skip = 'python3 unavailable';
}

const CANARY = 'DB_PASSWORD=canary-7f3a';
const DIR = scratch(os.tmpdir(), 'dockq-');
const BIN = path.join(DIR, 'bin');
const DECOY = path.join(DIR, 'decoy');
fs.mkdirSync(BIN);
fs.mkdirSync(DECOY);
// An absolute node path in the shebang: dockq pins docker's PATH to system directories,
// where `env node` would not find an fnm-managed node.
fs.writeFileSync(path.join(BIN, 'docker'), `#!${process.execPath}
const args = process.argv.slice(2);
if (process.env.FAKE_DOCKER_ENV) {
  process.stdout.write(JSON.stringify({ host: process.env.DOCKER_HOST ?? null }));
  process.exit(0);
}
if (args[0] !== 'inspect') {
  process.stdout.write(JSON.stringify(args));
  process.exit(0);
}
const c = {
  Name: '/web', Id: 'abc', Created: '2026-10-20T00:00:00Z', RestartCount: 0, Platform: 'linux',
  State: { Status: 'running' }, Mounts: [], HostConfig: { RestartPolicy: { Name: 'no' } },
  NetworkSettings: { Networks: {}, Ports: {} },
  Config: { Image: 'nginx:1', Env: [${JSON.stringify(CANARY)}], Labels: {} },
};
const fmt = args.find((a) => a.startsWith('--format='));
if (!fmt) {
  process.stdout.write(JSON.stringify([c]));
  process.exit(0);
}
const template = fmt.slice('--format='.length);
const rendered = template.replace(/{{json (\\.[A-Za-z.]*)}}/g, (_, p) => {
  const value = p === '.' ? c : p.slice(1).split('.').reduce((o, k) => o[k], c);
  return JSON.stringify(value);
});
if (rendered.includes('{{')) {
  process.stderr.write('fake docker cannot render: ' + template);
  process.exit(99);
}
process.stdout.write(rendered);
`);
fs.writeFileSync(path.join(DECOY, 'docker'), `#!${process.execPath}\nprocess.stdout.write('DECOY');\n`);
for (const dir of [BIN, DECOY]) fs.chmodSync(path.join(dir, 'docker'), 0o755);

const SEAM = `
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader('dockq', sys.argv[1])
mod = importlib.util.module_from_spec(importlib.util.spec_from_loader('dockq', loader))
loader.exec_module(mod)
mod.DOCKER_DIRS = (sys.argv[2],)
sys.exit(mod.main(sys.argv[3:]))
`;

function dockq(args, env = {}) {
  return run('python3', ['-c', SEAM, DOCKQ, BIN, ...args], { env: { ...process.env, ...env } });
}

test('logs builds a bounded invocation with the name after --', { skip }, () => {
  const r = dockq(['logs', 'web', '--tail', '50', '--since', '30m']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout),
    ['logs', '--tail=50', '--since=30m', '--', 'web']);
});

test('logs refuses an unbounded or missing --tail', { skip }, () => {
  for (const args of [['logs', 'web'], ['logs', 'web', '--tail', '0'],
    ['logs', 'web', '--tail', '5001'], ['logs', 'web', '--tail', 'all']]) {
    const r = dockq(args);
    assert.strictEqual(r.code, 2, args.join(' '));
    assert.strictEqual(r.stdout, '', `${args.join(' ')} reached docker`);
  }
});

test('refuses every write verb and caller-supplied format without starting docker', { skip }, () => {
  const refused = [
    ['run', 'alpine'], ['exec', 'web', 'sh'], ['rm', 'web'], ['stop', 'web'],
    ['pull', 'alpine'], ['build', '.'], ['compose', 'up'], ['compose', 'down'],
    ['inspect', 'web', '--format', '{{json .}}'], ['manifest', 'push', 'x'],
    ['logs', '--', '--privileged', '--tail', '5'],
  ];
  for (const args of refused) {
    const r = dockq(args);
    assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.strictEqual(r.stdout, '', `${args.join(' ')} reached docker`);
  }
});

test('inspect output excludes the environment, for every field', { skip }, () => {
  // Read from the tool's own --field choices, so a field added later is covered here
  // without anyone remembering to list it.
  const help = dockq(['inspect', '--help']).stdout.replace(/\s+/g, '');
  const fields = help.match(/--field\{([^}]+)\}/)[1].split(',');
  assert.ok(fields.length >= 5, help);
  const all = dockq(['inspect', 'web', ...fields.flatMap((f) => ['--field', f])]);
  assert.strictEqual(all.code, 0, all.stderr);
  assert.deepStrictEqual(Object.keys(JSON.parse(all.stdout)), fields);
  assert.ok(!all.stdout.includes('canary'), all.stdout);
  const byDefault = dockq(['inspect', 'web']);
  assert.strictEqual(byDefault.code, 0, byDefault.stderr);
  assert.strictEqual(JSON.parse(byDefault.stdout).image, 'nginx:1');
  assert.ok(!byDefault.stdout.includes('canary'), byDefault.stdout);
});

test('the caller cannot choose docker through PATH or aim it at another daemon', { skip }, () => {
  const viaPath = dockq(['ps'], { PATH: `${DECOY}:${process.env.PATH}` });
  assert.strictEqual(viaPath.code, 0, viaPath.stderr);
  assert.deepStrictEqual(JSON.parse(viaPath.stdout), ['ps']);
  const env = dockq(['ps'], { FAKE_DOCKER_ENV: '1', DOCKER_HOST: 'tcp://192.0.2.1:2375' });
  assert.strictEqual(env.code, 0, env.stderr);
  assert.strictEqual(JSON.parse(env.stdout).host, null);
});

// `tags` and `digest` talk HTTP, not docker. The fake registry runs as its own process
// because run() is spawnSync, which blocks this process's event loop: an in-process server
// would never answer. It challenges every /v2/ request with a bearer realm on itself, and
// appends one JSON line per request to LOG, so a test can see each method, path and header
// that reached it, and that a refusal reached nothing.
const LOG = path.join(DIR, 'registry.log');
const DIGEST_INDEX = `sha256:${'a'.repeat(64)}`;
const DIGEST_SINGLE = `sha256:${'b'.repeat(64)}`;
const NOHDR_BODY = '{"schemaVersion":2}';
fs.writeFileSync(path.join(DIR, 'registry.js'), `
const http = require('node:http');
const fs = require('node:fs');
const server = http.createServer((req, res) => {
  const port = server.address().port;
  fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({
    method: req.method, url: req.url,
    auth: req.headers.authorization ?? null, accept: req.headers.accept ?? null,
  }) + '\\n');
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/token') {
    res.end(JSON.stringify({ token: 'tok-' + url.searchParams.get('scope') }));
    return;
  }
  const repo = url.pathname.match(/^\\/v2\\/(.+?)\\/(?:tags|manifests)\\//)?.[1];
  if (req.headers.authorization !== 'Bearer tok-repository:' + repo + ':pull') {
    const host = repo === 'foreign/realm' ? 'localhost' : '127.0.0.1';
    res.writeHead(401, { 'WWW-Authenticate':
      'Bearer realm="http://' + host + ':' + port + '/token",service="fake"' });
    res.end();
    return;
  }
  if (url.pathname.endsWith('/tags/list')) {
    const first = !url.searchParams.has('last');
    // team/app links by path; the others spell the link absolute, or point it away.
    const next = {
      'abs/app': 'http://127.0.0.1:' + port + url.pathname,
      'away/app': '/v2/other/app/tags/list',
      'offhost/app': 'http://localhost:' + port + url.pathname,
    }[repo] ?? url.pathname;
    if (first) res.setHeader('Link', '<' + next + '?last=b&n=2>; rel="next"');
    res.end(JSON.stringify({ tags: first ? ['a', 'b'] : ['c'] }));
    return;
  }
  if (repo === 'redir/app') {
    res.writeHead(302, { Location: '/v2/team/app/manifests/1.0' });
    res.end();
    return;
  }
  if (repo === 'nohdr/app') {
    res.end(${JSON.stringify(NOHDR_BODY)});
    return;
  }
  const index = (req.headers.accept ?? '').includes('image.index.v1+json');
  res.writeHead(200, { 'Docker-Content-Digest': index ? ${JSON.stringify(DIGEST_INDEX)}
    : ${JSON.stringify(DIGEST_SINGLE)} });
  res.end();
});
server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n'));
`);

let registryProc;
let REGISTRY;

before(async () => {
  fs.writeFileSync(LOG, '');
  registryProc = spawn(process.execPath, [path.join(DIR, 'registry.js')],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    registryProc.stdout.once('data', (d) => resolve(String(d).trim()));
    registryProc.once('error', reject);
  });
  REGISTRY = `127.0.0.1:${port}`;
});

after(() => registryProc?.kill());

// Runs dockq and returns its result with the requests the fake registry saw meanwhile.
function viaRegistry(args, env = {}) {
  const before = fs.readFileSync(LOG, 'utf8').length;
  const r = dockq(args, { NO_PROXY: '', no_proxy: '', ...env });
  const seen = fs.readFileSync(LOG, 'utf8').slice(before).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line));
  return { ...r, seen };
}

test('tags answers the bearer challenge and follows the next page', { skip }, () => {
  const r = viaRegistry(['tags', 'team/app', '--registry', REGISTRY]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(r.stdout.trim().split('\n'), ['a', 'b', 'c']);
  assert.deepStrictEqual(r.seen.map((s) => `${s.method} ${s.url}`), [
    'GET /v2/team/app/tags/list?n=1000',
    'GET /token?scope=repository%3Ateam%2Fapp%3Apull&service=fake',
    'GET /v2/team/app/tags/list?n=1000',
    'GET /v2/team/app/tags/list?last=b&n=2',
  ]);
  const json = viaRegistry(['tags', `${REGISTRY}/team/app`, '--json']);
  assert.deepStrictEqual(JSON.parse(json.stdout), ['a', 'b', 'c']);
});

test('digest asks for the index digest with a HEAD', { skip }, () => {
  const r = viaRegistry(['digest', 'team/app:1.0', '--registry', REGISTRY]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), DIGEST_INDEX);
  assert.deepStrictEqual(r.seen.map((s) => s.method), ['HEAD', 'GET', 'HEAD']);
  assert.strictEqual(r.seen.at(-1).url, '/v2/team/app/manifests/1.0');
});

test('digest hashes the manifest when a HEAD carries no digest header', { skip }, () => {
  const r = viaRegistry(['digest', `${REGISTRY}/nohdr/app`]);
  assert.strictEqual(r.code, 0, r.stderr);
  const want = `sha256:${require('node:crypto').createHash('sha256').update(NOHDR_BODY).digest('hex')}`;
  assert.strictEqual(r.stdout.trim(), want);
  assert.strictEqual(r.seen.at(-1).url, '/v2/nohdr/app/manifests/latest');
});

test('refuses a registry outside the closed set before any request', { skip }, () => {
  const refused = [
    ['digest', 'evil.example/x:1'],
    ['tags', 'x', '--registry', 'evil.example'],
    ['tags', 'x', '--registry', '10.0.0.5:5000'],
    ['digest', 'ghcr.io/x:1', '--registry', REGISTRY],
    ['digest', 'team/app:../../x', '--registry', REGISTRY],
    ['tags', 'Team/App', '--registry', REGISTRY],
  ];
  for (const args of refused) {
    const r = viaRegistry(args);
    assert.strictEqual(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /^dockq: refusing /, args.join(' '));
    assert.deepStrictEqual(r.seen, [], `${args.join(' ')} reached the registry`);
  }
});

test('a challenge cannot send the token request to another host', { skip }, () => {
  const r = viaRegistry(['digest', 'foreign/realm:1', '--registry', REGISTRY]);
  assert.strictEqual(r.code, 2, r.stderr);
  assert.match(r.stderr, /refusing token realm/);
  assert.deepStrictEqual(r.seen.map((s) => s.url), ['/v2/foreign/realm/manifests/1']);
});

test('requests ignore a proxy variable', { skip }, () => {
  // Port 9 has no listener, so a request routed through the proxy fails.
  const r = viaRegistry(['digest', 'team/app:1.0', '--registry', REGISTRY], {
    HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9',
  });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), DIGEST_INDEX);
});

test('tags follows an absolute next link on the same registry only', { skip }, () => {
  const abs = viaRegistry(['tags', 'abs/app', '--registry', REGISTRY]);
  assert.strictEqual(abs.code, 0, abs.stderr);
  assert.deepStrictEqual(abs.stdout.trim().split('\n'), ['a', 'b', 'c']);
  for (const repo of ['away/app', 'offhost/app']) {
    const r = viaRegistry(['tags', repo, '--registry', REGISTRY]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(r.stdout.trim().split('\n'), ['a', 'b'], repo);
    assert.match(r.stderr, /not following next page/, repo);
    assert.ok(r.seen.every((s) => s.url.startsWith(`/v2/${repo}/`) || s.url.startsWith('/token')),
      JSON.stringify(r.seen));
  }
});

test('digest does not follow a redirect', { skip }, () => {
  const r = viaRegistry(['digest', 'redir/app:1.0', '--registry', REGISTRY]);
  assert.strictEqual(r.code, 1, r.stderr);
  assert.match(r.stderr, /HTTP 302/);
  assert.ok(!r.seen.some((s) => s.url.startsWith('/v2/team/')), JSON.stringify(r.seen));
});

test('digest accepts a digest reference', { skip }, () => {
  const r = viaRegistry(['digest', `team/app@${DIGEST_SINGLE}`, '--registry', REGISTRY]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.seen.at(-1).url, `/v2/team/app/manifests/${DIGEST_SINGLE}`);
});

// The public registries cannot be reached from a test, so these load dockq as a module and
// call the step under test directly, with the one network call replaced by a recorder.
const MODULE = `
import importlib.machinery, importlib.util, json, sys, urllib.request
loader = importlib.machinery.SourceFileLoader('dockq', sys.argv[1])
mod = importlib.util.module_from_spec(importlib.util.spec_from_loader('dockq', loader))
loader.exec_module(mod)
exec(sys.argv[2])
`;

function inModule(code, env = {}) {
  const r = run('python3', ['-c', MODULE, DOCKQ, code], { env: { ...process.env, ...env } });
  assert.strictEqual(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('Docker Hub names get library/ and ghcr.io names keep their owner', { skip }, () => {
  const out = inModule(`
refs = ['nginx', 'grafana/loki:3.4.2', 'docker.io/postgres:17', 'ghcr.io/o/img:v1']
print(json.dumps([[r.base, repo, ref] for r, repo, ref in
                  (mod.parse_ref(x, None, want_reference=True) for x in refs)]))`);
  assert.deepStrictEqual(out, [
    ['https://registry-1.docker.io', 'library/nginx', 'latest'],
    ['https://registry-1.docker.io', 'grafana/loki', '3.4.2'],
    ['https://registry-1.docker.io', 'library/postgres', '17'],
    ['https://ghcr.io', 'o/img', 'v1'],
  ]);
});

test('a public registry asks its pinned realm, whatever the challenge names', { skip }, () => {
  const out = inModule(`
seen = []
class Stop(Exception): pass
def record(req):
    seen.append(req.full_url)
    raise Stop
mod._open = record
for host in ('ghcr.io', 'docker.io'):
    try:
        mod._fetch_token(mod.registry_for(host), 'o/img',
                         {'realm': 'https://evil.example/token', 'service': 'evil'})
    except Stop:
        pass
print(json.dumps(seen))`);
  assert.deepStrictEqual(out, [
    'https://ghcr.io/token?scope=repository%3Ao%2Fimg%3Apull&service=ghcr.io',
    'https://auth.docker.io/token?scope=repository%3Ao%2Fimg%3Apull&service=registry.docker.io',
  ]);
});

test('the opener holds no proxy for any scheme', { skip }, () => {
  // The public registries are https, which the loopback proxy test above cannot reach.
  const out = inModule(`
print(json.dumps([h.proxies for h in mod._OPENER.handlers
                  if isinstance(h, urllib.request.ProxyHandler) and h.proxies]))`,
  { HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9' });
  assert.deepStrictEqual(out, []);
});
