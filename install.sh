#!/bin/sh
# Pull and run Ruang AI with Docker. Works piped from curl or over SSH:
#   curl -fsSL https://raw.githubusercontent.com/hendras1722/virtual-office/main/install.sh | sh
#   ssh user@server 'sh -s' < install.sh
set -eu

IMAGE="${IMAGE:-ghcr.io/hendras1722/virtual-office:latest}"
NAME="${NAME:-ruang-ai}"
VOLUME="${VOLUME:-ruang-ai-data}"
PORT="${PORT:-29417}"

case "$IMAGE$NAME$VOLUME$PORT" in
  *[!A-Za-z0-9._:/@-]*) echo "IMAGE/NAME/VOLUME/PORT contain unsupported characters." >&2; exit 1 ;;
esac
command -v docker >/dev/null 2>&1 || { echo "Docker is not installed on this host." >&2; exit 1; }

docker pull "$IMAGE"
docker rm -f "$NAME" >/dev/null 2>&1 || true
# Loopback only: the app has no login and stores API keys in plaintext. Data lives in the named volume.
docker run -d --name "$NAME" --restart unless-stopped \
  -p "127.0.0.1:$PORT:29417" -v "$VOLUME:/app/data" "$IMAGE" >/dev/null

echo "Ruang AI running on 127.0.0.1:$PORT of this host (data volume: $VOLUME)."
echo "Open it from your machine:  ssh -L 29417:127.0.0.1:$PORT <user>@<this-host>  ->  http://127.0.0.1:29417"
