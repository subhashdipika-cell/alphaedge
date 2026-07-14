// ─── PREMIUM-BASED PAPER-TRADE RESOLUTION ─────────────────────────────────────
// Option paper trades must resolve against the OPTION PREMIUM path, not the
// underlying spot — a long call can bleed to its SL on theta while spot never
// touches an underlying level. This walks the minute-level premium series from
// /dhan/premium and decides win / loss / time-stop / square-off, SL-first on
// ambiguity. Because it replays the whole series, a trade resolves correctly
// even if the app was closed all day.
//
// Pure: resolvePaperTrade(trade, series) → outcome patch | null (still open).

import { netOptionPnl, optionRoundTripCost, exchangeFor } from "./costs.js";

const IST_SQUAREOFF_MIN = 15 * 60 + 15;   // 15:15 IST intraday flat

// "HH:MM" → minutes since midnight.
function hhmmToMin(t) {
  if (typeof t !== "string" || !t.includes(":")) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// IST minutes-of-day for a ms timestamp.
function istMinutes(ts) {
  const d = new Date(ts + (new Date(ts).getTimezoneOffset() + 330) * 60000);
  return d.getHours() * 60 + d.getMinutes();
}

// Identify an option paper trade (vs a legacy spot signal).
export function isOptionPaperTrade(rec) {
  return !!(rec && rec.tradeType === "Paper" && rec.strike != null &&
            Number.isFinite(Number(rec.optionPremium)) && Number.isFinite(Number(rec.slPremium)));
}

// Walk the premium series and resolve, or return null if still open.
// trade: { entryTs, entryPremium|optionPremium, slPremium, tgtPremium, lots, lotSize, maxHoldMin, squareOff, direction, expiry }
// series: [{ t:"HH:MM", ltp, bid, ask }] (IST), typically already filtered to >= entry.
export function resolvePaperTrade(trade, series) {
  if (!Array.isArray(series) || !series.length) return null;
  const entry = Number(trade.entryPremium ?? trade.optionPremium);
  const sl = Number(trade.slPremium);
  const tgt = Number(trade.tgtPremium);
  if (!(entry > 0) || !(sl >= 0)) return null;
  const entryMin = istMinutes(trade.entryTs || trade.timestamp || Date.now());
  const lots = Number(trade.lots) || 0;
  const lotSize = Number(trade.lotSize) || 0;
  const riskPerUnit = entry - sl;
  const ctx = { entry, riskPerUnit, qty: lots * lotSize, exchange: exchangeFor(trade.underlying || trade.assetId) };

  let mfe = entry, mae = entry;   // max favourable / adverse premium
  for (const pt of series) {
    const ptMin = hhmmToMin(pt.t);
    if (ptMin == null || ptMin < entryMin) continue;
    const bid = Number(pt.bid ?? pt.ltp) || 0;   // you EXIT at the bid (conservative)
    const ltp = Number(pt.ltp ?? pt.bid) || 0;
    if (bid > mfe) mfe = bid;
    if (bid < mae) mae = bid;
    const held = ptMin - entryMin;

    const slHit = bid <= sl;
    const tgtHit = tgt > 0 && bid >= tgt;
    // SL-first: checked before target, so an ambiguous same-minute bar resolves against us.
    if (slHit) return exit(outcomeOf(sl, entry), sl, pt, "SL hit on premium", { ...ctx, mfe, mae });
    if (tgtHit) return exit(outcomeOf(tgt, entry), tgt, pt, "Target hit on premium", { ...ctx, mfe, mae });
    if (trade.maxHoldMin && held >= trade.maxHoldMin)
      return exit(outcomeOf(ltp, entry), ltp, pt, `Theta time-stop (${trade.maxHoldMin}m)`, { ...ctx, mfe, mae });
    if (trade.squareOff && ptMin >= IST_SQUAREOFF_MIN)
      return exit(outcomeOf(ltp, entry), ltp, pt, "15:15 IST square-off", { ...ctx, mfe, mae });
  }
  return null;   // no touch yet — still open
}

// Outcome is decided by NET P&L (after brokerage + taxes) — a target-touch that
// nets negative after costs is honestly a loss.
function outcomeOf(exitPremium, entry) { return exitPremium >= entry ? "win" : "loss"; }

function exit(_outcomeHint, exitPremium, pt, reason, { entry, riskPerUnit, qty, exchange, mfe, mae }) {
  const { grossRs, costRs, netRs } = netOptionPnl({ entryPremium: entry, exitPremium, qty, exchange });
  const pnlPerUnit = exitPremium - entry;
  const rMultiple = riskPerUnit ? +(pnlPerUnit / riskPerUnit).toFixed(2) : 0;   // gross premium R
  return {
    outcome: netRs >= 0 ? "win" : "loss",   // NET of costs
    exitPremium: +exitPremium.toFixed(2),
    exitReason: reason,
    exitAt: pt.t,
    pnlRs: netRs, grossPnlRs: grossRs, costRs, rMultiple,
    mfe: +mfe.toFixed(2), mae: +mae.toFixed(2),
    resolvedBy: "auto-premium",
    resolvedAt: Date.now(),
  };
}

// Estimate the round-trip cost of a leg (for live P&L / plan display).
export function estimateCost({ entryPremium, exitPremium, lots, lotSize, underlying }) {
  return optionRoundTripCost({ entryPremium, exitPremium, qty: (lots || 0) * (lotSize || 0), exchange: exchangeFor(underlying) }).total;
}

// Convert an entry timestamp (ms) to the collector CSV's UTC "YYYY-MM-DD HH:MM:SS"
// for the /dhan/premium sinceTs filter.
export function entryTsToUtc(ts) {
  return new Date(ts).toISOString().slice(0, 19).replace("T", " ");
}
