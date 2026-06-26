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
