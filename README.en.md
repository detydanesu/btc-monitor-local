# BTC Real-Time Alert Monitor

[简体中文](README.md) | **English**

This project is a standalone, read-only Node.js monitor for the BTC/USDT market. It does not log in to an exchange, store exchange API keys, place orders, or trade. Alerts are sent directly through the selected QQ Bot or Telegram Bot HTTPS API; OpenClaw is not required.

## Features

- Watches Binance `BTCUSDT` aggregated trades over WebSocket.
- Sends alerts through either QQ Bot or Telegram Bot when the price moves far enough from the saved baseline or changes enough over a rolling five-minute window.
- Uses REST data to initialize the five-minute history and to continue monitoring while the WebSocket is unavailable.
- Provides a systemd user service and an interactive control menu.
- Stores credentials in mode-600 environment files outside the repository.
- Keeps the baseline unchanged when an alert delivery fails, so the alert can be retried.

## Alert rules

The default timezone is `Asia/Shanghai`.

| Period | Baseline movement | Rolling five-minute movement |
| --- | ---: | ---: |
| 06:40–22:59 | ±0.5% | ±0.2% |
| 23:00–06:39 | ±1.2% | ±0.6% |

The monitor evaluates new prices approximately every 250 ms. A baseline alert is sent when the current price reaches the configured percentage away from the saved baseline. After the QQ message is delivered successfully, the triggering price becomes the new baseline. If delivery fails, the old baseline is kept and delivery is retried.

Rolling five-minute alerts are sent when the threshold is first crossed, the direction changes, or the movement expands significantly. The default re-arm ratio is `0.7`, the escalation step is `0.2%`, and there is no fixed notification cooldown. A baseline alert and a rolling alert that happen together are combined into one QQ message.

The current message titles are in Chinese:

- `【5min滚动预警】` — rolling five-minute condition only.
- `【基准涨跌预警】` — baseline condition only.
- `【基准涨跌预警 + 5min滚动预警】` — both conditions.

## Requirements

- Linux with a working systemd user service.
- Node.js 22 or newer. The monitor uses the built-in `fetch` and `WebSocket` implementations.
- Network access to Binance and the selected bot API.
- A QQ Bot or Telegram Bot with permission to send messages to the selected target.

The installer does not install Node.js. To install the current Node.js LTS with `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install --lts
nvm alias default 'lts/*'
node --version
```

## One-line installation from GitHub

The public repository is:

<https://github.com/detydanesu/btc-monitor-local>

Install the latest `main` branch with:

```bash
curl -fsSL https://raw.githubusercontent.com/detydanesu/btc-monitor-local/main/install-from-github.sh | bash
```

The bootstrap script uses Git when it is available. If Git is unavailable, it downloads the GitHub archive with `curl` or `wget` and unpacks it with `tar`. The default source directory is:

```text
~/.local/share/btc-monitor-local
```

To use another directory:

```bash
curl -fsSL https://raw.githubusercontent.com/detydanesu/btc-monitor-local/main/install-from-github.sh \
  | BTC_MONITOR_INSTALL_DIR="$HOME/apps/btc-monitor-local" bash
```

When updating an existing Git checkout, the script uses a fast-forward-only pull. When updating a recognized non-Git installation, it preserves the existing `config.json` and `data/` directory.

The installer creates:

- `~/.config/systemd/user/btc-realtime-monitor.service`
- `~/.config/btc-realtime-monitor/qqbot.env` when QQ Bot credentials are imported
- `~/.config/btc-realtime-monitor/telegram.env` when Telegram credentials are imported
- `~/.config/btc-realtime-monitor/provider.env` when the provider is selected with `btc-monitorctl provider`
- `~/.local/bin/btc-monitorctl`
- `~/.local/bin/qqbot-import`

The service is enabled but is not started until credentials for the selected provider are available. If the installer reports that `~/.local/bin` is not in `PATH`, run:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then use `btc-monitorctl` normally. You can also invoke it by its absolute path:

```bash
~/.local/bin/btc-monitorctl menu
```

To keep a user service running after logout, enable systemd user lingering:

```bash
loginctl enable-linger "$USER"
```

## Configure alert delivery

