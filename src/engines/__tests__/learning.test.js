import { describe, it, expect } from "vitest";
import { outcomeBucket, signalPnlR, buildSignalLearningProfile } from "../learning.js";

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
});
