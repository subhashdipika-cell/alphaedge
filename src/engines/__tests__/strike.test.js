import { describe, it, expect, beforeEach, vi } from "vitest";
import { selectStrike, optionsTradePlan } from "../strike.js";

beforeEach(() => {
  const store = {};
  vi.stubGlobal("localStorage", {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
});

// NIFTY PE chain: deltas 0.65 / 0.55 / 0.45 with premiums 250 / 216 / 160.
// Lot 65 → risk/lot at the default 30% SL: ₹4,875 / ₹4,225 / ₹3,120.
function chain() {
  const rows = [
    { strike: 24250, pe: { ltp: 250, delta: -0.65, oi: 300000, iv: 15, theta: -11, bid: 249.5, ask: 250.5 } },
    { strike: 24150, pe: { ltp: 216, delta: -0.55, oi: 250000, iv: 15, theta: -12, bid: 215.5, ask: 216.5 } },
    { strike: 24050, pe: { ltp: 160, delta: -0.45, oi: 280000, iv: 15, theta: -12, bid: 159.5, ask: 160.5 } },
  ].map(r => ({ ...r, atm: r.strike === 24150, ce: {} }));
  return { ok: true, underlying: "NIFTY50", under_ltp: 24100, expiry: "2026-07-21", strikes: rows };
}
const base = { chain: chain(), direction: "PE", minPremium: 40, underlying: "NIFTY50", mm: {} };

describe("selectStrike — affordability-aware walk", () => {
  it("picks the ideal-delta strike when no budget constraint is given", () => {
    const pick = selectStrike({ ...base });
    expect(pick.leg.strike).toBe(24150);         // Δ0.55 = the ideal
    expect(pick.unaffordable).toBeUndefined();
  });

  it("keeps the ideal strike when the budget covers it", () => {
    const pick = selectStrike({ ...base, budget: 10000 });
    expect(pick.leg.strike).toBe(24150);
  });

  it("steps to a cheaper in-band strike when one lot of the ideal busts the budget", () => {
    // ₹4,000 budget (₹4L @ 1%): Δ0.55 risks ₹4,225 → steps to Δ0.45 (₹3,120 fits).
    const pick = selectStrike({ ...base, budget: 4000 });
    expect(pick.leg.strike).toBe(24050);
    expect(pick.leg.delta).toBe(-0.45);
    expect(pick.unaffordable).toBeUndefined();
    expect(pick.reasons.some(r => /stepped to this affordable/.test(r))).toBe(true);
    // And the plan sized from it actually affords a lot at that budget.
    const plan = optionsTradePlan({ rec: { ltp: pick.leg.ltp }, underlying: "NIFTY50",
      mm: { capital: 400000, rr: 2 }, riskPct: 1 });
    expect(plan.lots).toBeGreaterThanOrEqual(1);
    expect(plan.affordable).toBe(true);
  });

  it("returns the ideal pick flagged unaffordable when nothing in the pool fits", () => {
    const pick = selectStrike({ ...base, budget: 2000 });
    expect(pick.leg.strike).toBe(24150);          // unchanged ideal
    expect(pick.unaffordable).toBe(true);
    expect(pick.reasons.some(r => /No strike in the pool fits/.test(r))).toBe(true);
  });

  it("respects a fixed SL from Money Mgt in the risk-per-lot math", () => {
    // Fixed 50-pt SL → every leg risks 50×65 = ₹3,250 → ideal fits a ₹4,000 budget.
    const pick = selectStrike({ ...base, budget: 4000, mm: { useSL: true, slPoints: 50 } });
    expect(pick.leg.strike).toBe(24150);
  });

  it("affordability walk uses the structural stop per-leg (delta-converted)", () => {
    // stopUnder 130: Δ0.55 → 72 pts ×65 = ₹4,645 (busts ₹4,000) → Δ0.45 → 59 pts ×65 = ₹3,802 ✓
    const pick = selectStrike({ ...base, budget: 4000, stopUnder: 130 });
    expect(pick.leg.strike).toBe(24050);
    expect(pick.leg.delta).toBe(-0.45);
  });
});

describe("optionsTradePlan — structure-based SL", () => {
  const mm = { capital: 400000, rr: 2 };

  it("places the SL behind structure, premium via delta, and sizes to it", () => {
    const plan = optionsTradePlan({ rec: { ltp: 200, delta: -0.5 }, underlying: "NIFTY50", mm, riskPct: 1,
      structStop: { stopUnder: 100, level: 24100, kinds: ["pdl"], capped: null } });
    expect(plan.slPts).toBe(50);            // 100 underlying pts × 0.5 delta
    expect(plan.slBasis).toBe("structure");
    expect(plan.slLevel).toBe(24100);
    expect(plan.slPrice).toBe(150);
    expect(plan.lots).toBe(1);              // ₹4,000 // (50 × 65) = 1
    expect(plan.tgtPts).toBe(100);          // rr 2 on the structural stop
  });

  it("falls back to 30% of premium when there is no structural stop", () => {
    const plan = optionsTradePlan({ rec: { ltp: 200, delta: -0.5 }, underlying: "NIFTY50", mm, riskPct: 1 });
    expect(plan.slPts).toBe(60);            // 30% of 200
    expect(plan.slBasis).toBe("pct");
  });

  it("a fixed Money-Mgt SL overrides the structural stop", () => {
    const plan = optionsTradePlan({ rec: { ltp: 200, delta: -0.5 }, underlying: "NIFTY50",
      mm: { ...mm, useSL: true, slPoints: 40 }, riskPct: 1,
      structStop: { stopUnder: 100, level: 24100, kinds: ["pdl"], capped: null } });
    expect(plan.slPts).toBe(40);
    expect(plan.slBasis).toBe("fixed");
  });
});
