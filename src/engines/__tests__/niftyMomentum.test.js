import { describe, it, expect } from "vitest";
import { analyzeNiftyIndexContext, analyzeSelectedOption } from "../niftyMomentum.js";
import { analyzeOiTrend } from "../oi.js";

function candles(n = 80, start = 24000, step = 8) {
  const out = []; let px = start;
  for (let i = 0; i < n; i++) {
    const open = px; px += i % 12 === 0 && i > 0 ? -step * 2 : step;
    out.push({ open, high: px + 4, low: open - 4, close: px, vol: 1000 + i * 4, bull: true, ts: i * 300000 });
  }
  return out;
}

describe("Dhan NIFTY option-premium scalp context", () => {
  it("fails closed instead of crashing when Dhan candles are null", () => {
    const r = analyzeNiftyIndexContext({ candles5m: null, candles15m: null });
    expect(r.direction).toBe("NO_TRADE");
    expect(r.regime).toBe("INSUFFICIENT_DATA");
    expect(r.gates[0]).toMatch(/Insufficient Dhan NIFTY chart history/);
  });

  it("uses the NIFTY chart to establish directional context", () => {
    const c5 = candles(100, 24000, 8), c15 = candles(100, 24000, 20);
    const r = analyzeNiftyIndexContext({ candles5m: c5, candles15m: c15, nowMin: 10 * 60 });
    expect(r.direction).toBe("CE");
    expect(r.regime).toBe("TREND_UP");
    expect(r.levels.support).toBeTruthy();
  });

  it("uses the selected option premium path for entry, stop and target", () => {
    const r = analyzeSelectedOption({
      strike: 24100, direction: "CE",
      leg: { ltp: 120, bid: 119.5, ask: 120.5, oi: 100000, volume: 5000, delta: 0.52, spreadPct: 0.004 },
      oi: { strikes: [{ strike: 24100, ce: { ltp: [100, 104, 108, 114, 120], vol: [100, 200, 300, 400, 500] } }] },
    });
    expect(r.candles.length).toBe(5);
    expect(r.resistance).toBeLessThanOrEqual(120);
    expect(r.stopPremium).toBeLessThan(r.current);
    expect(r.targetPremium).toBeGreaterThan(r.current);
  });

  it("keeps the selected option premium history after OI analysis", () => {
    const leg = { oi: [100000, 101000, 102000, 103000], ltp: [100, 104, 108, 114],
      iv: [14, 14, 14, 14], vol: [100, 200, 300, 400], delta: 0.52, prevOi: 99000 };
    const analyzed = analyzeOiTrend({ ok: true, underlying: "NIFTY50", expiry: "2026-12-31",
      source: "test", marketOpen: true, bucketMin: 5, atmStrike: 24100,
      times: ["09:15", "09:20", "09:25", "09:30"], underLtp: [24000, 24010, 24020, 24030],
      strikes: [{ strike: 24100, atm: true, ce: leg, pe: leg }] });
    const r = analyzeSelectedOption({ oi: analyzed, strike: 24100, direction: "CE",
      leg: { ltp: 114, bid: 113.5, ask: 114.5, oi: 103000, volume: 400, delta: 0.52, spreadPct: 0.009 } });
    expect(r.candles.length).toBe(4);
    expect(r.candles.at(-1).close).toBe(114);
  });
});
