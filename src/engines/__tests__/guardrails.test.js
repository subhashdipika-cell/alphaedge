import { describe, it, expect, beforeEach, vi } from "vitest";
import { evaluateGuardrails, isIndianInstrument, marketSession, GUARDRAIL_DEFAULTS } from "../guardrails.js";

// evaluateGuardrails reads localStorage (guardrail config) and the bridge module's
// holiday cache. jsdom isn't loaded, so stub a minimal localStorage + keep the
// holiday cache empty (fetchNseHolidayInfo is never called here).
beforeEach(() => {
  const store = {};
  vi.stubGlobal("localStorage", {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
});

const sig = (o) => ({ timestamp: Date.now(), outcome: "pending", ...o });

describe("isIndianInstrument", () => {
  it("matches the index universe and rejects junk", () => {
    for (const s of ["NIFTY50", "BANKNIFTY", "SENSEX", "FINNIFTY"]) expect(isIndianInstrument(s)).toBe(true);
    expect(isIndianInstrument("BTCUSD")).toBe(false);
    expect(isIndianInstrument("")).toBe(false);
  });
});

describe("marketSession", () => {
  it("tags the volatile open as avoid and the afternoon as prime", () => {
    // 09:30 IST → 04:00 UTC ; 14:30 IST → 09:00 UTC (use fixed UTC instants)
    const open = new Date("2026-07-14T04:00:00Z");      // Tuesday, 09:30 IST
    const noonish = new Date("2026-07-14T09:00:00Z");   // 14:30 IST
    expect(marketSession("NIFTY50", open.getTime()).quality).toBe("avoid");
    expect(marketSession("NIFTY50", noonish.getTime()).prime).toBe(true);
  });
});

describe("evaluateGuardrails", () => {
  it("passes clean history (guardrails enabled by default)", () => {
    const ev = evaluateGuardrails([], null, "NIFTY50");
    expect(ev.state.disabled).toBeUndefined();
    // May or may not be blocked depending on wall-clock (NSE open lockout), but
    // with no asset-specific candidate + empty history the counters are zero.
    expect(ev.state.tradesToday).toBe(0);
    expect(ev.state.consec).toBe(0);
  });

  it("blocks after the daily trade cap is hit", () => {
    const today = Date.now();
    const hist = Array.from({ length: GUARDRAIL_DEFAULTS.maxTradesPerDay }, () => sig({ timestamp: today }));
    const ev = evaluateGuardrails(hist, null, "NIFTY50");
    expect(ev.blocked).toBe(true);
    expect(ev.violations.some(v => /Daily trade cap/.test(v))).toBe(true);
  });

  it("blocks on a consecutive-loss streak", () => {
    const hist = [
      sig({ outcome: "loss", timestamp: Date.now() - 1000 }),
      sig({ outcome: "loss", timestamp: Date.now() - 2000 }),
    ];
    const ev = evaluateGuardrails(hist, null, "NIFTY50");
    expect(ev.violations.some(v => /consecutive losses/.test(v))).toBe(true);
  });

  it("blocks a below-floor option premium", () => {
    const ev = evaluateGuardrails([], { optionPremium: 5, asset: "NIFTY50" }, "NIFTY50");
    expect(ev.violations.some(v => /below floor/.test(v))).toBe(true);
  });

  it("blocks a 0-DTE option (expiry today)", () => {
    const now = Date.now();
    const ev = evaluateGuardrails([], { timestamp: now, expiry: new Date(now).toISOString(), asset: "NIFTY50" }, "NIFTY50");
    expect(ev.violations.some(v => /0-DTE/.test(v))).toBe(true);
  });

  it("returns unblocked with disabled state when guardrails are off", () => {
    localStorage.setItem("alphaedge_guardrails", JSON.stringify({ enabled: false }));
    const hist = Array.from({ length: 10 }, () => sig({ outcome: "loss" }));
    const ev = evaluateGuardrails(hist, null, "NIFTY50");
    expect(ev.blocked).toBe(false);
    expect(ev.state.disabled).toBe(true);
  });
});
