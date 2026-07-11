"use strict";
const fs = require("fs");
const path = require("path");

const PKG = path.join(__dirname, "pkg");
const OUT = path.join(__dirname, "install.sh");
const DELIM = "__CLAUDE_AUDIT_PKG_EOF__";

// (target-relative path) for each plain file to embed verbatim
const FILES = [
  ".claude/hooks/log-permission.js",
  ".claude/hooks/log-permission.test.js",
  ".claude/scripts/audit-permissions.js",
  ".claude/scripts/audit-permissions.test.js",
  ".claude/skills/audit-permissions/SKILL.md",
  ".claude/skills/audit-permissions/README.md"
];

function read(rel) {
  const c = fs.readFileSync(path.join(PKG, rel), "utf8");
  if (c.indexOf(DELIM) !== -1) throw new Error("delimiter collision in " + rel);
  return c.endsWith("\n") ? c : c + "\n";
}

function heredoc(body) {
  return "<<'" + DELIM + "'\n" + body + DELIM + "\n";
}

const settings = read(".claude/settings.json");

let s = "";
s += "#!/usr/bin/env bash\n";
s += "# Claude Code permission-audit system - portable installer (generated; do not hand-edit).\n";
s += "# Usage: bash install.sh [TARGET_DIR]   (default: current directory)\n";
s += "set -u\n";
s += 'TARGET="${1:-.}"\n';
s += 'echo "Installing the Claude Code permission-audit system into: $TARGET"\n\n';

s += "write() {\n";
s += '  mkdir -p "$(dirname "$TARGET/$1")"\n';
s += '  cat > "$TARGET/$1"\n';
s += "}\n\n";

for (const rel of FILES) {
  s += 'write "' + rel + '" ' + heredoc(read(rel)) + "\n";
}

// settings.json: never clobber an existing one
s += "emit_settings() {\n";
s += "cat " + heredoc(settings);
s += "}\n\n";
s += 'SETTINGS="$TARGET/.claude/settings.json"\n';
s += 'if [ -f "$SETTINGS" ]; then\n';
s += '  emit_settings > "$TARGET/.claude/settings.audit-snippet.json"\n';
s += '  SETTINGS_NOTE="EXISTING settings.json left untouched -> wrote settings.audit-snippet.json; merge its permissions+hooks blocks and remove any OLD audit hooks."\n';
s += "else\n";
s += '  emit_settings > "$SETTINGS"\n';
s += '  SETTINGS_NOTE="wrote .claude/settings.json"\n';
s += "fi\n\n";

// .gitignore for the log
s += 'GI="$TARGET/.claude/.gitignore"\n';
s += "if ! grep -qs '^logs/' \"$GI\" 2>/dev/null; then\n";
s += "  printf '%s\\n' '# Permission audit log (machine-local; never commit)' 'logs/' >> \"$GI\"\n";
s += "fi\n\n";

s += 'echo\n';
s += 'echo "Files installed. $SETTINGS_NOTE"\n';
s += 'echo\n';
s += 'if command -v node >/dev/null 2>&1; then\n';
s += '  echo "Self-test:"\n';
s += '  node "$TARGET/.claude/hooks/log-permission.test.js" 2>&1 | tail -1 || true\n';
s += '  node "$TARGET/.claude/scripts/audit-permissions.test.js" 2>&1 | tail -1 || true\n';
s += "else\n";
s += '  echo "WARNING: node not found on PATH - the hooks need it. Install Node, then re-check."\n';
s += "fi\n\n";

s += 'echo\n';
s += 'echo "Next steps:"\n';
s += 'echo "  1. Restart Claude Code so it loads the hooks."\n';
s += 'echo "  2. Use it for a while, then run: node .claude/scripts/audit-permissions.js"\n';
s += 'echo "  3. Or invoke the /audit-permissions skill to get allowlist suggestions."\n';
s += 'echo "  See .claude/skills/audit-permissions/README.md for details."\n';

fs.writeFileSync(OUT, s);
fs.chmodSync(OUT, 0o755);
console.log("Wrote " + OUT + " (" + s.length + " bytes, embeds " + (FILES.length + 1) + " files)");
