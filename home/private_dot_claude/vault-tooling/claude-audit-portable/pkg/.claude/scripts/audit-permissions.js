#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require("../hooks/log-permission.js");

function parseArgs(argv) {
  const out = { since: null, prune: null, json: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { out.json = true; }
    else if (a === "--since") {
      if (i + 1 >= argv.length) { out.error = "--since requires a date value"; break; }
      const v = argv[++i];
      if (Number.isNaN(Date.parse(v))) { out.error = "--since requires a valid date (got '" + v + "')"; break; }
      out.since = v;
    } else if (a === "--prune") {
      if (i + 1 >= argv.length) { out.error = "--prune requires a number of days"; break; }
      const v = argv[++i];
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 1) { out.error = "--prune requires a positive integer of days (1 or more, got '" + v + "')"; break; }
      out.prune = n;
    } else { out.error = "unknown argument: " + a; break; }
  }
  return out;
}

function entriesArray(store) {
  return Object.keys(store.entries).map(k => store.entries[k]);
}

function summarizeReport(store, opts) {
  opts = opts || {};
  let list = entriesArray(store);
  if (opts.since) {
    const t = Date.parse(opts.since);
    list = list.filter(e => Date.parse(e.last) >= t);
  }
  const byTool = {};
  let totalCalls = 0, totalAsks = 0;
  for (const e of list) {
    totalCalls += e.calls; totalAsks += e.asks;
    const t = byTool[e.tool] || (byTool[e.tool] = { tool: e.tool, calls: 0, asks: 0, auto: 0 });
    t.calls += e.calls; t.asks += e.asks; t.auto += Math.max(0, e.calls - e.asks);
  }
  const prompted = list.filter(e => e.asks > 0).sort((x, y) => y.asks - x.asks);
  return { totalCalls, totalAsks, byTool, prompted, list };
}

// Multi-verb tools where the second token is a meaningful subcommand worth scoping
// the rule to (Bash(git push *)) rather than the whole tool (Bash(git *)).
const SUBCOMMAND_TOOLS = new Set([
  "git", "gh", "npm", "npx", "yarn", "pnpm", "cargo", "docker", "kubectl",
  "pip", "pip3", "go", "dotnet", "brew", "apt", "systemctl", "mullvad", "netsh"
]);

// Segment heads we must never propose blanket-allowing: arbitrary exec / deletion /
// network / opaque shells, plus `cat` (the canonical `cat > file` arbitrary-content
// write idiom — deliberately left prompting per the standing allowlist decision). A
// prompted command containing one of these is, by design, left to prompt each time —
// blockedByPolicy() surfaces it instead of suggestRules().
const UNSAFE_PREFIXES = new Set([
  "cd", "rm", "rmdir", "mv", "dd", "cat", "sudo", "eval", "exec", "source", ".",
  "bash", "sh", "zsh", "pwsh", "powershell", "powershell.exe", "cmd", "cmd.exe",
  "find", "awk", "xargs", "chmod", "chown", "kill", "curl", "wget", "scp", "ssh"
]);

// Segment heads that are meaningless to write a specific allow rule for: shell
// control words and pure-output builtins (the latter are allowlisted wholesale).
const NOISE_PREFIXES = new Set([
  "for", "if", "while", "until", "do", "done", "then", "else", "elif", "fi",
  "case", "esac", "function", "select", "time", "[", "[[", "{", "(", ":",
  "test", "echo", "printf", "true", "false"
]);

// Split a shell command into pipeline/sequence segments, but only on separators
// that sit OUTSIDE quotes — so a powershell.exe -Command "...|...|..." one-liner
// stays a single segment instead of being shredded into fake cmdlet "segments".
function splitSegments(cmd) {
  const s = String(cmd || "");
  const segs = [];
  let cur = "", q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    // A heredoc body (<<EOF …) is inline data, not shell — stop splitting once it starts.
    if (c === "<" && s[i + 1] === "<") { cur += s.slice(i); break; }
    if (c === "\n" || c === ";") { segs.push(cur); cur = ""; continue; }
    if (c === "&" && s[i + 1] === "&") { segs.push(cur); cur = ""; i++; continue; }
    if (c === "|" && s[i + 1] === "|") { segs.push(cur); cur = ""; i++; continue; }
    if (c === "|") { segs.push(cur); cur = ""; continue; }
    cur += c;
  }
  segs.push(cur);
  return segs.map(x => x.trim()).filter(Boolean);
}

