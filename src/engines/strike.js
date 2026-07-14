// ─── OPTIONS REGIME + STRIKE / TRADE-PLAN ─────────────────────────────────────
// Seed logic for the Option Buying Score engine (revamp Phase 6). detectOptionsRegime
// reads the underlying's candles + the option chain into a NO_TRADE / BUY_CALL /
// BUY_PUT recommendation; optionsTradePlan sizes a chosen leg from Money Mgt.

import { emaSeries } from "../lib/math.js";
import { getLotSize } from "../data/bridge.js";

// Detect the market regime from the underlying's candles + the option chain, and
// recommend NO_TRADE / BUY_CALL / BUY_PUT. Long options need a directional trend
// and reasonable IV; ranges and rich IV are buyer-hostile (theta/vega bleed).
export function detectOptionsRegime({ candles, chain, guardrails }) {
  const reasons = [];

  // ── Trend from candles (EMA20 vs EMA50 + slope) ──
  let trend = "unknown", slopePct = 0, emaGap = 0, strength = 0;
  if (candles && candles.length >= 30) {
    const closes = candles.map(c => c.close);
    const e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50);
    const last = closes[closes.length - 1], l20 = e20[e20.length - 1], l50 = e50[e50.length - 1];
    const prev20 = e20[Math.max(0, e20.length - 6)] || l20;
    slopePct = l20 ? (l20 - prev20) / l20 * 100 : 0;
    emaGap   = l50 ? (l20 - l50) / l50 * 100 : 0;
    if (last > l20 && l20 >= l50 && slopePct > 0.02) trend = "up";
    else if (last < l20 && l20 <= l50 && slopePct < -0.02) trend = "down";
    else trend = "range";
    strength = Math.min(1, Math.abs(emaGap) / 0.5 + Math.abs(slopePct) / 0.2);
    reasons.push(`Trend: ${trend === "up" ? "↑ price > EMA20 > EMA50" : trend === "down" ? "↓ price < EMA20 < EMA50" : "→ EMAs flat / mixed"} (slope ${slopePct.toFixed(2)}%, EMA gap ${emaGap.toFixed(2)}%)`);
  } else {
    reasons.push("Trend: not enough candles — bridge/market may be off; using chain signals only.");
  }

  // ── Volatility from ATM IV percentile ──
  const ivp = chain?.ivPercentile;
  const volState = ivp == null ? "unknown" : ivp > 75 ? "rich" : ivp < 30 ? "cheap" : "normal";
  if (ivp != null) reasons.push(`IV ${ivp}th pct — options ${volState === "rich" ? "expensive (buyer-hostile)" : volState === "cheap" ? "cheap (buyer-friendly)" : "fairly priced"}`);

  // ── PCR + ATM IV skew from the chain ──
  let pcr = null, skew = null;
  if (chain?.strikes?.length) {
    const ceOI = chain.strikes.reduce((a, s) => a + (s.ce?.oi || 0), 0);
    const peOI = chain.strikes.reduce((a, s) => a + (s.pe?.oi || 0), 0);
    pcr = ceOI ? peOI / ceOI : null;
    const atmRow = chain.strikes.find(s => s.atm) || chain.strikes[Math.floor(chain.strikes.length / 2)];
    if (atmRow) skew = (atmRow.pe?.iv || 0) - (atmRow.ce?.iv || 0);
    if (pcr != null) reasons.push(`PCR ${pcr.toFixed(2)} (${pcr > 1.2 ? "bullish — put writers supporting" : pcr < 0.8 ? "bearish — call writers capping" : "neutral"})`);
    if (skew != null) reasons.push(`ATM IV skew ${skew > 0 ? "+" : ""}${skew.toFixed(1)} (${skew > 1 ? "put bid — downside fear" : skew < -1 ? "call bid — upside demand" : "flat"})`);
  }

  // ── Decide ──
  const expiryBlock = chain?.isExpiryToday && guardrails?.blockExpiryDay;
  let suggestion = "NO_TRADE", why;
  if (expiryBlock)                              why = "Expiry day (0-DTE) — guardrail blocks buying.";
  else if (trend === "range")                   why = "Sideways / choppy — long options bleed theta in a range.";
  else if (volState === "rich" && strength < 0.6) why = "IV rich without a strong trend — poor risk/reward for buyers.";
  else if (trend === "up")   { suggestion = "BUY_CALL"; why = `Uptrend${pcr > 1.2 ? " + supportive PCR" : ""}${skew < 0 ? " + call demand" : ""}.`; }
  else if (trend === "down") { suggestion = "BUY_PUT";  why = `Downtrend${pcr < 0.8 ? " + weak PCR" : ""}${skew > 1 ? " + downside fear" : ""}.`; }
  else                                          why = "No clear directional edge.";
  reasons.push(why);

  const label = suggestion !== "NO_TRADE"
    ? `${trend === "up" ? "Uptrend" : "Downtrend"}${volState === "cheap" ? " · cheap IV" : volState === "rich" ? " · rich IV" : ""}`
    : expiryBlock ? "0-DTE — Stand aside"
    : trend === "range" ? "Range / Chop — Stand aside"
    : volState === "rich" ? "High IV, no trend — Stand aside"
    : "No edge — Stand aside";

  return { suggestion, label, why, trend, volState, ivp, pcr, skew, strength, reasons };
}

// Position plan for a chosen option leg, sized from Money Mgt (capital + RR + SL)
// and the risk policy (max % account risk per trade).
export function optionsTradePlan({ rec, underlying, mm, riskPct }) {
  if (!rec || !(rec.ltp > 0)) return null;
  const lotUnits = getLotSize(underlying);
  const capital  = Number(mm.capital) || 0;
  const budget   = capital * (riskPct / 100);             // ₹ risk allowed this trade
  const entry    = Number(rec.ltp) || 0;
  // SL on the premium: fixed points if the user set one and it's sane, else 30%
  // of premium; never more than the premium itself (max loss on a long option).
  let slPts = (mm.useSL && mm.slPoints > 0) ? Number(mm.slPoints) : Math.round(entry * 0.30);
  slPts = Math.max(1, Math.min(slPts, Math.floor(entry)));
  const rr = mm.rr === "trail" ? (Number(mm.trailMaxRR) || 3) : (Number(mm.rr) || 2);
  const tgtPts = +(slPts * rr).toFixed(2);
  const riskPerLot = slPts * lotUnits;
  const lots = riskPerLot > 0 ? Math.floor(budget / riskPerLot) : 0;
  return {
    lotUnits, capital, riskPct, budget, entry, slPts, tgtPts, rr, lots,
    slPrice:  +(entry - slPts).toFixed(2),
    tgtPrice: +(entry + tgtPts).toFixed(2),
    riskRs:   lots * riskPerLot,
    rewardRs: lots * tgtPts * lotUnits,
    outlayRs: lots * entry * lotUnits,
    oneLotRisk: riskPerLot,
    affordable: lots >= 1,
  };
}
