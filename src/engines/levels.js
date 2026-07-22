// ─── LEVEL ENGINE — context awareness ("human touch") ─────────────────────────
// The mechanical flaws this fixes: entering after momentum is gone (chasing),
// shorting at support / longing at resistance (no map), and placing targets
// beyond the barrier price would have to break. None of that is emotion — it's
// location. This module builds a level map before every decision:
//   swing highs/lows (15m) · previous-day H/L/C · round numbers · OI walls
// and derives the three checks the score engine gates on:
//   freshness (ATR extension) · location (barrier proximity) · R:R-to-structure.
//
// Pure functions — unit-tested, reused by the app, the headless scanner and replay.

import { detectSwings, calcEMAs, calcATR } from "./ict.js";

// ── Config (localStorage-overridable: "alphaedge_levels") ─────────────────────
export const LEVELS_DEFAULTS = {
  enforce: true,        // true = violations gate the trade; false = shadow (tag only)
  minRRStructure: 1.2,  // (room to opposing barrier − buffer) ÷ underlying stop must be ≥ this
  bufferATR: 0.25,      // target buffer before the barrier, in 15m-ATR units
  locATR: 0.35,         // "too close to the barrier" proximity, in 15m-ATR units
  extMaxATR: 1.5,       // skip if price is further than this from the 5m EMA20, in 5m-ATR units
  minBarrierStrength: 1, // only levels this strong act as barriers for the gates
                         // (minor round numbers / prev-day close are context, not walls)
  structSL: true,       // SL behind the helping barrier instead of a blind % of premium
  minStopATR: 0.6,      // structural stop never tighter than this (noise floor), 15m-ATR units
  maxStopATR: 3.0,      // ...and never wider (volatility cap when structure is far), 15m-ATR units
};
export function getLevelsConfig() {
  try { return { ...LEVELS_DEFAULTS, ...JSON.parse(localStorage.getItem("alphaedge_levels") || "{}") }; }
  catch { return { ...LEVELS_DEFAULTS }; }
}

// Round-number gravity per index: minor step (every level) + major step (stronger).
const ROUND_STEPS = {
  NIFTY50:   { step: 100, major: 500 },
  BANKNIFTY: { step: 500, major: 1000 },
  SENSEX:    { step: 500, major: 1000 },
  FINNIFTY:  { step: 100, major: 500 },
};

const istDayKeyOf = (ts) => {
  const d = new Date(ts);
  return new Date(d.getTime() + (d.getTimezoneOffset() + 330) * 60000).toDateString();
};

