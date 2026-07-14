// ─── OPTION BUYING SCORE ENGINE ───────────────────────────────────────────────
// The "AI Confidence Engine": every independent factor returns a sub-score; the
// weighted sum is a 0–100 with an explainable per-factor breakdown, a direction
// (CE/PE/NO_TRADE), a recommended strike + expiry, a sized trade plan, and a
// human "decision report". Deterministic and rule-based — the LLM stays an
// optional second opinion, never a scoring input.
//
// Pure: scoreOption(inputs) → result. Data gathering happens in the page/scanner.

import { detectSwings, detectBOS, detectOrderBlocks, detectFVGs, detectLiquidity, detectMSLabels, detectPD, calcEMAs, calcRSI, calcATR } from "./ict.js";
import { detectRegime } from "./regime.js";
import { expectedMove, selectStrike, optionsTradePlan } from "./strike.js";
import { evaluateGuardrails, marketSession } from "./guardrails.js";

export const DEFAULT_WEIGHTS = { trend: 20, momentum: 15, ict: 20, chainOi: 15, greeks: 10, ivVix: 10, risk: 5, news: 5 };
export const SCORE_WEIGHTS_KEY = "alphaedge_score_weights";
export const TRADE_THRESHOLD = 70;
export const WATCH_THRESHOLD = 55;

