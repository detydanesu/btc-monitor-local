#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
CONFIG_HOME=${XDG_CONFIG_HOME:-"$HOME/.config"}
ENV_DIR="$CONFIG_HOME/btc-realtime-monitor"
ENV_FILE="$ENV_DIR/qqbot.env"
NODE_BIN=${NODE_BIN:-node}

APP_ID=${QQBOT_APP_ID:-}
CLIENT_SECRET=${QQBOT_CLIENT_SECRET:-}
TARGET=${QQBOT_TARGET:-}
API_BASE=${QQBOT_API_BASE:-https://api.bot.qq.com}
AUTH_URL=${QQBOT_AUTH_URL:-https://api.bot.qq.com/app/getAppAccessToken}
OPENCLAW_CONFIG=${OPENCLAW_CONFIG:-}
TEST=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-id) APP_ID=${2:?--app-id requires a value}; shift 2 ;;
    --client-secret) CLIENT_SECRET=${2:?--client-secret requires a value}; shift 2 ;;
    --target|--openid) TARGET=${2:?--target requires c2c:OPENID or group:OPENID}; shift 2 ;;
    --api-base) API_BASE=${2:?--api-base requires a URL}; shift 2 ;;
    --auth-url) AUTH_URL=${2:?--auth-url requires a URL}; shift 2 ;;
    --from-openclaw) OPENCLAW_CONFIG=${2:?--from-openclaw requires a JSON path}; shift 2 ;;
    --test) TEST=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: qqbot-import [options]

Options:
  --app-id ID             QQ Bot AppID
  --client-secret SECRET  QQ Bot Client Secret
  --target TARGET        c2c:OPENID or group:OPENID
  --api-base URL         Default: https://api.bot.qq.com
  --auth-url URL         Default: https://api.bot.qq.com/app/getAppAccessToken
  --from-openclaw PATH   Import app credentials from an existing JSON config
  --test                 Send a labelled test alert after importing

Without options, the script asks for the values interactively.
The secret is stored in a mode-600 environment file.
EOF
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$OPENCLAW_CONFIG" && -f "$HOME/.openclaw/openclaw.json" ]]; then
  OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
fi

if [[ -n "$OPENCLAW_CONFIG" && -f "$OPENCLAW_CONFIG" ]]; then
  mapfile -t IMPORTED_VALUES < <(OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG" "$NODE_BIN" <<'NODE'
const fs = require("node:fs");
try {
  const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
  const qqbot = config?.channels?.qqbot ?? {};
  process.stdout.write(`${String(qqbot.appId ?? "")}\n${String(qqbot.clientSecret ?? "")}\n`);
} catch {
  process.exitCode = 1;
}
NODE
  ) || true
  if [[ -z "$APP_ID" && ${#IMPORTED_VALUES[@]} -ge 1 ]]; then APP_ID=${IMPORTED_VALUES[0]}; fi
  if [[ -z "$CLIENT_SECRET" && ${#IMPORTED_VALUES[@]} -ge 2 ]]; then CLIENT_SECRET=${IMPORTED_VALUES[1]}; fi
fi

if [[ -z "$TARGET" && -f "$APP_DIR/config.json" ]]; then
  TARGET=$(CONFIG_PATH="$APP_DIR/config.json" "$NODE_BIN" -e '
    const fs = require("node:fs");
    try {
      const c = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf8"));
      process.stdout.write(String(c?.qqBot?.target ?? c?.qqTarget ?? ""));
    } catch {}
  ' 2>/dev/null || true)
fi

if [[ -z "$APP_ID" ]]; then read -r -p "QQ Bot AppID: " APP_ID; fi
if [[ -z "$CLIENT_SECRET" ]]; then read -r -s -p "QQ Bot Client Secret: " CLIENT_SECRET; echo; fi
if [[ -z "$TARGET" ]]; then read -r -p "Target (c2c:OPENID or group:OPENID): " TARGET; fi

if [[ "$TARGET" =~ ^qqbot:(c2c|direct|user|group):(.+)$ ]]; then
  KIND=${BASH_REMATCH[1]}
  OPENID=${BASH_REMATCH[2]}
elif [[ "$TARGET" =~ ^(c2c|direct|user|group):(.+)$ ]]; then
  KIND=${BASH_REMATCH[1]}
  OPENID=${BASH_REMATCH[2]}
else
  echo "Target must be c2c:OPENID or group:OPENID; a QQ number is not an OpenID." >&2
  exit 2
fi

if [[ "$KIND" == "group" ]]; then
  NORMALIZED_TARGET="group:$OPENID"
else
  NORMALIZED_TARGET="c2c:$OPENID"
fi

mkdir -p "$ENV_DIR"
TEMP_FILE=$(mktemp "$ENV_DIR/qqbot.env.XXXXXX")
cleanup() { rm -f -- "$TEMP_FILE"; }
trap cleanup EXIT

escape_env() {
  local value=$1
  value=${value//\'/\'\\\'\'}
  value=${value//$'\n'/}
  printf "'%s'" "$value"
}

{
  printf 'QQBOT_APP_ID='; escape_env "$APP_ID"; printf '\n'
  printf 'QQBOT_CLIENT_SECRET='; escape_env "$CLIENT_SECRET"; printf '\n'
  printf 'QQBOT_TARGET='; escape_env "$NORMALIZED_TARGET"; printf '\n'
  printf 'QQBOT_API_BASE='; escape_env "$API_BASE"; printf '\n'
  printf 'QQBOT_AUTH_URL='; escape_env "$AUTH_URL"; printf '\n'
} >"$TEMP_FILE"
chmod 0600 "$TEMP_FILE"
mv -f -- "$TEMP_FILE" "$ENV_FILE"
trap - EXIT

echo "QQ Bot credentials imported to $ENV_FILE"
echo "Target: $NORMALIZED_TARGET"

if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet btc-realtime-monitor.service; then
  systemctl --user restart btc-realtime-monitor.service
  echo "Restarted btc-realtime-monitor.service to load the new credentials."
fi

if [[ "$TEST" == "1" ]]; then
  # The monitor's labelled test uses the same direct API path as real alerts.
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  exec "$APP_DIR/btc-monitorctl" test-alert
fi

echo "Run 'btc-monitorctl test-alert' to verify delivery."
