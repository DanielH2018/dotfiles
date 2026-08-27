# sonar-routing-watcher.ps1
# Keeps SteelSeries Sonar's playback channels pointed at the Arctis stereo Game
# endpoint. Sonar silently reassigns them to the mono Chat endpoint whenever the
# headset's USB base station re-enumerates.
#
# The Arctis Pro Wireless base exposes two render endpoints: "... Game" (stereo)
# and "... Chat" (mono). A KVM switch detaches the base from this host; on switching
# back, the two endpoints re-enumerate in a non-deterministic order. When Chat wins
# that race, Sonar repoints every channel at it and all playback lands in the mono
# chat mix, inaudible unless the headset's ChatMix dial is turned fully to chat.
# The symptom is "audio stopped working entirely". Same root cause class as
# streamdeck-watcher: a device that drops on the KVM and whose owning app does not
# recover on its own.
#
# The repair is idempotent. Each pass reads the routing and writes only the channels
# that are wrong; a pass that finds nothing wrong writes nothing and logs nothing.
#
# Disable:   Disable-ScheduledTask -TaskName 'Sonar Routing Watcher'
# Re-enable: Enable-ScheduledTask -TaskName 'Sonar Routing Watcher'
# Log:       $env:LOCALAPPDATA\sonar-routing-watcher.log

$ErrorActionPreference = 'SilentlyContinue'

# --- configuration -----------------------------------------------------------

# Substring of the target endpoint's friendlyName. Deliberately excludes the "2-"
# prefix, which is a Windows enumeration index that changes when the base station
# lands on a different USB port.
$TargetNameMatch = 'Arctis Pro Wireless Game'

# Channels to pin. 'chat' is included because leaving it on the Chat endpoint is
# what makes Discord vanish when the ChatMix dial sits toward game. The cost is that
# the dial no longer separates game from chat. Remove 'chat' from this list to get
# ChatMix back, and accept that chat audio depends on the dial position again.
$Channels = @('game', 'media', 'aux', 'chat')

$IdlePollSeconds   = 20   # safety-net pass, independent of any device event
$SettleSeconds     = 3    # let a USB burst finish enumerating before reading
$PostArrivalPasses = 5    # Sonar can re-mangle the routing just after we fix it
$PostArrivalGap    = 3

$LogPath       = Join-Path $env:LOCALAPPDATA 'sonar-routing-watcher.log'
$CorePropsPath = Join-Path $env:ProgramData 'SteelSeries\GG\coreProps.json'

# --- single-instance guard ---------------------------------------------------
# A KVM switch or a hibernate can leave a stale watcher behind, and two watchers
# would fight over the same PUTs.
$singleton = New-Object System.Threading.Mutex($false, 'Local\SonarRoutingWatcherSingleton')
if (-not $singleton.WaitOne(0)) { return }

# --- helpers -----------------------------------------------------------------

function Write-Log([string]$Message) {
    "{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $Message | Add-Content -Path $LogPath
}

# Windows PowerShell 5.1's Invoke-RestMethod cannot complete the TLS handshake with
# the GG server even with a permissive certificate callback. System32's curl.exe
# handles it, and ships with every Windows 10+ install.
$Curl = Join-Path $env:SystemRoot 'System32\curl.exe'

function Invoke-Api([string]$Url, [string]$Method = 'GET') {
    $raw = & $Curl -sk --max-time 8 -X $Method $Url 2>$null
    if (-not $raw) { return $null }
    try { return $raw | ConvertFrom-Json } catch { return $null }
}

# The Sonar port is assigned at launch and changes across GG restarts and updates,
# so it is resolved through the full chain rather than hardcoded: coreProps.json
# gives the GG port, and GG's /subApps gives Sonar's.
function Resolve-SonarBase {
    if (-not (Test-Path $CorePropsPath)) { return $null }
    $core = Get-Content $CorePropsPath -Raw | ConvertFrom-Json
    if (-not $core.ggEncryptedAddress) { return $null }
    $subApps = Invoke-Api "https://$($core.ggEncryptedAddress)/subApps"
    $addr = $subApps.subApps.sonar.metadata.webServerAddress
    if ($addr) { return $addr.TrimEnd('/') }
    return $null
}

