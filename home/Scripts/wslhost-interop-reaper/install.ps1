# install.ps1 — register the reaper to run hidden at logon. Run once per machine.
# Uninstall: Unregister-ScheduledTask -TaskName 'WSL Interop Reaper' -Confirm:$false
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'wslhost-interop-reaper.ps1'
$vbs    = Join-Path $here 'wslhost-interop-reaper-hidden.vbs'
if (-not (Test-Path $script)) { throw "Not found: $script" }
if (-not (Test-Path $vbs))    { throw "Not found: $vbs" }

# Same VBS-wrapper reasoning as streamdeck-watcher: Task Scheduler delegates
# powershell.exe to Windows Terminal on Win11, which creates the window before
# -WindowStyle Hidden applies — and the reaper never exits, so that console would
# never close. wscript starts it genuinely hidden.
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

# RunLevel Limited: terminating the leaked host needs no elevation (verified 2026-07-25).
Register-ScheduledTask -TaskName 'WSL Interop Reaper' -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Limited -Force `
    -Description 'Kills wslhost.exe hosts that leaked spinning interop threads (microsoft/WSL#41173).' | Out-Null

Start-ScheduledTask -TaskName 'WSL Interop Reaper'
Write-Host 'Installed and started. It will also auto-start at every logon.'
Write-Host "Reaps are logged to $env:LOCALAPPDATA\wslhost-interop-reaper.log"
