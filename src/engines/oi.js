// ─── TRENDING-OI ENGINE ───────────────────────────────────────────────────────
// Treats open interest as a TIME SERIES, not a snapshot. Consumes the bridge's
// /dhan/oitrend payload (raw per-strike OI/LTP/IV/volume buckets) and derives:
//   ΔOI (since open + vs prev-day close), velocity, acceleration,
//   writing / unwinding strength (ATM-weighted), OI-weighted centroids + migration,
//   the price↔OI confirmation matrix, OI-vs-price divergence, OI walls (support/
//   resistance) with strength, OI spurts, active strikes by volume, Max Pain,
//   OI-flip detection, a Black-Scholes gamma wall, and a smart-money composite.
//
// This is the single source of truth for OI analytics — the OI Pulse page, the
// Option Buying Score engine, and the R&D replay script all call analyzeOiTrend.
// Pure: input payload → output object. No fetching, no DOM.

const RISK_FREE = 0.065;   // ~RBI repo, for Black-Scholes gamma

// Standard normal PDF.
function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

// Black-Scholes gamma for one option. S spot, K strike, iv fraction (0.15=15%),
// tYears time to expiry in years. Same for CE and PE. Returns 0 on bad inputs.
function bsGamma(S, K, iv, tYears) {
  if (!(S > 0) || !(K > 0) || !(iv > 0) || !(tYears > 0)) return 0;
  const sqrtT = Math.sqrt(tYears);
  const d1 = (Math.log(S / K) + (RISK_FREE + 0.5 * iv * iv) * tYears) / (iv * sqrtT);
  return normPdf(d1) / (S * iv * sqrtT);
}

// Last defined value of an array (arrays are carry-forward filled server-side).
const last = (a) => (a && a.length ? a[a.length - 1] : 0);

// Years to expiry from an ISO date string (expiry is EOD IST). Floors at ~2h so
// same-day 0-DTE still yields a positive, finite gamma.
function yearsToExpiry(expiry) {
  if (!expiry) return 1 / 365;
  const end = new Date(`${expiry}T15:30:00+05:30`).getTime();
  const days = Math.max(2 / 24, (end - Date.now()) / 86400000);
  return days / 365;
}

