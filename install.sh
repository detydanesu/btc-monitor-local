#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
NODE_BIN=$(command -v node || true)
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js is required but was not found in PATH." >&2
  exit 1
fi

if ! "$NODE_BIN" -e 'if (typeof fetch !== "function" || typeof WebSocket !== "function") process.exit(1)'; then
  echo "This monitor needs a Node.js version with global fetch and WebSocket." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required for the user service installation." >&2
  exit 1
fi

CONFIG_HOME=${XDG_CONFIG_HOME:-"$HOME/.config"}
APP_CONFIG_DIR="$CONFIG_HOME/btc-realtime-monitor"
USER_UNIT_DIR="$CONFIG_HOME/systemd/user"
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$APP_DIR/data" "$APP_CONFIG_DIR" "$USER_UNIT_DIR" "$LOCAL_BIN"
ENV_FILE="$APP_CONFIG_DIR/qqbot.env"
chmod 0755 "$APP_DIR/install.sh" "$APP_DIR/install-from-github.sh" "$APP_DIR/btc-monitorctl" "$APP_DIR/scripts"/*.sh

# Preserve a baseline created by the previous OpenClaw-based deployment.
OLD_STATE="${OPENCLAW_STATE_FILE:-$HOME/.openclaw/btc-qq-alert-state.json}"
NEW_STATE="$APP_DIR/data/baseline-state.json"
if [[ -f "$OLD_STATE" && ! -f "$NEW_STATE" ]]; then
  cp -p -- "$OLD_STATE" "$NEW_STATE"
  echo "Migrated the existing baseline to $NEW_STATE"
fi

UNIT_PATH="$USER_UNIT_DIR/btc-realtime-monitor.service"
cat >"$UNIT_PATH" <<EOF
[Unit]
Description=BTC real-time QQ Bot alert monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/btc-realtime-monitor.mjs --config $APP_DIR/config.json
EnvironmentFile=-$ENV_FILE
Restart=always
RestartSec=3
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

chmod 0644 "$UNIT_PATH"
cat >"$LOCAL_BIN/btc-monitorctl" <<EOF
#!/usr/bin/env bash
exec "$APP_DIR/btc-monitorctl" "\$@"
EOF
cat >"$LOCAL_BIN/qqbot-import" <<EOF
#!/usr/bin/env bash
exec "$APP_DIR/scripts/import-qqbot.sh" "\$@"
EOF
chmod 0755 "$LOCAL_BIN/btc-monitorctl" "$LOCAL_BIN/qqbot-import"

systemctl --user stop btc-realtime-monitor.service 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable btc-realtime-monitor.service

echo
if [[ -f "$ENV_FILE" ]]; then
  systemctl --user start btc-realtime-monitor.service
  echo "Installed and started btc-realtime-monitor.service."
else
  echo "Installed the service but did not start it because QQ Bot credentials are not imported yet."
fi
echo "Import QQ Bot credentials with: btc-monitorctl qqbot import"
echo "Then start the service with: btc-monitorctl open"
echo "Set the baseline with: btc-monitorctl baseline current"
if [[ ":$PATH:" == *":$LOCAL_BIN:"* ]]; then
  echo "Open the interactive control interface with: btc-monitorctl (or btc-monitorctl menu)"
  echo "View the available commands with: btc-monitorctl --help"
else
  echo "Your current shell does not include $LOCAL_BIN in PATH."
  echo "Run now: $LOCAL_BIN/btc-monitorctl menu"
  echo "Enable it for this shell: export PATH=\"$LOCAL_BIN:\$PATH\""
  echo "Then use: btc-monitorctl menu"
fi
echo "If the service must survive logout, run: loginctl enable-linger $USER"
