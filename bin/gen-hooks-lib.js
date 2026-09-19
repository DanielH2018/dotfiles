'use strict';
// Pure, deterministic logic for `bin/gen-hooks`. No fs/process access lives here: the
// wrapper lists home/private_dot_claude/hooks/ and reads each file, then hands the text in
// as plain objects, so every function below is a total function of its arguments
// (gen-lint-files-lib.js's precedent).
//
// What this generates, and why. The `hooks` block of settings.base.json used to be
// hand-written JSON, and nothing asserted that every hook file on disk was registered in it:
// a hook that existed but fired nowhere was a silent gap (#528). Each hook now declares its
// own registrations in a comment block the shell (and Python) ignore, and the block in the
// template is rendered from those declarations. A file with no declaration is an error
// here, so the exists-but-unregistered state cannot land.
//
// The declaration grammar. One block per registration; a file may carry several (a hook
// invoked with different arguments on different events). A file that is invoked by a
// sibling and registered nowhere carries `library` instead, with the reason spelled out:
//
//   # gen-hooks: register
//   #   event: SessionStart
//   #   matcher: startup|compact          optional
//   #   timeout: 5                        required, seconds
//   #   order: 10                         required, unique within the event
//   #   args: start                       optional, appended to the command
//   #   when: ne .chezmoi.os "windows"    optional chezmoi condition, emitted verbatim
//   #   async: true                       optional
//   #   statusMessage: Formatting...      optional
//   #   command: {{ if ... }}...{{ end }} optional; replaces the derived command whole, and
//                                       is written into the template verbatim (no escaping)
//
//   # gen-hooks: library
//   #   reason: sourced by hook-input.sh consumers
//
// The opener is the only delimiter: a block runs from its `# gen-hooks:` line to the first
// line that is not a `#   key: value` continuation. There is no closing marker to forget,
// and a stray blank line ends the block rather than swallowing what follows.

const OPENER_RE = /^# gen-hooks: (\S+)\s*$/;
const FIELD_RE = /^#   ([a-zA-Z]+): (.*)$/;

const REGISTER_KEYS = new Set([
  'event', 'matcher', 'timeout', 'order', 'args', 'when', 'async', 'statusMessage', 'command',
]);
const LIBRARY_KEYS = new Set(['reason']);

// The order events are written in. It is the order the hand-written block had, kept so the
// first generated commit diffs as a rewrite of the same shape rather than a reshuffle. An
// event outside this list is a typo as far as the harness is concerned -- it would register
// a hook that never fires -- so it is an error here, not a new key.
const EVENT_ORDER = [
  'PermissionRequest', 'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'PreCompact', 'PostCompact', 'Stop', 'StopFailure', 'SessionEnd',
  'InstructionsLoaded', 'SubagentStop',
];

// Registrations with no hook file behind them. The one entry is a shell one-liner, not a
// script; it lives here rather than in the template so the block stays fully generated.
// dev-container network glue (Linux/macOS); skipped on Windows.
const INLINE_REGISTRATIONS = [
  {
    file: '(inline)',
    event: 'SessionStart',
    matcher: 'startup',
    timeout: 10,
    order: 80,
    when: 'ne .chezmoi.os "windows"',
    command: 'docker network connect workspace_default $(hostname) 2>/dev/null || true',
  },
];

const HOOKS_PREFIX = '~/.claude/hooks/';
const SOURCE_PREFIX = 'executable_';

const BEGIN_MARKER_RE = /^\s*\{\{\/\* gen-hooks:begin\b.*\*\/\}\}\s*$/;
const END_MARKER_RE = /^\s*\{\{\/\* gen-hooks:end\b.*\*\/\}\}\s*$/;

// --- Parsing --------------------------------------------------------------------------------

function parseInt10(name, value, file) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`gen-hooks: ${file}: ${name} must be a non-negative integer, got '${value}'.`);
  }
  return Number(value);
}