function Repair-Routing([string]$Base) {
    # Streamer mode uses a different redirection model; leave it alone entirely.
    $mode = Invoke-Api "$Base/mode"
    if ($mode -ne 'classic') { return $false }

    $devices = Invoke-Api "$Base/audioDevices"
    if (-not $devices) { return $false }

    $target = $devices | Where-Object {
        $_.dataFlow -eq 'render' -and $_.state -eq 'active' -and
        -not $_.isVad -and $_.channels -ge 2 -and $_.friendlyName -like "*$TargetNameMatch*"
    } | Select-Object -First 1

    # Headset powered off or base detached: no correct target exists, so repointing
    # now would pin the channels to whatever else happens to be plugged in.
    if (-not $target) { return $false }

    $current = Invoke-Api "$Base/classicRedirections"
    if (-not $current) { return $false }

    $encodedId = [uri]::EscapeDataString($target.id)
    $changed = @()

    foreach ($ch in $Channels) {
        $now = $current | Where-Object { $_.id -eq $ch } | Select-Object -First 1
        if (-not $now -or $now.deviceId -eq $target.id) { continue }

        $wasName = ($devices | Where-Object { $_.id -eq $now.deviceId } |
                    Select-Object -First 1).friendlyName
        if (-not $wasName) { $wasName = $now.deviceId }

        $result = Invoke-Api "$Base/classicRedirections/$ch/deviceId/$encodedId" 'PUT'
        if ($result.deviceId -eq $target.id) { $changed += "$ch (was: $wasName)" }
        else { Write-Log "FAILED to repoint $ch" }
    }

    if ($changed.Count) {
        Write-Log ("Repointed to '{0}': {1}" -f $target.friendlyName, ($changed -join '; '))
        return $true
    }
    return $false
}

function Invoke-Pass([ref]$BaseRef) {
    if (-not $BaseRef.Value) { $BaseRef.Value = Resolve-SonarBase }
    if (-not $BaseRef.Value) { return $false }
    $ok = Repair-Routing $BaseRef.Value
    # A dead base usually means GG restarted onto a new port; drop the cache so the
    # next pass re-resolves it.
    if (-not (Invoke-Api "$($BaseRef.Value)/mode")) { $BaseRef.Value = $null }
    return $ok
}

# A device arrival is the moment Sonar is most likely to mangle the routing, and it
# can mangle it again a beat after we repair it. Sweep a few times before settling
# back to the idle poll.
function Invoke-Burst([ref]$BaseRef) {
    Start-Sleep -Seconds $SettleSeconds
    for ($i = 0; $i -lt $PostArrivalPasses; $i++) {
        Invoke-Pass $BaseRef | Out-Null
        Start-Sleep -Seconds $PostArrivalGap
    }
}

# --- main loop ---------------------------------------------------------------

$base = $null
Write-Log 'Watcher started.'
Invoke-Pass ([ref]$base) | Out-Null   # initial pass: covers a logon after the damage was already done

Register-CimIndicationEvent -Query 'SELECT * FROM Win32_DeviceChangeEvent' `
    -SourceIdentifier Sonar_Change | Out-Null

while ($true) {
    # Waking on either the device event or the timeout keeps this correct whichever
    # way the routing breaks: the event catches the KVM return quickly, and the
    # timeout covers any cause that raises no device event at all.
    $evt = Wait-Event -SourceIdentifier Sonar_Change -Timeout $IdlePollSeconds
    if ($evt) {
        Get-Event -SourceIdentifier Sonar_Change | Remove-Event   # collapse the burst
        Invoke-Burst ([ref]$base)
    } else {
        Invoke-Pass ([ref]$base) | Out-Null
    }
}
