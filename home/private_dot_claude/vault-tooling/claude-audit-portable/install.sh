#!/usr/bin/env bash
# Claude Code permission-audit system - portable installer (generated; do not hand-edit).
# Usage: bash install.sh [TARGET_DIR]   (default: current directory)
set -u
TARGET="${1:-.}"
echo "Installing the Claude Code permission-audit system into: $TARGET"

write() {
  mkdir -p "$(dirname "$TARGET/$1")"
  cat > "$TARGET/$1"
}

write ".claude/hooks/log-permission.js" <<'__CLAUDE_AUDIT_PKG_EOF__'
"use strict";
const fs = require("fs");
const path = require("path");

const SCOPE = /^(Bash|Write|Edit|WebFetch|WebSearch|Task|Agent|Skill|mcp__.*)$/;
const SUM_CAP = 500;
const SEP = " ";
const MAX_ENTRIES = 5000;
const RETENTION_DAYS = 180;
const ASK_DEDUP_MS = 2000;
const LOCK_RETRIES = 10;
const LOCK_DELAY_MS = 20;
const LOCK_STALE_MS = 10000;
const STORE_PATH = process.env.PERMLOG_STORE || path.join(__dirname, "..", "logs", "permissions.json");
const LOCK_PATH = STORE_PATH + ".lock";

function inScope(tool) {
  return typeof tool === "string" && SCOPE.test(tool);
}

function cap(s) {
  s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return s.length > SUM_CAP ? s.slice(0, SUM_CAP) : s;
}

