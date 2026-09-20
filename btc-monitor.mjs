#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QQBotHttpClient } from "./btc-realtime-monitor.mjs";

const programDir = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.join(programDir, "config.json");

function parseArgs(argv) {
  const args = { once: false, dryRun: false, configPath: defaultConfigPath };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") args.once = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--config") args.configPath = path.resolve(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node btc-monitor.mjs [--once] [--dry-run] [--config path]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function loadConfig(configPath) {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const configDir = path.dirname(configPath);
  const qqBotRaw = config.qqBot ?? {};
  const apiBaseUrl = String(process.env.QQBOT_API_BASE ?? qqBotRaw.apiBaseUrl ?? "https://api.bot.qq.com").replace(/\/$/u, "");
  return {
    ...config,
    intervalMs: Number(config.intervalMs ?? 300000),
    baselineThresholdPct: Number(config.baselineThresholdPct ?? 0.5),
    largeMovePct: Number(config.largeMovePct ?? 1),
    majorMovePct: Number(config.majorMovePct ?? 2),
    stateFile: path.resolve(configDir, config.stateFile ?? "./data/state.json"),
    messageTimeoutMs: Number(config.messageTimeoutMs ?? 60000),
    qqBot: {
      apiBaseUrl,
      authUrl: String(process.env.QQBOT_AUTH_URL ?? qqBotRaw.authUrl ?? "https://api.bot.qq.com/app/getAppAccessToken").replace(
        "https://bots.qq.com/app/getAppAccessToken",
        "https://api.bot.qq.com/app/getAppAccessToken",
      ),
      appId: String(process.env.QQBOT_APP_ID ?? qqBotRaw.appId ?? ""),
      clientSecret: String(process.env.QQBOT_CLIENT_SECRET ?? qqBotRaw.clientSecret ?? ""),
      target: String(process.env.QQBOT_TARGET ?? qqBotRaw.target ?? config.qqTarget ?? ""),
    },
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function readMarket(config) {
  const base = config.marketApiBase.replace(/\/$/u, "");
  const params = new URLSearchParams({ symbol: config.symbol, interval: "1m", limit: "6" });
  const [klines, ticker, day] = await Promise.all([
    fetchJson(`${base}/api/v3/klines?${params}`),
    fetchJson(`${base}/api/v3/ticker/price?symbol=${encodeURIComponent(config.symbol)}`),
    fetchJson(`${base}/api/v3/ticker/24hr?symbol=${encodeURIComponent(config.symbol)}`),
  ]);
  if (!Array.isArray(klines) || klines.length < 6 || !ticker?.price) {
    throw new Error("market API returned incomplete data");
  }
  const currentPrice = Number(ticker.price);
  const fiveMinuteStart = Number(klines[0][4]);
  const fiveMinuteChangePct = ((currentPrice - fiveMinuteStart) / fiveMinuteStart) * 100;
  const dayChangePct = Number(day?.priceChangePercent);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(fiveMinuteChangePct)) {
    throw new Error("market API returned invalid numeric data");
  }
  return { currentPrice, fiveMinuteChangePct, dayChangePct };
}

async function readState(stateFile) {
  try {
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    return Number.isFinite(Number(state.baselinePrice)) ? state : {};
  } catch {
    return {};
  }
}

async function writeState(stateFile, baselinePrice) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const tempFile = `${stateFile}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify({ baselinePrice, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  await fs.rename(tempFile, stateFile);
}

function formatPrice(value) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

async function runOnce(config, dryRun) {
  const now = new Date().toISOString();
  const market = await readMarket(config);
  const state = await readState(config.stateFile);
  const hadBaseline = Number.isFinite(Number(state.baselinePrice));
  const baselinePrice = hadBaseline ? Number(state.baselinePrice) : market.currentPrice;
  const baselineChangePct = ((market.currentPrice - baselinePrice) / baselinePrice) * 100;
  const absoluteFiveMinute = Math.abs(market.fiveMinuteChangePct);
  const absoluteBaseline = Math.abs(baselineChangePct);
  const major = absoluteFiveMinute >= config.majorMovePct;
  const large = absoluteFiveMinute >= config.largeMovePct;
  const baselineAlert = absoluteBaseline >= config.baselineThresholdPct;

  const qqReasons = [];
  if (baselineAlert) qqReasons.push(`相对基准价${baselineChangePct >= 0 ? "上涨" : "下跌"} ${absoluteBaseline.toFixed(2)}%`);
  if (major) qqReasons.push(`近5分钟${market.fiveMinuteChangePct >= 0 ? "上涨" : "下跌"} ${absoluteFiveMinute.toFixed(2)}%（重大波动）`);
  else if (large) qqReasons.push(`近5分钟${market.fiveMinuteChangePct >= 0 ? "上涨" : "下跌"} ${absoluteFiveMinute.toFixed(2)}%（较大波动）`);

  if (qqReasons.length === 0) {
    if (!hadBaseline && !dryRun) await writeState(config.stateFile, market.currentPrice);
    console.log(`[${now}] No QQ alert.`);
    return;
  }

  const qqMessage = [
    `【BTC ${major ? "重大波动" : large ? "较大波动" : "基准价提醒"}】`,
    qqReasons.join("；"),
    `当前价格：$${formatPrice(market.currentPrice)}`,
    "已将当前价格设为新的基准价。",
    "仅作风险提醒，不构成确定性买卖指令。",
  ].join("\n");
  if (dryRun) {
    console.log(`[dry-run] qqbot -> ${config.qqBot.target}:\n${qqMessage}`);
  } else {
    const qqClient = new QQBotHttpClient(config.qqBot, config.messageTimeoutMs);
    await qqClient.sendText(qqMessage);
  }
  if (!dryRun) await writeState(config.stateFile, market.currentPrice);
  console.log(`[${now}] QQ alert sent.`);
}

const args = parseArgs(process.argv.slice(2));
const config = await loadConfig(args.configPath);

if (args.once) {
  await runOnce(config, args.dryRun);
} else {
  console.log(`BTC local monitor started; interval=${config.intervalMs}ms`);
  while (true) {
    try {
      await runOnce(config, args.dryRun);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  }
}
