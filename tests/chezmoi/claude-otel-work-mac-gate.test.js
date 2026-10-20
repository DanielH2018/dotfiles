// The work Mac's claude-otel removal (2026-10-20), checked from both sides.
//
// On MacBook-Pro-2 the org's managed settings point every Claude Code session at Lithic's
// collector, so the local stack received nothing and was removed. Two gates carry that:
// .chezmoiignore keeps ~/claude-otel off the host, and settings.base.json sets no telemetry
// key on darwin, so nothing from this repo rides along into the org's pipeline. Both gates are
// silent when wrong, in opposite directions: a gate that fails open ships logs and traces to a
// company collector, and one written too wide takes the stack off the Linux workstations that
// still run it. So each is rendered as the work Mac and as a host that keeps the stack.
//
// The host is forced with `set .chezmoi`, because the `data` override cannot reach .chezmoi.*
// and CI renders on Linux, where the real hostname would make every check here vacuous.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { srcPath } = require('../lib/paths');

const skip = chezmoiAvailable ? false : 'chezmoi unavailable';

const IGNORE = srcPath('.chezmoiignore');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');

const WORK_MAC = { os: 'darwin', hostname: 'MacBook-Pro-2' };
// is-wsl reads .chezmoi.kernel.osrelease, which a macOS chezmoi does not populate, so a Linux
// render faked on a Mac has to supply a non-WSL kernel itself.
const FEDORA = { os: 'linux', hostname: 'fedora', osrelease: '7.1.5-201.fc44.x86_64' };

const as = ({ os, hostname, osrelease }, file) => renderTemplate(
  `{{ $_ := set .chezmoi "os" ${JSON.stringify(os)} }}`
  + `{{ $_ := set .chezmoi "hostname" ${JSON.stringify(hostname)} }}`
  + (osrelease ? `{{ $_ := set .chezmoi "kernel" (dict "osrelease" ${JSON.stringify(osrelease)}) }}` : '')
  + fs.readFileSync(file, 'utf8'),
  { profile: 'workstation' },
);

const ignored = (host) => new Set(as(host, IGNORE).split('\n').map((l) => l.trim()).filter(Boolean));
const telemetryKeys = (host) => Object.keys(JSON.parse(as(host, SETTINGS)).env)
  .filter((k) => /OTEL|TELEMETRY/.test(k))
  .sort();

test('the work Mac renders no claude-otel files', { skip }, () => {
  // Ignoring the directory covers every file under it, ensure-up.sh included, and leaves
  // nothing for the launchd agent to run.
  assert.ok(ignored(WORK_MAC).has('claude-otel'), 'claude-otel must be ignored on MacBook-Pro-2');
});

test('a workstation that runs the stack still renders it', { skip }, () => {
  const gated = [...ignored(FEDORA)].filter((l) => l.startsWith('claude-otel'));
  // ensure-up.sh is the macOS launcher and was never deployed on Linux; nothing else may be.
  assert.deepStrictEqual(gated, ['claude-otel/ensure-up.sh']);
});

test('the work Mac renders no telemetry env at all', { skip }, () => {
  // Every OTEL_* key the org does not set would reach Lithic's collector under the org's
  // endpoint and headers, so the expected list is empty rather than "minus the content flags".
  assert.deepStrictEqual(telemetryKeys(WORK_MAC), []);
});

test('a workstation keeps the full telemetry env, content flags included', { skip }, () => {
  assert.deepStrictEqual(telemetryKeys(FEDORA), [
    'CLAUDE_CODE_ENABLE_TELEMETRY',
    'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE',
    'OTEL_EXPORTER_OTLP_PROTOCOL',
    'OTEL_LOGS_EXPORTER',
    'OTEL_LOGS_EXPORT_INTERVAL',
    'OTEL_LOG_ASSISTANT_RESPONSES',
    'OTEL_LOG_TOOL_CONTENT',
    'OTEL_LOG_TOOL_DETAILS',
    'OTEL_LOG_USER_PROMPTS',
    'OTEL_METRICS_EXPORTER',
    'OTEL_METRICS_INCLUDE_ENTRYPOINT',
    'OTEL_METRICS_INCLUDE_SESSION_ID',
    'OTEL_METRIC_EXPORT_INTERVAL',
    'OTEL_TRACES_EXPORTER',
  ]);
});
