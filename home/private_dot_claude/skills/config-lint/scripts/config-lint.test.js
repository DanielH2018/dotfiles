"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
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

test("enumeratePluginSkills only returns skills for a plugin settings.json actually enables (B6)", () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "config-lint-plugins-"));
  try {
    for (const [plugin, skill] of [["enabled-plugin", "on-skill"], ["superpowers", "systematic-debugging"]]) {
      const skillDir = path.join(cacheRoot, "claude-plugins-official", plugin, "1.0.0", "skills", skill);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\n");
    }
    const enabledPlugins = {
      "enabled-plugin@claude-plugins-official": true,
      "superpowers@claude-plugins-official": false, // installed, but disabled -- like this host's
    };
    const bySource = m.enumeratePluginSkills(cacheRoot, enabledPlugins);
    assert.deepStrictEqual(bySource, { "plugin:enabled-plugin": ["on-skill"] });
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
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

test("extractBinaryDeps ignores \"which\" appearing mid-sentence in a quoted message, not in command position (E1b)", () => {
  // hooks/executable_chezmoi-apply-guard.sh's actual deny message: two "which"es, both
  // prose ("...which deploys...", "...which is $BEHIND commit(s)..."), neither a guard.
  const text = 'deny "the switch back is `bin/try --back`, which deploys to the ' +
    'operator live $HOME. Applying reads its source from $TOP, which is $BEHIND ' +
    'commit(s) behind origin/main."';
  const deps = m.extractBinaryDeps([{ path: "hooks/chezmoi-apply-guard.sh", text }]);
  assert.deepStrictEqual(deps, []);
});

test("extractBinaryDeps skips names a scanned file defines as a shell function (E1a)", () => {
  // run_bounded/hook_field/oc_mark are each guarded at their call site with the same
  // command -v/which idioms a real binary dependency uses, but each is a shell function
  // defined in a sibling file under home/private_dot_claude/hooks/ -- never a PATH lookup.
  const files = [
    { path: "hooks/run-bounded.sh", text: "run_bounded() {\n  :\n}\n" },
    { path: "hooks/hook-input.sh", text: "hook_field() {\n  :\n}\n" },
    { path: "hooks/outcome-lib.sh", text: "function oc_mark() {\n  :\n}\n" },
    {
      path: "hooks/auto-format.sh",
      text: 'if ! command -v run_bounded >/dev/null 2>&1; then exit 1; fi',
    },
    {
      path: "hooks/skill-usage-log.sh",
      text: 'command -v hook_field >/dev/null 2>&1 || hook_field() { jq -r "$1"; }',
    },
    { path: "hooks/some-consumer.sh", text: "which oc_mark >/dev/null 2>&1 && oc_mark ok" },
  ];
  assert.deepStrictEqual(m.extractBinaryDeps(files), []);
  assert.deepStrictEqual(
    [...m.extractShellFunctionNames(files)].sort(),
    ["hook_field", "oc_mark", "run_bounded"],
  );
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
  // pwd and history are shell builtins and are dropped — see the builtin test below.
  assert.deepStrictEqual(deps.map(d => d.tool).sort(), ["pbcopy"]);
  assert.ok(deps.every(d => d.file === "settings.json (permissions.allow)"));
});

// The false positive this check shipped with. `Bash(history)` was reported as a missing
// dependency because history is a bash builtin and so is never on PATH — but it is
// always available, and the allow rule is valid. A lint that cries wolf on a correct
// config is worse than one that misses a case.
test("extractPermissionDeps skips shell builtins, which are never on PATH", () => {
  const allow = ["Bash(history)", "Bash(cd)", "Bash(source)", "Bash(alias)", "Bash(pbcopy)"];
  const deps = m.extractPermissionDeps(allow).map(d => d.tool);
  assert.deepStrictEqual(deps, ["pbcopy"], `builtins leaked through: ${deps.join(", ")}`);
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
