// ─── HEADLESS AUTONOMOUS PAPER-TRADE SCANNER ──────────────────────────────────
// A start-and-forget service (like SMT / IntelliTrade) that runs the SAME score
// engines the app uses — no browser required. Every cycle, during market hours,
// it scores all four indices, opens a paper trade on every TRADE-grade setup,
// and resolves open trades against the option-premium path. State is a plain
// JSON file the bridge serves (GET /paper/auto) so the app can show the record.
//
// One engine implementation, reused: this shares src/engines/* + src/data/*
// with the app and scripts/replay.mjs (no Python port, no divergence).
//
// Usage:
//   node scripts/scanner.mjs                       # loop, 5-min cycle, all indices
//   node scripts/scanner.mjs --interval 180        # 3-min cycle
//   node scripts/scanner.mjs --capital 500000 --risk 1
//   node scripts/scanner.mjs --once                # one cycle then exit (smoke test)
//   BRIDGE_URL=http://127.0.0.1:5000 node scripts/scanner.mjs
//
// Paper trading only. It places NO broker orders — it writes a JSON track record.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ── localStorage shim (settings/weights read it; none at import time) ──────────
// Must exist before any engine/settings function runs. Injecting a BRIDGE_URL
// here lets the shared bridge.js fetchers target a non-default bridge.
globalThis.localStorage = {
  _s: {}, getItem(k) { return k in this._s ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; },
};
if (process.env.BRIDGE_URL) {
  globalThis.localStorage.setItem("alphaedge_settings", JSON.stringify({ broker: { bridgeUrl: process.env.BRIDGE_URL } }));
}

const { ASSETS } = await import("../src/data/constants.js");
const { fetchScoreInputs, fetchPremiumSeries, bridgeBaseUrl } = await import("../src/data/bridge.js");
const { analyzeOiTrend } = await import("../src/engines/oi.js");
const { scoreOption } = await import("../src/engines/score.js");
const { resolvePaperTrade, entryTsToUtc } = await import("../src/engines/resolve.js");
const { getMoneyMgt, getRiskPolicy } = await import("../src/state/settings.js");
const { eventProximity } = await import("../src/data/events.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STORE_DIR = path.join(ROOT, "strategy-lab", "paper");
const STORE = path.join(STORE_DIR, "auto_paper_trades.json");

// ── args ──
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, def) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const CFG = {
  intervalMs: Math.max(30, Number(opt("interval", 300))) * 1000,  // cycle seconds → ms
  capital: Number(opt("capital", getMoneyMgt().capital || 400000)),
  risk: Number(opt("risk", getRiskPolicy().maxRiskPct || 1)),
  range: Number(opt("range", 8)),
  once: flag("once"),
  underlyings: (opt("underlying", "") ? [opt("underlying", "")] : ASSETS.map(a => a.id)),
};
const ENTER_FROM = 9 * 60 + 20;   // no new entries before 09:20 IST (skip the open auction chop)
const ENTER_TO   = 15 * 60 + 15;  // no new entries after 15:15 IST (matches the 15:15 square-off)

