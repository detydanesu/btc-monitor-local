#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  PriceHistory,
  buildAlertMessage,
  decideRollingAlert,
  getRuleBand,
  isBaselineAlert,
} from "./btc-realtime-monitor.mjs";

const config = {
  timezone: "Asia/Shanghai",
  day: { baselineThresholdPct: 0.5, rolling5mThresholdPct: 0.2 },
  night: {
    start: "23:00",
    end: "06:40",
    baselineThresholdPct: 1.2,
    rolling5mThresholdPct: 0.6,
  },
  rollingRearmRatio: 0.7,
  rollingAlertCooldownMs: 0,
  rollingEscalationStepPct: 0.2,
};

function testBandBoundaries() {
  const cases = [
    ["2026-08-20T22:39:59.999Z", "夜间", 1.2, 0.6], // 06:39:59 Shanghai
    ["2026-08-20T22:40:00.000Z", "日间", 0.5, 0.2], // 06:40:00 Shanghai
    ["2026-08-21T14:59:59.999Z", "日间", 0.5, 0.2], // 22:59:59 Shanghai
    ["2026-08-21T15:00:00.000Z", "夜间", 1.2, 0.6], // 23:00:00 Shanghai
  ];
  for (const [iso, label, baseline, rolling] of cases) {
    const band = getRuleBand(new Date(iso), config);
    assert.equal(band.label, label, iso);
    assert.equal(band.baselineThresholdPct, baseline, iso);
    assert.equal(band.rolling5mThresholdPct, rolling, iso);
  }
}

function testRollingHistory() {
  const history = new PriceHistory({ windowMs: 300_000, sampleIntervalMs: 250, maxGapMs: 2_000 });
  const start = 1_800_000_000_000;
  for (let second = 0; second <= 300; second += 1) {
    history.add(start + second * 1_000, second === 0 ? 100 : 100.25, true);
  }
  const result = history.changePct(start + 300_000, 100.25);
  assert.ok(result);
  assert.ok(Math.abs(result.changePct - 0.25) < 1e-10);

  const stale = new PriceHistory({ windowMs: 300_000, sampleIntervalMs: 250, maxGapMs: 1_000 });
  stale.add(start, 100, true);
  assert.equal(stale.changePct(start + 310_000, 101), null, "stale history must not create an alert");
}

function testRollingDecisions() {
  const day = getRuleBand(new Date("2026-08-21T04:00:00Z"), config); // noon Shanghai
  let state = {};

  const exactThreshold = decideRollingAlert(state, 0.2, day, 1_000_000, config);
  assert.equal(exactThreshold.shouldAlert, true, "exact positive threshold must trigger");
  assert.equal(exactThreshold.reason, "threshold-crossed");
  state = exactThreshold.stateOnSuccess;

  const repeated = decideRollingAlert(state, 0.25, day, 1_030_000, config);
  assert.equal(repeated.shouldAlert, false, "condition must not alert on every tick");

  const escalatedImmediately = decideRollingAlert(state, 0.41, day, 1_030_001, config);
  assert.equal(escalatedImmediately.shouldAlert, true, "qualifying rolling alerts must not be time-gated");
  state = escalatedImmediately.stateOnSuccess;

  assert.equal(
    isBaselineAlert(100.6, 100, day.baselineThresholdPct),
    true,
    "baseline alerts must remain independent from rolling alert deduplication",
  );

  const rearmed = decideRollingAlert(state, 0.1, day, 1_031_000, config);
  assert.equal(rearmed.shouldAlert, false);
  assert.equal(rearmed.state.active, false, "move below hysteresis must rearm");
  state = rearmed.state;

  const negative = decideRollingAlert(state, -0.2, day, 1_032_000, config);
  assert.equal(negative.shouldAlert, true, "rearmed threshold crossing must trigger without a time gate");

  const night = getRuleBand(new Date("2026-08-21T16:00:00Z"), config); // midnight Shanghai
  const belowNight = decideRollingAlert({}, 0.59, night, 2_000_000, config);
  assert.equal(belowNight.shouldAlert, false);
  const exactNight = decideRollingAlert({}, -0.6, night, 2_000_000, config);
  assert.equal(exactNight.shouldAlert, true, "night threshold equality must trigger");
}

function testCombinedMessage() {
  const band = { label: "日间", baselineThresholdPct: 0.5, rolling5mThresholdPct: 0.2 };
  const message = buildAlertMessage({
    timestamp: Date.parse("2026-08-21T04:00:00Z"),
    timezone: "Asia/Shanghai",
    price: 100_500,
    source: "websocket",
    band,
    baseline: { triggered: true, price: 100_000, changePct: 0.5 },
    rolling: { triggered: true, changePct: -0.25 },
  });
  assert.match(message, /基准价/);
  assert.match(message, /滚动5分钟/);
  assert.match(message, /WebSocket/);
  assert.match(message, /不会执行交易/);
  assert.match(message, /^【BTC ↕双向预警｜基准\+5min】/u);
  assert.match(message, /基准价方向：↑ 上涨 \+0\.50%/u);
  assert.match(message, /5分钟方向：↓ 下跌 -0\.25%/u);
  assert.equal((message.match(/预警】/gu) ?? []).length, 1, "simultaneous reasons use one message");

  const baselineOnly = buildAlertMessage({
    timestamp: Date.parse("2026-08-21T04:00:00Z"),
    timezone: "Asia/Shanghai",
    price: 100_500,
    source: "websocket",
    band,
    baseline: { triggered: true, price: 100_000, changePct: 0.5 },
    rolling: { triggered: false, changePct: 0.25 },
  });
  assert.match(baselineOnly, /^【BTC ↑上涨预警｜基准】/u);

  const rollingOnly = buildAlertMessage({
    timestamp: Date.parse("2026-08-21T04:00:00Z"),
    timezone: "Asia/Shanghai",
    price: 100_250,
    source: "websocket",
    band,
    baseline: { triggered: false, price: 100_000, changePct: 0.25 },
    rolling: { triggered: true, changePct: 0.25 },
  });
  assert.match(rollingOnly, /^【BTC ↑上涨预警｜5min】/u);
}

testBandBoundaries();
testRollingHistory();
testRollingDecisions();
testCombinedMessage();
console.log("All BTC real-time monitor unit tests passed.");