// Collapse volatile temp-file paths to a stable "<tmp>" token so that otherwise-
// identical one-off commands (node "...Temp/qedit.js", node "...Temp/qedit2.js")
// aggregate into a single store entry instead of bloating cardinality forever.
// Only clearly-temp locations are touched; real project paths pass through unchanged.
// Covers all three platforms so the hook is portable (Windows/macOS/Linux).
function normalizeVolatile(s) {
  return String(s == null ? "" : s)
    // Windows per-user temp dir (forward- or back-slashed)
    .replace(/[A-Za-z]:[\/\\]Users[\/\\][^\/\\\s"']+[\/\\]AppData[\/\\]Local[\/\\]Temp[\/\\][^\s"')]+/gi, "<tmp>")
    // macOS per-user temp dir ($TMPDIR → /var/folders/xx/.../T/…)
    .replace(/\/var\/folders\/[^\s"')]+/g, "<tmp>")
    // Unix-style temp dir (Linux, and the cross-platform /tmp)
    .replace(/\/tmp\/[^\s"')]+/g, "<tmp>");
}

function summarize(tool, input) {
  input = input || {};
  switch (tool) {
    case "Bash":      return cap(normalizeVolatile(input.command));
    case "Write":
    case "Edit":      return cap(input.file_path);
    case "WebFetch":  return cap(input.url);
    case "WebSearch": return cap(input.query);
    case "Task":
    case "Agent":     return cap([input.subagent_type, input.description].filter(Boolean).join(": "));
    case "Skill":     return cap(input.skill || input.command);
    default:
      if (typeof tool === "string" && tool.indexOf("mcp__") === 0) {
        const keys = Object.keys(input).slice(0, 3);
        return cap(keys.map(k => k + "=" + String(input[k])).join(" "));
      }
      return "";
  }
}

function keyFor(tool, sum) { return tool + SEP + sum; }

function classify(d) {
  const evt = d.hook_event_name;
  const tool = d.tool_name;
  if (evt === "PreToolUse") {
    if (!inScope(tool)) return null;
    return { kind: "call", tool: tool, sum: summarize(tool, d.tool_input) };
  }
  if (evt === "PermissionRequest") {
    if (!inScope(tool)) return null;
    return { kind: "ask", tool: tool, sum: summarize(tool, d.tool_input) };
  }
  if (evt === "Notification" && d.notification_type === "permission_prompt") {
    // If tool_name is absent, inScope(undefined) is false and we drop the event.
    // The "(unattributed)" fallback only applies when the tool is known but tool_input is missing.
    if (!inScope(tool)) return null;
    const sum = d.tool_input ? summarize(tool, d.tool_input) : "(unattributed)";
    return { kind: "ask", tool: tool, sum: sum };
  }
  return null;
}

function applyEvent(store, e, nowIso) {
  const nowMs = Date.parse(nowIso);
  if (!store.lastAskByTool) store.lastAskByTool = {};
  // A single prompt can surface as both a PermissionRequest (carries the command)
  // and a Notification (often without it → "(unattributed)"). Suppress the
  // unattributed echo when any ask for this tool fired within the window, so the
  // pair counts once. Checked before touching store.entries so no phantom
  // "(unattributed)" entry is created. Attributed asks are never per-tool-deduped,
  // so genuinely distinct prompts (e.g. parallel tool calls) are still each counted.
  if (e.kind === "ask" && e.sum === "(unattributed)") {
    const toolLastMs = store.lastAskByTool[e.tool] ? Date.parse(store.lastAskByTool[e.tool]) : 0;
    if (nowMs - toolLastMs < ASK_DEDUP_MS) return false;
  }
  const key = keyFor(e.tool, e.sum);
  let ent = store.entries[key];
  if (!ent) {
    ent = store.entries[key] = { tool: e.tool, sum: e.sum, calls: 0, asks: 0, first: nowIso, last: nowIso };
  }
  if (e.kind === "call") {
    ent.calls++;
    ent.last = nowIso;
    store.updated = nowIso;
    return true;
  }
  const lastAskMs = ent.lastAsk ? Date.parse(ent.lastAsk) : 0;
  if (nowMs - lastAskMs >= ASK_DEDUP_MS) {
    ent.asks++;
    ent.lastAsk = nowIso;
    ent.last = nowIso;
    store.lastAskByTool[e.tool] = nowIso;
    store.updated = nowIso;
    return true;
  }
  return false;
}

function pruneIfNeeded(store, nowMs) {
  // Always drop entries past the retention horizon (cheap, keeps one-off noise from
  // lingering for months), then hard-cap the entry count as a backstop.
  const cutoff = nowMs - RETENTION_DAYS * 86400000;
  for (const k of Object.keys(store.entries)) {
    if (Date.parse(store.entries[k].last) < cutoff) delete store.entries[k];
  }
  let remaining = Object.keys(store.entries);
  if (remaining.length > MAX_ENTRIES) {
    remaining.sort((a, b) => Date.parse(store.entries[a].last) - Date.parse(store.entries[b].last));
    const toDrop = remaining.length - MAX_ENTRIES;
    for (let i = 0; i < toDrop; i++) delete store.entries[remaining[i]];
  }
  return store;
}

function sleepSync(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function acquireLock() {
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      return fs.openSync(LOCK_PATH, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") return null;
      try {
        // Best-effort stale-lock recovery: if a previous holder died leaving its lock,
        // reclaim it after LOCK_STALE_MS. There is a tiny TOCTOU window between stat and
        // unlink; the worst case is dropping a single log increment, which is acceptable
        // for an observability-only hook.
        const st = fs.statSync(LOCK_PATH);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(LOCK_PATH); continue; }
      } catch (_) {}
      sleepSync(LOCK_DELAY_MS);
    }
  }
  return null;
}

function releaseLock(fd) {
  try { fs.closeSync(fd); } catch (_) {}
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
}

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")); }
  catch (_) { return { version: 1, updated: null, entries: {} }; }
}

function saveStore(store) {
  const tmp = STORE_PATH + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2);
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

function main() {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch (_) { return; }
  let d;
  try { d = JSON.parse(raw); } catch (_) { return; }
  const e = classify(d);
  if (!e) return;
  try { fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true }); } catch (_) {}
  const fd = acquireLock();
  if (fd === null) return;
  try {
    const nowIso = new Date().toISOString();
    const store = loadStore();
    if (!store.entries) store.entries = {};
    if (applyEvent(store, e, nowIso)) {
      pruneIfNeeded(store, Date.now());
      saveStore(store);
    }
  } catch (_) {
    // never disrupt the tool call
  } finally {
    releaseLock(fd);
  }
}

if (require.main === module) {
  try { main(); } catch (_) {}
}

module.exports = { inScope, cap, normalizeVolatile, summarize, keyFor, classify, applyEvent, pruneIfNeeded, acquireLock, releaseLock, loadStore, saveStore, STORE_PATH, LOCK_PATH, SEP, ASK_DEDUP_MS, MAX_ENTRIES, RETENTION_DAYS };
__CLAUDE_AUDIT_PKG_EOF__

write ".claude/hooks/log-permission.test.js" <<'__CLAUDE_AUDIT_PKG_EOF__'
"use strict";
const assert = require("assert");
const m = require("./log-permission.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("ok   - " + name); }
  catch (e) { fail++; console.error("FAIL - " + name + ": " + e.message); }
}
process.on("exit", () => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
});

test("inScope matches Bash and mcp tools, rejects Read", () => {
  assert.strictEqual(m.inScope("Bash"), true);
  assert.strictEqual(m.inScope("mcp__context7__query-docs"), true);
  assert.strictEqual(m.inScope("Skill"), true);
  assert.strictEqual(m.inScope("Read"), false);
  assert.strictEqual(m.inScope("Glob"), false);
  assert.strictEqual(m.inScope(undefined), false);
});

test("cap collapses whitespace, trims, and caps length", () => {
  assert.strictEqual(m.cap("  git   status \n"), "git status");
  assert.strictEqual(m.cap(null), "");
  assert.strictEqual(m.cap("a".repeat(600)).length, 500);
});

test("summarize extracts the right field per tool", () => {
  assert.strictEqual(m.summarize("Bash", { command: "git status" }), "git status");
  assert.strictEqual(m.summarize("Write", { file_path: "/x/y.md" }), "/x/y.md");
  assert.strictEqual(m.summarize("WebFetch", { url: "https://e.com" }), "https://e.com");
  assert.strictEqual(m.summarize("WebSearch", { query: "node test" }), "node test");
  assert.strictEqual(m.summarize("Task", { subagent_type: "Explore", description: "find x" }), "Explore: find x");
  assert.strictEqual(m.summarize("Skill", { skill: "vault-commit" }), "vault-commit");
});

test("summarize handles mcp__ tools via first keys", () => {
  assert.strictEqual(
    m.summarize("mcp__ctx__query", { library_id: "react", tokens: 5000 }),
    "library_id=react tokens=5000");
});

test("keyFor joins tool and sum with a space separator", () => {
  assert.strictEqual(m.keyFor("Bash", "git status"), "Bash" + m.SEP + "git status");
});

test("classify maps PreToolUse to a call, out-of-scope to null", () => {
  assert.deepStrictEqual(
    m.classify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }),
    { kind: "call", tool: "Bash", sum: "ls" });
  assert.strictEqual(
    m.classify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } }), null);
});

