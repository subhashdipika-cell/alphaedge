import { describe, it, expect } from "vitest";
import { styleMetaLearning, factorAttribution, tuneWeights, regimeAttribution, rescore, MIN_SAMPLE } from "../rnd.js";

// Synthetic resolved trades: SCALP wins more, SWING loses; `trend` factor is
// predictive (high on wins), `news` is noise.
function makeTrades(n = 40) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const win = i % 2 === 0;                 // 50/50 overall
    const style = i % 3 === 0 ? "SCALP" : i % 3 === 1 ? "INTRADAY" : "SWING";
    const styleWin = style === "SCALP" ? i % 4 !== 0 : style === "SWING" ? i % 4 === 0 : win;
    out.push({
      outcome: styleWin ? "win" : "loss",
      rMultiple: styleWin ? 1.5 : -1,
      pnlRs: styleWin ? 1500 : -1000,
      style, regime: styleWin ? "TREND_BULL" : "RANGE",
      score: 70,
      scoreFactors: {
        trend: styleWin ? 0.9 : 0.3,         // predictive
        momentum: 0.5, ict: 0.6, chainOi: 0.5, greeks: 0.6,
        ivVix: 0.4, risk: 0.8,
        news: Math.random(),                  // noise
      },
    });
  }
  return out;
}

const base = { trend: 20, momentum: 15, ict: 20, chainOi: 15, greeks: 10, ivVix: 10, risk: 5, news: 5 };

describe("styleMetaLearning", () => {
  const r = styleMetaLearning(makeTrades(45));
  it("groups by style with win-rate and expectancy", () => {
    expect(r.rows.length).toBe(3);
    expect(r.ready).toBe(true);
    r.rows.forEach(row => { expect(row.n).toBeGreaterThan(0); expect(typeof row.expectancyR).toBe("number"); });
  });
  it("ranks styles by expectancy (best first)", () => {
    for (let i = 1; i < r.rows.length; i++) expect(r.rows[i - 1].expectancyR).toBeGreaterThanOrEqual(r.rows[i].expectancyR);
  });
  it("suppresses recommendations below MIN_SAMPLE", () => {
    expect(styleMetaLearning(makeTrades(5)).ready).toBe(false);
    expect(styleMetaLearning(makeTrades(5)).recs.length).toBe(0);
  });
});

describe("factorAttribution", () => {
  it("ranks the predictive factor above the noise factor", () => {
    const attr = factorAttribution(makeTrades(60));
    const trend = attr.find(a => a.factor === "trend");
    const news = attr.find(a => a.factor === "news");
    expect(Math.abs(trend.corr)).toBeGreaterThan(Math.abs(news.corr));
    expect(trend.corr).toBeGreaterThan(0);   // high trend precedes wins
  });
});

describe("rescore", () => {
  it("recomputes a 0-100 score from stored factors + weights", () => {
    const t = { scoreFactors: { trend: 1, momentum: 1, ict: 1, chainOi: 1, greeks: 1, ivVix: 1, risk: 1, news: 1 } };
    expect(rescore(t, base)).toBeCloseTo(100, 0);
    const half = { scoreFactors: Object.fromEntries(Object.keys(base).map(k => [k, 0.5])) };
    expect(rescore(half, base)).toBeCloseTo(50, 0);
  });
});

describe("tuneWeights", () => {
  it("suppresses below MIN_SAMPLE", () => {
    const r = tuneWeights(makeTrades(10), base);
    expect(r.ready).toBe(false);
    expect(r.n).toBeLessThan(MIN_SAMPLE);
  });
  it("returns candidates that beat the baseline separation on enough data", () => {
    const r = tuneWeights(makeTrades(60), base);
    expect(r.ready).toBe(true);
    expect(typeof r.baseSeparation).toBe("number");
    r.candidates.forEach(c => {
      expect(c.separation).toBeGreaterThan(r.baseSeparation);
      expect(Object.values(c.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
    });
  });
});

describe("regimeAttribution", () => {
  it("returns per-regime expectancy sorted", () => {
    const r = regimeAttribution(makeTrades(40));
    expect(r.length).toBeGreaterThan(0);
    for (let i = 1; i < r.length; i++) expect(r[i - 1].expectancyR).toBeGreaterThanOrEqual(r[i].expectancyR);
  });
});
