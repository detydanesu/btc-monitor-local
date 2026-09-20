#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
exec "$APP_DIR/btc-monitorctl" restart "$@"
