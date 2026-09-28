'use strict';
// Pure, deterministic logic for config-soak. No filesystem, network or clock access lives
// here: callers inject `now`, the tracked path set and each path's landed date, so every
// function is a total function of its arguments.
//
// A path's landed date is the committer date of the last commit on origin/main that touched
// it. main only moves by fast-forward (bin/land, and the ruleset forbids anything else), so
// that date is stable once a commit lands. It replaced a committed fingerprint ledger
// (config-soak.json) in #694: every acknowledgement in that ledger was self-issued by the
// author running `config-soak land`, so it recorded nothing the history did not already hold.
//
// A config file's lifecycle: unlanded -> soaking -> stable. `unlanded` means the working
// tree differs from origin/main at that path, or origin/main has never carried it.

const DEFAULT_WINDOW_DAYS = 7;
const DAY_MS = 86400000;

function toMs(t) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (Number.isNaN(ms)) throw new TypeError(`invalid timestamp: ${t}`);
  return ms;
}

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// Classify every tracked path.
//   paths    repo-relative paths git tracks under the config surface
//   landed   { path: ISO committer date on origin/main }, absent when main never had it
//   pending  paths whose working-tree content differs from origin/main
// Returns { windowDays, unlanded[], soaking[], stable[] }, each sorted by path.
function classify({ paths, landed = {}, pending = [], now, windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const nowMs = toMs(now);
  const pendingSet = new Set(pending);
  const report = { windowDays, unlanded: [], soaking: [], stable: [] };
  for (const path of [...paths].sort()) {
    const date = landed[path];
    if (!date || pendingSet.has(path)) {
      report.unlanded.push({ path, landed: date || null });
      continue;
    }
    const ageDays = (nowMs - toMs(date)) / DAY_MS;
    if (ageDays >= windowDays) report.stable.push({ path, landed: date, ageDays });
    else report.soaking.push({ path, landed: date, ageDays, daysRemaining: windowDays - ageDays });
  }
  for (const bucket of [report.unlanded, report.soaking, report.stable]) bucket.sort(byPath);
  return report;
}

// Read the output of a log walk printed as `--format=%x00%cI --name-only` (newest first)
// into { path: date }, keeping each path's FIRST, i.e. newest, occurrence. One walk answers
// every path, where asking per path costs a process per tracked file.
function parseLandedLog(text) {
  const landed = {};
  for (const block of text.split('\0').filter(Boolean)) {
    const [date, ...files] = block.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const f of files) if (!(f in landed)) landed[f] = date;
  }
  return landed;
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
  classify,
  parseLandedLog,
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
