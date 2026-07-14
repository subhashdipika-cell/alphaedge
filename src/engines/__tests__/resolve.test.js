import { describe, it, expect } from "vitest";
import { resolvePaperTrade, isOptionPaperTrade } from "../resolve.js";
import { optionRoundTripCost, netOptionPnl, exchangeFor } from "../costs.js";

// entryTs = today 09:20 IST (03:50 UTC). Series times are IST HH:MM.
const entryTs = new Date("2026-07-14T03:50:00Z").getTime();
const baseTrade = {
  entryTs, entryPremium: 100, slPremium: 70, tgtPremium: 160,
  lots: 1, lotSize: 50, maxHoldMin: 30, squareOff: true, direction: "CE", underlying: "NIFTY50",
};
const pt = (t, ltp, bid = ltp) => ({ t, ltp, bid, ask: ltp + 0.5 });

describe("costs", () => {
  it("charges brokerage + STT + exch + GST + stamp on a round trip", () => {
    const c = optionRoundTripCost({ entryPremium: 100, exitPremium: 160, qty: 50, exchange: "NSE" });
    expect(c.total).toBeGreaterThan(0);
    expect(c.breakdown.stt).toBeGreaterThan(0);        // STT on sell
    expect(c.breakdown.brokerage).toBeGreaterThan(0);
    expect(c.breakdown.gst).toBeGreaterThan(0);
  });
  it("nets gross minus cost", () => {
    const n = netOptionPnl({ entryPremium: 100, exitPremium: 160, qty: 50, exchange: "NSE" });
    expect(n.grossRs).toBe(3000);                       // (160-100)*50
    expect(n.costRs).toBeGreaterThan(0);
    expect(n.netRs).toBeLessThan(n.grossRs);
    expect(n.netRs).toBe(+(n.grossRs - n.costRs).toFixed(2));
  });
  it("routes SENSEX to BSE", () => {
    expect(exchangeFor("SENSEX")).toBe("BSE");
    expect(exchangeFor("NIFTY50")).toBe("NSE");
  });
});

describe("resolvePaperTrade", () => {
  it("returns null while the premium stays between SL and target", () => {
    const series = [pt("09:25", 105), pt("09:30", 110), pt("09:35", 98)];
    expect(resolvePaperTrade(baseTrade, series)).toBeNull();
  });

  it("resolves a target hit as a NET win", () => {
    const series = [pt("09:25", 120), pt("09:40", 165)];
    const r = resolvePaperTrade(baseTrade, series);
    expect(r.outcome).toBe("win");
    expect(r.exitPremium).toBe(160);         // capped at target
    expect(r.grossPnlRs).toBe(3000);
    expect(r.costRs).toBeGreaterThan(0);
    expect(r.pnlRs).toBe(+(r.grossPnlRs - r.costRs).toFixed(2));  // net
  });

  it("resolves an SL hit as a loss", () => {
    const series = [pt("09:25", 90), pt("09:30", 68)];
    const r = resolvePaperTrade(baseTrade, series);
    expect(r.outcome).toBe("loss");
    expect(r.exitPremium).toBe(70);
    expect(r.pnlRs).toBeLessThan(0);
  });

  it("is SL-first when SL and target both hit in the same bar", () => {
    // one bar where bid <= SL AND >= target is impossible, but simulate a spike bar
    // whose bid touches SL — SL must win because it's checked first.
    const series = [pt("09:25", 70, 70)];   // bid 70 == SL
    const r = resolvePaperTrade({ ...baseTrade, tgtPremium: 70 }, series);
    expect(r.outcome).toBe("loss");
  });

  it("applies the theta time-stop after maxHoldMin", () => {
    // entry 09:20, maxHold 30m → 09:50. A 09:55 bar in-between SL/target time-stops.
    const series = [pt("09:35", 108), pt("09:55", 112)];
    const r = resolvePaperTrade(baseTrade, series);
    expect(r.exitReason).toMatch(/time-stop/);
    expect(r.exitPremium).toBe(112);
  });

  it("squares off at 15:15 IST", () => {
    const longHold = { ...baseTrade, maxHoldMin: 24 * 60 };
    const series = [pt("15:15", 130)];
    const r = resolvePaperTrade(longHold, series);
    expect(r.exitReason).toMatch(/square-off/);
  });
});

describe("isOptionPaperTrade", () => {
  it("matches enriched paper records only", () => {
    expect(isOptionPaperTrade({ tradeType: "Paper", strike: 24000, optionPremium: 100, slPremium: 70 })).toBe(true);
    expect(isOptionPaperTrade({ tradeType: "Paper", bias: "BULLISH" })).toBe(false);   // legacy spot signal
    expect(isOptionPaperTrade(null)).toBe(false);
  });
});