test("classify maps PermissionRequest and Notification(permission_prompt) to asks", () => {
  assert.deepStrictEqual(
    m.classify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm i" } }),
    { kind: "ask", tool: "Bash", sum: "npm i" });
  assert.deepStrictEqual(
    m.classify({ hook_event_name: "Notification", notification_type: "permission_prompt", tool_name: "Bash" }),
    { kind: "ask", tool: "Bash", sum: "(unattributed)" });
  assert.strictEqual(
    m.classify({ hook_event_name: "Notification", notification_type: "idle_prompt", tool_name: "Bash" }), null);
});

test("applyEvent increments calls and sets first/last", () => {
  const store = { version: 1, updated: null, entries: {} };
  m.applyEvent(store, { kind: "call", tool: "Bash", sum: "ls" }, "2026-06-17T10:00:00.000Z");
  m.applyEvent(store, { kind: "call", tool: "Bash", sum: "ls" }, "2026-06-17T10:01:00.000Z");
  const e = store.entries["Bash" + m.SEP + "ls"];
  assert.strictEqual(e.calls, 2);
  assert.strictEqual(e.asks, 0);
  assert.strictEqual(e.first, "2026-06-17T10:00:00.000Z");
  assert.strictEqual(e.last, "2026-06-17T10:01:00.000Z");
});

test("applyEvent dedups asks within the window and reports change", () => {
  const store = { version: 1, updated: null, entries: {} };
  assert.strictEqual(m.applyEvent(store, { kind: "ask", tool: "Bash", sum: "npm i" }, "2026-06-17T10:00:00.000Z"), true);
  assert.strictEqual(m.applyEvent(store, { kind: "ask", tool: "Bash", sum: "npm i" }, "2026-06-17T10:00:01.000Z"), false);
  assert.strictEqual(m.applyEvent(store, { kind: "ask", tool: "Bash", sum: "npm i" }, "2026-06-17T10:00:06.000Z"), true);
  assert.strictEqual(store.entries["Bash" + m.SEP + "npm i"].asks, 2);
});

test("pruneIfNeeded is a no-op under the cap", () => {
  const store = { version: 1, updated: null, entries: { a: { tool: "Bash", sum: "a", calls: 1, asks: 0, first: "x", last: "2026-06-17T10:00:00.000Z" } } };
  m.pruneIfNeeded(store, Date.parse("2026-06-18T00:00:00.000Z"));
  assert.strictEqual(Object.keys(store.entries).length, 1);
});

test("pruneIfNeeded drops stale entries when over cap", () => {
  const now = Date.parse("2026-06-17T00:00:00.000Z");
  const store = { version: 1, updated: null, entries: {} };
  // one fresh entry, plus MAX_ENTRIES stale ones (last seen ~1 year ago)
  store.entries["fresh"] = { tool: "Bash", sum: "fresh", calls: 1, asks: 0, first: "x", last: "2026-06-17T00:00:00.000Z" };
  const stale = new Date(now - 365 * 86400000).toISOString();
  for (let i = 0; i < m.MAX_ENTRIES; i++) {
    store.entries["s" + i] = { tool: "Bash", sum: "s" + i, calls: 1, asks: 0, first: "x", last: stale };
  }
  m.pruneIfNeeded(store, now);
  assert.ok(store.entries["fresh"], "fresh entry retained");
  assert.ok(Object.keys(store.entries).length <= m.MAX_ENTRIES, "down to cap");
});

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function runHook(storePath, payload) {
  execFileSync(process.execPath, [path.join(__dirname, "log-permission.js")], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env, { PERMLOG_STORE: storePath })
  });
}

test("end-to-end: a call then a prompt yields calls=1, asks=1", () => {
  const tmp = path.join(os.tmpdir(), "permlog-test-" + process.pid + ".json");
  try { fs.unlinkSync(tmp); } catch (_) {}
  runHook(tmp, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "deploy.sh" } });
  runHook(tmp, { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "deploy.sh" } });
  const store = JSON.parse(fs.readFileSync(tmp, "utf8"));
  const e = store.entries["Bash" + m.SEP + "deploy.sh"];
  assert.strictEqual(e.calls, 1);
  assert.strictEqual(e.asks, 1);
  fs.unlinkSync(tmp);
});

test("end-to-end: out-of-scope and malformed input do not write the store", () => {
  const tmp = path.join(os.tmpdir(), "permlog-test2-" + process.pid + ".json");
  try { fs.unlinkSync(tmp); } catch (_) {}
  runHook(tmp, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } });
  // malformed stdin must not throw (exit 0); store stays absent
  execFileSync(process.execPath, [path.join(__dirname, "log-permission.js")], {
    input: "not json", env: Object.assign({}, process.env, { PERMLOG_STORE: tmp })
  });
  assert.strictEqual(fs.existsSync(tmp), false);
});

