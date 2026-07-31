#!/usr/bin/env node
/**
 * config-lint.js — deterministic drift checks for a Claude Code config dir.
 *
 * Report-only. Audits (default: ~/.claude):
 *   - enabledPlugins that aren't installed  (dead) / installed but not enabled (dormant)
 *   - hook command script paths that don't exist on disk (orphaned)
 *   - @-include targets in CLAUDE.md / CLAUDE.local.md that don't exist
 *   - skill-name collisions across user skills and plugin skills
 *   - CLAUDE.md size vs a soft bloat threshold
 *   - binary/tool deps guarded in hook scripts (run_if_installed/command -v/
 *     which), permission-granted in settings.json (Bash(tool...) allow
 *     entries), or gated by a `-f "$HOME/.local/share/<tool>/..."` existence
 *     check before a `source` (e.g. ble.sh) — absent from PATH/disk on this
 *     host — info-only for now (M14/M15 reference-resolver slice 1; see
 *     specs/env-modules)
 *
 * Usage: node config-lint.js [rootDir] [--strict] [--json]
 *   rootDir  config dir to audit (default: ~/.claude)
 *   --strict exit 1 if any should-fix findings (for CI/hooks)
 *   --json   emit findings as JSON instead of text
 *
 * The judgment part (is a rule in the right home — hook vs skill vs rule vs
 * permission) is intentionally NOT here; it lives in SKILL.md as advisory
 * review, because prose classification is unreliable as a hard check.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const BLOAT_MAX_BYTES = 12 * 1024; // ~12 KB
const BLOAT_MAX_LINES = 250;

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

function diffPlugins(enabled, installedKeys) {
    const installed = new Set(installedKeys);
    const enabledKeys = Object.keys(enabled || {}).filter(k => enabled[k]);
    return {
        dead: enabledKeys.filter(k => !installed.has(k)),
        dormant: installedKeys.filter(k => !enabled[k]),
    };
}

function extractHookCommands(settings) {
    const out = [];
    const hooks = (settings && settings.hooks) || {};
    for (const event of Object.keys(hooks)) {
        const matchers = Array.isArray(hooks[event]) ? hooks[event] : [];
        for (const matcher of matchers) {
            const list = (matcher && matcher.hooks) || [];
            for (const h of list) {
                if (h && h.type === "command" && typeof h.command === "string") out.push(h.command);
            }
        }
    }
    return out;
}

function extractPaths(cmd, home) {
    const paths = [], unresolved = [];
    const re = /"([^"]{1,400}\.(?:js|sh|mjs|cjs))"|'([^']{1,400}\.(?:js|sh|mjs|cjs))'|(\S{1,400}\.(?:js|sh|mjs|cjs))/g;
    let match;
    while ((match = re.exec(cmd)) !== null) {
        let tok = match[1] || match[2] || match[3];
        if (/\$(?!HOME\b)\{?\w+/.test(tok)) { unresolved.push(tok); continue; }
        tok = tok.replace(/\$\{?HOME\}?/g, home).replace(/^~(?=[/\\]|$)/, home);
        paths.push(tok);
    }
    return { paths, unresolved };
}

function parseIncludes(text) {
    const out = [];
    for (const line of String(text).split("\n")) {
        const m = line.match(/^@(\S+)/);
        if (m) out.push(m[1]);
    }
    return out;
}

function findDuplicateSkills(skillsBySource) {
    const seen = new Map(); // name -> [sources]
    for (const source of Object.keys(skillsBySource)) {
        for (const name of skillsBySource[source]) {
            if (!seen.has(name)) seen.set(name, []);
            seen.get(name).push(source);
        }
    }
    const dupes = [];
    for (const [name, sources] of seen) {
        if (sources.length > 1) dupes.push({ name, sources });
    }
    return dupes;
}

function checkBloat(text, { maxBytes = BLOAT_MAX_BYTES, maxLines = BLOAT_MAX_LINES } = {}) {
    const bytes = Buffer.byteLength(text, "utf8");
    const lines = text.split("\n").length;
    return { bytes, lines, overBytes: bytes > maxBytes, overLines: lines > maxLines };
}

// Binary/tool dependency (M14/M15 reference kind #10, spec §2 row 10).
// Deployed scripts guard optional tools with idioms like:
//   run_if_installed prettier --write ...      (hooks/auto-format.sh's own wrapper)
//   command -v cargo >/dev/null 2>&1 && ...    (ad-hoc guards elsewhere)
// Both idioms name the *literal* tool at the call site; only the wrapper's own
// definition (`command -v "$1"`) references a shell parameter, which is excluded.
const BINARY_DEP_PATTERNS = [
    /\brun_if_installed\s+([A-Za-z0-9_.-]+)/g,
    /\bcommand\s+-v\s+"?([A-Za-z0-9_.-]+)"?/g,
    /\bwhich\s+"?([A-Za-z0-9_.-]+)"?/g,
];

// Strip shell comments (naive: '#' at line start or preceded by whitespace) so
// prose like "# which would break X" doesn't get misread as a `which` guard.
function stripShellComments(text) {
    return text.split("\n").map(line => {
        const m = line.match(/(^|\s)#.*/);
        return m ? line.slice(0, m.index) : line;
    }).join("\n");
}

