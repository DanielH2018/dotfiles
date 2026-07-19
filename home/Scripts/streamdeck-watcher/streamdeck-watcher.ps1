# streamdeck-watcher.ps1
# Restarts the Elgato Stream Deck app whenever the device (re)appears on USB.
# Elgato's software will not reconnect on its own after the device drops and comes
# back, so any of these leave it stuck on the Elgato logo with no buttons:
#   - boot (USB chain enumerates after the app launched)
#   - resume from hibernate (USB fully powers down in S4)
#   - KVM switch back (pass-through USB detaches from the inactive host)
#   - monitor USB hub dropping power when the panel sleeps
# All four end in the same event: the Stream Deck arriving on USB. We watch for that
# transition (absent -> present) and restart the app, which is the automatic
# equivalent of unplugging and replugging it.

$ErrorActionPreference = 'SilentlyContinue'
$vid = 'VID_0FD9'          # Elgato vendor ID (matches every Stream Deck model)
$debounceSeconds = 5

# Single-instance guard: a KVM switch / hibernate can leave a stale watcher behind, and
# two watchers would each restart the Deck (double pop-ups). Only the first instance runs.
$singleton = New-Object System.Threading.Mutex($false, 'Local\StreamDeckWatcherSingleton')
if (-not $singleton.WaitOne(0)) { return }

function Get-StreamDeckExe {
    $paths = @(
        (Join-Path $env:ProgramFiles 'Elgato\StreamDeck\StreamDeck.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Elgato\StreamDeck\StreamDeck.exe')
    )
    $hit = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $hit) {
        $hit = (Get-Process StreamDeck -ErrorAction SilentlyContinue | Select-Object -First 1).Path
    }
    return $hit
}

function Test-StreamDeckPresent {
    [bool](Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like "*$vid*" })
}

function Restart-StreamDeck {
    Get-Process StreamDeck -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    $exe = Get-StreamDeckExe
    # --runinbk is Elgato's own background-launch flag (used by its login Run entry):
    # starts the app straight to the system tray with no window. No minimizing needed.
    if ($exe) { Start-Process $exe -ArgumentList '--runinbk' }
}

# React to every USB device change, but only act on an absent -> present transition
# for the Stream Deck. This ignores unrelated USB plugs and device removals, so the
# app is never restarted needlessly.
Register-CimIndicationEvent -Query 'SELECT * FROM Win32_DeviceChangeEvent' -SourceIdentifier SD_Change | Out-Null

$present = Test-StreamDeckPresent
if ($present) { Restart-StreamDeck }   # initial pass: covers a boot where the device enumerated before logon
$last = (Get-Date).AddSeconds(-$debounceSeconds)

while ($true) {
    Wait-Event -SourceIdentifier SD_Change | Out-Null
    Start-Sleep -Milliseconds 1500                          # let the composite device finish enumerating
    Get-Event -SourceIdentifier SD_Change | Remove-Event    # collapse the burst of interface events
    $now = Test-StreamDeckPresent
    if ($now -and -not $present -and ((Get-Date) - $last).TotalSeconds -ge $debounceSeconds) {
        Restart-StreamDeck
        $last = Get-Date
    }
    $present = $now
}
