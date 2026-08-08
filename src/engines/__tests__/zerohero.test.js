import { describe, it, expect } from "vitest";
import { zeroHeroPick, zeroHeroRecords, zeroHeroV2Pick, zeroHeroV2Records,
  zeroHeroDivergencePick, zeroHeroDivergenceRecord } from "../zerohero.js";

const IN_WINDOW = 14 * 60;         // 14:00 IST
const upDay = Array.from({ length: 40 }, (_, i) => ({ close: 24100 + i * 6 }));
const dnDay = Array.from({ length: 40 }, (_, i) => ({ close: 24300 - i * 6 }));

function chain({ expiryToday = true } = {}) {
  const mk = (strike, ceLtp, peLtp) => ({
    strike,
    ce: { ltp: ceLtp, oi: 50000, delta: 0.1 },
    pe: { ltp: peLtp, oi: 50000, delta: -0.1 },
  });
  return {
    ok: true, underlying: "NIFTY50", under_ltp: 24300, expiry: "2026-07-21",
    isExpiryToday: expiryToday,
    strikes: [
      mk(24300, 60, 55),      // ATM — far above the band
      mk(24400, 18, 130),
      mk(24450, 4.6, 180),    // CE in the ₹3–5 band, nearer to spot
      mk(24500, 3.2, 240),    // CE in the band, further out
      mk(24150, 130, 4.1),    // PE in the band
    ],
  };
}

function v2Chain() {
  const c = chain();
  c.strikes = [{ strike: 24450, ce: { ltp: 4.6, oi: 50000, volume: 10000, delta: 0.2, bid: 4.55, ask: 4.65 }, pe: { ltp: 180, oi: 50000 } }];
  return c;
}

const v2Oi = { ok: true, rows: [{ strike: 24450, ce: { oi: 50000, ltp: 4.6, ltpSeries: [3, 3.2, 3.5, 4, 4.6], volSeries: [100, 200, 300, 400, 500], delta: 0.2 }, pe: {} }] };
const v2Candles = Array.from({ length: 80 }, (_, i) => {
  const open = 24000 + i * 4, close = open + 4;
  return { open, high: close + 3, low: open - 3, close, vol: 1000, ts: i * 300000 };
});

