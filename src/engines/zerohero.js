// ─── ZERO HERO — expiry-day lottery scalp (paper experiment) ──────────────────
// On expiry day between 14:00–14:45 IST, buy 2 lots of a far-OTM option priced
// ₹3–5 on the FADE (counter-trend) side. When premium doubles, sell half (the
// trade is now free) and ride the rest into the close. Max loss = the premium.
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

import { analyzeNiftyIndexContext, analyzeSelectedOption } from "./niftyMomentum.js";

// Window + side are DATA-DRIVEN (strategy-lab/zh_window_scan.py over 9 expiry
// days, ~317 tickets): 14:00–14:45 was the only EV-positive zone (+0.15×/ticket,
// 38.9% doubled, 11% hit 5×) and the spikes sat on the COUNTER-trend side —
// expiry-afternoon far-OTM explosions are reversal/short-covering squeezes, so
// fading the day's trend beat riding it in every afternoon window. Re-run the
// scan as more expiry days accumulate; n is still small.
export const ZH_DEFAULTS = {
  minPrem: 3,            // ₹ — candidate premium band
  maxPrem: 5,
  lots: 2,               // total lots (split 1 + 1 across the two legs)
  enterFromMin: 14 * 60,        // 14:00 IST (13:45 entries sat in a −0.32× EV bucket)
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

  // Direction = FADE the day's trend (counter-trend). Empirical: expiry-afternoon
  // far-OTM spikes are reversal/squeeze-driven — the fade side doubled 38.9% vs
  // the trend side's 17.4% in the 14:00 window (see zh_window_scan.py).
  const closes = candles5m.map(c => c.close);
  const k = 2 / 21;
  let ema = closes[0];
  for (const c of closes) ema = c * k + ema * (1 - k);
  const last = closes[closes.length - 1];
  const direction = last >= ema ? "PE" : "CE";
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
    maxHoldMin: null, squareOff: true,   // 15:12 square-off / expiry settle
    expiry: pick.leg.expiry, strike: pick.leg.strike, direction: pick.direction,
    regime: "EXPIRY", style: "ZERO_HERO", strategyVersion: "zero-hero-v1",
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

// Chart-confirmed Zero-Hero v2. This is separate from the original
// counter-trend lottery: v2 confirms NIFTY direction, selects an option from
// chain/OI/liquidity data, and requires the selected premium to break out.
export const ZH_V2_DEFAULTS = {
  ...ZH_DEFAULTS, minIndexScore: 4, minDelta: 0.05, maxDelta: 0.35, maxSpreadPct: 0.08,
  contextFromMin: 14 * 60, contextToMin: 14 * 60 + 45,
};

export function zeroHeroV2Pick({ chain, oi, candles5m, candles15m, istMin, cfg = ZH_V2_DEFAULTS }) {
  if (!chain?.ok || !chain.strikes?.length) return { ok: false, reason: "no chain" };
  if (!chain.isExpiryToday) return { ok: false, reason: "not expiry day" };
  if (istMin < cfg.enterFromMin || istMin > cfg.enterToMin) return { ok: false, reason: "outside v2 window" };
  const context = analyzeNiftyIndexContext({ candles5m, candles15m, nowMin: istMin, config: cfg });
  if (!context.allowed) return { ok: false, reason: context.gates[0] || "NIFTY context not confirmed", context };
  const side = context.direction === "CE" ? "ce" : "pe";
  const cands = chain.strikes.map(s => {
    const leg = s[side] || {};
    const spreadPct = leg.ltp > 0 && leg.ask ? Math.abs((leg.ask - (leg.bid || leg.ask)) / leg.ltp) : 1;
    return { strike: s.strike, leg, spreadPct };
  }).filter(x => x.leg.ltp >= cfg.minPrem && x.leg.ltp <= cfg.maxPrem
    && (x.leg.oi || 0) >= cfg.minOi && (x.leg.volume || 0) > 0
    && Math.abs(x.leg.delta || 0) >= cfg.minDelta && Math.abs(x.leg.delta || 0) <= cfg.maxDelta
    && x.spreadPct <= cfg.maxSpreadPct)
    .sort((a, b) => Math.abs(a.strike - chain.under_ltp) - Math.abs(b.strike - chain.under_ltp));
  for (const candidate of cands) {
    const structure = analyzeSelectedOption({ oi, strike: candidate.strike, direction: context.direction,
      leg: { ...candidate.leg, spreadPct: candidate.spreadPct }, config: {
        minDelta: 0, maxDelta: 1, maxSpreadPct: cfg.maxSpreadPct, optionLookback: 5,
        entryBufferATR: 0.05, stopBufferATR: 0.2, targetR: 2,
      } });
    if (structure.allowed) return { ok: true, direction: context.direction, context, structure,
      leg: { ...candidate.leg, strike: candidate.strike, spreadPct: candidate.spreadPct, expiry: chain.expiry } };
  }
  return { ok: false, reason: "no selected option premium breakout", context };
}

export function zeroHeroV2Records({ underlying, pick, lotSize, now = Date.now() }) {
  const entry = Number(pick.leg.ask || pick.leg.ltp) || 0;
  const sl = Number(pick.structure.stopPremium) || Math.max(0.05, entry * 0.7);
  const tgt = Number(pick.structure.targetPremium) || entry * 2;
  const base = { timestamp: now, entryTs: now, asset: underlying, assetId: underlying, timeframe: "options",
    nature: "Scalping", bias: pick.direction === "CE" ? "BULLISH" : "BEARISH", confidence: pick.context.score,
    entry, optionPremium: entry, stopLoss: sl, slPremium: sl, lots: 1, lotSize, maxHoldMin: 25, squareOff: true,
    expiry: pick.leg.expiry, strike: pick.leg.strike, direction: pick.direction, regime: pick.context.regime,
    style: "ZERO_HERO_V2", source: "Zero-Hero-v2", tradeType: "Paper", strategyVersion: "zero-hero-v2",
    niftyContext: { regime: pick.context.regime, direction: pick.direction, levels: pick.context.levels },
    optionStructure: { support: pick.structure.support, resistance: pick.structure.resistance,
      entryTrigger: pick.structure.entryTrigger, confirmed: pick.structure.confirmed }, outcome: "pending" };
  return [
    { ...base, id: `ZHV2-${underlying}-${now}-A`, setup: `Zero Hero v2 ${pick.leg.strike}${pick.direction} · target`,
      tgtPremium: tgt, takeProfit1: tgt, trailStop: false },
    { ...base, id: `ZHV2-${underlying}-${now}-B`, setup: `Zero Hero v2 ${pick.leg.strike}${pick.direction} · runner`,
      tgtPremium: 0, takeProfit1: 0, trailStop: true, trailArmPts: Math.max(0.05, entry - sl), trailPts: Math.max(0.05, entry - sl) },
  ];
}
