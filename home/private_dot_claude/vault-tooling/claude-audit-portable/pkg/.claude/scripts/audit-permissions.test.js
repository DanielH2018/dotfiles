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
