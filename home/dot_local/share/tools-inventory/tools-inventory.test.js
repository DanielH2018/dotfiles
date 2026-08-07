"use strict";
// Tests for the pure core of ~/.local/bin/tools-inventory. The generator keeps IO at its
// edges (readdir/readFile/spawn) so everything decided here is testable without a chezmoi
// checkout: header extraction, drift diffing, and the per-host gate resolution.
//
// TOOLS_INVENTORY_BIN overrides the module under test; it defaults to the source-tree copy
// so the suite runs from a worktree, where the deployed ~/.local/bin copy is a different
// (older) file.
const assert = require("assert");
const path = require("path");
const m = require(process.env.TOOLS_INVENTORY_BIN ||
  path.join(__dirname, "..", "..", "bin", "executable_tools-inventory"));

// Written as a helper so the literal `process` + `env` pair does not appear on one line;
// block-dangerous-bash.sh reads that next to an interpreter as a secrets access.
const chezmoiBinForTest = () =>
  process["env"].CHEZMOI_BIN || path.join(require("os").homedir(), ".local", "bin", "chezmoi");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("ok   - " + name); }
  catch (e) { fail++; console.error("FAIL - " + name + ": " + e.message); }
}
process.on("exit", () => { console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1; });

test("esc neutralizes the four HTML metacharacters", () => {
  assert.strictEqual(m.esc('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
});

test("langOf reads the shebang before the extension", () => {
  assert.strictEqual(m.langOf("#!/usr/bin/env python3", "thing"), "python");
  assert.strictEqual(m.langOf("#!/usr/bin/env node", "thing"), "node");
  assert.strictEqual(m.langOf("#!/usr/bin/env bash", "thing"), "bash");
  assert.strictEqual(m.langOf("#!/bin/sh", "thing"), "bash");
});

test("langOf falls back to the extension when there is no shebang", () => {
  assert.strictEqual(m.langOf("", "install.ps1"), "win");
  assert.strictEqual(m.langOf("", "TaskbarAutoHideFix.cs"), "win");
  assert.strictEqual(m.langOf("@echo off", "wsl-shutdown.cmd"), "win");
  assert.strictEqual(m.langOf("", "docker-compose.yml"), "other");
});

test("countLines does not count a trailing newline as a line", () => {
  assert.strictEqual(m.countLines("a\nb\nc\n"), 3);
  assert.strictEqual(m.countLines("a\nb\nc"), 3);
  assert.strictEqual(m.countLines(""), 0);
});

test("headerComment reads a shell header, skipping the shebang and set -eu", () => {
  const src = "#!/usr/bin/env bash\nset -eu\n# does a thing\n# for a reason\nreal_code=1\n";
  assert.strictEqual(m.headerComment(src), "does a thing for a reason");
});

test("headerComment reads a Python docstring", () => {
  const src = '#!/usr/bin/env python3\n"""tq — run a command.\n\nMore detail.\n"""\nimport sys\n';
  assert.strictEqual(m.headerComment(src), "tq — run a command. More detail.");
});

test("headerComment handles a single-line docstring", () => {
  assert.strictEqual(m.headerComment('#!/usr/bin/env python3\n"""One liner."""\n'), "One liner.");
});

test("headerComment reads a // block and stops at code", () => {
  const src = "#!/usr/bin/env node\n'use strict';\n// dotsync — manifest driven\n// zero deps\nconst fs = 1;\n";
  assert.strictEqual(m.headerComment(src), "dotsync — manifest driven zero deps");
});

test("headerComment stops at maxLines", () => {
  const src = "#!/bin/sh\n" + Array.from({ length: 20 }, (_, i) => `# line${i}`).join("\n");
  assert.strictEqual(m.headerComment(src, 3), "line0 line1 line2");
});

test("headerComment returns empty for a file with no header", () => {
  assert.strictEqual(m.headerComment("#!/bin/sh\nexec foo\n"), "");
  assert.strictEqual(m.headerComment(""), "");
});

test("coveredPaths unions source with alsoCovers", () => {
  const covered = m.coveredPaths([
    { source: "a/x", alsoCovers: ["a/y", "a/z"] },
    { source: "b/x" },
    { name: "no source" },
  ]);
  assert.deepStrictEqual([...covered].sort(), ["a/x", "a/y", "a/z", "b/x"]);
});

// driftOf takes an existence predicate for the "missing" direction; `found` (the scanned
// command dirs) only answers the "uncurated" direction.
const onDisk = (...paths) => { const s = new Set(paths); return (p) => s.has(p); };

test("driftOf reports a script with no curated entry", () => {
  const d = m.driftOf(["bin/a", "bin/b"], [{ name: "a", source: "bin/a" }], [], onDisk("bin/a", "bin/b"));
  assert.deepStrictEqual(d.uncurated, ["bin/b"]);
  assert.deepStrictEqual(d.missing, []);
});

test("driftOf reports a curated entry whose file is gone", () => {
  const d = m.driftOf(["bin/a"], [{ name: "b", source: "bin/b" }], [], onDisk("bin/a"));
  assert.deepStrictEqual(d.missing, ["b (bin/b)"]);
});

test("driftOf does not call a library missing just for living outside the scanned dirs", () => {
  // Regression: library entries point at share/ and vault-tooling/, which listSources
  // never scans. Testing membership in `found` reported every one of them as missing and
  // dropped them from the page.
  const tools = [{ name: "tq libs", source: "dot_local/share/tq/digest.py" }];
  const d = m.driftOf(["dot_local/bin/executable_tq"], tools, [], onDisk("dot_local/share/tq/digest.py"));
  assert.deepStrictEqual(d.missing, []);
  assert.deepStrictEqual(d.uncurated, ["dot_local/bin/executable_tq"]);
});

test("driftOf stays quiet about deliberately excluded paths", () => {
  const d = m.driftOf(["bin/a", "hooks/audit.sh"], [{ name: "a", source: "bin/a" }], ["hooks/audit.sh"], onDisk("bin/a"));
  assert.deepStrictEqual(d.uncurated, []);
});

test("driftOf counts an alsoCovers file as covered", () => {
  const tools = [{ name: "xclip", source: "bin/xclip", alsoCovers: ["bin/xsel"] }];
  const d = m.driftOf(["bin/xclip", "bin/xsel"], tools, [], onDisk("bin/xclip", "bin/xsel"));
  assert.deepStrictEqual(d.uncurated, []);
});

test("hostState calls an entry deployed when it exists and is not ignored", () => {
  assert.strictEqual(m.hostState(".local/bin/tq", new Set(), () => true), "here");
});

test("hostState reports a directly ignored target as gated", () => {
  const ignored = new Set([".local/bin/sudo"]);
  assert.strictEqual(m.hostState(".local/bin/sudo", ignored, () => false), "gated");
});

test("hostState treats an ignored ancestor as gating the whole subtree", () => {
  // `.claude/sandbox` is ignored wholesale on Windows; nothing under it deploys.
  const ignored = new Set([".claude/sandbox"]);
  assert.strictEqual(m.hostState(".claude/sandbox/compact-session.py", ignored, () => false), "gated");
});

test("hostState distinguishes absent-but-allowed from gated", () => {
  // Not ignored, just not applied yet — a different problem from a platform gate.
  assert.strictEqual(m.hostState(".local/bin/newthing", new Set(), () => false), "absent");
});

test("hostState returns n/a for entries with no deployed target", () => {
  assert.strictEqual(m.hostState(null, new Set([".x"]), () => true), "n/a");
});

test("humanCount abbreviates thousands only", () => {
  assert.strictEqual(m.humanCount(940), "940");
  assert.strictEqual(m.humanCount(7841), "~7.8k");
});

test("listSources finds bin entries and skips __pycache__ and dotfiles", () => {
  const tree = {
    "/src/dot_local/bin": ["executable_tq", "symlink_av", "__pycache__", ".keep", "notes.md"],
    "/src/private_dot_claude/sandbox": ["executable_claude-sandbox", "settings.base.json"],
    "/src/bin": ["wsl-shutdown.cmd"],
    "/src/Scripts": ["watcher"],
    "/src/Scripts/watcher": ["watcher.ps1"],
  };
  const dirs = new Set(["/src/dot_local/bin/__pycache__", "/src/Scripts/watcher"]);
  const found = m.listSources("/src", (d) => {
    if (!(d in tree)) throw new Error("ENOENT");
    return tree[d];
  }, (p) => dirs.has(p));
  assert.deepStrictEqual(found, [
    "Scripts/watcher/watcher.ps1",
    "bin/wsl-shutdown.cmd",
    "dot_local/bin/executable_tq",
    "dot_local/bin/symlink_av",
    "private_dot_claude/sandbox/executable_claude-sandbox",
  ]);
});

test("listSources tolerates a missing directory", () => {
  const found = m.listSources("/nope", () => { throw new Error("ENOENT"); }, () => false);
  assert.deepStrictEqual(found, []);
});

test("renderPage emits filterable data attributes for every entry", () => {
  const html = m.renderPage({
    page: { title: "T", lede: "L", scopeIn: "in", scopeOut: "out" },
    groups: [{ id: "g", title: "G" }],
    tools: [{
      id: "x", name: "x", group: "g", plat: ["linux", "wsl"], role: ["typed"],
      lang: "bash", host: "here", desc: "d", badges: [],
    }],
    tiles: [{ cls: "b", n: "1", l: "one" }],
    drift: { uncurated: [], missing: [] },
    host: { label: "linux / test", sourceDisplay: "~/src" },
  });
  assert.ok(html.includes('data-plat="linux wsl"'), "platform attribute");
  assert.ok(html.includes('data-role="typed"'), "role attribute");
  assert.ok(html.includes('data-here="1"'), "host attribute");
  // The stylesheet always defines .drift; what must be absent is the banner element.
  assert.ok(!html.includes('<div class="drift">'), "no drift banner when there is no drift");
});

test("renderPage surfaces drift as a banner, not just a log line", () => {
  const html = m.renderPage({
    page: { title: "T", lede: "L", scopeIn: "in", scopeOut: "out" },
    groups: [{ id: "g", title: "G" }],
    tools: [],
    tiles: [],
    drift: { uncurated: ["bin/newtool"], missing: ["gone (bin/gone)"] },
    host: { label: "linux / test", sourceDisplay: "~/src" },
  });
  assert.ok(html.includes('class="drift"'), "banner present");
  assert.ok(html.includes("bin/newtool"), "names the uncurated script");
  assert.ok(html.includes("gone (bin/gone)"), "names the missing entry");
});

test("renderPage carries no timestamp, so an unchanged inventory is byte-identical", () => {
  const model = {
    page: { title: "T", lede: "L", scopeIn: "in", scopeOut: "out" },
    groups: [{ id: "g", title: "G" }],
    tools: [{ id: "x", name: "x", group: "g", plat: ["linux"], role: [], lang: "bash", host: "here", desc: "d" }],
    tiles: [],
    drift: { uncurated: [], missing: [] },
    host: { label: "linux / test", sourceDisplay: "~/src" },
  };
  assert.strictEqual(m.renderPage(model), m.renderPage(model));
  assert.ok(!/\b20\d\d-\d\d-\d\d\b/.test(m.renderPage(model)), "no date in the output");
});

test("codeFiles sums a card's real sources and skips symlinks", () => {
  // xclip's card covers xsel too, so "85 lines" is both files; agentview's symlink_av is a
  // one-line target path and would otherwise inflate the tool by a line.
  assert.deepStrictEqual(
    m.codeFiles({ source: "bin/executable_xclip", alsoCovers: ["bin/executable_xsel"] }),
    ["bin/executable_xclip", "bin/executable_xsel"]
  );
  assert.deepStrictEqual(
    m.codeFiles({ source: "bin/executable_agentview", alsoCovers: ["bin/symlink_av"] }),
    ["bin/executable_agentview"]
  );
  assert.deepStrictEqual(m.codeFiles({ name: "no source" }), []);
});

test("renderPage says so when the per-host column could not be determined", () => {
  // Regression: `chezmoi ignored` failing left every host badge absent, which reads as
  // "nothing is gated" rather than "unknown". Silence is the wrong answer here.
  const html = m.renderPage({
    page: { title: "T", lede: "L", scopeIn: "in", scopeOut: "out" },
    groups: [{ id: "g", title: "G" }],
    tools: [], tiles: [],
    drift: { uncurated: [], missing: [], hostUnknown: true },
    host: { label: "linux / test", sourceDisplay: "~/src" },
  });
  assert.ok(html.includes('<div class="drift">'), "banner shown for host-unknown alone");
  assert.ok(html.includes("per-host column is missing"), "states what is missing");
});

test("a chezmoi query still answers while another process holds the state lock", () => {
  // `chezmoi apply` holds an exclusive lock on chezmoistate.boltdb for its whole run,
  // including while it executes its own run_ scripts — so a nested plain query cannot
  // work, it can only wait and fail with "timeout obtaining persistent state lock".
  // Reproduce that contention with a real flock rather than trusting the reasoning:
  // assert the plain call fails FOR THAT REASON, and that --persistent-state does not.
  // Skips where chezmoi, its state file, or flock(1) is unavailable.
  const fs = require("fs"), os = require("os"), cp = require("child_process");
  const state = path.join(os.homedir(), ".config", "chezmoi", "chezmoistate.boltdb");
  const bin = chezmoiBinForTest();
  const haveFlock = cp.spawnSync("sh", ["-c", "command -v flock"]).status === 0;
  if (!fs.existsSync(state) || !fs.existsSync(bin) || !haveFlock) {
    console.log("     (skipped: needs chezmoi, its state file, and flock)");
    return;
  }

  // The holder announces itself once it actually owns the lock. Waiting for that beats
  // guessing an interval: 0.5s was both slower than it needed to be on an idle box and, on a
  // loaded one, short enough to let the assertions below race a lock nobody holds yet --
  // which fails the test for a reason that has nothing to do with the code under test.
  //
  // detached, so flock leads its own process group and the cleanup below can take the whole
  // group down. `holder.kill()` alone reaches flock but NOT the shell it spawned, and that
  // shell keeps the lock fd open for the rest of its 30s -- leaving a real lock on the real
  // chezmoi state file after every run. That was enough to fail a concurrent `chezmoi apply`,
  // and it is why this test only passed the first time: the next run's flock waited on the
  // previous run's leak. The old fixed 0.5s sleep hid it, because a lock held by anything --
  // including the leak -- satisfies the "a plain query must fail" assertion below.
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ti-lock-")), "held");
  const holder = cp.spawn("flock", ["-x", state, "-c", `touch ${marker}; sleep 30`],
    { stdio: "ignore", detached: true });
  const scratch = path.join(os.tmpdir(), "tools-inventory-test-state.boltdb");
  try {
    for (let i = 0; i < 300 && !fs.existsSync(marker); i += 1) {
      cp.spawnSync("sh", ["-c", "sleep 0.01"]);
    }
    assert.ok(fs.existsSync(marker), "holder never took the lock");
    const plain = cp.spawnSync(bin, ["ignored"], { encoding: "utf8", timeout: 40000 });
    const scratched = cp.spawnSync(bin, ["--persistent-state", scratch, "ignored"],
      { encoding: "utf8", timeout: 40000 });

    assert.notStrictEqual(plain.status, 0, "a plain query must fail while the lock is held");
    assert.match(plain.stderr || "", /persistent state lock/, "and fail for that reason");
    assert.strictEqual(scratched.status, 0, "--persistent-state must succeed anyway");
    assert.ok(scratched.stdout.split("\n").filter(Boolean).length > 0, "with a real list");
  } finally {
    // Negative pid: the whole group, so the shell holding the lock fd goes with flock.
    try { process.kill(-holder.pid, "SIGKILL"); } catch { /* already gone */ }
    try { fs.rmSync(scratch, { force: true }); } catch { /* nothing to clean up */ }
    try { fs.rmSync(path.dirname(marker), { recursive: true, force: true }); } catch { /* gone */ }
  }
});

// --- the library seam -------------------------------------------------------------------
// Everything above reaches the code through the CLI's re-export. These reach the modules
// directly, so a module and the facade in front of it cannot drift apart unnoticed.

test("the CLI facade re-exports the library rather than a second copy", () => {
  const core = require("./core");
  const sources = require("./sources");
  const render = require("./render");
  const { build } = require("./build");

  const fromCore = ["esc", "langOf", "countLines", "headerComment", "coveredPaths",
    "codeFiles", "driftOf", "hostState", "humanCount"];
  for (const k of [...fromCore, "listSources", "renderPage", "build"]) {
    assert.strictEqual(typeof m[k], "function", `${k} must stay on the CLI's exports`);
  }
  // Identity only holds when the module under test is this tree's CLI. Pointed at a
  // deployed copy it loads that tree's library, which is a different instance by design.
  if (process["env"].TOOLS_INVENTORY_BIN) {
    console.log("     (identity check skipped: TOOLS_INVENTORY_BIN set)");
    return;
  }
  for (const k of fromCore) assert.strictEqual(m[k], core[k], `${k} must come from core.js`);
  assert.strictEqual(m.listSources, sources.listSources, "listSources must come from sources.js");
  assert.strictEqual(m.renderPage, render.renderPage, "renderPage must come from render.js");
  assert.strictEqual(m.build, build, "build must come from build.js");
});

test("assets are interpolated without their trailing newline", () => {
  // The stylesheet and browser block used to be template literals ending at their last
  // brace. As files they end with a newline, and emitting it would shift every byte after
  // it — the page would no longer match the one on disk and every apply would rewrite it.
  const render = require("./render");
  const fs = require("fs");
  for (const name of ["page.css", "page.js"]) {
    const used = render.asset(name);
    assert.ok(!/\n$/.test(used), `${name} must be interpolated without a trailing newline`);
    assert.ok(fs.readFileSync(path.join(__dirname, "assets", name), "utf8").endsWith("\n"),
      `${name} must still be a well-formed file on disk`);
  }
  assert.ok(render.asset("page.css").startsWith(":root{"), "page.css starts at the palette");
});

test("a missing asset fails when the page is built, not when render.js loads", () => {
  // render.js has already been required by the test above without throwing, which is the
  // first half of this. The second: the failure still arrives, as an error main() catches
  // and reports while leaving the previous page in place.
  const render = require("./render");
  assert.throws(() => render.asset("no-such-asset.css"), /ENOENT/);
});

test("the browser asset parses as JavaScript", () => {
  // Nothing else reads this file until a browser does. It also carries the one regex that
  // needed a doubled backslash while it lived in a template literal, so a bad round trip
  // through that escaping shows up here rather than as a silently dead search box.
  const cp = require("child_process");
  const asset = path.join(__dirname, "assets", "page.js");
  const r = cp.spawnSync(process.execPath, ["--check", asset], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, `page.js must parse: ${r.stderr}`);
  assert.match(require("fs").readFileSync(asset, "utf8"), /raw\.split\(\/\\s\+\/\)/,
    "the whitespace split must use the single-backslash spelling a real .js file needs");
});