// ── Build the level map for one underlying ────────────────────────────────────
// candles15m: [{open,high,low,close,ts}] (oldest→newest). oi: analyzeOiTrend()
// result (optional — walls/maxPain merge in when present). Returns
// { ok, spot, atr, levels[{price,kind,strength}], supports[], resistances[] }.
export function buildLevelMap({ underlying, candles15m, spot, oi = null }) {
  if (!Array.isArray(candles15m) || candles15m.length < 30 || !(spot > 0)) return { ok: false };
  const atrArr = calcATR(candles15m, 14);
  const atr = atrArr[atrArr.length - 1] || spot * 0.002;
  const raw = [];

  // Swing highs/lows (last 8 each, recent structure only).
  const { highs, lows } = detectSwings(candles15m, 3);
  highs.slice(-8).forEach(h => raw.push({ price: h.price, kind: "swing-high", strength: 1 }));
  lows.slice(-8).forEach(l => raw.push({ price: l.price, kind: "swing-low", strength: 1 }));

  // Previous-day high / low / close (from the day before the last candle's day).
  const lastDay = istDayKeyOf(candles15m[candles15m.length - 1].ts);
  const prevDays = candles15m.filter(c => istDayKeyOf(c.ts) !== lastDay);
  if (prevDays.length) {
    const prevDay = istDayKeyOf(prevDays[prevDays.length - 1].ts);
    const pd = prevDays.filter(c => istDayKeyOf(c.ts) === prevDay);
    if (pd.length) {
      raw.push({ price: Math.max(...pd.map(c => c.high)), kind: "pdh", strength: 1.3 });
      raw.push({ price: Math.min(...pd.map(c => c.low)),  kind: "pdl", strength: 1.3 });
      raw.push({ price: pd[pd.length - 1].close,          kind: "pdc", strength: 0.7 });
    }
  }

  // Full-window extremes — the multi-session shelf/ceiling. Fractal swings
  // plus the last-8 recency cap lose these in a breakdown/breakout: after a
  // rally every recent swing low sits ABOVE price, so the support side of
  // the map degrades to round numbers exactly when location matters most.
  // 2026-07-22: FINNIFTY bounced at 26,214 with the window low at 26,211.65
  // and SENSEX at 76,819 with the window low at 76,800 — neither was in the
  // map; both PE targets reached far beyond them.
  raw.push({ price: Math.min(...candles15m.map(c => c.low)),  kind: "win-low",  strength: 1.4 });
  raw.push({ price: Math.max(...candles15m.map(c => c.high)), kind: "win-high", strength: 1.4 });

  // Round numbers around spot (±3 minor steps; majors count more).
  const rs = ROUND_STEPS[underlying] || { step: 100, major: 500 };
  const base = Math.round(spot / rs.step) * rs.step;
  for (let k = -3; k <= 3; k++) {
    const p = base + k * rs.step;
    if (p <= 0) continue;
    raw.push({ price: p, kind: "round", strength: p % rs.major === 0 ? 1.2 : 0.6 });
  }

  // OI walls: max-CE-OI strike caps upside (resistance), max-PE-OI supports.
  if (oi?.walls?.resistance?.strike) raw.push({ price: oi.walls.resistance.strike, kind: "ce-wall", strength: 1.6 });
  if (oi?.walls?.support?.strike)    raw.push({ price: oi.walls.support.strike,    kind: "pe-wall", strength: 1.6 });

  // Cluster near-identical levels (within 0.1% of spot): sum strength, keep kinds.
  const tol = spot * 0.001;
  raw.sort((a, b) => a.price - b.price);
  const levels = [];
  for (const l of raw) {
    const last = levels[levels.length - 1];
    if (last && Math.abs(l.price - last.price) <= tol) {
      last.strength = +(last.strength + l.strength).toFixed(2);
      if (!last.kinds.includes(l.kind)) last.kinds.push(l.kind);
      last.price = +((last.price + l.price) / 2).toFixed(2);
    } else {
      levels.push({ price: +l.price.toFixed(2), kinds: [l.kind], strength: l.strength });
    }
  }
  const eps = spot * 0.0002;
  return {
    ok: true, spot, atr: +atr.toFixed(2), levels,
    resistances: levels.filter(l => l.price > spot + eps),
    supports:    levels.filter(l => l.price < spot - eps),
  };
}

// Nearest barrier on each side of spot. Returns { res, sup } (level objects or null).
export function nearestBarriers(map, spot = map?.spot) {
  if (!map?.ok) return { res: null, sup: null };
  const res = map.resistances.length ? map.resistances.reduce((m, l) => (l.price < m.price ? l : m)) : null;
  const sup = map.supports.length    ? map.supports.reduce((m, l) => (l.price > m.price ? l : m))    : null;
  return { res, sup, distUp: res ? +(res.price - spot).toFixed(2) : null, distDn: sup ? +(spot - sup.price).toFixed(2) : null };
}

// ── Freshness: how extended is price from its 5m mean, in ATR units? ──────────
// > extMaxATR in the trade's direction = chasing a move that already happened.
export function extensionATR(candles5m) {
  if (!Array.isArray(candles5m) || candles5m.length < 30) return null;
  const { e20 } = calcEMAs(candles5m);
  const atrArr = calcATR(candles5m, 14);
  const close = candles5m[candles5m.length - 1].close;
  const ema = e20[e20.length - 1], atr = atrArr[atrArr.length - 1];
  if (!(atr > 0)) return null;
  return { ext: +((close - ema) / atr).toFixed(2), ema20: +ema.toFixed(2), atr: +atr.toFixed(2) };
}

