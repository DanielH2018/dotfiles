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
      report.stable.push({ path, hash, landed: entry.landed, ageDays, outcome: entry.outcome || null });
    } else {
      report.soaking.push({
        path,
        hash,
        landed: entry.landed,
        ageDays,
        daysRemaining: win - ageDays,
        outcome: entry.outcome || null,
      });
    }
  }

  for (const entry of entries) {
    if (!(entry.path in tracked)) {
      report.removed.push({ path: entry.path, recordedHash: entry.hash, landed: entry.landed });
    }
  }
  report.removed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // "landed, never fired": the soak window fully elapsed (stable), an
  // outcomes run actually reached Loki (source:"loki" — never true for a
  // path outcomes never attempted, or one that came back source:"none"),
  // and it recorded zero hits the whole time. A warning, not a gate
  // failure, unless the caller passes { strict: true } to gateFailures.
  report.neverFired = report.stable.filter(
    (x) => x.outcome && x.outcome.source === 'loki' && x.outcome.fired === 0
  );
  return report;
}

// Count of gate-failing findings. Zero => the gate passes (all config is
// acknowledged, whether still soaking or already stable). `opts.strict`
// additionally fails the gate on "landed, never fired" entries (see
// buildReport's `neverFired`) — off by default, since a config that soaked
// out without firing is a scaffolding-delete-pass candidate, not by itself
// evidence the change was wrong.
function gateFailures(report, opts = {}) {
  let n = report.unrecorded.length + report.changed.length + report.removed.length;
  if (opts.strict) n += (report.neverFired || []).length;
  return n;
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
      // unchanged: preserve clock AND any recorded outcome — nothing about
      // this file's review state changed.
      const rec = { path, hash, landed: existing.landed };
      if (existing.outcome) rec.outcome = existing.outcome;
      out.push(rec);
    } else if (inScope(path)) {
      // new/changed & reviewed: (re)start clock. Deliberately no `outcome`
      // carried forward — a changed file's prior outcome describes content
      // that no longer exists, and `outcomes` has not observed the new one.
      out.push({ path, hash, landed: nowIso });
    } else if (existing) {
      // out of scope: keep old, outcome included
      const rec = { path: existing.path, hash: existing.hash, landed: existing.landed };
      if (existing.outcome) rec.outcome = existing.outcome;
      out.push(rec);
    }
    // new & out of scope: intentionally omitted (stays unrecorded)
  }

  // Deleted files: recorded entries whose path is gone from `tracked`.
  // Drop them when in scope (acknowledging the removal), keep them otherwise.
  for (const entry of manifest.entries || []) {
    if (!(entry.path in tracked) && !inScope(entry.path)) {
      const rec = { path: entry.path, hash: entry.hash, landed: entry.landed };
      if (entry.outcome) rec.outcome = entry.outcome;
      out.push(rec);
    }
  }

  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { windowDays: win, entries: out };
}

// ---------------------------------------------------------------------------
// Outcome attribution — did a landed config change ever fire, in Loki?
//
// Claude Code's OTEL event schema (see home/claude-otel/README.md) logs one
// `tool_decision` event per gated tool call, carrying `source` (who decided:
// "hook" | "config" | "user_temporary" | ...) and `decision` ("accept" |
// "reject"). It does NOT carry which hook script decided, or which rule in
// the permission ruleset matched — so attribution is only as fine as those
// two facts allow. Two tracked-config shapes get a real signal; everything
// else is honestly unattributable:
//
//   settings.*.json  -> the three templates merge into one live permission
//                        ruleset. An automatic decision with no hook and no
//                        human involved logs `source="config"`. That signal
//                        cannot be split further (which of the three files,
//                        which rule), so all three share the same aggregate.
//
//   hooks/<script>   -> only PreToolUse and PermissionRequest hooks gate a
//                        tool call at all (SessionStart/PostToolUse/Stop/...
//                        hooks are lifecycle hooks with no tool_decision
//                        counterpart). Within those two event types, a
//                        `source="hook"` decision is attributable to ONE
//                        script only when that script is the sole hook
//                        registered for its (event, matcher) pair — Loki
//                        cannot tell which of several co-registered hooks
//                        decided a shared matcher.
//
// Everything that fails either test reports `source:"none"` with a `note`
// explaining why, rather than a false zero.

