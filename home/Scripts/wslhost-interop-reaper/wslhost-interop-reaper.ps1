# wslhost-interop-reaper.ps1
# Kills wslhost.exe processes that have leaked spinning interop threads.
#
# The bug (microsoft/WSL#41173 — open, and present in every release through 2.9.4):
# ProcessInteropMessages in src/windows/common/interop.cpp re-issues its ReadFile
# forever when the read completes *synchronously* with zero bytes. All three loop
# exits sit inside `if (!Success)`, and a gracefully-closed hvsocket returns success
# with BytesRead == 0 — so the thread spins at a full core inside NtReadFile until
# its process dies. The asynchronous branch checks BytesRead == 0 correctly; the
# synchronous one never checks it at all. There is no fix to upgrade to.
#
# Each leak is one thread named "Interop" burning 1.00 core, and they accumulate:
# this machine reached 15 of them (~12 cores, 96% host CPU) after 2.5 hours of
# agent-driven interop traffic. Closing terminals does nothing, because the leaks
# land in the *VM-mode* host — the one launched with --vm-id but no --distro-id,
# which services Windows-binary launches from Linux processes whose owning wsl.exe
# has already exited. It registers no distro session, so it dies only with the VM.
#
# Killing that host is the only remedy with evidence behind it, and it is safe:
# verified 2026-07-25 that the WSL VM, its running containers, and interop itself
# all survived the kill, and that no elevation is required. WSL respawns the host
# on the next background interop request.
#
# Cost of a reap: Windows children previously launched through *background* interop
# lose their control channel. Foreground interop (a Windows binary run from a live
# shell) goes through the per-distro host and is untouched.

[CmdletBinding()]
param(
    # Seconds between sweeps. The leak is wasted CPU, not damage, so a slow poll is fine.
    [int]$PollSeconds = 300,

    # CPU sampling window. A leaked thread holds a full core indefinitely, so a few
    # seconds is enough to separate it from a thread doing real, bursty work.
    [int]$SampleSeconds = 5,

    # Cores a single thread must hold for the whole window to count as spinning.
    # A healthy interop thread blocks in ReadFile at ~0.00; a leaked one sits at 1.00.
    [double]$SpinCoreFloor = 0.5,

    # Leaked threads tolerated before reaping. Above 1 so a genuinely busy moment is
    # never mistaken for a leak; low enough that wasted CPU stays bounded.
    [int]$LeakThreshold = 3,

    # Report what would be killed without killing it.
    [switch]$DryRun,

    # Single sweep then exit, instead of looping. For testing and for driving this
    # from a periodic trigger rather than the default persistent task.
    [switch]$Once
)

$ErrorActionPreference = 'SilentlyContinue'
$logPath = Join-Path $env:LOCALAPPDATA 'wslhost-interop-reaper.log'

function Write-Log {
    param([string]$Message)
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Output $line
    # Keep the log from growing without bound. Every sweep records a line, so at the default
    # poll that is ~288/day and the 1MB cap is reached in weeks, not years; keep enough tail
    # to still cover the run-up to whatever prompted the reading.
    if ((Test-Path $logPath) -and ((Get-Item $logPath).Length -gt 1MB)) {
        Set-Content -Path $logPath -Value (Get-Content $logPath -Tail 2000)
    }
    Add-Content -Path $logPath -Value $line
}

function Get-WslHost {
    Get-CimInstance Win32_Process -Filter "Name = 'wslhost.exe'"
}

function Get-VmModeHost {
    param($Hosts)
    # The VM-mode host is the leak target: --vm-id present, --distro-id absent.
    # The per-distro host (--distro-id) belongs to a live wsl.exe and must be left alone.
    $Hosts | Where-Object { $_.CommandLine -match '--vm-id' -and $_.CommandLine -notmatch '--distro-id' }
}

function Measure-SpinningThread {
    param([int]$ProcessId)
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { return $null }

    $before = @{}
    foreach ($t in $p.Threads) { $before[$t.Id] = $t.TotalProcessorTime.TotalSeconds }

    Start-Sleep -Seconds $SampleSeconds

    $p.Refresh()
    if ($p.HasExited) { return $null }

    $spinning = 0
    foreach ($t in $p.Threads) {
        # Threads created inside the window have no baseline, so they cannot be
        # judged yet — a leaked one will still be here on the next sweep.
        if (-not $before.ContainsKey($t.Id)) { continue }
        $cores = ($t.TotalProcessorTime.TotalSeconds - $before[$t.Id]) / $SampleSeconds
        if ($cores -ge $SpinCoreFloor) { $spinning++ }
    }
    return $spinning
}

function Invoke-Sweep {
    $all = @(Get-WslHost)
    $hosts = @(Get-VmModeHost -Hosts $all)

    if ($hosts.Count -eq 0) {
        # Separate "nothing to reap" from "the filter cannot see anything". Win32_Process
        # reports CommandLine as $null for a process the caller lacks rights to inspect, and
        # the filter then matches nothing however hard the host is spinning -- a silent no-op
        # that reads exactly like a healthy idle sweep unless both counts are on the record.
        # Observed 2026-07-26: the task swept for ~2h while a host climbed to 9 leaked
        # threads, logging nothing, because only reaps were ever written down.
        $blind = @($all | Where-Object { -not $_.CommandLine }).Count
        $note = "sweep: 0 VM-mode hosts of $($all.Count) wslhost"
        if ($blind) { $note += "; $blind with unreadable CommandLine (insufficient rights?)" }
        Write-Log $note
        return
    }

    foreach ($h in $hosts) {
        $spinning = Measure-SpinningThread -ProcessId $h.ProcessId
        if ($null -eq $spinning) {
            Write-Log "sweep: wslhost pid=$($h.ProcessId) exited or unreadable during sampling"
            continue
        }

        if ($spinning -ge $LeakThreshold) {
            $verb = if ($DryRun) { 'would reap' } else { 'reaping' }
            Write-Log "$verb wslhost pid=$($h.ProcessId): $spinning threads spinning (threshold $LeakThreshold)"
            if (-not $DryRun) {
                Stop-Process -Id $h.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
        else {
            Write-Log "sweep: wslhost pid=$($h.ProcessId) ok, $spinning threads spinning (threshold $LeakThreshold)"
        }
    }
}

# Single-instance guard: two reapers would double-sample and could race on the same
# kill. Only the first instance runs. Matches the streamdeck-watcher pattern. Sits below
# Write-Log so the refusal can be recorded: a blocked instance is otherwise silent, and a
# hand-run -Once that quietly does nothing looks exactly like a sweep that found nothing
# (which cost an hour of misattribution on 2026-07-26 -- the scheduled task had made the
# kill, while the manual run it was credited to had returned here without sweeping).
$singleton = New-Object System.Threading.Mutex($false, 'Local\WslhostInteropReaperSingleton')
if (-not $singleton.WaitOne(0)) {
    Write-Log 'sweep skipped: another reaper instance holds the singleton'
    return
}

if ($Once) {
    Invoke-Sweep
    return
}

while ($true) {
    Invoke-Sweep
    Start-Sleep -Seconds $PollSeconds
}
