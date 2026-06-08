#!/usr/bin/env bash
# Build or run the disccovery production image locally, sourcing config from
# .env.docker so you don't have to pass --build-arg / -e on every invocation.
#
# Usage:
#   ./scripts/docker-local.sh build
#   ./scripts/docker-local.sh run
#   ./scripts/docker-local.sh up      # build + run

set -euo pipefail

cmd="${1:-}"
if [[ -z "$cmd" ]]; then
  echo "usage: $0 {build|run|up}" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$repo_root/.env.docker"

if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file — copy .env.docker.example and fill it in." >&2
  exit 1
fi

# Load .env.docker into this shell so we can pass values as --build-arg.
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

required=(SPOTIFY_CLIENT_ID SPOTIFY_CLIENT_SECRET SESSION_SECRET TOKEN_ENC_KEY DATABASE_URL PUBLIC_BASE_URL ORIGIN)
for v in "${required[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "Missing $v in $env_file" >&2
    exit 1
  fi
done

do_build() {
  docker build \
    --build-arg PUBLIC_BASE_URL="$PUBLIC_BASE_URL" \
    --build-arg SPOTIFY_CLIENT_ID="$SPOTIFY_CLIENT_ID" \
    --build-arg SPOTIFY_CLIENT_SECRET="$SPOTIFY_CLIENT_SECRET" \
    --build-arg SESSION_SECRET="$SESSION_SECRET" \
    --build-arg DATABASE_URL="$DATABASE_URL" \
    -t disccovery \
    "$repo_root"
}

do_run() {
  docker run --rm -p 3000:3000 \
    --env-file "$env_file" \
    -e NODE_ENV=production \
    disccovery
}

case "$cmd" in
  build) do_build ;;
  run)   do_run ;;
  up)    do_build && do_run ;;
  *) echo "usage: $0 {build|run|up}" >&2; exit 1 ;;
esac
