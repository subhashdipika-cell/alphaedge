// Offline warm-up inventory. Counts are necessary, not proof of signal quality.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localCandles, readCsv, snapshots, sliceTo } from './replay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, 'strategy-lab', 'data');
const report = { generatedAt: new Date().toISOString(), provenance: 'DHAN_INDEX_IDENTITY_RECORDED',
  limitations: ['Checks completed-bar warm-up counts, not uninterrupted data or full-session coverage.',
    'Does not reconstruct missing option snapshots, IV history, VIX or events.',
    'Backfilled candles are retrospective observations, not proof they were available to the live scanner.'], days: [] };
if (process.argv.includes('--allow-unverified')) throw new Error('Coverage requires verified INDEX candles');
for (const file of fs.readdirSync(path.join(data, 'options')).sort()) {
  const match = /^(NIFTY50|BANKNIFTY|SENSEX|FINNIFTY)_OPT_(\d{4}-\d{2}-\d{2})\.csv$/.exec(file);
  if (!match) continue;
  const [, underlying, date] = match;
  const snaps = snapshots(readCsv(path.join(data, 'options', file)));
  if (!snaps.length) { report.days.push({ underlying, date, ready: false, reason: 'NO_SNAPSHOTS' }); continue; }
  const firstTs = Date.parse(snaps[0].time.replace(' ', 'T') + 'Z');
  const from = new Date(Date.parse(date) - 14 * 86400000).toISOString().slice(0, 10);
  const counts = Object.fromEntries([['5m', 5], ['15m', 15], ['1H', 60]].map(([tf, duration]) =>
    [tf, sliceTo(localCandles(underlying, tf, from, date), firstTs, duration).length]));
  report.days.push({ underlying, date, firstSnapshot: snaps[0].time, snapshots: snaps.length,
    completedWarmup: counts, ready: counts['5m'] >= 50 && counts['15m'] >= 50 && counts['1H'] >= 50 });
}
report.summary = { indexDays: report.days.length, warmupReady: report.days.filter(d => d.ready).length,
  missingWarmup: report.days.filter(d => !d.ready).length };
const dest = path.join(root, 'strategy-lab', 'results', 'history-coverage.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
for (const day of report.days.filter(d => !d.ready)) console.log(JSON.stringify(day));
console.log(dest);
