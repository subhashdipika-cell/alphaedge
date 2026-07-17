// ─── MARKET REGIME ENGINE ─────────────────────────────────────────────────────
// "Should we even be trading?" — classifies the day-type and rates it for option
// BUYING, from VIX, ATR, ADX, IV percentile, PCR, OI distribution and the option
// expiry/event context. Unfavorable regimes (range, vol-compression, event pre-
// window) veto the score engine; the label is logged on every recommendation so
// the R&D learning engine can answer "which regimes favour which setups".
//
// Pure: inputs → { regime, confidence, favorable, bias, reasons[] }.

import { calcATR, calcADX, calcEMAs } from "./ict.js";

// day-type constants
export const REGIMES = {
  TREND_BULL: "Strong Bull Trend",
  TREND_BEAR: "Strong Bear Trend",
  BREAKOUT: "Breakout / Vol Expansion",
  RANGE: "Range / Chop",
  VOL_COMPRESSION: "Volatility Compression",
  EXPIRY: "Expiry Day",
  EVENT: "Event-Driven Day",
  MIXED: "Mixed / Unclear",
};

// ── Prior-day context ─────────────────────────────────────────────────────────
// What kind of day was yesterday, and how did today open against it? Explicit
// inputs a human always checks: yesterday's day-type (trend/range), where it
// closed in its own range (strong/weak close), and today's opening gap.
const istDayOf = (ts) => {
  const d = new Date(ts);
  return new Date(d.getTime() + (d.getTimezoneOffset() + 330) * 60000).toDateString();
};

export function priorDayContext(candles = []) {
  if (!Array.isArray(candles) || candles.length < 30) return null;
  const days = new Map();
  for (const c of candles) {
    const k = istDayOf(c.ts);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(c);
  }
  const keys = [...days.keys()];
  if (keys.length < 2) return null;
  const prev = days.get(keys[keys.length - 2]);
  const today = days.get(keys[keys.length - 1]);
  const pdo = prev[0].open, pdc = prev[prev.length - 1].close;
  const pdh = Math.max(...prev.map(c => c.high)), pdl = Math.min(...prev.map(c => c.low));
  const range = pdh - pdl;
  if (!(range > 0) || !(pdc > 0)) return null;
  const net = pdc - pdo;
  const trendiness = Math.abs(net) / range;                       // 0..1 close-to-open drive
  const dayType = trendiness >= 0.5 ? (net > 0 ? "TREND_UP" : "TREND_DOWN") : "RANGE";
  const closePos = (pdc - pdl) / range;                           // 0 = at low, 1 = at high
  const todayOpen = today[0].open;
  const gapPct = ((todayOpen - pdc) / pdc) * 100;
  const spot = today[today.length - 1].close;
  return {
    pdh: +pdh.toFixed(2), pdl: +pdl.toFixed(2), pdc: +pdc.toFixed(2),
    dayType, trendiness: +trendiness.toFixed(2),
    closePos: +closePos.toFixed(2),
    strongClose: closePos >= 0.75 ? "high" : closePos <= 0.25 ? "low" : null,
    gapPct: +gapPct.toFixed(2),
    openLoc: todayOpen > pdh ? "above-range" : todayOpen < pdl ? "below-range" : "in-range",
    insideYRange: spot <= pdh && spot >= pdl,
  };
}

