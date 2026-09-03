'use strict';
// Pure, deterministic logic for `shadow-report`. No fs/process access lives here — the
// wrapper reads the log and the hook source and hands their text in, so every function is
// a total function of its arguments and trivially testable against a small fixture instead
// of the real 2.7MB log (see tests/shadow-report.test.js).
//
// Vocabulary:
//   row       one parsed line of ~/.claude/logs/cmdparse-shadow.jsonl — see
//             block-dangerous-bash.sh's `_bdb_shadow_log` for the writer and its comments
//             for what each field can and cannot mean.
//   census family   one of the family names the M02 shadow census itself tracks (today:
//             ssh, terraform) — the only rule families this log can report fired/never-fired
//             counts for, because they are the only ones the census writes a signal about.
//   deny rule       one `deny "Blocked: ..."` call site in block-dangerous-bash.sh. The log's
//             `old` field records only a generic deny/allow/none verdict per Bash call, never
//             which of these ~40 sites produced it — so these are NEVER "never-fired", they
//             are "not instrumented, the log cannot say." Reporting them as never-fired would
//             be a false clear on a live rule (MEMORY.md: "An optimisation can land green and
//             be inert").

// Parse a JSONL blob into { rows, errors }. A line that fails to parse is reported, not
// silently dropped — a corrupt log should show up in the report rather than just shrink
// the row count with no explanation.
function parseLines(text) {
  const rows = [];
  const errors = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch (e) {
      errors.push({ lineNo: i + 1, line, error: e.message });
    }
  }
  return { rows, errors };
}

// The census family names the hook itself tracks, read off its own source rather than
// hardcoded here — a family added to or removed from block-dangerous-bash.sh's M02 section
// changes what this reports without needing a second edit to keep it in sync. The three
// case-arms below are the only places a family name is appended to the census's own
// newly/newly_sub/found_sub accumulators (see _bdb_shadow_log).
const CENSUS_FAMILY_RE = /case \$(?:newly|newly_sub|found_sub) in \*([a-zA-Z0-9_]+)\*\)/g;

// A grep that returns fewer than this after a refactor is a bug in the extraction, not
// evidence the census shrank to nothing — fail loudly instead of reporting an empty
// "instrumented families" section as if that were the truth (the KNOWN_CONSUMERS pattern,
// scripts/diagnostics/tests/test_probe_boundaries.py in the server repo).
const MIN_KNOWN_CENSUS_FAMILIES = ['ssh', 'terraform'];

function censusFamiliesFromSource(hookSrc) {
  const names = new Set();
  let m;
  CENSUS_FAMILY_RE.lastIndex = 0;
  while ((m = CENSUS_FAMILY_RE.exec(hookSrc))) names.add(m[1]);
  return [...names].sort();
}

// Every whole-string `deny()` rule site, as a short label: the reason text up to its first
// sentence. Two sites share an identical message (the two `rm -rf` forms of the same rule),
// so the result is deduped — that is a correct count of distinct DENY MESSAGES, not of
// `deny()` call sites, which is what a report reader actually wants to see once each.
const DENY_RULE_RE = /deny\s+"Blocked: ([^"]*)"/g;

function denyRuleLabelsFromSource(hookSrc) {
  const labels = new Set();
  let m;
  DENY_RULE_RE.lastIndex = 0;
  while ((m = DENY_RULE_RE.exec(hookSrc))) {
    const full = m[1];
    const firstSentence = full.split(/\.\s|\.$/, 1)[0].trim();
    labels.add(firstSentence);
  }
  return [...labels].sort();
}

// Summarize a set of rows against a known census-family list. Returns:
//   totalRows        rows parsed
//   statusCounts      row.status histogram (ok / unreadable:* / desync:* / missing)
//   oldCounts         row.old histogram (deny / allow / none / defer / whatever the
//                     deployed hook wrote, INCLUDING values not in the current source —
//                     the log can outlive a rename)
//   families          one entry per census family: fired counts for each of the three log
//                     fields, and `fired` (true if any of the three is nonzero over the
//                     window). A family present in `censusFamilies` but absent from every
//                     row is `fired: false` across the board — genuine never-fired evidence.
//   disagreements     one row per (log row, field, family) where newly_anchored or
//                     newly_anchored_sub named a family — i.e. a case where the per-segment
//                     view found something the whole-string SCAN path's own decision missed.
//                     sub_anchored alone (no matching newly_anchored_sub) is NOT a
//                     disagreement — SCAN already caught it elsewhere in the command, see
//                     the hook's own comment on sub_anchored — so it is counted in
//                     `families` but excluded here.
function summarize(rows, censusFamilies) {
  const statusCounts = {};
  const oldCounts = {};
  const families = {};
  for (const fam of censusFamilies) {
    families[fam] = { newly_anchored: 0, newly_anchored_sub: 0, sub_anchored: 0 };
  }
  const disagreements = [];

  for (const row of rows) {
    const status = typeof row.status === 'string' && row.status !== '' ? row.status : '(missing)';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    const old = typeof row.old === 'string' && row.old !== '' ? row.old : '(missing)';
    oldCounts[old] = (oldCounts[old] || 0) + 1;

    for (const field of ['newly_anchored', 'newly_anchored_sub', 'sub_anchored']) {
      const list = row[field];
      if (!Array.isArray(list)) continue;
      for (const fam of list) {
        if (!families[fam]) families[fam] = { newly_anchored: 0, newly_anchored_sub: 0, sub_anchored: 0 };
        families[fam][field] += 1;
        if (field === 'newly_anchored' || field === 'newly_anchored_sub') {
          disagreements.push({
            ts: row.ts,
            family: fam,
            field,
            old: row.old,
            status: row.status,
            cmd: typeof row.cmd === 'string' ? row.cmd.slice(0, 160) : '',
          });
        }
      }
    }
  }

  const familyReport = Object.keys(families).sort().map((fam) => {
    const f = families[fam];
    return {
      family: fam,
      newly_anchored: f.newly_anchored,
      newly_anchored_sub: f.newly_anchored_sub,
      sub_anchored: f.sub_anchored,
      fired: f.newly_anchored > 0 || f.newly_anchored_sub > 0 || f.sub_anchored > 0,
    };
  });

  return { totalRows: rows.length, statusCounts, oldCounts, families: familyReport, disagreements };
}

module.exports = {
  parseLines,
  censusFamiliesFromSource,
  denyRuleLabelsFromSource,
  summarize,
  MIN_KNOWN_CENSUS_FAMILIES,
};