// ── IST helpers (same idiom as src/lib/ist.js — correct on any machine zone) ──
function istDate() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 330) * 60000); }
function istDateStr(d = istDate()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function istMinutes(d = istDate()) { return d.getHours() * 60 + d.getMinutes(); }
function istClock(d = istDate()) { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
const inr = (v) => `${v >= 0 ? "+" : "−"}₹${Math.abs(Math.round(Number(v) || 0)).toLocaleString("en-IN")}`;
const log = (...a) => console.log(`[${istClock()} IST]`, ...a);

// ── store ──
function loadStore() {
  try {
    if (fs.existsSync(STORE)) {
      const d = JSON.parse(fs.readFileSync(STORE, "utf8"));
      if (Array.isArray(d.trades)) return d;
    }
  } catch (e) { console.warn("  store read failed, starting fresh:", e.message); }
  return { version: 1, startedAt: new Date().toISOString(), trades: [] };
}
function summarize(trades) {
  const done = trades.filter(t => t.outcome === "win" || t.outcome === "loss");
  const wins = done.filter(t => t.outcome === "win").length;
  const net = done.reduce((s, t) => s + (Number(t.pnlRs) || 0), 0);
  return {
    total: trades.length, open: trades.filter(t => (t.outcome || "pending") === "pending").length,
    resolved: done.length, wins, losses: done.length - wins,
    winRate: done.length ? +(wins / done.length * 100).toFixed(1) : 0, netRs: +net.toFixed(2),
  };
}
function saveStore(store) {
  store.updatedAt = new Date().toISOString();
  store.summary = summarize(store.trades);
  store.config = { capital: CFG.capital, riskPct: CFG.risk, source: "headless-scanner" };
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
  return store;
}

// ── daily NSE trading-day gate (holidays) — cached per IST date ──
let _tradingDay = { date: null, ok: true };
async function isTradingDay() {
  const today = istDateStr();
  if (_tradingDay.date === today) return _tradingDay.ok;
  let ok = true;   // fail-open: if the holiday endpoint is down, assume a trading day
  try {
    const r = await fetch(`${bridgeBaseUrl()}/market/holiday`, { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    if (d && d.ok && typeof d.tradingDay === "boolean") ok = d.tradingDay;
  } catch { /* keep fail-open */ }
  _tradingDay = { date: today, ok };
  return ok;
}

// ── resolve open trades against the premium path ──
async function resolveOpen(store) {
  const open = store.trades.filter(t => (t.outcome || "pending") === "pending");
  let changed = 0;
  for (const t of open) {
    // Past expiry with no touch → settle as expired (excluded from win-rate).
    if (t.expiry && istDateStr() > t.expiry) {
      Object.assign(t, { outcome: "expired", resolvedBy: "auto-expiry", resolvedAt: Date.now() });
      changed++; log(`resolved ${t.assetId} ${t.strike}${t.direction} → EXPIRED`); continue;
    }
    try {
      const r = await fetchPremiumSeries(t.assetId, t.strike, t.direction, {
        expiry: t.expiry, sinceTs: entryTsToUtc(t.entryTs || t.timestamp),
      });
      if (!r?.ok || !Array.isArray(r.series) || !r.series.length) continue;
      const res = resolvePaperTrade({
        entryTs: t.entryTs || t.timestamp, entryPremium: t.optionPremium, slPremium: t.slPremium, tgtPremium: t.tgtPremium,
        lots: t.lots, lotSize: t.lotSize, maxHoldMin: t.maxHoldMin, squareOff: t.squareOff !== false,
        trailStop: t.trailStop === true, trailArmPts: t.trailArmPts, trailPts: t.trailPts,
        direction: t.direction, expiry: t.expiry, underlying: t.assetId,
      }, r.series);
      if (res) {
        Object.assign(t, res);
        changed++;
        log(`resolved ${t.assetId} ${t.strike}${t.direction} → ${String(res.outcome).toUpperCase()} ${inr(res.pnlRs)} (${res.exitReason})`);
      }
    } catch { /* premium offline — retry next cycle */ }
  }
  return changed;
}

// ── score one underlying and, if TRADE-grade, open a paper trade ──
async function scanOne(store, underlying) {
  // One open position per underlying at a time (no stacking).
  if (store.trades.some(t => t.assetId === underlying && (t.outcome || "pending") === "pending")) {
    return { underlying, note: "skip(open)" };
  }
  const inputs = await fetchScoreInputs(underlying, CFG.range, null);
  if (!inputs.chain?.ok && !inputs.chain?.strikes?.length) return { underlying, note: "no-chain" };
  const oi = inputs.oiTrend ? analyzeOiTrend(inputs.oiTrend) : { ok: false };
  const r = scoreOption({
    underlying,
    candles5m: inputs.candles5m, candles15m: inputs.candles15m, candles1H: inputs.candles1H,
    chain: inputs.chain, oi, vix: inputs.vix,
    history: store.trades, events: eventProximity(underlying),
    mm: { ...getMoneyMgt(), capital: CFG.capital }, riskPct: CFG.risk,
  });

  if (r.verdict !== "TRADE") {
    const tag = r.gates?.length ? `gate:${r.gates[0].slice(0, 24)}` : `${r.verdict}(${r.score})`;
    return { underlying, note: tag };
  }
  // TRADE-grade but the plan can't fit even one lot inside the risk budget
  // (same affordability gate as the app's "Paper trade this" button). Surface
  // it clearly rather than silently skipping — the user can raise --capital/--risk.
  if (!r.strike || !r.plan || !(r.plan.lots >= 1)) {
    log(`${underlying} TRADE(${r.score}) ${r.strike?.strike || ""}${r.direction} — 0 lots at ₹${CFG.capital.toLocaleString("en-IN")}/${CFG.risk}% risk (unaffordable, skipped)`);
    return { underlying, note: `TRADE(${r.score})·0-lots` };
  }

  const now = Date.now();
  const label = ASSETS.find(a => a.id === underlying)?.label || underlying;
  const record = {
    id: `AUTO-${underlying}-${now}`,
    timestamp: now, entryTs: now,
    asset: label, assetId: underlying, timeframe: "options",
    nature: r.style?.style === "SCALP" ? "Scalping" : r.style?.style === "SWING" ? "Swing" : "Intraday",
    bias: r.direction === "CE" ? "BULLISH" : "BEARISH",
    confidence: r.score,
    setup: `${r.style?.label || "Score"} · ${r.strike.strike}${r.direction} · ${r.regime.label}`,
    // premium-based fields (isOptionPaperTrade + resolver key on these)
    entry: r.strike.ltp, optionPremium: r.strike.ltp,
    slPremium: r.plan.slPrice, tgtPremium: r.plan.tgtPrice,
    stopLoss: r.plan.slPrice, takeProfit1: r.plan.tgtPrice,
    lots: r.plan.lots, lotSize: r.plan.lotUnits,
    maxHoldMin: r.plan.maxHoldMin, squareOff: r.plan.squareOff !== false,
    trailStop: r.plan.trailStop === true, trailArmPts: r.plan.trailArmPts, trailPts: r.plan.trailPts,
    riskReward: r.plan.rr, expiry: r.strike.expiry, strike: r.strike.strike, direction: r.direction,
    summary: r.report.map(l => `${l.k}: ${l.v}`).join(" · "),
    scoreFactors: Object.fromEntries(Object.entries(r.factors).map(([k, f]) => [k, f.score01])),
    regime: r.regime.regime, style: r.style?.style,
    outcome: "pending", source: "Auto-Scan", tradeType: "Paper",
  };
  store.trades.push(record);
  log(`OPENED ${underlying} ${r.strike.strike}${r.direction} @ ₹${r.strike.ltp} · ${r.style?.style} · score ${r.score} · ${r.plan.lots}×${r.plan.lotUnits} lots · SL ₹${r.plan.slPrice} TGT ₹${r.plan.tgtPrice}`);
  return { underlying, note: `TRADE(${r.score})→${r.strike.strike}${r.direction}` };
}

// ── one cycle: resolve, then (if in-session) scan for entries ──
async function tick() {
  const store = loadStore();
  const resolved = await resolveOpen(store);

  const mins = istMinutes();
  const inSession = mins >= ENTER_FROM && mins <= ENTER_TO;
  const trading = inSession ? await isTradingDay() : false;

  if (!trading) {
    saveStore(store);
    const why = mins < ENTER_FROM ? "pre-open" : mins > ENTER_TO ? "past 15:00 entry cutoff" : "not a trading day";
    log(`idle (${why}) · resolved ${resolved} · open ${store.summary.open}`);
    return store.summary;
  }

  const notes = [];
  for (const u of CFG.underlyings) {
    try { notes.push((await scanOne(store, u)).note); }
    catch (e) { notes.push(`err:${e.message?.slice(0, 20)}`); }
  }
  saveStore(store);
  const s = store.summary;
  log(`scan ${CFG.underlyings.map((u, i) => `${u}:${notes[i]}`).join(" · ")} | open ${s.open} · resolved ${s.resolved} (${s.winRate}% WR, ${inr(s.netRs)})`);
  return s;
}

async function main() {
  const base = bridgeBaseUrl();
  console.log("─".repeat(72));
  console.log(" AlphaEdge — Headless Autonomous Paper-Trade Scanner");
  console.log(` bridge   ${base}`);
  console.log(` indices  ${CFG.underlyings.join(", ")}`);
  console.log(` cycle    ${CFG.intervalMs / 1000}s · capital ₹${CFG.capital.toLocaleString("en-IN")} · risk ${CFG.risk}%/trade`);
  console.log(` store    ${STORE}`);
  console.log(" PAPER ONLY — no broker orders. Entries 09:20–15:00 IST; resolves to 15:15 square-off.");
  console.log("─".repeat(72));

  // Fail loudly if the bridge isn't up — the scanner is useless without it.
  try {
    const r = await fetch(`${base}/market/holiday`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`bridge returned ${r.status}`);
  } catch (e) {
    console.error(`\n✖ Cannot reach the bridge at ${base} — start it first (mt5-bridge/run.bat).\n  ${e.message}`);
    if (CFG.once) process.exit(1);
    console.error("  Will keep retrying every cycle…");
  }

  await tick();
  if (CFG.once) { log("once — exiting."); return; }

  const iv = setInterval(() => { tick().catch(e => console.error("tick error:", e.message)); }, CFG.intervalMs);
  const stop = () => { clearInterval(iv); log("stopped (state saved)."); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch(e => { console.error(e); process.exit(1); });
