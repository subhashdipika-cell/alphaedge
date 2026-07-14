// ─── R&D / META-LEARNING ENGINE ───────────────────────────────────────────────
// Turns the resolved paper-trade / replay track record into learning:
//   • per-STYLE meta-learning (which style pays; allocation nudge),
//   • per-REGIME expectancy,
//   • per-FACTOR attribution (does a high factor score predict wins?),
//   • a deterministic weight TUNER (re-scores logged trades from their stored
//     factor scores; never auto-applies).
// It guards against overfitting by reporting sample sizes and suppressing
// recommendations below MIN_SAMPLE.
//
// Pure: all functions take an array of resolved trade records and return plain
// objects. A resolved record carries: outcome "win"|"loss", rMultiple, pnlRs,
// style, regime, score, scoreFactors{ factor: 0..1 }.

export const MIN_SAMPLE = 20;   // below this, report but don't recommend
const FACTORS = ["trend", "momentum", "ict", "chainOi", "greeks", "ivVix", "risk", "news"];
const STYLE_LABEL = { SCALP: "Momentum Scalp", INTRADAY: "Intraday Directional", SWING: "Positional Swing" };

const resolved = (trades) => (trades || []).filter(t => t && (t.outcome === "win" || t.outcome === "loss"));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };

function cell() { return { n: 0, wins: 0, losses: 0, sumR: 0, netRs: 0 }; }
function roll(g, t) {
  g.n += 1;
  if (t.outcome === "win") g.wins += 1; else g.losses += 1;
  g.sumR += Number(t.rMultiple) || 0;
  g.netRs += Number(t.pnlRs) || 0;
}
function finish(g) {
  return { ...g, winRate: g.n ? (g.wins / g.n) * 100 : 0, expectancyR: g.n ? g.sumR / g.n : 0, avgNetRs: g.n ? g.netRs / g.n : 0 };
}

function groupBy(trades, keyFn) {
  const groups = {};
  resolved(trades).forEach(t => { const k = keyFn(t); if (k == null) return; (groups[k] ||= cell()); roll(groups[k], t); });
  return Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, finish(g)]));
}

// ── Per-style meta-learning + allocation recommendation ──
export function styleMetaLearning(trades) {
  const byStyle = groupBy(trades, t => t.style || "UNKNOWN");
  const rows = Object.entries(byStyle).map(([style, g]) => ({ style, label: STYLE_LABEL[style] || style, ...g }))
    .sort((a, b) => b.expectancyR - a.expectancyR);
  const total = resolved(trades).length;
  const recs = [];
  if (total >= MIN_SAMPLE && rows.length) {
    const best = rows[0], worst = rows[rows.length - 1];
    if (best.n >= MIN_SAMPLE / 2 && best.expectancyR > 0.2)
      recs.push(`Increase allocation to ${best.label} — ${best.winRate.toFixed(0)}% WR, ${best.expectancyR >= 0 ? "+" : ""}${best.expectancyR.toFixed(2)}R over ${best.n} trades.`);
    if (rows.length > 1 && worst.n >= MIN_SAMPLE / 2 && worst.expectancyR < 0)
      recs.push(`Reduce ${worst.label} size — negative expectancy (${worst.expectancyR.toFixed(2)}R) over ${worst.n} trades.`);
  }
  return { rows, total, ready: total >= MIN_SAMPLE, recs, minSample: MIN_SAMPLE };
}

// ── Per-regime expectancy ──
export function regimeAttribution(trades) {
  const byRegime = groupBy(trades, t => t.regime || "UNKNOWN");
  return Object.entries(byRegime).map(([regime, g]) => ({ regime, ...g })).sort((a, b) => b.expectancyR - a.expectancyR);
}

