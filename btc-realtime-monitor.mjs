#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const programDir = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.join(programDir, "config.json");

function parseArgs(argv) {
  const args = {
    configPath: defaultConfigPath,
    dryRun: false,
    once: false,
    testAlert: false,
    showBaseline: false,
    setBaseline: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("--config requires a path");
      args.configPath = path.resolve(value);
      index += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--once") {
      args.once = true;
    } else if (arg === "--test-alert") {
      args.testAlert = true;
    } else if (arg === "--show-baseline") {
      args.showBaseline = true;
    } else if (arg === "--set-baseline") {
      const value = argv[index + 1];
      if (!value) throw new Error("--set-baseline requires PRICE or current");
      args.setBaseline = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node btc-realtime-monitor.mjs [options]",
        "",
        "Options:",
        "  --config PATH   Configuration file (default: ./config.json)",
        "  --dry-run       Print alerts without sending or changing state",
        "  --once          Fetch one REST snapshot, evaluate, and exit",
        "  --test-alert    Send one clearly labelled test alert and exit",
        "  --show-baseline Print the current baseline state",
        "  --set-baseline  Set baseline to PRICE or the current market price",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function asPositiveNumber(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function asNonNegativeNumber(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function resolveFrom(baseDir, value) {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function configOrEnv(value, envName, fallback = "") {
  const fromEnv = process.env[envName];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  const text = String(value ?? "").trim();
  if (/^\$\{[^}]+\}$/u.test(text)) return fallback;
  return text || fallback;
}

function normalizeQQAuthUrl(value) {
  const url = String(value ?? "").trim();
  // QQ's current official token endpoint is under api.bot.qq.com. Keep
  // existing installations that still have the retired bots.qq.com URL
  // working without requiring users to edit their protected env file first.
  if (url === "https://bots.qq.com/app/getAppAccessToken") {
    return "https://api.bot.qq.com/app/getAppAccessToken";
  }
  return url;
}

export async function loadConfig(configPath = defaultConfigPath) {
  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  const configDir = path.dirname(configPath);
  const symbol = String(raw.symbol ?? "BTCUSDT").toUpperCase();
  const streamName = `${symbol.toLowerCase()}@aggTrade`;
  const qqBotRaw = raw.qqBot ?? {};
  const qqApiBaseUrl = String(
    configOrEnv(qqBotRaw.apiBaseUrl, "QQBOT_API_BASE", "https://api.bot.qq.com"),
  ).replace(/\/$/u, "");

  const config = {
    symbol,
    marketApiBase: String(raw.marketApiBase ?? "https://api.binance.com").replace(/\/$/u, ""),
    marketWsUrl: String(raw.marketWsUrl ?? `wss://stream.binance.com:9443/ws/${streamName}`),
    alertProvider: String(configOrEnv(raw.alertProvider, "BTC_ALERT_PROVIDER", "qqbot-http")).toLowerCase(),
    qqTarget: configOrEnv(raw.qqTarget, "QQBOT_TARGET", ""),
    qqBot: {
      apiBaseUrl: qqApiBaseUrl,
      authUrl: normalizeQQAuthUrl(configOrEnv(
        qqBotRaw.authUrl,
        "QQBOT_AUTH_URL",
        "https://api.bot.qq.com/app/getAppAccessToken",
      )),
      appId: configOrEnv(qqBotRaw.appId, "QQBOT_APP_ID"),
      clientSecret: configOrEnv(qqBotRaw.clientSecret, "QQBOT_CLIENT_SECRET"),
      target: configOrEnv(qqBotRaw.target, "QQBOT_TARGET", configOrEnv(raw.qqTarget, "QQBOT_TARGET", "")),
    },
    stateFile: resolveFrom(configDir, String(raw.stateFile ?? "./data/baseline-state.json")),
    runtimeStateFile: resolveFrom(configDir, String(raw.runtimeStateFile ?? "./data/realtime-status.json")),
    lockFile: resolveFrom(configDir, String(raw.lockFile ?? "./data/realtime-monitor.lock")),
    timezone: String(raw.timezone ?? "Asia/Shanghai"),
    day: {
      baselineThresholdPct: asPositiveNumber(raw.day?.baselineThresholdPct, 0.5, "day.baselineThresholdPct"),
      rolling5mThresholdPct: asPositiveNumber(raw.day?.rolling5mThresholdPct, 0.2, "day.rolling5mThresholdPct"),
    },
    night: {
      start: String(raw.night?.start ?? "23:00"),
      end: String(raw.night?.end ?? "06:40"),
      baselineThresholdPct: asPositiveNumber(raw.night?.baselineThresholdPct, 1.2, "night.baselineThresholdPct"),
      rolling5mThresholdPct: asPositiveNumber(raw.night?.rolling5mThresholdPct, 0.6, "night.rolling5mThresholdPct"),
    },
    rollingWindowMs: asPositiveNumber(raw.rollingWindowMs, 300_000, "rollingWindowMs"),
    historySampleIntervalMs: asPositiveNumber(raw.historySampleIntervalMs, 250, "historySampleIntervalMs"),
    historyMaxGapMs: asPositiveNumber(raw.historyMaxGapMs, 10_000, "historyMaxGapMs"),
    evaluationIntervalMs: asPositiveNumber(raw.evaluationIntervalMs, 250, "evaluationIntervalMs"),
    rollingAlertCooldownMs: asNonNegativeNumber(raw.rollingAlertCooldownMs, 0, "rollingAlertCooldownMs"),
    rollingRearmRatio: Number(raw.rollingRearmRatio ?? 0.7),
    rollingEscalationStepPct: Number(raw.rollingEscalationStepPct ?? 0.2),
    deliveryRetryMs: asPositiveNumber(raw.deliveryRetryMs, 15_000, "deliveryRetryMs"),
    messageTimeoutMs: asPositiveNumber(raw.messageTimeoutMs, 60_000, "messageTimeoutMs"),
    httpTimeoutMs: asPositiveNumber(raw.httpTimeoutMs, 10_000, "httpTimeoutMs"),
    staleStreamMs: asPositiveNumber(raw.staleStreamMs, 20_000, "staleStreamMs"),
    restFallbackIntervalMs: asPositiveNumber(raw.restFallbackIntervalMs, 5_000, "restFallbackIntervalMs"),
    healthWriteIntervalMs: asPositiveNumber(raw.healthWriteIntervalMs, 30_000, "healthWriteIntervalMs"),
    reconnectInitialMs: asPositiveNumber(raw.reconnectInitialMs, 1_000, "reconnectInitialMs"),
    reconnectMaxMs: asPositiveNumber(raw.reconnectMaxMs, 30_000, "reconnectMaxMs"),
  };

  if (!config.qqBot.target) throw new Error("qqBot.target or QQBOT_TARGET is required");
  if (!(config.rollingRearmRatio > 0 && config.rollingRearmRatio < 1)) {
    throw new Error("rollingRearmRatio must be between 0 and 1");
  }
  if (!(config.rollingEscalationStepPct > 0)) {
    throw new Error("rollingEscalationStepPct must be positive");
  }

  parseClock(config.night.start);
  parseClock(config.night.end);
  return config;
}

function parseClock(value) {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error(`Invalid clock time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid clock time: ${value}`);
  return hour * 60 + minute;
}

function zonedMinuteOfDay(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

export function getRuleBand(date, config) {
  const current = zonedMinuteOfDay(date, config.timezone);
  const start = parseClock(config.night.start);
  const end = parseClock(config.night.end);
  const isNight = start <= end
    ? current >= start && current < end
    : current >= start || current < end;
  const rules = isNight ? config.night : config.day;
  return {
    label: isNight ? "夜间" : "日间",
    baselineThresholdPct: rules.baselineThresholdPct,
    rolling5mThresholdPct: rules.rolling5mThresholdPct,
  };
}

export function isBaselineAlert(currentPrice, baselinePrice, thresholdPct) {
  if (
    !Number.isFinite(currentPrice)
    || !Number.isFinite(baselinePrice)
    || baselinePrice <= 0
    || !Number.isFinite(thresholdPct)
    || thresholdPct <= 0
  ) return false;
  const changePct = ((currentPrice - baselinePrice) / baselinePrice) * 100;
  return Math.abs(changePct) >= thresholdPct;
}

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`Cannot read valid JSON from ${filePath}: ${error?.message ?? error}`, { cause: error });
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "btc-realtime-monitor/1.0" },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseQQTarget(rawTarget) {
  const target = String(rawTarget ?? "").trim();
  const match = /^(?:qqbot:)?(c2c|direct|user|group):(.+)$/iu.exec(target);
  if (!match || !match[2].trim()) {
    throw new Error("QQBOT_TARGET must be c2c:OPENID or group:OPENID");
  }
  const kind = match[1].toLowerCase() === "group" ? "group" : "c2c";
  return { kind, openid: match[2].trim() };
}

export class QQBotHttpClient {
  constructor(config, timeoutMs = 60_000) {
    const mergedConfig = {
      apiBaseUrl: "https://api.bot.qq.com",
      authUrl: "https://api.bot.qq.com/app/getAppAccessToken",
      ...config,
    };
    this.config = {
      ...mergedConfig,
      authUrl: normalizeQQAuthUrl(mergedConfig.authUrl),
    };
    this.timeoutMs = timeoutMs;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.nextMessageSequence = Math.floor(Math.random() * 65_535) + 1;
  }

  async requestJson(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      if (!response.ok) {
        const detail = body?.message || body?.msg || body?.raw || `${response.status} ${response.statusText}`;
        const error = new Error(`QQ Bot API ${response.status}: ${detail}`);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getAccessToken(force = false) {
    if (!force && this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }
    const appId = String(this.config.appId ?? "").trim();
    const clientSecret = String(this.config.clientSecret ?? "").trim();
    if (!appId || !clientSecret) {
      throw new Error("QQ Bot credentials are missing; run btc-monitorctl qqbot import");
    }
    const body = await this.requestJson(this.config.authUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId, clientSecret }),
    });
    const token = String(body?.access_token ?? "").trim();
    const expiresIn = Number(body?.expires_in ?? 7200);
    if (!token) {
      const code = body?.code ?? body?.err_code ?? body?.error_code;
      const detail = body?.message ?? body?.msg ?? body?.error_description;
      const reason = [
        code === undefined || code === null ? "" : `code=${code}`,
        detail ? String(detail) : "",
      ].filter(Boolean).join(", ");
      const suffix = reason ? ` (${reason})` : "";
      throw new Error(
        `QQ Bot token request returned no access_token${suffix}; check AppID, Client Secret, and auth endpoint ${this.config.authUrl}`,
      );
    }
    this.accessToken = token;
    this.accessTokenExpiresAt = Date.now() + Math.max((Number.isFinite(expiresIn) ? expiresIn : 7200) * 1000 - 60_000, 1_000);
    return token;
  }

  async sendText(message) {
    const { kind, openid } = parseQQTarget(this.config.target);
    const pathPart = kind === "group" ? "groups" : "users";
    const url = `${this.config.apiBaseUrl}/v2/${pathPart}/${encodeURIComponent(openid)}/messages`;
    const msgSeq = this.nextMessageSequence;
    this.nextMessageSequence = (this.nextMessageSequence % 65_535) + 1;
    const sendWithToken = async (forceRefresh) => {
      const token = await this.getAccessToken(forceRefresh);
      return this.requestJson(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `QQBot ${token}`,
          "x-union-appid": String(this.config.appId ?? "").trim(),
        },
        body: JSON.stringify({
          msg_type: 0,
          content: String(message),
          msg_seq: msgSeq,
        }),
      });
    };

    try {
      return await sendWithToken(false);
    } catch (error) {
      if (error?.status !== 401) throw error;
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
      return sendWithToken(true);
    }
  }
}

