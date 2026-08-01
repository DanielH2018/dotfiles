{{/* Shared Linux install core, inlined via {{ includeTemplate "linux-install.sh" . }} at render
time (so each deployed run_ script stays fully self-contained) — the Linux counterpart to
winget-install.ps1. Provides the apt/dnf abstraction, the sudo guard, arch naming, the
GitHub-release installers, and the Flathub / COPR / third-party-repo helpers.

Callers set TAG before including this (it prefixes every message) and then call the helpers.
Every helper is safe to call on a machine that cannot satisfy it: it warns on stderr and
returns non-zero rather than aborting its caller, so one unavailable app never costs the rest
of the run. Nothing here calls `exit` — convergence checks belong to the caller. */ -}}
: "${TAG:=linux-install}"

# All four are overridable purely so the helpers below can be exercised against a throwaway
# directory; nothing in normal operation sets any of them. Plain assignment here was an active
# hazard rather than a style choice: it silently overwrote an exported BIN_DIR, so a test harness
# that thought it had sandboxed itself installed straight into the real ~/.local/bin and replaced
# live binaries with its fixtures. tests/linux-install-lib.test.js fails if that form comes back.
#
# To sandbox this module, redirect HOME — all three install destinations derive from it, so there
# is no fourth one left pointing at the live machine when you forget it. The individual overrides
# are for aiming a single destination somewhere else, not for containment.
: "${BIN_DIR:=$HOME/.local/bin}"
: "${VER_DIR:=$BIN_DIR/.versions}"  # release tag last installed per tool, so a re-apply upgrades
                                    # a stale binary in place instead of skipping it (install-once).
: "${APP_DIR:=$HOME/.local/share}"  # unpacked multi-file release apps (scrcpy), symlinked into BIN_DIR
: "${REPO_DIR:=/etc/yum.repos.d}"
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

# Fedora ships some vendor repos pre-installed but DISABLED — fedora-workstation-repositories
# drops google-chrome.repo carrying enabled=0. "The file exists" is therefore NOT the same as
# "the repo works", and treating them as equivalent is a silent failure: the writers below
# short-circuit, dnf never sees the package, and the install dies with a bare "no match" that
# points nowhere near the cause. Always run this after ensuring the file is present.
# sed rather than `dnf config-manager`, whose spelling differs between dnf4 (--set-enabled) and
# dnf5 (setopt); rewriting the line works on both and is idempotent.
rpm_repo_enable() { # $1=repo name (file stem)
  [ "$PM" = dnf ] || return 0
  f="$REPO_DIR/$1.repo"
  [ -f "$f" ] || return 0
  grep -q '^enabled=0' "$f" || return 0
  # Only ever rewrite a single-stanza vendor file. Fedora's own repo files bundle several stanzas
  # and keep the source/debuginfo ones disabled on purpose — a blanket rewrite would switch those
  # on as a side effect of enabling something unrelated.
  if [ "$(grep -c '^\[' "$f")" -ne 1 ]; then
    echo "$TAG: $1.repo carries multiple stanzas; enable it by hand rather than risk the others" >&2
    return 1
  fi
  echo "$TAG: enabling the pre-installed but disabled $1 repo"
  sudo sed -i 's/^enabled=0/enabled=1/' "$f"
}

rpm_repo_add() { # $1=repo name (file stem) $2=URL of a ready-made .repo definition
  [ "$PM" = dnf ] || return 0
  if [ -f "$REPO_DIR/$1.repo" ]; then
    rpm_repo_enable "$1"
    return 0
  fi
  tmp="$(mktemp)"
  if curl -fsSL "$2" -o "$tmp"; then
    sudo install -m 0644 "$tmp" "$REPO_DIR/$1.repo"
    rm -f "$tmp"
    rpm_repo_enable "$1"
  else
    echo "$TAG: failed to fetch the $1 repo definition" >&2; rm -f "$tmp"; return 1
  fi
}

# $1=repo name (file stem); the .repo body is read from stdin. For vendors that document a repo
# stanza but publish no .repo file to fetch (Google Chrome, VS Code).
rpm_repo_write() {
  [ "$PM" = dnf ] || return 0
  if [ -f "$REPO_DIR/$1.repo" ]; then
    cat >/dev/null            # consume the here-doc the caller attached
    rpm_repo_enable "$1"      # the distro may have shipped it disabled
    return 0
  fi
  tmp="$(mktemp)"
  cat > "$tmp"
  sudo install -m 0644 "$tmp" "$REPO_DIR/$1.repo"
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

# --- 6. Zip / prefix-merge / matched-file release installers -------------------------------
# install_release/install_tarball_app above resolve $tag themselves from an owner/repo slug via
# latest_tag. These three instead take $tag already resolved, because Bitwarden tags its CLI
# release "cli-vYYYY.M.P" alongside the desktop app's own tags, so the releases/latest redirect
# lands on the desktop app rather than the CLI — that caller has to work out its own tag and
# hands it in ready-made. The other two helpers here take a pre-resolved tag purely so all three
# share one calling convention rather than forcing a callback into the module for one case.
_fetch_archive() { # $1=url $2=dest-dir -> extract $1 into $2; .zip needs unzip, else tar xzf
  case "$1" in
    *.zip)
      if ! command -v unzip >/dev/null 2>&1; then
        echo "$TAG: unzip required to extract $1 but not found on PATH" >&2
        return 1
      fi
      curl -fsSL "$1" -o "$2/a.zip" 2>/dev/null && unzip -q -o "$2/a.zip" -d "$2" 2>/dev/null
      ;;
    *)
      curl -fsSL "$1" -o "$2/a.tgz" 2>/dev/null && tar xzf "$2/a.tgz" -C "$2" 2>/dev/null
      ;;
  esac
}

