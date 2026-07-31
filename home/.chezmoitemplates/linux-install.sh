{{/* Shared Linux install core, inlined via {{ includeTemplate "linux-install.sh" . }} at render
time (so each deployed run_ script stays fully self-contained) — the Linux counterpart to
winget-install.ps1. Provides the apt/dnf abstraction, the sudo guard, arch naming, the
GitHub-release installers, and the Flathub / COPR / third-party-repo helpers.

Callers set TAG before including this (it prefixes every message) and then call the helpers.
Every helper is safe to call on a machine that cannot satisfy it: it warns on stderr and
returns non-zero rather than aborting its caller, so one unavailable app never costs the rest
of the run. Nothing here calls `exit` — convergence checks belong to the caller. */ -}}
: "${TAG:=linux-install}"

BIN_DIR="$HOME/.local/bin"
VER_DIR="$BIN_DIR/.versions"   # release tag last installed per tool, so a re-apply upgrades a
                               # stale binary in place instead of skipping it (install-once).
APP_DIR="$HOME/.local/share"   # unpacked multi-file release apps (scrcpy), symlinked into BIN_DIR
mkdir -p "$BIN_DIR" "$VER_DIR"

# --- 1. Package-manager abstraction -------------------------------------------------------
# Everything speaks pkg_* instead of apt/dnf directly, so the two distro families share one code
# path and one set of markers. An unrecognised distro (Arch, Alpine, ...) sets PM="" — callers
# warn once, skip the package phases, and still install everything that needs no package
# manager, rather than failing the apply forever over packages they have no way to install.
if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
  PM=apt
elif command -v dnf >/dev/null 2>&1 && command -v rpm >/dev/null 2>&1; then
  PM=dnf
else
  PM=""
  echo "$TAG: no supported package manager (want apt or dnf); installing release binaries only" >&2
fi

pkg_installed() { # $1=package -> 0 if present. Unknown PM: claim satisfied (nothing to check).
  case "$PM" in
    apt) dpkg -s "$1" >/dev/null 2>&1 ;;
    dnf) rpm -q "$1" >/dev/null 2>&1 ;;
    *)   return 0 ;;
  esac
}

pkg_install() { # $@=packages. dnf refreshes its own metadata, so it needs no `update` step.
  case "$PM" in
    apt) sudo apt-get update -qq && sudo apt-get install -y "$@" ;;
    dnf) sudo dnf install -y "$@" ;;
    *)   return 1 ;;
  esac
}

# Left unredirected on purpose: `sudo -v` must be able to prompt in an interactive terminal.
have_sudo() { sudo -v; }

# --- 2. Arch naming ------------------------------------------------------------------------
# Per-project arch names differ: Rust target triple (eza/sd/scrcpy) vs fastfetch's -aarch64 vs
# goreleaser's arm64 (curlie). Downloading the wrong arch would tar-extract cleanly but
# Exec-format-error at first use, so an arch we lack names for leaves every var empty and
# callers skip their release installs outright. Each caller uses only the names it needs, so the
# rest read as unused to shellcheck.
# shellcheck disable=SC2034
case "$(uname -m)" in
  x86_64|amd64)  rust_arch=x86_64;  ff_arch=amd64;   go_arch=amd64;  nvim_arch=x86_64; rg_target=x86_64-unknown-linux-musl ;;
  aarch64|arm64) rust_arch=aarch64; ff_arch=aarch64; go_arch=arm64;  nvim_arch=arm64;  rg_target=aarch64-unknown-linux-gnu ;;
  *)             rust_arch="";      ff_arch="";      go_arch="";     nvim_arch="";     rg_target="" ;;
esac

# --- 3. GitHub release installers ----------------------------------------------------------
latest_tag() { # $1=owner/repo -> latest tag via the releases/latest redirect (no API/ratelimit)
  curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$1/releases/latest" \
    | sed 's#.*/tag/##; s#[[:space:]]*$##'
}
recorded_tag() { cat "$VER_DIR/$1" 2>/dev/null; } # tag last installed for $1 ("" if never)

