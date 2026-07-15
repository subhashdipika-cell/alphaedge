// ─── PAPER-TRADE LIFECYCLE (over the signal history store) ────────────────────
// Option paper trades live in the same history store (so the learning loop and
// guardrail counters already include them), enriched with premium fields. This
// module filters/summarises them and runs the premium-based resolver against the
// bridge /dhan/premium series.

import { fetchPremiumSeries } from "../data/bridge.js";
import { isOptionPaperTrade, resolvePaperTrade, entryTsToUtc } from "../engines/resolve.js";
import { istDayKey } from "../lib/ist.js";

export function getOptionPaperTrades(history = []) {
  return history.filter(isOptionPaperTrade);
}
export function openPaperTrades(history = []) {
  return getOptionPaperTrades(history).filter(t => (t.outcome || "pending") === "pending");
}

// Rollup stats for the blotter / R&D, optionally grouped by a key function.
export function paperTradeStats(history = [], keyFn = null) {
  const trades = getOptionPaperTrades(history).filter(t => t.outcome === "win" || t.outcome === "loss");
  const agg = () => ({ n: 0, wins: 0, losses: 0, pnlRs: 0, sumR: 0 });
  const roll = (g, t) => {
    g.n += 1;
    if (t.outcome === "win") g.wins += 1; else g.losses += 1;
    g.pnlRs += Number(t.pnlRs) || 0;
    g.sumR += Number(t.rMultiple) || 0;
  };
  const finish = (g) => ({ ...g, winRate: g.n ? (g.wins / g.n) * 100 : 0, expectancyR: g.n ? g.sumR / g.n : 0 });
  if (!keyFn) { const g = agg(); trades.forEach(t => roll(g, t)); return finish(g); }
  const groups = {};
  trades.forEach(t => { const k = keyFn(t) || "—"; (groups[k] ||= agg()); roll(groups[k], t); });
  return Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, finish(g)]));
}

// Resolve every open option paper trade against its premium series. Returns
// { changed, next } — the patched history array (caller persists + sets state).
export async function resolveOpenPaperTrades(history = []) {
  const open = openPaperTrades(history);
  if (!open.length) return { changed: false, next: history };
  const today = istDayKey(Date.now());
  const patches = new Map();

  for (const t of open) {
    // Past-expiry with no touch → settle as expired (excluded from win-rate).
    if (t.expiry && istDayKey(Date.now()) > `${t.expiry}` && istDayKey(t.timestamp) !== today) {
      patches.set(t.id, { outcome: "expired", resolvedBy: "auto-expiry", resolvedAt: Date.now() });
      continue;
    }
    try {
      const type = t.direction === "CE" || t.direction === "PE" ? t.direction
                 : (t.bias === "BULLISH" ? "CE" : "PE");
      const r = await fetchPremiumSeries(t.assetId, t.strike, type, {
        expiry: t.expiry, sinceTs: entryTsToUtc(t.entryTs || t.timestamp),
      });
      if (!r?.ok || !Array.isArray(r.series)) continue;
      const res = resolvePaperTrade({
        entryTs: t.entryTs || t.timestamp,
        entryPremium: t.optionPremium ?? t.entry,
        slPremium: t.slPremium ?? t.stopLoss,
        tgtPremium: t.tgtPremium ?? t.takeProfit1,
        lots: t.lots, lotSize: t.lotSize,
        maxHoldMin: t.maxHoldMin, squareOff: t.squareOff !== false,
        trailStop: t.trailStop === true, trailArmPts: t.trailArmPts, trailPts: t.trailPts,
        direction: type, expiry: t.expiry, underlying: t.assetId,
      }, r.series);
      if (res) patches.set(t.id, res);
    } catch { /* bridge/premium offline — retry next tick */ }
  }

  if (!patches.size) return { changed: false, next: history };
  const next = history.map(s => (patches.has(s.id) ? { ...s, ...patches.get(s.id) } : s));
  return { changed: true, next };
}
