#!/bin/sh
# Drain dispatch, finish current work, restart, then restore the previous desk state.
# Usage: scripts/restart-when-idle.sh [service-name] [port] [max-minutes]
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
exec node --disable-warning=ExperimentalWarning "$ROOT/scripts/restart-when-idle.mjs" "$@"
