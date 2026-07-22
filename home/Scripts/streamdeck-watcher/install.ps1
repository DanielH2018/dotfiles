# install.ps1 — register the watcher to run hidden at logon. Run once per machine.
# Uninstall: Unregister-ScheduledTask -TaskName 'StreamDeck Watcher' -Confirm:$false
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'streamdeck-watcher.ps1'
$vbs    = Join-Path $here 'streamdeck-watcher-hidden.vbs'
if (-not (Test-Path $script)) { throw "Not found: $script" }
if (-not (Test-Path $vbs))    { throw "Not found: $vbs" }

# Launch through the VBS wrapper (wscript window style 0), not powershell.exe directly:
# on Win11, Task Scheduler delegates powershell.exe to Windows Terminal, which creates the
# window before -WindowStyle Hidden applies — and since the watcher never exits, that
# console window never closes. wscript starts it genuinely hidden.
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'StreamDeck Watcher' -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Limited -Force `
    -Description 'Restarts Elgato Stream Deck when the device re-appears (KVM switch / hibernate / boot).' | Out-Null

Start-ScheduledTask -TaskName 'StreamDeck Watcher'
Write-Host 'Installed and started. It will also auto-start at every logon.'