Choose the active provider with:

```bash
btc-monitorctl provider qqbot-http
btc-monitorctl provider telegram
```

The default provider is `qqbot-http`. Only the selected provider needs credentials.
The `provider` command stores its selection in the protected `provider.env` file, so it does not modify the tracked `config.json`.

The same setting can be written in `config.json`:

```json
{
  "alertProvider": "telegram"
}
```

### QQ Bot

Use the interactive importer:

```bash
btc-monitorctl qqbot import
```

It asks for:

1. QQ Bot AppID.
2. QQ Bot Client Secret.
3. The destination OpenID.

The target must use one of these formats:

```text
c2c:OPENID
group:OPENID
```

A QQ number cannot replace an OpenID. The credentials and target are saved in:

```text
~/.config/btc-realtime-monitor/qqbot.env
```

The file is created with permission `600`. It is ignored by Git and is not stored in the project directory.

If an old OpenClaw configuration exists at `~/.openclaw/openclaw.json`, the importer can use its QQ Bot AppID and Client Secret as migration defaults. The target OpenID still needs to be confirmed. To specify another file:

```bash
btc-monitorctl qqbot import --from-openclaw /path/to/openclaw.json
```

The application also accepts these environment variables, which override matching values in `config.json`:

| Variable | Purpose |
| --- | --- |
| `QQBOT_APP_ID` | QQ Bot AppID |
| `QQBOT_CLIENT_SECRET` | QQ Bot Client Secret |
| `QQBOT_TARGET` | `c2c:OPENID` or `group:OPENID` |
| `QQBOT_API_BASE` | API base URL; default `https://api.bot.qq.com` |
| `QQBOT_AUTH_URL` | Token URL; default `https://api.bot.qq.com/app/getAppAccessToken` |
| `BTC_ALERT_PROVIDER` | Alert provider; default `qqbot-http` |

### Telegram Bot

