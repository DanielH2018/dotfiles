#!/bin/bash
#
# Bring the claude-otel compose stack up once Docker Desktop answers. macOS only: run by the
# com.daniel.claude-otel launchd agent (scheduled/com.daniel.claude-otel.plist.tmpl) at load
# and whenever ~/.docker/run/docker.sock changes. A running job keeps executing the copy it
# started with, so after editing this run `launchctl kickstart -k gui/$(id -u)/com.daniel.claude-otel`.
set -euo pipefail

# launchd starts this with a minimal PATH that lacks the Docker Desktop CLI.
export PATH="/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"

for _ in $(seq 1 60); do
  docker info >/dev/null 2>>"$HOME/claude-otel/launchd.log" && break
  sleep 2
done

exec docker compose -f "$HOME/claude-otel/docker-compose.yml" up -d
