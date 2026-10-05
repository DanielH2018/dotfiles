' Launches the .ps1 named by the first argument truly hidden (window style 0), bypassing
' the Windows 11 terminal-delegation quirk where powershell.exe -WindowStyle Hidden can
' flash a console window / steal focus when re-launched via Task Scheduler.
' -ExecutionPolicy Bypass: execution policy is Undefined (= Restricted) at every scope on
' this machine, so a .ps1 will not run from Task Scheduler without it.
' Shared by every logon watcher under Scripts/; register.ps1 passes the script path.
If WScript.Arguments.Count < 1 Then WScript.Quit 2
Set objShell = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & WScript.Arguments(0) & """"
objShell.Run cmd, 0, False