# Expand {tag} (e.g. v1.1.0) and {ver} (the tag without a leading v) in an asset URL template.
_asset_url() { printf '%s' "$2" | sed "s#{tag}#$1#g; s#{ver}#${1#v}#g"; }

# Version-aware single-binary release install. $1=binname $2=owner/repo $3=asset-URL template.
# Resolves the latest tag and only downloads when the binary is missing or the recorded tag
# differs — so `chezmoi apply` upgrades a stale tool in place instead of skipping anything
# already on PATH. We record the tag we installed rather than parsing `--version`, which is
# unreliable per-tool (eza prints multiple lines, curlie reports curl's version).
install_release() {
  bin="$1"; repo="$2"; tmpl="$3"
  tag="$(latest_tag "$repo")"
  if [ -z "$tag" ]; then echo "$TAG: could not resolve latest tag for $repo" >&2; return 0; fi
  [ -x "$BIN_DIR/$bin" ] && [ "$(recorded_tag "$bin")" = "$tag" ] && return 0
  url="$(_asset_url "$tag" "$tmpl")"
  old="$(recorded_tag "$bin")"
  tmp="$(mktemp -d)"
  if curl -fsSL "$url" -o "$tmp/a.tgz" 2>/dev/null && tar xzf "$tmp/a.tgz" -C "$tmp" 2>/dev/null; then
    found="$(find "$tmp" -type f -name "$bin" 2>/dev/null | head -1)"
    if [ -n "$found" ]; then
      if install -m 0755 "$found" "$BIN_DIR/$bin"; then
        printf '%s' "$tag" > "$VER_DIR/$bin"
        echo "$TAG: installed $bin ${old:+$old -> }$tag"
      fi
    else
      echo "$TAG: $bin not found in archive ($url)" >&2
    fi
  else
    echo "$TAG: failed to fetch $bin ($url)" >&2
  fi
  rm -rf "$tmp"
}

# Version-aware install for a release that ships a DIRECTORY rather than one binary (scrcpy
# carries scrcpy-server and adb beside its executable, and locates the server via /proc/self/exe
# — which resolves the symlink below back into the unpacked tree, so a plain symlink is enough).
# $1=appname $2=owner/repo $3=asset-URL template $4=binary inside the archive.
install_tarball_app() {
  app="$1"; repo="$2"; tmpl="$3"; bin="$4"
  tag="$(latest_tag "$repo")"
  if [ -z "$tag" ]; then echo "$TAG: could not resolve latest tag for $repo" >&2; return 0; fi
  [ -x "$BIN_DIR/$bin" ] && [ "$(recorded_tag "$app")" = "$tag" ] && return 0
  url="$(_asset_url "$tag" "$tmpl")"
  old="$(recorded_tag "$app")"
  tmp="$(mktemp -d)"
  if curl -fsSL "$url" -o "$tmp/a.tgz" 2>/dev/null && tar xzf "$tmp/a.tgz" -C "$tmp" 2>/dev/null; then
    src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
    if [ -n "$src" ] && [ -f "$src/$bin" ]; then
      # ${app:?} guards the replace-in-place below: an empty $app would make this `rm -rf` take
      # out all of ~/.local/share rather than one unpacked app.
      rm -rf "$APP_DIR/${app:?}"
      if mkdir -p "$APP_DIR" && cp -a "$src" "$APP_DIR/$app"; then
        chmod 0755 "$APP_DIR/$app/$bin"
        ln -sf "$APP_DIR/$app/$bin" "$BIN_DIR/$bin"
        printf '%s' "$tag" > "$VER_DIR/$app"
        echo "$TAG: installed $app ${old:+$old -> }$tag"
      fi
    else
      echo "$TAG: $bin not found in archive ($url)" >&2
    fi
  else
    echo "$TAG: failed to fetch $app ($url)" >&2
  fi
  rm -rf "$tmp"
}

