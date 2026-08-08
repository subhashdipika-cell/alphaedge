#!/usr/bin/env node
// Research adapter for Dhan /charts/rollingoption output.
// This is an OHLC proxy, not an execution-quality bid/ask backtest: the API
// supplies rolling ATM-relative strikes and no historical bid/ask or Greeks.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { netOptionPnl } from "../src/engines/costs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "strategy-lab", "data");
const ROLLING = path.join(DATA, "expired_options");
const OPTIONS = path.join(DATA, "options");
const OUT = path.join(ROOT, "strategy-lab", "reports", "zerohero-rolling.json");
const LOT_SIZE = 30, SLIPPAGE = 0.005, SQUAREOFF = 15 * 60 + 12;
const csv = text => { const ls = text.trim().split(/\r?\n/).filter(Boolean); if (!ls.length) return []; const h = ls[0].split(","); return ls.slice(1).map(x => Object.fromEntries(h.map((k, i) => [k, x.split(",")[i] ?? ""]))); };
const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
const stamp = s => Date.parse(String(s).replace(" ", "T") + "Z");
const istMin = t => { const d = new Date(t); return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440; };
const day = t => new Date(t).toISOString().slice(0, 10);

function loadRolling() {
  if (!fs.existsSync(ROLLING)) return [];
  const out = [];
  for (const file of fs.readdirSync(ROLLING).filter(f => f.endsWith(".csv"))) {
    out.push(...csv(fs.readFileSync(path.join(ROLLING, file), "utf8")).map(r => ({
      ...r, ts: stamp(r.time), spot: num(r.spot), strike: num(r.strike), close: num(r.close),
      high: num(r.high), low: num(r.low), volume: num(r.volume), oi: num(r.oi),
    })).filter(r => Number.isFinite(r.ts) && r.strike > 0 && r.close > 0));
  }
  return out;
}
function loadIndex(symbol, date) {
  const file = path.join(DATA, `${symbol}_M5_${date}.csv`);
  if (!fs.existsSync(file)) return [];
  return csv(fs.readFileSync(file, "utf8")).map(r => ({ ts: stamp(r.time), high: num(r.high), low: num(r.low), close: num(r.close) }))
    .filter(r => Number.isFinite(r.ts) && r.high > 0 && r.low > 0 && r.close > 0);
}
function expiryDates() {
  const dates = new Set();
  for (const file of fs.existsSync(OPTIONS) ? fs.readdirSync(OPTIONS).filter(f => f.startsWith("BANKNIFTY_OPT_")) : []) {
    const date = file.match(/_(\d{4}-\d{2}-\d{2})\.csv$/)?.[1];
    if (!date) continue;
    for (const r of csv(fs.readFileSync(path.join(OPTIONS, file), "utf8"))) if (r.expiry === date) dates.add(date);
  }
  return [...dates].sort();
}
function reference(candles, signalMin) {
  const rows = candles.filter(c => { const m = istMin(c.ts); return m >= 555 && m < signalMin; });
  return rows.length >= 30 ? { high: Math.max(...rows.map(r => r.high)), low: Math.min(...rows.map(r => r.low)) } : null;
}
function signal(a, b) {
  const sa = a.filter(c => istMin(c.ts) >= 835 && istMin(c.ts) <= 840).at(-1);
  const sb = b.filter(c => istMin(c.ts) >= 835 && istMin(c.ts) <= 840).at(-1);
  const ra = sa && reference(a, istMin(sa.ts)), rb = sb && reference(b, istMin(sb.ts));
  if (!sa || !sb || !ra || !rb) return null;
  const aUp = sa.close > ra.high, aDown = sa.close < ra.low, bUp = sb.close > rb.high, bDown = sb.close < rb.low;
  if ((aUp && bUp) || (aDown && bDown)) return null;
  const type = aUp && sb.close <= rb.high ? "CE" : aDown && sb.close >= rb.low ? "PE" : null;
  return type ? { type, ts: sa.ts, rangeA: ra, rangeB: rb } : null;
}
function metrics(trades) {
  let equity = 0, peak = 0, dd = 0; const vals = [];
  for (const t of trades) { equity += t.netRs; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity); vals.push(equity); }
  const wins = trades.filter(t => t.netRs > 0), losses = trades.filter(t => t.netRs < 0);
  const gp = wins.reduce((s, t) => s + t.netRs, 0), gl = -losses.reduce((s, t) => s + t.netRs, 0);
  return { totalTrades: trades.length, wins: wins.length, losses: losses.length,
    winRatePct: trades.length ? +(wins.length / trades.length * 100).toFixed(2) : 0,
    profitFactor: gl ? +(gp / gl).toFixed(3) : gp ? Infinity : 0,
    expectancyRs: trades.length ? +(equity / trades.length).toFixed(2) : 0,
    netReturnRs: +equity.toFixed(2), maxDrawdownRs: +dd.toFixed(2), equity: vals };
}

const rows = loadRolling();
const dates = expiryDates();
const trades = [], skipped = {};
for (const date of dates) {
  const a = loadIndex("NIFTY50", date), b = loadIndex("BANKNIFTY", date), s = signal(a, b);
  if (!s) { skipped.noDivergenceOrIndexData = (skipped.noDivergenceOrIndexData || 0) + 1; continue; }
  const candidates = rows.filter(r => r.underlying === "BANKNIFTY" && day(r.ts) === date && r.type === s.type && r.relative_strike === "ATM" && Math.abs(istMin(r.ts) - 840) <= 5).sort((x, y) => x.ts - y.ts);
  const entryQuote = candidates.at(-1);
  if (!entryQuote) { skipped.noAtmQuote = (skipped.noAtmQuote || 0) + 1; continue; }
  const fixed = rows.filter(r => r.underlying === "BANKNIFTY" && r.type === s.type && day(r.ts) === date && r.strike === entryQuote.strike && r.ts >= entryQuote.ts && istMin(r.ts) <= SQUAREOFF).sort((x, y) => x.ts - y.ts);
  if (!fixed.length) { skipped.noFixedStrikePath = (skipped.noFixedStrikePath || 0) + 1; continue; }
  const entry = entryQuote.close * (1 + SLIPPAGE), stop = entry * 0.5, target = entry + 10 * (entry - stop);
  let exit = fixed.at(-1).close * (1 - SLIPPAGE), reason = "15:12 IST square-off";
  for (const q of fixed) { const px = q.close * (1 - SLIPPAGE); if (px <= stop) { exit = px; reason = "stop"; break; } if (px >= target) { exit = px; reason = "target"; break; } }
  const pnl = netOptionPnl({ entryPremium: entry, exitPremium: exit, qty: LOT_SIZE });
  trades.push({ date, type: s.type, strike: entryQuote.strike, entryPremium: +entry.toFixed(2), exitPremium: +exit.toFixed(2), reason, ...pnl, proxy: true });
}
const result = { generatedAt: new Date().toISOString(), source: "Dhan /charts/rollingoption", proxyWarning: "Rolling ATM-relative OHLC; no historical bid/ask or Greeks; expiry dates come from local live-chain archive.", assumptions: { lotSize: LOT_SIZE, slippagePct: SLIPPAGE * 100, squareOff: "15:12 IST" }, expiryDaysConsidered: dates.length, metrics: metrics(trades), skipped, trades };
fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, trades: undefined }, null, 2));