// ── main ──────────────────────────────────────────────────────────────────────
// windows: OI-velocity lookbacks in MINUTES. `ictState` (optional) = the output
// of the ICT engine on the underlying, used for the confluence read.
export function analyzeOiTrend(payload, { windows = [5, 15, 30], ictState = null } = {}) {
  if (!payload || !payload.ok || !Array.isArray(payload.strikes) || !payload.strikes.length) {
    return { ok: false, error: payload?.error || "no OI-trend data" };
  }
  const bucketMin = payload.bucketMin || 5;
  const times = payload.times || [];
  const under = payload.underLtp || [];
  const nowUnder = last(under);
  const openUnder = under[0] || nowUnder;
  const atm = payload.atmStrike;
  const strikes = payload.strikes;
  const stepBuckets = (mins) => Math.max(1, Math.round(mins / bucketMin));
  const tYears = yearsToExpiry(payload.expiry);
  // Median strike gap (for the ATM-proximity weighting and strike-step maths).
  const sks = strikes.map(s => s.strike).sort((a, b) => a - b);
  const gaps = sks.slice(1).map((s, i) => s - sks[i]).filter(g => g > 0);
  const strikeGap = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 1;

  // ── per-strike derivations ──
  const rows = strikes.map(s => {
    const derLeg = (leg) => {
      const oi = leg.oi || [];
      const oiNow = last(oi);
      const oiOpen = oi[0] || oiNow;
      const dOiOpen = oiNow - oiOpen;                 // build since open
      const dOiPrev = oiNow - (leg.prevOi || oiOpen); // vs prior-day close
      const vel = {};
      for (const w of windows) {
        const b = stepBuckets(w);
        const past = oi[Math.max(0, oi.length - 1 - b)] ?? oiNow;
        vel[w] = +((oiNow - past) / w).toFixed(1);     // contracts / min
      }
      // acceleration = Δ of the shortest-window velocity over that same window
      const b = stepBuckets(windows[0]);
      const oiA = oi[Math.max(0, oi.length - 1 - b)] ?? oiNow;
      const oiB = oi[Math.max(0, oi.length - 1 - 2 * b)] ?? oiA;
      const vNow = (oiNow - oiA), vPrev = (oiA - oiB);
      const accel = +((vNow - vPrev) / windows[0]).toFixed(1);
      return { oi: oiNow, oiOpen, dOiOpen, dOiPrev, vel, accel,
               ltp: last(leg.ltp), ltpSeries: leg.ltp || [], iv: last(leg.iv),
               vol: last(leg.vol), volSeries: leg.vol || [], delta: leg.delta };
    };
    return { strike: s.strike, atm: s.atm, ce: derLeg(s.ce), pe: derLeg(s.pe) };
  });

  const prox = (strike) => Math.exp(-Math.abs(strike - atm) / (2 * strikeGap));

  // ── writing / unwinding strength (ATM-weighted, normalised by side mean) ──
  const flowRaw = { callWriting: 0, putWriting: 0, callUnwind: 0, putUnwind: 0 };
  rows.forEach(r => {
    const w = prox(r.strike);
    flowRaw.callWriting += Math.max(r.ce.dOiOpen, 0) * w;
    flowRaw.putWriting  += Math.max(r.pe.dOiOpen, 0) * w;
    flowRaw.callUnwind  += Math.max(-r.ce.dOiOpen, 0) * w;
    flowRaw.putUnwind   += Math.max(-r.pe.dOiOpen, 0) * w;
  });
  const flowScale = Math.max(1, (flowRaw.callWriting + flowRaw.putWriting + flowRaw.callUnwind + flowRaw.putUnwind));
  const flows = {
    callWriting: +(flowRaw.callWriting / flowScale).toFixed(3),
    putWriting:  +(flowRaw.putWriting / flowScale).toFixed(3),
    callUnwind:  +(flowRaw.callUnwind / flowScale).toFixed(3),
    putUnwind:   +(flowRaw.putUnwind / flowScale).toFixed(3),
  };

  // ── OI-weighted centroids per side + migration since open ──
  const centroid = (pick) => {
    let num = 0, den = 0, numO = 0, denO = 0;
    rows.forEach(r => {
      const leg = pick(r);
      num += r.strike * leg.oi;   den += leg.oi;
      numO += r.strike * leg.oiOpen; denO += leg.oiOpen;
    });
    const now = den ? num / den : atm, open = denO ? numO / denO : atm;
    return { now: +now.toFixed(1), open: +open.toFixed(1), shift: +(now - open).toFixed(1),
             shiftSteps: +((now - open) / strikeGap).toFixed(2) };
  };
  const ceCentroid = centroid(r => r.ce);
  const peCentroid = centroid(r => r.pe);

  // ── OI walls: max-OI strikes, strength = wall / mean(side) ──
  const meanCe = rows.reduce((a, r) => a + r.ce.oi, 0) / rows.length || 1;
  const meanPe = rows.reduce((a, r) => a + r.pe.oi, 0) / rows.length || 1;
  const resRow = rows.reduce((m, r) => (r.ce.oi > m.ce.oi ? r : m), rows[0]);  // CE wall = resistance
  const supRow = rows.reduce((m, r) => (r.pe.oi > m.pe.oi ? r : m), rows[0]);  // PE wall = support
  const walls = {
    resistance: { strike: resRow.strike, oi: resRow.ce.oi, strength: +(resRow.ce.oi / meanCe).toFixed(2), vel15: resRow.ce.vel[15] ?? 0 },
    support:    { strike: supRow.strike, oi: supRow.pe.oi, strength: +(supRow.pe.oi / meanPe).toFixed(2), vel15: supRow.pe.vel[15] ?? 0 },
    ceCentroid, peCentroid,
  };

  // ── total OI series → PCR series + confirmation matrix + divergence ──
  const nBuckets = times.length;
  const ceTot = [], peTot = [], pcr = [];
  for (let i = 0; i < nBuckets; i++) {
    let ce = 0, pe = 0;
    strikes.forEach(s => { ce += (s.ce.oi[i] || 0); pe += (s.pe.oi[i] || 0); });
    ceTot.push(ce); peTot.push(pe); pcr.push(ce ? +(pe / ce).toFixed(3) : 0);
  }
  const b15 = stepBuckets(15);
  const dUnder15 = nowUnder - (under[Math.max(0, under.length - 1 - b15)] ?? nowUnder);
  const dCe15 = last(ceTot) - (ceTot[Math.max(0, ceTot.length - 1 - b15)] ?? last(ceTot));
  const dPe15 = last(peTot) - (peTot[Math.max(0, peTot.length - 1 - b15)] ?? last(peTot));
  // Classic price↔OI reads on the dominant side over the trailing 15m.
  const upMove = dUnder15 > 0;
  const dominant = Math.abs(dCe15) >= Math.abs(dPe15) ? "CE" : "PE";
  const domOiUp = (dominant === "CE" ? dCe15 : dPe15) > 0;
  let buildup;
  if (upMove && domOiUp)       buildup = dominant === "PE" ? "LONG_BUILDUP" : "CALL_WRITING";
  else if (!upMove && domOiUp)  buildup = dominant === "CE" ? "SHORT_BUILDUP" : "PUT_WRITING";
  else if (upMove && !domOiUp)  buildup = "SHORT_COVERING";
  else                          buildup = "LONG_UNWINDING";
  // Writer bias: which side is being written more near ATM (writers fade that side).
  const writerBias = flows.putWriting > flows.callWriting * 1.15 ? "BULLISH"
                    : flows.callWriting > flows.putWriting * 1.15 ? "BEARISH" : "NEUTRAL";
  // Divergence: price up but PCR falling (call writers dominating) → bearish, and vice-versa.
  const dPcr15 = last(pcr) - (pcr[Math.max(0, pcr.length - 1 - b15)] ?? last(pcr));
  let divergence = null;
  if (upMove && dPcr15 < -0.05 && flows.callWriting > flows.putWriting) divergence = "BEARISH";
  else if (!upMove && dPcr15 > 0.05 && flows.putWriting > flows.callWriting) divergence = "BULLISH";
  const matrix = { underlying: buildup, writerBias, divergence, pcr: last(pcr), dPcr15: +dPcr15.toFixed(3) };

  // ── OI spurts: biggest ΔOI% movers since open (both sides) ──
  const spurtList = [];
  rows.forEach(r => {
    [["CE", r.ce], ["PE", r.pe]].forEach(([t, leg]) => {
      if (leg.oiOpen > 0) spurtList.push({ strike: r.strike, type: t, pct: +((leg.dOiOpen / leg.oiOpen) * 100).toFixed(1), dOi: leg.dOiOpen, oi: leg.oi });
    });
  });
  const spurts = spurtList.filter(s => s.oi > meanCe * 0.15).sort((a, b) => b.pct - a.pct).slice(0, 5);

  // ── active strikes by traded volume ──
  const activeStrikes = rows.map(r => ({ strike: r.strike, ceVol: r.ce.vol, peVol: r.pe.vol, vol: r.ce.vol + r.pe.vol }))
    .sort((a, b) => b.vol - a.vol).slice(0, 5);

  // ── Max Pain: strike minimising total writer payout (∑ ITM intrinsic × OI) ──
  let maxPain = atm, minPayout = Infinity;
  strikes.forEach(exp => {
    const K = exp.strike;
    let payout = 0;
    rows.forEach(r => {
      if (r.strike < K) payout += (K - r.strike) * r.ce.oi;   // CE ITM below K
      if (r.strike > K) payout += (r.strike - K) * r.pe.oi;   // PE ITM above K
    });
    if (payout < minPayout) { minPayout = payout; maxPain = K; }
  });

  // ── OI flip: strikes whose ΔOI since open flipped sign vs the prior day ──
  const flips = [];
  rows.forEach(r => {
    ["ce", "pe"].forEach(k => {
      const leg = r[k];
      if (Math.sign(leg.dOiOpen) !== 0 && Math.sign(leg.dOiPrev) !== 0 &&
          Math.sign(leg.dOiOpen) !== Math.sign(leg.dOiPrev) && Math.abs(leg.dOiOpen) > meanCe * 0.2) {
        flips.push({ strike: r.strike, type: k.toUpperCase(), from: leg.dOiPrev, to: leg.dOiOpen });
      }
    });
  });

  // ── gamma wall: strike with max total (CE+PE) dealer gamma exposure ──
  let gammaWall = atm, maxGammaOi = -1;
  rows.forEach(r => {
    const gCe = bsGamma(nowUnder, r.strike, (r.ce.iv || 0) / 100, tYears) * r.ce.oi;
    const gPe = bsGamma(nowUnder, r.strike, (r.pe.iv || 0) / 100, tYears) * r.pe.oi;
    const tot = gCe + gPe;
    if (tot > maxGammaOi) { maxGammaOi = tot; gammaWall = r.strike; }
  });

  // ── smart-money composite: weighted vote → bias + strength + reasons ──
  let vote = 0; const reasons = [];
  const wb = writerBias === "BULLISH" ? 1 : writerBias === "BEARISH" ? -1 : 0;
  vote += 0.40 * wb;
  if (wb) reasons.push(`${writerBias === "BULLISH" ? "Put" : "Call"} writing dominates near ATM (writers fade that side)`);
  const centSig = Math.sign(peCentroid.shift) * Math.min(1, Math.abs(peCentroid.shiftSteps)) * 0.5
                + -Math.sign(ceCentroid.shift) * Math.min(1, Math.abs(ceCentroid.shiftSteps)) * 0.5;
  vote += 0.25 * centSig;
  if (Math.abs(peCentroid.shiftSteps) >= 0.3) reasons.push(`Support ladder ${peCentroid.shift > 0 ? "climbing" : "sliding"} (PE centroid ${peCentroid.shift > 0 ? "+" : ""}${peCentroid.shiftSteps} strikes)`);
  const wallSig = Math.sign(walls.support.vel15) * 0.5 - Math.sign(walls.resistance.vel15) * 0.5;
  vote += 0.20 * Math.max(-1, Math.min(1, wallSig));
  const divSig = divergence === "BULLISH" ? 1 : divergence === "BEARISH" ? -1 : 0;
  vote += 0.15 * divSig;
  if (divSig) reasons.push(`OI divergence vs price: ${divergence.toLowerCase()}`);
  const bias = vote > 0.12 ? "BULLISH" : vote < -0.12 ? "BEARISH" : "NEUTRAL";
  const strength = +Math.min(1, Math.abs(vote)).toFixed(2);
  if (!reasons.length) reasons.push("No dominant OI bias — mixed positioning");
  const smartMoney = { bias, strength, vote: +vote.toFixed(3), reasons };

  // ── optional ICT confluence ──
  const confluence = ictState ? oiIctConfluence(smartMoney, walls, nowUnder, ictState) : null;

  return {
    ok: true,
    underlying: payload.underlying, expiry: payload.expiry, asOf: payload.asOf,
    source: payload.source, marketOpen: payload.marketOpen,
    atmStrike: atm, underLtp: nowUnder, dayChange: +(nowUnder - openUnder).toFixed(2),
    rows, flows, walls, matrix, spurts, activeStrikes, maxPain, flips, gammaWall,
    pcr: last(pcr), smartMoney, confluence,
    series: { times, underLtp: under, pcr, ceOiTotal: ceTot, peOiTotal: peTot },
  };
}

// Combine the OI read with the ICT structure read into a confluence verdict.
// ictState: { bias:"BULLISH"|"BEARISH", atOrderBlock?:bool, ... } (loose shape).
export function oiIctConfluence(smartMoney, walls, spot, ictState) {
  const ictBias = ictState.bias || "NEUTRAL";
  const agree = smartMoney.bias !== "NEUTRAL" && smartMoney.bias === ictBias;
  const aboveSupport = spot > walls.support.strike;
  const belowResistance = spot < walls.resistance.strike;
  const notes = [];
  if (agree) notes.push(`OI (${smartMoney.bias}) and structure (${ictBias}) agree`);
  else notes.push(`OI ${smartMoney.bias} vs structure ${ictBias} — mixed`);
  if (aboveSupport && belowResistance) notes.push(`Spot inside the OI channel ${walls.support.strike}–${walls.resistance.strike}`);
  const level = agree && smartMoney.strength > 0.4 ? "HIGH" : agree ? "MEDIUM" : "LOW";
  return { level, agree, bias: agree ? smartMoney.bias : "NEUTRAL", notes };
}
