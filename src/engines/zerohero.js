// ─── ZERO HERO — expiry-day lottery scalp (paper experiment) ──────────────────
// On expiry day between 13:45–14:45 IST, buy 2 lots of a far-OTM option priced
// ₹3–5 on the trending side. When premium doubles, sell half (the trade is now
// free) and ride the rest into the close. Max loss = the tiny premium paid.
//
// This is a deliberate exception to the main stack's rules: it WANTS the 0-DTE
// chain (no expiry roll) and premiums far below the ₹40 floor (it IS the
// far-OTM lottery, sized accordingly). It never goes through scoreOption —
// records are tagged source "Zero-Hero" so R&D can judge it in isolation.
//
// Pure decision function; the scanner owns records/persistence/alerts.
// The 2-lot position is expressed as TWO 1-lot paper trades:
//   leg A: target 2× entry (the "sell 50% at double")
//   leg B: no target, trailing stop arming at 2× (the runner)

export const ZH_DEFAULTS = {
  minPrem: 3,            // ₹ — candidate premium band
  maxPrem: 5,
  lots: 2,               // total lots (split 1 + 1 across the two legs)
  enterFromMin: 13 * 60 + 45,   // 13:45 IST
  enterToMin: 14 * 60 + 45,     // 14:45 IST
  minOi: 5000,           // liquidity floor for the chosen strike
};

// Decide the lottery leg for one underlying.
//   chain: FRONT-expiry /dhan/optionchain result (caller must NOT use the rolled chain)
//   candles5m: today's 5m candles (day-trend read)
//   istMin: minutes-of-day IST at decision time
// Returns { ok:true, direction, leg } or { ok:false, reason }.
export function zeroHeroPick({ chain, candles5m, istMin, cfg = ZH_DEFAULTS }) {
  if (!chain?.ok || !chain.strikes?.length) return { ok: false, reason: "no chain" };
  if (!chain.isExpiryToday) return { ok: false, reason: "not expiry day" };
  if (istMin < cfg.enterFromMin || istMin > cfg.enterToMin)
    return { ok: false, reason: "outside 13:45–14:45 window" };
  if (!Array.isArray(candles5m) || candles5m.length < 30)
    return { ok: false, reason: "insufficient candles" };

  // Direction = the day's trending side (close vs the 5m EMA20 — ride, don't fade).
  const closes = candles5m.map(c => c.close);
  const k = 2 / 21;
  let ema = closes[0];
  for (const c of closes) ema = c * k + ema * (1 - k);
  const last = closes[closes.length - 1];
  const direction = last >= ema ? "CE" : "PE";
  const side = direction === "CE" ? "ce" : "pe";

  // Candidate: premium in [minPrem, maxPrem] with real OI, nearest to spot
  // (closest to the money = most gamma if the move comes).
  const spot = chain.under_ltp || 0;
  const cands = chain.strikes
    .map(s => ({ strike: s.strike, leg: s[side] || {} }))
    .filter(x => x.leg.ltp >= cfg.minPrem && x.leg.ltp <= cfg.maxPrem && (x.leg.oi || 0) >= cfg.minOi)
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  if (!cands.length) return { ok: false, reason: `no ₹${cfg.minPrem}–${cfg.maxPrem} strike with OI ≥ ${cfg.minOi}` };

  const pick = cands[0];
  return {
    ok: true, direction, spot,
    leg: { strike: pick.strike, ltp: pick.leg.ltp, oi: pick.leg.oi || 0,
           delta: pick.leg.delta || 0, expiry: chain.expiry },
  };
}

// Build the two 1-lot paper-trade records for a pick (scanner shape).
// lotSize comes from the caller (getLotSize is app/data-layer territory).
export function zeroHeroRecords({ underlying, pick, lotSize, now = Date.now() }) {
  const entry = pick.leg.ltp;
  const base = {
    timestamp: now, entryTs: now,
    asset: underlying, assetId: underlying, timeframe: "options",
    nature: "Scalping", bias: pick.direction === "CE" ? "BULLISH" : "BEARISH",
    confidence: null,
    entry, optionPremium: entry,
    stopLoss: 0, slPremium: 0,          // lottery: max loss = the premium itself
    lots: 1, lotSize,
    maxHoldMin: null, squareOff: true,   // 15:15 square-off / expiry settle
    expiry: pick.leg.expiry, strike: pick.leg.strike, direction: pick.direction,
    regime: "EXPIRY", style: "ZERO_HERO",
    outcome: "pending", source: "Zero-Hero", tradeType: "Paper",
  };
  return [
    { ...base, id: `ZH-${underlying}-${now}-A`,
      setup: `Zero Hero ${pick.leg.strike}${pick.direction} · sell half at 2×`,
      tgtPremium: +(entry * 2).toFixed(2), takeProfit1: +(entry * 2).toFixed(2),
      trailStop: false },
    { ...base, id: `ZH-${underlying}-${now}-B`,
      setup: `Zero Hero ${pick.leg.strike}${pick.direction} · runner (trails after 2×)`,
      tgtPremium: 0, takeProfit1: 0,
      trailStop: true, trailArmPts: entry, trailPts: entry },  // arm at 2×, trail 1× entry behind the peak
  ];
}
