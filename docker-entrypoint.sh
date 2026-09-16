#!/bin/sh
set -eu

# The /data path is normally a bind mount. Host permissions/ACLs (and especially
# NFS/root-squash) can make it impossible for an unprivileged container user to
# chown or create files there. Prefer the configured PUID/PGID when possible,
# but never make startup fail solely because the host volume cannot be chowned.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

mkdir -p /data/cache /data/db 2>/dev/null || {
  echo "ERROR: /data is not writable even as root." >&2
  echo "Check the host bind-mount path and its filesystem/ACL permissions." >&2
  exit 1
}

if [ "$(id -u)" = "0" ]; then
  # Try to hand /data to the requested host uid/gid. This can fail on NFS/root-squash
  # or ACL-managed mounts; that's okay, because root can still service the application.
  if chown -R "$PUID:$PGID" /data 2>/dev/null; then
    if gosu "$PUID:$PGID" node -e "require('fs').accessSync('/data', require('fs').constants.W_OK)" >/dev/null 2>&1; then
      echo "Starting as uid:gid ${PUID}:${PGID}"
      exec gosu "$PUID:$PGID" node server.js
    fi
  fi

  echo "WARN: Could not make /data writable for ${PUID}:${PGID}; running Node as root so bind-mounted storage remains usable." >&2
  exec node server.js
fi

exec node server.js
