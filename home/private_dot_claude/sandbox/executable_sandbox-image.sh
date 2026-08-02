#!/usr/bin/env bash
# sandbox-image.sh — toolchain detection and Dockerfile generation, sourced by
# claude-sandbox (lives in ~/.claude/sandbox). Sourced, not executed: define
# functions only, never run anything at load time or set shell options here.
#
# CONTRACT — the same launcher-context contract as sandbox-mounts.sh, not the pure
# one sandbox-lib.sh and sandbox-worktree.sh keep. These functions
#
#   * read the launcher globals REPO_PATH and DOCKERFILE;
#   * set NEEDS_DOCKER, which the launcher reads twice when deciding whether to
#     start the socket proxy;
#   * call validate_version(), which stays in the launcher — bash resolves that at
#     call time, and generate_dockerfile only runs long after the launcher has
#     defined it;
#   * print the detected-toolchain summary to stdout.
#
# Everything here reads REPO_PATH as UNTRUSTED input: it is the repo being
# sandboxed, and the versions parsed out of .sdkmanrc, .terraform-version and
# friends are interpolated into a Dockerfile that then runs as a build. That is why
# java/node/rust/go versions go through validate_version() and the Terraform version
# is hard-matched against a semver pattern before it can reach a download URL. Keep
# any new toolchain on the same footing.
#
# NEEDS_DOCKER is set here and read only in the launcher, which the linter cannot see
# from this side of the source boundary — the mirror of the disable the launcher
# carries for the flags it sets and the libs read. File-wide, so it is not scoped to
# that one name.
# shellcheck disable=SC2034

detect_docker_need() {
  # Check for docker-compose files (depth 2 catches monorepo layouts)
  local compose_files
  compose_files=$(find "$REPO_PATH" -maxdepth 2 \( -name "docker-compose*.yml" -o -name "docker-compose*.yaml" -o -name "compose*.yml" -o -name "compose*.yaml" \) 2>/dev/null | head -1)
  if [[ -n "$compose_files" ]]; then
    NEEDS_DOCKER=true
  fi
  # Also check Makefile for docker compose references
  if [[ -f "$REPO_PATH/Makefile" ]] && grep -q 'docker compose\|docker-compose' "$REPO_PATH/Makefile" 2>/dev/null; then
    NEEDS_DOCKER=true
  fi
}

detect_uv_need() {
  # Check for uv.lock, or uv references in CLAUDE.md / Makefile / pyproject.toml
  if [[ -f "$REPO_PATH/uv.lock" ]]; then
    return 0
  fi
  if [[ -f "$REPO_PATH/CLAUDE.md" ]] && grep -q '\buv \|uv run\|uv sync\|uv pip\|uv add' "$REPO_PATH/CLAUDE.md" 2>/dev/null; then
    return 0
  fi
  if [[ -f "$REPO_PATH/Makefile" ]] && grep -q '\buv \|uv run\|uv sync\|uv pip' "$REPO_PATH/Makefile" 2>/dev/null; then
    return 0
  fi
  return 1
}