# --- 4. Flatpak / Flathub ------------------------------------------------------------------
# Added per-user (no sudo, no root-owned state): Fedora ships only its own filtered OCI remote,
# and every GUI app that the distro repos don't carry lives on Flathub. Installs are --user too,
# so nothing here needs elevation and a sudo-less run still converges.
FLATHUB_URL="https://dl.flathub.org/repo/flathub.flatpakrepo"
flatpak_ready() {
  command -v flatpak >/dev/null 2>&1 || return 1
  flatpak remotes --user 2>/dev/null | grep -q '^flathub' && return 0
  flatpak remote-add --user --if-not-exists flathub "$FLATHUB_URL" >/dev/null 2>&1
}
flatpak_install() { # $1=flathub application id
  if flatpak info "$1" >/dev/null 2>&1; then echo "$TAG: [skip] $1 already installed (flatpak)."; return 0; fi
  flatpak_ready || { echo "$TAG: flatpak or Flathub unavailable; skipping $1" >&2; return 1; }
  echo "$TAG: [install] $1 (flatpak) ..."
  flatpak install --user --noninteractive --or-update flathub "$1"
}

# --- 5. Third-party repositories -----------------------------------------------------------
# Each is added once; the distro's normal upgrade path keeps the package current afterwards.
copr_enable() { # $1=owner/project. Fedora only; dnf no-ops when the COPR is already enabled.
  [ "$PM" = dnf ] || return 0
  sudo dnf -y copr enable "$1"
}

rpm_repo_add() { # $1=repo name (file stem) $2=URL of a ready-made .repo definition
  [ "$PM" = dnf ] || return 0
  [ -f "/etc/yum.repos.d/$1.repo" ] && return 0
  tmp="$(mktemp)"
  if curl -fsSL "$2" -o "$tmp"; then
    sudo install -m 0644 "$tmp" "/etc/yum.repos.d/$1.repo"
    rm -f "$tmp"
  else
    echo "$TAG: failed to fetch the $1 repo definition" >&2; rm -f "$tmp"; return 1
  fi
}

# $1=repo name (file stem); the .repo body is read from stdin. For vendors that document a repo
# stanza but publish no .repo file to fetch (Google Chrome, VS Code).
rpm_repo_write() {
  [ "$PM" = dnf ] || return 0
  [ -f "/etc/yum.repos.d/$1.repo" ] && { cat >/dev/null; return 0; }
  tmp="$(mktemp)"
  cat > "$tmp"
  sudo install -m 0644 "$tmp" "/etc/yum.repos.d/$1.repo"
  rm -f "$tmp"
}

# $1=repo name (file stem) $2=signing-key URL $3=deb line, with __KEYRING__ where the keyring
# path goes. Handles both key formats without the caller caring: an ASCII-armored key is
# dearmored, an already-binary keyring is installed as-is (fetching the wrong one silently
# produces a repo apt refuses to trust).
apt_repo_add() {
  [ "$PM" = apt ] || return 0
  list="/etc/apt/sources.list.d/$1.list"
  keyring="/etc/apt/keyrings/$1.gpg"
  [ -f "$list" ] && return 0
  tmp="$(mktemp)"
  if ! curl -fsSL "$2" -o "$tmp"; then
    echo "$TAG: failed to fetch the $1 signing key" >&2; rm -f "$tmp"; return 1
  fi
  sudo mkdir -p -m 755 /etc/apt/keyrings
  if head -c 40 "$tmp" | grep -q 'BEGIN PGP PUBLIC KEY'; then
    sudo gpg --yes --dearmor -o "$keyring" "$tmp"
  else
    sudo install -m 0644 "$tmp" "$keyring"
  fi
  sudo chmod 0644 "$keyring"
  rm -f "$tmp"
  printf '%s\n' "$3" | sed "s#__KEYRING__#$keyring#" | sudo tee "$list" >/dev/null
  sudo apt-get update -qq
}