function extractBinaryDeps(files) {
    const seen = new Set();
    const deps = [];
    for (const { path: filePath, text: rawText } of files) {
        const text = stripShellComments(rawText);
        for (const re of BINARY_DEP_PATTERNS) {
            re.lastIndex = 0;
            let match;
            while ((match = re.exec(text)) !== null) {
                const tool = match[1];
                if (/^\$/.test(tool)) continue; // shell parameter (e.g. "$1"), not a literal tool name
                const key = `${filePath} ${tool}`;
                if (seen.has(key)) continue;
                seen.add(key);
                deps.push({ file: filePath, tool });
            }
        }
    }
    return deps;
}

// hasBinary is injected so tests never depend on the real PATH; audit() wires
// up the real `command -v` check via commandExists() below.
function checkBinaryDeps(deps, hasBinary) {
    const findings = [];
    for (const { file, tool } of deps) {
        if (!hasBinary(tool)) {
            findings.push({ sev: "info", area: "binary-deps", msg: `${file} depends on "${tool}", not found on PATH (guarded, silently no-ops here)` });
        }
    }
    return findings;
}

// Permission-granted binary dependency (M14/M15 reference kind #10, spec §2 row
// 10 — same "declares a tool this config expects to run" shape as
// run_if_installed/command -v/which, just spelled as a settings.json bare
// `Bash(<tool>)` allow entry instead of a shell guard). Matches part of
// A1-43: settings.base.json allow-lists macOS-only bare commands (pbcopy,
// pbpaste) and a non-interactive-only builtin (history) with no platform
// gate, so they resolve to dead grants on this Linux host.
//
// Deliberately scoped to the *bare*, argument-less `Bash(tool)` shape (no
// `:*` wildcard or subcommand) — NOT every `Bash(...)` entry. The wider
// allow-list also carries ~250 `Bash(<tool> <subcommand>:*)` grants for a
// whole polyglot dev toolchain (cargo, go, java, eslint, gradle, sdk, just,
// ...) that are deliberately host/project-portable pre-approvals, not
// same-host dependency declarations; checking those against local PATH
// would misreport every toolchain this box doesn't happen to have installed
// as a "missing dependency," which it isn't. `md5:*`/`sdk ...:*`/`just:*`
// (also named in A1-43) fall in that wider, syntactically indistinguishable
// bucket and are left to the judgment-based pass 2 review (SKILL.md §2),
// not this deterministic check.
const PERMISSION_DEP_PATTERN = /^Bash\(([A-Za-z0-9_.-]+)\)$/;

