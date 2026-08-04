// Windows-style window shortcuts for a multi-monitor layout.
//
//   Meta+Shift+Left/Right  move the window to the previous/next screen,
//                          cycling with wrap-around
//   Meta+Shift+Up          maximise the window
//   Meta+Shift+Down        restore it
//
// Screens are ordered left to right by x, and top to bottom where two share
// an x. On this layout that is: far-left, centre, right, bottom-right — so
// the bottom-right screen sits after the right one, and Right from it wraps
// round to the far-left. KWin's own "Window to Next Screen" happens to agree
// today, but its order is an internal detail; this states the rule outright.
//
// Moving scales the window to the new screen, so it keeps the same fraction
// of the work area instead of keeping its pixel size and being clamped.

var MAXIMIZE_AREA = 2; // KWin ClientAreaOption::MaximizeArea
var EPS = 4;           // px slack when recognising a snapped window

function near(a, b) {
    return Math.abs(a - b) <= EPS;
}

function sameOutput(a, b) {
    if (!a || !b) {
        return false;
    }
    return a.geometry.x === b.geometry.x && a.geometry.y === b.geometry.y;
}

function workArea(output) {
    try {
        return workspace.clientArea(MAXIMIZE_AREA, output, workspace.currentDesktop);
    } catch (e) {
        return output.geometry;
    }
}

function orderedOutputs() {
    var all = workspace.screens, outs = [];
    for (var i = 0; i < all.length; i++) {
        outs.push(all[i]);
    }
    outs.sort(function (a, b) {
        if (a.geometry.x !== b.geometry.x) {
            return a.geometry.x - b.geometry.x;
        }
        return a.geometry.y - b.geometry.y;
    });
    return outs;
}

function stepOutput(from, delta) {
    var outs = orderedOutputs();
    if (outs.length < 2) {
        return null;
    }
    var idx = -1;
    for (var i = 0; i < outs.length; i++) {
        if (sameOutput(outs[i], from)) {
            idx = i;
            break;
        }
    }
    if (idx < 0) {
        return null;
    }
    return outs[(idx + delta + outs.length) % outs.length];
}

// A maximised or quick-tiled window ignores frameGeometry writes, so the state
// has to come off before the move and go back on after. Plasma 6.7 exposes
// neither maximizedHorizontally nor quickTileMode to scripts, so recognise it
// from the geometry instead.
function snapOf(w, area) {
    var g = w.frameGeometry;
    var fullHeight = near(g.height, area.height) && near(g.y, area.y);
    var fullWidth = near(g.width, area.width) && near(g.x, area.x);

    if (fullWidth && fullHeight) {
        return "max";
    }
    if (fullHeight && near(g.width, area.width / 2)) {
        if (near(g.x, area.x)) { return "left"; }
        if (near(g.x, area.x + area.width / 2)) { return "right"; }
    }
    if (fullWidth && near(g.height, area.height / 2)) {
        if (near(g.y, area.y)) { return "top"; }
        if (near(g.y, area.y + area.height / 2)) { return "bottom"; }
    }
    return "none";
}

// Every one of these slots toggles, so calling applySnap once before the move
// and once after leaves the window in the state it started in.
function applySnap(snap) {
    if (snap === "max") { workspace.slotWindowMaximize(); }
    else if (snap === "left") { workspace.slotWindowQuickTileLeft(); }
    else if (snap === "right") { workspace.slotWindowQuickTileRight(); }
    else if (snap === "top") { workspace.slotWindowQuickTileTop(); }
    else if (snap === "bottom") { workspace.slotWindowQuickTileBottom(); }
}

function moveScreen(delta) {
    var w = workspace.activeWindow;
    if (!w || !w.moveable) {
        return;
    }
    var from = w.output;
    var target = stepOutput(from, delta);
    if (!target || sameOutput(target, from)) {
        return;
    }

    var oldArea = workArea(from);
    var snap = snapOf(w, oldArea);

    applySnap(snap);

    // Scale to the new screen: the window keeps the same fraction of the work
    // area in both position and size.
    var newArea = workArea(target);
    var g = w.frameGeometry;
    var scaleX = newArea.width / oldArea.width;
    var scaleY = newArea.height / oldArea.height;
    var width = Math.min(g.width * scaleX, newArea.width);
    var height = Math.min(g.height * scaleY, newArea.height);
    var x = newArea.x + (g.x - oldArea.x) * scaleX;
    var y = newArea.y + (g.y - oldArea.y) * scaleY;

    w.frameGeometry = {
        x: Math.round(Math.min(Math.max(x, newArea.x), newArea.x + newArea.width - width)),
        y: Math.round(Math.min(Math.max(y, newArea.y), newArea.y + newArea.height - height)),
        width: Math.round(width),
        height: Math.round(height)
    };

    applySnap(snap);
}

function isMaximized(w) {
    var a = workArea(w.output), g = w.frameGeometry;
    return near(g.x, a.x) && near(g.y, a.y) &&
           near(g.width, a.width) && near(g.height, a.height);
}

// KWin's own restore geometry does not survive a scripted move — restoring a
// window maximised on one screen can throw it back to the previous one. So
// remember the pre-maximise rect here instead, as fractions of the work area,
// which also makes it follow the window across screens.
var restoreRects = {};

function windowKey(w) {
    return String(w.internalId || (w.resourceClass + "/" + w.caption));
}

function setMaximized(wanted) {
    var w = workspace.activeWindow;
    if (!w || !w.resizeable || isMaximized(w) === wanted) {
        return;
    }
    var key = windowKey(w);
    var area = workArea(w.output);

    if (wanted) {
        var g = w.frameGeometry;
        restoreRects[key] = {
            x: (g.x - area.x) / area.width,
            y: (g.y - area.y) / area.height,
            width: g.width / area.width,
            height: g.height / area.height
        };
        workspace.slotWindowMaximize();
        return;
    }

    workspace.slotWindowMaximize();
    var r = restoreRects[key];
    if (r) {
        delete restoreRects[key];
        var width = r.width * area.width;
        var height = r.height * area.height;
        w.frameGeometry = {
            x: Math.round(area.x + r.x * area.width),
            y: Math.round(area.y + r.y * area.height),
            width: Math.round(width),
            height: Math.round(height)
        };
    }
}

registerShortcut("WindowsScreenMoveLeft",  "Move Window One Screen Left (Windows-style)",  "Meta+Shift+Left",  function () { moveScreen(-1); });
registerShortcut("WindowsScreenMoveRight", "Move Window One Screen Right (Windows-style)", "Meta+Shift+Right", function () { moveScreen(1); });
registerShortcut("WindowsMaximizeWindow", "Maximize Window (Windows-style)", "Meta+Shift+Up",   function () { setMaximized(true); });
registerShortcut("WindowsRestoreWindow",  "Restore Window (Windows-style)",  "Meta+Shift+Down", function () { setMaximized(false); });