_report_installed() { # $1=verkey $2=tag $3=old-tag -> records $2 under $1 and prints the upgrade line
  printf '%s' "$2" > "$VER_DIR/$1"
  echo "$TAG: installed $1 ${3:+$3 -> }$2"
}

# Version-aware zip release install, for vendors (yazi) that ship .zip instead of .tar.gz.
# $1=verkey $2=tag (already resolved) $3=asset-URL template $4...=binary names to install into
# $BIN_DIR at 0755; the first name doubles as the already-current sentinel, and the tag is only
# recorded once it has landed, so a partial extract still upgrades on the next apply.
install_release_zip() {
  verkey="$1"; tag="$2"; tmpl="$3"; shift 3
  first="$1"
  [ -x "$BIN_DIR/$first" ] && [ "$(recorded_tag "$verkey")" = "$tag" ] && return 0
  old="$(recorded_tag "$verkey")"
  url="$(_asset_url "$tag" "$tmpl")"
  tmp="$(mktemp -d)"
  status=1
  if _fetch_archive "$url" "$tmp"; then
    for bin in "$@"; do
      found="$(find "$tmp" -type f -name "$bin" 2>/dev/null | head -1)"
      if [ -n "$found" ]; then
        if install -m 0755 "$found" "$BIN_DIR/$bin"; then
          [ "$bin" = "$first" ] && status=0
        else
          echo "$TAG: failed to install $bin" >&2
        fi
      else
        echo "$TAG: $bin not found in archive ($url)" >&2
      fi
    done
    [ "$status" -eq 0 ] && _report_installed "$verkey" "$tag" "$old"
  else
    echo "$TAG: failed to fetch $verkey ($url)" >&2
  fi
  rm -rf "$tmp"
  return "$status"
}

# Version-aware install for a release whose tarball is one top-level directory holding a full
# prefix tree (Neovim: bin/nvim + share/nvim/runtime) rather than one binary or an app directory
# of its own — so, unlike install_tarball_app, the payload gets merged INTO an existing prefix
# ($4) rather than unpacked beside it, and bin/nvim can find ../share/nvim/runtime at the paths
# it expects. $1=verkey $2=tag (already resolved) $3=asset-URL template $4=prefix-dir
# $5=sentinel-bin (path under $4 that proves the merge worked, e.g. bin/nvim).
install_prefix_tarball() {
  verkey="$1"; tag="$2"; tmpl="$3"; prefix="$4"; sentinel="$5"
  [ -x "$prefix/$sentinel" ] && [ "$(recorded_tag "$verkey")" = "$tag" ] && return 0
  old="$(recorded_tag "$verkey")"
  url="$(_asset_url "$tag" "$tmpl")"
  tmp="$(mktemp -d)"
  status=1
  if _fetch_archive "$url" "$tmp"; then
    src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
    if [ -n "$src" ] && mkdir -p "$prefix" && cp -a "$src"/. "$prefix"/; then
      if [ -x "$prefix/$sentinel" ]; then
        _report_installed "$verkey" "$tag" "$old"
        status=0
      else
        echo "$TAG: $sentinel missing from $prefix after merging $verkey ($url)" >&2
      fi
    else
      echo "$TAG: $verkey archive did not contain a top-level directory ($url)" >&2
    fi
  else
    echo "$TAG: failed to fetch $verkey ($url)" >&2
  fi
  rm -rf "$tmp"
  return "$status"
}

# Version-aware install for a release where the payload is a set of loose files scattered in the
# archive (a Nerd Font's .ttf files) rather than one binary. $1=verkey $2=tag (already resolved)
# $3=asset-URL template $4=dest-dir $5=find -name pattern (e.g. '*.ttf') $6=install mode. Replaces
# dest-dir wholesale on a successful match so a font upgrade never leaves a stale variant behind;
# ${dest:?} guards that rm -rf against an empty dest-dir ever taking out more than intended.
install_release_files() {
  verkey="$1"; tag="$2"; tmpl="$3"; dest="$4"; pattern="$5"; mode="$6"
  [ -d "$dest" ] && [ "$(recorded_tag "$verkey")" = "$tag" ] && return 0
  old="$(recorded_tag "$verkey")"
  url="$(_asset_url "$tag" "$tmpl")"
  tmp="$(mktemp -d)"
  status=1
  if _fetch_archive "$url" "$tmp"; then
    list="$tmp/.matches"
    find "$tmp" -type f -name "$pattern" > "$list" 2>/dev/null
    if [ -s "$list" ]; then
      rm -rf "${dest:?}"
      mkdir -p "$dest"
      landed=0
      while IFS= read -r f; do
        install -m "$mode" "$f" "$dest/" && landed=1
      done < "$list"
      if [ "$landed" -eq 1 ]; then
        _report_installed "$verkey" "$tag" "$old"
        status=0
      else
        echo "$TAG: failed to install matched files for $verkey into $dest" >&2
      fi
    else
      echo "$TAG: no files matching '$pattern' found in $verkey archive ($url)" >&2
    fi
  else
    echo "$TAG: failed to fetch $verkey ($url)" >&2
  fi
  rm -rf "$tmp"
  return "$status"
}
