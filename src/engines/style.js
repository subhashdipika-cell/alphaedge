// ─── TRADE-STYLE ENGINE (the "Strategy Selector") ─────────────────────────────
// The same factors matter DIFFERENTLY for a 5-minute scalp vs a 5-day swing.
// Rather than three duplicated strategy codebases, one scored engine is
// specialised per style by: (a) a weight profile, (b) a strike-delta preference,
// (c) a hold / time-stop. A rule-based selector picks the style from the regime,
// VIX, DTE and time-of-day. Every recommendation is tagged with its style so the
// R&D meta-learning engine (Phase 8) can compare per-style expectancy and adapt
// allocation — while the underlying rules stay explicit and auditable.
//
// Pure: no fetching, no DOM.

import { nowIST } from "../lib/ist.js";

// Local copy of the base weights (avoids a circular import with score.js).
const BASE_WEIGHTS = { trend: 20, momentum: 15, ict: 20, chainOi: 15, greeks: 10, ivVix: 10, risk: 5, news: 5 };

export const STYLES = {
  SCALP: "Momentum Scalp",
  INTRADAY: "Intraday Directional",
  SWING: "Positional Swing",
};

// Multipliers over the base weights (then renormalised to 100). Scalps lean on
// Trending-OI / Greeks / Momentum / IV-expansion; swings lean on multi-TF Trend,
// IV-rank and structure, and de-emphasise intraday OI and short-term momentum.
export const STYLE_WEIGHT_BIAS = {
  SCALP:    { trend: 0.6, momentum: 1.6, ict: 0.9, chainOi: 1.5, greeks: 1.5, ivVix: 1.1, risk: 1.0, news: 0.5 },
  INTRADAY: { trend: 1.1, momentum: 1.0, ict: 1.1, chainOi: 1.0, greeks: 1.0, ivVix: 1.0, risk: 1.0, news: 1.0 },
  SWING:    { trend: 1.6, momentum: 0.5, ict: 1.2, chainOi: 0.6, greeks: 0.9, ivVix: 1.4, risk: 1.0, news: 1.4 },
};

// Strike-delta preference per style. Scalp/Intraday: ATM / slightly-ITM high
// delta for speed & liquidity. Swing: deeper ITM for lower theta / resilience.
export const STYLE_STRIKE = {
  SCALP:    { deltaLo: 0.45, deltaHi: 0.62, ideal: 0.55, prefer: "ATM" },
  INTRADAY: { deltaLo: 0.45, deltaHi: 0.65, ideal: 0.55, prefer: "ATM" },
  SWING:    { deltaLo: 0.55, deltaHi: 0.80, ideal: 0.65, prefer: "ITM" },
};

// Hold / time-stop per style. Scalp/Intraday square off intraday; swing holds
// overnight to a multi-day cap.
export const STYLE_HOLD = {
  SCALP:    { maxHoldMin: 25,             squareOff: true,  label: "≤ 20–30 min" },
  INTRADAY: { maxHoldMin: 360,            squareOff: true,  label: "15 min → close" },
  SWING:    { maxHoldMin: 15 * 24 * 60,   squareOff: false, label: "2–15 days" },
};

// Rule-based style selector. Returns { style, reasons[], alternatives[] }.
export function selectStyle({ regime, vix, dteYears, atNow = null } = {}) {
  const ist = atNow ? new Date(atNow) : nowIST();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const vl = vix?.vix?.ltp ?? null;
  const dteDays = (dteYears ?? (1 / 365)) * 365;
  const reasons = [];

  // Expiry day, high VIX, or an imminent event ⇒ scalp (fast, gamma-driven).
  if (regime?.regime === "EXPIRY") { reasons.push("Expiry day — 0-DTE gamma favours fast scalps only"); return pick("SCALP", reasons); }
  if (vl != null && vl >= 20)      { reasons.push(`VIX ${vl.toFixed(1)} elevated — volatility scalps, avoid holding`); return pick("SCALP", reasons); }
  if (regime?.regime === "BREAKOUT") { reasons.push("Volatility breakout — momentum scalp window"); return pick("SCALP", reasons, ["INTRADAY"]); }

  // Calm + multi-day expiry + a real trend ⇒ swing (theta-tolerant, ITM).
  if (dteDays >= 3 && (vl == null || vl < 14) && regime?.favorable && (regime?.regime === "TREND_BULL" || regime?.regime === "TREND_BEAR")) {
    reasons.push(`Low VIX + ${Math.round(dteDays)}d to expiry + a clean trend — positional swing (ITM, theta-tolerant)`);
    return pick("SWING", reasons, ["INTRADAY"]);
  }

  // Late in the session, prefer scalps over opening fresh intraday exposure.
  if (mins >= 14 * 60 + 30) { reasons.push("Late session — quick scalp only, no fresh intraday hold"); return pick("SCALP", reasons); }

  // Default: intraday directional.
  reasons.push("Directional day-trade conditions — intraday engine");
  return pick("INTRADAY", reasons, dteDays >= 3 ? ["SWING"] : ["SCALP"]);
}

function pick(style, reasons, alternatives = []) {
  return { style, label: STYLES[style], reasons, alternatives };
}

// Style-adjusted weights: base (or user overrides) × style bias, renormalised to
// sum 100 so the 0–100 scale is preserved.
export function styleWeights(style, base = BASE_WEIGHTS) {
  const bias = STYLE_WEIGHT_BIAS[style] || STYLE_WEIGHT_BIAS.INTRADAY;
  const raw = {};
  let sum = 0;
  for (const k of Object.keys(base)) { raw[k] = (base[k] || 0) * (bias[k] ?? 1); sum += raw[k]; }
  const out = {};
  for (const k of Object.keys(raw)) out[k] = sum ? +(raw[k] / sum * 100).toFixed(2) : base[k];
  return out;
}
