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

test("extractBinaryDeps finds run_if_installed call sites but not the wrapper's own $1 param", () => {
  const text = [
    'run_if_installed() {',
    '  command -v "$1" >/dev/null 2>&1 && "$@" 2>&1',
    '}',
    'run_if_installed prettier --write "$FILE_PATH"',
    'run_if_installed shfmt -w "$FILE_PATH"',
  ].join("\n");
  const deps = m.extractBinaryDeps([{ path: "hooks/auto-format.sh", text }]);
  const tools = deps.map(d => d.tool).sort();
  assert.deepStrictEqual(tools, ["prettier", "shfmt"]);
});

test("extractBinaryDeps finds bare command -v and which guards, deduped per file+tool", () => {
  const text = [
    'command -v jq >/dev/null 2>&1 || exit 0',
    'if command -v cygpath >/dev/null 2>&1; then :; fi',
    'which cargo >/dev/null',
    'command -v jq >/dev/null 2>&1 || exit 0', // repeat: should dedupe
  ].join("\n");
  const deps = m.extractBinaryDeps([{ path: "hooks/chezmoi-guard.sh", text }]);
  assert.deepStrictEqual(deps.map(d => d.tool).sort(), ["cargo", "cygpath", "jq"]);
});

test("extractBinaryDeps ignores prose mentions of \"which\"/\"command\" inside comments", () => {
  const text = [
    "# Helps Claude remember which feature branch it is on.",
    "# which would inject a spurious marker into every prompt.",
    "echo hi # command -v ignored, this is trailing prose not a guard",
  ].join("\n");
  const deps = m.extractBinaryDeps([{ path: "hooks/worktree-context.sh", text }]);
  assert.deepStrictEqual(deps, []);
});

test("checkBinaryDeps reports info findings only for tools the injected checker says are missing", () => {
  const deps = [
    { file: "hooks/x.sh", tool: "definitely-not-a-real-binary-xyz" },
    { file: "hooks/x.sh", tool: "sh" },
  ];
  const hasBinary = tool => tool === "sh";
  const findings = m.checkBinaryDeps(deps, hasBinary);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].sev, "info");
  assert.strictEqual(findings[0].area, "binary-deps");
  assert.match(findings[0].msg, /definitely-not-a-real-binary-xyz/);
});

// A1-43: settings.json `Bash(tool)` permission entries as a binary-dep declaration shape.
test("extractPermissionDeps matches only bare, argument-less Bash(tool) entries", () => {
  const allow = [
    "Bash(pbcopy)",
    "Bash(pwd)",
    "Bash(history)",
    "Bash(md5:*)",              // wildcard subcommand shape — deliberately excluded
    "Bash(sdk list:*)",         // multi-word + wildcard — deliberately excluded
    "Bash(cargo build:*)",      // portable toolchain grant — deliberately excluded
    "Read(**)",                 // not a Bash entry at all
    "Bash(pbcopy)",             // repeat: should dedupe
  ];
  const deps = m.extractPermissionDeps(allow, "settings.json (permissions.allow)");
  assert.deepStrictEqual(deps.map(d => d.tool).sort(), ["history", "pbcopy", "pwd"]);
  assert.ok(deps.every(d => d.file === "settings.json (permissions.allow)"));
});

test("extractPermissionDeps tolerates a missing/empty allow list", () => {
  assert.deepStrictEqual(m.extractPermissionDeps(undefined), []);
  assert.deepStrictEqual(m.extractPermissionDeps([]), []);
});

// A14-31: ble.sh's `-f "$HOME/.local/share/..."` guard before `source` as a binary-dep shape.
test("extractPathDeps matches -f \"$HOME/.local/share/...\" guards, deduped per file+path", () => {
  const text = [
    'if [[ $OSTYPE != msys* && -f "$HOME/.local/share/blesh/ble.sh" ]]; then',
    '  source "$HOME/.local/share/blesh/ble.sh" --noattach',
    'fi',
  ].join("\n");
  const deps = m.extractPathDeps([{ path: "dot_bashrc", text }]);
  assert.deepStrictEqual(deps, [{ file: "dot_bashrc", tool: "$HOME/.local/share/blesh/ble.sh" }]);
});

test("extractPathDeps ignores -f guards outside .local/share (e.g. .config overrides)", () => {
  const text = '[ -f "$HOME/.config/claude/local.env" ] && . "$HOME/.config/claude/local.env"';
  assert.deepStrictEqual(m.extractPathDeps([{ path: "hooks/watch-paths.sh", text }]), []);
});

test("checkPathDeps expands $HOME and reports info findings only for paths the injected checker says are missing", () => {
  const deps = [
    { file: "dot_bashrc", tool: "$HOME/.local/share/blesh/ble.sh" },
    { file: "dot_bashrc", tool: "$HOME/.local/share/present-tool/x" },
  ];
  const hasPath = p => p === "/home/d/.local/share/present-tool/x";
  const findings = m.checkPathDeps(deps, "/home/d", hasPath);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].sev, "info");
  assert.strictEqual(findings[0].area, "binary-deps");
  assert.match(findings[0].msg, /blesh\/ble\.sh/);
  assert.match(findings[0].msg, /not found on disk/);
});