test("end-to-end: lock contention drops the event without touching the store", () => {
  const tmp = path.join(os.tmpdir(), "permlog-test3-" + process.pid + ".json");
  const lock = tmp + ".lock";
  try { fs.unlinkSync(tmp); } catch (_) {}
  fs.writeFileSync(lock, String(process.pid)); // hold a fresh (non-stale) lock
  try {
    runHook(tmp, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "x" } });
    assert.strictEqual(fs.existsSync(tmp), false);
  } finally {
    try { fs.unlinkSync(lock); } catch (_) {}
  }
});

test("summarize collapses Windows temp paths so one-off temp commands aggregate", () => {
  const a = m.summarize("Bash", { command: 'node "C:/Users/alice/AppData/Local/Temp/qedit.js"' });
  const b = m.summarize("Bash", { command: 'node "C:/Users/alice/AppData/Local/Temp/qedit2.js"' });
  assert.strictEqual(a, 'node "<tmp>"');
  assert.strictEqual(a, b, "different temp filenames collapse to the same key");
});

test("summarize collapses /tmp paths and backslash temp paths", () => {
  assert.strictEqual(m.summarize("Bash", { command: "cat /tmp/diag-12345.log" }), "cat <tmp>");
  assert.strictEqual(
    m.summarize("Bash", { command: 'node "C:\\Users\\alice\\AppData\\Local\\Temp\\x.js"' }),
    'node "<tmp>"');
});

test("summarize collapses macOS /var/folders temp paths (cross-platform)", () => {
  assert.strictEqual(
    m.summarize("Bash", { command: "node /var/folders/xy/abc123def/T/qedit.js" }),
    "node <tmp>");
});

test("summarize leaves non-temp vault paths untouched", () => {
  const cmd = 'node "C:/Users/alice/MyProject/.claude/scripts/check-links.js"';
  assert.strictEqual(m.summarize("Bash", { command: cmd }), cmd);
});

test("pruneIfNeeded drops entries older than retention even under the cap", () => {
  const now = Date.parse("2026-06-17T00:00:00.000Z");
  const old = new Date(now - (m.RETENTION_DAYS + 20) * 86400000).toISOString();
  const store = { version: 1, updated: null, entries: {
    stale: { tool: "Bash", sum: "stale", calls: 1, asks: 0, first: "x", last: old },
    fresh: { tool: "Bash", sum: "fresh", calls: 1, asks: 0, first: "x", last: "2026-06-16T00:00:00.000Z" }
  } };
  m.pruneIfNeeded(store, now);
  assert.ok(!store.entries.stale, "stale entry dropped despite being under the cap");
  assert.ok(store.entries.fresh, "fresh entry retained");
});

test("applyEvent skips an unattributed prompt that echoes a recent attributed one", () => {
  const store = { version: 1, updated: null, entries: {} };
  // PermissionRequest carries the command; Notification echo arrives 0.5s later without it.
  assert.strictEqual(m.applyEvent(store, { kind: "ask", tool: "Bash", sum: "npm i" }, "2026-06-17T10:00:00.000Z"), true);
  assert.strictEqual(m.applyEvent(store, { kind: "ask", tool: "Bash", sum: "(unattributed)" }, "2026-06-17T10:00:00.500Z"), false);
  assert.strictEqual(store.entries["Bash" + m.SEP + "npm i"].asks, 1);
  assert.ok(!store.entries["Bash" + m.SEP + "(unattributed)"], "no phantom unattributed entry created");
});

test("applyEvent still counts a standalone unattributed prompt", () => {
  const store = { version: 1, updated: null, entries: {} };
  assert.strictEqual(m.applyEvent(store, { kind: "ask", tool: "Bash", sum: "(unattributed)" }, "2026-06-17T10:00:00.000Z"), true);
  assert.strictEqual(store.entries["Bash" + m.SEP + "(unattributed)"].asks, 1);
});

test("applyEvent counts distinct attributed prompts even seconds apart (no per-tool over-dedup)", () => {
  const store = { version: 1, updated: null, entries: {} };
  // two different real commands prompted ~1s apart (e.g. parallel tool calls) must both count
  assert.strictEqual(m.applyEvent(store, { kind: "ask", tool: "Bash", sum: "cmd-a" }, "2026-06-17T10:00:00.000Z"), true);
  assert.strictEqual(m.applyEvent(store, { kind: "ask", tool: "Bash", sum: "cmd-b" }, "2026-06-17T10:00:01.000Z"), true);
  assert.strictEqual(store.entries["Bash" + m.SEP + "cmd-a"].asks, 1);
  assert.strictEqual(store.entries["Bash" + m.SEP + "cmd-b"].asks, 1);
});
__CLAUDE_AUDIT_PKG_EOF__

write ".claude/scripts/audit-permissions.js" <<'__CLAUDE_AUDIT_PKG_EOF__'
#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require("../hooks/log-permission.js");

const STORE_PATH = lib.STORE_PATH;

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
__CLAUDE_AUDIT_PKG_EOF__

