// One file from the homelab repo (DanielH2018/server), for a test that keeps a pin here in
// lockstep with one there.
//
// The oracle is the homelab repo's own file: a local checkout where one exists, and otherwise
// that repo's master copy fetched from GitHub (the repo is public). CI has no checkout, so
// without the fetch a lockstep test would skip there on every run. A committed copy of the
// homelab's value would be an oracle this repo supplies about itself: a bump here would move it
// along with the pin, and the test would then pass with the two repos apart.
//
// homelabFile(relPath, candidates, fetchImpl) -> { text, from } or { skip } with the reason the
//   file could not be reached. Only a transport failure or a 5xx skips, which is the offline
//   case. Any other non-200 throws: the file moving or the repo going private is exactly the
//   change a lockstep test has to report.
// HOMELAB_CANDIDATES  the checkouts to try first, in order. $HOMELAB_REPO leads when it is set.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOMELAB_RAW = 'https://raw.githubusercontent.com/DanielH2018/server/master';
const HOMELAB_CANDIDATES = [
  process.env.HOMELAB_REPO,
  path.join(os.homedir(), 'server'),
  path.join(os.homedir(), 'dev', 'server'),
].filter(Boolean);

async function homelabFile(relPath, candidates, fetchImpl) {
  const url = `${HOMELAB_RAW}/${relPath}`;
  const dir = candidates.find((d) => fs.existsSync(path.join(d, relPath)));
  if (dir) return { text: fs.readFileSync(path.join(dir, relPath), 'utf8'), from: dir };
  const offline = `no homelab checkout at ${candidates.join(', ')}, and ${url}`;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    return { skip: `${offline} is unreachable (${err.cause?.code ?? err.name})` };
  }
  if (res.status >= 500) return { skip: `${offline} answered ${res.status}` };
  if (res.status !== 200) {
    throw new Error(`${url} answered ${res.status}: the homelab ${relPath} moved, or the repo is no longer public`);
  }
  return { text: await res.text(), from: url };
}

module.exports = { HOMELAB_RAW, HOMELAB_CANDIDATES, homelabFile };
