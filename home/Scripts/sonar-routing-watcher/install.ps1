# install.ps1 - register the Sonar routing watcher to run hidden at logon. Run once per machine.
# Uninstall:  Unregister-ScheduledTask -TaskName 'Sonar Routing Watcher' -Confirm:$false
# Pause:      Disable-ScheduledTask -TaskName 'Sonar Routing Watcher'
# Resume:     Enable-ScheduledTask -TaskName 'Sonar Routing Watcher'
# The registration itself is shared with the other logon watchers: ..\logon-watcher\register.ps1.
#
# Limited (not elevated) matters here in particular: Sonar's HTTP API is bound to the user
# session, and the port in coreProps.json is only valid in GG's own session.
#
# Starting it on install is safe even if a watcher is already running: the script takes a
# named mutex and a second instance returns immediately.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $here '..\logon-watcher\register.ps1') `
    -TaskName 'Sonar Routing Watcher' `
    -Script (Join-Path $here 'sonar-routing-watcher.ps1') `
    -Description 'Repoints SteelSeries Sonar playback channels back to the Arctis stereo Game endpoint after the KVM/USB re-enumerates and Sonar falls back to the mono Chat endpoint.' `
    -LogPath (Join-Path $env:LOCALAPPDATA 'sonar-routing-watcher.log')
