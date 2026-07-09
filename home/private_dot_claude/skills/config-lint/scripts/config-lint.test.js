"use strict";
const assert = require("assert");
const m = require("./config-lint.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("ok   - " + name); }
  catch (e) { fail++; console.error("FAIL - " + name + ": " + e.message); }
}
process.on("exit", () => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
});

test("diffPlugins separates dead (enabled, not installed) from dormant (installed, not enabled)", () => {
  const enabled = { "a@mkt": true, "b@mkt": true, "off@mkt": false };
  const installed = ["b@mkt", "c@mkt"];
  const { dead, dormant } = m.diffPlugins(enabled, installed);
  assert.deepStrictEqual(dead, ["a@mkt"]);        // enabled, absent from installed
  assert.deepStrictEqual(dormant, ["c@mkt"]);     // installed, not enabled (off is disabled, not installed)
});

test("extractHookCommands pulls command strings across events and matchers", () => {
  const settings = { hooks: {
    PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "node a.js" }, { type: "command", command: "bash b.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "node c.js" }, { type: "other", command: "ignored" }] }],
  } };
  assert.deepStrictEqual(m.extractHookCommands(settings).sort(), ["bash b.sh", "node a.js", "node c.js"]);
});

test("extractHookCommands tolerates missing/empty hooks", () => {
  assert.deepStrictEqual(m.extractHookCommands({}), []);
  assert.deepStrictEqual(m.extractHookCommands({ hooks: { Stop: [] } }), []);
});

test("extractPaths resolves ~ and $HOME, defers unresolved vars", () => {
  const home = "/home/d";
  const r1 = m.extractPaths('node "~/.claude/hooks/x.js"', home);
  assert.deepStrictEqual(r1.paths, ["/home/d/.claude/hooks/x.js"]);
  const r2 = m.extractPaths('bash "$HOME/.claude/hooks/y.sh"', home);
  assert.deepStrictEqual(r2.paths, ["/home/d/.claude/hooks/y.sh"]);
  const r3 = m.extractPaths('bash "$CLAUDE_PROJECT_DIR/.claude/hooks/z.sh"', home);
  assert.deepStrictEqual(r3.paths, []);
  assert.strictEqual(r3.unresolved.length, 1);
});

test("extractPaths ignores non-script tokens", () => {
  assert.deepStrictEqual(m.extractPaths("echo hello && git status", "/home/d").paths, []);
});

test("parseIncludes finds @-include lines only", () => {
  const text = "# CLAUDE\nsome text\n@~/.claude/docs/orchestration.md\nnot @inline reference\n@~/.claude/CLAUDE.local.md\n";
  assert.deepStrictEqual(m.parseIncludes(text), ["~/.claude/docs/orchestration.md", "~/.claude/CLAUDE.local.md"]);
});

test("findDuplicateSkills reports only names in >1 source", () => {
  const dupes = m.findDuplicateSkills({ user: ["prep", "review"], "plugin:x": ["review"], "plugin:y": ["solo"] });
  assert.strictEqual(dupes.length, 1);
  assert.strictEqual(dupes[0].name, "review");
  assert.deepStrictEqual(dupes[0].sources.sort(), ["plugin:x", "user"]);
});

test("checkBloat flags over-threshold on bytes and lines", () => {
  assert.strictEqual(m.checkBloat("ok\n", { maxBytes: 100, maxLines: 100 }).overBytes, false);
  assert.strictEqual(m.checkBloat("x".repeat(200), { maxBytes: 100, maxLines: 100 }).overBytes, true);
  assert.strictEqual(m.checkBloat("a\n".repeat(200), { maxBytes: 1e9, maxLines: 100 }).overLines, true);
});
