// ─── WALK-FORWARD / PARAMETER-STABILITY RESEARCH ────────────────────────────
// Selects parameters only on an earlier train window, then evaluates them on a
// later test window using the same replay engine. This is research-only and
// never changes live strategy settings.
//
// Usage:
//   node scripts/walkforward.mjs --underlying NIFTY50
//   node scripts/walkforward.mjs --train 10 --test 5 --step 5

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OPT_DIR = path.join(ROOT, "strategy-lab", "data", "options");
const RESULTS_DIR = path.join(ROOT, "strategy-lab", "results");
const REPLAY = path.join(HERE, "replay.mjs");
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const CFG = {
  underlying: opt("underlying", "NIFTY50"),
  train: Number(opt("train", 10)), test: Number(opt("test", 5)), step: Number(opt("step", 5)),
  risk: Number(opt("risk", 1)), capital: Number(opt("capital", 400000)), research: true,
};

const candidates = [
  { indexScore: 3, minDelta: 0.40, maxDelta: 0.65, targetR: 1.4 },
  { indexScore: 3, minDelta: 0.45, maxDelta: 0.60, targetR: 1.8 },
  { indexScore: 4, minDelta: 0.40, maxDelta: 0.65, targetR: 1.4 },
  { indexScore: 4, minDelta: 0.45, maxDelta: 0.60, targetR: 1.8 },
  { indexScore: 4, minDelta: 0.45, maxDelta: 0.60, targetR: 2.2 },
  { indexScore: 5, minDelta: 0.40, maxDelta: 0.65, targetR: 1.4 },
  { indexScore: 5, minDelta: 0.45, maxDelta: 0.60, targetR: 1.8 },
  { indexScore: 5, minDelta: 0.45, maxDelta: 0.60, targetR: 2.2 },
];

function daysFor() {
  return fs.readdirSync(OPT_DIR)
    .filter(f => f.startsWith(`${CFG.underlying}_OPT_`) && f.endsWith(".csv"))
    .map(f => f.match(/_(\d{4}-\d{2}-\d{2})\.csv$/)?.[1])
    .filter(Boolean).sort();
}

function key(p) { return `${p.indexScore}-${p.minDelta}-${p.maxDelta}-${p.targetR}`; }

function runReplay(from, to, p) {
  const replayArgs = [REPLAY, "--underlying", CFG.underlying, "--from", from, "--to", to,
    "--step", String(CFG.step), "--risk", String(CFG.risk), "--capital", String(CFG.capital),
    "--research", "true", "--index-score", String(p.indexScore), "--min-delta", String(p.minDelta),
    "--max-delta", String(p.maxDelta), "--target-r", String(p.targetR)];
  try { execFileSync(process.execPath, replayArgs, { cwd: ROOT, stdio: "ignore", timeout: 120000 }); }
  catch (e) { throw new Error(`Replay failed for ${from}..${to}: ${e.message}`); }
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.startsWith("replay_") && f.endsWith(".json"))
    .map(f => ({ f, m: f.match(/^replay_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.json$/) }))
    .filter(x => x.m && x.m[1] === from && x.m[2] === to);
  if (!files.length) throw new Error(`Replay result missing for ${from}..${to}`);
  return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, files[0].f), "utf8")).summary;
}

function score(s) {
  // Prefer positive net and average R, with a modest drawdown penalty. Do not
  // pretend a one-trade sample is strong evidence; it is reported separately.
  return (Number(s.netRs) || 0) / CFG.capital + (Number(s.avgR) || 0) * 0.02
    - (Number(s.maxDrawdownRs) || 0) / CFG.capital * 0.25;
}

function aggregate(summaries) {
  const trades = summaries.reduce((n, s) => n + (s.trades || 0), 0);
  const wins = summaries.reduce((n, s) => n + (s.wins || 0), 0);
  const netRs = summaries.reduce((n, s) => n + (s.netRs || 0), 0);
  const costsRs = summaries.reduce((n, s) => n + (s.costsRs || 0), 0);
  const r = summaries.flatMap(s => Array(s.trades || 0).fill(Number(s.avgR) || 0));
  return { windows: summaries.length, trades, wins, losses: trades - wins,
    winRate: trades ? +(wins / trades * 100).toFixed(1) : 0, netRs: +netRs.toFixed(2), costsRs: +costsRs.toFixed(2),
    avgR: r.length ? +(r.reduce((a, b) => a + b, 0) / r.length).toFixed(2) : 0 };
}

function main() {
  const days = daysFor();
  if (days.length < CFG.train + CFG.test) throw new Error(`Need ${CFG.train + CFG.test} sessions; found ${days.length}`);
  const windows = [];
  for (let i = 0; i + CFG.train + CFG.test <= days.length; i += CFG.step) {
    const trainDays = days.slice(i, i + CFG.train), testDays = days.slice(i + CFG.train, i + CFG.train + CFG.test);
    const train = candidates.map(p => ({ params: p, summary: runReplay(trainDays[0], trainDays.at(-1), p) }));
    const eligible = train.filter(x => x.summary.trades >= 2);
    const ranked = (eligible.length ? eligible : train).sort((a, b) => score(b.summary) - score(a.summary));
    const selected = ranked[0];
    const test = runReplay(testDays[0], testDays.at(-1), selected.params);
    const baseline = runReplay(testDays[0], testDays.at(-1), candidates[3]);
    windows.push({ train: [trainDays[0], trainDays.at(-1)], test: [testDays[0], testDays.at(-1)],
      selected: selected.params, selectedTrain: selected.summary, selectedTest: test, baselineTest: baseline,
      trainCandidates: train.map(x => ({ params: x.params, summary: x.summary })) });
    console.log(`${testDays[0]}..${testDays.at(-1)} selected ${key(selected.params)} → ${test.trades} trades, ₹${test.netRs} net; baseline ₹${baseline.netRs}`);
  }
  const selectedAgg = aggregate(windows.map(w => w.selectedTest));
  const baselineAgg = aggregate(windows.map(w => w.baselineTest));
  const report = { generatedAt: new Date().toISOString(), mode: "research-only", underlying: CFG.underlying,
    trainSessions: CFG.train, testSessions: CFG.test, stepSessions: CFG.step, candidates,
    windows, selectedAggregate: selectedAgg, baselineAggregate: baselineAgg,
    conclusion: selectedAgg.trades >= 20 && selectedAgg.netRs > 0 && selectedAgg.netRs >= baselineAgg.netRs
      ? "Promising but requires more out-of-sample sessions and execution validation."
      : "Insufficient evidence of stable edge; keep deterministic gates unchanged and collect more data." };
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, "walkforward_latest.json"), JSON.stringify(report, null, 2));
  console.log(`\nSelected OOS: ${selectedAgg.trades} trades · ${selectedAgg.winRate}% WR · ₹${selectedAgg.netRs} net`);
  console.log(`Baseline OOS: ${baselineAgg.trades} trades · ${baselineAgg.winRate}% WR · ₹${baselineAgg.netRs} net`);
  console.log(`Report: ${path.join(RESULTS_DIR, "walkforward_latest.json")}`);
}

main();
