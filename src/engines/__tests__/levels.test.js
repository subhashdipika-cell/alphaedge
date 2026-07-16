import { describe, it, expect } from "vitest";
import { buildLevelMap, nearestBarriers, extensionATR, humanCheck, capTargetToStructure, LEVELS_DEFAULTS } from "../levels.js";

// ── synthetic candles: 15m bars across two IST days around 24,000 ─────────────
// Day 1 (prev day): 09:30–15:30 IST 2026-07-14 → PDH 24120, PDL 23880.
// Day 2 (today):    09:30 onward 2026-07-15, drifting near 24,000.
function bars(startUtcIso, prices, stepMin = 15, range = 12) {
  const t0 = new Date(startUtcIso).getTime();
  return prices.map((p, i) => ({
    ts: t0 + i * stepMin * 60000,
    open: p - 2, close: p, high: p + range / 2, low: p - range / 2, bull: true, vol: 100,
  }));
}
const day1Prices = [];
for (let i = 0; i < 24; i++) day1Prices.push(24000 + Math.sin(i / 3) * 110);   // swings, hi≈24110 lo≈23890
const day2Prices = [];
for (let i = 0; i < 20; i++) day2Prices.push(23990 + Math.sin(i / 2.5) * 40);
const candles15m = [
  ...bars("2026-07-14T04:00:00Z", day1Prices),
  ...bars("2026-07-15T04:00:00Z", day2Prices),
];
const spot = candles15m[candles15m.length - 1].close;

describe("buildLevelMap", () => {
  const map = buildLevelMap({ underlying: "NIFTY50", candles15m, spot });
  it("builds a map with supports below and resistances above spot", () => {
    expect(map.ok).toBe(true);
    expect(map.supports.length).toBeGreaterThan(0);
    expect(map.resistances.length).toBeGreaterThan(0);
    map.supports.forEach(l => expect(l.price).toBeLessThan(spot));
    map.resistances.forEach(l => expect(l.price).toBeGreaterThan(spot));
  });
  it("includes previous-day high/low", () => {
    const kinds = map.levels.flatMap(l => l.kinds);
    expect(kinds).toContain("pdh");
    expect(kinds).toContain("pdl");
    const pdh = map.levels.find(l => l.kinds.includes("pdh"));
    expect(pdh.price).toBeGreaterThan(24100);           // day-1 high ≈ 24110 + range/2
  });
  it("includes round numbers at the index step", () => {
    const rounds = map.levels.filter(l => l.kinds.includes("round"));
    expect(rounds.length).toBeGreaterThan(3);
    rounds.forEach(l => {
      // clustering can average a round into a nearby level — accept ±tolerance
      const nearest100 = Math.round(l.price / 100) * 100;
      expect(Math.abs(l.price - nearest100)).toBeLessThanOrEqual(spot * 0.001 + 1e-6);
    });
  });
  it("merges OI walls in as strong levels", () => {
    const oi = { walls: { resistance: { strike: 24200 }, support: { strike: 23800 } } };
    const m2 = buildLevelMap({ underlying: "NIFTY50", candles15m, spot, oi });
    const wallRes = m2.levels.find(l => l.kinds.includes("ce-wall"));
    const wallSup = m2.levels.find(l => l.kinds.includes("pe-wall"));
    expect(wallRes).toBeTruthy();
    expect(wallSup).toBeTruthy();
    expect(wallRes.strength).toBeGreaterThanOrEqual(1.6);
  });
  it("nearestBarriers picks the closest level on each side", () => {
    const m = { ok: true, spot: 24000, atr: 20,
      resistances: [{ price: 24040, kinds: ["swing-high"], strength: 1 }, { price: 24100, kinds: ["round"], strength: 1 }],
      supports: [{ price: 23900, kinds: ["round"], strength: 1 }, { price: 23960, kinds: ["swing-low"], strength: 1 }] };
    const nb = nearestBarriers(m);
    expect(nb.res.price).toBe(24040);
    expect(nb.sup.price).toBe(23960);
    expect(nb.distUp).toBe(40);
    expect(nb.distDn).toBe(40);
  });
});

