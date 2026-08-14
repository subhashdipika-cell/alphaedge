import { describe, expect, it } from "vitest";
import { selectStrike } from "../strike.js";

describe("Indian option strike quality alignment", () => {
  it("can enforce the premium validator's 0.60 delta ceiling", () => {
    const chain = {
      under_ltp: 25000,
      strikes: [
        { strike: 24900, ce: { ltp: 150, oi: 1000, volume: 500, delta: 0.65 }, pe: {} },
        { strike: 25000, ce: { ltp: 120, oi: 1000, volume: 500, delta: 0.55 }, pe: {} },
      ],
    };
    const pick = selectStrike({ chain, direction: "CE", strikePref: { deltaLo: 0.45, deltaHi: 0.60, ideal: 0.55 }, minPremium: 40 });
    expect(pick.leg.delta).toBe(0.55);
  });
});
