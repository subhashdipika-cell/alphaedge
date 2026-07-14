// ─── DHAN DATA LAYER (via the local bridge) ───────────────────────────────────
// The browser can't call api.dhan.co directly (CORS), so everything routes
// through the local Python bridge (bridge.py on :5000). Fallbacks: allorigins
// CORS proxy (Dhan direct) and Yahoo Finance, so the app degrades gracefully
// when the bridge is down.

import {
  ASSETS, DHAN_INSTRUMENTS, DHAN_TF_INTERVAL,
  LOT_SIZE_DEFAULTS, APP_TO_DHAN, YAHOO_INDEX, DEFAULT_BRIDGE_URL,
} from "./constants.js";

// ─── Credentials ──────────────────────────────────────────────────────────────
export function getDhanToken() { return localStorage.getItem("alphaedge_dhan_token") || ""; }
export function setDhanToken(t) { localStorage.setItem("alphaedge_dhan_token", t.trim()); }
export function getDhanClientId() { return localStorage.getItem("alphaedge_dhan_client_id") || ""; }
export function setDhanClientId(c) { localStorage.setItem("alphaedge_dhan_client_id", c.trim()); }

// ─── Bridge URL ───────────────────────────────────────────────────────────────
// Local Dhan/India bridge URL (Settings may override; default is :5000).
export function getAnyBridgeUrl() {
  try {
    const s = JSON.parse(localStorage.getItem("alphaedge_settings") || "{}");
    // Fall back to the local bridge (always on :5000) so Dhan/Options features
    // work out-of-the-box when the bridge is running.
    return s?.broker?.bridgeUrl || s?.broker?.mt5?.demo?.bridgeUrl || DEFAULT_BRIDGE_URL;
  } catch { return DEFAULT_BRIDGE_URL; }
}
export function bridgeBaseUrl() {
  return (getAnyBridgeUrl() || "").replace(/\/signal\/?$/, "");
}

// ─── Candles ──────────────────────────────────────────────────────────────────
// Last Dhan-fetch error, surfaced to the Backtest UI for clear diagnostics.
let dhanLastError = "";
export function getDhanLastError() { return dhanLastError; }

