import { describe, it, expect } from "vitest";
import { selectStyle, styleWeights, STYLE_WEIGHT_BIAS, STYLES } from "../style.js";

describe("selectStyle", () => {
  it("picks SCALP on expiry day", () => {
    const r = selectStyle({ regime: { regime: "EXPIRY", favorable: false }, vix: { vix: { ltp: 13 } }, dteYears: 1 / 365 });
    expect(r.style).toBe("SCALP");
  });
  it("picks SCALP when VIX is elevated", () => {
    const r = selectStyle({ regime: { regime: "TREND_BULL", favorable: true }, vix: { vix: { ltp: 24 } }, dteYears: 3 / 365 });
    expect(r.style).toBe("SCALP");
  });
  it("picks SWING on a calm multi-day trend", () => {
    const r = selectStyle({ regime: { regime: "TREND_BULL", favorable: true }, vix: { vix: { ltp: 12 } }, dteYears: 20 / 365, atNow: new Date("2026-07-14T05:00:00Z") });
    expect(r.style).toBe("SWING");
  });
  it("defaults to INTRADAY midday on a normal trend", () => {
    const r = selectStyle({ regime: { regime: "TREND_BULL", favorable: true }, vix: { vix: { ltp: 15 } }, dteYears: 2 / 365, atNow: new Date("2026-07-14T06:00:00Z") });
    expect(r.style).toBe("INTRADAY");
  });
  it("always returns reasons", () => {
    const r = selectStyle({ regime: { regime: "MIXED" }, vix: null, dteYears: 1 / 365 });
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(STYLES[r.style]).toBeTruthy();
  });
});

describe("styleWeights", () => {
  it("renormalizes every style profile to sum 100", () => {
    for (const style of Object.keys(STYLE_WEIGHT_BIAS)) {
      const w = styleWeights(style);
      const sum = Object.values(w).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(100, 0);
    }
  });
  it("SCALP over-weights momentum/OI/greeks vs SWING", () => {
    const scalp = styleWeights("SCALP"), swing = styleWeights("SWING");
    expect(scalp.momentum).toBeGreaterThan(swing.momentum);
    expect(scalp.chainOi).toBeGreaterThan(swing.chainOi);
    expect(swing.trend).toBeGreaterThan(scalp.trend);
  });
});
