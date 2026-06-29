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
    { kind: "call", tool: "Bash", sum: "ls", session: null });
  assert.strictEqual(
    m.classify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } }), null);
});

test("classify maps PermissionRequest and Notification(permission_prompt) to asks", () => {
  assert.deepStrictEqual(
    m.classify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm i" } }),
    { kind: "ask", tool: "Bash", sum: "npm i", session: null });
  assert.deepStrictEqual(
    m.classify({ hook_event_name: "Notification", notification_type: "permission_prompt", tool_name: "Bash" }),
    { kind: "ask", tool: "Bash", sum: "(unattributed)", session: null });
  assert.strictEqual(
    m.classify({ hook_event_name: "Notification", notification_type: "idle_prompt", tool_name: "Bash" }), null);
});

test("classify passes session_id through when present", () => {
  const e = m.classify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, session_id: "abc-123" });
  assert.strictEqual(e.session, "abc-123");
});

test("applyEvent increments calls, sets first/last, and tracks lastSession", () => {
  const store = { version: 1, updated: null, entries: {} };
  m.applyEvent(store, { kind: "call", tool: "Bash", sum: "ls", session: "s1" }, "2026-06-17T10:00:00.000Z");
  m.applyEvent(store, { kind: "call", tool: "Bash", sum: "ls", session: "s2" }, "2026-06-17T10:01:00.000Z");
  const e = store.entries["Bash" + m.SEP + "ls"];
  assert.strictEqual(e.calls, 2);
  assert.strictEqual(e.asks, 0);
  assert.strictEqual(e.first, "2026-06-17T10:00:00.000Z");
  assert.strictEqual(e.last, "2026-06-17T10:01:00.000Z");
  assert.strictEqual(e.lastSession, "s2");
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
  const a = m.summarize("Bash", { command: 'node "C:/Users/daniel/AppData/Local/Temp/qedit.js"' });
  const b = m.summarize("Bash", { command: 'node "C:/Users/daniel/AppData/Local/Temp/qedit2.js"' });
  assert.strictEqual(a, 'node "<tmp>"');
  assert.strictEqual(a, b, "different temp filenames collapse to the same key");
});

test("summarize collapses /tmp paths and backslash temp paths", () => {
  assert.strictEqual(m.summarize("Bash", { command: "cat /tmp/diag-12345.log" }), "cat <tmp>");
  assert.strictEqual(
    m.summarize("Bash", { command: 'node "C:\\Users\\daniel\\AppData\\Local\\Temp\\x.js"' }),
    'node "<tmp>"');
});

test("summarize collapses macOS /var/folders temp paths (cross-platform)", () => {
  assert.strictEqual(
    m.summarize("Bash", { command: "node /var/folders/xy/abc123def/T/qedit.js" }),
    "node <tmp>");
});

test("summarize leaves non-temp paths untouched", () => {
  const cmd = 'node "C:/Users/daniel/notes/.claude/scripts/check-links.js"';
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

test("classify maps PostToolUseFailure to a fail", () => {
  assert.deepStrictEqual(
    m.classify({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "cargo build" } }),
    { kind: "fail", tool: "Bash", sum: "cargo build", session: null });
  assert.strictEqual(
    m.classify({ hook_event_name: "PostToolUseFailure", tool_name: "Read", tool_input: { file_path: "/x" } }), null);
});

test("applyEvent increments fails counter", () => {
  const store = { version: 1, updated: null, entries: {} };
  m.applyEvent(store, { kind: "call", tool: "Bash", sum: "cargo build", session: "s1" }, "2026-06-17T10:00:00.000Z");
  m.applyEvent(store, { kind: "fail", tool: "Bash", sum: "cargo build", session: "s1" }, "2026-06-17T10:00:05.000Z");
  m.applyEvent(store, { kind: "fail", tool: "Bash", sum: "cargo build", session: "s1" }, "2026-06-17T10:01:00.000Z");
  const e = store.entries["Bash" + m.SEP + "cargo build"];
  assert.strictEqual(e.calls, 1);
  assert.strictEqual(e.fails, 2);
  assert.strictEqual(e.last, "2026-06-17T10:01:00.000Z");
});

test("end-to-end: PostToolUseFailure creates a fails entry in the store", () => {
  const tmp = path.join(os.tmpdir(), "permlog-test-fail-" + process.pid + ".json");
  try { fs.unlinkSync(tmp); } catch (_) {}
  runHook(tmp, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "tsc --noEmit" } });
  runHook(tmp, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "tsc --noEmit" } });
  const store = JSON.parse(fs.readFileSync(tmp, "utf8"));
  const e = store.entries["Bash" + m.SEP + "tsc --noEmit"];
  assert.strictEqual(e.calls, 1);
  assert.strictEqual(e.fails, 1);
  fs.unlinkSync(tmp);
});

test("applyEvent counts distinct attributed prompts even seconds apart (no per-tool over-dedup)", () => {
  const store = { version: 1, updated: null, entries: {} };
  // two different real commands prompted ~1s apart (e.g. parallel tool calls) must both count
  assert.strictEqual(m.applyEvent(store, { kind: "ask", tool: "Bash", sum: "cmd-a" }, "2026-06-17T10:00:00.000Z"), true);
  assert.strictEqual(m.applyEvent(store, { kind: "ask", tool: "Bash", sum: "cmd-b" }, "2026-06-17T10:00:01.000Z"), true);
  assert.strictEqual(store.entries["Bash" + m.SEP + "cmd-a"].asks, 1);
  assert.strictEqual(store.entries["Bash" + m.SEP + "cmd-b"].asks, 1);
});
