' Launches sonar-routing-watcher.ps1 truly hidden (window style 0), bypassing the
' Windows 11 terminal-delegation quirk where powershell.exe -WindowStyle Hidden
' can flash a console window / steal focus when re-launched via Task Scheduler.
' Same wrapper and same -ExecutionPolicy Bypass as streamdeck-watcher-hidden.vbs:
' execution policy is Undefined (= Restricted) at every scope on this machine, so
' a .ps1 will not run from Task Scheduler without it.
Set objShell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\sonar-routing-watcher.ps1"""
objShell.Run cmd, 0, False