// ── Per-factor attribution: does a high factor score predict wins? ──
// For each factor: split trades at the score01 median, compare win-rate; also a
// point-biserial correlation of factor score with the win/loss outcome.
export function factorAttribution(trades) {
  const R = resolved(trades).filter(t => t.scoreFactors);
  const out = [];
  const winFlag = R.map(t => (t.outcome === "win" ? 1 : 0));
  const p = mean(winFlag), q = 1 - p;
  for (const f of FACTORS) {
    const xs = R.map(t => Number(t.scoreFactors[f])).filter(Number.isFinite);
    if (xs.length < 4) { out.push({ factor: f, n: xs.length, corr: null, lift: null, winRateHigh: null, winRateLow: null }); continue; }
    const paired = R.filter(t => Number.isFinite(Number(t.scoreFactors[f])));
    const m1 = mean(paired.filter(t => t.outcome === "win").map(t => Number(t.scoreFactors[f])));
    const m0 = mean(paired.filter(t => t.outcome === "loss").map(t => Number(t.scoreFactors[f])));
    const sx = std(paired.map(t => Number(t.scoreFactors[f])));
    const corr = sx > 0 ? ((m1 - m0) / sx) * Math.sqrt(p * q) : 0;
    // median split for an intuitive lift
    const med = [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const hi = paired.filter(t => Number(t.scoreFactors[f]) >= med), lo = paired.filter(t => Number(t.scoreFactors[f]) < med);
    const wr = (g) => (g.length ? g.filter(t => t.outcome === "win").length / g.length * 100 : null);
    out.push({ factor: f, n: paired.length, corr: +corr.toFixed(3), winRateHigh: wr(hi), winRateLow: wr(lo),
               lift: (wr(hi) != null && wr(lo) != null) ? +(wr(hi) - wr(lo)).toFixed(1) : null });
  }
  return out.sort((a, b) => (Math.abs(b.corr ?? 0)) - (Math.abs(a.corr ?? 0)));
}

// Re-score a logged trade from its stored per-factor scores + a weight vector.
export function rescore(trade, weights) {
  const sf = trade.scoreFactors || {};
  let pts = 0, wsum = 0;
  for (const f of FACTORS) {
    const s = Number(sf[f]);
    if (!Number.isFinite(s)) continue;
    pts += s * (weights[f] || 0);
    wsum += (weights[f] || 0);
  }
  return wsum ? (pts / wsum) * 100 : 0;
}

// Separation metric: point-biserial corr of the re-scored value with win/loss.
function separation(trades, weights) {
  const R = resolved(trades).filter(t => t.scoreFactors);
  if (R.length < 4) return 0;
  const scores = R.map(t => rescore(t, weights));
  const wins = R.map(t => (t.outcome === "win" ? 1 : 0));
  const p = mean(wins), q = 1 - p, sx = std(scores);
  if (!sx || !p || !q) return 0;
  const m1 = mean(scores.filter((_, i) => wins[i] === 1));
  const m0 = mean(scores.filter((_, i) => wins[i] === 0));
  return ((m1 - m0) / sx) * Math.sqrt(p * q);
}

// ── Weight tuner: deterministic coordinate search, re-scoring from stored
// factors. Returns the baseline separation + top candidate vectors that beat it.
// Never applies anything — the user opts in from Settings.
export function tuneWeights(trades, baseWeights) {
  const R = resolved(trades).filter(t => t.scoreFactors);
  const baseSep = separation(trades, baseWeights);
  if (R.length < MIN_SAMPLE) {
    return { ready: false, n: R.length, minSample: MIN_SAMPLE, baseSeparation: +baseSep.toFixed(3), candidates: [] };
  }
  const norm = (w) => { const s = Object.values(w).reduce((a, b) => a + b, 0); const o = {}; for (const k of Object.keys(w)) o[k] = +(w[k] / s * 100).toFixed(1); return o; };
  const seen = new Set();
  const candidates = [];
  // Single-factor perturbations ±5 / ±10 (renormalised).
  for (const f of FACTORS) {
    for (const d of [-10, -5, 5, 10]) {
      const w = { ...baseWeights, [f]: Math.max(0, (baseWeights[f] || 0) + d) };
      const nw = norm(w), key = JSON.stringify(nw);
      if (seen.has(key)) continue; seen.add(key);
      candidates.push({ weights: nw, changed: `${f} ${d > 0 ? "+" : ""}${d}`, separation: +separation(trades, nw).toFixed(3) });
    }
  }
  // Greedy 3-round coordinate ascent from the base.
  let cur = { ...baseWeights }, curSep = baseSep, moves = [];
  for (let round = 0; round < 3; round++) {
    let best = null;
    for (const f of FACTORS) for (const d of [-5, 5]) {
      const w = norm({ ...cur, [f]: Math.max(0, (cur[f] || 0) + d) });
      const sep = separation(trades, w);
      if (!best || sep > best.sep) best = { w, sep, move: `${f} ${d > 0 ? "+" : ""}${d}` };
    }
    if (best && best.sep > curSep + 1e-4) { cur = best.w; curSep = best.sep; moves.push(best.move); } else break;
  }
  if (moves.length) candidates.push({ weights: norm(cur), changed: `greedy: ${moves.join(", ")}`, separation: +curSep.toFixed(3) });

  const top = candidates.filter(c => c.separation > baseSep).sort((a, b) => b.separation - a.separation).slice(0, 3);
  return { ready: true, n: R.length, minSample: MIN_SAMPLE, baseSeparation: +baseSep.toFixed(3), candidates: top };
}