// text: one hook file. Returns { registrations: [...], library: {reason} | null }.
// Throws on a malformed block: an unknown opener word, an unknown key, a missing required
// key, a bad integer, or a file that mixes `library` with a registration.
function parseHookFile(file, text) {
  const lines = text.split('\n');
  const registrations = [];
  let library = null;
  for (let i = 0; i < lines.length; i += 1) {
    const open = OPENER_RE.exec(lines[i]);
    if (!open) continue;
    const kind = open[1];
    if (kind !== 'register' && kind !== 'library') {
      throw new Error(`gen-hooks: ${file}:${i + 1}: unknown block '# gen-hooks: ${kind}' (expected register or library).`);
    }
    const allowed = kind === 'register' ? REGISTER_KEYS : LIBRARY_KEYS;
    const fields = {};
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const m = FIELD_RE.exec(lines[j]);
      if (!m) break;
      const [, key, value] = m;
      if (!allowed.has(key)) {
        throw new Error(`gen-hooks: ${file}:${j + 1}: unknown key '${key}' in a ${kind} block.`);
      }
      if (key in fields) throw new Error(`gen-hooks: ${file}:${j + 1}: duplicate key '${key}'.`);
      fields[key] = value.trim();
    }
    i = j - 1;
    if (kind === 'library') {
      if (!fields.reason) throw new Error(`gen-hooks: ${file}: a library block needs a reason: line.`);
      if (library) throw new Error(`gen-hooks: ${file}: more than one library block.`);
      library = { reason: fields.reason };
      continue;
    }
    for (const req of ['event', 'timeout', 'order']) {
      if (!(req in fields) || fields[req] === '') {
        throw new Error(`gen-hooks: ${file}: register block at line ${i + 1} is missing ${req}:.`);
      }
    }
    if (!EVENT_ORDER.includes(fields.event)) {
      throw new Error(`gen-hooks: ${file}: unknown event '${fields.event}'. Known: ${EVENT_ORDER.join(', ')}.`);
    }
    if ('async' in fields && fields.async !== 'true') {
      throw new Error(`gen-hooks: ${file}: async: takes only 'true' (omit the line otherwise).`);
    }
    const reg = {
      file,
      event: fields.event,
      timeout: parseInt10('timeout', fields.timeout, file),
      order: parseInt10('order', fields.order, file),
    };
    if (fields.matcher) reg.matcher = fields.matcher;
    if (fields.when) reg.when = fields.when;
    if (fields.async) reg.async = true;
    if (fields.statusMessage) reg.statusMessage = fields.statusMessage;
    if (fields.command) {
      // Written into the template verbatim, inside the quotes: it may carry `{{ }}` actions,
      // which JSON-escaping would break (`\"windows\"` is not a template operand).
      reg.command = fields.command;
      reg.rawCommand = true;
    } else {
      reg.command = `${HOOKS_PREFIX}${file.slice(SOURCE_PREFIX.length)}${fields.args ? ` ${fields.args}` : ''}`;
    }
    registrations.push(reg);
  }
  if (library && registrations.length > 0) {
    throw new Error(`gen-hooks: ${file}: is marked library but also carries a register block.`);
  }
  return { registrations, library };
}

// --- Census ---------------------------------------------------------------------------------

// files: { 'executable_foo.sh': '<text>', ... } -- every entry of the hooks directory. Only
// the `executable_` sources count: a registration is `~/.claude/hooks/foo.sh`, which needs
// the +x bit, and the prefix is the only thing that produces it. The sourced helpers
// (hook-input.sh, identity.sh, ...) and the test_*.py files are not candidates.
// Returns { registrations, libraries: [{file, reason}] } with the inline entries folded in.
// Throws for an executable that declares nothing: that is the drift this exists to close.
function census(files) {
  const registrations = [];
  const libraries = [];
  const undeclared = [];
  for (const file of Object.keys(files).sort()) {
    if (!file.startsWith(SOURCE_PREFIX)) continue;
    const parsed = parseHookFile(file, files[file]);
    if (parsed.library) libraries.push({ file, reason: parsed.library.reason });
    else if (parsed.registrations.length === 0) undeclared.push(file);
    registrations.push(...parsed.registrations);
  }
  if (undeclared.length > 0) {
    throw new Error(
      `gen-hooks: ${undeclared.length} hook file(s) declare no registration and are not marked `
      + `library, so they would fire nowhere: ${undeclared.join(', ')}. Add a `
      + '`# gen-hooks: register` block (or `# gen-hooks: library` with a reason:).',
    );
  }
  registrations.push(...INLINE_REGISTRATIONS);
  return { registrations, libraries };
}

// --- Rendering ------------------------------------------------------------------------------

// Registrations grouped the way the template writes them: per event, sorted by order, and
// consecutive entries sharing a matcher and a condition folded into one matcher group.
// Throws on a duplicate order within an event, and when an event's first group is
// conditional -- the comma scheme below puts the separator BEFORE each later group so any
// subset of them can drop out under a chezmoi gate, which only works if the first one is
// always there.
function groupRegistrations(registrations) {
  const byEvent = new Map();
  for (const r of registrations) {
    if (!byEvent.has(r.event)) byEvent.set(r.event, []);
    byEvent.get(r.event).push(r);
  }
  const events = [];
  for (const event of EVENT_ORDER) {
    const regs = byEvent.get(event);
    if (!regs) continue;
    regs.sort((a, b) => a.order - b.order);
    for (let i = 1; i < regs.length; i += 1) {
      if (regs[i].order === regs[i - 1].order) {
        throw new Error(
          `gen-hooks: ${event}: ${regs[i - 1].file} and ${regs[i].file} both declare order: `
          + `${regs[i].order}. Orders are unique within an event.`,
        );
      }
    }
    const groups = [];
    for (const r of regs) {
      const last = groups[groups.length - 1];
      if (last && last.matcher === r.matcher && last.when === r.when) last.hooks.push(r);
      else groups.push({ matcher: r.matcher, when: r.when, hooks: [r] });
    }
    if (groups[0].when) {
      throw new Error(
        `gen-hooks: ${event}: the first entry (${groups[0].hooks[0].file}) is conditional. `
        + 'Give an unconditional entry the lowest order in this event.',
      );
    }
    events.push({ event, groups });
  }
  return events;
}

