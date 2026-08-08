// Dhan-backed NIFTY option-premium scalping helpers.
// NIFTY spot is used for context only. The selected option's own premium path
// supplies the entry, stop and target structure.

import { calcATR, calcEMAs, calcVWAP, detectSwings } from "./ict.js";

export const NIFTY_OPTION_SCALP_CONFIG = {
  minIndexCandles: 60,
  minIndexScore: 4,
  minDelta: 0.45,
  maxDelta: 0.60,
  maxSpreadPct: 0.015,
  minOptionPoints: 12,
  optionLookback: 20,
  entryBufferATR: 0.08,
  stopBufferATR: 0.25,
  targetR: 1.8,
};

export const SENSEX_OPTION_FILTER_CONFIG = {
  ...NIFTY_OPTION_SCALP_CONFIG,
  minIndexScore: 4,
  maxSpreadPct: 0.025,
  contextFromMin: 9 * 60 + 35,
  contextToMin: 13 * 60,
};

const n = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const last = a => Array.isArray(a) && a.length ? a[a.length - 1] : null;

function trendline(points) {
  if (!points || points.length < 2) return null;
  const a = points.at(-2), b = points.at(-1);
  return { from: a, to: b, slope: (b.price - a.price) / Math.max(1, b.index - a.index) };
}

function levels(candles) {
  const { highs: rawHighs, lows: rawLows } = detectSwings(candles || []);
  const highs = rawHighs.map(x => ({ index: x.i, price: x.price }));
  const lows = rawLows.map(x => ({ index: x.i, price: x.price }));
  const recent = (candles || []).slice(-20);
  const fallbackHigh = recent.length ? Math.max(...recent.map(x => n(x.high))) : null;
  const fallbackLow = recent.length ? Math.min(...recent.map(x => n(x.low))) : null;
  return {
    support: lows.at(-1)?.price ?? fallbackLow,
    resistance: highs.at(-1)?.price ?? fallbackHigh,
    supports: lows.slice(-3).map(x => x.price),
    resistances: highs.slice(-3).map(x => x.price),
    supportTrendline: trendline(lows), resistanceTrendline: trendline(highs),
  };
}

export function analyzeIndexContext({ underlying = "NIFTY50", candles5m = [], candles15m = [], nowMin = null, config = {} } = {}) {
  const baseConfig = underlying === "SENSEX" ? SENSEX_OPTION_FILTER_CONFIG : NIFTY_OPTION_SCALP_CONFIG;
  const cfg = { ...baseConfig, ...config };
  const label = underlying === "SENSEX" ? "SENSEX" : "NIFTY";
  const gates = [], reasons = [];
  if (candles5m.length < cfg.minIndexCandles || candles15m.length < 40)
    return { allowed: false, regime: "INSUFFICIENT_DATA", direction: "NO_TRADE", gates: [`Insufficient Dhan ${label} chart history`], reasons };

  const c = candles15m, c5 = candles5m;
  const { e20, e50 } = calcEMAs(c), { e20: e205, e50: e505 } = calcEMAs(c5);
  const atr = n(last(calcATR(c))), atr5 = n(last(calcATR(c5)));
  const px = n(last(c)?.close), px5 = n(last(c5)?.close);
  const vwap = n(calcVWAP(c).vwap), vwap5 = n(calcVWAP(c5).vwap);
  const e20Now = n(last(e20)), e50Now = n(last(e50));
  const e20Prev = n(e20[Math.max(0, e20.length - 5)], e20Now);
  const slope = e20Now ? (e20Now - e20Prev) / e20Now * 100 : 0;
  const gapATR = atr ? Math.abs(e20Now - e50Now) / atr : 0;
  const lv = levels(c);
  const bull = [px > vwap, e20Now > e50Now, slope > 0, px5 > vwap5, n(last(e205)) > n(last(e505))];
  const bear = [px < vwap, e20Now < e50Now, slope < 0, px5 < vwap5, n(last(e205)) < n(last(e505))];
  const bullScore = bull.filter(Boolean).length, bearScore = bear.filter(Boolean).length;
  const direction = bullScore > bearScore ? "CE" : bearScore > bullScore ? "PE" : "NO_TRADE";
  const score = direction === "CE" ? bullScore : direction === "PE" ? bearScore : 0;
  const regime = score >= cfg.minIndexScore && gapATR >= 0.15 ? (direction === "CE" ? "TREND_UP" : "TREND_DOWN") : "CHOP";
  const contextFromMin = n(cfg.contextFromMin, 9 * 60 + 30);
  const contextToMin = n(cfg.contextToMin, 14 * 60 + 30);
  const inWindow = nowMin == null || (nowMin >= contextFromMin && nowMin <= contextToMin);
  if (!inWindow) gates.push("Outside NIFTY context window 09:30–14:30 IST");
  if (regime === "CHOP") gates.push(`${label} trend/regime is not directional enough`);
  if (score < cfg.minIndexScore) gates.push(`${label} chart confirmation ${score}/5 is below ${cfg.minIndexScore}/5`);
  reasons.push(`NIFTY ${regime} · EMA gap ${gapATR.toFixed(2)} ATR · VWAP ${vwap.toFixed(2)}`);
  reasons.push(`NIFTY direction confirmation CE ${bullScore}/5 · PE ${bearScore}/5`);
  if (lv.support != null || lv.resistance != null) reasons.push(`NIFTY levels support ${lv.support ?? "—"} · resistance ${lv.resistance ?? "—"}`);
  return { allowed: gates.length === 0, regime, direction, score, bullScore, bearScore,
    atr, atr5, price: px, price5: px5, vwap, vwap5, gapATR, levels: lv, gates, reasons };
}