// ── The combined human check ──────────────────────────────────────────────────
// direction: "CE" (long underlying) | "PE" (short underlying).
// stopUnderPts: the stop distance expressed in UNDERLYING points (premium SL ÷ |delta|).
// ext: extensionATR() result (signed; positive = above the 5m mean).
// Returns { violations[{code,reason}], rrStructure, headroom, barrier, buffer, extension }.
export function humanCheck({ direction, map, stopUnderPts, ext = null, cfg = LEVELS_DEFAULTS }) {
  const out = { violations: [], rrStructure: null, headroom: null, barrier: null, buffer: null, extension: ext?.ext ?? null };
  if (!map?.ok) return out;
  // Barriers = STRONG levels only (swings, PDH/PDL, OI walls, major rounds,
  // clusters). Minor round numbers are speed bumps, not walls — they stay on the
  // map for display but don't gate trades.
  const minStr = cfg.minBarrierStrength ?? 1;
  const strongRes = map.resistances.filter(l => l.strength >= minStr);
  const strongSup = map.supports.filter(l => l.strength >= minStr);
  const res = strongRes.length ? strongRes.reduce((m, l) => (l.price < m.price ? l : m)) : null;
  const sup = strongSup.length ? strongSup.reduce((m, l) => (l.price > m.price ? l : m)) : null;
  const buffer = +(cfg.bufferATR * map.atr).toFixed(2);
  const locDist = cfg.locATR * map.atr;
  out.buffer = buffer;

  // 1) Freshness — don't chase an extended move (direction-signed).
  if (ext && Number.isFinite(ext.ext)) {
    const dirExt = direction === "CE" ? ext.ext : -ext.ext;
    if (dirExt > cfg.extMaxATR) {
      out.violations.push({ code: "chasing", reason: `Chasing — price is ${dirExt.toFixed(1)}×ATR beyond the 5m mean; wait for a pullback` });
    }
  }

  // 2) Location — never long into resistance / short into support.
  const opposing = direction === "CE" ? res : sup;
  const opposingDist = opposing ? Math.abs(opposing.price - map.spot) : null;
  if (opposing && opposingDist <= locDist) {
    out.violations.push({
      code: "location",
      reason: `${direction === "CE" ? "Longing into resistance" : "Shorting into support"} @ ${opposing.price} (${opposing.kinds.join("+")}) only ${opposingDist.toFixed(0)} pts away`,
    });
  }

  // 3) R:R to structure — room to the opposing barrier vs the stop.
  if (opposing && stopUnderPts > 0) {
    out.barrier = { price: opposing.price, kinds: opposing.kinds, strength: opposing.strength };
    out.headroom = +Math.max(0, opposingDist - buffer).toFixed(2);
    out.rrStructure = +(out.headroom / stopUnderPts).toFixed(2);
    if (out.rrStructure < cfg.minRRStructure) {
      out.violations.push({
        code: "rr-structure",
        reason: `Only ${out.rrStructure}R of room to ${opposing.price} (${opposing.kinds.join("+")}) — target would sit beyond structure`,
      });
    }
  }
  return out;
}

// ── Structure-based stop: the invalidation lives BEHIND the helping barrier
// (below support for a long / above resistance for a short) — where the trade
// idea is actually wrong — not at a blind percentage of premium. Returns
// { stopUnder, level, kinds, capped } in UNDERLYING points, clamped to
// [minStopATR, maxStopATR]×ATR (noise floor / volatility cap), or null when
// the map has no strong helping level (caller falls back to the % default).
export function structuralStopUnder({ direction, map, cfg = LEVELS_DEFAULTS }) {
  if (!map?.ok) return null;
  const minStr = cfg.minBarrierStrength ?? 1;
  const helping = (direction === "CE" ? map.supports : map.resistances)
    .filter(l => l.strength >= minStr);
  if (!helping.length) return null;
  const lvl = direction === "CE"
    ? helping.reduce((m, l) => (l.price > m.price ? l : m))    // nearest support below
    : helping.reduce((m, l) => (l.price < m.price ? l : m));   // nearest resistance above
  const buffer = (cfg.bufferATR ?? 0.25) * map.atr;
  const raw = direction === "CE"
    ? map.spot - (lvl.price - buffer)
    : (lvl.price + buffer) - map.spot;
  const lo = (cfg.minStopATR ?? 0.6) * map.atr;
  const hi = (cfg.maxStopATR ?? 3.0) * map.atr;
  const stopUnder = Math.min(Math.max(raw, lo), hi);
  return {
    stopUnder: +stopUnder.toFixed(2), level: lvl.price, kinds: lvl.kinds,
    capped: raw > hi ? "far" : raw < lo ? "near" : null,
  };
}

// ── Barrier-aware target: cap the premium target so the implied underlying move
// stays INSIDE the barrier (long TGT = resistance − buffer, in premium space).
// Returns null when no cap applies, else { tgtPts, tgtPrice, rr, capped: true }.
export function capTargetToStructure({ entry, slPts, tgtPts, delta, headroom }) {
  const adelta = Math.abs(delta) || 0.5;
  if (!(headroom > 0) || !(entry > 0) || !(slPts > 0)) return null;
  const maxTgtPts = +(headroom * adelta).toFixed(2);   // premium points achievable inside the room
  if (!(maxTgtPts > 0) || maxTgtPts >= tgtPts) return null;
  return {
    tgtPts: maxTgtPts,
    tgtPrice: +(entry + maxTgtPts).toFixed(2),
    rr: +(maxTgtPts / slPts).toFixed(2),
    capped: true,
  };
}
