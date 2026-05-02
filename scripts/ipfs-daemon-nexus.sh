#!/usr/bin/env bash
# Same daemon flags as ./run.sh for this project: DHT client routing (lighter for demos).
# If a daemon is already running, skip or stop it manually first.

set -euo pipefail
exec ipfs daemon --routing=dhtclient "$@"
