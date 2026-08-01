// Guards the Windows scheduled-task definitions under windows-provisioning/scheduled-tasks.
// These files are exported from Task Scheduler, which bakes the exporting machine in: the
// account SID under <Principals>, and the NetBIOS-qualified account name in a LogonTrigger.
// That pins the task to one box and publishes the machine SID. elevated-setup.ps1 registers
// them with `Register-ScheduledTask -User $env:USERNAME`, which rewrites the Principal but
// NOT the trigger's UserId — so the trigger has to come from chezmoi or the task cannot
// register anywhere else.
//
// The exports also declared encoding="UTF-16" while the bytes were ASCII, which made every
// standard XML parser refuse them. Task Scheduler survived it (PowerShell hands it a .NET
// string, where the declaration is ignored), so nothing ever complained — it just meant the
// definitions could not be machine-checked at all.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { renderTemplate } = require('./lib/render');

const REPO = path.join(__dirname, '..');
const TASKS = path.join(REPO, 'home', 'dot_config', 'windows-provisioning', 'scheduled-tasks');

function have(cmd, arg) {
  try { execFileSync(cmd, [arg], { stdio: 'ignore' }); return true; } catch { return false; }
}
const skip = !have('chezmoi', '--version') ? 'chezmoi unavailable' : false;
const skipXml = skip || (!have('python3', '--version') ? 'python3 unavailable' : false);

// Every definition, rendered: templates through chezmoi, plain XML as-is.
function definitions() {
  return fs.readdirSync(TASKS).filter((f) => f.endsWith('.xml') || f.endsWith('.xml.tmpl')).map((name) => {
    const raw = fs.readFileSync(path.join(TASKS, name), 'utf8');
    const xml = name.endsWith('.tmpl')
      ? renderTemplate(raw, { source: null, cwd: REPO })
      : raw;
    return { name, xml };
  });
}

test('the task definitions are found', { skip }, () => {
  const names = definitions().map((d) => d.name);
  assert.ok(names.length >= 3, `expected the exported tasks, got ${names.join(',')}`);
});

test('every definition is well-formed XML', { skip: skipXml }, () => {
  for (const { name, xml } of definitions()) {
    const r = spawnSync('python3', ['-c', 'import sys,xml.dom.minidom; xml.dom.minidom.parseString(sys.stdin.buffer.read())'], { input: xml, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${name}: ${r.stderr}`);
  }
});

test('no definition carries a machine account SID', { skip }, () => {
  for (const { name, xml } of definitions()) {
    assert.doesNotMatch(xml, /S-1-5-21-/, `${name} still has the exporting machine's SID`);
  }
});

test('every UserId comes from the template, not from the export', { skip }, () => {
  // Checked against the SOURCE, not the render: what a correct render looks like depends
  // on the machine (chezmoi's .chezmoi.username is bare on Linux and may be MACHINE\user
  // on Windows — both register fine). What must never come back is a literal.
  for (const name of fs.readdirSync(TASKS).filter((f) => f.endsWith('.xml') || f.endsWith('.xml.tmpl'))) {
    const src = fs.readFileSync(path.join(TASKS, name), 'utf8');
    for (const [, value] of src.matchAll(/<UserId>([^<]*)<\/UserId>/g)) {
      assert.match(value, /\{\{/, `${name} hardcodes a UserId (${value}) instead of templating it`);
    }
  }
});

test('a rendered UserId is never empty', { skip }, () => {
  // A template that renders to nothing would register a task nobody can run, and Task
  // Scheduler reports that as a generic failure long after provisioning.
  for (const { name, xml } of definitions()) {
    for (const [, value] of xml.matchAll(/<UserId>([^<]*)<\/UserId>/g)) {
      assert.notStrictEqual(value.trim(), '', `${name} rendered an empty UserId`);
    }
  }
});

test('a LogonTrigger names the user it should fire for', { skip }, () => {
  // Register-ScheduledTask -User does not reach into the trigger, so dropping the UserId
  // here would silently widen the task to every account's logon.
  for (const { name, xml } of definitions()) {
    for (const trigger of xml.match(/<LogonTrigger>[\s\S]*?<\/LogonTrigger>/g) || []) {
      const user = trigger.match(/<UserId>([^<]*)<\/UserId>/);
      assert.ok(user && user[1].trim() !== '', `${name}: LogonTrigger has no UserId`);
    }
  }
});

test('the declared encoding matches the bytes on disk', { skip }, () => {
  for (const name of fs.readdirSync(TASKS).filter((f) => f.endsWith('.xml') || f.endsWith('.xml.tmpl'))) {
    const buf = fs.readFileSync(path.join(TASKS, name));
    const declared = (buf.toString('latin1').match(/encoding="([^"]+)"/) || [])[1] || '';
    const isUtf16 = buf[0] === 0xff || buf[0] === 0xfe || buf.includes(0x00);
    assert.strictEqual(/^utf-16$/i.test(declared), isUtf16,
      `${name} declares encoding="${declared}" but is ${isUtf16 ? 'UTF-16' : 'single-byte'} on disk`);
  }
});