# --- Detect toolchains and generate Dockerfile ---
generate_dockerfile() {
  local layers=""

  # Java / Kotlin via sdkman
  if [[ -f "$REPO_PATH/.sdkmanrc" ]]; then
    local java_version
    java_version=$(grep -E '^java=' "$REPO_PATH/.sdkmanrc" | cut -d= -f2 | tr -d '[:space:]')
    [[ -n "$java_version" ]] && validate_version "java" "$java_version"
    if [[ -n "$java_version" ]]; then
      layers+="
# --- Java via sdkman (.sdkmanrc) ---
USER root
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    apt-get update && apt-get install -y --no-install-recommends zip unzip findutils
USER claudebot
ENV SDKMAN_DIR=/home/claudebot/.sdkman
RUN curl -s \"https://get.sdkman.io\" | bash
RUN bash -c \"source \$SDKMAN_DIR/bin/sdkman-init.sh && sdk install java $java_version && sdk flush tmp\"
ENV JAVA_HOME=/home/claudebot/.sdkman/candidates/java/current
ENV PATH=\"\$JAVA_HOME/bin:\$PATH\"
"
    fi
  fi

  # Node via fnm
  local node_version=""
  if [[ -f "$REPO_PATH/.nvmrc" ]]; then
    node_version=$(cat "$REPO_PATH/.nvmrc" | tr -d '[:space:]' | sed 's/^v//')
  elif [[ -f "$REPO_PATH/.node-version" ]]; then
    node_version=$(cat "$REPO_PATH/.node-version" | tr -d '[:space:]' | sed 's/^v//')
  elif [[ -f "$REPO_PATH/package.json" ]]; then
    # No version file — base image already has Node 22 (current LTS).
    # Skip fnm to avoid a ~200MB duplicate install. If the repo needs
    # a specific version, add an .nvmrc or .node-version file.
    :
  fi
  if [[ -n "$node_version" ]]; then
    validate_version "node" "$node_version"
    layers+="
# --- Node via fnm ---
ENV FNM_DIR=/home/claudebot/.fnm
RUN curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir \"\$FNM_DIR\" --skip-shell
ENV PATH=\"/home/claudebot/.fnm:\$PATH\"
RUN eval \"\$(fnm env)\" && fnm install $node_version && fnm default $node_version
ENV PATH=\"/home/claudebot/.fnm/aliases/default/bin:\$PATH\"
"
  fi

  # Rust via rustup
  if [[ -f "$REPO_PATH/Cargo.toml" ]]; then
    layers+="
# --- Rust via rustup ---
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH=\"/home/claudebot/.cargo/bin:\$PATH\"
"
  fi

  # Go
  if [[ -f "$REPO_PATH/go.mod" ]]; then
    local go_version
    go_version=$(grep -E '^go ' "$REPO_PATH/go.mod" | awk '{print $2}' | head -1)
    [[ -z "$go_version" ]] && go_version="1.22.4"
    # Go downloads require three-part versions (1.22.0, not 1.22)
    if [[ "$go_version" =~ ^[0-9]+\.[0-9]+$ ]]; then
      go_version="${go_version}.0"
    fi
    validate_version "go" "$go_version"
    layers+="
# --- Go ---
USER root
RUN ARCH=\$(dpkg --print-architecture) && \\
    curl -fsSL \"https://go.dev/dl/go${go_version}.linux-\${ARCH}.tar.gz\" | tar -C /usr/local -xz
USER claudebot
ENV PATH=\"/usr/local/go/bin:/home/claudebot/go/bin:\$PATH\"
"
  fi

  # Python
  if [[ -f "$REPO_PATH/pyproject.toml" || -f "$REPO_PATH/requirements.txt" ]]; then
    local python_build_deps="python3 python3-pip python3-venv python-is-python3"
    # C extension build deps — always included since most non-trivial
    # dependency trees include at least one compiled extension
    local extra_deps="gcc python3-dev libpq-dev libffi-dev"

    local uv_layer=""
    if detect_uv_need; then
      uv_layer="
# uv package manager
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH=\"/home/claudebot/.local/bin:\$PATH\"
"
    fi

    layers+="
# --- Python ---
USER root
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    apt-get update && apt-get install -y --no-install-recommends $python_build_deps $extra_deps
USER claudebot
$uv_layer"
  fi

  # Terraform (detect .tf files or .terraform-version). Pinned to match the
  # host tfenv default (1.5.7 — last MPL/pre-BUSL release); a repo can override
  # via .terraform-version. Downloaded + SHA256-verified against the published
  # sums. Read-only/plan work only: the destructive-terraform deny in
  # block-dangerous-bash.sh (RO-mounted, registered PreToolUse) still blocks
  # apply/destroy/import/state-mutation in-container.
  if [[ -f "$REPO_PATH/.terraform-version" ]] || find "$REPO_PATH" -maxdepth 8 -name '*.tf' -print -quit 2>/dev/null | grep -q .; then
    local tf_version="1.5.7"
    if [[ -f "$REPO_PATH/.terraform-version" ]]; then
      tf_version=$(tr -d '[:space:]' < "$REPO_PATH/.terraform-version")
    fi
    # Untrusted repo input flows into a build URL + shell — hard-require semver.
    [[ "$tf_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || tf_version="1.5.7"
    layers+="
# --- Terraform ---
USER root
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    apt-get update && apt-get install -y --no-install-recommends unzip
RUN cd /tmp \\
    && ARCH=\$(dpkg --print-architecture) \\
    && curl -fsSLO \"https://releases.hashicorp.com/terraform/${tf_version}/terraform_${tf_version}_linux_\${ARCH}.zip\" \\
    && curl -fsSL \"https://releases.hashicorp.com/terraform/${tf_version}/terraform_${tf_version}_SHA256SUMS\" -o SHA256SUMS \\
    && grep -F \"terraform_${tf_version}_linux_\${ARCH}.zip\" SHA256SUMS | sha256sum -c - \\
    && unzip -o \"terraform_${tf_version}_linux_\${ARCH}.zip\" -d /usr/local/bin terraform \\
    && chmod 755 /usr/local/bin/terraform \\
    && rm -f \"terraform_${tf_version}_linux_\${ARCH}.zip\" SHA256SUMS \\
    && terraform version
USER claudebot
"
  fi

  # Write Dockerfile
  cat > "$DOCKERFILE" <<DOCKEREOF
# syntax=docker/dockerfile:1
FROM claudebot:base
$layers
WORKDIR /workspace
DOCKEREOF

  echo "Generated $DOCKERFILE"
  if [[ -n "$layers" ]]; then
    echo "Detected toolchains:"
    grep '# ---' "$DOCKERFILE" | sed 's/# --- //;s/ ---.*//' | sed 's/^/  - /'
    if grep -q 'uv/install' "$DOCKERFILE"; then
      echo "  - uv (Python package manager)"
    fi
  else
    echo "  No toolchains detected (lightweight image)"
  fi
}
