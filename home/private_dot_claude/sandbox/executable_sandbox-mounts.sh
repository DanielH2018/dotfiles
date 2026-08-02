#!/usr/bin/env bash
# sandbox-mounts.sh — mount-assembly helpers sourced by claude-sandbox
# (lives in ~/.claude/sandbox). Sourced, not executed: define functions only,
# never run anything at load time or set shell options here.
#
# CONTRACT — deliberately different from sandbox-lib.sh and sandbox-worktree.sh,
# whose functions are pure. These are not pure and cannot be: they were
# straight-line launcher code wrapped in functions for readability, and they
# still behave that way. Each one
#
#   * appends to the launcher's DOCKER_ARGS array;
#   * reads launcher globals — SANDBOX_DIR, REPO_PATH, WORK_PATH, OP_SOCKET,
#     REPOS_ROOT, REPO_SNAPSHOT_ROOT, the NO_* / REPOS_LIVE flags, and the
#     optional CLAUDE_VAULT_DIR / CHEZMOI_SRC_DIR / WORK_LAPTOP_CONFIG_DIR /
#     VAULT_INDEX_PKG_DIR overrides;
#   * sets VAULT_INDEX_TMP and VAULT_DB_TMPDIR, which the launcher's cleanup()
#     trap removes on exit;
#   * prints progress to stdout.
#
# So sourcing this file requires the launcher's variable context — it is not a
# standalone library. tests/sandbox/claude-sandbox-mounts.test.js supplies that context
# explicitly (fixture dirs + DOCKER_ARGS=()) and drives each function directly.
#
# CALL ORDER IS LOAD-BEARING and stays in the launcher, not here: the functions
# append to one array whose order becomes the docker run argument order, and a
# nested read-only bind must follow the read-write mount it overlays.

add_host_integration_mounts() {
  # Forward the 1Password agent socket only when it actually exists. A bind mount of
  # a missing path would auto-create a junk dir on the host and leave SSH_AUTH_SOCK
  # pointing at a directory; when the socket is absent, commit signing is simply
  # unavailable (entrypoint.sh detects this and warns).
  if [[ -S "$OP_SOCKET" ]]; then
    DOCKER_ARGS+=(
      -v "$OP_SOCKET:/run/1password/agent.sock"
      -e SSH_AUTH_SOCK=/run/1password/agent.sock
    )
  fi

  # Personal keybindings so alt+v -> chat:imagePaste works in-container too (entrypoint copies it
  # into ~/.claude). Guarded so a missing file doesn't bind-mount a junk dir at the target path.
  if [[ -f "$HOME/.claude/keybindings.json" ]]; then
    DOCKER_ARGS+=(-v "$HOME/.claude/keybindings.json:/home/claudebot/.claude-defaults/keybindings.json:ro")
  fi

  # WSL image paste: share the host WSLg Wayland clipboard so alt+v in-container reads the
  # image WSLg mirrors from the Windows clipboard as image/bmp (the container's xclip shim
  # forwards the typed read to wl-paste). Gated on the socket, so it's a no-op off
  # WSLg. The socket is world-accessible (0777) and the container uid matches the host (1000), so
  # no permission setup is needed. WAYLAND_DISPLAY is the absolute socket path, which avoids having
  # to set XDG_RUNTIME_DIR (that would point other tools at a root-owned mount point).
  if [[ -S /mnt/wslg/runtime-dir/wayland-0 ]]; then
    DOCKER_ARGS+=(
      -v /mnt/wslg/runtime-dir/wayland-0:/tmp/wl-clip.sock
      -e WAYLAND_DISPLAY=/tmp/wl-clip.sock
    )
  fi
}