write ".claude/scripts/audit-permissions.test.js" <<'__CLAUDE_AUDIT_PKG_EOF__'
"use strict";
const assert = require("assert");
const a = require("./audit-permissions.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("ok   - " + name); }
  catch (e) { fail++; console.error("FAIL - " + name + ": " + e.message); }
}
process.on("exit", () => { console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1; });

function fixture() {
  return {
    version: 1,
    updated: "2026-06-17T10:00:00.000Z",
    entries: {
      k1: { tool: "Bash", sum: "git status", calls: 50, asks: 0, first: "2026-06-01T00:00:00.000Z", last: "2026-06-17T00:00:00.000Z" },
      k2: { tool: "Bash", sum: "git push origin main", calls: 6, asks: 6, first: "2026-06-02T00:00:00.000Z", last: "2026-06-16T00:00:00.000Z" },
      k3: { tool: "Bash", sum: "git pull", calls: 3, asks: 2, first: "2026-06-03T00:00:00.000Z", last: "2026-06-10T00:00:00.000Z" },
      k4: { tool: "Write", sum: "/x/y.md", calls: 10, asks: 0, first: "2026-06-04T00:00:00.000Z", last: "2026-06-15T00:00:00.000Z" }
    }
  };
}

test("summarizeReport totals calls and asks across entries", () => {
  const rep = a.summarizeReport(fixture(), {});
  assert.strictEqual(rep.totalCalls, 69);
  assert.strictEqual(rep.totalAsks, 8);
  assert.strictEqual(rep.byTool.Bash.calls, 59);
  assert.strictEqual(rep.byTool.Write.calls, 10);
});

test("summarizeReport prompted list is sorted by asks desc and excludes never-prompted", () => {
  const rep = a.summarizeReport(fixture(), {});
  assert.strictEqual(rep.prompted.length, 2);
  assert.strictEqual(rep.prompted[0].sum, "git push origin main");
  assert.strictEqual(rep.prompted[1].sum, "git pull");
});

test("summarizeReport --since filters by last-seen", () => {
  const rep = a.summarizeReport(fixture(), { since: "2026-06-14T00:00:00.000Z" });
  // k3 (last 2026-06-10) drops out
  assert.strictEqual(rep.totalAsks, 6);
});

test("suggestRules groups prompted Bash commands by prefix", () => {
  const rep = a.summarizeReport(fixture(), {});
  const rules = a.suggestRules(rep.prompted);
  assert.strictEqual(rules[0].rule, "Bash(git push *)");
  assert.ok(rules.some(r => r.rule === "Bash(git pull *)"));
});

test("doPrune removes entries not seen within N days", () => {
  const store = fixture();
  // relative to 2026-06-17, prune everything older than 5 days → k3 (06-10) and k2(06-16 kept), k1(06-17 kept), k4(06-15 kept)
  const removed = a.doPrune(store, 5, Date.parse("2026-06-17T00:00:00.000Z"));
  assert.strictEqual(removed, 1);
  assert.ok(!store.entries.k3);
});

test("parseArgs validates flags and values", () => {
  assert.strictEqual(a.parseArgs(["--json"]).json, true);
  assert.strictEqual(a.parseArgs(["--since", "2026-06-01"]).since, "2026-06-01");
  assert.strictEqual(a.parseArgs(["--prune", "30"]).prune, 30);
  assert.ok(a.parseArgs(["--prune", "abc"]).error);
  assert.ok(a.parseArgs(["--prune"]).error);
  assert.ok(a.parseArgs(["--since"]).error);
  assert.ok(a.parseArgs(["--since", "notadate"]).error);
  assert.ok(a.parseArgs(["--bogus"]).error);
});

test("suggestRules emits an exact rule for single-token commands", () => {
  const rules = a.suggestRules([{ tool: "Bash", sum: "htop", asks: 3 }]);
  assert.strictEqual(rules[0].rule, "Bash(htop)");
});

test("render handles empty and populated reports", () => {
  const out0 = a.render(a.summarizeReport({ version: 1, updated: null, entries: {} }, {}));
  assert.ok(out0.includes("0 calls"));
  assert.ok(out0.includes("No prompted commands"));
  const out = a.render(a.summarizeReport(fixture(), {}));
  assert.ok(out.includes("Most-prompted"));
  assert.ok(out.includes("Bash(git push *)"));
});

test("summarizeReport per-tool auto sums per-entry max(0, calls-asks)", () => {
  // Aggregate subtraction would give 13 - 5 = 8; correct per-entry sum is 0 + 10 = 10.
  const store = { version: 1, updated: null, entries: {
    e1: { tool: "Bash", sum: "a", calls: 3, asks: 5, first: "2026-06-01T00:00:00.000Z", last: "2026-06-10T00:00:00.000Z" },
    e2: { tool: "Bash", sum: "b", calls: 10, asks: 0, first: "2026-06-01T00:00:00.000Z", last: "2026-06-10T00:00:00.000Z" }
  } };
  const rep = a.summarizeReport(store, {});
  assert.strictEqual(rep.byTool.Bash.auto, 10);
});

test("parseArgs rejects --prune 0 (would wipe the log)", () => {
  assert.ok(a.parseArgs(["--prune", "0"]).error);
  assert.strictEqual(a.parseArgs(["--prune", "1"]).prune, 1);
});

