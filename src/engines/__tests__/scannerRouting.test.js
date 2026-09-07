import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { selectStyle } from "../style.js";

describe("scanner routing safeguards", () => {
  const scanner = fs.readFileSync(new URL("../../../scripts/scanner.mjs", import.meta.url), "utf8");
  it("uses chart-first routing and retains the adaptive veto before execution", () => {
    expect(scanner).toContain('niftyOptionWorkflow: underlying === "NIFTY50"');
    expect(scanner).not.toContain('dhanOptionScalp: underlying === "NIFTY50"');
    const start = scanner.indexOf("async function scanOne");
    const body = scanner.slice(start, scanner.indexOf("store.trades.push(record)", start));
    expect(body.indexOf("if (!adaptive.allowed)")).toBeGreaterThan(body.indexOf("const r = scoreOption"));
    expect(body).toContain('"score-v1"'); // no fresh ID to evade the existing loss pause
  });
  it("retains completed scan decisions after idle health updates", () => {
    expect(scanner).toContain("scan-decisions-${istDateStr()}.jsonl");
    expect(scanner).toContain("executionRevision");
  });
  it("interprets style timestamps in IST, independent of the host timezone", () => {
    const inputs = { regime: { regime: "TREND_BULL", favorable: true }, ivp: 30, dteYears: 2 / 365 };
    expect(selectStyle({ ...inputs, atNow: "2026-09-07T09:05:00Z" }).style).toBe("SCALP");
    expect(selectStyle({ ...inputs, atNow: "2026-09-07T06:00:00Z" }).style).toBe("INTRADAY");
  });
});
