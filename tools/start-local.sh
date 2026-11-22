#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
: "${LAN_HOST:?Set LAN_HOST to the Mac Wi-Fi address}"
umask 077
mkdir -p data
if [ ! -s data/setup-key ]; then
  openssl rand -hex 10 > data/setup-key
fi
export SETUP_KEY="$(cat data/setup-key)"
export HOST="$LAN_HOST"
export PORT="${PORT:-3080}"
exec node server/index.mjs
