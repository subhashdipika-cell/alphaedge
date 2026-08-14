import { describe, expect, it } from "vitest";
import { evaluateTimingShadow, timingFromChronosResponse } from "../aiTiming.js";

describe("Chronos timing shadow", () => {
  const trade = { entryPremium: 100, stopPremium: 85, targetPremium: 130 };

  it("marks a forecast supportive without changing execution authority", () => {
    const r = evaluateTimingShadow({ ...trade, q10: 92, q50: 112, q90: 138 });
    expect(r.status).toBe("SUPPORTIVE");
    expect(r.allow).toBe(true);
    expect(r.shadowOnly).toBe(true);
  });

  it("rejects a forecast that cannot reach the planned target", () => {
    const r = evaluateTimingShadow({ ...trade, q10: 90, q50: 98, q90: 118 });
    expect(r.status).toBe("CAUTION");
    expect(r.allow).toBe(false);
  });

  it("fails closed when the model response is unavailable", () => {
    const r = timingFromChronosResponse({ ok: false, error: "not running" }, trade);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.allow).toBe(false);
    expect(r.shadowOnly).toBe(true);
  });
});
