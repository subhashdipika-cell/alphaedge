import { describe, it, expect } from "vitest";
import { analyzeOiTrend, oiIctConfluence } from "../oi.js";

// Synthetic oitrend payload: rising underlying, heavy PUT writing at the 95 strike
// (support building below) and a CALL wall at 105. 4 buckets × 5 min.
function buildPayload() {
  const times = ["09:15", "09:20", "09:25", "09:30"];
  const underLtp = [100, 101, 102, 103];
  const leg = (oiArr, iv = 15, delta = 0.5, prevOi = null) => ({
    oi: oiArr,
    ltp: oiArr.map(() => 30),
    iv: oiArr.map(() => iv),
    vol: oiArr.map((_, i) => 100 * (i + 1)),
    delta,
    prevOi: prevOi ?? oiArr[0],
  });
  return {
    ok: true, underlying: "NIFTY50", expiry: "2026-12-31", asOf: "09:30",
    source: "live-csv", marketOpen: true, bucketMin: 5, atmStrike: 100,
    times, underLtp,
    strikes: [
      // 95: PE OI ramps 2000→5000 (put writing), CE flat
      { strike: 95,  atm: false, ce: leg([1000, 1000, 1000, 1000]), pe: leg([2000, 3000, 4000, 5000], 16, -0.2) },
      // 100 (ATM): balanced
      { strike: 100, atm: true,  ce: leg([1500, 1550, 1500, 1500]), pe: leg([1500, 1500, 1450, 1500]) },
      // 105: CE wall (highest CE OI), PE thin
      { strike: 105, atm: false, ce: leg([3000, 3050, 3100, 3200], 14, 0.3), pe: leg([500, 500, 500, 500]) },
    ],
  };
}

describe("analyzeOiTrend", () => {
  const r = analyzeOiTrend(buildPayload());

  it("returns ok with the core fields", () => {
    expect(r.ok).toBe(true);
    expect(r.atmStrike).toBe(100);
    expect(r.underLtp).toBe(103);
    expect(r.dayChange).toBe(3);
  });

  it("computes ΔOI-since-open and positive velocity for the building put leg", () => {
    const s95 = r.rows.find(x => x.strike === 95);
    expect(s95.pe.dOiOpen).toBe(3000);        // 5000 - 2000
    expect(s95.pe.vel[15]).toBeGreaterThan(0); // OI rising over 15 min
  });

  it("reads heavy put writing as a BULLISH writer bias and smart-money bias", () => {
    expect(r.matrix.writerBias).toBe("BULLISH");
    expect(r.smartMoney.bias).toBe("BULLISH");
    expect(r.smartMoney.strength).toBeGreaterThan(0);
    expect(r.smartMoney.reasons.length).toBeGreaterThan(0);
  });

  it("locates the PE wall as support (95) and the CE wall as resistance (105)", () => {
    expect(r.walls.support.strike).toBe(95);
    expect(r.walls.resistance.strike).toBe(105);
    expect(r.walls.support.strength).toBeGreaterThan(1);
  });

  it("classifies the trailing move (price up + put writing) as LONG_BUILDUP", () => {
    expect(r.matrix.underlying).toBe("LONG_BUILDUP");
  });

  it("surfaces the biggest OI spurt (95 PE, +150%)", () => {
    expect(r.spurts.length).toBeGreaterThan(0);
    const top = r.spurts[0];
    expect(top.strike).toBe(95);
    expect(top.type).toBe("PE");
    expect(top.pct).toBeCloseTo(150, 0);   // 2000 → 5000
  });

  it("returns a Max Pain strike within the chain and a gamma wall strike", () => {
    expect([95, 100, 105]).toContain(r.maxPain);
    expect([95, 100, 105]).toContain(r.gammaWall);
  });

  it("builds aligned PCR / total-OI series the length of the time axis", () => {
    expect(r.series.pcr).toHaveLength(4);
    expect(r.series.ceOiTotal).toHaveLength(4);
    expect(r.series.pcr.every(v => v > 0)).toBe(true);
  });
});

describe("analyzeOiTrend guards", () => {
  it("returns ok:false on an empty payload", () => {
    expect(analyzeOiTrend(null).ok).toBe(false);
    expect(analyzeOiTrend({ ok: true, strikes: [] }).ok).toBe(false);
  });
});

describe("oiIctConfluence", () => {
  it("flags HIGH confluence when OI and structure agree with strength", () => {
    const sm = { bias: "BULLISH", strength: 0.6 };
    const walls = { support: { strike: 95 }, resistance: { strike: 105 } };
    const c = oiIctConfluence(sm, walls, 100, { bias: "BULLISH" });
    expect(c.level).toBe("HIGH");
    expect(c.agree).toBe(true);
  });
  it("flags LOW confluence when they disagree", () => {
    const sm = { bias: "BULLISH", strength: 0.6 };
    const walls = { support: { strike: 95 }, resistance: { strike: 105 } };
    const c = oiIctConfluence(sm, walls, 100, { bias: "BEARISH" });
    expect(c.level).toBe("LOW");
    expect(c.agree).toBe(false);
  });
});
