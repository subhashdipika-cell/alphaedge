// ─── DISCIPLINE GUARDRAILS ─────────────────────────────────────────────────────
// Mechanical rules derived from the 2026-06-23 Dhan option-buying audit (net
// −₹3.4L). Each maps to a documented flaw and flags a rule-violating setup as
// STAND-DOWN. Enforced entirely app-side — AlphaEdge places no orders.

import { nowIST, istDayKey } from "../lib/ist.js";
import { isResolvedSignal, isLossSignal } from "./learning.js";
import { getNseHolidayInfo } from "../data/bridge.js";

export const GUARDRAIL_DEFAULTS = {
  enabled:          true,
  cooldownMin:      15,    // no new entry within N min of closing a loss
  maxTradesPerDay:  5,     // hard daily trade cap
  maxConsecLosses:  2,     // stop for the session after N losses in a row
  openLockout:      true,  // no entries during the volatile open
  openLockoutEnd:   "10:15", // IST — first entries allowed after this
  blockExpiryDay:   true,  // no 0-DTE long options
  minPremium:       40,    // option-buying premium floor (avoid far-OTM lottery)
  maxHoldMin:       30,    // time-stop for open option longs (alert)
};

export function getGuardrails() {
  try { return { ...GUARDRAIL_DEFAULTS, ...JSON.parse(localStorage.getItem("alphaedge_guardrails") || "{}") }; }
  catch { return { ...GUARDRAIL_DEFAULTS }; }
}
export function setGuardrails(v) {
  try { localStorage.setItem("alphaedge_guardrails", JSON.stringify(v)); } catch { /* ignore */ }
}

// Is this an Indian exchange instrument (NSE/BSE)? Open-lockout & expiry rules
// apply to these.
export function isIndianInstrument(asset) {
  const s = String(asset || "").toUpperCase();
  return /NIFTY|BANKNIFTY|SENSEX|BANKEX|FINNIFTY|MIDCP/.test(s);
}

// Trading session + prime-window flag per index, in IST. Used to TAG every
// generated signal so the engine "keeps in mind" the best time to trade and the
// weekly analysis can confirm which session is actually most profitable.
//   Indian prime = 14:00–15:30 IST (audit edge); 09:15–10:15 = avoid
export function marketSession(asset, at = null) {
  const base = at ? new Date(at) : new Date();
  const ist = new Date(base.getTime() + (base.getTimezoneOffset() + 330) * 60000);
  const dow = ist.getDay();                 // 0 Sun .. 6 Sat
  const m   = ist.getHours() * 60 + ist.getMinutes();
  const a   = String(asset || "").toUpperCase();

  if (isIndianInstrument(a)) {
    if (dow === 0 || dow === 6 || m < 555 || m > 930) return { session: "Closed", prime: false, quality: "closed" };
    if (m < 615)  return { session: "NSE Open (volatile)", prime: false, quality: "avoid" };  // 09:15–10:15
    if (m >= 840) return { session: "NSE Afternoon",       prime: true,  quality: "prime" };  // 14:00–15:30
    return { session: "NSE Midday", prime: false, quality: "ok" };
  }
  return { session: "", prime: false, quality: "ok" };
}

// Evaluate all guardrails against trade history (+ an optional candidate signal).
// `asset` lets exchange-specific rules (NSE open lockout) target Indian markets.
// Returns { blocked, violations[], warnings[], state{} } — drives both the
// STAND-DOWN verdict and the live Discipline Monitor.
export function evaluateGuardrails(history = [], signal = null, asset = null) {
  const g = getGuardrails();
  const ist = nowIST();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const todayKey = ist.toDateString();
  const violations = [], warnings = [];
  const indian = isIndianInstrument(asset || signal?.asset || signal?.symbol);

  const todays = history.filter(s => s && s.timestamp && istDayKey(s.timestamp) === todayKey);
  const resolved = history.filter(isResolvedSignal).sort((a, b) => b.timestamp - a.timestamp);
  let consec = 0;
  for (const s of resolved) { if (isLossSignal(s)) consec++; else break; }
  const lastLoss = resolved.find(isLossSignal);
  // Count cooldown from when the loss resolved if known, else from signal time.
  const lossTime = lastLoss ? (lastLoss.closedAt || lastLoss.resolvedAt || lastLoss.timestamp) : 0;
  const cooldownLeft = lastLoss
    ? Math.max(0, Math.ceil(g.cooldownMin - (Date.now() - lossTime) / 60000))
    : 0;

  if (!g.enabled) {
    return { blocked: false, violations, warnings, state: { tradesToday: todays.length, consec, cooldownLeft, disabled: true } };
  }

  // 1) Post-loss cooldown
  if (g.cooldownMin > 0 && cooldownLeft > 0)
    violations.push(`Cooldown active — ${cooldownLeft} min left after last loss (revenge-trade guard)`);
  // 2) Daily trade cap
  if (todays.length >= g.maxTradesPerDay)
    violations.push(`Daily trade cap reached (${todays.length}/${g.maxTradesPerDay}) — stop for today`);
  // 3) Consecutive-loss session stop
  if (consec >= g.maxConsecLosses)
    violations.push(`${consec} consecutive losses — session stop (no revenge trades)`);
  // 4) NSE market-open lockout — Indian instruments only
  let inNseOpen = false;
  if (g.openLockout) {
    const [h, m] = String(g.openLockoutEnd || "10:15").split(":").map(Number);
    const end = (h || 10) * 60 + (m || 15);
    inNseOpen = mins >= (9 * 60 + 15) && mins < end;
    // Only blocks an actual Indian-instrument trade. When asset is unknown
    // (general monitor view), it's informational, not a block.
    if (inNseOpen && indian)
      violations.push(`NSE open lockout until ${g.openLockoutEnd} IST (worst window in your audit)`);
  }
  // 5) Expiry-day / 0-DTE (option signals only)
  if (g.blockExpiryDay && signal && signal.expiry) {
    if (istDayKey(signal.timestamp || Date.now()) === istDayKey(new Date(signal.expiry).getTime()))
      violations.push("0-DTE long blocked — no option buying on expiry day");
  }
  // 6) Premium floor (option signals only)
  if (g.minPremium > 0 && signal && Number.isFinite(Number(signal.optionPremium))) {
    if (Number(signal.optionPremium) < g.minPremium)
      violations.push(`Premium ₹${signal.optionPremium} below floor ₹${g.minPremium} — far-OTM lottery guard`);
  }
  // 7) NSE holiday + intraday square-off (Indian instruments only).
  if (indian) {
    if (getNseHolidayInfo()?.isHoliday)
      violations.push("NSE holiday today (Dhan calendar) — Indian market closed");
    else if (mins >= 15 * 60 + 5 && mins <= 15 * 60 + 30)
      violations.push("NSE square-off — no new entries after 15:05 IST (flat before 15:20, close 15:30)");
  }
  // Warning (not a block): one trade away from the daily cap
  if (todays.length === g.maxTradesPerDay - 1)
    warnings.push(`Last trade of the day — ${todays.length + 1}/${g.maxTradesPerDay}`);

  return {
    blocked: violations.length > 0,
    violations, warnings,
    state: { tradesToday: todays.length, maxTrades: g.maxTradesPerDay, consec, cooldownLeft,
             nseOpenWindow: inNseOpen,                       // NSE 09:15→lockout-end window active
             inOpenLockout: inNseOpen && (indian || asset===null) },  // chip status for Indian context
  };
}
