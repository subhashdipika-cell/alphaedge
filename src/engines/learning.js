// ─── SIGNAL LEARNING ENGINE ───────────────────────────────────────────────────
// Pure outcome classification + a profile builder that groups resolved signals
// by setup / asset / timeframe / nature and emits avoid/favor lists. Asset-
// agnostic — the same machinery will drive the R&D factor-attribution engine
// (revamp Phase 8), grouping by score-factor tags instead of setup/asset.

export const SIGNAL_LEARNING_KEY = "alphaedge_signal_learning";
export const MIN_BIG_PROFIT_RR = 3;
export const MAX_SIGNAL_RISK_PCT = 1;

export function outcomeBucket(signalOrOutcome) {
  const outcome = typeof signalOrOutcome === "string" ? signalOrOutcome : signalOrOutcome?.outcome;
  if (outcome === "win") {
    const rr = typeof signalOrOutcome === "object" ? Number(signalOrOutcome?.riskReward || 0) : 0;
    return rr >= MIN_BIG_PROFIT_RR ? "big_profit" : "small_profit";
  }
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