function jsonString(s) {
  return JSON.stringify(s);
}

function renderHook(r, indent) {
  const lines = [
    `${indent}{`,
    `${indent}  "type": "command",`,
    `${indent}  "command": ${r.rawCommand ? `"${r.command}"` : jsonString(r.command)},`,
    `${indent}  "timeout": ${r.timeout}`,
  ];
  if (r.statusMessage) lines.push(`${indent}  "statusMessage": ${jsonString(r.statusMessage)}`);
  if (r.async) lines.push(`${indent}  "async": true`);
  // Every line but the last carries the comma.
  for (let i = 3; i < lines.length - 1; i += 1) lines[i] += ',';
  lines.push(`${indent}}`);
  return lines;
}

function renderGroup(g, indent) {
  const lines = [`${indent}{`];
  if (g.matcher !== undefined) lines.push(`${indent}  "matcher": ${jsonString(g.matcher)},`);
  lines.push(`${indent}  "hooks": [`);
  g.hooks.forEach((r, i) => {
    const hook = renderHook(r, `${indent}    `);
    if (i < g.hooks.length - 1) hook[hook.length - 1] += ',';
    lines.push(...hook);
  });
  lines.push(`${indent}  ]`, `${indent}}`);
  return lines;
}

// The text between the markers: every event key of the `hooks` object, indented for the
// template. Each group after an event's first is preceded by its comma; a conditional group
// wraps comma and body in `{{ if <when> }}...{{ end }}`, so the gate opens on the previous
// group's closing line and closes on this one's, the way the hand-written block did.
function renderHooksBlock(registrations, indent = '    ') {
  const out = [];
  const events = groupRegistrations(registrations);
  events.forEach(({ event, groups }, ei) => {
    out.push(`${indent}${jsonString(event)}: [`);
    groups.forEach((g, gi) => {
      const body = renderGroup(g, `${indent}  `);
      if (gi > 0) {
        if (g.when) {
          out[out.length - 1] += `{{ if ${g.when} }},`;
          body[body.length - 1] += '{{ end }}';
        } else {
          out[out.length - 1] += ',';
        }
      }
      out.push(...body);
    });
    out.push(`${indent}]${ei < events.length - 1 ? ',' : ''}`);
  });
  return out.join('\n');
}

// Replace the lines strictly between the begin and end markers with the rendered block.
// Throws when either marker is missing, doubled, or out of order: the generator fills the
// slot the template declares, it does not invent where the block goes.
function injectHooksBlock(templateText, registrations) {
  const lines = templateText.split('\n');
  const begins = [];
  const ends = [];
  lines.forEach((l, i) => {
    if (BEGIN_MARKER_RE.test(l)) begins.push(i);
    if (END_MARKER_RE.test(l)) ends.push(i);
  });
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(
      `gen-hooks: expected exactly one {{/* gen-hooks:begin */}} and one {{/* gen-hooks:end */}} `
      + `marker in the template, found ${begins.length} and ${ends.length}.`,
    );
  }
  if (ends[0] < begins[0]) throw new Error('gen-hooks: end marker appears before begin marker.');
  const indent = /^\s*/.exec(lines[begins[0]])[0];
  const block = renderHooksBlock(registrations, indent);
  return [...lines.slice(0, begins[0] + 1), block, ...lines.slice(ends[0])].join('\n');
}

function firstDiffLine(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const n = Math.max(al.length, bl.length);
  for (let i = 0; i < n; i += 1) {
    if (al[i] !== bl[i]) {
      return { lineNo: i + 1, expected: al[i] ?? '(end of file)', got: bl[i] ?? '(end of file)' };
    }
  }
  return null;
}

module.exports = {
  EVENT_ORDER,
  INLINE_REGISTRATIONS,
  SOURCE_PREFIX,
  parseHookFile,
  census,
  groupRegistrations,
  renderHooksBlock,
  injectHooksBlock,
  firstDiffLine,
};
