#!/usr/bin/env node
// Replay Zero-Hero divergence on locally collected Dhan-format CSV files.
// This is deliberately fail-closed: missing paired index candles, expiry-day
// option data, or a complete option quote means no synthetic trade.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zeroHeroDivergencePick } from "../src/engines/zerohero.js";
import { netOptionPnl } from "../src/engines/costs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "strategy-lab", "data");
const OPTIONS = path.join(DATA, "options");
const OUT = path.join(ROOT, "strategy-lab", "reports");
const LOT_SIZE = 30; // BANKNIFTY default in AlphaEdge; live lot size remains broker-refreshed.
const SLIPPAGE = 0.005;
const START_MIN = 9 * 60 + 15;
const SIGNAL_MIN = 14 * 60;
const SQUAREOFF_MIN = 15 * 60 + 12; // platform safety cutoff, not the research 15:20 request

function csv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map(line => {
    const cells = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
}
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function ts(s) { return Date.parse(String(s).replace(" ", "T") + "Z"); }
function istMin(t) { const d = new Date(t); return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440; }
function dateFromName(name) { return name.match(/_(\d{4}-\d{2}-\d{2})\.csv$/)?.[1] || null; }

function filesFor(symbol, folder, kind) {
  return fs.readdirSync(folder).filter(name => name.startsWith(`${symbol}_${kind}_`) && name.endsWith(".csv"));
}
function loadCandles(symbol, date) {
  const name = `${symbol}_M5_${date}.csv`;
  const file = path.join(DATA, name);
  if (!fs.existsSync(file)) return [];
  return csv(fs.readFileSync(file, "utf8")).map(r => ({
    ts: ts(r.time), open: n(r.open), high: n(r.high), low: n(r.low), close: n(r.close),
  })).filter(r => Number.isFinite(r.ts) && r.high > 0 && r.low > 0 && r.close > 0);
}
function loadOptionRows(symbol, date) {
  const file = path.join(OPTIONS, `${symbol}_OPT_${date}.csv`);
  if (!fs.existsSync(file)) return [];
  return csv(fs.readFileSync(file, "utf8")).map(r => ({
    ts: ts(r.time), underlying: symbol, under_ltp: n(r.under_ltp), expiry: r.expiry,
    strike: n(r.strike), type: r.type, ltp: n(r.ltp), oi: n(r.oi), prev_oi: n(r.prev_oi),
    iv: n(r.iv), volume: n(r.volume), delta: n(r.delta), theta: n(r.theta), vega: n(r.vega),
    bid: n(r.bid), ask: n(r.ask),
  })).filter(r => Number.isFinite(r.ts) && r.strike > 0 && r.expiry && r.bid > 0 && r.ask > 0);
}
function chainAt(rows, atMin = SIGNAL_MIN) {
  const candidates = rows.filter(r => Math.abs(istMin(r.ts) - atMin) <= 5).sort((a, b) => a.ts - b.ts);
  const latestTs = candidates.at(-1)?.ts;
  if (!latestTs) return null;
  const snapshot = candidates.filter(r => r.ts === latestTs);
  const under = snapshot.find(r => r.under_ltp > 0)?.under_ltp;
  const expiry = snapshot.find(r => r.expiry)?.expiry;
  const strikes = {};
  for (const r of snapshot) {
    const key = String(r.strike);
    const leg = { strike: r.strike, ltp: r.ltp, bid: r.bid, ask: r.ask, oi: r.oi,
      prev_oi: r.prev_oi, volume: r.volume, delta: r.delta, iv: r.iv, theta: r.theta, vega: r.vega };
    if (!strikes[key]) strikes[key] = { strike: r.strike };
    strikes[key][r.type.toLowerCase()] = leg;
  }
  return { ok: true, underlying: "BANKNIFTY", under_ltp: under, expiry, isExpiryToday: false, strikes: Object.values(strikes) };
}
// Correct the date comparison without relying on local timezone formatting.
function chainAtForDate(rows, date) {
  const chain = chainAt(rows);
  if (chain) chain.isExpiryToday = chain.expiry === date;
  return chain;
}
function quoteAfter(rows, leg, fromTs) {
  return rows.filter(r => r.ts >= fromTs && r.strike === leg.strike && r.type === leg.optionType)
    .sort((a, b) => a.ts - b.ts);
}
function svgCurve(equity, file) {
  const w = 900, h = 300, pad = 24;
  const vals = [0, ...equity]; const lo = Math.min(...vals), hi = Math.max(...vals, lo + 1);
  const points = vals.map((v, i) => `${pad + i * (w - pad * 2) / Math.max(1, vals.length - 1)},${h - pad - (v - lo) * (h - pad * 2) / (hi - lo)}`).join(" ");
  fs.writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#10151f"/><polyline fill="none" stroke="#55d6a6" stroke-width="2" points="${points}"/><text x="24" y="20" fill="#fff" font-family="sans-serif">Zero-Hero divergence equity (₹)</text></svg>\n`);
}
function metrics(trades) {
  const net = trades.map(t => t.netRs); let equity = 0, peak = 0, mdd = 0, streak = 0, maxLosses = 0;
  const curve = [];
  for (const r of net) { equity += r; peak = Math.max(peak, equity); mdd = Math.max(mdd, peak - equity); streak = r < 0 ? streak + 1 : 0; maxLosses = Math.max(maxLosses, streak); curve.push(+equity.toFixed(2)); }
  const wins = trades.filter(t => t.netRs > 0).length;
  const gp = trades.filter(t => t.netRs > 0).reduce((s, t) => s + t.netRs, 0);
  const gl = -trades.filter(t => t.netRs < 0).reduce((s, t) => s + t.netRs, 0);
  const rValues = trades.map(t => t.rMultiple);
  const buyHold = trades.reduce((s, t) => s + t.buyHoldNetRs, 0);
  return { totalTrades: trades.length, wins, losses: trades.length - wins,
    winRatePct: trades.length ? +(wins / trades.length * 100).toFixed(2) : 0,
    profitFactor: gl ? +(gp / gl).toFixed(3) : (gp ? Infinity : 0),
    expectancyRs: trades.length ? +(net.reduce((s, x) => s + x, 0) / trades.length).toFixed(2) : 0,
    expectancyR: trades.length ? +(rValues.reduce((s, x) => s + x, 0) / trades.length).toFixed(3) : 0,
    netReturnRs: +equity.toFixed(2), buyAndHoldNetRs: +buyHold.toFixed(2), maxDrawdownRs: +mdd.toFixed(2), maxConsecutiveLosses: maxLosses, curve };
}

const dates = new Set(filesFor("BANKNIFTY", OPTIONS, "OPT").map(dateFromName));
const niftyDates = new Set(filesFor("NIFTY50", OPTIONS, "OPT").map(dateFromName));
const trades = [], skipped = {};
for (const date of [...dates].filter(Boolean).filter(d => niftyDates.has(d)).sort()) {
  const candlesA = loadCandles("NIFTY50", date), candlesB = loadCandles("BANKNIFTY", date);
  const rowsA = loadOptionRows("NIFTY50", date), rowsB = loadOptionRows("BANKNIFTY", date);
  if (!candlesA.length || !candlesB.length) { skipped.missingIndexCandles = (skipped.missingIndexCandles || 0) + 1; continue; }
  const chainB = chainAtForDate(rowsB, date);
  if (!chainB?.isExpiryToday) { skipped.notExpiryDay = (skipped.notExpiryDay || 0) + 1; continue; }
  const pick = zeroHeroDivergencePick({ candlesA, candlesB, chainB, istMin: SIGNAL_MIN });
  if (!pick.ok) { skipped[pick.reason] = (skipped[pick.reason] || 0) + 1; continue; }
  const entry = pick.leg.entry * (1 + SLIPPAGE), stop = entry * 0.5, target = entry + 10 * (entry - stop);
  const optionRows = quoteAfter(rowsB, pick.leg, pick.signal.ts);
  let exit = null, reason = "15:12 IST square-off";
  for (const q of optionRows) {
    const bid = q.bid * (1 - SLIPPAGE), m = istMin(q.ts);
    if (bid <= stop) { exit = bid; reason = "stop"; break; }
    if (bid >= target) { exit = bid; reason = "target"; break; }
    if (m >= SQUAREOFF_MIN) { exit = bid; break; }
  }
  if (!Number.isFinite(exit)) { skipped.noExitQuote = (skipped.noExitQuote || 0) + 1; continue; }
  const pnl = netOptionPnl({ entryPremium: entry, exitPremium: exit, qty: LOT_SIZE });
  const holdQuote = optionRows.filter(q => istMin(q.ts) <= SQUAREOFF_MIN).at(-1)?.bid;
  const holdPnl = Number.isFinite(holdQuote)
    ? netOptionPnl({ entryPremium: entry, exitPremium: holdQuote * (1 - SLIPPAGE), qty: LOT_SIZE }).netRs : pnl.netRs;
  trades.push({ date, direction: pick.direction, strike: pick.leg.strike, optionType: pick.leg.optionType,
    entryPremium: +entry.toFixed(2), exitPremium: +exit.toFixed(2), reason, ...pnl,
    buyHoldNetRs: holdPnl, rMultiple: +((exit - entry) / (entry - stop)).toFixed(3) });
}
const result = { generatedAt: new Date().toISOString(), assumptions: { slippagePct: SLIPPAGE * 100, lotSize: LOT_SIZE, squareOff: "15:12 IST", source: "local Dhan CSV" }, metrics: metrics(trades), skipped, trades };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "zerohero-divergence.json"), JSON.stringify(result, null, 2));
svgCurve(result.metrics.curve, path.join(OUT, "zerohero-divergence-equity.svg"));
console.log(JSON.stringify({ ...result.metrics, curve: undefined, skipped }, null, 2));
