import { describe, it, expect, beforeEach, vi } from "vitest";
import { evaluateGuardrails, getGuardrails, isIndianInstrument, marketSession, GUARDRAIL_DEFAULTS } from "../guardrails.js";

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

  it("has the emotion-derived guardrails OFF by default (mechanical paper policy)", () => {
    // Policy defaults (2026-07-15): cooldown, daily cap, consec-loss stop and
    // the open lockout are all disabled for the mechanical paper test.
    expect(GUARDRAIL_DEFAULTS.cooldownMin).toBe(20);
    expect(GUARDRAIL_DEFAULTS.maxTradesPerDay).toBe(3);
    expect(GUARDRAIL_DEFAULTS.maxConsecLosses).toBe(2);
    expect(GUARDRAIL_DEFAULTS.openLockout).toBe(true);
    // Many trades + a long loss streak must NOT trip any of them by default.
    const now = Date.now();
    const hist = Array.from({ length: 12 }, (_, i) => sig({ outcome: "loss", timestamp: now - i * 1000 }));
    const ev = evaluateGuardrails(hist, null, "NIFTY50");
    expect(ev.violations.some(v => /Daily trade cap/.test(v))).toBe(true);
    expect(ev.violations.some(v => /consecutive losses/.test(v))).toBe(true);
    expect(ev.violations.some(v => /Cooldown active/.test(v))).toBe(true);
  });

  it("still blocks on the daily trade cap when re-enabled in Settings", () => {
    // A real Settings save carries the current policyVersion (state comes from
    // getGuardrails), so the migration doesn't strip it back to the default.
    localStorage.setItem("alphaedge_guardrails", JSON.stringify({ maxTradesPerDay: 5, policyVersion: GUARDRAIL_DEFAULTS.policyVersion }));
    const today = Date.now();
    const hist = Array.from({ length: 5 }, () => sig({ timestamp: today }));
    const ev = evaluateGuardrails(hist, null, "NIFTY50");
    expect(ev.blocked).toBe(true);
    expect(ev.violations.some(v => /Daily trade cap/.test(v))).toBe(true);
  });

  it("still blocks on a consecutive-loss streak when re-enabled in Settings", () => {
    localStorage.setItem("alphaedge_guardrails", JSON.stringify({ maxConsecLosses: 2, policyVersion: GUARDRAIL_DEFAULTS.policyVersion }));
    const hist = [
      sig({ outcome: "loss", timestamp: Date.now() - 1000 }),
      sig({ outcome: "loss", timestamp: Date.now() - 2000 }),
    ];
    const ev = evaluateGuardrails(hist, null, "NIFTY50");
    expect(ev.violations.some(v => /consecutive losses/.test(v))).toBe(true);
  });

  it("migrates a pre-policy saved config so the emotion guardrails turn OFF", () => {
    // Simulate an old browser config (before 2026-07-15) with the emotion
    // guardrails ON — the very thing that kept blocking despite the code default.
    localStorage.setItem("alphaedge_guardrails", JSON.stringify({
      enabled: true, openLockout: true, cooldownMin: 15, maxTradesPerDay: 5, maxConsecLosses: 2,
    }));
    const g = getGuardrails();
    expect(g.openLockout).toBe(true);
    expect(g.cooldownMin).toBe(20);
    expect(g.maxTradesPerDay).toBe(3);
    expect(g.maxConsecLosses).toBe(2);
    expect(g.policyVersion).toBe(GUARDRAIL_DEFAULTS.policyVersion);
    // Structural rules the migration must NOT touch.
    expect(g.blockExpiryDay).toBe(true);
    // And it re-persists so it only migrates once.
    expect(JSON.parse(localStorage.getItem("alphaedge_guardrails")).policyVersion).toBe(GUARDRAIL_DEFAULTS.policyVersion);
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