test("splitSegments breaks compound commands on &&, ||, |, ;, and newlines", () => {
  assert.deepStrictEqual(a.splitSegments("echo hi && grep foo bar | head -5"), ["echo hi", "grep foo bar", "head -5"]);
  assert.deepStrictEqual(a.splitSegments("a ; b || c"), ["a", "b", "c"]);
  assert.deepStrictEqual(a.splitSegments("solo"), ["solo"]);
});

test("splitSegments does not split on separators inside quotes (PowerShell pipelines stay intact)", () => {
  assert.deepStrictEqual(
    a.splitSegments('powershell.exe -Command "Get-Process | Where-Object { $_.x }" 2>&1 | head -5'),
    ['powershell.exe -Command "Get-Process | Where-Object { $_.x }" 2>&1', 'head -5']);
  assert.deepStrictEqual(a.splitSegments("grep 'a;b' file"), ["grep 'a;b' file"]);
});

test("splitSegments treats a heredoc body as data, not shell segments", () => {
  const cmd = "cat > /tmp/diag.ps1 <<'EOF'\nGet-Process | Where-Object { $_.x } | Select-Object Name\nEOF";
  const segs = a.splitSegments(cmd);
  assert.strictEqual(segs.length, 1);
  assert.ok(segs[0].startsWith("cat > /tmp/diag.ps1"));
});

test("suggestRules does not mine cmdlets from inside a powershell -Command string", () => {
  const rules = a.suggestRules([
    { tool: "Bash", sum: 'powershell.exe -NoProfile -Command "Get-Process | Where-Object { $_.x } | ForEach-Object { $_ }"', asks: 9 }
  ]);
  assert.strictEqual(rules.length, 0, "no ForEach-Object/Where-Object suggestions");
});

test("candidatePrefix uses a subcommand for multi-verb tools but a bare head otherwise", () => {
  assert.strictEqual(a.candidatePrefix("git push origin main").prefix, "git push");
  assert.strictEqual(a.candidatePrefix("gh api repos/x").prefix, "gh api");
  assert.strictEqual(a.candidatePrefix("head -40 file").prefix, "head"); // flag arg, not a subcommand
  assert.strictEqual(a.candidatePrefix("ls -la /c").prefix, "ls");
  assert.strictEqual(a.candidatePrefix('node "C:/x.js"').prefix, "node");
  const htop = a.candidatePrefix("htop");
  assert.strictEqual(htop.exact, true);
});

test("candidatePrefix ignores leading env-assignment prefixes", () => {
  assert.strictEqual(a.candidatePrefix('PERMLOG_STORE="$T" node x.js').prefix, "node");
  assert.strictEqual(a.candidatePrefix("NODE_ENV=test npm run build").prefix, "npm run");
  // a command-substitution assignment is not a simple env prefix → left alone
  assert.strictEqual(a.candidatePrefix("T=$(node -e 1) echo hi").head, "T=$(node");
});

test("isCovered matches wildcard and exact allow rules, respects boundaries", () => {
  assert.strictEqual(a.isCovered("git push", ["Bash(git *)"]), true);
  assert.strictEqual(a.isCovered("ls", ["Bash(ls *)"]), true);
  assert.strictEqual(a.isCovered("gh api", ["Bash(gh pr *)"]), false);
  assert.strictEqual(a.isCovered("htop", ["Bash(htop)"]), true);
  assert.strictEqual(a.isCovered("grep", ["Read", "Bash(grep *)"]), true);
});

test("suggestRules splits compound commands and skips unsafe/noise segment heads", () => {
  const rules = a.suggestRules([
    { tool: "Bash", sum: 'cd "C:/x" && echo "=== hi ===" && grep foo bar.txt && head -5 bar.txt', asks: 3 }
  ]);
  const names = rules.map(r => r.rule);
  assert.ok(names.includes("Bash(grep *)"), "suggests the real gap (grep)");
  assert.ok(names.includes("Bash(head *)"), "suggests the real gap (head)");
  assert.ok(!names.some(n => n.startsWith("Bash(cd")), "never suggests a cd-prefixed rule");
  assert.ok(!names.some(n => n.startsWith("Bash(echo")), "never suggests an echo-prefixed rule");
});

test("suggestRules filters out segments already covered by the allow list", () => {
  const prompted = [{ tool: "Bash", sum: "grep foo bar && wc -l bar", asks: 4 }];
  const rules = a.suggestRules(prompted, { allow: ["Bash(grep *)"] });
  const names = rules.map(r => r.rule);
  assert.ok(!names.includes("Bash(grep *)"), "grep already allowed → not suggested");
  assert.ok(names.includes("Bash(wc *)"), "wc still a gap → suggested");
});

test("cat is left to prompt by design: skipped from suggestions, reported as blocked", () => {
  const prompted = [{ tool: "Bash", sum: "cat somefile.md", asks: 9 }];
  assert.strictEqual(a.suggestRules(prompted).length, 0, "cat not suggested");
  const blocked = a.blockedByPolicy(prompted);
  assert.ok(blocked.some(b => b.prefix === "cat" && b.asks === 9), "cat reported as blocked-by-design");
});