// candles: 15m array preferred (falls back gracefully). chain: /dhan/optionchain
// result. vix: /dhan/vix result. oi: analyzeOiTrend result. events: [{impactMin}]
// where impactMin = minutes until a high-impact event (negative = passed today).
export function detectRegime({ candles = [], chain = null, vix = null, oi = null, eventSoon = false, eventToday = false } = {}) {
  const reasons = [];
  const priorDay = priorDayContext(candles);

  // ── Expiry / event override day-types ──
  if (chain?.isExpiryToday) {
    reasons.push("Expiry day (0-DTE) — gamma explosive, theta brutal; scalps only");
    return { regime: "EXPIRY", label: REGIMES.EXPIRY, confidence: 90, favorable: false, bias: "NEUTRAL", reasons, priorDay };
  }
  if (eventToday || eventSoon) {
    reasons.push(eventSoon ? "High-impact event imminent — IV crush risk" : "Event-risk day — positioning ahead of a catalyst");
    return { regime: "EVENT", label: REGIMES.EVENT, confidence: 75, favorable: false, bias: "NEUTRAL", reasons, priorDay };
  }

  // ── Trend strength from EMA alignment + ADX ──
  let emaBias = "NEUTRAL", adxNow = 0, atrPct = 0, atrRising = false;
  if (candles.length >= 40) {
    const closes = candles.map(c => c.close);
    const { e20, e50, e200 } = calcEMAs(candles);
    const last = closes.at(-1), l20 = e20.at(-1), l50 = e50.at(-1), l200 = e200.at(-1);
    if (last > l20 && l20 >= l50 && l50 >= l200) emaBias = "BULLISH";
    else if (last < l20 && l20 <= l50 && l50 <= l200) emaBias = "BEARISH";
    const { adx } = calcADX(candles);
    adxNow = adx.at(-1) || 0;
    const atr = calcATR(candles);
    const atrLast = atr.at(-1) || 0;
    atrPct = last ? (atrLast / last) * 100 : 0;
    const atrPrev = atr[Math.max(0, atr.length - 6)] || atrLast;
    atrRising = atrLast > atrPrev * 1.05;
  } else {
    reasons.push("Not enough candles for a confident trend read");
  }

  const vixLevel = vix?.vix?.ltp ?? null;
  const ivp = chain?.ivPercentile ?? null;
  const pcr = oi?.pcr ?? null;
  const smBias = oi?.smartMoney?.bias || "NEUTRAL";

  // ── Classify ──
  let regime = "MIXED", confidence = 40, favorable = false, bias = "NEUTRAL";

  const strongTrend = adxNow >= 25 && emaBias !== "NEUTRAL";
  const weakTrend = adxNow < 18;

  if (strongTrend) {
    regime = emaBias === "BULLISH" ? "TREND_BULL" : "TREND_BEAR";
    bias = emaBias;
    favorable = true;
    confidence = Math.min(95, 55 + (adxNow - 25) * 1.5);
    reasons.push(`ADX ${adxNow.toFixed(0)} with aligned EMAs — a directional trend day (option-buyer friendly)`);
    if (smBias === bias) { confidence = Math.min(97, confidence + 8); reasons.push("OI smart-money agrees with the trend"); }
  } else if (atrRising && (vixLevel == null || vixLevel >= 12)) {
    regime = "BREAKOUT";
    bias = emaBias;
    favorable = true;
    confidence = 60;
    reasons.push("ATR expanding — volatility breakout; buyers favoured if direction confirms");
  } else if (weakTrend && (ivp == null || ivp < 40) && (vixLevel == null || vixLevel < 13)) {
    regime = "VOL_COMPRESSION";
    favorable = false;
    confidence = 65;
    reasons.push(`Low ADX (${adxNow.toFixed(0)}) + cheap IV/low VIX — coiled but quiet; long options bleed theta`);
  } else if (weakTrend) {
    regime = "RANGE";
    favorable = false;
    confidence = 60;
    reasons.push(`Low ADX (${adxNow.toFixed(0)}) — range/chop; long options bleed theta without a move`);
  } else {
    reasons.push(`ADX ${adxNow.toFixed(0)} — no decisive trend; treat as mixed`);
  }

  // ── Prior-day context adjustments — what a human checks before committing ──
  if (priorDay) {
    const pd = priorDay;
    // Trend continuation: yesterday drove one way and closed strong on that
    // extreme; today agreeing is the highest-quality directional context.
    if (pd.dayType === "TREND_UP" && pd.strongClose === "high" && (bias === "BULLISH" || regime === "BREAKOUT")) {
      confidence += 6;
      reasons.push("Yesterday: trend-up day closing at its highs — continuation context");
    } else if (pd.dayType === "TREND_DOWN" && pd.strongClose === "low" && (bias === "BEARISH" || regime === "BREAKOUT")) {
      confidence += 6;
      reasons.push("Yesterday: trend-down day closing at its lows — continuation context");
    }
    // Gap caution: large gaps over yesterday's close often fade or chop first.
    if (Math.abs(pd.gapPct) >= 0.5) {
      confidence -= 10;
      reasons.push(`Gapped ${pd.gapPct > 0 ? "+" : ""}${pd.gapPct}% over yesterday's close — gap days fade/chop; expectations down`);
    }
    // A "breakout" that hasn't even left yesterday's range isn't one yet.
    if (regime === "BREAKOUT" && pd.dayType === "RANGE" && pd.insideYRange) {
      confidence -= 15;
      reasons.push(`Breakout call while still inside yesterday's ${pd.pdl}–${pd.pdh} range — needs a PDH/PDL break to confirm`);
    }
    // Direction hint when the trend read is neutral but yesterday wasn't.
    if (bias === "NEUTRAL" && pd.dayType === "TREND_UP" && pd.strongClose === "high" && pd.gapPct > -0.2) bias = "BULLISH";
    else if (bias === "NEUTRAL" && pd.dayType === "TREND_DOWN" && pd.strongClose === "low" && pd.gapPct < 0.2) bias = "BEARISH";
    confidence = Math.max(20, Math.min(97, confidence));
    if (confidence < 50) favorable = false;
  }

  if (vixLevel != null) reasons.push(`India VIX ${vixLevel.toFixed(1)} (${vixLevel < 11 ? "complacent" : vixLevel > 18 ? "elevated" : "normal"})`);
  if (pcr != null) reasons.push(`PCR ${pcr.toFixed(2)} (${pcr > 1.15 ? "put-heavy / supportive" : pcr < 0.85 ? "call-heavy / capped" : "balanced"})`);

  return { regime, label: REGIMES[regime], confidence: Math.round(confidence), favorable, bias,
           adx: +adxNow.toFixed(1), atrPct: +atrPct.toFixed(3), vix: vixLevel, ivPercentile: ivp, reasons, priorDay };
}
