// ─── ECONOMIC-EVENT CALENDAR (shared feed) ────────────────────────────────────
// Owns the event list (live-fetched by App, or a fallback), and an
// eventProximity() read that the Option Buying Score's News & Event factor
// consumes so imminent RBI/CPI/Fed/Budget risk actually gates/penalises trades.

// Intentionally empty: the calendar is now fed live by the bridge (Forex Factory,
// server-side — see bridge.py /calendar + App fetchEconEvents). A hardcoded seed
// only ever went stale and displayed wrong dates/times, so there is no fabricated
// fallback. When the live feed is unreachable the calendar simply shows no events
// (and the score's News factor treats that as "no known event", i.e. no penalty).
export const ECON_EVENTS_FALLBACK = [];

// US events still move Indian indices (Fed → FII flows), so USD maps to them too.
export const ASSET_IMPACT = {
  USD:["NIFTY50","BANKNIFTY","SENSEX"],
  INR:["NIFTY50","BANKNIFTY","SENSEX","FINNIFTY"],
};

// Live calendar cache (module scope so it survives page unmount/remount).
let LIVE_ECON_EVENTS = null;
export function setLiveEconEvents(list) { LIVE_ECON_EVENTS = (Array.isArray(list) && list.length) ? list : LIVE_ECON_EVENTS; }
export function hasLiveEconEvents() { return !!(LIVE_ECON_EVENTS && LIVE_ECON_EVENTS.length); }
export function getEconEvents() {
  return (LIVE_ECON_EVENTS && LIVE_ECON_EVENTS.length) ? LIVE_ECON_EVENTS : ECON_EVENTS_FALLBACK;
}

const istDayStr = (ms) => {
  const ist = new Date(ms + (new Date(ms).getTimezoneOffset() + 330) * 60000);
  return ist.toDateString();
};

// High-impact event proximity for an underlying → { eventMin, eventToday, next }.
//   eventMin  = minutes to the nearest FUTURE high-impact event (≤ 48h), else null
//   eventToday = a high-impact event lands today (IST) — flags event-day risk
// Only events relevant to the Indian indices (INR + USD via ASSET_IMPACT) count.
export function eventProximity(underlying, now = Date.now()) {
  const relevant = getEconEvents().filter(e => {
    if (String(e.impact).toLowerCase() !== "high") return false;
    const affects = ASSET_IMPACT[e.currency] || [];
    return affects.includes(underlying);
  });
  const todayStr = istDayStr(now);
  let eventMin = null, next = null, eventToday = false;
  for (const e of relevant) {
    const t = new Date(e.datetime).getTime();
    if (!Number.isFinite(t)) continue;
    if (istDayStr(t) === todayStr) eventToday = true;
    const mins = (t - now) / 60000;
    if (mins >= 0 && mins <= 48 * 60 && (eventMin == null || mins < eventMin)) { eventMin = Math.round(mins); next = e; }
  }
  return { eventMin, eventToday, next };
}
