// Offline diagnostic replay. Never imports a broker or changes paper journals.
// Quotes are sparse snapshots, not tick paths; results are NOT promotion evidence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCsv, snapshots, chainAt, oitrendUpto, localCandles, sliceTo, hhmmToMin } from './replay.mjs';
import { scoreOption } from '../src/engines/score.js';
import { analyzeOiTrend } from '../src/engines/oi.js';
import { zeroHeroPick, zeroHeroV2Pick, zeroHeroDivergencePick, zeroHeroRecords, zeroHeroV2Records, zeroHeroDivergenceRecord } from '../src/engines/zerohero.js';
import { netOptionPnl, exchangeFor } from '../src/engines/costs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'strategy-lab/data/options');
const out = process.argv[2] || path.join(root, 'strategy-lab/reports', `stored-audit-${Date.now()}.json`);
const families = ['current', 'legacy', 'zero-hero-v1', 'zero-hero-v2', 'zero-hero-divergence'];
const result = { generatedAt: new Date().toISOString(), assumptions: {
  mode: 'OFFLINE_RESEARCH_ONLY', slippage: 0.005, sizing: 'one option unit per leg; historical lot metadata unavailable',
  charges: 'current shared cost model per one-unit order, NOT historical lot-sized portfolio P&L',
  limitations: ['Stored index filenames may contain futures; no per-row instrument provenance.',
    'Sparse chain snapshots cannot establish all intrabar stop/target touches.',
    'Current score uses front expiry here; live expiry rolling differs.',
    'No historical VIX, events, FII/DII or learned gate state; independent strategy tests, not scanner portfolio.',
    'No claim of out-of-sample evidence: parameters previously tuned on some stored sessions.',
    'Divergence uses the deployed five-minute implementation, not the original one-minute specification.']
}, files: [], strategies: {}, errors: [] };
const epoch = t => Date.parse(t.replace(' ', 'T') + 'Z');
const stats = (f, u) => result.strategies[`${f}/${u}`] ||= { evaluations: 0, gates: {}, signals: 0, unresolved: 0, trades: [] };
const gate = (s, reason) => { s.gates[reason] = (s.gates[reason] || 0) + 1; };

// Stop exits use observed bid (including gaps), never a guaranteed stop fill.
export function settle(trade, snaps, start, expiry) {
  const entry = trade.optionPremium, risk = entry - trade.slPremium;
  let high = entry, stop = trade.slPremium;
  for (let j = start + 1; j < snaps.length; j++) {
    const snap = snaps[j], q = snap.legs.find(r => r.expiry === expiry && +r.strike === trade.strike && r.type === trade.direction);
    if (!q || !(+q.bid > 0) || !(+q.ask >= +q.bid)) continue;
    const bid = +q.bid * 0.995, mins = hhmmToMin(snap.hhmm);
    const held = (epoch(snap.time) - trade.entryTs) / 60000;
    high = Math.max(high, bid);
    if (trade.trailStop && high >= entry + trade.trailArmPts) stop = Math.max(stop, high - trade.trailPts);
    const reason = bid <= stop ? 'stop' : trade.tgtPremium > 0 && bid >= trade.tgtPremium ? 'target'
      : mins >= 912 ? 'square-off' : trade.maxHoldMin && held >= trade.maxHoldMin ? 'time-stop' : null;
    if (!reason) continue;
    const exit = reason === 'target' ? Math.min(bid, trade.tgtPremium) : bid;
    const pnl = netOptionPnl({ entryPremium: entry, exitPremium: exit, qty: 1, exchange: exchangeFor(trade.assetId) });
    return { entryTs: trade.entryTs, exitTs: epoch(snap.time), entry, exit, reason, strike: trade.strike,
      direction: trade.direction, expiry, grossR: risk > 0 ? (exit - entry) / risk : null, ...pnl };
  }
  return null;
}