Create a bot with [BotFather](https://t.me/BotFather) and obtain the destination chat ID. The implementation uses Telegram's [`sendMessage`](https://core.telegram.org/bots/api#sendmessage) Bot API method. Import the token and chat ID:

```bash
btc-monitorctl telegram import
btc-monitorctl provider telegram
btc-monitorctl telegram test
```

The importer stores the credentials in `~/.config/btc-realtime-monitor/telegram.env` with permission `600`. The chat ID can be a numeric user, group, or channel ID, or a Telegram `@channelusername`.

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | User, group, or channel chat ID |
| `TELEGRAM_API_BASE` | API base URL; default `https://api.telegram.org` |
| `TELEGRAM_PARSE_MODE` | Optional parse mode, such as `HTML` |

## Start and control the service

After importing credentials, set an initial baseline and start the service:

```bash
btc-monitorctl baseline current
btc-monitorctl open
btc-monitorctl status
```

The control command supports:

```bash
btc-monitorctl open              # start the service
btc-monitorctl close             # stop the service
btc-monitorctl restart           # restart the service
btc-monitorctl status            # show service status
btc-monitorctl logs              # follow recent logs
btc-monitorctl test-alert        # send a labelled delivery test
btc-monitorctl telegram test     # test Telegram delivery
btc-monitorctl provider telegram # select Telegram as the active provider
btc-monitorctl once --dry-run    # fetch and evaluate one snapshot safely
btc-monitorctl rules              # show the active day/night rules
btc-monitorctl config show        # show configuration with secrets hidden
btc-monitorctl config edit        # edit config.json with $EDITOR
btc-monitorctl version            # show the installed source revision
btc-monitorctl --help             # show all commands
```

`btc-monitorctl` without a command opens the interactive menu when it is connected to a terminal:

```bash
btc-monitorctl
```

The menu includes service status/start/stop/restart, QQ Bot and Telegram import/testing, provider selection, baseline management, rules and configuration, and service logs. The explicit form is:

```bash
btc-monitorctl menu
```

`btc-monitorctl test-alert` uses the selected provider. `btc-monitorctl telegram test` explicitly tests Telegram. Both send one clearly labelled test message and do not change the baseline or rolling-alert state.

## Change the baseline

Show the saved baseline:

```bash
btc-monitorctl baseline show
```

Set it to the current Binance price:

```bash
btc-monitorctl baseline current
```

Set it to a specific positive price:

```bash
btc-monitorctl baseline 70000
```

If the service is running, the control command stops it briefly while updating the state file and starts it again afterward.

## Change the alert rules

The rules are in `config.json`:

```json
{
  "day": {
    "baselineThresholdPct": 0.5,
    "rolling5mThresholdPct": 0.2
  },
  "night": {
    "start": "23:00",
    "end": "06:40",
    "baselineThresholdPct": 1.2,
    "rolling5mThresholdPct": 0.6
  }
}
```

Edit through the control interface:

```bash
btc-monitorctl config edit
```

Or edit the file directly and restart the service:

```bash
${EDITOR:-vi} ~/.local/share/btc-monitor-local/config.json
btc-monitorctl restart
```

Use `btc-monitorctl rules` or the menu to confirm the active values. The monitor validates positive thresholds and valid night-period clock values when it starts.

## Inspect and test locally

From the source directory:

```bash
cd /path/to/btc-monitor-local
node --check btc-realtime-monitor.mjs
node btc-realtime-monitor.test.mjs
node btc-realtime-monitor.mjs --once --dry-run
```

To inspect the baseline directly:

```bash
node btc-realtime-monitor.mjs --show-baseline
```

To send a direct test message without changing alert state:

```bash
btc-monitorctl test-alert
```

After confirming that the real-time service is working, disable any older five-minute polling job that sends the same alerts so that duplicate messages are not produced.

## How it works

1. At startup, the monitor fetches Binance one-second candles and the current ticker price to populate roughly five minutes of history.
2. It subscribes to the Binance `BTCUSDT` aggregated-trade WebSocket.
3. New prices are sampled and evaluated against the active Shanghai day/night band.
4. When a rule triggers, the monitor sends the message directly through the selected QQ Bot or Telegram Bot HTTP API.
5. QQ access tokens are cached and refreshed automatically. A `401` response causes one token refresh and retry.
6. The baseline and runtime state are persisted only after successful delivery where appropriate.

The monitor is an alerting service only. Messages include a reminder that they are market-risk notifications and are not investment advice; no trading operation is performed.

## Fault tolerance and state

- WebSocket data is considered stale after 20 seconds; the monitor reconnects with exponential backoff up to 30 seconds.
- While WebSocket data is unavailable, REST snapshots are attempted every five seconds. Failed REST attempts back off up to 60 seconds.
- State is written to temporary files and atomically renamed into place.
- A lock file prevents two monitor instances from running at the same time.
- Baseline state is stored in `data/baseline-state.json`.
- Runtime health is stored in `data/realtime-status.json`.
- User-service logs are available with `journalctl --user -u btc-realtime-monitor.service`.
- Delivery has at-least-once semantics. If the process stops after QQ accepts a message but before the local state is persisted, a restart may send that alert once more.

## Files

- `btc-realtime-monitor.mjs` — real-time monitor and direct QQ Bot/Telegram Bot HTTP clients.
- `btc-realtime-monitor.test.mjs` — tests that do not require network access or message delivery.
- `config.json` — market, threshold, retry, and state-file settings.
- `btc-realtime-monitor.service` — example systemd service unit; `install.sh` generates a user-specific unit for the current checkout.
- `btc-monitor.mjs` — legacy five-minute REST polling implementation retained for reference; it is not used by the real-time service.
- `install.sh` — installs the user service and control wrappers.
- `install-from-github.sh` — downloads or updates the project and then runs the installer.
- `btc-monitorctl` — service control, provider setup/testing, baseline management, and configuration commands.
- `scripts/import-qqbot.sh` — secure QQ Bot credential importer.
- `scripts/import-telegram.sh` — secure Telegram Bot token and chat ID importer.

## Security notes

- Do not commit `qqbot.env`, `telegram.env`, `provider.env`, bot tokens, AppIDs, Client Secrets, OpenIDs, chat IDs, or runtime state to a public repository.
- Keep bot credentials in the protected environment files instead of placing them in shell history or `config.json`.
- Limit each bot's permissions and message targets to what the monitor needs.
