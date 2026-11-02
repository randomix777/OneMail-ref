#!/usr/bin/env bash
# Start (or update) OneMail on this host.
#
#   ./up.sh              # uses ./docker-compose.yml from the repository
#   ./up.sh --pull       # pull the newest image first
#
# The Cloudflare Tunnel override is added automatically when TUNNEL_TOKEN is set
# in ./.env, so the same command works with and without the tunnel.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "missing .env in $(pwd) — copy deploy/vps/.env.example and fill it in" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

files=(-f docker-compose.yml -f docker-compose.vps.yml)
if [ -n "${TUNNEL_TOKEN:-}" ]; then
  files+=(-f docker-compose.tunnel.yml)
fi

if [ "${1:-}" = "--pull" ]; then
  docker compose "${files[@]}" --profile all --profile queue-worker pull
fi

exec docker compose "${files[@]}" --profile all --profile queue-worker up -d