// Fetch historical candles from Dhan for backtesting.
// PRIMARY: route through the local bridge (Python, no CORS) — reliable, and
// it uses the AUTO-REFRESHED config token (the browser token may be stale).
// FALLBACK: a public CORS proxy (allorigins) if the bridge isn't running.
// `tf` is one of: "1m","5m","15m","1H","1D". Returns [{time,...}] or null.
export async function fetchDhanHistorical(instrumentKey, tf, fromDate, toDate) {
  const token  = getDhanToken();
  const client = getDhanClientId();
  const meta   = DHAN_INSTRUMENTS[instrumentKey];
  if (!meta) return null;        // bridge supplies the token; browser token optional
  dhanLastError = "";

  const toRow = (t, o, h, l, c, v) => ({
    time: new Date(Number(t) * 1000).toISOString(),
    open: Number(o), high: Number(h), low: Number(l), close: Number(c),
    volume: Number(v || 0),
  });

  // ── 1) Local bridge (preferred — uses the fresh auto-refreshed token) ─────
  const base = bridgeBaseUrl();
  if (base) {
    try {
      const r = await fetch(base + "/dhan/historical", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument: instrumentKey, tf, fromDate, toDate, token, clientId: client }),
        signal: AbortSignal.timeout(20000),
      });
      const d = await r.json().catch(()=>null);
      if (r.ok && d?.ok && Array.isArray(d.candles) && d.candles.length) {
        return d.candles.map(k => toRow(k.time, k.open, k.high, k.low, k.close, k.volume));
      }
      if (d?.error) dhanLastError = d.error;   // surface the bridge's real reason
    } catch { dhanLastError = "bridge unreachable — is bridge.py running?"; }
  } else {
    dhanLastError = "no bridge URL set in Settings → Local Data Bridge";
  }

  // ── 2) Public CORS proxy (fallback) ──────────────────────────────────────
  const isDaily = tf === "1D";
  const endpoint = isDaily
    ? "https://api.dhan.co/v2/charts/historical"
    : "https://api.dhan.co/v2/charts/intraday";
  const body = isDaily
    ? { securityId: meta.securityId, exchangeSegment: meta.segment, instrument: meta.instrument,
        expiryCode: 0, oi: false, dhanClientId: client, fromDate, toDate }
    : { securityId: meta.securityId, exchangeSegment: meta.segment, instrument: meta.instrument,
        interval: Number(DHAN_TF_INTERVAL[tf] || "5"), oi: false, dhanClientId: client, fromDate, toDate };

  try {
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(endpoint)}`;
    const resp = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "access-token": token,
        ...(client ? { "client-id": client } : {}),
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const raw = await resp.json();
    const d = raw?.data || raw;
    const o = d?.open, h = d?.high, l = d?.low, c = d?.close, v = d?.volume, t = d?.timestamp;
    if (!Array.isArray(o) || !Array.isArray(t) || !o.length) return null;
    const n = Math.min(o.length, h.length, l.length, c.length, t.length);
    const out = [];
    for (let i = 0; i < n; i++) out.push(toRow(t[i], o[i], h[i], l[i], c[i], Array.isArray(v) ? v[i] : 0));
    return out;
  } catch { return null; }
}

// Real Dhan candles for a homepage chart, in the app's candle shape.
// Pulls intraday history (last ~5 days) via the bridge-backed historical path.
export async function fetchDhanChartCandles(instrumentKey, tf = "5m") {
  const today = new Date();
  const from  = new Date(today.getTime() - 5 * 86400000);
  const fmt   = d => d.toISOString().slice(0, 10);
  const rows  = await fetchDhanHistorical(instrumentKey, tf, fmt(from), fmt(today));
  if (!rows || rows.length < 10) return null;
  return rows.map(r => ({
    open: r.open, high: r.high, low: r.low, close: r.close,
    bull: r.close >= r.open, vol: r.volume || 0, ts: new Date(r.time).getTime(),
  }));
}

// ─── Quotes ───────────────────────────────────────────────────────────────────
// Live index quotes (Dhan, server-side) from the local bridge. Returns {} if
// the bridge isn't running — callers then use web sources.
export async function fetchBridgePrices() {
  const base = bridgeBaseUrl();
  if (!base) return {};
  try {
    const r = await fetch(base + "/price", { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return {};
    const d = await r.json();
    return (d && typeof d === "object" && !d.error) ? d : {};
  } catch { return {}; }
}

// Last-resort live Nifty quote when the bridge isn't running. The primary
// source is the bridge /price (Dhan, server-side); this allorigins proxy path
// is flaky and only a fallback.
export async function fetchDhanNifty() {
  const token = getDhanToken();
  if (!token) return null;
  try {
    // Use allorigins proxy to bypass CORS
    const body    = JSON.stringify({ IDX_I: ["13"] });
    const encoded = encodeURIComponent("https://api.dhan.co/v2/marketfeed/quote");
    const proxyUrl = `https://api.allorigins.win/raw?url=${encoded}`;
    const resp = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "access-token":  token,
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const q = data?.data?.IDX_I?.["13"]
           || data?.IDX_I?.["13"]
           || data?.["13"];
    if (!q) return null;
    const ltp  = parseFloat(q.ltp || q.LTP || q.last_price || 0);
    const prev = parseFloat(q.close || q.Close || q.prev_close || q.prevClose || 0);
    if (!ltp) return null;
    return { price: ltp, change: prev ? ((ltp-prev)/prev)*100 : 0, source:"Dhan" };
  } catch { return null; }
}

