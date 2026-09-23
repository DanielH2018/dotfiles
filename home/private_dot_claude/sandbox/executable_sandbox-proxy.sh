#!/usr/bin/env bash
# sandbox-proxy.sh — docker socket proxy and create-filter lifecycle, sourced by
# claude-sandbox (lives in ~/.claude/sandbox). Sourced, not executed: define
# functions only, never run anything at load time or set shell options here.
#
# CONTRACT — launcher-context, like sandbox-mounts.sh and sandbox-image.sh, with one
# addition worth stating on its own. These functions
#
#   * read the launcher globals PROXY_NAME, PROXY_ALIAS, FILTER_NAME, FILTER_ALIAS,
#     NETWORK_NAME, PROXY_NETWORK_NAME, PROXY_IMAGE, ENGINE_ARGS, CANON_LIB,
#     SANDBOX_DIR and WORK_PATH, all set by the launcher before start_proxy runs;
#   * call add_mount_relabel(), which stays in the launcher because the rootless
#     podman relabelling it does is not this file's subject;
#   * write no launcher globals at all;
#   * CALL `exit 1` when the proxy or the filter fails to come up inside the time
#     budget wait_for_running() applies — everything except wait_for_running itself,
#     which returns non-zero and lets its caller decide.
#
# That last point is the difference from sandbox-worktree.sh, whose header promises
# its functions never exit so tests can source them freely. These can and do: a
# sandbox whose socket proxy never started must not proceed to run a container that
# would then reach an unfiltered docker socket. Drive them in a subshell.
#
# Why two networks: the filter is created on the proxy network so FILTER_UPSTREAM
# resolves immediately, then connected to the sandbox network under FILTER_ALIAS.
# Nothing outside these functions may join PROXY_NETWORK_NAME —
# tests/sandbox/claude-sandbox-network.test.js asserts exactly that by line range.

# wait_for_running <container> — block until the container reports Running.
#
# Both start paths used to count attempts: 15 polls of 0.2s, then "failed to start
# after 15 attempts". That measures samples, not time. The samples are 3s of sleep
# plus 15 `docker inspect` calls, and an inspect costs microseconds on an idle host
# and can cost the better part of a second on a loaded one — so the budget the
# operator actually gets varies with load, and a slow host reports a start failure
# for a container that was starting normally. A wall-clock deadline says the same
# thing independently of how the host is scheduled.
#
# SANDBOX_PROXY_START_TIMEOUT overrides the budget, in whole seconds. It is read here
# rather than at load time because this file is sourced and must set nothing.
#
# Returns 1 rather than exiting: both callers exit, but a function that exits cannot
# be tested, and the caller is the one that knows what failed to come up.
wait_for_running() {
  local name=$1
  local budget=${SANDBOX_PROXY_START_TIMEOUT:-30}
  local deadline=$((SECONDS + budget))
  local state seen=0

  while :; do
    state=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null)
    case "$state" in
      running) return 0 ;;
      # The containers run with --rm, so one that died is gone and inspect answers
      # nothing. Empty before the first sighting is just the create not settled yet;
      # empty after it means the container exited and was removed, and waiting out
      # the rest of the budget would only delay a failure that is already decided.
      '') [ "$seen" -eq 0 ] || { printf 'Error: %s exited before it was ready\n' "$name" >&2; return 1; } ;;
      exited|dead) printf 'Error: %s exited before it was ready (%s)\n' "$name" "$state" >&2; return 1 ;;
      *) seen=1 ;;
    esac

    if [ "$SECONDS" -ge "$deadline" ]; then
      printf 'Error: %s did not report running within %ss\n' "$name" "$budget" >&2
      return 1
    fi
    sleep 0.2
  done
}