export class PriceHistory {
  constructor({ windowMs, sampleIntervalMs, maxGapMs }) {
    this.windowMs = windowMs;
    this.sampleIntervalMs = sampleIntervalMs;
    this.maxGapMs = maxGapMs;
    this.samples = [];
  }

  replace(samples) {
    this.samples = [];
    for (const sample of samples
      .filter((item) => Number.isFinite(item?.ts) && Number.isFinite(item?.price) && item.price > 0)
      .sort((left, right) => left.ts - right.ts)) {
      this.add(sample.ts, sample.price, true);
    }
  }

  add(ts, price, force = false) {
    if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) return;
    const last = this.samples.at(-1);
    if (last && ts < last.ts) return;

    if (last && ts === last.ts) {
      last.price = price;
    } else if (!force && last && Math.floor(ts / this.sampleIntervalMs) === Math.floor(last.ts / this.sampleIntervalMs)) {
      last.ts = ts;
      last.price = price;
    } else {
      this.samples.push({ ts, price });
    }
    this.prune(ts);
  }

  prune(nowTs) {
    const cutoff = nowTs - this.windowMs;
    while (this.samples.length > 2 && this.samples[1].ts <= cutoff) {
      this.samples.shift();
    }
    const hardLimit = Math.ceil(this.windowMs / Math.max(this.sampleIntervalMs, 1)) + 200;
    if (this.samples.length > hardLimit) {
      this.samples.splice(0, this.samples.length - hardLimit);
    }
  }

  changePct(nowTs, currentPrice) {
    if (this.samples.length === 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;
    const targetTs = nowTs - this.windowMs;
    let low = 0;
    let high = this.samples.length - 1;
    let beforeIndex = -1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.samples[middle].ts <= targetTs) {
        beforeIndex = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    const candidates = [];
    if (beforeIndex >= 0) candidates.push(this.samples[beforeIndex]);
    if (beforeIndex + 1 < this.samples.length) candidates.push(this.samples[beforeIndex + 1]);
    if (candidates.length === 0) return null;
    const baseline = candidates.reduce((best, item) => (
      Math.abs(item.ts - targetTs) < Math.abs(best.ts - targetTs) ? item : best
    ));
    const gapMs = Math.abs(baseline.ts - targetTs);
    if (gapMs > this.maxGapMs) return null;

    return {
      changePct: ((currentPrice - baseline.price) / baseline.price) * 100,
      startPrice: baseline.price,
      startTs: baseline.ts,
      gapMs,
    };
  }
}