describe("zeroHeroPick", () => {
  it("FADES an up-trending expiry day (buys the PE) — spikes are reversal-driven", () => {
    const r = zeroHeroPick({ chain: chain(), candles5m: upDay, istMin: IN_WINDOW });
    expect(r.ok).toBe(true);
    expect(r.direction).toBe("PE");
    expect(r.leg.strike).toBe(24150);       // in-band PE (₹4.1)
  });

  it("fades a down-trending day (buys the CE nearest to spot)", () => {
    const r = zeroHeroPick({ chain: chain(), candles5m: dnDay, istMin: IN_WINDOW });
    expect(r.ok).toBe(true);
    expect(r.direction).toBe("CE");
    expect(r.leg.strike).toBe(24450);       // ₹4.6, closer than 24500's ₹3.2
    expect(r.leg.ltp).toBe(4.6);
  });

  it("refuses outside the 14:00–14:45 window and on non-expiry days", () => {
    expect(zeroHeroPick({ chain: chain(), candles5m: upDay, istMin: 12 * 60 }).ok).toBe(false);
    expect(zeroHeroPick({ chain: chain(), candles5m: upDay, istMin: 13 * 60 + 50 }).ok).toBe(false);  // pre-14:00 bucket is EV-negative
    expect(zeroHeroPick({ chain: chain(), candles5m: upDay, istMin: 15 * 60 }).ok).toBe(false);
    expect(zeroHeroPick({ chain: chain({ expiryToday: false }), candles5m: upDay, istMin: IN_WINDOW }).ok).toBe(false);
  });

  it("skips when no strike sits in the premium band with enough OI", () => {
    const c = chain();
    c.strikes.forEach(s => { s.ce.oi = 100; s.pe.oi = 100; });   // below minOi
    const r = zeroHeroPick({ chain: c, candles5m: upDay, istMin: IN_WINDOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no ₹/);
  });
});

describe("zeroHeroRecords", () => {
  const pick = zeroHeroPick({ chain: chain(), candles5m: upDay, istMin: IN_WINDOW });
  const recs = zeroHeroRecords({ underlying: "NIFTY50", pick, lotSize: 65, now: 1752750000000 });

  it("splits 2 lots into a 2×-target leg and a trailing runner", () => {
    expect(recs).toHaveLength(2);
    const [a, b] = recs;
    expect(a.lots).toBe(1); expect(b.lots).toBe(1);
    expect(a.tgtPremium).toBe(8.2);          // 2 × ₹4.1 (fade-side PE) — sell half at double
    expect(a.trailStop).toBe(false);
    expect(b.tgtPremium).toBe(0);            // runner: no fixed target
    expect(b.trailStop).toBe(true);
    expect(b.trailArmPts).toBe(4.1);         // arms once the premium doubles
  });

  it("is a max-loss-limited lottery: SL 0 (the premium IS the risk), square-off on", () => {
    for (const r of recs) {
      expect(r.slPremium).toBe(0);
      expect(r.squareOff).toBe(true);
      expect(r.source).toBe("Zero-Hero");
      expect(r.style).toBe("ZERO_HERO");
    }
  });
});

describe("zeroHeroV2Pick", () => {
  it("requires NIFTY context and selected-option premium breakout", () => {
    const pick = zeroHeroV2Pick({ chain: v2Chain(), oi: v2Oi, candles5m: v2Candles, candles15m: v2Candles,
      istMin: IN_WINDOW, cfg: { enterFromMin: IN_WINDOW, enterToMin: IN_WINDOW + 45, minPrem: 3, maxPrem: 5,
        minOi: 5000, minIndexScore: 3, minDelta: 0.05, maxDelta: 0.35, maxSpreadPct: 0.08,
        contextFromMin: IN_WINDOW, contextToMin: IN_WINDOW + 45 } });
    expect(pick.ok).toBe(true);
    expect(pick.direction).toBe("CE");
    expect(pick.structure.confirmed).toBe(true);
    const recs = zeroHeroV2Records({ underlying: "NIFTY50", pick, lotSize: 65 });
    expect(recs[0].source).toBe("Zero-Hero-v2");
    expect(recs[0].slPremium).toBeGreaterThan(0);
    expect(recs[0].tgtPremium).toBeGreaterThan(recs[0].entry);
  });
});

function divergenceCandles({ breakout = null } = {}) {
  const rows = [];
  for (let i = 0; i < 57; i++) {
    const min = 9 * 60 + 15 + i * 5;
    const ts = Date.UTC(2026, 6, 21, Math.floor((min - 330) / 60), (min - 330) % 60);
    let close = 100;
    if (i === 56 && breakout === "up") close = 105;
    if (i === 56 && breakout === "down") close = 95;
    rows.push({ ts, open: close, high: close + 1, low: close - 1, close, vol: 1000 });
  }
  return rows;
}

function divergenceChain({ expiryToday = true } = {}) {
  return {
    ok: true, isExpiryToday: expiryToday, expiry: "2026-07-21", under_ltp: 100,
    strikes: [{ strike: 100, ce: { ltp: 20, bid: 20.4, ask: 20.5, oi: 10000, volume: 5000, delta: 0.5 },
      pe: { ltp: 20, bid: 20.4, ask: 20.5, oi: 10000, volume: 5000, delta: -0.5 } }],
  };
}

describe("zeroHeroDivergencePick", () => {
  it("buys an ATM CE on the lagging index after driver breakout", () => {
    const r = zeroHeroDivergencePick({ candlesA: divergenceCandles({ breakout: "up" }),
      candlesB: divergenceCandles(), chainB: divergenceChain(), istMin: 14 * 60 });
    expect(r.ok).toBe(true); expect(r.direction).toBe("CE"); expect(r.leg.strike).toBe(100);
    expect(r.leg.stopPremium).toBe(10.25); expect(r.leg.targetPremium).toBe(123);
  });

  it("buys an ATM PE on the lagging index after driver breakdown", () => {
    const r = zeroHeroDivergencePick({ candlesA: divergenceCandles({ breakout: "down" }),
      candlesB: divergenceCandles(), chainB: divergenceChain(), istMin: 14 * 60 });
    expect(r.ok).toBe(true); expect(r.direction).toBe("PE");
  });

  it("rejects simultaneous breakouts, missing candles, and non-expiry chains", () => {
    expect(zeroHeroDivergencePick({ candlesA: divergenceCandles({ breakout: "up" }),
      candlesB: divergenceCandles({ breakout: "up" }), chainB: divergenceChain(), istMin: 14 * 60 }).ok).toBe(false);
    expect(zeroHeroDivergencePick({ candlesA: [], candlesB: [], chainB: divergenceChain(), istMin: 14 * 60 }).ok).toBe(false);
    expect(zeroHeroDivergencePick({ candlesA: divergenceCandles({ breakout: "up" }),
      candlesB: divergenceCandles(), chainB: divergenceChain({ expiryToday: false }), istMin: 14 * 60 }).ok).toBe(false);
  });

  it("records one paper trade with a strict 10R premium plan", () => {
    const pick = zeroHeroDivergencePick({ candlesA: divergenceCandles({ breakout: "up" }),
      candlesB: divergenceCandles(), chainB: divergenceChain(), istMin: 14 * 60 });
    const record = zeroHeroDivergenceRecord({ pick, lotSize: 35, now: 123 });
    expect(record.strategyVersion).toBe("zero-hero-divergence-v1");
    expect(record.slPremium).toBe(10.25); expect(record.tgtPremium).toBe(123);
    expect(record.lots).toBe(1); expect(record.source).toBe("Zero-Hero-Divergence");
  });
});
