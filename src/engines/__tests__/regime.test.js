import { describe, it, expect } from "vitest";
import { detectRegime, priorDayContext } from "../regime.js";

// Two IST days of 15m candles with real epoch timestamps.
// Day 1 (2026-07-16): shaped by `prevShape`. Day 2 (2026-07-17): shaped by `todayShape`.
function twoDays(prevShape, todayShape) {
  const mk = (startUtcIso, prices) => {
    const t0 = new Date(startUtcIso).getTime();
    return prices.map((p, i) => ({
      ts: t0 + i * 15 * 60000,
      open: i === 0 ? prices[0] : prices[i - 1],
      close: p, high: Math.max(i === 0 ? prices[0] : prices[i - 1], p) + 4,
      low: Math.min(i === 0 ? prices[0] : prices[i - 1], p) - 4, bull: true, vol: 100,
    }));
  };
  return [...mk("2026-07-16T04:00:00Z", prevShape), ...mk("2026-07-17T04:00:00Z", todayShape)];
}
const ramp = (from, to, n = 25) => Array.from({ length: n }, (_, i) => from + (to - from) * (i / (n - 1)));
const flat = (mid, n = 25) => Array.from({ length: n }, (_, i) => (i === n - 1 ? mid : mid + (i % 2 ? 15 : -15)));

describe("priorDayContext", () => {
  it("classifies a trend-up day with a strong close and reads today's gap", () => {
    const c = twoDays(ramp(24000, 24240), ramp(24340, 24400));   // opens +100 over pdc
    const pd = priorDayContext(c);
    expect(pd.dayType).toBe("TREND_UP");
    expect(pd.strongClose).toBe("high");
    expect(pd.closePos).toBeGreaterThan(0.75);
    expect(pd.gapPct).toBeGreaterThan(0.3);                       // ~+0.41%
    expect(pd.openLoc).toBe("above-range");
  });

  it("classifies a range day and an in-range open", () => {
    const c = twoDays(flat(24100), flat(24110));
    const pd = priorDayContext(c);
    expect(pd.dayType).toBe("RANGE");
    expect(pd.strongClose).toBeNull();
    expect(pd.openLoc).toBe("in-range");
    expect(pd.insideYRange).toBe(true);
  });

  it("returns null with fewer than two days of candles", () => {
    const oneDay = twoDays(ramp(24000, 24100), ramp(24100, 24150)).slice(0, 20);
    expect(priorDayContext(oneDay)).toBeNull();
  });
});

describe("detectRegime — prior-day adjustments", () => {
  it("attaches priorDay and rewards continuation after a strong trend close", () => {
    // Yesterday trend-up closing at highs; today keeps trending up → TREND_BULL
    // with the continuation reason and a boosted confidence.
    const c = twoDays(ramp(23600, 24100), ramp(24110, 24500));
    const r = detectRegime({ candles: c });
    expect(r.priorDay).toBeTruthy();
    expect(r.priorDay.dayType).toBe("TREND_UP");
    if (r.bias === "BULLISH" || r.regime === "BREAKOUT") {
      expect(r.reasons.some(x => /continuation context/.test(x))).toBe(true);
    }
  });

  it("dampens confidence on a large gap", () => {
    // Yesterday mild range ~24100, today opens +200 (~0.83% gap).
    const c = twoDays(flat(24100), flat(24300));
    const r = detectRegime({ candles: c });
    expect(r.priorDay.gapPct).toBeGreaterThan(0.5);
    expect(r.reasons.some(x => /Gapped/.test(x))).toBe(true);
  });

  it("carries priorDay through the expiry-day early return", () => {
    const c = twoDays(flat(24100), flat(24120));
    const r = detectRegime({ candles: c, chain: { isExpiryToday: true } });
    expect(r.regime).toBe("EXPIRY");
    expect(r.priorDay).toBeTruthy();
  });
});