# --- Docker socket proxy management ---
start_proxy() {
  # Clean up any stale proxy/filter/network from a previous run
  docker rm -f "$FILTER_NAME" 2>/dev/null || true
  docker rm -f "$PROXY_NAME" 2>/dev/null || true
  docker network rm "$NETWORK_NAME" 2>/dev/null || true
  docker network rm "$PROXY_NETWORK_NAME" 2>/dev/null || true

  # Sandbox <-> filter. The sandbox joins this one and nothing else.
  docker network create "$NETWORK_NAME" >/dev/null
  # Filter <-> proxy. --internal keeps it off the host bridge as well; only these two
  # containers are ever attached.
  docker network create --internal "$PROXY_NETWORK_NAME" >/dev/null

  # Proxy scope: containers/networks/volumes/images are enabled for compose
  # workflows. POST is required for container create/start. exec/build/commit
  # are blocked.
  #
  # Blocking exec/build/commit does NOT prevent escape on its own. docker-socket-proxy
  # filters by API PATH and never reads a request BODY, so POST=1 + ALLOW_START=1
  # forwards /containers/create with any HostConfig the caller asks for — `-v /:/host`,
  # `--privileged`, `--pid=host`. A plain HTTP POST to the proxy port does it; no
  # `docker` binary is involved, so the Bash deny-list never sees it.
  #
  # docker-create-filter.py now sits in FRONT of this and reads those bodies (see
  # start_filter below), which is what makes Docker access here less than
  # host-equivalent. This container keeps its path-level rules as the second layer:
  # if the filter has a parsing bug, the worst case is the behaviour we had before it,
  # not something weaker.
  echo "Starting Docker socket proxy ($PROXY_NAME)..."
  # $PROXY_NAME can exceed the 63-char DNS label limit (RFC 1035), in which
  # case Docker's embedded resolver (127.0.0.11) never registers it and the
  # sandbox can't reach DOCKER_HOST by name. Attach a short, stable alias on
  # the isolated per-run network and point DOCKER_HOST at that instead.
  docker run -d --rm \
    --name "$PROXY_NAME" \
    --network "$PROXY_NETWORK_NAME" \
    --network-alias "$PROXY_ALIAS" \
    --cap-drop all \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -e LOG_LEVEL=info \
    -e CONTAINERS=1 \
    -e NETWORKS=1 \
    -e VOLUMES=1 \
    -e IMAGES=1 \
    -e POST=1 \
    -e ALLOW_START=1 \
    -e ALLOW_STOP=1 \
    -e ALLOW_RESTARTS=1 \
    -e EVENTS=1 \
    -e VERSION=1 \
    -e PING=1 \
    -e EXEC=0 \
    -e AUTH=0 \
    -e SECRETS=0 \
    -e SWARM=0 \
    -e BUILD=0 \
    -e COMMIT=0 \
    -e CONFIGS=0 \
    -e DISTRIBUTION=0 \
    -e NODES=0 \
    -e PLUGINS=0 \
    -e SYSTEM=0 \
    -e SERVICES=0 \
    -e TASKS=0 \
    "$PROXY_IMAGE" >/dev/null

  # Wait for proxy container to be running
  wait_for_running "$PROXY_NAME" || exit 1

  start_filter

  echo "  Allowed: containers, networks, volumes, images (read), start/stop/restart"
  echo "  Blocked: exec, build, commit, system, secrets, auth, swarm, plugins"
  echo "  Filtered: create bodies — no privileged, host namespaces, added caps,"
  echo "            devices, or binds outside $WORK_PATH"
}

# Body-inspecting filter in front of the socket proxy. Runs on claudebot:base purely
# because it is already built and already has python3 — no extra image to pull or pin.
start_filter() {
  echo "Starting Docker create-filter ($FILTER_NAME)..."
  # The workspace is mounted at its own host path, read-only, so the filter can
  # realpath a bind source. Without it a symlink planted in the repo — which the agent
  # can write — would resolve on the host and escape a purely textual prefix check.
  docker run -d --rm \
    --name "$FILTER_NAME" \
    --network "$PROXY_NETWORK_NAME" \
    --cap-drop all \
    --read-only \
    --user "$(id -u):$(id -g)" \
    ${ENGINE_ARGS[@]+"${ENGINE_ARGS[@]}"} \
    -v "$(add_mount_relabel "$SANDBOX_DIR/docker-create-filter.py:/opt/docker-create-filter.py:ro")" \
    -v "$(add_mount_relabel "$SANDBOX_DIR/filter_policy.py:/opt/filter_policy.py:ro")" \
    -v "$(add_mount_relabel "$CANON_LIB:/opt/canon.py:ro")" \
    -v "$(add_mount_relabel "$WORK_PATH:$WORK_PATH:ro")" \
    -e FILTER_UPSTREAM="$PROXY_ALIAS:2375" \
    -e FILTER_WORKSPACE="$WORK_PATH" \
    --entrypoint python3 \
    claudebot:base /opt/docker-create-filter.py >/dev/null

  # Second interface, added after creation because `docker run` accepts only one
  # --network. The proxy network comes first so FILTER_UPSTREAM resolves from the
  # moment the process starts; this is the interface the sandbox reaches it on.
  docker network connect --alias "$FILTER_ALIAS" "$NETWORK_NAME" "$FILTER_NAME" >/dev/null

  if ! wait_for_running "$FILTER_NAME"; then
    docker logs "$FILTER_NAME" 2>&1 | tail -20 >&2 || true
    exit 1
  fi
}

stop_proxy() {
  docker rm -f "$FILTER_NAME" 2>/dev/null || true
  docker rm -f "$PROXY_NAME" 2>/dev/null || true
  docker network rm "$NETWORK_NAME" 2>/dev/null || true
  docker network rm "$PROXY_NETWORK_NAME" 2>/dev/null || true
}
