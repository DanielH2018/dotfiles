'use strict';
// terminal-cheatsheet / core — the config roots and the handful of primitives every
// parser and the renderer share.
//
// The roots are resolved once, from the environment, and each parser also accepts one as
// an argument so a test can point it at a fixture tree without reloading the module graph.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The escape every generated page shares lives in html-kit (#564).
const { esc } = require('../html-kit');

const HOME = os.homedir();
const XDG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const YAZI = process.env.YAZI_CONFIG_HOME || path.join(XDG, 'yazi');
const PLATFORM = ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[os.platform()] || os.platform();

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const disp = (p) => p.replace(HOME, '~').replace(/\\/g, '/');
const appendUnit = (v, unit) => (v ? v + unit : '');

module.exports = { HOME, XDG, YAZI, PLATFORM, read, esc, disp, appendUnit };