function extractPermissionDeps(allowList, file = "settings.json (permissions.allow)") {
    const seen = new Set();
    const deps = [];
    for (const entry of allowList || []) {
        if (typeof entry !== "string") continue;
        const m = entry.match(PERMISSION_DEP_PATTERN);
        if (!m) continue;
        const tool = m[1];
        const key = `${file} ${tool}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deps.push({ file, tool });
    }
    return deps;
}

// File-existence guard before a `source`/`.` (M14/M15 reference kind #10, spec
// §2 row 10) — a companion shape to run_if_installed/command -v/which for
// tools that aren't invoked from PATH but are sourced from a fixed install
// location under XDG_DATA_HOME. Matches A14-31's ble.sh guard:
//   if [[ ... && -f "$HOME/.local/share/blesh/ble.sh" ]]; then
//     source "$HOME/.local/share/blesh/ble.sh" --noattach
//   fi
// Scoped to `.local/share` specifically (not `.config`) so it doesn't also
// catch optional local-override config files like
// ~/.config/claude/local.env, which are a different, intentionally-optional
// shape (M15 kind #5 file path, not #10 binary/tool dependency).
const PATH_DEP_PATTERN = /-f\s+"(\$HOME\/\.local\/share\/[^"]+)"/g;

function extractPathDeps(files) {
    const seen = new Set();
    const deps = [];
    for (const { path: filePath, text: rawText } of files) {
        const text = stripShellComments(rawText);
        PATH_DEP_PATTERN.lastIndex = 0;
        let match;
        while ((match = PATH_DEP_PATTERN.exec(text)) !== null) {
            const tool = match[1];
            const key = `${filePath} ${tool}`;
            if (seen.has(key)) continue;
            seen.add(key);
            deps.push({ file: filePath, tool });
        }
    }
    return deps;
}

// hasPath is injected (fs.existsSync in production, home is expanded first)
// so tests never depend on the real filesystem.
function checkPathDeps(deps, home, hasPath) {
    const findings = [];
    for (const { file, tool } of deps) {
        const resolved = tool.replace(/^\$HOME/, home);
        if (!hasPath(resolved)) {
            findings.push({ sev: "info", area: "binary-deps", msg: `${file} depends on "${tool}", not found on disk (guarded, silently no-ops here)` });
        }
    }
    return findings;
}

// ── fs wrappers ───────────────────────────────────────────────────────────────

function readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function commandExists(tool) {
    // `command` is a shell builtin (not an executable on PATH), so this needs a
    // shell. Tool names are already constrained to [A-Za-z0-9_.-] by the
    // extraction regexes, so a single interpolated string is safe here and
    // avoids Node's args+shell deprecation warning (DEP0190).
    const r = spawnSync(`command -v ${tool}`, { shell: "/bin/sh" });
    return r.status === 0;
}

function readHookScripts(hooksDir) {
    if (!fs.existsSync(hooksDir)) return [];
    return fs.readdirSync(hooksDir, { withFileTypes: true })
        .filter(d => d.isFile() && /\.(sh|bash)$/.test(d.name))
        .map(d => {
            const p = path.join(hooksDir, d.name);
            return { path: p, text: fs.readFileSync(p, "utf8") };
        });
}

function listSkillNames(skillsDir) {
    if (!fs.existsSync(skillsDir)) return [];
    return fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, "SKILL.md")))
        .map(d => d.name);
}

function enumeratePluginSkills(cacheRoot) {
    const bySource = {};
    if (!fs.existsSync(cacheRoot)) return bySource;
    for (const mkt of fs.readdirSync(cacheRoot, { withFileTypes: true }).filter(d => d.isDirectory())) {
        const mktDir = path.join(cacheRoot, mkt.name);
        for (const plugin of fs.readdirSync(mktDir, { withFileTypes: true }).filter(d => d.isDirectory())) {
            const pluginDir = path.join(mktDir, plugin.name);
            for (const version of fs.readdirSync(pluginDir, { withFileTypes: true }).filter(d => d.isDirectory())) {
                const names = listSkillNames(path.join(pluginDir, version.name, "skills"));
                if (names.length) bySource[`plugin:${plugin.name}`] = names;
            }
        }
    }
    return bySource;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function audit(root, home) {
    const findings = []; // {sev: 'should-fix'|'info', area, msg}
    const add = (sev, area, msg) => findings.push({ sev, area, msg });

    const settings = readJSON(path.join(root, "settings.json")) || {};
    const installed = readJSON(path.join(root, "plugins", "installed_plugins.json"));
    const installedKeys = installed && installed.plugins ? Object.keys(installed.plugins) : [];

    // Plugins
    const { dead, dormant } = diffPlugins(settings.enabledPlugins || {}, installedKeys);
    for (const p of dead) add("should-fix", "plugins", `enabled but not installed: ${p}`);
    for (const p of dormant) add("info", "plugins", `installed but not enabled: ${p}`);

    // Hook script paths
    for (const cmd of extractHookCommands(settings)) {
        const { paths, unresolved } = extractPaths(cmd, home);
        for (const p of paths) {
            if (!fs.existsSync(p)) add("should-fix", "hooks", `hook command references missing file: ${p}`);
        }
        for (const u of unresolved) add("info", "hooks", `hook path has unresolved var, not verified: ${u}`);
    }

    // @-includes in CLAUDE.md chain
    for (const name of ["CLAUDE.md", "CLAUDE.local.md"]) {
        const file = path.join(root, name);
        if (!fs.existsSync(file)) continue;
        const text = fs.readFileSync(file, "utf8");
        for (const inc of parseIncludes(text)) {
            const resolved = inc.replace(/^~(?=[/\\]|$)/, home);
            if (!fs.existsSync(resolved)) add("info", "includes", `${name} @-includes absent file (CC skips silently; ok if machine-local): ${inc}`);
        }
        if (name === "CLAUDE.md") {
            const b = checkBloat(text);
            if (b.overBytes || b.overLines) {
                add("info", "bloat", `CLAUDE.md is ${(b.bytes / 1024).toFixed(1)} KB / ${b.lines} lines (soft cap ${(BLOAT_MAX_BYTES / 1024)} KB / ${BLOAT_MAX_LINES})`);
            }
        }
    }

    // Duplicate skill names
    const skillsBySource = { user: listSkillNames(path.join(root, "skills")), ...enumeratePluginSkills(path.join(root, "plugins", "cache")) };
    for (const dupe of findDuplicateSkills(skillsBySource)) {
        add("info", "skills", `skill name "${dupe.name}" defined in: ${dupe.sources.join(", ")}`);
    }

    // Binary/tool dependencies (report-only: always info, see SKILL.md §Migration)
    const hookScripts = readHookScripts(path.join(root, "hooks"));
    const binaryDeps = extractBinaryDeps(hookScripts)
        .concat(extractPermissionDeps((settings.permissions || {}).allow));
    for (const f of checkBinaryDeps(binaryDeps, commandExists)) add(f.sev, f.area, f.msg);

    // Path-existence-guarded dependencies (e.g. ble.sh sourced from ~/.local/share).
    // Scanned over hook scripts plus ~/.bashrc — NOT folded into hookScripts above,
    // since bashrc also carries unrelated `command -v` guards (fzf, a prompt-banner
    // function) that would otherwise get swept into the PATH-binary check above and
    // produce findings outside this change's scope.
    const bashrcPath = path.join(home, ".bashrc");
    const pathScanFiles = fs.existsSync(bashrcPath)
        ? hookScripts.concat([{ path: bashrcPath, text: fs.readFileSync(bashrcPath, "utf8") }])
        : hookScripts;
    const pathDeps = extractPathDeps(pathScanFiles);
    for (const f of checkPathDeps(pathDeps, home, fs.existsSync)) add(f.sev, f.area, f.msg);

    return findings;
}

function main() {
    const args = process.argv.slice(2);
    const strict = args.includes("--strict");
    const asJson = args.includes("--json");
    const root = args.find(a => !a.startsWith("--")) || path.join(os.homedir(), ".claude");
    const home = os.homedir();

    const findings = audit(root, home);

    if (asJson) {
        console.log(JSON.stringify({ root, findings }, null, 2));
    } else {
        const shouldFix = findings.filter(f => f.sev === "should-fix");
        const info = findings.filter(f => f.sev === "info");
        console.log(`config-lint — ${root}\n`);
        if (!findings.length) console.log("✓ no drift found");
        if (shouldFix.length) {
            console.log(`SHOULD-FIX (${shouldFix.length}):`);
            for (const f of shouldFix) console.log(`  [${f.area}] ${f.msg}`);
        }
        if (info.length) {
            console.log(`\nINFO (${info.length}):`);
            for (const f of info) console.log(`  [${f.area}] ${f.msg}`);
        }
    }

    if (strict && findings.some(f => f.sev === "should-fix")) process.exitCode = 1;
}

module.exports = {
    diffPlugins, extractHookCommands, extractPaths, parseIncludes,
    findDuplicateSkills, checkBloat, extractBinaryDeps, checkBinaryDeps, audit,
    extractPermissionDeps, extractPathDeps, checkPathDeps,
    BLOAT_MAX_BYTES, BLOAT_MAX_LINES,
};

if (require.main === module) main();