function cleanRollingState(input = {}) {
  return {
    band: typeof input.band === "string" ? input.band : null,
    active: Boolean(input.active),
    direction: Number(input.direction) || 0,
    alertedMagnitudePct: Number(input.alertedMagnitudePct) || 0,
    lastAlertAtMs: Number(input.lastAlertAtMs) || 0,
  };
}

export function decideRollingAlert(inputState, changePct, band, nowMs, config) {
  let state = cleanRollingState(inputState);
  let stateChanged = false;

  if (state.band !== band.label) {
    state = {
      ...state,
      band: band.label,
      active: false,
      direction: 0,
      alertedMagnitudePct: 0,
    };
    stateChanged = true;
  }

  if (!Number.isFinite(changePct)) {
    return { shouldAlert: false, reason: null, state, stateChanged, stateOnSuccess: state };
  }

  const magnitude = Math.abs(changePct);
  const direction = Math.sign(changePct);
  const threshold = band.rolling5mThresholdPct;
  const rearmBelow = threshold * config.rollingRearmRatio;

  if (state.active && magnitude < rearmBelow) {
    state = {
      ...state,
      active: false,
      direction: 0,
      alertedMagnitudePct: 0,
    };
    stateChanged = true;
  }

  if (magnitude < threshold) {
    return { shouldAlert: false, reason: null, state, stateChanged, stateOnSuccess: state };
  }

  const cooldownReady = state.lastAlertAtMs === 0
    || nowMs - state.lastAlertAtMs >= config.rollingAlertCooldownMs;
  let reason = null;
  if (!state.active && cooldownReady) {
    reason = "threshold-crossed";
  } else if (state.active && state.direction !== direction && cooldownReady) {
    reason = "direction-reversed";
  } else if (
    state.active
    && cooldownReady
    && magnitude >= state.alertedMagnitudePct + config.rollingEscalationStepPct
  ) {
    reason = "movement-escalated";
  }

  const stateOnSuccess = reason
    ? {
        ...state,
        band: band.label,
        active: true,
        direction,
        alertedMagnitudePct: magnitude,
        lastAlertAtMs: nowMs,
      }
    : state;

  return {
    shouldAlert: Boolean(reason),
    reason,
    state,
    stateChanged,
    stateOnSuccess,
  };
}

