'use strict';
// Pure, deterministic logic for the config soak gate. No filesystem, network,
// or clock access lives here — callers inject `now` and the scanned file set —
// so every function is a total function of its arguments and trivially testable.
//
// Vocabulary:
//   tracked   { repoRelPath: sha256hex }   fingerprints of the current config on disk
//   manifest  { windowDays, entries: [{ path, hash, landed }] }   the committed ledger
//   now       ISO-8601 string or epoch ms  injected wall clock
//
// A config file's lifecycle: unrecorded -> (land) -> soaking -> stable.
// A content change moves it to `changed`; a deletion moves its ledger entry to
// `removed`. `unrecorded`, `changed`, and `removed` are the gate-failing states —
// they represent behavior-affecting config that a human has not consciously
// acknowledged via `land`.

const crypto = require('node:crypto');

const DEFAULT_WINDOW_DAYS = 7;
const DAY_MS = 86400000;

// sha256 of file content, hex. EOL-agnostic: CRLF is collapsed to LF before
// hashing, so a file checked out with Windows line endings (autocrlf) fingerprints
// identically to the LF ledger written on macOS/Linux — otherwise every CRLF
// checkout false-flags as `changed`. The tracked surface is all text config;
// latin1 is a byte-exact round-trip, so nothing but literal CRLF pairs is touched.
function fingerprint(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const lf = Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return crypto.createHash('sha256').update(lf).digest('hex');
}

function toMs(t) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (Number.isNaN(ms)) throw new TypeError(`invalid timestamp: ${t}`);
  return ms;
}

function resolveWindow(manifest, override) {
  if (override != null) return override;
  if (manifest && manifest.windowDays != null) return manifest.windowDays;
  return DEFAULT_WINDOW_DAYS;
}

// Classify every tracked path and every ledger entry into buckets.
// Returns { windowDays, soaking[], stable[], unrecorded[], changed[], removed[] }.
// Each bucket is sorted by path for stable, reviewable output.
function buildReport({ tracked, manifest = {}, now, windowDays } = {}) {
  const win = resolveWindow(manifest, windowDays);
  const nowMs = toMs(now);
  const entries = manifest.entries || [];
  const byPath = new Map(entries.map((e) => [e.path, e]));

  const report = {
    windowDays: win,
    soaking: [],
    stable: [],
    unrecorded: [],
    changed: [],
    removed: [],
  };

  for (const path of Object.keys(tracked).sort()) {
    const hash = tracked[path];
    const entry = byPath.get(path);
    if (!entry) {
      report.unrecorded.push({ path, hash });
      continue;
    }
    if (entry.hash !== hash) {
      report.changed.push({ path, hash, recordedHash: entry.hash, landed: entry.landed });
      continue;
    }
    const ageDays = (nowMs - toMs(entry.landed)) / DAY_MS;
    if (ageDays >= win) {
      report.stable.push({ path, hash, landed: entry.landed, ageDays });
    } else {
      report.soaking.push({
        path,
        hash,
        landed: entry.landed,
        ageDays,
        daysRemaining: win - ageDays,
      });
    }
  }

  for (const entry of entries) {
    if (!(entry.path in tracked)) {
      report.removed.push({ path: entry.path, recordedHash: entry.hash, landed: entry.landed });
    }
  }
  report.removed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return report;
}

// Count of gate-failing findings. Zero => the gate passes (all config is
// acknowledged, whether still soaking or already stable).
function gateFailures(report) {
  return report.unrecorded.length + report.changed.length + report.removed.length;
}

// Produce a NEW manifest that records the current reality as reviewed.
//   - unchanged files keep their existing `landed` (soak clock is NOT reset)
//   - new or content-changed files (within scope) are stamped landed=now
//   - deleted files (within scope) are dropped from the ledger
// `paths` is an optional allow-list: when given, only those paths are refreshed
// (acknowledge just what you actually reviewed); everything else keeps its prior
// ledger state. Pure — returns a fresh object, never mutates its input.
function land({ tracked, manifest = {}, now, paths } = {}) {
  const win = resolveWindow(manifest, undefined);
  const nowIso = typeof now === 'number' ? new Date(now).toISOString() : now;
  const scope = paths && paths.length ? new Set(paths) : null;
  const inScope = (p) => !scope || scope.has(p);
  const prev = new Map((manifest.entries || []).map((e) => [e.path, e]));
  const out = [];

  for (const path of Object.keys(tracked).sort()) {
    const hash = tracked[path];
    const existing = prev.get(path);
    if (existing && existing.hash === hash) {
      out.push({ path, hash, landed: existing.landed }); // unchanged: preserve clock
    } else if (inScope(path)) {
      out.push({ path, hash, landed: nowIso }); // new/changed & reviewed: (re)start clock
    } else if (existing) {
      out.push({ path: existing.path, hash: existing.hash, landed: existing.landed }); // out of scope: keep old
    }
    // new & out of scope: intentionally omitted (stays unrecorded)
  }

  // Deleted files: recorded entries whose path is gone from `tracked`.
  // Drop them when in scope (acknowledging the removal), keep them otherwise.
  for (const entry of manifest.entries || []) {
    if (!(entry.path in tracked) && !inScope(entry.path)) {
      out.push({ path: entry.path, hash: entry.hash, landed: entry.landed });
    }
  }

  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { windowDays: win, entries: out };
}

module.exports = {
  DEFAULT_WINDOW_DAYS,
  DAY_MS,
  fingerprint,
  buildReport,
  gateFailures,
  land,
};
