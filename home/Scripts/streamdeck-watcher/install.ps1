# install.ps1 - register the watcher to run hidden at logon. Run once per machine.
# Uninstall: Unregister-ScheduledTask -TaskName 'StreamDeck Watcher' -Confirm:$false
# The registration itself is shared with the other logon watchers: ..\logon-watcher\register.ps1.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $here '..\logon-watcher\register.ps1') `
    -TaskName 'StreamDeck Watcher' `
    -Script (Join-Path $here 'streamdeck-watcher.ps1') `
    -Description 'Restarts Elgato Stream Deck when the device re-appears (KVM switch / hibernate / boot).'
