#!/bin/bash
# Entrypoint for claudebot container.
# Runs as claudebot (USER set in Dockerfile).
# Socket permissions are fixed by the launcher via a pre-run container.
exec "$@"