test("suggestRules never suggests PowerShell or other unsafe shells", () => {
  const rules = a.suggestRules([
    { tool: "Bash", sum: 'powershell.exe -NoProfile -Command "Get-Process"', asks: 31 }
  ]);
  assert.strictEqual(rules.length, 0);
});

test("blockedByPolicy reports unsafe segment heads that keep commands prompting", () => {
  const blocked = a.blockedByPolicy([
    { tool: "Bash", sum: 'cd "C:/x" && powershell.exe -Command "x"', asks: 5 },
    { tool: "Bash", sum: "rm -f /tmp/x", asks: 2 }
  ]);
  const byPrefix = {};
  blocked.forEach(b => { byPrefix[b.prefix] = b.asks; });
  assert.strictEqual(byPrefix["powershell.exe"], 5);
  assert.strictEqual(byPrefix["cd"], 5);
  assert.strictEqual(byPrefix["rm"], 2);
});

test("collectPermissions merges allow/deny/ask across settings objects", () => {
  const merged = a.collectPermissions([
    { permissions: { allow: ["Bash(git *)"], deny: ["Bash(rm -rf *)"], ask: ["Bash(git reset --hard*)"] } },
    { permissions: { allow: ["Bash(node *)"] } },
    { nothing: true }
  ]);
  assert.deepStrictEqual(merged.allow, ["Bash(git *)", "Bash(node *)"]);
  assert.deepStrictEqual(merged.deny, ["Bash(rm -rf *)"]);
  assert.deepStrictEqual(merged.ask, ["Bash(git reset --hard*)"]);
});

test("suggestRules does not propose a rule the user deliberately set to prompt (ask tier)", () => {
  const prompted = [{ tool: "Bash", sum: "sketchy --do-it", asks: 5 }];
  assert.strictEqual(a.suggestRules(prompted).length, 1, "suggested when not in any tier");
  const rules = a.suggestRules(prompted, { ask: ["Bash(sketchy *)"] });
  assert.strictEqual(rules.length, 0, "suppressed when matched by the ask tier");
});
__CLAUDE_AUDIT_PKG_EOF__

write ".claude/skills/audit-permissions/SKILL.md" <<'__CLAUDE_AUDIT_PKG_EOF__'
---
name: audit-permissions
description: Audit the permission log and propose allowlist improvements. Use when reviewing which Bash commands or tools keep prompting for approval, or when tuning the Claude Code permission setup in .claude/settings.json.
---

Review the permission audit log and propose concrete improvements to the allowlist.

1. Run the audit script and read its output:

   `node .claude/scripts/audit-permissions.js`

   (Add `--since YYYY-MM-DD` to scope to recent activity, or `--json` for raw data.)

2. If the script reports no data, tell the user the log is empty (the hooks may not have run yet — they take effect on the next session after install) and stop.

3. Summarize the findings for the user:
   - Overall prompt rate and per-tool breakdown (auto-approved vs. prompted).
   - The most-prompted commands — these are the allowlist gaps.
   - The **Suggested Bash allowlist rules** — already segment-aware (splits compound `a && b | c` commands, ignores quoted/heredoc bodies and env prefixes) and cross-referenced against the current `allow`/`deny`/`ask` tiers, so already-covered and policy-blocked patterns are filtered out for you.
   - The **Left to prompt by design** section — commands that keep prompting because they contain a segment that is unsafe to blanket-allow (`powershell.exe`, `cd`, `rm`, `find`, `awk`, …). These are *expected* prompts, not gaps; do not propose allowlisting them.

4. For the top suggested rules, propose specific edits to the `allow` list in `.claude/settings.json`. Prefer the narrowest rule that covers the pattern (e.g. `Bash(gh pr *)` over `Bash(gh *)`). The script already excludes anything in `deny`/`ask`, but still sanity-check each pick and call out anything risky to auto-approve (e.g. utilities that can redirect-overwrite files, or anything with an exec/delete vector).

5. Present the proposed `settings.json` changes as a diff and ask for confirmation before editing. Only edit `.claude/settings.json` after the user approves.

6. After any edit, validate the JSON:

   `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); console.log('valid')"`

   and remind the user that permission changes take effect on the next Claude Code session.
__CLAUDE_AUDIT_PKG_EOF__

write ".claude/skills/audit-permissions/README.md" <<'__CLAUDE_AUDIT_PKG_EOF__'
# Claude Code permission-audit system (portable)

A logging-only setup that records which permissioned tool calls Claude Code makes
and which ones prompt you, so you can tune your allowlist with data instead of
guesswork. Pure Node, no dependencies, cross-platform (Windows/macOS/Linux).

## What's in here

```
.claude/
  hooks/log-permission.js          # the hook: records every in-scope tool call + prompt
  hooks/log-permission.test.js     # `node .claude/hooks/log-permission.test.js`
  scripts/audit-permissions.js     # the report: per-tool counts + segment-aware suggestions
  scripts/audit-permissions.test.js
  skills/audit-permissions/SKILL.md  # `/audit-permissions` slash command
  settings.json                    # permissions + the 3 logging hooks (portable paths)
  .gitignore                       # keeps logs/ out of git
logs/permissions.json              # created on first run (gitignored)
```

## How it works

- Three hooks (`PreToolUse`, `PermissionRequest`, `Notification`) all run
  `log-permission.js`, which appends to `.claude/logs/permissions.json`. The hook is
  `async`, swallows all errors, and uses a file lock — it never blocks or breaks a
  tool call.
