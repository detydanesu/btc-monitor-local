#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
CONFIG_HOME=${XDG_CONFIG_HOME:-"$HOME/.config"}
ENV_DIR="$CONFIG_HOME/btc-realtime-monitor"
ENV_FILE="$ENV_DIR/telegram.env"

TOKEN=${TELEGRAM_BOT_TOKEN:-}
CHAT_ID=${TELEGRAM_CHAT_ID:-}
API_BASE=${TELEGRAM_API_BASE:-https://api.telegram.org}
PARSE_MODE=${TELEGRAM_PARSE_MODE:-}
TEST=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token|--bot-token) TOKEN=${2:?$1 requires a value}; shift 2 ;;
    --chat-id) CHAT_ID=${2:?--chat-id requires a value}; shift 2 ;;
    --api-base) API_BASE=${2:?--api-base requires a URL}; shift 2 ;;
    --parse-mode) PARSE_MODE=${2:?--parse-mode requires a value}; shift 2 ;;
    --test) TEST=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: import-telegram.sh [options]

Options:
  --token TOKEN       Telegram Bot token from BotFather
  --chat-id ID        Telegram user, group, or channel chat ID
  --api-base URL      Default: https://api.telegram.org
  --parse-mode MODE   Optional Telegram parse mode, such as HTML
  --test              Send a labelled test alert after importing

Without options, the script asks for the values interactively.
The token is stored in a mode-600 environment file.
EOF
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TOKEN" ]]; then
  read -r -s -p "Telegram Bot token: " TOKEN
  echo
fi
if [[ -z "$CHAT_ID" ]]; then
  read -r -p "Telegram chat ID: " CHAT_ID
fi

if [[ -z "$TOKEN" || -z "$CHAT_ID" ]]; then
  echo "Both the Telegram Bot token and chat ID are required." >&2
  exit 2
fi

mkdir -p "$ENV_DIR"
TEMP_FILE=$(mktemp "$ENV_DIR/telegram.env.XXXXXX")
cleanup() { rm -f -- "$TEMP_FILE"; }
trap cleanup EXIT

escape_env() {
  local value=$1
  value=${value//\'/\'\\\'\'}
  value=${value//$'\n'/}
  printf "'%s'" "$value"
}

{
  printf 'TELEGRAM_BOT_TOKEN='; escape_env "$TOKEN"; printf '\n'
  printf 'TELEGRAM_CHAT_ID='; escape_env "$CHAT_ID"; printf '\n'
  printf 'TELEGRAM_API_BASE='; escape_env "$API_BASE"; printf '\n'
  printf 'TELEGRAM_PARSE_MODE='; escape_env "$PARSE_MODE"; printf '\n'
} >"$TEMP_FILE"
chmod 0600 "$TEMP_FILE"
mv -f -- "$TEMP_FILE" "$ENV_FILE"
trap - EXIT

echo "Telegram Bot credentials imported to $ENV_FILE"
echo "Chat ID: $CHAT_ID"
echo "Select Telegram as the active provider with: btc-monitorctl provider telegram"

if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet btc-realtime-monitor.service; then
  systemctl --user restart btc-realtime-monitor.service
  echo "Restarted btc-realtime-monitor.service to load the new credentials."
fi

if [[ "$TEST" == "1" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  BTC_ALERT_PROVIDER=telegram "$APP_DIR/btc-monitorctl" test-alert
  exit $?
fi

echo "Run 'btc-monitorctl telegram test' after selecting Telegram to verify delivery."