function formatPrice(value) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatSignedPct(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatLocalTime(timestamp, timezone) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

export function buildAlertMessage({
  timestamp,
  timezone,
  price,
  source,
  band,
  baseline,
  rolling,
  test = false,
}) {
  let title = "【BTC实时预警】";
  if (test) title = "【BTC实时监测测试】";
  else if (baseline?.triggered && rolling?.triggered) title = "【基准涨跌预警 + 5min滚动预警】";
  else if (baseline?.triggered) title = "【基准涨跌预警】";
  else if (rolling?.triggered) title = "【5min滚动预警】";
  const lines = [title];
  lines.push(`当前价格：$${formatPrice(price)}`);

  if (baseline?.triggered) {
    const direction = baseline.changePct >= 0 ? "上涨" : "下跌";
    lines.push(
      `• 基准价：相对 $${formatPrice(baseline.price)} ${direction} ${Math.abs(baseline.changePct).toFixed(2)}%`
      + `（${band.label}阈值 ${band.baselineThresholdPct.toFixed(1)}%）`,
    );
  }

  if (rolling?.triggered) {
    const direction = rolling.changePct >= 0 ? "上涨" : "下跌";
    lines.push(
      `• 滚动5分钟：${direction} ${Math.abs(rolling.changePct).toFixed(2)}%`
      + `（${band.label}阈值 ${band.rolling5mThresholdPct.toFixed(1)}%）`,
    );
  }

  if (test) {
    if (baseline && !baseline.triggered) lines.push(`基准价变化：${formatSignedPct(baseline.changePct)}`);
    if (rolling && !rolling.triggered) lines.push(`滚动5分钟变化：${formatSignedPct(rolling.changePct)}`);
    lines.push("通知链路测试成功后，真实预警会使用同一通道发送。");
  } else {
    lines.push("已实时捕捉阈值穿越；请注意短线波动风险。");
  }

  lines.push(`时间：${formatLocalTime(timestamp, timezone)}（${timezone}）`);
  lines.push(`数据源：Binance ${source === "websocket" ? "WebSocket" : "REST 后备通道"}`);
  lines.push("仅作行情风险提醒，不构成投资建议；不会执行交易。");
  return lines.join("\n");
}

export class RealtimeBtcMonitor {
  constructor(config, { dryRun = false, readOnlyState = false } = {}) {
    this.config = config;
    this.dryRun = dryRun;
    this.readOnlyState = readOnlyState;
    this.history = new PriceHistory({
      windowMs: config.rollingWindowMs,
      sampleIntervalMs: config.historySampleIntervalMs,
      maxGapMs: config.historyMaxGapMs,
    });
    this.baseline = {};
    this.runtime = {};
    this.latest = null;
    this.ws = null;
    this.connected = false;
    this.stopping = false;
    this.restInFlight = false;
    this.evaluationInFlight = false;
    this.lastEvaluationAtMs = 0;
    this.nextDeliveryAttemptAtMs = 0;
    this.lastWebSocketMessageAtMs = 0;
    this.reconnectDelayMs = config.reconnectInitialMs;
    this.nextRestAttemptAtMs = 0;
    this.restRetryDelayMs = config.restFallbackIntervalMs;
    this.reconnectTimer = null;
    this.fallbackTimer = null;
    this.healthTimer = null;
    this.staleTimer = null;
    this.runtimeWrite = Promise.resolve();
    this.startedAt = new Date().toISOString();
    this.lockOwned = false;
    this.qqClient = new QQBotHttpClient(config.qqBot, config.messageTimeoutMs);
  }

  log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
  }

  async initialize({ evaluate = true } = {}) {
    this.baseline = await readJson(this.config.stateFile, {});
    if (
      Object.hasOwn(this.baseline, "baselinePrice")
      && (!Number.isFinite(Number(this.baseline.baselinePrice)) || Number(this.baseline.baselinePrice) <= 0)
    ) {
      throw new Error(`Invalid baselinePrice in ${this.config.stateFile}`);
    }
    const savedRuntime = await readJson(this.config.runtimeStateFile, {});
    this.runtime = {
      rolling: cleanRollingState(savedRuntime.rolling),
      lastAlertAt: savedRuntime.lastAlertAt ?? null,
      reconnectCount: Number(savedRuntime.reconnectCount) || 0,
      lastError: null,
      lastAlertFingerprint: savedRuntime.lastAlertFingerprint ?? null,
    };

    const snapshot = await this.fetchRestSnapshot();
    this.history.replace(snapshot.samples);
    this.recordPrice(snapshot.timestamp, snapshot.price, "rest", true);

    if (!Number.isFinite(Number(this.baseline.baselinePrice)) || Number(this.baseline.baselinePrice) <= 0) {
      this.baseline = {
        baselinePrice: snapshot.price,
        updatedAt: new Date(snapshot.timestamp).toISOString(),
      };
      if (!this.dryRun && !this.readOnlyState) await atomicWriteJson(this.config.stateFile, this.baseline);
      this.log(`Baseline initialized at $${formatPrice(snapshot.price)}`);
    }

    if (evaluate) await this.evaluateLatest(true);
    await this.persistRuntime("initialized");
  }

  async setBaseline(value) {
    let price;
    if (String(value).trim().toLowerCase() === "current") {
      const snapshot = await this.fetchRestSnapshot();
      price = snapshot.price;
    } else {
      price = Number(value);
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("Baseline must be a positive price or the value current");
    }
    const state = {
      baselinePrice: price,
      updatedAt: new Date().toISOString(),
      source: "manual",
    };
    if (this.dryRun) {
      console.log(`[dry-run] baseline would be set to $${formatPrice(price)}`);
      return state;
    }
    await atomicWriteJson(this.config.stateFile, state);
    this.baseline = state;
    console.log(`Baseline set to $${formatPrice(price)}`);
    return state;
  }

  async fetchRestSnapshot() {
    const limit = Math.min(1000, Math.ceil(this.config.rollingWindowMs / 1000) + 3);
    const params = new URLSearchParams({
      symbol: this.config.symbol,
      interval: "1s",
      limit: String(limit),
    });
    const tickerParams = new URLSearchParams({ symbol: this.config.symbol });
    const [klines, ticker] = await Promise.all([
      fetchJson(`${this.config.marketApiBase}/api/v3/klines?${params}`, this.config.httpTimeoutMs),
      fetchJson(`${this.config.marketApiBase}/api/v3/ticker/price?${tickerParams}`, this.config.httpTimeoutMs),
    ]);

    if (!Array.isArray(klines) || klines.length < Math.floor(this.config.rollingWindowMs / 1000) - 5) {
      throw new Error("Binance returned insufficient 1-second kline history");
    }
    const price = Number(ticker?.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error("Binance returned an invalid ticker price");

    const samples = klines.map((row) => ({ ts: Number(row[6]), price: Number(row[4]) }));
    return { samples, price, timestamp: Date.now() };
  }

  recordPrice(timestamp, price, source, forceSample = false) {
    if (!Number.isFinite(timestamp) || !Number.isFinite(price) || price <= 0) return;
    this.history.add(timestamp, price, forceSample);
    this.latest = { timestamp, price, source };
    if (source === "websocket") this.lastWebSocketMessageAtMs = Date.now();
  }

  requestEvaluation() {
    if (this.evaluationInFlight) return;
    if (Date.now() - this.lastEvaluationAtMs < this.config.evaluationIntervalMs) return;
    this.evaluationInFlight = true;
    void this.evaluateLatest(false)
      .catch((error) => {
        this.runtime.lastError = String(error?.message ?? error);
        this.log(`Evaluation error: ${this.runtime.lastError}`);
      })
      .finally(() => { this.evaluationInFlight = false; });
  }

  async evaluateLatest(force = false) {
    if (!this.latest) return;
    const nowMs = Date.now();
    if (!force && nowMs - this.lastEvaluationAtMs < this.config.evaluationIntervalMs) return;
    this.lastEvaluationAtMs = nowMs;

    const { timestamp, price, source } = this.latest;
    const band = getRuleBand(new Date(timestamp), this.config);
    const baselinePrice = Number(this.baseline.baselinePrice);
    const baselineChangePct = ((price - baselinePrice) / baselinePrice) * 100;
    const baselineTriggered = isBaselineAlert(price, baselinePrice, band.baselineThresholdPct);
    const rollingSnapshot = this.history.changePct(timestamp, price);
    const rollingChangePct = rollingSnapshot?.changePct ?? null;
    const rollingDecision = decideRollingAlert(
      this.runtime.rolling,
      rollingChangePct,
      band,
      timestamp,
      this.config,
    );

    if (rollingDecision.stateChanged) {
      this.runtime.rolling = rollingDecision.state;
      if (!this.dryRun && !this.readOnlyState) await this.persistRuntime("rolling-state-updated");
    }

    this.runtime.current = {
      price,
      timestamp: new Date(timestamp).toISOString(),
      source,
      band: band.label,
      baselinePrice,
      baselineChangePct,
      rolling5mChangePct: rollingChangePct,
    };

    if (!baselineTriggered && !rollingDecision.shouldAlert) return;
    if (nowMs < this.nextDeliveryAttemptAtMs) return;

    const message = buildAlertMessage({
      timestamp,
      timezone: this.config.timezone,
      price,
      source,
      band,
      baseline: {
        triggered: baselineTriggered,
        price: baselinePrice,
        changePct: baselineChangePct,
      },
      rolling: rollingChangePct === null ? null : {
        triggered: rollingDecision.shouldAlert,
        changePct: rollingChangePct,
      },
    });

    const alertFingerprint = [
      Math.floor(timestamp / 1000),
      price.toFixed(2),
      baselineTriggered ? "baseline" : "",
      rollingDecision.shouldAlert ? `rolling:${rollingDecision.reason}` : "",
    ].join(":");
    this.log(`Delivering alert ${alertFingerprint}`);
    let deliveredAtMs;
    try {
      await this.sendMessage(message);
      deliveredAtMs = Date.now();
      this.nextDeliveryAttemptAtMs = 0;
    } catch (error) {
      this.nextDeliveryAttemptAtMs = Date.now() + this.config.deliveryRetryMs;
      throw error;
    }
    this.log(`Alert delivered: baseline=${baselineTriggered}, rolling5m=${rollingDecision.shouldAlert}, price=$${formatPrice(price)}`);

    if (this.dryRun || this.readOnlyState) return;
    if (baselineTriggered) {
      this.baseline = { baselinePrice: price, updatedAt: new Date(timestamp).toISOString() };
      await atomicWriteJson(this.config.stateFile, this.baseline);
    }
    if (rollingDecision.shouldAlert) {
      this.runtime.rolling = {
        ...rollingDecision.stateOnSuccess,
        lastAlertAtMs: deliveredAtMs,
      };
    }
    this.runtime.lastAlertAt = new Date(deliveredAtMs).toISOString();
    this.runtime.lastAlertFingerprint = alertFingerprint;
    this.runtime.lastError = null;
    await this.persistRuntime("alert-delivered");
  }

  async sendMessage(message) {
    if (this.dryRun) {
      console.log(`[dry-run] qqbot -> ${this.config.qqBot.target}\n${message}`);
      return;
    }
    if (this.config.alertProvider !== "qqbot-http") {
      throw new Error(`Unsupported alert provider: ${this.config.alertProvider}`);
    }
    await this.qqClient.sendText(message);
  }

  async sendTestAlert() {
    if (!this.latest) throw new Error("No market snapshot is available");
    const { timestamp, price, source } = this.latest;
    const band = getRuleBand(new Date(timestamp), this.config);
    const baselinePrice = Number(this.baseline.baselinePrice);
    const baselineChangePct = ((price - baselinePrice) / baselinePrice) * 100;
    const rollingChangePct = this.history.changePct(timestamp, price)?.changePct ?? 0;
    const message = buildAlertMessage({
      timestamp,
      timezone: this.config.timezone,
      price,
      source,
      band,
      baseline: { triggered: false, price: baselinePrice, changePct: baselineChangePct },
      rolling: { triggered: false, changePct: rollingChangePct },
      test: true,
    });
    await this.sendMessage(message);
    this.log("Test alert delivered without changing alert state");
  }

  async refreshRestFallback() {
    if (
      this.restInFlight
      || this.stopping
      || this.connected
      || Date.now() < this.nextRestAttemptAtMs
    ) return;
    this.restInFlight = true;
    try {
      const snapshot = await this.fetchRestSnapshot();
      this.history.replace(snapshot.samples);
      this.recordPrice(snapshot.timestamp, snapshot.price, "rest", true);
      await this.evaluateLatest(true);
      this.runtime.lastError = null;
      this.log(`REST fallback snapshot received at $${formatPrice(snapshot.price)}`);
      this.restRetryDelayMs = this.config.restFallbackIntervalMs;
      this.nextRestAttemptAtMs = 0;
    } catch (error) {
      this.runtime.lastError = `REST fallback: ${String(error?.message ?? error)}`;
      this.log(this.runtime.lastError);
      this.nextRestAttemptAtMs = Date.now() + this.restRetryDelayMs;
      this.restRetryDelayMs = Math.min(this.restRetryDelayMs * 2, 60_000);
    } finally {
      this.restInFlight = false;
    }
  }

  connectWebSocket() {
    if (this.stopping) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.log(`Connecting to ${this.config.marketWsUrl}`);
    const ws = new WebSocket(this.config.marketWsUrl);
    this.ws = ws;
    const connectionWatchdog = setTimeout(() => {
      if (this.ws !== ws || this.connected || this.stopping) return;
      this.runtime.lastError = `WebSocket connection timed out after ${this.config.staleStreamMs}ms`;
      this.log(this.runtime.lastError);
      this.ws = null;
      try { ws.close(4001, "connection timeout"); } catch { /* no-op */ }
      this.scheduleReconnect();
    }, this.config.staleStreamMs);

    ws.addEventListener("open", () => {
      if (this.ws !== ws || this.stopping) return;
      clearTimeout(connectionWatchdog);
      this.connected = true;
      this.lastWebSocketMessageAtMs = Date.now();
      this.reconnectDelayMs = this.config.reconnectInitialMs;
      this.runtime.lastError = null;
      this.log("Binance WebSocket connected");
      void this.persistRuntime("websocket-connected");
    });

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws || this.stopping) return;
      try {
        const payload = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
        const price = Number(payload.p);
        const timestamp = Number(payload.T ?? payload.E ?? Date.now());
        if (!Number.isFinite(price) || price <= 0) throw new Error("invalid WebSocket price");
        this.recordPrice(timestamp, price, "websocket");
        this.requestEvaluation();
      } catch (error) {
        this.runtime.lastError = `WebSocket message: ${String(error?.message ?? error)}`;
        this.log(this.runtime.lastError);
      }
    });

    ws.addEventListener("error", () => {
      if (this.ws !== ws || this.stopping) return;
      this.runtime.lastError = "Binance WebSocket error";
      this.log(this.runtime.lastError);
    });

    ws.addEventListener("close", (event) => {
      clearTimeout(connectionWatchdog);
      if (this.ws !== ws) return;
      this.connected = false;
      this.ws = null;
      if (this.stopping) return;
      this.runtime.lastError = `WebSocket closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`;
      this.log(this.runtime.lastError);
      void this.persistRuntime("websocket-closed");
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const jitter = Math.floor(Math.random() * Math.min(500, this.reconnectDelayMs / 4));
    const delay = this.reconnectDelayMs + jitter;
    this.runtime.reconnectCount = (Number(this.runtime.reconnectCount) || 0) + 1;
    this.log(`Reconnecting WebSocket in ${delay}ms; REST fallback remains active`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, delay);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.config.reconnectMaxMs);
  }

  async persistRuntime(status) {
    if (this.dryRun || this.readOnlyState) return;
    const rolling = cleanRollingState(this.runtime.rolling);
    const payload = {
      version: 1,
      pid: process.pid,
      status,
      serviceStartedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      connected: this.connected,
      lastWebSocketMessageAt: this.lastWebSocketMessageAtMs
        ? new Date(this.lastWebSocketMessageAtMs).toISOString()
        : null,
      reconnectCount: Number(this.runtime.reconnectCount) || 0,
      lastError: this.runtime.lastError ?? null,
      lastAlertAt: this.runtime.lastAlertAt ?? null,
      lastAlertFingerprint: this.runtime.lastAlertFingerprint ?? null,
      rolling,
      current: this.runtime.current ?? null,
    };
    this.runtimeWrite = this.runtimeWrite
      .catch(() => {})
      .then(() => atomicWriteJson(this.config.runtimeStateFile, payload));
    await this.runtimeWrite;
  }

  async run() {
    await this.acquireLock();
    try {
      await this.initialize({ evaluate: false });
      this.connectWebSocket();
      this.evaluationInFlight = true;
      try {
        await this.evaluateLatest(true);
      } finally {
        this.evaluationInFlight = false;
      }

      this.fallbackTimer = setInterval(() => {
        void this.refreshRestFallback();
      }, this.config.restFallbackIntervalMs);

      this.healthTimer = setInterval(() => {
        void this.persistRuntime(this.connected ? "running" : "rest-fallback");
      }, this.config.healthWriteIntervalMs);

      this.staleTimer = setInterval(() => {
        if (!this.connected || !this.ws || this.stopping) return;
        const staleFor = Date.now() - this.lastWebSocketMessageAtMs;
        if (staleFor <= this.config.staleStreamMs) return;
        this.runtime.lastError = `WebSocket stale for ${staleFor}ms`;
        this.log(`${this.runtime.lastError}; forcing reconnect`);
        const staleSocket = this.ws;
        this.ws = null;
        this.connected = false;
        try { staleSocket.close(4000, "stale stream"); } catch { /* no-op */ }
        this.scheduleReconnect();
      }, Math.min(5_000, Math.max(1_000, this.config.staleStreamMs / 4)));

      await this.persistRuntime("running");
      this.log("BTC real-time monitor started; alerts only, no trading");
    } catch (error) {
      await this.releaseLock();
      throw error;
    }
  }

  async acquireLock() {
    await fs.mkdir(path.dirname(this.config.lockFile), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(this.config.lockFile, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: this.startedAt })}\n`);
        await handle.close();
        this.lockOwned = true;
        return;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = await readJson(this.config.lockFile, {});
        const existingPid = Number(existing.pid);
        let alive = false;
        if (Number.isInteger(existingPid) && existingPid > 0) {
          try {
            process.kill(existingPid, 0);
            alive = true;
          } catch (signalError) {
            alive = signalError?.code === "EPERM";
          }
        }
        if (alive) throw new Error(`Another real-time monitor is already running with PID ${existingPid}`);
        await fs.unlink(this.config.lockFile);
      }
    }
    throw new Error(`Could not acquire monitor lock ${this.config.lockFile}`);
  }

  async releaseLock() {
    if (!this.lockOwned) return;
    try {
      const existing = await readJson(this.config.lockFile, {});
      if (Number(existing.pid) === process.pid) await fs.unlink(this.config.lockFile);
    } catch (error) {
      if (error?.code !== "ENOENT") this.log(`Could not release lock: ${error?.message ?? error}`);
    } finally {
      this.lockOwned = false;
    }
  }

  async stop(signal = "SIGTERM") {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`Stopping after ${signal}`);
    for (const timer of [this.reconnectTimer, this.fallbackTimer, this.healthTimer, this.staleTimer]) {
      if (timer) clearTimeout(timer);
    }
    if (this.ws) {
      try { this.ws.close(1000, "service stopping"); } catch { /* no-op */ }
    }
    this.connected = false;
    await this.persistRuntime("stopped");
    await this.releaseLock();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.configPath);

  if (args.showBaseline && args.setBaseline !== null) {
    throw new Error("--show-baseline and --set-baseline cannot be used together");
  }

  if (args.showBaseline) {
    console.log(JSON.stringify(await readJson(config.stateFile, {}), null, 2));
    return;
  }

  if (args.setBaseline !== null) {
    const monitor = new RealtimeBtcMonitor(config, { dryRun: args.dryRun });
    if (!args.dryRun) await monitor.acquireLock();
    try {
      await monitor.setBaseline(args.setBaseline);
    } finally {
      if (!args.dryRun) await monitor.releaseLock();
    }
    return;
  }

  const monitor = new RealtimeBtcMonitor(config, {
    dryRun: args.dryRun,
    readOnlyState: args.testAlert,
  });

  if (args.testAlert) {
    await monitor.initialize({ evaluate: false });
    await monitor.sendTestAlert();
    return;
  }

  if (args.once) {
    if (!args.dryRun) await monitor.acquireLock();
    try {
      await monitor.initialize();
      const current = monitor.runtime.current;
      console.log(JSON.stringify({
        price: current?.price,
        source: current?.source,
        band: current?.band,
        baselineChangePct: current?.baselineChangePct,
        rolling5mChangePct: current?.rolling5mChangePct,
        dryRun: args.dryRun,
      }, null, 2));
    } finally {
      if (!args.dryRun) await monitor.releaseLock();
    }
    return;
  }

  const shutdown = async (signal) => {
    try {
      await monitor.stop(signal);
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  await monitor.run();
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[${new Date().toISOString()}] Fatal: ${error?.stack ?? error}`);
    process.exit(1);
  });
}
