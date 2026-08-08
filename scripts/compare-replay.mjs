// ─── CURRENT VS PREVIOUS STRATEGY REPLAY ─────────────────────────────────────
// Runs both variants on identical collected Dhan option data and writes an
// apples-to-apples comparison. Research mode is enabled by default so the
// production entry-window gate does not dominate the comparison.

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RESULTS = path.join(ROOT, "strategy-lab", "results");
const REPLAY = path.join(HERE, "replay.mjs");
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const CFG = { underlying: opt("underlying", null), from: opt("from", null), to: opt("to", null),
  step: opt("step", "5"), risk: opt("risk", "1"), capital: opt("capital", "400000"), research: opt("research", "true") };

function run(variant) {
  const a = [REPLAY, "--variant", variant, "--step", CFG.step, "--risk", CFG.risk, "--capital", CFG.capital,
    "--research", CFG.research];
  for (const [k, v] of [["underlying", CFG.underlying], ["from", CFG.from], ["to", CFG.to]]) if (v) a.push(`--${k}`, v);
  execFileSync(process.execPath, a, { cwd: ROOT, stdio: "ignore", timeout: 600000 });
  return JSON.parse(fs.readFileSync(path.join(RESULTS, "replay_latest.json"), "utf8"));
}

function stats(trades) {
  const done = trades.filter(t => t.outcome === "win" || t.outcome === "loss");
  const wins = done.filter(t => t.outcome === "win").length;
  let equity = 0, peak = 0, dd = 0;
  for (const t of done) { equity += Number(t.pnlRs) || 0; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity); }
  const r = done.map(t => Number(t.rMultiple)).filter(Number.isFinite);
  return { trades: done.length, wins, losses: done.length - wins,
    winRate: done.length ? +(wins / done.length * 100).toFixed(1) : 0,
    grossRs: +done.reduce((s, t) => s + (Number(t.grossPnlRs) || 0), 0).toFixed(2),
    costsRs: +done.reduce((s, t) => s + (Number(t.costRs) || 0), 0).toFixed(2),
    netRs: +done.reduce((s, t) => s + (Number(t.pnlRs) || 0), 0).toFixed(2),
    maxDrawdownRs: +dd.toFixed(2), avgR: r.length ? +(r.reduce((s, x) => s + x, 0) / r.length).toFixed(2) : 0 };
}

function byUnderlying(trades) {
  const map = {};
  for (const t of trades) (map[t.underlying || t.assetId] ||= []).push(t);
  return Object.fromEntries(Object.entries(map).map(([u, ts]) => [u, stats(ts)]));
}

function main() {
  const previous = run("legacy"), current = run("current");
  const report = { generatedAt: new Date().toISOString(), inputs: CFG, methodology:
    "Same Dhan CSVs, timestamps, replay step, capital, risk, costs, resolver, and research window; legacy disables NIFTY chart-first/premium confirmation and ask-fill accounting.",
    previous: { summary: stats(previous.trades), byUnderlying: byUnderlying(previous.trades) },
    current: { summary: stats(current.trades), byUnderlying: byUnderlying(current.trades) } };
  report.delta = Object.fromEntries(Object.keys(report.current.summary).map(k => [k,
    typeof report.current.summary[k] === "number" ? +(report.current.summary[k] - (report.previous.summary[k] || 0)).toFixed(2) : null]));
  fs.mkdirSync(RESULTS, { recursive: true });
  const fp = path.join(RESULTS, "replay_comparison_latest.json");
  fs.writeFileSync(fp, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Comparison report: ${fp}`);
}

main();