export function getScoreWeights() {
  try {
    const raw = JSON.parse(localStorage.getItem(SCORE_WEIGHTS_KEY) || "{}");
    return { ...DEFAULT_WEIGHTS, ...raw };
  } catch { return { ...DEFAULT_WEIGHTS }; }
}
export function setScoreWeights(w) {
  try { localStorage.setItem(SCORE_WEIGHTS_KEY, JSON.stringify(w)); } catch { /* ignore */ }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isBull = (dir) => dir === "CE";

// Each factor returns { points (0..weight), weight, score01, missing, reasons[] }.
function F(weight, awarded, reasons, missing = false) {
  const pts = missing ? 0 : clamp(awarded, 0, weight);
  return { weight, points: +pts.toFixed(2), score01: missing ? null : +(pts / weight).toFixed(3), missing, reasons };
}

// ── Factor 1: Trend & Market Structure (directional) ──
function factorTrend(dir, w, { candles5m, candles15m, candles1H }) {
  if (!candles15m || candles15m.length < 50) return F(w, 0, ["Not enough 15m candles"], true);
  const bull = isBull(dir);
  const reasons = [];
  let pts = 0;
  const emaAlign = (c) => {
    const { e20, e50 } = calcEMAs(c);
    const px = c.at(-1).close, l20 = e20.at(-1), l50 = e50.at(-1);
    return bull ? (px > l20 && l20 >= l50) : (px < l20 && l20 <= l50);
  };
  // EMA alignment 5m & 15m — 3 each
  if (candles5m && candles5m.length >= 50 && emaAlign(candles5m)) { pts += 3; reasons.push("5m EMA20/50 aligned with direction"); }
  if (emaAlign(candles15m)) { pts += 3; reasons.push("15m EMA20/50 aligned with direction"); }
  // EMA20 slope — 3
  const { e20 } = calcEMAs(candles15m);
  const l20 = e20.at(-1), p20 = e20[Math.max(0, e20.length - 6)] || l20;
  const slope = l20 ? (l20 - p20) / l20 * 100 : 0;
  if ((bull && slope > 0.05) || (!bull && slope < -0.05)) { pts += 3; reasons.push(`EMA20 slope ${slope.toFixed(2)}% (strong)`); }
  else if ((bull && slope > 0.01) || (!bull && slope < -0.01)) { pts += 1.5; reasons.push(`EMA20 slope ${slope.toFixed(2)}% (mild)`); }
  // Swing structure HH/HL vs LL/LH — 4
  const labels = detectMSLabels(detectSwings(candles15m)).slice(-4);
  const good = bull ? labels.filter(l => l.label === "HH" || l.label === "HL").length
                    : labels.filter(l => l.label === "LL" || l.label === "LH").length;
  if (good >= 2) { pts += 4; reasons.push(`Recent structure ${bull ? "HH/HL" : "LL/LH"} (${good})`); }
  else if (good === 1) { pts += 2; }
  // Unbroken 15m BOS in direction — 4
  const bos = detectBOS(candles15m, detectSwings(candles15m)).filter(b => b.label === "BOS");
  const lastBos = bos.at(-1);
  if (lastBos && ((bull && lastBos.type === "bull") || (!bull && lastBos.type === "bear"))) { pts += 4; reasons.push("15m BOS in direction"); }
  // 1H agreement — 3
  if (candles1H && candles1H.length >= 50) {
    const { e50 } = calcEMAs(candles1H);
    const px = candles1H.at(-1).close, l50 = e50.at(-1);
    if ((bull && px > l50) || (!bull && px < l50)) { pts += 3; reasons.push("1H trend agrees (price vs EMA50)"); }
  } else reasons.push("1H candles unavailable — partial trend read");
  if (!reasons.length) reasons.push("No trend alignment in this direction");
  return F(w, pts, reasons);
}

// ── Factor 2: Momentum (directional) ──
function factorMomentum(dir, w, { candles5m }) {
  if (!candles5m || candles5m.length < 40) return F(w, 0, ["Not enough 5m candles"], true);
  const bull = isBull(dir);
  const reasons = [];
  let pts = 0;
  const rsi = calcRSI(candles5m).at(-1);
  if (bull ? (rsi >= 55 && rsi <= 72) : (rsi >= 28 && rsi <= 45)) { pts += 5; reasons.push(`RSI ${rsi.toFixed(0)} in the directional band`); }
  else if (bull ? rsi > 72 : rsi < 28) { pts += 2.5; reasons.push(`RSI ${rsi.toFixed(0)} — overextended`); }
  const atr = calcATR(candles5m).at(-1) || 1;
  const push = candles5m.at(-1).close - candles5m[Math.max(0, candles5m.length - 11)].close;
  if ((bull ? push : -push) >= atr) { pts += 5; reasons.push(`10-bar push ≥ 1 ATR (${(push / atr).toFixed(1)}×)`); }
  else if ((bull ? push : -push) >= atr * 0.5) { pts += 2.5; }
  // MACD-lite: EMA12-EMA26 gap widening
  const ema = (p) => { const k = 2 / (p + 1); let r = candles5m[0].close; return candles5m.map(c => (r = c.close * k + r * (1 - k))); };
  const e12 = ema(12), e26 = ema(26);
  const gapNow = e12.at(-1) - e26.at(-1), gapPrev = e12.at(-4) - e26.at(-4);
  if ((bull && gapNow > gapPrev && gapNow > 0) || (!bull && gapNow < gapPrev && gapNow < 0)) { pts += 3; reasons.push("MACD-lite gap widening in direction"); }
  // Volume expansion vs 20-bar mean
  const vols = candles5m.slice(-20).map(c => c.vol || 0);
  const vMean = vols.reduce((a, b) => a + b, 0) / (vols.length || 1);
  if ((candles5m.at(-1).vol || 0) > vMean * 1.3) { pts += 2; reasons.push("Volume expanding vs 20-bar mean"); }
  if (!reasons.length) reasons.push("Momentum flat / against direction");
  return F(w, pts, reasons);
}

// ── Factor 3: ICT / SMC confluence (directional) ──
function factorICT(dir, w, { candles15m }) {
  if (!candles15m || candles15m.length < 50) return F(w, 0, ["Not enough candles for ICT read"], true);
  const bull = isBull(dir);
  const reasons = [];
  let pts = 0;
  const sw = detectSwings(candles15m);
  const spot = candles15m.at(-1).close;
  // Fresh BOS/CHoCH agreeing — 5 (CHoCH against gives 0)
  const struct = detectBOS(candles15m, sw).at(-1);
  if (struct) {
    const agrees = (bull && (struct.type === "bull" || struct.type === "hl")) || (!bull && (struct.type === "bear" || struct.type === "lh"));
    if (agrees && struct.label === "BOS") { pts += 5; reasons.push("Fresh BOS in direction"); }
    else if (agrees) { pts += 3; reasons.push(`${struct.label} in direction`); }
  }
  // Unmitigated same-direction OB at price — 5
  const obs = detectOrderBlocks(candles15m, sw).filter(o => o.type === (bull ? "bull" : "bear") && !o.mitigated);
  if (obs.some(o => spot >= o.bot * 0.999 && spot <= o.top * 1.001)) { pts += 5; reasons.push("Price at an unmitigated order block"); }
  else if (obs.length) { pts += 2; reasons.push("Unmitigated OB nearby"); }
  // Open FVG in direction — 4
  const fvgs = detectFVGs(candles15m).filter(f => f.type === (bull ? "bull" : "bear") && !f.filled);
  if (fvgs.length) { pts += 4; reasons.push("Open FVG supports direction"); }
  // Completed liquidity sweep — 3
  const liq = detectLiquidity(sw);
  if (liq.length) { pts += 3; reasons.push(`Liquidity pool mapped (${liq.length} eq levels)`); }
  // PD array: discount for CE / premium for PE — 3
  const pd = detectPD(sw);
  if (pd) {
    const inDiscount = spot < pd.mid, inPremium = spot > pd.mid;
    if ((bull && inDiscount) || (!bull && inPremium)) { pts += 3; reasons.push(`Entering from ${bull ? "discount" : "premium"} half of the range`); }
  }
  if (!reasons.length) reasons.push("No ICT confluence in this direction");
  return F(w, pts, reasons);
}

// ── Factor 4: Option Chain & OI (directional) ──
function factorChainOI(dir, w, { oi, chain }) {
  if (!oi?.ok) return F(w, 0, ["OI-trend data unavailable"], true);
  const bull = isBull(dir);
  const reasons = [];
  let pts = 0;
  const sm = oi.smartMoney;
  if (sm.bias === (bull ? "BULLISH" : "BEARISH")) { pts += 5 * clamp(sm.strength / 0.6, 0.3, 1); reasons.push(`Smart-money OI ${sm.bias} (${(sm.strength * 100).toFixed(0)}%)`); }
  const wb = oi.matrix.writerBias;
  if (wb === (bull ? "BULLISH" : "BEARISH")) { pts += 4; reasons.push(`Writer bias ${wb} (writers fading ${bull ? "puts" : "calls"})`); }
  // Wall geometry: room to the opposite wall
  const spot = oi.underLtp;
  if (bull && spot > oi.walls.support.strike && oi.walls.resistance.strike - spot >= (oi.atmStrike ? 1 : 0)) { pts += 4; reasons.push(`Above PE-wall support ${oi.walls.support.strike}, headroom to ${oi.walls.resistance.strike}`); }
  else if (!bull && spot < oi.walls.resistance.strike && spot - oi.walls.support.strike >= 0) { pts += 4; reasons.push(`Below CE-wall resistance ${oi.walls.resistance.strike}, room to ${oi.walls.support.strike}`); }
  // PCR regime
  if ((bull && oi.pcr > 1.15) || (!bull && oi.pcr < 0.85)) { pts += 2; reasons.push(`PCR ${oi.pcr.toFixed(2)} supports direction`); }
  if (!reasons.length) reasons.push("OI positioning does not favour this direction");
  return F(w, pts, reasons);
}

// ── Factor 5: Greeks on the CHOSEN strike (directional; runs after selection) ──
function factorGreeks(dir, w, { leg, spot, dteYears }) {
  if (!leg) return F(w, 0, ["No strike selected"], true);
  const reasons = [];
  let pts = 0;
  const adelta = Math.abs(leg.delta || 0);
  if (adelta >= 0.50 && adelta <= 0.60) { pts += 4; reasons.push(`Delta ${leg.delta.toFixed(2)} — ideal`); }
  else if (adelta >= 0.45 && adelta <= 0.65) { pts += 2.5; reasons.push(`Delta ${leg.delta.toFixed(2)} — acceptable`); }
  const thetaBurden = leg.ltp > 0 ? Math.abs(leg.theta || 0) / leg.ltp * 100 : 100;
  if (thetaBurden <= 4) { pts += 3; reasons.push(`Theta burden ${thetaBurden.toFixed(1)}%/day — low`); }
  else if (thetaBurden <= 10) { pts += 1.5; reasons.push(`Theta burden ${thetaBurden.toFixed(1)}%/day — moderate`); }
  else reasons.push(`Theta burden ${thetaBurden.toFixed(1)}%/day — high`);
  if (leg.atm || Math.abs((leg.strike || 0) - (spot || 0)) <= (spot || 0) * 0.003) { pts += 2; reasons.push("Within ±1 strike of ATM (buyer's gamma zone)"); }
  // Vega sanity (short-dated + reasonable IV)
  if ((dteYears ?? 1) < 0.06 || (leg.iv || 0) < 60) { pts += 1; }
  return F(w, pts, reasons);
}

// ── Factor 6: IV & India VIX (directional) ──
function factorIVVix(dir, w, { chain, vix, eventInDTE }) {
  const reasons = [];
  let pts = 0, anyData = false;
  const ivp = chain?.ivPercentile;
  if (ivp != null) {
    anyData = true;
    const p = ivp < 30 ? 4 : ivp < 60 ? 3 : ivp < 75 ? 1.5 : 0;
    pts += p; reasons.push(`ATM IV ${ivp}th pct — ${ivp < 30 ? "cheap (buyer-friendly)" : ivp > 75 ? "rich (buyer-hostile)" : "fair"}`);
  }
  const proxy = vix?.source === "proxy";
  const vl = vix?.vix?.ltp;
  if (vl != null) {
    anyData = true;
    const credit = proxy ? 0.5 : 1;
    const regimePts = (vl >= 11 && vl <= 18) ? 3 : vl < 11 ? 1.5 : Math.max(0, 3 - (vl - 18) * 0.3);
    pts += regimePts * credit; reasons.push(`VIX ${vl.toFixed(1)}${proxy ? " (proxy)" : ""} — ${vl < 11 ? "complacent" : vl > 18 ? "elevated" : "comfortable"}`);
    const changePct = vix?.vix?.changePct || 0;
    if ((isBull(dir) && changePct < 0) || (!isBull(dir) && changePct > 0)) { pts += 2 * credit; reasons.push(`VIX ${changePct >= 0 ? "rising" : "falling"} agrees with a ${isBull(dir) ? "call" : "put"} buy`); }
  }
  if (!eventInDTE) { pts += 1; } else reasons.push("Event inside DTE horizon — IV-crush risk");
  if (!anyData) return F(w, 0, ["No IV / VIX data"], true);
  return F(w, pts, reasons);
}

// ── Factor 7: Risk management (non-directional) ──
function factorRisk(w, { guardEval, session }) {
  const reasons = [];
  let pts = 0;
  const st = guardEval?.state || {};
  const g = st.maxTrades || 5;
  if ((st.tradesToday ?? 0) < g - 1) { pts += 1.5; reasons.push(`Trades used ${st.tradesToday ?? 0}/${g} — headroom`); }
  if ((st.cooldownLeft ?? 0) === 0) { pts += 1.5; reasons.push("No active post-loss cooldown"); }
  if (session === "prime" || session === "ok") { pts += 1; reasons.push("Inside a tradeable session window"); }
  if ((st.consec ?? 0) < 2) { pts += 1; reasons.push("Not on a loss streak"); }
  if (!reasons.length) reasons.push("Risk posture stretched");
  return F(w, pts, reasons);
}

// ── Factor 8: News & event risk (non-directional) ──
function factorNews(w, { eventMin, eventToday }) {
  const reasons = [];
  let pts = 0;
  if (eventMin == null || eventMin > 120 || eventMin < 0) { pts += 3; reasons.push("No high-impact event within 2h"); }
  else if (eventMin > 60) { pts += 1.5; reasons.push(`Event in ~${eventMin}m — reduce size`); }
  else reasons.push(`Event in ~${eventMin}m — stand aside`);
  if (!eventToday) { pts += 2; reasons.push("No event-day flag (RBI/CPI/Fed/Budget)"); }
  else { pts += 1; reasons.push("Event day — trade the plan, not the surprise"); }
  return F(w, pts, reasons);
}

// ── main ──────────────────────────────────────────────────────────────────────
export function scoreOption(inputs) {
  const {
    underlying, candles5m, candles15m, candles1H,
    chain, oi, vix, history = [], events = {}, mm = {}, riskPct = 1,
    weights = getScoreWeights(),
  } = inputs;

  const gates = [];
  const eventMin = events.eventMin ?? null;      // minutes to next high-impact event
  const eventToday = !!events.eventToday;
  const eventSoon = eventMin != null && eventMin >= 0 && eventMin < 30;
  const dteYears = chain?.expiry ? Math.max(2 / 24, (new Date(`${chain.expiry}T15:30:00+05:30`).getTime() - Date.now()) / 86400000) / 365 : (1 / 365);
  const eventInDTE = eventToday || (eventMin != null && eventMin >= 0 && eventMin / (60 * 24) < dteYears * 365);

  // Regime read (logged + can veto).
  const regime = detectRegime({ candles: candles15m || [], chain, vix, oi, eventSoon, eventToday });

  // ── HARD GATES ──
  if (!chain?.ok && !chain?.strikes?.length) gates.push("No option chain — cannot evaluate");
  if (!candles15m || candles15m.length < 50) gates.push("Insufficient candle history");
  const guardEval = evaluateGuardrails(history, { asset: underlying }, underlying);
  if (guardEval.blocked) gates.push(`Guardrail: ${guardEval.violations[0]}`);
  if (chain?.isExpiryToday && getGuardBlockExpiry()) gates.push("Expiry day (0-DTE) — guardrail blocks buying");
  if (eventSoon) gates.push(`High-impact event in ~${eventMin}m — stand aside`);
  if (!regime.favorable && (regime.regime === "RANGE" || regime.regime === "VOL_COMPRESSION")) gates.push(`Regime ${regime.label} — buyer-hostile`);

  const session = marketSessionQuality(underlying);

  // ── score both directions ──
  const scoreDir = (dir, chosenLeg) => {
    const f = {
      trend: factorTrend(dir, weights.trend, { candles5m, candles15m, candles1H }),
      momentum: factorMomentum(dir, weights.momentum, { candles5m }),
      ict: factorICT(dir, weights.ict, { candles15m }),
      chainOi: factorChainOI(dir, weights.chainOi, { oi, chain }),
      ivVix: factorIVVix(dir, weights.ivVix, { chain, vix, eventInDTE }),
      greeks: factorGreeks(dir, weights.greeks, { leg: chosenLeg, spot: chain?.under_ltp, dteYears }),
      risk: factorRisk(weights.risk, { guardEval, session }),
      news: factorNews(weights.news, { eventMin, eventToday }),
    };
    return f;
  };

  // First pass without greeks-strike to pick direction on factors 1-4,6-8.
  const em = expectedMove(chain, dteYears);
  const minPrem = getGuardMinPremium();
  const preCE = scoreDir("CE", null), prePE = scoreDir("PE", null);
  const dirTotal = (f) => Object.entries(f).filter(([k]) => k !== "greeks")
    .reduce((s, [, v]) => s + (v.missing ? 0 : v.points), 0);
  const direction = dirTotal(preCE) >= dirTotal(prePE) ? "CE" : "PE";

  // Select strike for the winning direction, then finalize with greeks.
  const pick = selectStrike({ chain, direction, minPremium: minPrem, expected: em });
  const chosenLeg = pick?.leg || null;
  const factors = scoreDir(direction, chosenLeg);

  // ── coverage-capped renormalization ──
  const present = Object.values(factors).filter(f => !f.missing);
  const coverage = present.reduce((s, f) => s + f.weight, 0);   // 0..100
  const rawPts = present.reduce((s, f) => s + f.points, 0);
  let score = 0, verdict = "NO_TRADE", why = "";
  if (coverage < 70) {
    gates.push(`Only ${coverage}% factor coverage — insufficient data`);
  }
  if (!gates.length) {
    const renorm = coverage > 0 ? (rawPts / coverage) * 100 : 0;
    score = Math.round(renorm * (0.85 + 0.15 * coverage / 100));
    verdict = score >= TRADE_THRESHOLD ? "TRADE" : score >= WATCH_THRESHOLD ? "WATCH" : "NO_TRADE";
  }
  if (gates.length) { verdict = "NO_TRADE"; why = gates[0]; }
  else why = verdict === "TRADE" ? `Score ${score} — factors align for a ${direction === "CE" ? "call" : "put"} buy`
           : verdict === "WATCH" ? `Score ${score} — setup forming, wait for confirmation`
           : `Score ${score} — no decisive edge`;

  // ── plan + expected move ──
  const plan = (verdict !== "NO_TRADE" && chosenLeg)
    ? optionsTradePlan({ rec: { ltp: chosenLeg.ltp }, underlying, mm, riskPct }) : null;

  // ── decision report (the explainable output) ──
  const report = buildReport({ underlying, direction, verdict, score, regime, factors, pick, chosenLeg, chain, oi, vix, em, plan, why, gates });

  return {
    ok: true, underlying, direction: verdict === "NO_TRADE" ? "NO_TRADE" : direction,
    verdict, score, coverage, why, gates,
    regime, factors, weights,
    strike: chosenLeg ? { strike: chosenLeg.strike, moneyness: pick?.moneyness, ltp: chosenLeg.ltp,
                          delta: chosenLeg.delta, theta: chosenLeg.theta, iv: chosenLeg.iv,
                          expiry: chain?.expiry, reasons: pick?.reasons || [] } : null,
    expectedMove: em, plan, report,
    ts: Date.now(),
  };
}

// Build the human-readable decision report array.
function buildReport({ underlying, direction, verdict, score, regime, factors, pick, chosenLeg, chain, oi, vix, em, plan, why }) {
  const lines = [];
  if (verdict === "NO_TRADE") {
    lines.push({ k: "Verdict", v: "NO TRADE", tone: "warn" });
    lines.push({ k: "Reason", v: why });
    lines.push({ k: "Regime", v: `${regime.label} (${regime.confidence}%)` });
    return lines;
  }
  const label = chosenLeg ? `${verdict === "WATCH" ? "WATCH" : "BUY"} ${underlying} ${chosenLeg.strike} ${direction}${chain?.expiry ? " " + chain.expiry.slice(5) : ""}` : `${verdict} ${underlying} ${direction}`;
  lines.push({ k: "Trade", v: label, tone: direction === "CE" ? "good" : "bad" });
  lines.push({ k: "Confidence", v: `${score}/100 (${verdict})`, tone: score >= 70 ? "good" : "warn" });
  lines.push({ k: "Market Regime", v: `${regime.label} · ${regime.confidence}%` });
  lines.push({ k: "Trending OI", v: `${oi?.smartMoney?.bias || "—"} · ${oi?.matrix?.underlying?.replace(/_/g, " ") || "—"}` });
  if (chosenLeg) lines.push({ k: "Greeks", v: `Δ ${chosenLeg.delta?.toFixed(2)} · θ ${chosenLeg.theta?.toFixed(1)}/day · IV ${chosenLeg.iv}` });
  if (chain?.ivPercentile != null) lines.push({ k: "IV", v: `${chain.ivPercentile}th pct${vix?.vix?.ltp ? ` · VIX ${vix.vix.ltp.toFixed(1)}` : ""}` });
  if (em) lines.push({ k: "Expected move", v: `≈${em.points} pts (${em.pct}%) by expiry` });
  if (pick) lines.push({ k: "Strike", v: `${chosenLeg.strike} ${pick.moneyness} @ ₹${chosenLeg.ltp}` });
  if (plan) {
    lines.push({ k: "Plan", v: `${plan.lots} lot(s) · SL ₹${plan.slPrice} · target ₹${plan.tgtPrice} · 1:${plan.rr}` });
    lines.push({ k: "Risk", v: `₹${Math.round(plan.riskRs)} risk / ₹${Math.round(plan.rewardRs)} reward · outlay ₹${Math.round(plan.outlayRs)}` });
  }
  // top contributing + dragging factors
  const ranked = Object.entries(factors).filter(([, f]) => !f.missing).sort((a, b) => b[1].score01 - a[1].score01);
  if (ranked.length) {
    lines.push({ k: "Strongest", v: ranked.slice(0, 2).map(([k, f]) => `${k} ${(f.score01 * 100).toFixed(0)}%`).join(", "), tone: "good" });
    const weak = ranked.slice(-2).filter(([, f]) => f.score01 < 0.5);
    if (weak.length) lines.push({ k: "Weakest", v: weak.map(([k, f]) => `${k} ${(f.score01 * 100).toFixed(0)}%`).join(", "), tone: "warn" });
  }
  return lines;
}

// Local reads of guardrail config (avoid importing the whole module surface).
function getGuardBlockExpiry() {
  try { return (JSON.parse(localStorage.getItem("alphaedge_guardrails") || "{}").blockExpiryDay ?? true); } catch { return true; }
}
function getGuardMinPremium() {
  try { return Number(JSON.parse(localStorage.getItem("alphaedge_guardrails") || "{}").minPremium ?? 40); } catch { return 40; }
}
// Session quality for the underlying.
function marketSessionQuality(underlying) {
  try { return marketSession(underlying).quality; } catch { return "ok"; }
}
