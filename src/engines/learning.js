// ─── SIGNAL LEARNING ENGINE ───────────────────────────────────────────────────
// Pure outcome classification + a profile builder that groups resolved signals
// by setup / asset / timeframe / nature and emits avoid/favor lists. Asset-
// agnostic — the same machinery will drive the R&D factor-attribution engine
// (revamp Phase 8), grouping by score-factor tags instead of setup/asset.

export const SIGNAL_LEARNING_KEY = "alphaedge_signal_learning";
export const MIN_BIG_PROFIT_RR = 3;
export const MAX_SIGNAL_RISK_PCT = 1;
export const PROMOTION_POLICY = {
  minResolvedTrades: 50,
  minWinRatePct: 52,
  minExpectancyR: 0.10,
  minProfitFactor: 1.10,
  maxDrawdownR: 5,
  minWilsonWinRatePct: 45,
  wilsonZ: 1.645, // one-sided 95% lower confidence bound
};
export const PROMOTION_STRATEGIES = [
  { key: "nifty-option-workflow-v1", label: "NIFTY option workflow" },
  { key: "sensex-option-workflow-v1", label: "SENSEX option workflow" },
  { key: "score-v1", label: "Legacy score strategies" },
  { key: "zero-hero-v1", label: "Zero-Hero" },
  { key: "zero-hero-v2", label: "Zero-Hero v2" },
  { key: "zero-hero-divergence-v1", label: "Zero-Hero divergence" },
];

export function outcomeBucket(signalOrOutcome) {
  const outcome = typeof signalOrOutcome === "string" ? signalOrOutcome : signalOrOutcome?.outcome;
  if (typeof signalOrOutcome === "object" && (outcome === "win" || outcome === "loss")) {
    // Classification must use realized R, not the planned target. A trade that
    // was planned for 3R but exited at +0.4R is a small profit, not a big one.
    const realizedR = Number(signalOrOutcome?.rMultiple);
    if (Number.isFinite(realizedR)) {
      if (realizedR >= MIN_BIG_PROFIT_RR) return "big_profit";
      if (realizedR > 0) return "small_profit";
      if (realizedR < -1) return "big_loss";
      return "small_loss";
    }
    // Legacy records without realized R retain conservative semantics: wins
    // are small profits unless explicitly marked otherwise.
    return outcome === "win" ? "small_profit" : "small_loss";
  }
  if (outcome === "win") return "small_profit";
  if (outcome === "loss") return "small_loss";
  return outcome || "pending";
}

export function isResolvedSignal(signal) {
  return ["small_loss", "small_profit", "big_profit", "big_loss", "win", "loss"].includes(signal?.outcome);
}

export function isWinSignal(signal) {
  return ["small_profit", "big_profit"].includes(outcomeBucket(signal));
}

export function isLossSignal(signal) {
  return ["small_loss", "big_loss"].includes(outcomeBucket(signal));
}

export function signalPnlR(signal) {
  const bucket = outcomeBucket(signal);
  const realizedR = Number(signal?.rMultiple);
  if (Number.isFinite(realizedR)) return realizedR;
  const rr = Math.max(Number(signal?.riskReward || 0), MIN_BIG_PROFIT_RR);
  if (bucket === "big_profit") return rr;
  if (bucket === "small_profit") return Math.max(0.5, Math.min(1.5, rr / 2));
  if (bucket === "small_loss") return -1;
  if (bucket === "big_loss") return -Math.max(3, rr);
  return 0;
}

