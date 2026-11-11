// One file from the homelab repo (DanielH2018/server), for a test that keeps a pin here in
// lockstep with one there.
//
// The oracle is the homelab repo's master copy fetched from GitHub (the repo is public). A local
// checkout answers only when $HOMELAB_REPO names it, to test a change on both sides before either
// lands, or when GitHub is unreachable. An implicit ~/server checkout is a dated copy: one nobody
// had pulled for months failed the lockstep test against a pin master had already moved.
// A committed copy of the homelab's value would be an oracle this repo supplies about itself: a
// bump here would move it along with the pin, and the test would then pass with the two repos
// apart.
//
// homelabFile(relPath, fallbacks, fetchImpl, override = $HOMELAB_REPO) -> { text, from } or
//   { skip } with the reason the file could not be reached. Offline (a transport failure or a
//   5xx) it reads the first fallback checkout holding the file, and skips only when none does.
//   Any other non-200 throws: the file moving or the repo going private is exactly the change a
//   lockstep test has to report.
// HOMELAB_CANDIDATES  the offline fallback checkouts, in order.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOMELAB_RAW = 'https://raw.githubusercontent.com/DanielH2018/server/master';
const HOMELAB_CANDIDATES = [
  path.join(os.homedir(), 'server'),
  path.join(os.homedir(), 'dev', 'server'),
];

const readFrom = (dir, relPath) => ({ text: fs.readFileSync(path.join(dir, relPath), 'utf8'), from: dir });

async function homelabFile(relPath, fallbacks, fetchImpl, override = process.env.HOMELAB_REPO) {
  if (override) return readFrom(override, relPath);
  const url = `${HOMELAB_RAW}/${relPath}`;
  const offline = (why) => {
    const dir = fallbacks.find((d) => fs.existsSync(path.join(d, relPath)));
    return dir ? readFrom(dir, relPath) : { skip: `no homelab checkout at ${fallbacks.join(', ')}, and ${url} ${why}` };
  };
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    return offline(`is unreachable (${err.cause?.code ?? err.name})`);
  }
  if (res.status >= 500) return offline(`answered ${res.status}`);
  if (res.status !== 200) {
    throw new Error(`${url} answered ${res.status}: the homelab ${relPath} moved, or the repo is no longer public`);
  }
  return { text: await res.text(), from: url };
}

module.exports = { HOMELAB_RAW, HOMELAB_CANDIDATES, homelabFile };