describe("extensionATR (freshness)", () => {
  it("flags an extended vertical move", () => {
    // Flat then a vertical +8-point-per-bar ramp → close far above EMA20.
    const prices = [...Array(30).fill(24000), ...Array(10)].map((p, i) => p ?? 24000 + (i - 29) * 25);
    const c = bars("2026-07-15T04:00:00Z", prices, 5, 8);
    const e = extensionATR(c);
    expect(e).toBeTruthy();
    expect(e.ext).toBeGreaterThan(1.5);
  });
  it("stays small in a flat market", () => {
    const c = bars("2026-07-15T04:00:00Z", Array(40).fill(24000).map((p, i) => p + Math.sin(i) * 5), 5, 8);
    const e = extensionATR(c);
    expect(Math.abs(e.ext)).toBeLessThan(1);
  });
});

describe("humanCheck", () => {
  const map = { ok: true, spot: 24000, atr: 20,
    resistances: [{ price: 24005, kinds: ["ce-wall"], strength: 1.6 }],
    supports: [{ price: 23900, kinds: ["pdl"], strength: 1.3 }] };

  it("blocks longing into resistance (location)", () => {
    const r = humanCheck({ direction: "CE", map, stopUnderPts: 30, cfg: LEVELS_DEFAULTS });
    expect(r.violations.some(v => v.code === "location")).toBe(true);
  });
  it("blocks when there's no room to structure (rr-structure)", () => {
    const r = humanCheck({ direction: "CE", map, stopUnderPts: 30, cfg: LEVELS_DEFAULTS });
    // headroom = 5 − buffer(0.25×20=5) = 0 → 0R < 1.2R
    expect(r.rrStructure).toBeLessThan(LEVELS_DEFAULTS.minRRStructure);
    expect(r.violations.some(v => v.code === "rr-structure")).toBe(true);
  });
  it("passes a PE (short) with plenty of room to support", () => {
    const r = humanCheck({ direction: "PE", map, stopUnderPts: 30, cfg: LEVELS_DEFAULTS });
    // room down = 100 − 5 buffer = 95 → 95/30 ≈ 3.2R, support 100 pts away (not 'at' it)
    expect(r.violations.length).toBe(0);
    expect(r.rrStructure).toBeGreaterThan(3);
  });
  it("flags chasing when extended beyond extMaxATR in the trade direction", () => {
    const r = humanCheck({ direction: "CE", map: { ...map, resistances: [{ price: 24500, kinds: ["round"], strength: 1 }] },
      stopUnderPts: 30, ext: { ext: 2.1 }, cfg: LEVELS_DEFAULTS });
    expect(r.violations.some(v => v.code === "chasing")).toBe(true);
    // Same extension is NOT chasing for a PE (price stretched up = good short context).
    const r2 = humanCheck({ direction: "PE", map, stopUnderPts: 30, ext: { ext: 2.1 }, cfg: LEVELS_DEFAULTS });
    expect(r2.violations.some(v => v.code === "chasing")).toBe(false);
  });
});

describe("capTargetToStructure", () => {
  it("caps the premium target to the room available", () => {
    // 60 pts of underlying room × 0.5 delta = 30 premium pts max (below the 60-pt plan target).
    const cap = capTargetToStructure({ entry: 200, slPts: 60, tgtPts: 120, delta: -0.5, headroom: 60 });
    expect(cap).toBeTruthy();
    expect(cap.tgtPts).toBe(30);
    expect(cap.tgtPrice).toBe(230);
    expect(cap.rr).toBe(0.5);
  });
  it("returns null when the plan target already fits", () => {
    expect(capTargetToStructure({ entry: 200, slPts: 60, tgtPts: 120, delta: 0.5, headroom: 400 })).toBeNull();
  });
});
