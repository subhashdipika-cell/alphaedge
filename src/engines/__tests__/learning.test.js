import { describe, it, expect } from "vitest";
import { outcomeBucket, signalPnlR, buildSignalLearningProfile, promotionGate, promotionGatesByStrategy } from "../learning.js";

describe("realized outcome learning", () => {
  it("classifies from realized R rather than planned riskReward", () => {
    expect(outcomeBucket({ outcome: "win", riskReward: 3, rMultiple: 0.4 })).toBe("small_profit");
    expect(outcomeBucket({ outcome: "win", riskReward: 2, rMultiple: 3.2 })).toBe("big_profit");
    expect(outcomeBucket({ outcome: "loss", riskReward: 3, rMultiple: -1.4 })).toBe("big_loss");
  });

  it("uses realized R for expectancy", () => {
    expect(signalPnlR({ outcome: "win", riskReward: 3, rMultiple: 0.4 })).toBe(0.4);
    expect(signalPnlR({ outcome: "loss", riskReward: 3, rMultiple: -1.2 })).toBe(-1.2);
  });

  it("does not invent big profits for legacy records without realized R", () => {
    const profile = buildSignalLearningProfile([{ outcome: "win", riskReward: 3 }]);
    expect(profile.counts.big_profit).toBe(0);
    expect(profile.counts.small_profit).toBe(1);
  });

  it("keeps thin paper evidence paper-only", () => {
    const r = promotionGate(Array.from({ length: 20 }, (_, i) => ({ outcome: i < 15 ? "win" : "loss", rMultiple: i < 15 ? 0.5 : -0.4, tradeType: "Paper" })));
    expect(r.approved).toBe(false);
    expect(r.status).toBe("PAPER_ONLY");
    expect(r.checks.sample).toBe(false);
  });

  it("approves only sufficiently strong paper evidence", () => {
    const records = Array.from({ length: 50 }, (_, i) => ({
      outcome: i % 3 === 0 ? "loss" : "win", rMultiple: i % 3 === 0 ? -0.4 : 0.5,
      tradeType: "Paper", strategyVersion: "test-v1", timestamp: i,
    }));
    const r = promotionGate(records, { strategyKey: "test-v1" });
    expect(r.approved).toBe(true);
    expect(r.status).toBe("PROMOTION_ELIGIBLE");
    expect(r.wilsonWinRatePct).toBeGreaterThanOrEqual(45);
  });

  it("does not count replay records toward paper promotion", () => {
    const records = Array.from({ length: 60 }, (_, i) => ({ outcome: "win", rMultiple: 0.5, source: "replay" }));
    expect(promotionGate(records).trades).toBe(0);
  });

  it("keeps promotion evidence separate for each strategy version", () => {
    const records = [
      { outcome: "win", rMultiple: 1, tradeType: "Paper", strategyVersion: "nifty-option-workflow-v1" },
      { outcome: "loss", rMultiple: -1, tradeType: "Paper", strategyVersion: "sensex-option-workflow-v1" },
    ];
    const rows = promotionGatesByStrategy(records);
    expect(rows.find(r => r.key === "nifty-option-workflow-v1").trades).toBe(1);
    expect(rows.find(r => r.key === "sensex-option-workflow-v1").trades).toBe(1);
    expect(rows.find(r => r.key === "score-v1").trades).toBe(0);
  });
});
