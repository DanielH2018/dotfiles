// TaskbarAutoHideFix.exe
// Build: csc /nologo /target:winexe /out:TaskbarAutoHideFix.exe TaskbarAutoHideFix.cs
//
// Fixes the Windows 11 taskbar auto-hide breakage after resume/unlock that
// ExplorerPatcher's per-monitor taskbars amplify. On wake, Windows recreates the
// taskbar; its auto-hide app-bar registration collides with a stale one, which
//   (a) pops a "Taskbar" message box: "you can have only one auto-hide toolbar per side"
//   (b) flips "Automatically hide the taskbar" back off (taskbar stuck visible).
// The collision can land a second or two AFTER the trigger fires, so a single re-assert
// gets clobbered (observed: the box then sits there and auto-hide stays off). This helper
// therefore runs a short retry window. Each pass it:
//   - closes any "#32770" dialog that is the auto-hide-toolbar popup, and
//   - if auto-hide is off (or a popup was present) re-asserts it (off->on) to force a
//     clean app-bar re-registration.
// It exits early once things are stable for a few passes, so a normal unlock is ~a no-op.
// Auto-hide is a global taskbar attribute, so re-asserting the primary taskbar covers all
// monitors. Built as winexe: no console window when Task Scheduler runs it.
//
// Assumes auto-hide is the desired state (it always forces it back on).

using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
using System.Threading;

class TaskbarAutoHideFix
{
    [StructLayout(LayoutKind.Sequential)]
    struct APPBARDATA { public uint cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public IntPtr lParam; }
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int left, top, right, bottom; }

    delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("shell32.dll")] static extern IntPtr SHAppBarMessage(uint dwMessage, ref APPBARDATA pData);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string win);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);

    const uint ABM_GETSTATE = 0x00000004;
    const uint ABM_SETSTATE = 0x0000000A;
    const uint WM_CLOSE = 0x0010;
    const int ABS_AUTOHIDE = 0x00000001;

    static IntPtr tray;

    static int GetState()
    {
        APPBARDATA d = new APPBARDATA(); d.cbSize = (uint)Marshal.SizeOf(typeof(APPBARDATA)); d.hWnd = tray;
        return (int)SHAppBarMessage(ABM_GETSTATE, ref d);
    }
    static void SetState(int state)
    {
        APPBARDATA d = new APPBARDATA(); d.cbSize = (uint)Marshal.SizeOf(typeof(APPBARDATA)); d.hWnd = tray; d.lParam = (IntPtr)state;
        SHAppBarMessage(ABM_SETSTATE, ref d);
    }

    static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
    static string Class(IntPtr h) { var s = new StringBuilder(64); GetClassName(h, s, 64); return s.ToString(); }

    // The "you can have only one auto-hide toolbar per side" box is a #32770 dialog
    // captioned "Taskbar" (its body text lives in a child static).
    static bool IsAutoHidePopup(IntPtr h)
    {
        if (Class(h) != "#32770") return false;
        if (Text(h).ToLowerInvariant().Contains("taskbar")) return true;
        bool m = false;
        EnumChildWindows(h, (c, l) => { string t = Text(c).ToLowerInvariant(); if (t.Contains("toolbar") || t.Contains("auto-hide") || t.Contains("autohide")) m = true; return true; }, IntPtr.Zero);
        return m;
    }

    static int ClosePopups()
    {
        var hit = new List<IntPtr>();
        EnumWindows((h, l) => { if (IsWindowVisible(h) && IsAutoHidePopup(h)) hit.Add(h); return true; }, IntPtr.Zero);
        foreach (var h in hit) PostMessageW(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        return hit.Count;
    }

    static void Reassert()
    {
        SetState(0);            // auto-hide OFF
        Thread.Sleep(150);
        SetState(ABS_AUTOHIDE); // auto-hide ON -> forces app-bar re-registration
    }

    // One check: re-find the taskbar (its handle changes when explorer restarts), close
    // any auto-hide popup, and re-assert auto-hide if a popup was present or it's off.
    // Returns true when nothing needed fixing.
    static bool Pass()
    {
        tray = FindWindow("Shell_TrayWnd", null);
        if (tray == IntPtr.Zero) return true; // shell not up yet; try again next tick
        int popups = ClosePopups();
        if (popups > 0 || (GetState() & ABS_AUTOHIDE) == 0) { Reassert(); return false; }
        return true;
    }

    // "watch" (the scheduled task): run forever on a ~2.5s cadence, so the popup is cleared
    //          within seconds of appearing no matter which event caused it (logon, unlock,
    //          resume, or a display/power transition that fires no usable trigger).
    // "once":  a single quick sweep (the backup poll).
    // default: a bounded ~60s watch, for manual runs.
    static void Main(string[] args)
    {
        string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "bounded";
        if (mode == "watch")
        {
            while (true) { try { Pass(); } catch { } Thread.Sleep(2500); }
        }
        int maxIters = mode == "once" ? 3 : 24;
        int wait = mode == "once" ? 700 : 2500;
        int clean = 0;
        for (int i = 0; i < maxIters && clean < 8; i++)
        {
            if (Pass()) clean++; else clean = 0;
            Thread.Sleep(wait);
        }
    }
}