const ATTRIBUTABLE_HOOK_EVENTS = new Set(['PreToolUse', 'PermissionRequest']);

const SETTINGS_JSON_PATHS = new Set([
  'home/.chezmoitemplates/settings.base.json',
  'home/.chezmoitemplates/settings.permissions.json',
  'home/.chezmoitemplates/settings.safe-floor.json',
]);

function isSettingsPath(repoRelPath) {
  return SETTINGS_JSON_PATHS.has(repoRelPath);
}

function isHookPath(repoRelPath) {
  return repoRelPath.startsWith('home/private_dot_claude/hooks/');
}

// Pull the flat `hooks` object out of the chezmoi-templated settings.base.json
// SOURCE text (Go-template comments/conditionals over JSON — chezmoi renders
// this before it becomes real JSON, and we do not run chezmoi here). Stripping
// every `{{...}}` token and keeping the surrounding literal text is enough for
// this section specifically: an OS-gated hook OBJECT (`{{ if ne .chezmoi.os
// "windows" }}{ ... },{{ end }}`) keeps its braces in the literal text, so it
// stays included (correct for every OS this repo targets — none of the
// hooks section's conditionals exclude a hook only on Linux); an OS-branched
// COMMAND STRING (the tq-wrap-tests.py/.sh split) just concatenates both
// branches into one string, which is fine because callers only regex basenames
// out of it. Returns null if the section is missing or does not parse —
// callers treat that as "cannot attribute", not as "zero hooks".
function parseHooksConfig(sourceText) {
  const stripped = sourceText.replace(/\{\{[\s\S]*?\}\}/g, '');
  const keyIdx = stripped.indexOf('"hooks":');
  if (keyIdx === -1) return null;
  const braceStart = stripped.indexOf('{', keyIdx);
  if (braceStart === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let i = braceStart;
  for (; i < stripped.length; i++) {
    const c = stripped[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const slice = stripped.slice(braceStart, i);
  try {
    return JSON.parse(slice);
  } catch (_e) {
    return null;
  }
}

// basename -> every (event, matcher) registration naming it, each carrying
// the OTHER hook basenames sharing that same registration (its "siblings").
function findHookRegistrations(basename, hooksConfig) {
  const regs = [];
  if (!hooksConfig) return regs;
  for (const [event, arr] of Object.entries(hooksConfig)) {
    for (const entry of arr || []) {
      const names = new Set();
      for (const h of entry.hooks || []) {
        const cmd = h.command || '';
        const re = /~\/\.claude\/hooks\/([A-Za-z0-9._-]+)/g;
        let m;
        while ((m = re.exec(cmd))) names.add(m[1]);
      }
      if (names.has(basename)) {
        regs.push({
          event,
          matcher: entry.matcher || '*',
          siblingBasenames: [...names].filter((n) => n !== basename).sort(),
        });
      }
    }
  }
  return regs;
}

function matcherToRegex(matcher) {
  if (!matcher || matcher === '*') return null; // no tool_name filter
  return `^(${matcher})$`;
}

// The hooks config's `command` fields name the DEPLOYED path
// (~/.claude/hooks/protect-secrets.sh); the tracked ledger path is the
// chezmoi SOURCE path (home/private_dot_claude/hooks/executable_protect-
// secrets.sh — chezmoi's `executable_` attribute prefix sets the deployed
// file's permission bit and is stripped from the deployed name). Matching
// source basenames against the hooks config directly would silently miss
// every hook, since none of the deployed names carry that prefix. A source
// file with NO attribute prefix (artifact-state.sh, cmdparse.sh) is a
// library another hook sources, not a hook itself, and correctly falls
// through to "not referenced" below unchanged.
function chezmoiDeployedBasename(sourceBasename) {
  return sourceBasename.replace(/^executable_/, '');
}

// { attributable: true, slices: [{ source, toolNameRegex }] }
// { attributable: false, note }
function attributeHookPath(repoRelPath, hooksConfig) {
  const basename = chezmoiDeployedBasename(repoRelPath.split('/').pop());
  if (!hooksConfig) {
    return { attributable: false, note: "settings.base.json's hooks config could not be parsed" };
  }
  const regs = findHookRegistrations(basename, hooksConfig);
  if (regs.length === 0) {
    return { attributable: false, note: `${basename} is not referenced in settings.base.json's hooks config` };
  }
  const usable = regs.filter((r) => ATTRIBUTABLE_HOOK_EVENTS.has(r.event) && r.siblingBasenames.length === 0);
  if (usable.length === 0) {
    const reasons = regs.map((r) => {
      if (!ATTRIBUTABLE_HOOK_EVENTS.has(r.event)) {
        return `${r.event} hooks emit no tool_decision event (only PreToolUse/PermissionRequest do)`;
      }
      return `shares the ${r.event}/${r.matcher} matcher with ${r.siblingBasenames.join(', ')} — ` +
        'Loki\'s tool_decision event carries no field naming which hook decided';
    });
    return { attributable: false, note: reasons.join('; ') };
  }
  return {
    attributable: true,
    slices: usable.map((r) => ({ source: 'hook', toolNameRegex: matcherToRegex(r.matcher) })),
  };
}

// Top-level entry point: is this tracked path in scope for `outcomes` at all
// (a hook or a settings file — nothing else is), and if so, can it be
// attributed?
//   { inScope: false }
//   { inScope: true, attributable: true,  slices: [...] }
//   { inScope: true, attributable: false, note }
function attributeEntry(repoRelPath, hooksConfig) {
  if (isSettingsPath(repoRelPath)) {
    return { inScope: true, attributable: true, slices: [{ source: 'config', toolNameRegex: null }] };
  }
  if (isHookPath(repoRelPath)) {
    const r = attributeHookPath(repoRelPath, hooksConfig);
    return r.attributable
      ? { inScope: true, attributable: true, slices: r.slices }
      : { inScope: true, attributable: false, note: r.note };
  }
  return { inScope: false };
}

// Build the three LogQL instant-vector queries (fired/denied/errors) summing
// over every attributable slice. Pure string building — no network, no I/O.
// `sinceSeconds` is the age of the landed config in seconds; the query looks
// back exactly that far so it never counts activity that predates the review.
function buildOutcomeQueries(slices, sinceSeconds) {
  const range = `[${Math.max(1, Math.ceil(sinceSeconds))}s]`;
  const clause = (slice, extraFilter) => {
    const filters = ['event_name="tool_decision"', `source="${slice.source}"`];
    if (slice.toolNameRegex) filters.push(`tool_name=~"${slice.toolNameRegex}"`);
    if (extraFilter) filters.push(extraFilter);
    return `count_over_time({service_name="claude-code"} | json | ${filters.join(' | ')} ${range})`;
  };
  const sumOf = (extraFilter) => `sum(${slices.map((s) => clause(s, extraFilter)).join(' + ')})`;
  return {
    fired: sumOf(null),
    denied: sumOf('decision="reject"'),
    // No distinct "hook execution error" or "config parse error" event
    // exists in the schema; the closest honest proxy is a decision value
    // that is neither accept nor reject (an anomaly, not a real category).
    errors: sumOf('decision!~"accept|reject"'),
  };
}

// Extract a scalar total from a Loki `/loki/api/v1/query` (instant vector)
// JSON response, summed across every returned series. 0 for an empty result
// set is a real zero (no matching events) — callers distinguish a transport
// failure (thrown before this is ever called) from a genuine zero.
function parseLokiScalar(json) {
  const result = json && json.data && json.data.result;
  if (!Array.isArray(result) || result.length === 0) return 0;
  let total = 0;
  for (const series of result) {
    const v = series && series.value && series.value[1];
    const n = Number(v);
    if (!Number.isNaN(n)) total += n;
  }
  return total;
}

function makeOutcome({ fired, denied, errors, checkedAt, note = '' }) {
  return { checkedAt, fired, denied, errors, source: 'loki', note };
}

function unattributedOutcome({ checkedAt, note }) {
  return { checkedAt, fired: 0, denied: 0, errors: 0, source: 'none', note };
}

module.exports = {
  DEFAULT_WINDOW_DAYS,
  DAY_MS,
  fingerprint,
  buildReport,
  gateFailures,
  land,
  ATTRIBUTABLE_HOOK_EVENTS,
  isSettingsPath,
  isHookPath,
  chezmoiDeployedBasename,
  parseHooksConfig,
  attributeHookPath,
  attributeEntry,
  buildOutcomeQueries,
  parseLokiScalar,
  makeOutcome,
  unattributedOutcome,
};
