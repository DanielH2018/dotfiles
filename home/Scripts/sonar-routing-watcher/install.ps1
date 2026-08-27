# install.ps1 - register the Sonar routing watcher to run hidden at logon. Run once per machine.
# Uninstall:  Unregister-ScheduledTask -TaskName 'Sonar Routing Watcher' -Confirm:$false
# Pause:      Disable-ScheduledTask -TaskName 'Sonar Routing Watcher'
# Resume:     Enable-ScheduledTask -TaskName 'Sonar Routing Watcher'
#
# Run this as a file rather than pasting its Register-ScheduledTask call into a
# one-liner. Through a bash-hosted prompt, `$env:USERNAME` is expanded by the shell
# before PowerShell ever sees it, and the trigger registers with an empty UserId:
#   Register-ScheduledTask : No mapping between account names and security IDs was done.
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'sonar-routing-watcher.ps1'
$vbs    = Join-Path $here 'sonar-routing-watcher-hidden.vbs'
if (-not (Test-Path $script)) { throw "Not found: $script" }
if (-not (Test-Path $vbs))    { throw "Not found: $vbs" }

# Same VBS-wrapper reasoning as streamdeck-watcher: Task Scheduler delegates
# powershell.exe to Windows Terminal on Win11, which creates the window before
# -WindowStyle Hidden applies - and the watcher never exits, so that console would
# never close. wscript starts it genuinely hidden.
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

# RunLevel Limited: Sonar's HTTP API is bound to the user session and needs no
# elevation. Elevating would also put the watcher in a different session from GG,
# and the port in coreProps.json is only valid in GG's own session.
Register-ScheduledTask -TaskName 'Sonar Routing Watcher' -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Limited -Force `
    -Description 'Repoints SteelSeries Sonar playback channels back to the Arctis stereo Game endpoint after the KVM/USB re-enumerates and Sonar falls back to the mono Chat endpoint.' | Out-Null

# Starting it here is safe even if a watcher is already running: the script takes a
# named mutex and a second instance returns immediately.
Start-ScheduledTask -TaskName 'Sonar Routing Watcher'
Write-Host 'Installed and started. It will also auto-start at every logon.'
Write-Host "Repairs are logged to $env:LOCALAPPDATA\sonar-routing-watcher.log"
