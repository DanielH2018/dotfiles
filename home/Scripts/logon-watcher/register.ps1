# register.ps1 - shared installer for the long-running logon watchers under Scripts/.
# Each watcher's own install.ps1 calls this with its task name, script and description;
# the watcher then runs hidden at every logon and is started once now.
#
# Launched through run-hidden.vbs (wscript window style 0), not powershell.exe directly:
# on Win11, Task Scheduler delegates powershell.exe to Windows Terminal, which creates the
# window before -WindowStyle Hidden applies - and since a watcher never exits, that console
# window would never close. wscript starts it genuinely hidden.
#
# The trigger names the account as DOMAIN\user. The bare `-User $env:USERNAME` form left
# the trigger with an empty UserId when the installer ran from a bash-hosted prompt
# (dac9b5ec):
#   Register-ScheduledTask : No mapping between account names and security IDs was done.
# The WSL interop reaper's installer always runs that way, from its run_onchange script.
#
# RunLevel Limited for every watcher: none needs elevation, and an elevated task would run
# outside the user session the watched app lives in.
param(
    [Parameter(Mandatory)] [string] $TaskName,
    [Parameter(Mandatory)] [string] $Script,
    [Parameter(Mandatory)] [string] $Description,
    [string] $LogPath
)

$vbs = Join-Path $PSScriptRoot 'run-hidden.vbs'
if (-not (Test-Path $Script)) { throw "Not found: $Script" }
if (-not (Test-Path $vbs))    { throw "Not found: $vbs" }

$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`" `"$Script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Limited -Force -Description $Description | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started '$TaskName'. It will also auto-start at every logon."
if ($LogPath) { Write-Host "It logs to $LogPath" }