export function buildSignalLearningProfile(records = []) {
  const resolved = records.filter(isResolvedSignal);
  const counts = { small_loss:0, small_profit:0, big_profit:0, big_loss:0 };
  resolved.forEach(signal => {
    const bucket = outcomeBucket(signal);
    if (counts[bucket] != null) counts[bucket] += 1;
  });

  const makeGroups = (keyFn, labelFn = keyFn) => {
    const groups = {};
    resolved.forEach(signal => {
      const key = keyFn(signal) || "Unknown";
      if (!groups[key]) groups[key] = { key, label:labelFn(signal) || key, total:0, wins:0, losses:0, bigProfit:0, bigLoss:0, totalRR:0 };
      const g = groups[key];
      const bucket = outcomeBucket(signal);
      g.total += 1;
      if (isWinSignal(signal)) {
        g.wins += 1;
        g.totalRR += Number(signal.riskReward || MIN_BIG_PROFIT_RR);
      }
      if (isLossSignal(signal)) g.losses += 1;
      if (bucket === "big_profit") g.bigProfit += 1;
      if (bucket === "big_loss") g.bigLoss += 1;
    });
    return Object.values(groups).map(g => ({
      ...g,
      winRate: g.wins + g.losses ? (g.wins / (g.wins + g.losses)) * 100 : null,
      avgRR: g.wins ? g.totalRR / g.wins : 0,
    }));
  };

  const groups = [
    ...makeGroups(s => `setup:${s.setup}`, s => s.setup || "Unknown setup"),
    ...makeGroups(s => `asset:${s.assetId}`, s => s.asset || s.assetId || "Unknown asset"),
    ...makeGroups(s => `tf:${s.timeframe}`, s => s.timeframe || "Unknown TF"),
    ...makeGroups(s => `nature:${s.nature}`, s => s.nature || "Unknown nature"),
  ];

  const avoid = groups
    .filter(g => g.total >= 2 && (g.bigLoss > 0 || (g.winRate != null && g.winRate < 45) || g.losses >= g.wins + 2))
    .sort((a,b) => (b.bigLoss - a.bigLoss) || (a.winRate ?? 100) - (b.winRate ?? 100) || b.total - a.total)
    .slice(0, 5);

  const favor = groups
    .filter(g => g.total >= 2 && g.bigLoss === 0 && g.winRate != null && g.winRate >= 60 && (g.bigProfit > 0 || g.avgRR >= MIN_BIG_PROFIT_RR))
    .sort((a,b) => (b.winRate - a.winRate) || b.bigProfit - a.bigProfit || b.avgRR - a.avgRR)
    .slice(0, 5);

  const notes = [];
  if (counts.big_loss > 0) notes.push("Big Loss detected in history. Tighten approval, keep stop final, and reject loose-risk setups.");
  if (counts.small_loss > counts.big_profit + counts.small_profit) notes.push("Small losses are leading. Require cleaner confluence before approving the next signal.");
  if (counts.big_profit === 0 && resolved.length >= 3) notes.push("No Big Profit captured yet. Favor setups with TP2 at 1:3 or better and trail only after TP1.");
  if (!notes.length) notes.push("No critical mistake pattern yet. Keep enforcing stops and 1:3+ TP2.");

  return {
    updatedAt: Date.now(),
    total: records.length,
    resolved: resolved.length,
    counts,
    winRate: resolved.length ? (resolved.filter(isWinSignal).length / resolved.length) * 100 : null,
    expectancyR: resolved.length ? resolved.reduce((sum, s) => sum + signalPnlR(s), 0) / resolved.length : 0,
    avoid,
    favor,
    notes,
  };
}

export function saveSignalLearning(records) {
  const profile = buildSignalLearningProfile(records);
  try { localStorage.setItem(SIGNAL_LEARNING_KEY, JSON.stringify(profile)); } catch {}
  return profile;
}