// Bridge-first real prices for every index, with Dhan-direct + Yahoo fallbacks.
export async function fetchRealPrices() {
  const result = {};

  // ── Primary: Dhan index quotes via the local bridge ────────────────────────
  const bp = await fetchBridgePrices();
  ASSETS.forEach(a => { if (bp[a.id]) result[a.id] = bp[a.id]; });

  // ── Nifty fallback: Dhan direct via CORS proxy (browser token) ─────────────
  if (!result.NIFTY50) {
    const n = await fetchDhanNifty();
    if (n) result.NIFTY50 = n;
  }

  // ── Last resort per index: Yahoo Finance ───────────────────────────────────
  for (const a of ASSETS) {
    if (result[a.id]) continue;
    const sym = YAHOO_INDEX[a.id];
    if (!sym) continue;
    try {
      const resp = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=1d`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!resp.ok) continue;
      const meta = (await resp.json())?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        const cur  = parseFloat(meta.regularMarketPrice);
        const prev = parseFloat(meta.chartPreviousClose || meta.regularMarketPreviousClose || cur);
        result[a.id] = { price:cur, change:prev?((cur-prev)/prev)*100:0, source:"Yahoo" };
      }
    } catch {}
  }

  return result;
}

// ─── Option chain / VIX ───────────────────────────────────────────────────────
// Live option chain (ATM±range, greeks/IV) via the bridge. Falls back to the
// last collected snapshot off-hours (the bridge handles that). Returns the
// bridge response or {ok:false,error}.
export async function fetchOptionChain(underlying, range = 6, expiry = null) {
  const base = bridgeBaseUrl();
  if (!base) return { ok:false, error:"Start the local bridge — Dhan calls route through it." };
  try {
    const r = await fetch(base + "/dhan/optionchain", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ underlying, range, expiry, token:getDhanToken(), clientId:getDhanClientId() }),
      signal: AbortSignal.timeout(20000),
    });
    return await r.json();
  } catch (e) { return { ok:false, error:String(e) }; }
}

// Latest options-premium score replay (scripts/replay.mjs output) for R&D.
// Returns {ok, summary, trades[]} or {ok:false, error}.
export async function fetchReplay() {
  const base = bridgeBaseUrl();
  if (!base) return { ok: false, error: "no bridge URL" };
  try {
    const r = await fetch(base + "/rd/replay", { signal: AbortSignal.timeout(10000) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

// India VIX (live via Dhan, or a collected-ATM-IV percentile proxy off-hours).
// Returns the bridge payload {ok, source:"dhan"|"proxy", vix?, proxy} or null.
export async function fetchVix() {
  const base = bridgeBaseUrl();
  if (!base) return null;
  try {
    const r = await fetch(base + "/dhan/vix", { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Trending-OI time series (bucketed per-strike OI/LTP/IV/volume) for one index,
// from today's collected chain CSV (stale-csv off-hours). The oi.js engine
// derives velocity/acceleration/walls/centroids/matrix/smart-money from this.
// Returns the bridge payload {ok, times[], underLtp[], strikes[...]} or {ok:false}.
export async function fetchOiTrend(underlying, bucketMin = 5) {
  const base = bridgeBaseUrl();
  if (!base) return { ok: false, error: "no bridge URL" };
  try {
    const r = await fetch(base + "/dhan/oitrend", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ underlying, bucketMin }),
      signal: AbortSignal.timeout(15000),
    });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

// Minute-level premium path for one option leg — the backbone of paper-trade
// SL/target-touch resolution. Returns {ok, series:[{t,ltp,bid,ask,iv,oi,delta,theta}], high, low, last}.
export async function fetchPremiumSeries(underlying, strike, type, { expiry = null, sinceTs = null } = {}) {
  const base = bridgeBaseUrl();
  if (!base) return { ok: false, error: "no bridge URL" };
  try {
    const r = await fetch(base + "/dhan/premium", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ underlying, strike, type, expiry, sinceTs }),
      signal: AbortSignal.timeout(15000),
    });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

// Candles in the app's shape for a timeframe over `days` of history — wide
// enough for the score engine's 50-bar trend/ADX reads (1H needs ~10 days).
async function scoreCandles(underlying, tf, days) {
  const today = new Date();
  const from = new Date(today.getTime() - days * 86400000);
  const fmt = d => d.toISOString().slice(0, 10);
  const rows = await fetchDhanHistorical(underlying, tf, fmt(from), fmt(today)).catch(() => null);
  if (!rows || !rows.length) return null;
  return rows.map(r => ({ open: r.open, high: r.high, low: r.low, close: r.close,
    bull: r.close >= r.open, vol: r.volume || 0, ts: new Date(r.time).getTime() }));
}

// One-shot pull of everything the Option Buying Score engine needs for one
// underlying: option chain, OI trend, VIX, and 5m/15m/1H candles. Returns
// { chain, oiTrend, vix, candles5m, candles15m, candles1H } (candles in app shape).
export async function fetchScoreInputs(underlying, range = 8, expiry = null) {
  const [chain, oiTrend, vix, candles5m, candles15m, candles1H] = await Promise.all([
    fetchOptionChain(underlying, range, expiry),
    fetchOiTrend(underlying, 5),
    fetchVix(),
    scoreCandles(underlying, "5m", 5),
    scoreCandles(underlying, "15m", 10),
    scoreCandles(underlying, "1H", 12),
  ]);
  return { chain, oiTrend, vix, candles5m, candles15m, candles1H };
}

// ─── Lot sizes ────────────────────────────────────────────────────────────────
export function getStoredLots() {
  try { return JSON.parse(localStorage.getItem("alphaedge_lot_sizes") || "{}"); }
  catch { return {}; }
}
// Lot size for an app symbol (NIFTY50/BANKNIFTY/SENSEX/…): live value if fetched,
// else the last-known default.
export function getLotSize(appSym) {
  const stored = getStoredLots();
  const dhanKey = APP_TO_DHAN[appSym] || appSym;
  const live = Number(stored[dhanKey]);
  return live > 0 ? live : (LOT_SIZE_DEFAULTS[appSym] || 50);
}
export function getLotsUpdatedAt() {
  return localStorage.getItem("alphaedge_lot_sizes_updated") || "";
}

// Pull current index lot sizes from Dhan's scrip master via the bridge and cache
// them. Returns {ok, lots, updated} | {ok:false, error}.
export async function refreshLotSizes() {
  const base = bridgeBaseUrl();
  if (!base) return { ok: false, error: "No bridge URL set (Settings → Local Data Bridge)." };
  try {
    const r = await fetch(`${base}/dhan/lotsizes`, { signal: AbortSignal.timeout(70000) });
    const d = await r.json();
    if (d && d.ok && d.lots && Object.keys(d.lots).length) {
      localStorage.setItem("alphaedge_lot_sizes", JSON.stringify(d.lots));
      localStorage.setItem("alphaedge_lot_sizes_updated", d.updated || new Date().toISOString());
      return { ok: true, lots: d.lots, updated: d.updated };
    }
    return { ok: false, error: d?.error || "Bridge returned no lot sizes." };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ─── NSE holiday info ─────────────────────────────────────────────────────────
// Fetched once per session from the bridge, which refreshes it daily from
// Dhan's public holiday calendar. Read synchronously via getNseHolidayInfo.
let NSE_HOLIDAY_INFO = null;
export function getNseHolidayInfo() { return NSE_HOLIDAY_INFO; }
export async function fetchNseHolidayInfo() {
  try {
    const base = bridgeBaseUrl();
    if (!base) return null;
    const r = await fetch(`${base}/market/holiday`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    if (d && d.ok) NSE_HOLIDAY_INFO = d;
    return NSE_HOLIDAY_INFO;
  } catch { return NSE_HOLIDAY_INFO; }
}
