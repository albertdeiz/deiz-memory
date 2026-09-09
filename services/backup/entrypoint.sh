#!/usr/bin/env bash
# Joins the tailnet when asked, then hands over to the CLI.
#
# The destination — a Nextcloud on a Raspberry Pi — publishes no port to the
# internet and its name resolves to a tailnet address, which is the whole point
# of how that platform is built. So the backup joins the tailnet ITSELF instead
# of depending on the host's routing. That is not a workaround: it is what makes
# this work identically on a Linux VPS and on a laptop running Docker Desktop,
# where a container cannot reach the host's LAN at all.
#
# Userspace networking, so no NET_ADMIN and no /dev/net/tun: tailscaled opens an
# outbound HTTP proxy and restic and rclone are pointed at it. Nothing about the
# container's own network changes.
set -euo pipefail

if [ -n "${TS_AUTHKEY:-}" ]; then
  PROXY_PORT="${TS_PROXY_PORT:-1055}"
  echo "· uniéndose al tailnet" >&2
  tailscaled \
    --tun=userspace-networking \
    --outbound-http-proxy-listen="localhost:${PROXY_PORT}" \
    --socks5-server="localhost:$((PROXY_PORT + 1))" \
    --statedir=/tmp/tailscale >/tmp/tailscaled.log 2>&1 &

  # Readiness is the socket existing, NOT `tailscale status` succeeding: status
  # exits non-zero while logged out, which is precisely the state this loop is
  # waiting in. Using it as the signal meant waiting the full timeout and then
  # declaring a daemon dead that had been up the whole time.
  for i in $(seq 1 30); do
    [ -S /var/run/tailscale/tailscaled.sock ] && break
    sleep 1
    if [ "$i" = 30 ]; then
      echo "✗ tailscaled no abrió su socket en 30s:" >&2
      tail -20 /tmp/tailscaled.log >&2
      exit 1
    fi
  done

  # Ephemeral, so the node disappears when the run ends instead of leaving a
  # dead machine in the tailnet for every backup ever taken.
  tailscale up \
    --authkey="$TS_AUTHKEY" \
    --hostname="${TS_HOSTNAME:-deiz-memory-backup}" \
    --accept-dns=true >&2

  # This is what routes restic and rclone over the tailnet. Only these two make
  # outbound calls, and both honour the standard proxy variables.
  export HTTPS_PROXY="http://localhost:${PROXY_PORT}"
  export HTTP_PROXY="$HTTPS_PROXY"
  # The database and the object store are reached by Docker network name, and
  # sending those through the proxy would break them.
  export NO_PROXY="localhost,127.0.0.1,postgres,garage,ollama,documents,ocr,whisper"
  echo "· tailnet: $(tailscale ip -4 2>/dev/null || echo '?')" >&2
fi

exec node /app/dist/dm.js "$@"
