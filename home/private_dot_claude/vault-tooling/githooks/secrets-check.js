#!/usr/bin/env node
/**
 * secrets-check.js — external-pattern layer for the vault pre-commit secret scan.
 *
 * The pre-commit hook enforces a fixed set of built-in credential patterns in bash.
 * This script adds repo-specific patterns on top of those built-ins, loaded from
 * .claude/scan-patterns.json (produced by the distill-scan skill). It scans the same
 * staged added lines and blocks the commit on a match, honoring VAULT_ALLOW_SECRET=1.
 *
 * Only the first EXTERNAL_MAX_LINE chars of each line are tested, and every pattern is
 * safety-validated before use, so a pathological entry can't hang a commit.
 *
 * Exit 0 when scan-patterns.json is absent or yields no usable patterns.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const EXTERNAL_MAX_LINE = 2000;

// Reject the classic ReDoS shapes and absurd bounded repeats. This is a heuristic
// (it mirrors the examples distill-scan validates against), not a complete prover.
function isSafeRegex(src) {
    if (typeof src !== "string" || src === "") return false;
    if (/\([^)]*[+*][^)]*\)[?*+]/.test(src)) return false; // (a+)+ (.*)* (ab+)*
    for (const tok of src.match(/\{(\d+)(?:,(\d*))?\}/g) || []) {
        if (parseInt(tok.match(/\d+/)[0], 10) >= 1000) return false; // {1000,}
    }
    return true;
}

// Parse scan-patterns.json text into compiled patterns, dropping any entry that is
// malformed, unsafe, or doesn't compile. Returns both the survivors and what was cut.
function loadPatterns(jsonText) {
    const patterns = [], skipped = [];
    let arr;
    try { arr = JSON.parse(jsonText); } catch { return { patterns, skipped: [{ entry: null, reason: "invalid JSON" }] }; }
    if (!Array.isArray(arr)) return { patterns, skipped: [{ entry: null, reason: "not an array" }] };
    for (const e of arr) {
        if (!e || typeof e.name !== "string" || typeof e.re !== "string") { skipped.push({ entry: e, reason: "missing name/re" }); continue; }
        if (!isSafeRegex(e.re)) { skipped.push({ entry: e, reason: "unsafe regex" }); continue; }
        let re;
        try { re = new RegExp(e.re); } catch { skipped.push({ entry: e, reason: "does not compile" }); continue; }
        patterns.push({ name: e.name, re, severity: typeof e.severity === "string" ? e.severity : "warning" });
    }
    return { patterns, skipped };
}

function scanLines(lines, patterns, maxLine = EXTERNAL_MAX_LINE) {
    const hits = [];
    for (const line of lines) {
        const probe = line.length > maxLine ? line.slice(0, maxLine) : line;
        for (const p of patterns) {
            p.re.lastIndex = 0;
            if (p.re.test(probe)) hits.push({ name: p.name, severity: p.severity, line });
        }
    }
    return hits;
}

function stagedAddedLines() {
    const { execFileSync } = require("child_process");
    let diff;
    try {
        diff = execFileSync("git", ["diff", "--cached", "--unified=0", "--diff-filter=AM", "--", ".", ":!.githooks"], { encoding: "utf8" });
    } catch { return []; }
    return diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).map(l => l.slice(1));
}

function main() {
    const pfile = path.join(process.cwd(), ".claude", "scan-patterns.json");
    if (!fs.existsSync(pfile)) return;
    const { patterns, skipped } = loadPatterns(fs.readFileSync(pfile, "utf8"));
    for (const s of skipped) {
        const name = s.entry && s.entry.name ? `: ${s.entry.name}` : "";
        console.error(`secrets-check: skipped external pattern (${s.reason})${name}`);
    }
    if (!patterns.length) return;

    const hits = scanLines(stagedAddedLines(), patterns);
    if (!hits.length) return;

    console.error("pre-commit (external patterns): staged content matched a scan pattern:");
    for (const h of hits) console.error(`    [${h.severity}:${h.name}] ${h.line.slice(0, 200)}`);
    if (process.env.VAULT_ALLOW_SECRET === "1") {
        console.error("VAULT_ALLOW_SECRET=1 set — overriding.");
        return;
    }
    console.error("Blocked. Remove it, or set VAULT_ALLOW_SECRET=1 if it is a false positive.");
    process.exit(1);
}

module.exports = { EXTERNAL_MAX_LINE, isSafeRegex, loadPatterns, scanLines };

if (require.main === module) main();
