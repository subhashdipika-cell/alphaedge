// ─── OPTIONS-PREMIUM SCORE REPLAY (out-of-sample R&D backtest) ─────────────────
// Replays the SAME score/OI/style/resolve engines over the collected option-chain
// CSVs (strategy-lab/data/options/*.csv), day by day, producing a paper-trade
// track record with full factor breakdowns. This is the out-of-sample validation
// for the score engine — one engine implementation, reused (no Python port).
//
// Usage:
//   node scripts/replay.mjs                         # all underlyings, all days
//   node scripts/replay.mjs --underlying NIFTY50    # one underlying
//   node scripts/replay.mjs --from 2026-06-23 --to 2026-07-14
//   node scripts/replay.mjs --step 5 --risk 1 --capital 400000
//
// Writes strategy-lab/results/replay_{from}_{to}.json for the R&D page (served
// by the bridge GET /rd/replay).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { analyzeOiTrend } from "../src/engines/oi.js";
import { scoreOption } from "../src/engines/score.js";
import { resolvePaperTrade } from "../src/engines/resolve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OPT_DIR = path.join(ROOT, "strategy-lab", "data", "options");
const OUT_DIR = path.join(ROOT, "strategy-lab", "results");
const BRIDGE = process.env.BRIDGE_URL || "http://127.0.0.1:5000";

// Real underlying candles from the bridge (proper OHLC → real ATR/ADX/regime).
// Dhan intraday historical is size-limited per request, so callers fetch short
// windows. `time` comes back in Unix SECONDS.
async function fetchCandles(underlying, tf, fromDate, toDate) {
  try {
    const r = await fetch(`${BRIDGE}/dhan/historical`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instrument: underlying, tf, fromDate, toDate }),
    });
    const d = await r.json();
    if (!d?.ok || !Array.isArray(d.candles)) return [];
    return d.candles.map(k => ({ ts: Number(k.time) * 1000, open: +k.open, high: +k.high, low: +k.low, close: +k.close, bull: +k.close >= +k.open, vol: +k.volume || 0 }))
      .filter(c => Number.isFinite(c.ts)).sort((a, b) => a.ts - b.ts);
  } catch { return []; }
}
const sliceTo = (arr, ts) => arr.filter(c => c.ts <= ts);
const ymd = (d) => d.toISOString().slice(0, 10);

// Per-(underlying, date) candle history: a ~14-day window ENDING on the replay
// day, so prior days are real history and there's no intraday lookahead.
const _candleCache = new Map();
async function candlesForDay(underlying, date) {
  const key = `${underlying}_${date}`;
  if (_candleCache.has(key)) return _candleCache.get(key);
  const to = date;
  const from = ymd(new Date(new Date(date).getTime() - 14 * 86400000));
  const [c5, c15, c1h] = await Promise.all([
    fetchCandles(underlying, "5m", from, to), fetchCandles(underlying, "15m", from, to), fetchCandles(underlying, "1H", from, to),
  ]);
  const hist = { c5, c15, c1h };
  _candleCache.set(key, hist);
  return hist;
}

// Minimal localStorage shim (score reads guardrail/weight config).
globalThis.localStorage = { _s: {}, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };

// ── args ──
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const CFG = {
  underlying: opt("underlying", null),
  from: opt("from", null), to: opt("to", null),
  step: Number(opt("step", 5)),
  risk: Number(opt("risk", 1)),
  capital: Number(opt("capital", 400000)),
};

const IST = 330;
const utcToIstHHMM = (utc) => {
  const d = new Date(utc.replace(" ", "T") + "Z");
  const m = new Date(d.getTime() + IST * 60000);
  return `${String(m.getUTCHours()).padStart(2, "0")}:${String(m.getUTCMinutes()).padStart(2, "0")}`;
};
const hhmmToMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

function readCsv(fp) {
  const text = fs.readFileSync(fp, "utf8").trim();
  const [head, ...lines] = text.split(/\r?\n/);
  const cols = head.split(",");
  return lines.map(l => { const v = l.split(","); const o = {}; cols.forEach((c, i) => (o[c] = v[i])); return o; });
}

