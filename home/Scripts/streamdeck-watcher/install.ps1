# install.ps1 — register the watcher to run hidden at logon. Run once per machine.
# Uninstall: Unregister-ScheduledTask -TaskName 'StreamDeck Watcher' -Confirm:$false
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'streamdeck-watcher.ps1'
if (-not (Test-Path $script)) { throw "Not found: $script" }

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'StreamDeck Watcher' -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Limited -Force `
    -Description 'Restarts Elgato Stream Deck when the device re-appears (KVM switch / hibernate / boot).' | Out-Null

Start-ScheduledTask -TaskName 'StreamDeck Watcher'
Write-Host 'Installed and started. It will also auto-start at every logon.'