export function getSignalLearning() {
  try {
    const raw = localStorage.getItem(SIGNAL_LEARNING_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return buildSignalLearningProfile([]);
}

function wilsonLowerBound(wins, n, z = PROMOTION_POLICY.wilsonZ) {
  if (!n) return 0;
  const p = wins / n, z2 = z * z, den = 1 + z2 / n;
  return ((p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / den) * 100;
}

// Promotion is deliberately stricter than learning/tuning. It is an evidence
// report only; no broker execution is enabled by this function.
export function promotionGate(records = [], { strategyKey = null, paperOnly = true, policy = PROMOTION_POLICY } = {}) {
  const eligible = records.filter(t => isResolvedSignal(t)
    && (!paperOnly || t.tradeType === "Paper")
    && (!strategyKey || strategyVersionOf(t) === strategyKey))
    .sort((a, b) => Number(a.timestamp || a.entryTs || 0) - Number(b.timestamp || b.entryTs || 0));
  const wins = eligible.filter(isWinSignal).length;
  const losses = eligible.length - wins;
  const rValues = eligible.map(signalPnlR);
  const grossProfitR = rValues.filter(r => r > 0).reduce((s, r) => s + r, 0);
  const grossLossR = -rValues.filter(r => r < 0).reduce((s, r) => s + r, 0);
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const r of rValues) { equity += r; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity); }
  const winRatePct = eligible.length ? wins / eligible.length * 100 : 0;
  const expectancyR = eligible.length ? rValues.reduce((s, r) => s + r, 0) / eligible.length : 0;
  const profitFactor = grossLossR > 0 ? grossProfitR / grossLossR : grossProfitR > 0 ? Infinity : 0;
  const wilsonWinRatePct = wilsonLowerBound(wins, eligible.length, policy.wilsonZ);
  const checks = {
    sample: eligible.length >= policy.minResolvedTrades,
    winRate: winRatePct >= policy.minWinRatePct,
    expectancy: expectancyR >= policy.minExpectancyR,
    profitFactor: profitFactor >= policy.minProfitFactor,
    drawdown: maxDrawdownR <= policy.maxDrawdownR,
    confidence: wilsonWinRatePct >= policy.minWilsonWinRatePct,
  };
  const reasons = [];
  if (!checks.sample) reasons.push(`${eligible.length}/${policy.minResolvedTrades} resolved paper trades`);
  if (!checks.winRate) reasons.push(`win rate ${winRatePct.toFixed(1)}% < ${policy.minWinRatePct}%`);
  if (!checks.expectancy) reasons.push(`expectancy ${expectancyR.toFixed(2)}R < ${policy.minExpectancyR.toFixed(2)}R`);
  if (!checks.profitFactor) reasons.push(`profit factor ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"} < ${policy.minProfitFactor.toFixed(2)}`);
  if (!checks.drawdown) reasons.push(`drawdown ${maxDrawdownR.toFixed(2)}R > ${policy.maxDrawdownR.toFixed(2)}R`);
  if (!checks.confidence) reasons.push(`confidence lower bound ${wilsonWinRatePct.toFixed(1)}% < ${policy.minWilsonWinRatePct}%`);
  return { approved: Object.values(checks).every(Boolean), status: Object.values(checks).every(Boolean) ? "PROMOTION_ELIGIBLE" : "PAPER_ONLY",
    strategyKey, paperOnly, trades: eligible.length, wins, losses, winRatePct, expectancyR, profitFactor, maxDrawdownR, wilsonWinRatePct, checks, reasons,
    policy };
}

function strategyVersionOf(record) {
  const explicit = record?.strategyVersion;
  if (explicit === "nifty-option-scalp-v1") return "nifty-option-workflow-v1";
  if (explicit) return explicit;
  if (record?.source === "Zero-Hero") return "zero-hero-v1";
  if (record?.source === "Zero-Hero-v2") return "zero-hero-v2";
  if (record?.assetId === "NIFTY50") return "nifty-option-workflow-v1";
  if (record?.assetId === "SENSEX") return "sensex-option-workflow-v1";
  return "score-v1";
}

export function promotionGatesByStrategy(records = [], { paperOnly = true, policy = PROMOTION_POLICY, strategies = PROMOTION_STRATEGIES } = {}) {
  return strategies.map(strategy => ({ ...strategy, ...promotionGate(records, { strategyKey: strategy.key, paperOnly, policy }) }));
}
