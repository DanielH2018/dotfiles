# install.ps1 - register the reaper to run hidden at logon. Run once per machine.
# Uninstall: Unregister-ScheduledTask -TaskName 'WSL Interop Reaper' -Confirm:$false
# The registration itself is shared with the other logon watchers: ..\logon-watcher\register.ps1.
# Limited (not elevated): terminating the leaked host needs no elevation (verified 2026-07-25).
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $here '..\logon-watcher\register.ps1') `
    -TaskName 'WSL Interop Reaper' `
    -Script (Join-Path $here 'wslhost-interop-reaper.ps1') `
    -Description 'Kills wslhost.exe hosts that leaked spinning interop threads (microsoft/WSL#41173).' `
    -LogPath (Join-Path $env:LOCALAPPDATA 'wslhost-interop-reaper.log')
