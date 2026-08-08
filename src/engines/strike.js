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

// Expected move (≈1 SD by expiry) from the ATM straddle price, with an IV-based
// fallback. chain: /dhan/optionchain result (rows carry ce/pe ltp + iv).
export function expectedMove(chain, dteYears = null) {
  if (!chain?.strikes?.length) return null;
  const spot = chain.under_ltp || 0;
  const atm = chain.strikes.find(s => s.atm) || chain.strikes[Math.floor(chain.strikes.length / 2)];
  const straddle = (atm?.ce?.ltp || 0) + (atm?.pe?.ltp || 0);
  if (straddle > 0) {
    // The ATM straddle prices the ~1 SD move to expiry (0.8× is a common day-move proxy).
    return { points: +(straddle * 0.85).toFixed(1), pct: spot ? +((straddle * 0.85 / spot) * 100).toFixed(2) : 0, source: "straddle" };
  }
  const iv = (atm?.ce?.iv || atm?.pe?.iv || 0) / 100;
  const t = dteYears ?? (1 / 365);
  if (spot && iv > 0) {
    const pts = spot * iv * Math.sqrt(t);
    return { points: +pts.toFixed(1), pct: +((pts / spot) * 100).toFixed(2), source: "iv" };
  }
  return null;
}

// Dynamic strike selection for a direction. Prefers |delta| in the style's band
// (default [0.45,0.65]; swing skews ITM), ranks by closeness to the style's ideal
// delta, then tight spread, then OI; rejects premium below the floor.
//
// Affordability-aware: when `budget` (₹ risk allowed for the trade) is given and
// the ideal-delta strike can't fit ONE lot inside it (indivisible lots — e.g. a
// ₹216 slightly-ITM NIFTY PE risks ₹4,225/lot vs a ₹4,000 1% budget), it steps
// to a cheaper strike STILL INSIDE the delta band that does fit, instead of
// skipping a TRADE-grade setup over a few hundred rupees. Risk discipline is
// kept; the instrument adapts. If nothing in the pool fits, the ideal pick is
// returned unchanged (flagged `unaffordable`) so the caller sizes it to 0 lots
// and reports honestly.
// Returns { leg, moneyness, reasons, unaffordable? } or null.
export function selectStrike({ chain, direction, minPremium = 40, expected = null, strikePref = null,
                               budget = null, underlying = null, mm = {}, stopUnder = null }) {
  if (!chain?.strikes?.length) return null;
  const deltaLo = strikePref?.deltaLo ?? 0.45;
  const deltaHi = strikePref?.deltaHi ?? 0.65;
  const ideal = strikePref?.ideal ?? 0.55;
  const side = direction === "CE" ? "ce" : "pe";
  const spot = chain.under_ltp || 0;
  const legs = chain.strikes.map(s => {
    const leg = s[side] || {};
    const adelta = Math.abs(leg.delta || 0);
    const spreadPct = leg.ltp > 0 && leg.ask ? Math.abs((leg.ask - (leg.bid || leg.ask)) / leg.ltp) : 0;
    return { strike: s.strike, atm: s.atm, ltp: leg.ltp || 0, bid: leg.bid || 0, ask: leg.ask || 0,
             oi: leg.oi || 0, volume: leg.volume || 0, iv: leg.iv || 0,
             delta: leg.delta || 0, theta: leg.theta || 0, adelta, spreadPct };
  });
  const eligible = legs.filter(l => l.ltp >= minPremium && l.adelta >= deltaLo && l.adelta <= deltaHi);
  const pool = eligible.length ? eligible : legs.filter(l => l.ltp >= minPremium);
  if (!pool.length) return null;
  pool.sort((a, b) =>
    Math.abs(a.adelta - ideal) - Math.abs(b.adelta - ideal) ||
    a.spreadPct - b.spreadPct ||
    b.oi - a.oi);
  let leg = pool[0];

  // ── Affordability walk (same SL priority as optionsTradePlan: fixed →
  // structural stop × the LEG's delta → 30% of premium) ──
  const lotUnits = underlying ? getLotSize(underlying) : 0;
  const riskPerLot = (l) => {
    let slPts;
    if (mm.useSL && mm.slPoints > 0) slPts = Number(mm.slPoints);
    else if (stopUnder > 0) slPts = Math.round(stopUnder * (Math.abs(l.delta) || 0.5));
    else slPts = Math.round(l.ltp * 0.30);
    slPts = Math.max(1, Math.min(slPts, Math.floor(l.ltp)));
    return slPts * lotUnits;
  };
  const checkBudget = budget > 0 && lotUnits > 0;
  let stepped = null, unaffordable = false;
  if (checkBudget && riskPerLot(leg) > budget) {
    const fits = pool.filter(l => riskPerLot(l) <= budget);
    if (fits.length) { stepped = leg; leg = fits[0]; }   // fits[] keeps the pool's ranking
    else unaffordable = true;                            // honest: nothing fits — caller sizes 0 lots
  }

  // Moneyness relative to spot (CE ITM below spot; PE ITM above spot).
  let moneyness = "ATM";
  if (spot) {
    const diff = leg.strike - spot;
    const near = Math.abs(diff) <= (expected?.points || spot * 0.001);
    if (near) moneyness = "ATM";
    else if (direction === "CE") moneyness = diff < 0 ? "ITM" : "OTM";
    else moneyness = diff > 0 ? "ITM" : "OTM";
  }
  const reasons = [];
  reasons.push(`Delta ${leg.delta.toFixed(2)} (${moneyness}) — ${leg.adelta >= deltaLo && leg.adelta <= deltaHi ? `in the ${deltaLo}–${deltaHi} band` : `closest available to ${ideal}`}`);
  if (stepped) reasons.push(
    `Ideal Δ${stepped.adelta.toFixed(2)} strike ${stepped.strike} (₹${stepped.ltp}) risks ₹${riskPerLot(stepped).toLocaleString("en-IN")}/lot — over the ₹${Math.round(budget).toLocaleString("en-IN")} budget; stepped to this affordable strike (₹${riskPerLot(leg).toLocaleString("en-IN")}/lot)`);
  if (unaffordable) reasons.push(
    `No strike in the pool fits ₹${Math.round(budget).toLocaleString("en-IN")} risk/lot — raise capital/risk or wait for cheaper premium`);
  if (leg.spreadPct) reasons.push(`Spread ${(leg.spreadPct * 100).toFixed(1)}% of premium`);
  reasons.push(`Premium ₹${leg.ltp} · OI ${leg.oi.toLocaleString("en-IN")}`);
  return { leg, moneyness, reasons, ...(unaffordable ? { unaffordable: true } : {}) };
}