export function analyzeNiftyIndexContext(args = {}) { return analyzeIndexContext({ ...args, underlying: "NIFTY50" }); }
export function analyzeSensexIndexContext(args = {}) { return analyzeIndexContext({ ...args, underlying: "SENSEX" }); }

function optionSeries(oi, strike, direction) {
  const row = (oi?.strikes || oi?.rows || []).find(s => Number(s.strike) === Number(strike));
  const leg = row?.[direction === "CE" ? "ce" : "pe"];
  const values = (leg?.ltpSeries || leg?.ltp || []).map(v => n(v)).filter(v => v > 0);
  return values.map((close, i) => {
    const open = values[i - 1] ?? close;
    return { open, high: Math.max(open, close), low: Math.min(open, close), close, vol: leg?.volSeries?.[i] || leg?.vol?.[i] || 0 };
  });
}

export function analyzeSelectedOption({ oi, strike, direction, leg, config = {} } = {}) {
  const cfg = { ...NIFTY_OPTION_SCALP_CONFIG, ...config };
  const candles = optionSeries(oi, strike, direction);
  const gates = [], reasons = [];
  if (candles.length < 3) gates.push("Selected option has insufficient Dhan premium history");
  if (!leg || !(n(leg.ltp) > 0) || !(n(leg.oi) > 0) || !(n(leg.volume) > 0)) gates.push("Selected option LTP/OI/volume is incomplete");
  if (leg?.spreadPct != null && n(leg.spreadPct) > cfg.maxSpreadPct) gates.push(`Selected option spread ${(n(leg.spreadPct) * 100).toFixed(2)}% is too wide`);
  if (leg?.bid == null || leg?.ask == null || !(n(leg.ask) > 0)) gates.push("Selected option bid/ask unavailable");
  const adelta = Math.abs(n(leg?.delta));
  if (adelta < cfg.minDelta || adelta > cfg.maxDelta) gates.push(`Selected option delta ${adelta.toFixed(2)} outside ${cfg.minDelta}–${cfg.maxDelta}`);
  if (candles.length < 3) return { allowed: false, gates, reasons, candles };

  const atr = n(last(calcATR(candles)), Math.max(0.05, n(leg?.ltp) * 0.08));
  const { e20 } = calcEMAs(candles), vwap = n(calcVWAP(candles).vwap);
  const current = n(last(candles)?.close), prior = candles.slice(-cfg.optionLookback - 1, -1);
  const support = Math.min(...prior.map(x => x.low));
  const resistance = Math.max(...prior.map(x => x.high));
  const rising = current > vwap && n(last(e20)) >= n(e20[Math.max(0, e20.length - 3)]);
  const entryTrigger = resistance + atr * cfg.entryBufferATR;
  const stopPremium = Math.max(0.05, support - atr * cfg.stopBufferATR);
  const confirmed = current >= entryTrigger && rising;
  if (!confirmed) gates.push(`Option premium has not confirmed breakout above ₹${entryTrigger.toFixed(2)}`);
  const risk = Math.max(0.05, current - stopPremium);
  const targetPremium = current + risk * cfg.targetR;
  reasons.push(`Option ${strike}${direction} support ₹${support.toFixed(2)} · resistance ₹${resistance.toFixed(2)}`);
  reasons.push(`Premium VWAP ₹${vwap.toFixed(2)} · breakout trigger ₹${entryTrigger.toFixed(2)}`);
  reasons.push(confirmed ? "Selected option premium confirms momentum" : "Wait for option-premium breakout confirmation");
  return { allowed: gates.length === 0, gates, reasons, candles, atr, current, vwap,
    support, resistance, entryTrigger, stopPremium, targetPremium, risk, confirmed };
}
