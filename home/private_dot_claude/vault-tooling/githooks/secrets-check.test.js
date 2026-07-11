"use strict";
const assert = require("assert");
const m = require("./secrets-check.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("ok   - " + name); }
  catch (e) { fail++; console.error("FAIL - " + name + ": " + e.message); }
}
process.on("exit", () => { console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exitCode = 1; });

test("isSafeRegex rejects nested quantifiers", () => {
  assert.strictEqual(m.isSafeRegex("(a+)+"), false);
  assert.strictEqual(m.isSafeRegex("(.*)*"), false);
  assert.strictEqual(m.isSafeRegex("(ab+)*"), false);
});

test("isSafeRegex rejects absurd bounded repeats", () => {
  assert.strictEqual(m.isSafeRegex("a{1000,}"), false);
  assert.strictEqual(m.isSafeRegex("x{5000}"), false);
});

test("isSafeRegex accepts ordinary patterns", () => {
  assert.strictEqual(m.isSafeRegex("AKIA[0-9A-Z]{16}"), true);
  assert.strictEqual(m.isSafeRegex("(foo|bar)+"), true);
  assert.strictEqual(m.isSafeRegex("https?://\\S+"), true);
});

test("loadPatterns keeps valid entries and skips malformed/unsafe/uncompilable", () => {
  const json = JSON.stringify([
    { name: "ok", re: "SECRET_[A-Z]{10}" },
    { name: "no-re" },
    { re: "no-name-[0-9]+" },
    { name: "unsafe", re: "(a+)+" },
    { name: "bad", re: "([unclosed" },
    "not-an-object",
  ]);
  const { patterns, skipped } = m.loadPatterns(json);
  assert.strictEqual(patterns.length, 1);
  assert.strictEqual(patterns[0].name, "ok");
  assert.strictEqual(skipped.length, 5);
});

test("loadPatterns handles invalid JSON and non-arrays without throwing", () => {
  assert.strictEqual(m.loadPatterns("{bad json").patterns.length, 0);
  assert.strictEqual(m.loadPatterns('{"a":1}').patterns.length, 0);
});

test("loadPatterns defaults severity to warning and preserves a given severity", () => {
  const { patterns } = m.loadPatterns(JSON.stringify([
    { name: "a", re: "foo" },
    { name: "b", re: "bar", severity: "critical" },
  ]));
  assert.strictEqual(patterns[0].severity, "warning");
  assert.strictEqual(patterns[1].severity, "critical");
});

test("scanLines matches a positive line and ignores a benign one", () => {
  const { patterns } = m.loadPatterns(JSON.stringify([{ name: "tok", re: "TID_[0-9]{6}" }]));
  const hits = m.scanLines(["const t = 'TID_123456'", "const ok = 'hello'"], patterns);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].name, "tok");
});

test("scanLines only inspects the first EXTERNAL_MAX_LINE chars", () => {
  const { patterns } = m.loadPatterns(JSON.stringify([{ name: "tail", re: "NEEDLE" }]));
  const pad = "x".repeat(m.EXTERNAL_MAX_LINE);
  assert.strictEqual(m.scanLines([pad + "NEEDLE"], patterns).length, 0); // past the cap → not scanned
  assert.strictEqual(m.scanLines(["NEEDLE" + pad], patterns).length, 1); // within the cap → scanned
});
