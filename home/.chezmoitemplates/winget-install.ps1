{{/* Shared winget install core, inlined via {{ includeTemplate "winget-install.ps1" . }} at
render time (so each deployed run_onchange script stays fully self-contained). Provides the
error-handling preamble, the winget-presence guard, and Install-WingetPackage. Callers define
their own $packages list and loop, calling Install-WingetPackage for each id. */ -}}
$ErrorActionPreference = 'Stop'
# PS 7.3+ makes native non-zero exits throw under Stop; disable so a single winget
# failure (or "already installed") doesn't abort the loop. Harmless no-op on 5.1.
$PSNativeCommandUseErrorActionPreference = $false

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Warning "winget not found — install 'App Installer' from the Microsoft Store, then re-run 'chezmoi apply'."
    return
}

function Install-WingetPackage([string]$Id) {
    # `winget list` exits 0 when the package is present, non-zero otherwise.
    winget list --exact --id $Id --accept-source-agreements 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "[skip] $Id already installed."; return }
    Write-Host "[install] $Id ..."
    winget install --exact --id $Id --source winget `
        --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) { Write-Warning "winget install $Id exited $LASTEXITCODE (continuing)." }
}
