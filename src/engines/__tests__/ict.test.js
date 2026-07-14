import { describe, it, expect } from "vitest";
import {
  detectSwings, detectFVGs, detectOrderBlocks, detectBOS,
  detectLiquidity, detectMSLabels, detectPD, calcEMAs, calcRSI, calcVWAP,
} from "../ict.js";

// Build a candle in the app's shape from OHLC.
const c = (o, h, l, cl) => ({ open: o, high: h, low: l, close: cl, bull: cl >= o, vol: 100, ts: 0 });

describe("detectSwings", () => {
  it("finds a pivot high and pivot low with lookback 1", () => {
    // index:      0        1(hi)    2        3(lo)     4
    const candles = [c(10,11,9,10), c(12,15,11,14), c(11,12,8,9), c(7,8,5,6), c(9,11,8,10)];
    const { highs, lows } = detectSwings(candles, 1);
    expect(highs.map(h => h.i)).toContain(1);
    expect(lows.map(l => l.i)).toContain(3);
  });

  it("returns empty when the series is shorter than 2*lb+1", () => {
    const candles = [c(10,11,9,10), c(11,12,10,11)];
    const { highs, lows } = detectSwings(candles, 3);
    expect(highs).toEqual([]);
    expect(lows).toEqual([]);
  });
});

describe("detectFVGs", () => {
  it("detects an unfilled bullish gap (C[i+1].low > C[i-1].high)", () => {
    // C0 high=10, C2 low=12 → bullish gap that is never revisited
    const candles = [c(9,10,8,9), c(11,13,10,12), c(13,15,12,14), c(14,16,13,15)];
    const fvgs = detectFVGs(candles);
    const bull = fvgs.find(f => f.type === "bull");
    expect(bull).toBeTruthy();
    expect(bull.top).toBe(12);   // C[i+1].low
    expect(bull.bot).toBe(10);   // C[i-1].high
    expect(bull.filled).toBe(false);
  });

  it("marks a bullish gap filled when price trades back into it", () => {
    // gap at i=1 (top 12, bot 10), then C3 low dips to 11 (<=12) → filled
    const candles = [c(9,10,8,9), c(11,13,10,12), c(13,15,12,14), c(12,13,11,12)];
    const fvgs = detectFVGs(candles);
    const bull = fvgs.find(f => f.type === "bull");
    expect(bull.filled).toBe(true);
  });
});

describe("detectBOS", () => {
  it("labels a higher swing high BOS and a lower one CHoCH", () => {
    const swings = { highs: [{ i: 1, price: 100 }, { i: 5, price: 110 }, { i: 9, price: 105 }], lows: [] };
    const bos = detectBOS([], swings);
    expect(bos[0]).toMatchObject({ type: "bull", label: "BOS" });   // 110 > 100
    expect(bos[1]).toMatchObject({ type: "lh", label: "CHoCH" });   // 105 < 110
  });
});

describe("detectMSLabels", () => {
  it("tags HH/LH on highs and HL/LL on lows", () => {
    const swings = {
      highs: [{ i: 1, price: 100 }, { i: 5, price: 110 }],
      lows:  [{ i: 3, price: 90 },  { i: 7, price: 85 }],
    };
    const labels = detectMSLabels(swings);
    expect(labels.find(l => l.i === 5).label).toBe("HH");
    expect(labels.find(l => l.i === 7).label).toBe("LL");
  });
});

describe("detectPD", () => {
  it("returns the dealing-range high/low/mid from the latest swings", () => {
    const swings = { highs: [{ i: 1, price: 100 }, { i: 5, price: 120 }], lows: [{ i: 3, price: 80 }, { i: 7, price: 90 }] };
    expect(detectPD(swings)).toEqual({ high: 120, low: 90, mid: 105 });
  });
  it("returns null when a side has no swings", () => {
    expect(detectPD({ highs: [], lows: [{ i: 1, price: 5 }] })).toBeNull();
  });
});

describe("detectLiquidity", () => {
  it("pairs near-equal highs into an EQH level", () => {
    const swings = { highs: [{ i: 1, price: 100 }, { i: 5, price: 100.1 }], lows: [] };
    const lvls = detectLiquidity(swings);
    expect(lvls.some(l => l.type === "eqh")).toBe(true);
  });
});

describe("detectOrderBlocks", () => {
  it("finds a bullish order block: last down candle before an up impulse off a swing low", () => {
    // swing low at index 2; the down candle at index 2 precedes a rally to a swing high
    const candles = [
      c(100,101,99,100),
      c(100,101,98,99),
      c(99,99,95,96),     // bearish candle at the swing low (the OB)
      c(96,101,96,100),
      c(100,106,100,105),
    ];
    const swings = { highs: [{ i: 4, price: 106 }], lows: [{ i: 2, price: 95 }] };
    const obs = detectOrderBlocks(candles, swings);
    expect(obs.some(o => o.type === "bull")).toBe(true);
  });
});

describe("calcEMAs", () => {
  it("returns three series the length of the input", () => {
    const candles = Array.from({ length: 250 }, (_, i) => c(i, i + 1, i - 1, i));
    const { e20, e50, e200 } = calcEMAs(candles);
    expect(e20).toHaveLength(250);
    expect(e50).toHaveLength(250);
    expect(e200).toHaveLength(250);
    // On a rising series the fast EMA leads the slow one.
    expect(e20[249]).toBeGreaterThan(e200[249]);
  });
});

describe("calcRSI", () => {
  it("is ~100 on a monotonically rising series and ~0 on a falling one", () => {
    const up = Array.from({ length: 40 }, (_, i) => c(i, i + 1, i - 1, i));
    const down = Array.from({ length: 40 }, (_, i) => c(40 - i, 41 - i, 39 - i, 40 - i));
    const rUp = calcRSI(up);
    const rDown = calcRSI(down);
    expect(rUp[rUp.length - 1]).toBeGreaterThan(95);
    expect(rDown[rDown.length - 1]).toBeLessThan(5);
  });
});

describe("calcVWAP", () => {
  it("sits within the price range and slopes up on a rising series", () => {
    const up = Array.from({ length: 80 }, (_, i) => ({ ...c(100 + i, 101 + i, 99 + i, 100 + i), vol: 1000 }));
    const { vwap, slope } = calcVWAP(up);
    expect(vwap).toBeGreaterThan(100);
    expect(vwap).toBeLessThan(up.at(-1).close);   // lags the rising price
    expect(slope).toBeGreaterThan(0);
  });
  it("falls back gracefully with no volume", () => {
    const flat = Array.from({ length: 10 }, () => c(100, 101, 99, 100));
    const { vwap } = calcVWAP(flat);
    expect(vwap).toBeCloseTo(100, 0);
  });
});
