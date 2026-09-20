# BTC 实时行情预警

这是一个独立、只读市场数据的 Node.js 服务。它不会登录交易所、不会持有交易所 API Key，也不会下单。QQ 预警直接调用 QQ Bot 官方 HTTPS API，不依赖 OpenClaw。

## 实时规则

主要数据源是 Binance `BTCUSDT` 聚合成交 WebSocket；每笔聚合成交到达后会在约 250 ms 内重新评估：

- **基准价变化**
  - 上海时间 06:40–22:59：相对基准价涨跌达到 **0.5%**。
  - 上海时间 23:00–06:39：相对基准价涨跌达到 **1.2%**。
  - QQ 成功送达后才把触发价格保存为新基准；发送失败时保留原基准并重试。
- **滚动 5 分钟变化**
  - 上海时间 06:40–22:59：涨跌达到 **0.2%**。
  - 上海时间 23:00–06:39：涨跌达到 **0.6%**。
  - 只在首次穿越阈值、方向反转或波动继续明显扩大时提醒；不设固定最小通知间隔，并有回落重置机制，避免每笔成交都刷屏。

滚动 5 分钟提醒不设固定通知间隔；基准价变化达到阈值时也会独立立即提醒。

两个条件同时满足时合并成一条 QQ 消息。通知由本地服务直接调用 QQ Bot 官方 HTTPS API。

通知标题固定区分为：

- 仅滚动条件触发：`【5min滚动预警】`
- 仅基准条件触发：`【基准涨跌预警】`
- 两个条件同时触发：`【基准涨跌预警 + 5min滚动预警】`

## 容错

- 启动时使用 Binance 1 秒 K 线填充最近 5 分钟，因此不需要等待 5 分钟预热。
- WebSocket 断开或 20 秒无数据时，采用指数退避自动重连。
- WebSocket 不可用期间，每 5 秒尝试用 REST 更新价格和完整滚动窗口；连续失败时自动退避，最多 60 秒。
- 状态通过临时文件加原子重命名写入；锁文件阻止两个实例同时运行。
- 运行状态在 `data/realtime-status.json`；systemd 日志可用 `journalctl --user -u btc-realtime-monitor.service` 查看。
- 通知是“至少一次”语义：极少数情况下，如果进程恰好在 QQ 已送达但状态尚未落盘的瞬间崩溃，重启后可能重复提醒一次；不会因此漏掉预警。

## 一键安装与控制

前提是 Linux、systemd 用户服务和支持全局 `fetch`/`WebSocket` 的 Node.js。
安装脚本不会替你安装 Node.js。

从 GitHub 一行安装：

```bash
curl -fsSL https://raw.githubusercontent.com/detydanesu/btc-monitor-local/main/install-from-github.sh | bash
```

脚本优先使用 Git；没有 Git 时会改用 `curl` 或 `wget` 下载 GitHub 压缩包。
它不会覆盖非空的安装目录；更新已有 Git 检出时使用快进更新。

默认代码目录为 `~/.local/share/btc-monitor-local`。需要自定义目录时：

```bash
curl -fsSL https://raw.githubusercontent.com/detydanesu/btc-monitor-local/main/install-from-github.sh \
  | BTC_MONITOR_INSTALL_DIR="$HOME/apps/btc-monitor-local" bash
```

在 Linux + systemd 用户环境中：

```bash
bash install.sh
~/.local/bin/btc-monitorctl qqbot import
~/.local/bin/btc-monitorctl open
~/.local/bin/btc-monitorctl status
```

如果 `btc-monitorctl` 提示 `command not found`，先执行：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

安装完成后可以打开交互式控制界面：

```bash
btc-monitorctl menu
```

直接运行 `btc-monitorctl` 也会打开菜单。`btc-monitorctl --help` 会显示全部命令。

菜单包含启动、停止、重启、状态、日志、QQ Bot 导入与测试、当前价基准、指定价基准和配置查看。

`qqbot import` 会交互式保存 QQ Bot AppID、Client Secret 和目标 OpenID 到
`~/.config/btc-realtime-monitor/qqbot.env`，文件权限为 600。目标格式为
`c2c:OPENID` 或 `group:OPENID`；QQ 号码不能代替 OpenID。
如果检测到 `~/.openclaw/openclaw.json`，脚本会只读取其中的 QQ Bot AppID 和
Client Secret 作为迁移默认值；目标 OpenID 仍需确认。
QQ Bot 主动消息还受 QQ 平台的权限、用户接收设置和频率限制影响。

服务控制命令：

```bash
btc-monitorctl open       # start
btc-monitorctl close      # stop
btc-monitorctl restart
btc-monitorctl status
btc-monitorctl logs
btc-monitorctl test-alert
```

调整基准价：

```bash
btc-monitorctl baseline show
btc-monitorctl baseline current
btc-monitorctl baseline 100000
```

如果实时服务正在运行，`btc-monitorctl` 会在修改基准价时短暂停止并自动恢复服务。

## 本地验证

```bash
cd /path/to/btc-monitor-local
node --check btc-realtime-monitor.mjs
node btc-realtime-monitor.test.mjs
node btc-realtime-monitor.mjs --once --dry-run
```

发送一条明确标注的链路测试消息（不会改变基准或去重状态）：

```bash
btc-monitorctl test-alert
```

实时服务确认正常后，应禁用旧的五分钟 QQ 轮询任务，避免重复预警。

## 文件

- `btc-realtime-monitor.mjs`：实时服务。
- `btc-realtime-monitor.test.mjs`：无网络、无消息发送的单元测试。
- `config.json`：阈值、QQ 目标、网络与重试参数。
- `btc-realtime-monitor.service`：用户级 systemd 单元。
- `btc-monitor.mjs`：旧版五分钟 REST 轮询实现，仅保留作参考，不由实时服务调用。
- `install.sh`：生成用户级服务并安装控制命令。
- `install-from-github.sh`：从 GitHub 拉取或更新代码后执行安装。
- `btc-monitorctl`：启动、停止、查看服务、导入 QQ Bot 和调整基准价。
- `scripts/import-qqbot.sh`：安全导入 QQ Bot 凭据。
