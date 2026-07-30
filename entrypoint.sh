#!/bin/sh
set -e

# Ensure data directories exist and are owned by the app user.
# Docker creates these as root-owned directories on first run;
# the app user needs write access to create config.json and state.json.
mkdir -p /app/data /app/logs
chown -R app:app /app/data /app/logs

exec su-exec app:app "$@"
