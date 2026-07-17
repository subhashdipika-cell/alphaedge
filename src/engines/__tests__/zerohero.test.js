import { describe, it, expect } from "vitest";
import { zeroHeroPick, zeroHeroRecords } from "../zerohero.js";

const IN_WINDOW = 14 * 60;         // 14:00 IST
const upDay = Array.from({ length: 40 }, (_, i) => ({ close: 24100 + i * 6 }));
const dnDay = Array.from({ length: 40 }, (_, i) => ({ close: 24300 - i * 6 }));

function chain({ expiryToday = true } = {}) {
  const mk = (strike, ceLtp, peLtp) => ({
    strike,
    ce: { ltp: ceLtp, oi: 50000, delta: 0.1 },
    pe: { ltp: peLtp, oi: 50000, delta: -0.1 },
  });
  return {
    ok: true, underlying: "NIFTY50", under_ltp: 24300, expiry: "2026-07-21",
    isExpiryToday: expiryToday,
    strikes: [
      mk(24300, 60, 55),      // ATM — far above the band
      mk(24400, 18, 130),
      mk(24450, 4.6, 180),    // CE in the ₹3–5 band, nearer to spot
      mk(24500, 3.2, 240),    // CE in the band, further out
      mk(24150, 130, 4.1),    // PE in the band
    ],
  };
}

describe("zeroHeroPick", () => {
  it("FADES an up-trending expiry day (buys the PE) — spikes are reversal-driven", () => {
    const r = zeroHeroPick({ chain: chain(), candles5m: upDay, istMin: IN_WINDOW });
    expect(r.ok).toBe(true);
    expect(r.direction).toBe("PE");
    expect(r.leg.strike).toBe(24150);       // in-band PE (₹4.1)
  });

  it("fades a down-trending day (buys the CE nearest to spot)", () => {
    const r = zeroHeroPick({ chain: chain(), candles5m: dnDay, istMin: IN_WINDOW });
    expect(r.ok).toBe(true);
    expect(r.direction).toBe("CE");
    expect(r.leg.strike).toBe(24450);       // ₹4.6, closer than 24500's ₹3.2
    expect(r.leg.ltp).toBe(4.6);
  });

  it("refuses outside the 14:00–14:45 window and on non-expiry days", () => {
    expect(zeroHeroPick({ chain: chain(), candles5m: upDay, istMin: 12 * 60 }).ok).toBe(false);
    expect(zeroHeroPick({ chain: chain(), candles5m: upDay, istMin: 13 * 60 + 50 }).ok).toBe(false);  // pre-14:00 bucket is EV-negative
    expect(zeroHeroPick({ chain: chain(), candles5m: upDay, istMin: 15 * 60 }).ok).toBe(false);
    expect(zeroHeroPick({ chain: chain({ expiryToday: false }), candles5m: upDay, istMin: IN_WINDOW }).ok).toBe(false);
  });

  it("skips when no strike sits in the premium band with enough OI", () => {
    const c = chain();
    c.strikes.forEach(s => { s.ce.oi = 100; s.pe.oi = 100; });   // below minOi
    const r = zeroHeroPick({ chain: c, candles5m: upDay, istMin: IN_WINDOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no ₹/);
  });
});

describe("zeroHeroRecords", () => {
  const pick = zeroHeroPick({ chain: chain(), candles5m: upDay, istMin: IN_WINDOW });
  const recs = zeroHeroRecords({ underlying: "NIFTY50", pick, lotSize: 65, now: 1752750000000 });

  it("splits 2 lots into a 2×-target leg and a trailing runner", () => {
    expect(recs).toHaveLength(2);
    const [a, b] = recs;
    expect(a.lots).toBe(1); expect(b.lots).toBe(1);
    expect(a.tgtPremium).toBe(8.2);          // 2 × ₹4.1 (fade-side PE) — sell half at double
    expect(a.trailStop).toBe(false);
    expect(b.tgtPremium).toBe(0);            // runner: no fixed target
    expect(b.trailStop).toBe(true);
    expect(b.trailArmPts).toBe(4.1);         // arms once the premium doubles
  });

  it("is a max-loss-limited lottery: SL 0 (the premium IS the risk), square-off on", () => {
    for (const r of recs) {
      expect(r.slPremium).toBe(0);
      expect(r.squareOff).toBe(true);
      expect(r.source).toBe("Zero-Hero");
      expect(r.style).toBe("ZERO_HERO");
    }
  });
});