// Position plan for a chosen option leg, sized from Money Mgt (capital + RR + SL)
// and the risk policy (max % account risk per trade).
// structStop (from levels.structuralStopUnder): when present, the SL sits behind
// the level map's helping barrier — converted to premium via the leg's delta —
// instead of a blind 30% of premium. Sizing adapts (wider stop → fewer lots),
// so account risk stays at riskPct either way.
export function optionsTradePlan({ rec, underlying, mm, riskPct, structStop = null, optionStructure = null }) {
  if (!rec || !(rec.ltp > 0)) return null;
  const lotUnits = getLotSize(underlying);
  const capital  = Number(mm.capital) || 0;
  const budget   = capital * (riskPct / 100);             // ₹ risk allowed this trade
  const entry    = Number(rec.ask || rec.ltp) || 0;
  const adelta   = Math.abs(Number(rec.delta)) || 0.5;
  // SL priority: explicit fixed points (user override) → structural stop →
  // 30% of premium; never more than the premium itself (max loss on a long).
  let slPts, slBasis = "pct", slLevel = null, slCapped = false;
  if (mm.useSL && mm.slPoints > 0) {
    slPts = Number(mm.slPoints); slBasis = "fixed";
  } else if (structStop?.stopUnder > 0) {
    slPts = Math.round(structStop.stopUnder * adelta);
    slBasis = "structure"; slLevel = structStop.level ?? null; slCapped = structStop.capped === "far";
  } else {
    slPts = optionStructure?.stopPremium > 0
      ? Math.round(entry - optionStructure.stopPremium)
      : Math.round(entry * 0.30);
  }
  slPts = Math.max(1, Math.min(slPts, Math.floor(entry)));
  const rr = mm.rr === "trail" ? (Number(mm.trailMaxRR) || 3) : (Number(mm.rr) || 2);
  const tgtPts = +(optionStructure?.targetPremium > entry
    ? optionStructure.targetPremium - entry : slPts * rr).toFixed(2);
  const riskPerLot = slPts * lotUnits;
  const lots = riskPerLot > 0 ? Math.floor(budget / riskPerLot) : 0;
  // Trailing stop (premium): arms at +trailArmR·R, then trails trailR·R behind the
  // high-water premium. On by default; the resolver locks in gains once in profit.
  const trailStop = mm.trailStop !== false;
  const trailArmR = Number(mm.trailArmR) > 0 ? Number(mm.trailArmR) : 1;
  const trailR    = Number(mm.trailR)    > 0 ? Number(mm.trailR)    : 1;
  return {
    lotUnits, capital, riskPct, budget, entry, slPts, tgtPts, rr, lots,
    slBasis, slLevel, slCapped,
    slPrice:  +(entry - slPts).toFixed(2),
    tgtPrice: +(entry + tgtPts).toFixed(2),
    trailStop, trailArmPts: +(slPts * trailArmR).toFixed(2), trailPts: +(slPts * trailR).toFixed(2),
    riskRs:   lots * riskPerLot,
    rewardRs: lots * tgtPts * lotUnits,
    outlayRs: lots * entry * lotUnits,
    oneLotRisk: riskPerLot,
    affordable: lots >= 1,
  };
}