// Group CSV rows into per-timestamp snapshots (chronological).
function snapshots(rows) {
  const byTs = new Map();
  for (const r of rows) { if (!byTs.has(r.time)) byTs.set(r.time, []); byTs.get(r.time).push(r); }
  return [...byTs.entries()].map(([time, legs]) => ({ time, hhmm: utcToIstHHMM(time), legs }));
}

// Build the /dhan/optionchain-shaped object at a snapshot.
function chainAt(snap, underlying) {
  const under = Number(snap.legs[0].under_ltp) || 0;
  const expiry = snap.legs[0].expiry || "";
  const byStrike = {};
  for (const r of snap.legs) {
    const sk = Number(r.strike);
    (byStrike[sk] ||= {})[r.type.toLowerCase()] = {
      ltp: Number(r.ltp) || 0, oi: Number(r.oi) || 0, iv: +(Number(r.iv) || 0).toFixed(2),
      delta: +(Number(r.delta) || 0).toFixed(3), theta: +(Number(r.theta) || 0).toFixed(2),
      bid: Number(r.bid) || 0, ask: Number(r.ask) || 0,
    };
  }
  const sks = Object.keys(byStrike).map(Number).sort((a, b) => a - b);
  if (!sks.length || !under) return null;
  const atm = sks.reduce((m, s) => (Math.abs(s - under) < Math.abs(m - under) ? s : m), sks[0]);
  const today = expiry;  // best-effort: expiry-today if the file date == expiry (set by caller)
  return {
    ok: true, underlying, under_ltp: under, expiry, isExpiryToday: snap._isExpiryToday || false,
    atmStrike: atm, ivPercentile: null,
    strikes: sks.map(s => ({ strike: s, atm: s === atm, ce: byStrike[s].ce || {}, pe: byStrike[s].pe || {} })),
  };
}

// Build the /dhan/oitrend-shaped payload from snapshots up to index `upto`.
function oitrendUpto(snaps, upto, underlying, bucketMin) {
  const kept = [];
  let lastBucket = -1;
  for (let i = 0; i <= upto; i++) {
    const b = Math.floor(hhmmToMin(snaps[i].hhmm) / bucketMin);
    if (b !== lastBucket) { kept.push(snaps[i]); lastBucket = b; }
    else kept[kept.length - 1] = snaps[i];
  }
  const strikeSet = new Set();
  kept.forEach(s => s.legs.forEach(r => strikeSet.add(Number(r.strike))));
  const strikes = [...strikeSet].sort((a, b) => a - b);
  const under = kept[kept.length - 1].legs[0].under_ltp;
  const atm = strikes.reduce((m, s) => (Math.abs(s - under) < Math.abs(m - under) ? s : m), strikes[0]);
  const leg = () => ({ oi: [], ltp: [], iv: [], vol: [], delta: null, prevOi: null });
  const map = {}; strikes.forEach(s => (map[s] = { ce: leg(), pe: leg() }));
  const times = [], underLtp = [];
  for (const snap of kept) {
    times.push(snap.hhmm); underLtp.push(+Number(snap.legs[0].under_ltp).toFixed(2));
    const idx = {}; snap.legs.forEach(r => (idx[`${Number(r.strike)}_${r.type}`] = r));
    for (const s of strikes) for (const [T, k] of [["CE", "ce"], ["PE", "pe"]]) {
      const r = idx[`${s}_${T}`], slot = map[s][k];
      if (r) { slot.oi.push(+r.oi || 0); slot.ltp.push(+r.ltp || 0); slot.iv.push(+(+r.iv).toFixed(2)); slot.vol.push(+r.volume || 0); slot.delta = +(+r.delta).toFixed(3); slot.prevOi = +r.prev_oi || 0; }
      else { slot.oi.push(slot.oi.at(-1) || 0); slot.ltp.push(slot.ltp.at(-1) || 0); slot.iv.push(slot.iv.at(-1) || 0); slot.vol.push(slot.vol.at(-1) || 0); }
    }
  }
  return { ok: true, underlying, expiry: kept[0].legs[0].expiry, asOf: times.at(-1), source: "replay", marketOpen: false,
           bucketMin, atmStrike: atm, times, underLtp, strikes: strikes.map(s => ({ strike: s, atm: s === atm, ce: map[s].ce, pe: map[s].pe })) };
}