- `audit-permissions.js` reads that log and reports: overall prompt rate, per-tool
  auto-approved vs. prompted counts, the most-prompted commands, **segment-aware
  suggested allowlist rules** (splits compound `a && b | c` commands, ignores
  quoted/heredoc bodies and env prefixes, cross-references your live
  `allow`/`deny`/`ask` tiers), and a **"left to prompt by design"** list of heads
  that are unsafe to blanket-allow (`rm`, `find`, `cd`, `powershell.exe`, `cat`, …).

## Install

### Empty machine (e.g. a fresh Linux server) — copy the folder

1. Copy the `.claude/` folder into your project root (the directory you run
   `claude` from).
2. Restart Claude Code so it picks up the hooks.
3. Verify: `node .claude/hooks/log-permission.test.js && node .claude/scripts/audit-permissions.test.js`

   (or just run `install.sh` from the package root — it does steps 1–3 for you.)

### Machine that already has a `.claude/settings.json` (e.g. the Mac)

`install.sh` will **not** overwrite an existing `settings.json`. It installs the
code files and drops `settings.audit-snippet.json` next to your settings. Then:

1. Merge the `permissions` and `hooks` blocks from `settings.audit-snippet.json`
   into your existing `.claude/settings.json`.
2. **Remove your previous audit system** — delete its hook command(s) from
   `settings.json` and its log/script files, so you don't double-count events.
3. Add `logs/` to `.claude/.gitignore` (if the project is a git repo).
4. Restart Claude Code.

## Daily use

Run the report any time:

```
node .claude/scripts/audit-permissions.js                 # full report
node .claude/scripts/audit-permissions.js --since 2026-06-01
node .claude/scripts/audit-permissions.js --json
node .claude/scripts/audit-permissions.js --prune 180     # drop entries older than N days
```

Or invoke the `/audit-permissions` skill, which reads the report and proposes
concrete `settings.json` allowlist edits for you to approve.

## Notes

- The log lives only on each machine (`logs/` is gitignored) — counts are per-host,
  which is what you want for per-host allowlist tuning.
- Hook paths use `$CLAUDE_PROJECT_DIR`, so the same `settings.json` works on any
  machine without editing absolute paths. Requires a recent Claude Code that sets
  that variable for hooks (all current versions do).
- `node` must be on PATH for the Claude Code process. If hooks seem inert, confirm
  `which node` resolves in the same shell Claude Code launches.
__CLAUDE_AUDIT_PKG_EOF__

emit_settings() {
cat <<'__CLAUDE_AUDIT_PKG_EOF__'
{
  "permissions": {
    "allow": [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash(git *)",
      "Bash(node *)",
      "Bash(python3 *)",
      "Bash(ls *)",
      "Bash(mkdir *)",
      "Bash(which *)",
      "Bash(echo *)",
      "Bash(head *)",
      "Bash(tail *)",
      "Bash(grep *)",
      "Bash(sort *)",
      "Bash(wc *)",
      "Bash(tr *)",
      "Bash(cut *)"
    ],
    "ask": [
      "Bash(git reset --hard*)",
      "Bash(git clean -f*)",
      "Bash(git checkout -- *)"
    ],
    "deny": [
      "Bash(git push --force*)",
      "Bash(git push -f*)",
      "Bash(rm -rf *)",
      "Bash(rm -fr*)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Bash|Write|Edit|WebFetch|WebSearch|Task|Agent|Skill|mcp__.*)$",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/log-permission.js\"",
            "async": true
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/log-permission.js\"",
            "async": true
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/log-permission.js\"",
            "async": true
          }
        ]
      }
    ]
  }
}
__CLAUDE_AUDIT_PKG_EOF__
}

SETTINGS="$TARGET/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  emit_settings > "$TARGET/.claude/settings.audit-snippet.json"
  SETTINGS_NOTE="EXISTING settings.json left untouched -> wrote settings.audit-snippet.json; merge its permissions+hooks blocks and remove any OLD audit hooks."
else
  emit_settings > "$SETTINGS"
  SETTINGS_NOTE="wrote .claude/settings.json"
fi

GI="$TARGET/.claude/.gitignore"
if ! grep -qs '^logs/' "$GI" 2>/dev/null; then
  printf '%s\n' '# Permission audit log (machine-local; never commit)' 'logs/' >> "$GI"
fi

echo
echo "Files installed. $SETTINGS_NOTE"
echo
if command -v node >/dev/null 2>&1; then
  echo "Self-test:"
  node "$TARGET/.claude/hooks/log-permission.test.js" 2>&1 | tail -1 || true
  node "$TARGET/.claude/scripts/audit-permissions.test.js" 2>&1 | tail -1 || true
else
  echo "WARNING: node not found on PATH - the hooks need it. Install Node, then re-check."
fi

echo
echo "Next steps:"
echo "  1. Restart Claude Code so it loads the hooks."
echo "  2. Use it for a while, then run: node .claude/scripts/audit-permissions.js"
echo "  3. Or invoke the /audit-permissions skill to get allowlist suggestions."
echo "  See .claude/skills/audit-permissions/README.md for details."
