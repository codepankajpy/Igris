#!/bin/sh
# Container entrypoint. Starts as root ONLY to hand the data directories to
# the unprivileged `igris` user — a platform volume mounted at /data
# (Railway, Render, docker -v) is root-owned, and a key created with
# `docker exec` / `railway ssh` runs as root — then drops to `igris` with no
# capabilities and no-new-privs before starting Node.
set -eu
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$IGRIS_DATA_DIR" "$IGRIS_HOME"
  chown -R igris:igris "$IGRIS_DATA_DIR" "$IGRIS_HOME"
  chmod 0700 "$IGRIS_DATA_DIR" "$IGRIS_HOME"
  exec setpriv --reuid=10001 --regid=10001 --init-groups --no-new-privs \
    --bounding-set=-all --inh-caps=-all env HOME=/home/igris "$@"
fi
exec "$@"