add_vault_mounts() {
  # --- Knowledge vault (read-only, curated subset) ---
  # Mount an allowlisted subset of the vault at its real host path so the agent
  # can consult standing/task context on demand. Nothing is auto-loaded — only a
  # pointer is added to CLAUDE.md by the entrypoint (gated on SANDBOX_VAULT_DIR).
  VAULT_INDEX_TMP=""
  VAULT_DB_TMPDIR=""
  VAULT_ALLOWLIST="$SANDBOX_DIR/vault-allowlist.txt"
  vault_eligible=false
  if [[ "$NO_VAULT" == false && -n "${CLAUDE_VAULT_DIR:-}" && -d "$CLAUDE_VAULT_DIR" && -f "$VAULT_ALLOWLIST" ]]; then
    case "$WORK_PATH/" in
      "$CLAUDE_VAULT_DIR"/*) : ;;   # sandboxing the vault itself — skip
      *) vault_eligible=true ;;
    esac
  fi

  if [[ "$vault_eligible" == true ]]; then
    vault_mounted=false
    while IFS= read -r line; do
      entry="${line%%#*}"           # strip inline comments
      read -r entry <<< "$entry"    # trim surrounding whitespace (paths have no spaces)
      [[ -z "$entry" ]] && continue
      base="$(basename "$entry")"
      [[ "$base" == "CLAUDE.md" || "$base" == "index.md" ]] && continue
      if [[ -e "$CLAUDE_VAULT_DIR/$entry" ]]; then
        DOCKER_ARGS+=(-v "$CLAUDE_VAULT_DIR/$entry:$CLAUDE_VAULT_DIR/$entry:ro")
        vault_mounted=true
      fi
    done < "$VAULT_ALLOWLIST"

    if [[ "$vault_mounted" == true ]]; then
      VAULT_INDEX_TMP="$(mktemp "${TMPDIR:-/tmp}/vault-index-XXXXXX")"
      if python3 "$SANDBOX_DIR/gen-vault-index.py" "$CLAUDE_VAULT_DIR" "$VAULT_ALLOWLIST" "$VAULT_INDEX_TMP" 2>/dev/null; then
        DOCKER_ARGS+=(-v "$VAULT_INDEX_TMP:$CLAUDE_VAULT_DIR/index.md:ro")
      fi
      DOCKER_ARGS+=(-e SANDBOX_VAULT_DIR="$CLAUDE_VAULT_DIR")
      echo "  Vault: curated read-only subset mounted at $CLAUDE_VAULT_DIR (--no-vault to disable)"

      # Semantic search over the curated subset: build a DuckDB index host-side over
      # ONLY the allowlisted pages (--paths-from enforces the boundary) and mount it
      # read-only. The container queries it offline via the baked venv (vault-search).
      # Best-effort — falls back to the markdown index above if tooling is missing.
      # vault-index's canonical home is this chezmoi checkout (home/private_dot_claude/
      # vault-tooling/vault-index), NOT the vault itself — the vault only supplies
      # --root (content to index), never the code. Override with $VAULT_INDEX_PKG_DIR.
      VAULT_INDEX_DIR="${VAULT_INDEX_PKG_DIR:-$HOME/.claude/vault-tooling/vault-index}"
      if command -v uv &>/dev/null && [[ -f "$VAULT_INDEX_DIR/pyproject.toml" ]]; then
        VAULT_DB_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/vault-db-XXXXXX")"
        if (cd "$VAULT_INDEX_DIR" && uv run --quiet vault-index build \
              --root "$CLAUDE_VAULT_DIR" --paths-from "$VAULT_ALLOWLIST" \
              --db "$VAULT_DB_TMPDIR/vault.duckdb") >/dev/null 2>&1; then
          DOCKER_ARGS+=(-v "$VAULT_DB_TMPDIR/vault.duckdb:/home/claudebot/.vault-index/vault.duckdb:ro")
          DOCKER_ARGS+=(-v "$VAULT_INDEX_DIR:/opt/vault-index/code:ro")
          DOCKER_ARGS+=(-e SANDBOX_VAULT_DB="/home/claudebot/.vault-index/vault.duckdb")
          echo "  Vault: semantic search available (run 'vault-search') over the curated subset"
        else
          rm -rf "$VAULT_DB_TMPDIR"
          VAULT_DB_TMPDIR=""
          echo "  Vault: semantic index build skipped (markdown index.md still available)" >&2
        fi
      fi
    fi
  fi
}

add_chezmoi_mount() {
  # --- chezmoi dotfiles source (read-write) when the workspace is the vault ---
  # The vault is the primary sandbox; expose the chezmoi source tree so config
  # edits happen in-session. Mounted RW at its real host path so in-container git
  # (commit/diff) resolves. NOTE: `chezmoi apply` runs on the HOST — that apply is
  # the trust boundary; edits here don't affect the host until you apply them.
  CHEZMOI_SRC="${CHEZMOI_SRC_DIR:-$HOME/.local/share/chezmoi}"
  if [[ "$NO_CHEZMOI" == false && -n "${CLAUDE_VAULT_DIR:-}" && -d "$CHEZMOI_SRC" ]]; then
    case "$REPO_PATH/" in
      "$CLAUDE_VAULT_DIR"/*)
        DOCKER_ARGS+=(-v "$CHEZMOI_SRC:$CHEZMOI_SRC")
        # The host `chezmoi apply` is the trust boundary for TARGET files, but two
        # paths in this tree run on the host without any apply-time review of their
        # contents: .chezmoiscripts/run_* (apply executes them as the user) and
        # .git/hooks (any host git command in the repo runs them, no apply needed).
        # Re-mount both :ro so a session can still edit every managed dotfile —
        # which is the point of a vault session — without being able to plant
        # host-side code execution. Nested mounts over the RW mount above.
        _cm_root="$CHEZMOI_SRC"
        if [[ -f "$CHEZMOI_SRC/.chezmoiroot" ]]; then
          _cm_root="$CHEZMOI_SRC/$(tr -d '[:space:]' < "$CHEZMOI_SRC/.chezmoiroot")"
        fi
        if [[ -d "$_cm_root/.chezmoiscripts" ]]; then
          DOCKER_ARGS+=(-v "$_cm_root/.chezmoiscripts:$_cm_root/.chezmoiscripts:ro")
        fi
        if [[ -d "$CHEZMOI_SRC/.git/hooks" ]]; then
          DOCKER_ARGS+=(-v "$CHEZMOI_SRC/.git/hooks:$CHEZMOI_SRC/.git/hooks:ro")
        fi
        # The sandbox's own definition lives here: settings.base.json (which
        # resolve-sandbox-settings.sh takes as its base, hooks block included — only host
        # DENIES are unioned on top, nothing is sanitised), the container hook set, the
        # entrypoint and the Dockerfiles. Writable, a session could rewrite the boundary
        # that the NEXT launch runs under — the same escape the :ro live-hook mounts closed
        # inside the container, reached one level back through the source tree instead.
        if [[ -d "$_cm_root/private_dot_claude/sandbox" ]]; then
          DOCKER_ARGS+=(-v "$_cm_root/private_dot_claude/sandbox:$_cm_root/private_dot_claude/sandbox:ro")
        fi
        # Point the in-container chezmoi binary at the mounted source so
        # cat/diff/managed/source-path/execute-template work. apply/add are denied
        # (settings.base.json) — their dest is the container home, not the host.
        DOCKER_ARGS+=(-e CHEZMOI_SOURCE_DIR="$CHEZMOI_SRC")
        echo "  chezmoi: source mounted READ-WRITE at $CHEZMOI_SRC (apply on host; --no-chezmoi to disable)"
        ;;
    esac
  fi
}

add_work_config_mount() {
  # --- work-laptop-config source (read-write) when the workspace is the vault ---
  # Second config repo (work-machine dotfiles, deployed via install.sh on the
  # HOST). Mounted RW at its real host path so in-container git (commit/diff)
  # resolves. NOTE: install.sh runs on the HOST — that install is the trust
  # boundary; edits here don't affect the host until you run it there.
  WORK_CONFIG_SRC="${WORK_LAPTOP_CONFIG_DIR:-$HOME/work-laptop-config}"
  if [[ "$NO_WORK_CONFIG" == false && -n "${CLAUDE_VAULT_DIR:-}" && -d "$WORK_CONFIG_SRC" ]]; then
    case "$REPO_PATH/" in
      "$CLAUDE_VAULT_DIR"/*)
        DOCKER_ARGS+=(-v "$WORK_CONFIG_SRC:$WORK_CONFIG_SRC")
        # Same reasoning as the chezmoi mount: install.sh runs on the host, and
        # .git/hooks runs on any host git command. Everything else stays writable.
        if [[ -f "$WORK_CONFIG_SRC/install.sh" ]]; then
          DOCKER_ARGS+=(-v "$WORK_CONFIG_SRC/install.sh:$WORK_CONFIG_SRC/install.sh:ro")
        fi
        if [[ -d "$WORK_CONFIG_SRC/.git/hooks" ]]; then
          DOCKER_ARGS+=(-v "$WORK_CONFIG_SRC/.git/hooks:$WORK_CONFIG_SRC/.git/hooks:ro")
        fi
        echo "  work-laptop-config: source mounted READ-WRITE at $WORK_CONFIG_SRC (install on host; --no-work-config to disable)"
        ;;
    esac
  fi
}

# Resolve the ref to snapshot: prefer origin/HEAD, else origin/{main,master},
# else local main/master, else HEAD. Prints the ref, or nothing on failure.
resolve_main_ref() {
  local repo="$1" ref c
  ref="$(git -C "$repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -n "$ref" ]] && git -C "$repo" rev-parse -q --verify "$ref^{commit}" >/dev/null 2>&1; then
    printf '%s\n' "$ref"; return 0
  fi
  for c in origin/main origin/master main master HEAD; do
    if git -C "$repo" rev-parse -q --verify "$c^{commit}" >/dev/null 2>&1; then
      printf '%s\n' "$c"; return 0
    fi
  done
  return 1
}

# Archive one repo's main ref (tracked files only) into the SHA cache. Idempotent
# (no-op when the snapshot already exists). Atomic via temp dir + rename so a
# concurrent launch never sees a half-extracted tree. Exported for xargs; runs
# under a fresh `bash -c` (no set -e), so internal failures don't abort a launch.
build_repo_snapshot() {
  local repo="$1" name="$2" ref="$3" sha="$4"
  local dest="$REPO_SNAPSHOT_ROOT/$name/$sha" tmp
  [[ -f "$dest/.ok" ]] && return 0
  mkdir -p "$REPO_SNAPSHOT_ROOT/$name" || return 0
  tmp="$(mktemp -d "$REPO_SNAPSHOT_ROOT/$name/.tmp-XXXXXX" 2>/dev/null)" || return 0
  if git -C "$repo" archive --format=tar "$ref" 2>/dev/null | tar -x -C "$tmp" 2>/dev/null; then
    : > "$tmp/.ok"
    rm -rf "$dest" 2>/dev/null || true          # clear a stale partial, if any
    mv "$tmp" "$dest" 2>/dev/null || rm -rf "$tmp"   # dest now absent -> atomic rename
  else
    rm -rf "$tmp"
  fi
  return 0
}

add_sibling_repo_mounts() {
  if [[ "$NO_REPOS" == false && -d "$REPOS_ROOT" ]]; then
    repo_mounts=()          # "name<TAB>sha" — snapshot mode
    live_mounts=()          # "name" — --repos-live
    build_specs=()          # "repo|name|ref|sha" — repos needing archival
    for repo_dir in "$REPOS_ROOT"/*/; do
      repo_dir="${repo_dir%/}"
      [[ -d "$repo_dir" ]] || continue
      r_name="$(basename "$repo_dir")"
      case "$r_name" in *-wt-*) continue ;; esac        # skip worktrees (noise)
      [[ -e "$repo_dir/.git" ]] || continue             # git repos only
      [[ "$repo_dir" == "$REPO_PATH" ]] && continue     # skip the workspace repo itself
      if [[ "$REPOS_LIVE" == true ]]; then
        live_mounts+=("$r_name")
        continue
      fi
      r_ref="$(resolve_main_ref "$repo_dir" || true)"
      [[ -n "$r_ref" ]] || continue
      r_sha="$(git -C "$repo_dir" rev-parse -q --verify "$r_ref^{commit}" 2>/dev/null || true)"
      [[ -n "$r_sha" ]] || continue
      repo_mounts+=("$r_name"$'\t'"$r_sha")
      [[ -f "$REPO_SNAPSHOT_ROOT/$r_name/$r_sha/.ok" ]] || build_specs+=("$repo_dir|$r_name|$r_ref|$r_sha")
    done

    if [[ "$REPOS_LIVE" == true ]]; then
      if [[ ${#live_mounts[@]} -gt 0 ]]; then
        for r_name in "${live_mounts[@]}"; do
          DOCKER_ARGS+=(-v "$REPOS_ROOT/$r_name:$REPOS_ROOT/$r_name:ro")
        done
        DOCKER_ARGS+=(-e SANDBOX_REPOS_DIR="$REPOS_ROOT" -e SANDBOX_REPOS_LIVE=1)
        echo "  Repos: ${#live_mounts[@]} sibling repo(s) mounted read-only at their LIVE working tree (--repos-live)"
      fi
    else
      # Archive any missing snapshots in parallel (bounded). build_repo_snapshot is
      # idempotent, so this is cheap when everything is already cached.
      if [[ ${#build_specs[@]} -gt 0 ]]; then
        echo "  Repos: snapshotting ${#build_specs[@]} repo(s) at main/master (first run or main moved)..."
        export REPO_SNAPSHOT_ROOT
        export -f build_repo_snapshot
        # shellcheck disable=SC2016  # $1 and the _-prefixed vars belong to the xargs-spawned shell
        printf '%s\0' "${build_specs[@]}" | xargs -0 -P4 -I{} bash -c \
          'IFS="|" read -r _repo _name _ref _sha <<<"$1"; build_repo_snapshot "$_repo" "$_name" "$_ref" "$_sha"' _ {} \
          2>/dev/null || true
      fi
      # Mount every snapshot that exists; prune older SHAs (keep newest 2 per repo).
      repos_mounted=0
      for spec in ${repo_mounts[@]+"${repo_mounts[@]}"}; do
        r_name="${spec%%$'\t'*}"; r_sha="${spec##*$'\t'}"
        dest="$REPO_SNAPSHOT_ROOT/$r_name/$r_sha"
        [[ -f "$dest/.ok" ]] || continue
        DOCKER_ARGS+=(-v "$dest:$REPOS_ROOT/$r_name:ro")
        repos_mounted=$((repos_mounted + 1))
        touch "$dest" 2>/dev/null || true             # keep the mounted SHA newest
        # shellcheck disable=SC2012  # newest-first ordering is the point; find has no portable mtime sort
        while IFS= read -r old; do
          [[ -n "$old" ]] && rm -rf "$old" 2>/dev/null || true
        done < <(ls -1dt "$REPO_SNAPSHOT_ROOT/$r_name"/*/ 2>/dev/null | tail -n +3)
      done
      if [[ "$repos_mounted" -gt 0 ]]; then
        DOCKER_ARGS+=(-e SANDBOX_REPOS_DIR="$REPOS_ROOT")
        echo "  Repos: $repos_mounted sibling repo(s) mounted read-only at main/master snapshot (--no-repos to disable, --repos-live for live trees)"
      fi
    fi
  fi
}

# --- Vault-self hardening: protect sensitive subpaths ---
# Sandboxing the vault mounts everything RW at /workspace, which would expose
# the exact material vault-allowlist.txt keeps out of other sandboxes. When the
# workspace IS the vault: overlay read-only binds on the sensitive set (wiki
# stays editable, but Team/incident/PII content can't be tampered with).
add_vault_self_hardening() {
  if [[ -n "${CLAUDE_VAULT_DIR:-}" ]]; then
    case "$REPO_PATH/" in
      "$CLAUDE_VAULT_DIR"/*)
        VAULT_SENSITIVE="$SANDBOX_DIR/vault-sensitive.txt"
        if [[ -f "$VAULT_SENSITIVE" ]]; then
          sensitive_ro=false
          while IFS= read -r line; do
            entry="${line%%#*}"           # strip inline comments
            read -r entry <<< "$entry"    # trim whitespace (paths have no spaces)
            [[ -z "$entry" ]] && continue
            for match in "$WORK_PATH"/$entry; do
              [[ -e "$match" ]] || continue
              DOCKER_ARGS+=(-v "$match:/workspace/${match#"$WORK_PATH"/}:ro")
              sensitive_ro=true
            done
          done < "$VAULT_SENSITIVE"
          [[ "$sensitive_ro" == true ]] && \
            echo "  Vault: sensitive subpaths mounted read-only (vault-sensitive.txt)"
        fi
        ;;
    esac
  fi
}
