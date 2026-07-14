import { describe, it, expect, beforeEach, vi } from "vitest";
import { scoreOption, DEFAULT_WEIGHTS } from "../score.js";

beforeEach(() => {
  const store = {};
  vi.stubGlobal("localStorage", {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
});

// ── candle builders ──
function trendUp(n = 120, start = 24000, step = 12) {
  const out = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const o = px; px += step + (i % 3 === 0 ? -step * 0.3 : step * 0.2);
    const c = px;
    out.push({ open: o, high: Math.max(o, c) + 5, low: Math.min(o, c) - 5, close: c, bull: c >= o, vol: 1000 + i * 5, ts: i * 300000 });
  }
  return out;
}
function chop(n = 120, mid = 24000) {
  return Array.from({ length: n }, (_, i) => {
    const o = mid + (i % 2 ? 8 : -8), c = mid + (i % 2 ? -8 : 8);
    return { open: o, high: mid + 15, low: mid - 15, close: c, bull: c >= o, vol: 800, ts: i * 300000 };
  });
}

// Bullish option chain: ATM 24150, delta ~0.5 calls, decent premium, cheap IV.
function bullChain() {
  const strikes = [24000, 24050, 24100, 24150, 24200, 24250, 24300].map(k => {
    const atm = k === 24150;
    const ceDelta = Math.max(0.05, Math.min(0.95, 0.5 + (24150 - k) / 500));
    const peDelta = -(1 - ceDelta);
    return {
      strike: k, atm,
      ce: { ltp: Math.max(20, 120 - (k - 24000) * 0.08), oi: 100000 + (k >= 24200 ? 400000 : 50000), iv: 14, delta: +ceDelta.toFixed(2), theta: -4, bid: 60, ask: 61 },
      pe: { ltp: Math.max(20, 40 + (k - 24000) * 0.08), oi: 100000 + (k <= 24050 ? 400000 : 50000), iv: 15, delta: +peDelta.toFixed(2), theta: -4, bid: 40, ask: 41 },
    };
  });
  return { ok: true, underlying: "NIFTY50", under_ltp: 24160, expiry: "2026-12-31", isExpiryToday: false, ivPercentile: 25, atmStrike: 24150, strikes };
}

// Bullish OI read.
function bullOi() {
  return {
    ok: true, underlying: "NIFTY50", underLtp: 24160, atmStrike: 24150, pcr: 1.3,
    smartMoney: { bias: "BULLISH", strength: 0.6, reasons: ["put writing dominates"] },
    matrix: { underlying: "LONG_BUILDUP", writerBias: "BULLISH", divergence: null, pcr: 1.3, dPcr15: 0.1 },
    walls: { support: { strike: 24000 }, resistance: { strike: 24300 }, peCentroid: { shift: 5, shiftSteps: 0.1 }, ceCentroid: { shift: 0, shiftSteps: 0 } },
    rows: [],
  };
}

const vix = { ok: true, source: "dhan", vix: { ltp: 13, changePct: -1.5 } };

describe("scoreOption — bullish confluence", () => {
  const r = scoreOption({
    underlying: "NIFTY50",
    candles5m: trendUp(), candles15m: trendUp(), candles1H: trendUp(),
    chain: bullChain(), oi: bullOi(), vix,
    history: [], events: {}, mm: { capital: 400000, rr: 2 }, riskPct: 1,
  });

  it("returns a well-formed result", () => {
    expect(r.ok).toBe(true);
    expect(["TRADE", "WATCH", "NO_TRADE"]).toContain(r.verdict);
    expect(r.factors).toBeTruthy();
    expect(r.regime).toBeTruthy();
  });

  it("picks the CALL side on a bullish stack", () => {
    expect(r.direction).toBe("CE");
  });

  it("scores it a tradeable setup with a strike and plan", () => {
    expect(r.score).toBeGreaterThanOrEqual(55);
    expect(r.strike).toBeTruthy();
    expect(r.strike.strike).toBeGreaterThan(0);
    expect(r.plan).toBeTruthy();
    expect(r.report.length).toBeGreaterThan(3);
  });

  it("computes an expected move", () => {
    expect(r.expectedMove).toBeTruthy();
    expect(r.expectedMove.points).toBeGreaterThan(0);
  });
});

describe("scoreOption — hard gates", () => {
  it("gates 0-DTE (expiry today) to NO_TRADE", () => {
    const chain = { ...bullChain(), isExpiryToday: true };
    const r = scoreOption({ underlying: "NIFTY50", candles5m: trendUp(), candles15m: trendUp(), chain, oi: bullOi(), vix, history: [] });
    expect(r.verdict).toBe("NO_TRADE");
    expect(r.gates.some(g => /0-DTE|Expiry/.test(g))).toBe(true);
  });

  it("gates on missing candles", () => {
    const r = scoreOption({ underlying: "NIFTY50", candles5m: [], candles15m: [], chain: bullChain(), oi: bullOi(), vix, history: [] });
    expect(r.verdict).toBe("NO_TRADE");
    expect(r.gates.some(g => /candle/i.test(g))).toBe(true);
  });

  it("does not force a trade in chop (regime veto or low score)", () => {
    const flatChain = { ...bullChain(), ivPercentile: 20 };
    const flatOi = { ...bullOi(), smartMoney: { bias: "NEUTRAL", strength: 0.05, reasons: [] }, matrix: { underlying: "RANGE", writerBias: "NEUTRAL", divergence: null, pcr: 1, dPcr15: 0 }, pcr: 1 };
    const r = scoreOption({ underlying: "NIFTY50", candles5m: chop(), candles15m: chop(), chain: flatChain, oi: flatOi, vix, history: [] });
    expect(r.verdict).not.toBe("TRADE");
  });
});

describe("scoreOption — coverage renormalization", () => {
  it("still scores with VIX missing (renormalizes) but not below coverage floor", () => {
    const r = scoreOption({ underlying: "NIFTY50", candles5m: trendUp(), candles15m: trendUp(), candles1H: trendUp(), chain: bullChain(), oi: bullOi(), vix: null, history: [] });
    // vix missing removes part of one factor's data but ivPercentile keeps factor 6 present;
    // coverage stays >= 70 so it still produces a score.
    expect(r.coverage).toBeGreaterThanOrEqual(70);
    expect(r.score).toBeGreaterThan(0);
  });
});

describe("weights", () => {
  it("DEFAULT_WEIGHTS sum to 100", () => {
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
});