function candidatePrefix(segment) {
  const seg = String(segment || "").trim().replace(/^[!({]\s*/, "");
  const tokens = seg.split(/\s+/).filter(Boolean);
  // Skip leading env-assignment prefixes (FOO=bar cmd …) to reach the real command,
  // but leave command-substitution assignments (T=$(…)) alone.
  while (tokens.length > 1 && /^[A-Za-z_]\w*=/.test(tokens[0]) && !/\$\(|`/.test(tokens[0])) {
    tokens.shift();
  }
  if (!tokens.length) return null;
  const head = tokens[0];
  const exact = tokens.length === 1;
  let prefix = head;
  if (SUBCOMMAND_TOOLS.has(head) && tokens[1] && /^[a-z][a-z0-9-]*$/i.test(tokens[1])) {
    prefix = head + " " + tokens[1];
  }
  return { head: head, prefix: prefix, exact: exact };
}

// Does an existing allow/deny rule already cover commands of this prefix?
function isCovered(prefix, patterns) {
  for (const p of patterns || []) {
    const mm = /^Bash\((.+)\)$/.exec(p);
    if (!mm) continue;
    const pat = mm[1];
    if (pat === "*") return true;
    if (/\s\*$/.test(pat)) {
      const base = pat.slice(0, -2);
      if ((prefix + " ").startsWith(base + " ")) return true;
    } else if (prefix === pat) {
      return true;
    }
  }
  return false;
}

function suggestRules(prompted, opts) {
  opts = opts || {};
  const allow = opts.allow || [];
  const deny = opts.deny || [];
  const ask = opts.ask || [];
  const groups = {};
  for (const e of prompted) {
    if (e.tool !== "Bash") continue;
    const seen = {};
    for (const seg of splitSegments(e.sum)) {
      const cp = candidatePrefix(seg);
      if (!cp) continue;
      if (UNSAFE_PREFIXES.has(cp.head) || NOISE_PREFIXES.has(cp.head)) continue;
      // skip if already allowed (redundant) or deliberately set to prompt/block (deny/ask)
      if (isCovered(cp.prefix, allow) || isCovered(cp.prefix, deny) || isCovered(cp.prefix, ask)) continue;
      const rule = cp.exact ? "Bash(" + cp.prefix + ")" : "Bash(" + cp.prefix + " *)";
      if (seen[rule]) continue;       // credit a prefix at most once per command
      seen[rule] = true;
      const g = groups[rule] || (groups[rule] = { rule: rule, asks: 0, commands: 0, examples: [] });
      g.asks += e.asks;
      g.commands += 1;
      if (g.examples.length < 3) g.examples.push(e.sum);
    }
  }
  return Object.keys(groups).map(k => groups[k])
    .sort((x, y) => y.asks - x.asks || y.commands - x.commands);
}

// Prompted commands that will keep prompting because they contain a segment we
// refuse to blanket-allow (UNSAFE_PREFIXES). Explains the residual prompt rate.
function blockedByPolicy(prompted) {
  const groups = {};
  for (const e of prompted) {
    if (e.tool !== "Bash") continue;
    const seen = {};
    for (const seg of splitSegments(e.sum)) {
      const cp = candidatePrefix(seg);
      if (!cp || !UNSAFE_PREFIXES.has(cp.head) || seen[cp.head]) continue;
      seen[cp.head] = true;
      const g = groups[cp.head] || (groups[cp.head] = { prefix: cp.head, asks: 0, commands: 0 });
      g.asks += e.asks;
      g.commands += 1;
    }
  }
  return Object.keys(groups).map(k => groups[k]).sort((x, y) => y.asks - x.asks);
}

function collectPermissions(objs) {
  const allow = [], deny = [], ask = [];
  for (const o of objs || []) {
    const p = o && o.permissions;
    if (!p) continue;
    if (Array.isArray(p.allow)) allow.push.apply(allow, p.allow);
    if (Array.isArray(p.deny)) deny.push.apply(deny, p.deny);
    if (Array.isArray(p.ask)) ask.push.apply(ask, p.ask);
  }
  return { allow: allow, deny: deny, ask: ask };
}

function loadPerms() {
  const dir = path.join(__dirname, "..");
  const objs = [];
  for (const f of ["settings.json", "settings.local.json"]) {
    try { objs.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); } catch (_) {}
  }
  return collectPermissions(objs);
}

function doPrune(store, days, nowMs) {
  const cutoff = nowMs - days * 86400000;
  let removed = 0;
  for (const k of Object.keys(store.entries)) {
    if (Date.parse(store.entries[k].last) < cutoff) { delete store.entries[k]; removed++; }
  }
  return removed;
}

function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }

function render(rep, perms) {
  perms = perms || { allow: [], deny: [] };
  const lines = [];
  lines.push("Permission audit — " + rep.totalCalls + " calls, " + rep.totalAsks +
    " prompts (" + pct(rep.totalAsks, rep.totalCalls) + "% prompt rate)");
  lines.push("");
  lines.push("By tool:");
  Object.keys(rep.byTool).map(k => rep.byTool[k]).sort((x, y) => y.calls - x.calls).forEach(t => {
    const auto = t.auto;
    lines.push("  " + t.tool + ": " + t.calls + " calls, " + auto + " auto, " + t.asks + " prompted");
  });
  lines.push("");
  if (rep.prompted.length) {
    lines.push("Most-prompted commands (allowlist gaps):");
    rep.prompted.slice(0, 20).forEach(e => lines.push("  [" + e.asks + "x] " + e.tool + ": " + e.sum));
    lines.push("");
    const sugg = suggestRules(rep.prompted, perms);
    if (sugg.length) {
      lines.push("Suggested Bash allowlist rules (segment-aware, excludes already-allowed):");
      sugg.slice(0, 15).forEach(s => lines.push(
        "  " + s.rule + "   (" + s.asks + " prompts across " + s.commands + " cmds; e.g. " + s.examples[0] + ")"));
      lines.push("");
    }
    const blocked = blockedByPolicy(rep.prompted);
    if (blocked.length) {
      lines.push("Left to prompt by design (unsafe to blanket-allow):");
      blocked.slice(0, 10).forEach(b => lines.push(
        "  " + b.prefix + "   (" + b.asks + " prompts across " + b.commands + " cmds)"));
    }
  } else {
    lines.push("No prompted commands recorded yet.");
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error("audit-permissions: " + args.error); process.exit(1); }
  if (args.prune != null) {
    const fd = lib.acquireLock();
    if (fd === null) { console.error("audit-permissions: could not acquire store lock; try again."); process.exit(1); }
    try {
      const store = lib.loadStore();
      if (!store.entries) store.entries = {};
      const removed = doPrune(store, args.prune, Date.now());
      lib.saveStore(store);
      console.log("Pruned " + removed + " entries not seen in " + args.prune + " days.");
    } finally {
      lib.releaseLock(fd);
    }
    return;
  }
  const store = lib.loadStore();
  if (!store.entries) store.entries = {};
  const rep = summarizeReport(store, { since: args.since });
  const perms = loadPerms();
  if (args.json) {
    console.log(JSON.stringify({
      totalCalls: rep.totalCalls, totalAsks: rep.totalAsks,
      byTool: rep.byTool, prompted: rep.prompted,
      suggestions: suggestRules(rep.prompted, perms),
      blockedByPolicy: blockedByPolicy(rep.prompted)
    }, null, 2));
  } else {
    console.log(render(rep, perms));
  }
}

if (require.main === module) main();
module.exports = {
  summarizeReport, suggestRules, doPrune, parseArgs, render,
  splitSegments, candidatePrefix, isCovered, blockedByPolicy, collectPermissions
};