async function main() {
  const files = fs.readdirSync(dir).filter(f => /^(NIFTY50|BANKNIFTY|SENSEX|FINNIFTY)_OPT_.*\.csv$/.test(f)).sort();
  for (const file of files) {
    const [, underlying, date] = file.match(/^(.*?)_OPT_(\d{4}-\d{2}-\d{2})\.csv$/);
    try {
      const rows = readCsv(path.join(dir, file)), expiries = [...new Set(rows.map(r => r.expiry).filter(Boolean))].sort();
      if (!rows.length || !expiries.length) continue;
      const expiry = expiries[0], snaps = snapshots(rows.filter(r => r.expiry === expiry));
      const from = new Date(Date.parse(date) - 14 * 86400000).toISOString().slice(0, 10);
      const c5 = localCandles(underlying, '5m', from, date), c15 = localCandles(underlying, '15m', from, date), c1 = localCandles(underlying, '1H', from, date);
      const driver = underlying === 'BANKNIFTY' ? localCandles('NIFTY50', '5m', from, date) : [];
      result.files.push({ file, date, underlying, expiries, snapshots: snaps.length, first: snaps[0].time, last: snaps.at(-1).time,
        expiryDay: expiry === date, bars5m: c5.length, bars1h: c1.length });
      const next = {}, used = new Set(); let bucket = -1;
      for (let i = 0; i < snaps.length; i++) {
        const snap = snaps[i], mins = hhmmToMin(snap.hhmm), ts = epoch(snap.time);
        if (Math.floor(mins / 5) === bucket) continue;
        bucket = Math.floor(mins / 5);
        snap._isExpiryToday = expiry === date;
        const chain = chainAt(snap, underlying); if (!chain) continue;
        const oi = analyzeOiTrend(oitrendUpto(snaps, i, underlying, 5));
        const a5 = sliceTo(c5, ts, 5), a15 = sliceTo(c15, ts, 15), a1 = sliceTo(c1, ts, 60);
        for (const family of families) {
          if (family === 'zero-hero-divergence' && underlying !== 'BANKNIFTY') continue;
          const s = stats(family, underlying);
          if ((next[family] || 0) > ts || used.has(family)) continue;
          s.evaluations++;
          let records;
          if (family === 'current' || family === 'legacy') {
            const legacy = family === 'legacy';
            const r = scoreOption({ underlying, candles5m: a5, candles15m: a15, candles1H: a1, chain, oi,
              vix: null, history: [], events: {}, mm: { capital: 400000, rr: 2 }, riskPct: 1,
              nowMin: mins, atNow: ts, asOfTs: ts, dhanOptionScalp: !legacy && underlying === 'NIFTY50',
              sensexOptionWorkflow: !legacy && underlying === 'SENSEX', optionWorkflow: !legacy, legacyReplay: legacy });
            if (r.verdict !== 'TRADE' || !r.strike || !(r.plan?.lots >= 1)) { gate(s, r.gates?.[0] || r.verdict); continue; }
            records = [{ assetId: underlying, strike: r.strike.strike, direction: r.direction, optionPremium: r.strike.ltp,
              slPremium: r.plan.slPrice, tgtPremium: r.plan.tgtPrice, maxHoldMin: r.plan.maxHoldMin,
              trailStop: r.plan.trailStop, trailArmPts: r.plan.trailArmPts, trailPts: r.plan.trailPts }];
          } else {
            const common = { chain, oi, candles5m: a5, candles15m: a15, istMin: mins };
            const pick = family === 'zero-hero-v1' ? zeroHeroPick(common) : family === 'zero-hero-v2' ? zeroHeroV2Pick(common)
              : zeroHeroDivergencePick({ chainB: chain, candlesA: sliceTo(driver, ts, 5), candlesB: a5, istMin: mins });
            if (!pick.ok) { gate(s, pick.reason); continue; }
            const arg = { underlying, pick, lotSize: 1, now: ts };
            records = family === 'zero-hero-v1' ? zeroHeroRecords(arg) : family === 'zero-hero-v2' ? zeroHeroV2Records(arg) : [zeroHeroDivergenceRecord(arg)];
          }
          const quote = snap.legs.find(r => +r.strike === records[0].strike && r.type === records[0].direction);
          if (!(+quote?.ask > 0) || !(+quote?.bid > 0) || +quote.ask < +quote.bid) { gate(s, 'missing or crossed execution quote'); continue; }
          s.signals++; if (family.startsWith('zero')) used.add(family);
          for (const record of records) {
            record.entryTs = ts; record.optionPremium = +quote.ask * 1.005;
            const fill = settle(record, snaps, i, expiry);
            if (fill) { s.trades.push({ date, ...fill }); next[family] = Math.max(next[family] || 0, fill.exitTs + 1); }
            else { s.unresolved++; next[family] = Infinity; }
          }
        }
      }
      console.log(`${file}: ${snaps.length} snapshots`);
    } catch (e) { result.errors.push({ file, error: e.stack }); }
  }
  for (const s of Object.values(result.strategies)) {
    const r = s.trades.map(t => t.grossR).filter(Number.isFinite), wins = r.filter(x => x > 0), losses = r.filter(x => x < 0);
    s.summary = { completedLegs: s.trades.length, winRateGrossPct: r.length ? 100 * wins.length / r.length : null,
      expectancyGrossR: r.length ? r.reduce((a,b) => a+b,0)/r.length : null,
      profitFactorR: losses.length ? wins.reduce((a,b)=>a+b,0)/-losses.reduce((a,b)=>a+b,0) : null };
  }
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(result.strategies).map(([k,s]) => [k, { ...s.summary, signals: s.signals, unresolved: s.unresolved,
    gates: Object.entries(s.gates).sort((a,b)=>b[1]-a[1]).slice(0,3) }])) , null, 2));
  console.log(`Saved ${out}; errors=${result.errors.length}`);
  if (result.errors.length) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
