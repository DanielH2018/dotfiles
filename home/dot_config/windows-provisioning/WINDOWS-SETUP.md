# Windows PC provisioning

Bring a fresh Windows PC (or refresh this one) to the current state. chezmoi orchestrates;
winget / reg / powercfg / schtasks do the work.

## 1. Bootstrap

Elevated PowerShell on the new box:

```powershell
winget install twpayne.chezmoi
chezmoi init --apply DanielH2018/dotfiles
```

This installs the app inventory and the dev CLI toolchain, deploys configs, and imports
the ExplorerPatcher settings — all via chezmoi's `run_onchange_` scripts.

## 2. Elevated setup (run once, by hand)

chezmoi runs unelevated, so the admin-only steps are a separate script:

```powershell
pwsh -File $HOME\.config\windows-provisioning\elevated-setup.ps1
```

Sets the power scheme (AC never-sleep + 30-min hibernate — the Elgato 4K60 Pro breaks on
S3), and registers the TaskbarAutoHideFix + StreamDeck Watcher scheduled tasks.

## 3. Winaero Tweaker (one GUI import)

Winaero has no command-line import. Open Winaero Tweaker → **Tools → Import**, select
`~/.config/windows-provisioning/winaero-tweaker.ini`.

## 4. Restart File Explorer

So ExplorerPatcher fully applies. `Win+Ctrl+Shift+B` or sign out/in.

## 5. Apps winget can't install (do manually)

- **Microsoft Office** — installs via winget, but sign in / activate the license by hand
- **NVIDIA App**, **AMD chipset**, **AMD Ryzen Master** — vendor downloads
- **Samsung Magician** — vendor download if not resolved by winget
- **Elgato Game Capture** (4K60 Pro software) — Elgato download
- **Pokémon TCG Live** — standalone installer
- **Xbox Accessories** — Microsoft Store (`9NBLGGH30XJ3`)

## 6. hosts file (homelab)

Not in this public repo — internal hostnames live in the private homelab repo. Apply the
homelab hosts entries from there (`*.daniel-hunter.com` / `*.local.daniel-hunter.com` → 10.0.0.161).

## 7. Sign-ins & game libraries

- Sign in: Bitwarden, Google Drive, Spotify, Discord, Mullvad, Steam / Epic / EA / Riot
- Re-download game libraries from each launcher; re-apply Stream Deck / iCUE profiles

## 8. WireGuard homelab tunnel

One-time: create a Bitwarden **secure note** named `wireguard-daniel-pc` whose Notes field
is the complete `daniel-pc` WireGuard `.conf` (copy it from the WireGuard app → the tunnel →
Edit). Keys and homelab topology stay in Bitwarden, never in this public repo.

Then, from an **elevated** shell (`bw login` first if needed):

```powershell
pwsh -File $HOME\.config\windows-provisioning\install-wireguard.ps1
```

Pulls the note, installs the tunnel service, deletes the temp file. Re-running replaces it.