// Premium series for one strike/type from a day's snapshots, from time >= entry.
function premiumSeries(snaps, strike, type, entryHHMM) {
  const em = hhmmToMin(entryHHMM);
  const out = [];
  for (const snap of snaps) {
    if (hhmmToMin(snap.hhmm) < em) continue;
    const r = snap.legs.find(x => Number(x.strike) === strike && x.type === type);
    if (r) out.push({ t: snap.hhmm, ltp: +r.ltp || 0, bid: +r.bid || 0, ask: +r.ask || 0 });
  }
  return out;
}

function dayFiles(underlying) {
  return fs.readdirSync(OPT_DIR)
    .filter(f => f.endsWith(".csv") && (!underlying || f.startsWith(`${underlying}_OPT_`)))
    .map(f => { const m = f.match(/^(.+)_OPT_(\d{4}-\d{2}-\d{2})\.csv$/); return m ? { file: f, underlying: m[1], date: m[2] } : null; })
    .filter(Boolean)
    .filter(d => (!CFG.from || d.date >= CFG.from) && (!CFG.to || d.date <= CFG.to))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function replayDay({ file, underlying, date }, candleHist) {
  const rows = readCsv(path.join(OPT_DIR, file));
  if (!rows.length) return [];
  const snaps = snapshots(rows);
  const isExpiryToday = snaps[0].legs[0].expiry === date;
  snaps.forEach(s => (s._isExpiryToday = isExpiryToday));
  const trades = [];
  let openTrade = null;

  for (let i = 0; i < snaps.length; i++) {
    const mins = hhmmToMin(snaps[i].hhmm);
    if (mins % CFG.step !== 0 && i !== 0) continue;      // sample every `step` minutes

    // Manage an open trade: resolve against remaining premium series.
    if (openTrade) {
      const ser = premiumSeries(snaps, openTrade.strike, openTrade.direction, openTrade.entryHHMM);
      const res = resolvePaperTrade({ ...openTrade, entryTs: openTrade.entryTs }, ser);
      if (res) { trades.push({ ...openTrade, ...res, date }); openTrade = null; }
      else continue;   // still open — don't stack positions
    }

    const chain = chainAt(snaps[i], underlying);
    if (!chain) continue;
    const oiPayload = oitrendUpto(snaps, i, underlying, 5);
    const oi = analyzeOiTrend(oiPayload);

    // Real underlying candles sliced to this replay instant (proper OHLC).
    const replayTs = new Date(snaps[i].time.replace(" ", "T") + "Z").getTime();
    const c5 = sliceTo(candleHist.c5, replayTs), c15 = sliceTo(candleHist.c15, replayTs), c1h = sliceTo(candleHist.c1h, replayTs);
    const r = scoreOption({
      underlying, candles5m: c5, candles15m: c15, candles1H: c1h,
      chain, oi, vix: null, history: [], events: {}, mm: { capital: CFG.capital, rr: 2 }, riskPct: CFG.risk,
    });
    if (r.verdict === "TRADE" && r.strike && r.plan && r.plan.lots >= 1) {
      // Enter at the strike's ask (slippage realism).
      const legRow = snaps[i].legs.find(x => Number(x.strike) === r.strike.strike && x.type === r.direction);
      const entryPrem = legRow ? (Number(legRow.ask) || Number(legRow.ltp)) : r.strike.ltp;
      openTrade = {
        id: `RPL-${underlying}-${date}-${snaps[i].hhmm}`,
        entryTs: new Date(snaps[i].time.replace(" ", "T") + "Z").getTime(),
        entryHHMM: snaps[i].hhmm, assetId: underlying, underlying,
        strike: r.strike.strike, direction: r.direction, expiry: chain.expiry,
        optionPremium: entryPrem, entryPremium: entryPrem,
        slPremium: r.plan.slPrice, tgtPremium: r.plan.tgtPrice,
        trailStop: r.plan.trailStop === true, trailArmPts: r.plan.trailArmPts, trailPts: r.plan.trailPts,
        lots: r.plan.lots, lotSize: r.plan.lotUnits, maxHoldMin: r.plan.maxHoldMin, squareOff: r.plan.squareOff,
        style: r.style?.style, regime: r.regime.regime, score: r.score,
        scoreFactors: Object.fromEntries(Object.entries(r.factors).map(([k, f]) => [k, f.score01])),
      };
    }
  }
  // Square off any still-open at day end (last snapshot premium).
  if (openTrade) {
    const ser = premiumSeries(snaps, openTrade.strike, openTrade.direction, openTrade.entryHHMM);
    const lastPrem = ser.at(-1)?.ltp ?? openTrade.optionPremium;
    trades.push({ ...openTrade, outcome: lastPrem >= openTrade.optionPremium ? "win" : "loss",
      exitPremium: lastPrem, exitReason: "Day-end square-off", exitAt: snaps.at(-1).hhmm,
      grossPnlRs: +((lastPrem - openTrade.optionPremium) * openTrade.lots * openTrade.lotSize).toFixed(2),
      pnlRs: +((lastPrem - openTrade.optionPremium) * openTrade.lots * openTrade.lotSize).toFixed(2), costRs: 0,
      rMultiple: (openTrade.optionPremium - openTrade.slPremium) ? +((lastPrem - openTrade.optionPremium) / (openTrade.optionPremium - openTrade.slPremium)).toFixed(2) : 0, date });
  }
  return trades;
}

async function main() {
  if (!fs.existsSync(OPT_DIR)) { console.error("No options data dir:", OPT_DIR); process.exit(1); }
  const days = dayFiles(CFG.underlying);
  if (!days.length) { console.error("No matching CSVs."); process.exit(1); }
  const from = days[0].date, to = days.at(-1).date;
  console.log(`Replaying ${days.length} day-file(s) (${from} → ${to})… candles per-day from the bridge.`);
  let all = [], firstDay = true;
  for (const d of days) {
    try {
      const hist = await candlesForDay(d.underlying, d.date);
      if (firstDay) { console.log(`  candle check ${d.underlying} ${d.date}: ${hist.c5.length} 5m / ${hist.c15.length} 15m / ${hist.c1h.length} 1H`); firstDay = false;
        if (hist.c15.length < 50) console.warn("  ⚠ Thin candles — is the bridge running on :5000?"); }
      const t = replayDay(d, hist); all = all.concat(t);
      console.log(`  ${d.underlying} ${d.date}: ${t.length} trade(s)`);
    } catch (e) { console.warn(`  ${d.file}: ${e.message}`); }
  }
  const wins = all.filter(t => t.outcome === "win").length;
  const net = all.reduce((s, t) => s + (Number(t.pnlRs) || 0), 0);
  const summary = { generatedAt: new Date().toISOString(), from, to, underlyings: [...new Set(days.map(d => d.underlying))],
    step: CFG.step, risk: CFG.risk, capital: CFG.capital, trades: all.length, wins, losses: all.length - wins,
    winRate: all.length ? +(wins / all.length * 100).toFixed(1) : 0, netRs: +net.toFixed(2) };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `replay_${from}_${to}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ summary, trades: all }, null, 2));
  // Also write a stable "latest" pointer the bridge/R&D page reads by default.
  fs.writeFileSync(path.join(OUT_DIR, "replay_latest.json"), JSON.stringify({ summary, trades: all }));
  console.log(`\n${all.length} trades · ${summary.winRate}% WR · net ₹${summary.netRs} → ${outFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
