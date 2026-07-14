// ─── INDIAN INDEX-OPTIONS TRANSACTION COSTS ───────────────────────────────────
// Realistic round-trip cost for BUYING an index option on a discount broker
// (Dhan), so paper P&L reflects what a real fill nets — not theoretical premium
// moves (the audit lesson: theoretical R overstates results 3–8× vs broker).
//
// All turnovers are on the OPTION PREMIUM (premium × quantity), not the strike.
// Rates as of 2024-10 (STT on option sale raised to 0.10%). Update COST_RATES if
// SEBI / exchange / broker rates change.

export const COST_RATES = {
  brokeragePerOrder: 20,          // Dhan F&O: ₹20/executed order OR 0.03%, whichever LOWER
  brokeragePct: 0.0003,           //   the 0.03% cap
  sttSellPct: 0.001,              // STT 0.10% on the SELL-side premium (buyer sells to exit)
  // Exchange transaction charge on premium turnover (both sides):
  exchTxnPct: { NSE: 0.0003503, BSE: 0.000325 },   // NSE ₹35.03/lakh · BSE ~₹32.5/lakh
  sebiPct: 0.000001,              // SEBI ₹10/crore, both sides
  stampBuyPct: 0.00003,           // Stamp 0.003% on the BUY-side premium
  gstPct: 0.18,                   // 18% GST on (brokerage + exch txn + SEBI)
};

// Exchange an index trades on (Sensex/Bankex are BSE; the rest NSE).
export function exchangeFor(underlying) {
  return underlying === "SENSEX" || underlying === "BANKEX" ? "BSE" : "NSE";
}

// Round-trip cost (buy + sell) for an option leg. qty = lots × lotSize.
// Returns { total, breakdown:{...} } in ₹.
export function optionRoundTripCost({ entryPremium, exitPremium, qty, exchange = "NSE" }) {
  const buyT = Math.max(0, (Number(entryPremium) || 0) * (Number(qty) || 0));
  const sellT = Math.max(0, (Number(exitPremium) || 0) * (Number(qty) || 0));
  if (!buyT && !sellT) return { total: 0, breakdown: { brokerage: 0, stt: 0, exchTxn: 0, sebi: 0, stamp: 0, gst: 0 } };
  const exch = COST_RATES.exchTxnPct[exchange] ?? COST_RATES.exchTxnPct.NSE;

  const brokerage = Math.min(COST_RATES.brokeragePerOrder, COST_RATES.brokeragePct * buyT)
                  + Math.min(COST_RATES.brokeragePerOrder, COST_RATES.brokeragePct * sellT);
  const stt = COST_RATES.sttSellPct * sellT;
  const exchTxn = exch * (buyT + sellT);
  const sebi = COST_RATES.sebiPct * (buyT + sellT);
  const stamp = COST_RATES.stampBuyPct * buyT;
  const gst = COST_RATES.gstPct * (brokerage + exchTxn + sebi);
  const total = brokerage + stt + exchTxn + sebi + stamp + gst;

  const r2 = (v) => +v.toFixed(2);
  return {
    total: r2(total),
    breakdown: { brokerage: r2(brokerage), stt: r2(stt), exchTxn: r2(exchTxn), sebi: r2(sebi), stamp: r2(stamp), gst: r2(gst) },
  };
}

// Net P&L after costs for a completed leg. Positive = profit net of all charges.
export function netOptionPnl({ entryPremium, exitPremium, qty, exchange = "NSE" }) {
  const gross = ((Number(exitPremium) || 0) - (Number(entryPremium) || 0)) * (Number(qty) || 0);
  const { total } = optionRoundTripCost({ entryPremium, exitPremium, qty, exchange });
  return { grossRs: +gross.toFixed(2), costRs: total, netRs: +(gross - total).toFixed(2) };
}
