import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createChart, CandlestickSeries } from "lightweight-charts";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const ASSETS = [
  { id: "BTCUSD",  label: "BTC/USD",  base: 97420,  type: "crypto",     exchange: "Binance" },
  { id: "XAUUSD",  label: "XAU/USD",  base: 4538,   type: "commodity",  exchange: "OANDA"   },
  { id: "ETHUSD",  label: "ETH/USD",  base: 3184,   type: "crypto",     exchange: "Binance" },
  { id: "NIFTY50", label: "Nifty 50", base: 24800,  type: "index",      exchange: "NSE" },
];

const PAGES = ["Dashboard","AI Signal","Backtest","Execution","Portfolio","Alerts","History","Money Mgt.","Calendar","MTF Confluence","Journal","Analytics","Options","Settings"];
const PAGE_ICONS = ["▣","◈","⟳","⚡","◎","◉","◷","⚑","◫","◐","✎","◑","⊗","⚙"];

// ─── STORAGE HELPERS (30-day persistent signal history) ───────────────────────
const HISTORY_KEY = "signal-history";
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const SIGNAL_LEARNING_KEY = "alphaedge_signal_learning";
const MIN_BIG_PROFIT_RR = 3;
const MAX_SIGNAL_RISK_PCT = 1;

function outcomeBucket(signalOrOutcome) {
  const outcome = typeof signalOrOutcome === "string" ? signalOrOutcome : signalOrOutcome?.outcome;
  if (outcome === "win") {
    const rr = typeof signalOrOutcome === "object" ? Number(signalOrOutcome?.riskReward || 0) : 0;
    return rr >= MIN_BIG_PROFIT_RR ? "big_profit" : "small_profit";
  }
  if (outcome === "loss") return "small_loss";
  return outcome || "pending";
}

function isResolvedSignal(signal) {
  return ["small_loss", "small_profit", "big_profit", "big_loss", "win", "loss"].includes(signal?.outcome);
}

function isWinSignal(signal) {
  return ["small_profit", "big_profit"].includes(outcomeBucket(signal));
}

function isLossSignal(signal) {
  return ["small_loss", "big_loss"].includes(outcomeBucket(signal));
}

function signalPnlR(signal) {
  const bucket = outcomeBucket(signal);
  const rr = Math.max(Number(signal?.riskReward || 0), MIN_BIG_PROFIT_RR);
  if (bucket === "big_profit") return rr;
  if (bucket === "small_profit") return Math.max(0.5, Math.min(1.5, rr / 2));
  if (bucket === "small_loss") return -1;
  if (bucket === "big_loss") return -Math.max(3, rr);
  return 0;
}

function buildSignalLearningProfile(records = []) {
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

function saveSignalLearning(records) {
  const profile = buildSignalLearningProfile(records);
  try { localStorage.setItem(SIGNAL_LEARNING_KEY, JSON.stringify(profile)); } catch {}
  return profile;
}

function getSignalLearning() {
  try {
    const raw = localStorage.getItem(SIGNAL_LEARNING_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return buildSignalLearningProfile([]);
}

function getRiskPolicy() {
  let configuredRiskPct = 1;
  let configuredDailyPct = 3;
  try {
    const settings = loadSettings?.() || {};
    configuredRiskPct = Number(settings.risk?.maxRiskPct || 1) || 1;
    configuredDailyPct = Number(settings.risk?.maxDailyLoss || 3) || 3;
  } catch {}
  return {
    minRR: MIN_BIG_PROFIT_RR,
    maxRiskPct: Math.min(configuredRiskPct, MAX_SIGNAL_RISK_PCT),
    configuredRiskPct,
    maxDailyLossPct: configuredDailyPct,
  };
}

function signalRuleContextForPrompt(assetObj, tf, strategyName) {
  const learning = getSignalLearning();
  const policy = getRiskPolicy();
  const avoid = (learning.avoid || []).map(g => `${g.label} (${g.wins}W/${g.losses}L${g.bigLoss ? `, ${g.bigLoss} BL` : ""})`).slice(0, 3).join("; ") || "none yet";
  const favor = (learning.favor || []).map(g => `${g.label} (${g.winRate?.toFixed(0)}% WR, avg RR ${g.avgRR?.toFixed(1)})`).slice(0, 3).join("; ") || "none yet";
  const notes = (learning.notes || []).slice(0, 3).join(" ");
  const geoNow = getGeoAlerts()
    .filter(g => g.impact === "high" && (g.asset === "ALL" || g.asset === assetObj?.id || g.asset === (assetObj?.label||"").split("/")[0]))
    .map(g => g.text).slice(0, 3).join(" | ") || "no high-impact events flagged";
  return `ALPHAEDGE NON-NEGOTIABLE TRADING RULES:
1. Classify every approved signal into the 4 outcomes: Small Loss, Small Profit, Big Profit, Big Loss.
2. Big Loss is forbidden. Every signal must have a real stopLoss, no averaging down, no stop widening, and max planned account risk ${policy.maxRiskPct}%.
3. Small Loss and Small Profit can cancel out; account growth must come from Big Profit. TP2 must be at least 1:${policy.minRR}.
4. If the trade cannot meet these rules, return approved:false with noTradeReason instead of forcing a signal.
5. Include these JSON fields: quadrantPlan, ruleAudit, learningAdjustments.

LEARNING MEMORY FROM MARKED OUTCOMES:
Resolved signals: ${learning.resolved}; BP:${learning.counts?.big_profit || 0}, SP:${learning.counts?.small_profit || 0}, SL:${learning.counts?.small_loss || 0}, BL:${learning.counts?.big_loss || 0}.
Avoid or demand extra confirmation for: ${avoid}.
Prefer only when current confluence confirms: ${favor}.
Mistake notes: ${notes}

CURRENT GEOPOLITICAL / MACRO CONTEXT (factor this into bias & risk): ${geoNow}

Current request: ${assetObj.label} ${tf}, strategy ${strategyName}.`;
}

function enforceSignalRules(parsed, { assetObj, livePrice, source = "AI" }) {
  const policy = getRiskPolicy();
  const assetId = assetObj?.id;
  const toNum = v => Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  const entry = toNum(parsed.entry);
  const stopLoss = toNum(parsed.stopLoss);
  const takeProfit1 = toNum(parsed.takeProfit1);
  const takeProfit2 = toNum(parsed.takeProfit2);
  const bias = String(parsed.bias || "").toUpperCase();
  const isBull = bias === "BULLISH";
  const isBear = bias === "BEARISH";
  const violations = [];

  if (!isBull && !isBear) violations.push("bias must be BULLISH or BEARISH");
  if (![entry, stopLoss, takeProfit1, takeProfit2].every(Number.isFinite)) violations.push("entry, stopLoss, TP1, and TP2 are required");
  if (Number.isFinite(entry) && Number.isFinite(stopLoss) && entry === stopLoss) violations.push("stopLoss cannot equal entry");

  if (!violations.length) {
    if (isBull && !(stopLoss < entry && takeProfit1 > entry && takeProfit2 > entry)) violations.push("bullish levels must be SL below entry and targets above entry");
    if (isBear && !(stopLoss > entry && takeProfit1 < entry && takeProfit2 < entry)) violations.push("bearish levels must be SL above entry and targets below entry");
  }

  const risk = Math.abs(entry - stopLoss);
  const reward1 = Math.abs(takeProfit1 - entry);
  const reward2 = Math.abs(takeProfit2 - entry);
  const rrToTP1 = risk > 0 ? reward1 / risk : 0;
  const rrToTP2 = risk > 0 ? reward2 / risk : 0;
  const stopDistancePct = entry ? (risk / entry) * 100 : 0;
  const entryDriftPct = livePrice ? (Math.abs(entry - livePrice) / livePrice) * 100 : 0;
  const nature = String(parsed.nature || "Intraday");
  const baseStopPct = assetId === "NIFTY50" ? 0.9 : assetId === "XAUUSD" ? 0.8 : assetId === "ETHUSD" ? 2.5 : 2.0; // BTC 2%, ETH 2.5%
  const natureFactor = nature === "Swing" ? 2.5 : nature === "Scalping" ? 0.6 : 1;
  const maxStopPct = baseStopPct * natureFactor;
  const maxEntryDriftPct = assetId === "NIFTY50" ? 0.8 : assetId === "XAUUSD" ? 0.9 : 2.2;

  // Auto-correct TP2 to minimum RR if AI undershoots — don't hard-reject the signal
  let finalTP2 = takeProfit2;
  let finalRRtoTP2 = rrToTP2;
  if (!violations.length && rrToTP2 < policy.minRR - 0.05 && risk > 0) {
    finalTP2 = isBull
      ? Math.round((entry + risk * policy.minRR) * 100) / 100
      : Math.round((entry - risk * policy.minRR) * 100) / 100;
    finalRRtoTP2 = policy.minRR;
    parsed.takeProfit2 = finalTP2;
  }

  if (!violations.length) {
    if (stopDistancePct > maxStopPct) violations.push(`stop distance ${stopDistancePct.toFixed(2)}% exceeds ${maxStopPct.toFixed(2)}% cap`);
    if (entryDriftPct > maxEntryDriftPct) violations.push(`entry is ${entryDriftPct.toFixed(2)}% away from live price`);
  }

  if (violations.length) {
    throw new Error(`Signal rejected by AlphaEdge rules: ${violations.join("; ")}`);
  }

  const ruleAudit = {
    passed: true,
    source,
    minRR: policy.minRR,
    rrToTP1: Number(rrToTP1.toFixed(2)),
    rrToTP2: Number(finalRRtoTP2.toFixed(2)),
    stopDistancePct: Number(stopDistancePct.toFixed(2)),
    maxStopDistancePct: Number(maxStopPct.toFixed(2)),
    maxRiskPct: policy.maxRiskPct,
    stopIsMandatory: true,
    bigLossBlocked: true,
  };

  const quadrantPlan = {
    smallLoss: `Accept SL at ${stopLoss.toLocaleString()} with max ${policy.maxRiskPct}% account risk.`,
    smallProfit: `Use TP1 at ${takeProfit1.toLocaleString()} or trail; never widen SL.`,
    bigLoss: "Blocked: no stop removal, no averaging down, no revenge trade.",
    bigProfit: `Hold TP2 at ${finalTP2.toLocaleString()} for 1:${finalRRtoTP2} RR when trend confirms.`,
  };

  const learning = getSignalLearning();
  const learningSnapshot = {
    resolved: learning.resolved || 0,
    bigLosses: learning.counts?.big_loss || 0,
    expectancyR: Number((learning.expectancyR || 0).toFixed(2)),
    activeNotes: (learning.notes || []).slice(0, 2),
  };

  return {
    ...parsed,
    bias,
    nature,
    entry,
    stopLoss,
    takeProfit1,
    takeProfit2: finalTP2,
    riskReward: ruleAudit.rrToTP2,
    ruleAudit,
    quadrantPlan,
    learningSnapshot,
    learningAdjustments: parsed.learningAdjustments || learningSnapshot.activeNotes,
    riskWarning: [
      parsed.riskWarning,
      `AlphaEdge rule gate: Big Loss blocked, stop final, max planned risk ${policy.maxRiskPct}%, TP2 RR 1:${ruleAudit.rrToTP2}.`
    ].filter(Boolean).join(" "),
  };
}

async function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    const cutoff = Date.now() - THIRTY_DAYS;
    const filtered = arr.filter(s => s.timestamp > cutoff);
    saveSignalLearning(filtered);
    return filtered;
  } catch { return []; }
}

async function saveHistory(records) {
  try {
    const cutoff = Date.now() - THIRTY_DAYS;
    const pruned = records.filter(s => s.timestamp > cutoff);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(pruned));
    saveSignalLearning(pruned);
    archiveTrades(records);   // durable copy for the monthly Obsidian export
    return pruned;
  } catch { return records; }
}

// ─── DURABLE TRADE ARCHIVE (for monthly Obsidian export) ──────────────────────
// The live history above is pruned to 30 days, which would drop early-month
// trades before a month-end rollup can capture them. This archive is fed from
// the same saveHistory choke point, upserts by id (so later outcome updates win),
// and is kept ~400 days so a full month is always available to export.
const TRADE_ARCHIVE_KEY = "alphaedge_trade_archive";
const ARCHIVE_RETENTION = 400 * 24 * 60 * 60 * 1000;

function archiveTrades(records) {
  try {
    const raw  = localStorage.getItem(TRADE_ARCHIVE_KEY);
    const byId = new Map((raw ? JSON.parse(raw) : []).map(r => [r.id, r]));
    (records || []).forEach(r => { if (r && r.id) byId.set(r.id, { ...byId.get(r.id), ...r }); });
    const cutoff = Date.now() - ARCHIVE_RETENTION;
    const merged = [...byId.values()].filter(r => (r.timestamp || 0) > cutoff);
    localStorage.setItem(TRADE_ARCHIVE_KEY, JSON.stringify(merged));
  } catch { /* archive is best-effort — never break a normal save */ }
}

function loadTradeArchive() {
  try { const raw = localStorage.getItem(TRADE_ARCHIVE_KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}

async function appendSignal(signal) {
  const existing = await loadHistory();
  const updated = [signal, ...existing];
  return saveHistory(updated);
}

async function updateOutcome(id, outcome) {
  const existing = await loadHistory();
  const updated = existing.map(s => s.id === id ? { ...s, outcome } : s);
  const saved = saveHistory(updated);
  // Re-train the learning profile every time an outcome is marked — this is how
  // the AI's intelligence grows from real results over time.
  try { saveSignalLearning(updated); } catch { /* ignore */ }
  return saved;
}

// ─── MONTHLY OBSIDIAN EXPORT ──────────────────────────────────────────────────
// At the end of each month the completed month's trades are rolled up into one
// markdown file and written (via the local bridge — a browser can't touch E:\)
// to  E:\Obsidian\Trading_Mind\raw\trades\alphaedge\<YYYY-MM>.md  for Obsidian to
// ingest and analyse. "Catch-up on load": we export any completed, not-yet-
// exported month whenever the app starts, so it survives the app/bridge not
// running exactly at midnight on the 1st.
const OBSIDIAN_APP        = "alphaedge";                    // subfolder name
const OBSIDIAN_EXPORT_KEY = "alphaedge_obsidian_exported";  // months already written

// IST = UTC + 5:30. Shift the instant by +330 min and read UTC fields, so the
// result is IST wall-clock regardless of the machine's own timezone.
const IST_SHIFT_MS = 330 * 60000;
// "YYYY-MM" for a timestamp, in IST (the app's reference zone).
function istMonthKey(ts) {
  const i = new Date(Number(ts) + IST_SHIFT_MS);
  return `${i.getUTCFullYear()}-${String(i.getUTCMonth() + 1).padStart(2, "0")}`;
}
function istStamp(ts) {
  const i = new Date(Number(ts) + IST_SHIFT_MS);
  const p = n => String(n).padStart(2, "0");
  return `${i.getUTCFullYear()}-${p(i.getUTCMonth() + 1)}-${p(i.getUTCDate())} ${p(i.getUTCHours())}:${p(i.getUTCMinutes())}`;
}
// Sanitise a value for a markdown table cell (no pipes / newlines break the row).
const mdCell = v => String(v == null || v === "" ? "—" : v).replace(/\|/g, "/").replace(/\s*\n\s*/g, " ");

function monthlyTradeStats(records) {
  const wins     = records.filter(isWinSignal).length;
  const losses   = records.filter(isLossSignal).length;
  const resolved = records.filter(isResolvedSignal).length;
  const rrVals   = records.map(r => Number(r.riskReward || 0)).filter(x => x > 0);
  return {
    total: records.length, wins, losses, resolved, pending: records.length - resolved,
    winRate: (wins + losses) ? (wins / (wins + losses)) * 100 : null,
    netR:    records.reduce((s, r) => s + signalPnlR(r), 0),
    avgRR:   rrVals.length ? rrVals.reduce((a, b) => a + b, 0) / rrVals.length : 0,
  };
}

function monthlyGroupRows(records, keyFn) {
  const g = {};
  records.forEach(r => {
    const k = keyFn(r) || "Unknown";
    const x = (g[k] = g[k] || { total:0, wins:0, losses:0, rr:0, rrN:0 });
    x.total += 1;
    if (isWinSignal(r))  x.wins   += 1;
    if (isLossSignal(r)) x.losses += 1;
    const rr = Number(r.riskReward || 0);
    if (rr > 0) { x.rr += rr; x.rrN += 1; }
  });
  return Object.entries(g)
    .map(([label, x]) => ({ label, total:x.total, wins:x.wins, losses:x.losses,
      winRate: (x.wins + x.losses) ? (x.wins / (x.wins + x.losses)) * 100 : null,
      avgRR:   x.rrN ? x.rr / x.rrN : 0 }))
    .sort((a, b) => b.total - a.total);
}

// Build the full monthly rollup markdown (YAML frontmatter + summary + breakdowns
// + every trade) for Obsidian.
function buildMonthlyMarkdown(month, records) {
  const s   = monthlyTradeStats(records);
  const pct = v => v == null ? "—" : `${v.toFixed(0)}%`;
  const dir = b => b === "BULLISH" ? "LONG" : b === "BEARISH" ? "SHORT" : (b || "—");
  const oc  = r => isWinSignal(r) ? "WIN" : isLossSignal(r) ? "LOSS"
                 : (!r.outcome || r.outcome === "pending") ? "PENDING" : String(r.outcome).toUpperCase();
  const [yr, mo] = month.split("-");
  const monthName = new Date(Date.UTC(+yr, +mo - 1, 1)).toLocaleString("en-US", { month: "long" });
  const wr = s.winRate == null ? "" : s.winRate.toFixed(1);

  const section = (title, rows) => {
    let t = `\n## By ${title}\n\n| ${title[0].toUpperCase() + title.slice(1)} | Trades | Win% | Avg RR |\n|---|---|---|---|\n`;
    rows.forEach(r => { t += `| ${mdCell(r.label)} | ${r.total} | ${pct(r.winRate)} | ${r.avgRR.toFixed(2)} |\n`; });
    return t;
  };

  // Broker-realized stats — ONLY trades that actually filled and closed on
  // MT5 (realizedUsd synced from the bridge). The theoretical R/win-rate above
  // counts unresolved signals at their planned RR; cross-app audit (Jul 2026)
  // showed that flatters strategies by 3-8x vs what the broker actually pays.
  const mt5 = records.filter(r => r.realizedUsd != null && (r.mt5State === "closed" || r.outcome === "win" || r.outcome === "loss"));
  const mt5Wins = mt5.filter(r => Number(r.realizedUsd) > 0).length;
  const mt5Net  = mt5.reduce((a, r) => a + Number(r.realizedUsd || 0), 0);
  const mt5Wr   = mt5.length ? (100 * mt5Wins / mt5.length) : null;

  let md = `---\n`
    + `type: monthly-trade-summary\n`
    + `app: ${OBSIDIAN_APP}\n`
    + `month: ${month}\n`
    + `generated: ${new Date().toISOString()}\n`
    + `trades: ${s.total}\n`
    + `resolved: ${s.resolved}\n`
    + `pending: ${s.pending}\n`
    + `wins: ${s.wins}\n`
    + `losses: ${s.losses}\n`
    + `win_rate: ${wr}\n`
    + `net_r: ${s.netR.toFixed(1)}\n`
    + `avg_rr: ${s.avgRR.toFixed(2)}\n`
    + `mt5_trades: ${mt5.length}\n`
    + `mt5_win_rate: ${mt5Wr == null ? "" : mt5Wr.toFixed(1)}\n`
    + `mt5_net_usd: ${mt5Net.toFixed(2)}\n`
    + `tags:\n  - ${OBSIDIAN_APP}\n  - monthly\n  - trades\n  - ${month}\n`
    + `---\n\n`;
  md += `# AlphaEdge — ${monthName} ${yr} Trade Summary\n\n`;
  md += `**${s.total} trades** · ${s.wins}W / ${s.losses}L · **${wr || "—"}% win rate** · `
      + `net **${s.netR >= 0 ? "+" : ""}${s.netR.toFixed(1)}R** · avg RR ${s.avgRR.toFixed(2)} · ${s.pending} pending\n`;
  md += `\n> **Broker-realized (MT5 fills, net of spread): ${mt5.length} trades · `
      + `${mt5Wr == null ? "—" : mt5Wr.toFixed(1) + "%"} win rate · `
      + `${mt5Net >= 0 ? "+" : ""}$${mt5Net.toFixed(2)}.** `
      + `The theoretical figures above count unresolved signals at planned RR — `
      + `trust this line, not those.\n`;
  md += section("setup",     monthlyGroupRows(records, r => r.setup));
  md += section("asset",     monthlyGroupRows(records, r => r.asset || r.assetId));
  md += section("timeframe", monthlyGroupRows(records, r => r.timeframe));
  md += section("session",   monthlyGroupRows(records, r => r.session));
  md += `\n## Trades\n\n| Date (IST) | Session | Asset | Dir | Nature | TF | Setup | Conf | Outcome | RR |\n`
      + `|---|---|---|---|---|---|---|---|---|---|\n`;
  [...records].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)).forEach(r => {
    md += `| ${istStamp(r.timestamp)} | ${mdCell(r.session)} | ${mdCell(r.asset || r.assetId)} | ${dir(r.bias)} | `
        + `${mdCell(r.nature)} | ${mdCell(r.timeframe)} | ${mdCell(r.setup)} | `
        + `${r.confidence != null ? r.confidence + "%" : "—"} | ${oc(r)} | `
        + `${r.riskReward != null ? Number(r.riskReward).toFixed(1) : "—"} |\n`;
  });
  md += `\n_Generated by AlphaEdge for Obsidian ingestion._\n`;
  return md;
}

// Exporter. Default (auto, on load): write any COMPLETED month not yet exported.
// Manual button passes { includeCurrent:true, force:true } to also push the
// in-progress month and re-write already-exported months on demand. Reads the
// durable archive (not the 30-day history) so full months survive. Returns a
// {ok, written[], failed[]} summary for UI feedback; retries next launch if the
// bridge is offline.
async function exportMonthlyToObsidian(opts = {}) {
  const { includeCurrent = false, force = false } = opts;
  const base = (getAnyBridgeUrl() || "").replace(/\/signal\/?$/, "");
  if (!base) return { ok: false, error: "no bridge URL set", written: [], failed: [] };

  let done = [];
  try { done = JSON.parse(localStorage.getItem(OBSIDIAN_EXPORT_KEY) || "[]"); } catch { /* start fresh */ }

  const archive = loadTradeArchive();
  if (!archive.length) return { ok: true, written: [], failed: [], note: "no trades to export yet" };

  const current = istMonthKey(Date.now());
  const byMonth = {};
  archive.forEach(r => { if (r && r.timestamp) (byMonth[istMonthKey(r.timestamp)] ||= []).push(r); });

  const months = Object.keys(byMonth)
    .filter(m => (includeCurrent || m < current) && (force || !done.includes(m)) && byMonth[m].length)
    .sort();

  const written = [], failed = [];
  for (const m of months) {
    try {
      const markdown = buildMonthlyMarkdown(m, byMonth[m]);
      const resp = await fetch(`${base}/obsidian/monthly`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ app: OBSIDIAN_APP, month: m, markdown }),
        signal:  AbortSignal.timeout(6000),
      });
      const d = await resp.json().catch(() => null);
      if (resp.ok && d && d.ok) {
        if (!done.includes(m)) done.push(m);
        localStorage.setItem(OBSIDIAN_EXPORT_KEY, JSON.stringify(done));
        written.push(m);
        console.info(`[AlphaEdge] Exported ${m} trades to Obsidian → ${d.path}`);
      } else {
        failed.push(m);
        console.warn(`[AlphaEdge] Obsidian export for ${m} failed:`, (d && d.error) || resp.status);
      }
    } catch (e) {
      failed.push(m);
      console.warn(`[AlphaEdge] Obsidian export for ${m} skipped (bridge offline?):`, String(e));
    }
  }
  return { ok: failed.length === 0, written, failed };
}

// Link a saved AlphaEdge signal to the MT5 position it opened, so the History
// page can pull the real outcome (win/loss + P&L) back from the terminal.
async function attachMt5Ticket(id, result) {
  try {
    const ticket = result && (result.order || result.ticket);
    if (!ticket) return;
    const existing = await loadHistory();
    const updated = existing.map(s => s.id === id
      ? { ...s, mt5Ticket: ticket, mt5Status: result.account || (result.paper ? "paper" : "sent") }
      : s);
    saveHistory(updated);
  } catch { /* non-fatal */ }
}

// Seed / offline-fallback geo alerts. Shown only until a live fetch succeeds
// (or if every news source is unreachable). Real alerts come from fetchGeoAlerts().
const GEO_ALERTS_FALLBACK = [
  { text: "Fed rate decision in 18h — expect 80bps gap across majors", impact: "high", asset: "ALL", time: "2h ago", category: "Macro" },
  { text: "Middle East escalation overnight — safe-haven bid for Gold", impact: "high", asset: "XAU", time: "4h ago", category: "Geopolitical" },
  { text: "US-China tariff update — risk-off, crypto correlation 0.84", impact: "medium", asset: "BTC", time: "6h ago", category: "Trade" },
  { text: "ECB dovish pivot signal — EUR weakness, USD strength", impact: "medium", asset: "DXY", time: "8h ago", category: "Macro" },
  { text: "RBI holds rates at 6.25% — Nifty 50 rally expected on liquidity boost", impact: "high", asset: "NIFTY50", time: "3h ago", category: "India" },
  { text: "FII net buyers ₹4,200 Cr — bullish for Indian indices", impact: "medium", asset: "NIFTY50", time: "9h ago", category: "India" },
  { text: "OPEC+ surprise cut 500k bpd — commodity repricing", impact: "low", asset: "OIL", time: "12h ago", category: "Energy" },
];

// Live cache, populated by fetchGeoAlerts(). Kept at module scope so both the
// homepage panel and the AI-prompt builder read the same freshest data.
let LIVE_GEO_ALERTS = null;   // array once a fetch has succeeded, else null

// Backwards-compatible accessor: freshest live alerts, else the static seed.
function getGeoAlerts() {
  return (LIVE_GEO_ALERTS && LIVE_GEO_ALERTS.length) ? LIVE_GEO_ALERTS : GEO_ALERTS_FALLBACK;
}

// "3h ago" style relative time from an epoch-ms timestamp.
function geoTimeAgo(ts) {
  if (!ts) return "";
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60)      return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60)      return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)       return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Classify a headline into impact / asset / category by keyword. Best-effort —
// this is macro-context flavour for the UI and the AI prompt, not trade logic.
function classifyGeoHeadline(title) {
  const t = (title || "").toLowerCase();
  const hi  = /\b(fed|fomc|rate cut|rate hike|rate decision|interest rate|inflation|cpi|ppi|nfp|payroll|jobs report|recession|war|invasion|missile|sanction|tariff|rbi|ecb|boj|default|crisis|shutdown|election|opec)\b/;
  const med = /\b(gdp|unemployment|retail sales|earnings|yield|dollar|treasury|oil|crude|gold|bitcoin|crypto|nifty|sensex|fii|dii|budget)\b/;
  const impact = hi.test(t) ? "high" : med.test(t) ? "medium" : "low";

  let asset = "ALL";
  if (/\b(gold|xau|bullion|safe.?haven)\b/.test(t)) asset = "XAU";
  else if (/\b(bitcoin|btc|crypto|ethereum|eth)\b/.test(t)) asset = "BTC";
  else if (/\b(nifty|sensex|rbi|india|fii|dii|nse|bse)\b/.test(t)) asset = "NIFTY50";
  else if (/\b(dollar|dxy|fed|fomc|treasury|yield)\b/.test(t)) asset = "DXY";
  else if (/\b(oil|crude|opec|brent|wti)\b/.test(t)) asset = "OIL";

  let category = "Macro";
  if (/\b(war|invasion|missile|sanction|geopolit|middle east|ukraine|taiwan)\b/.test(t)) category = "Geopolitical";
  else if (/\b(tariff|trade war|export|import)\b/.test(t)) category = "Trade";
  else if (/\b(rbi|nifty|sensex|india|fii|dii)\b/.test(t)) category = "India";
  else if (/\b(oil|crude|opec|energy|gas)\b/.test(t)) category = "Energy";

  return { impact, asset, category };
}

// Macro / geopolitical news RSS feeds — free, no API key. Tried in order; the
// first that returns usable items wins.
const GEO_NEWS_FEEDS = [
  "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258", // CNBC Economy
  "https://feeds.marketwatch.com/marketwatch/topstories/",                                // MarketWatch Top Stories
  "https://www.investing.com/rss/news_25.rss",                                            // Investing.com Economy
];

// Public CORS proxies, tried in order. Third-party feeds (RSS/JSON) don't send
// CORS headers, so a proxy is required from the browser. corsproxy.io is primary
// (reliable); allorigins is a fallback — proxies do go down (503), so we never
// rely on one. Shared by the geo-alerts and economic-calendar fetchers.
const CORS_PROXIES = [
  u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
];

// Fetch one RSS feed through the proxy chain; returns its XML text or null.
async function fetchFeedXml(feed) {
  for (const proxy of CORS_PROXIES) {
    try {
      const resp = await fetch(proxy(feed), { signal: AbortSignal.timeout(7000) });
      if (!resp.ok) continue;
      const xml = await resp.text();
      if (xml && xml.includes("<")) return xml;   // looks like markup
    } catch { /* try next proxy */ }
  }
  return null;
}

// Fetch live macro/geo headlines and normalise them into the GEO_ALERTS shape.
// Returns an array on success (and updates the module cache), or null if every
// source failed — callers then keep showing the last cache / static fallback.
async function fetchGeoAlerts() {
  for (const feed of GEO_NEWS_FEEDS) {
    const xml = await fetchFeedXml(feed);
    if (!xml) continue;
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    if (doc.querySelector("parsererror")) continue;

    const items = Array.from(doc.querySelectorAll("item, entry")).slice(0, 12);
    const alerts = items.map(it => {
      const title = (it.querySelector("title")?.textContent || "").trim();
      if (!title) return null;
      const dateStr = it.querySelector("pubDate, published, updated")?.textContent || "";
      const ts = dateStr ? Date.parse(dateStr) : NaN;
      const { impact, asset, category } = classifyGeoHeadline(title);
      return {
        text: title,
        impact, asset, category,
        ts: Number.isNaN(ts) ? Date.now() : ts,
        time: Number.isNaN(ts) ? "" : geoTimeAgo(ts),
      };
    }).filter(Boolean);

    if (!alerts.length) continue;
    // Highest-impact first, then most recent.
    const rank = { high: 0, medium: 1, low: 2 };
    alerts.sort((a, b) => (rank[a.impact] - rank[b.impact]) || (b.ts - a.ts));
    LIVE_GEO_ALERTS = alerts;
    return alerts;
  }
  return null;
}

const STRATEGIES = [
  { id:"ict_ob",    name:"ICT Order Blocks",   cat:"ICT",     active:true,  winRate:71, trades:184 },
  { id:"ict_fvg",   name:"Fair Value Gap",      cat:"ICT",     active:true,  winRate:68, trades:210 },
  { id:"smc_mss",   name:"SMC MSS / BOS",       cat:"SMC",     active:true,  winRate:65, trades:156 },
  { id:"smc_choch", name:"CHoCH Detection",     cat:"SMC",     active:false, winRate:62, trades:98  },
  { id:"liq_sweep", name:"Liquidity Sweeps",    cat:"ICT",     active:true,  winRate:73, trades:132 },
  { id:"pd_array",  name:"PD Arrays",           cat:"ICT",     active:false, winRate:67, trades:77  },
  { id:"rsi_div",   name:"RSI Divergence",      cat:"Classic", active:true,  winRate:59, trades:341 },
  { id:"ema_trend", name:"EMA Trend Follow",    cat:"Classic", active:false, winRate:55, trades:290 },
  { id:"bb_squeeze",name:"BB Squeeze",          cat:"Classic", active:false, winRate:61, trades:188 },
  { id:"geo_hedge", name:"Geo-risk Hedging",    cat:"Macro",   active:false, winRate:64, trades:55  },
  { id:"sent_over", name:"Sentiment Overlay",   cat:"Macro",   active:true,  winRate:60, trades:120 },
  { id:"ema_9_20",     name:"9/20 EMA Pullback",  cat:"Classic", active:true,  winRate:0,  trades:0   },
  { id:"golden_setup", name:"Golden Setup",       cat:"Classic", active:true,  winRate:0,  trades:0   },
  { id:"adaptive_sr",  name:"Adaptive S/R Pro",   cat:"SMC",     active:true,  winRate:0,  trades:0   },
];

const OPEN_POSITIONS = [
  { id:"P001", asset:"BTC/USD", dir:"LONG",  entry:96800,  current:97420, size:0.5,  sl:95200, tp:99400, pnl:310,  pct:2.4,  strategy:"ICT OB", time:"3h 22m" },
  { id:"P002", asset:"XAU/USD", dir:"LONG",  entry:2330,   current:2341,  size:2,    sl:2310,  tp:2390,  pnl:22,   pct:0.47, strategy:"Macro",  time:"1h 08m" },
  { id:"P003", asset:"ETH/USD", dir:"SHORT", entry:3210,   current:3184,  size:3,    sl:3290,  tp:3000,  pnl:78,   pct:0.81, strategy:"SMC BOS",time:"45m"    },
];

const CAT_COLOR = { ICT:"#f59e0b", SMC:"#06b6d4", Classic:"#a78bfa", Macro:"#34d399" };

// ─── HELPERS ──────────────────────────────────────────────────────────────────
// ─── AI PROVIDER SYSTEM ───────────────────────────────────────────────────────
// Supports: DeepSeek, Google Gemini (FREE), Groq (FREE), OpenRouter

function getApiKey()    { return localStorage.getItem("alphaedge_api_key")      || ""; }
function setApiKey(k)   { localStorage.setItem("alphaedge_api_key", k.trim()); }
function getGeminiKey() { return localStorage.getItem("alphaedge_gemini_key")   || ""; }
function setGeminiKey(k){ localStorage.setItem("alphaedge_gemini_key", k.trim()); }
function getGroqKey()   { return localStorage.getItem("alphaedge_groq_key")     || ""; }
function setGroqKey(k)  { localStorage.setItem("alphaedge_groq_key", k.trim()); }
function getAIProvider(){
  const provider = localStorage.getItem("alphaedge_ai_provider") || "groq";
  return provider === "anthropic" ? "deepseek" : provider;
}
function setAIProvider(p){ localStorage.setItem("alphaedge_ai_provider", p); }
function getOpenRouterKey(){ return localStorage.getItem("alphaedge_openrouter_key") || ""; }
function setOpenRouterKey(k){ localStorage.setItem("alphaedge_openrouter_key", k.trim()); }
function getDeepSeekKey(){ return localStorage.getItem("alphaedge_deepseek_key") || localStorage.getItem("alphaedge_api_key") || ""; }
function setDeepSeekKey(k){ localStorage.setItem("alphaedge_deepseek_key", k.trim()); }

// ── Unified AI caller — picks active provider ──────────────────────────────
// ── Obsidian wiki context fetcher ─────────────────────────────────────────────
async function fetchWikiContext(assetId, strategy) {
  try {
    const bridgeUrl = getAnyBridgeUrl();
    if (!bridgeUrl) return "";
    const base = bridgeUrl.replace(/\/signal\/?$/, "");
    const resp = await fetch(
      `${base}/wiki/context?asset=${encodeURIComponent(assetId)}&strategy=${encodeURIComponent(strategy)}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!resp.ok) return "";
    const data = await resp.json();
    return data.context || "";
  } catch {
    return ""; // bridge offline — silently skip wiki context
  }
}

async function callAI(prompt, maxTokens=1000) {
  const provider = getAIProvider();

  // ── Groq (FREE — Llama 3.3 70B, 14,400 req/day, works in India) ───────────
  if (provider === "groq") {
    const key = getGroqKey();
    if (!key) throw new Error("NO_KEY");
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:  "POST",
      headers: { "Content-Type":"application/json", "Authorization":`Bearer ${key}` },
      body: JSON.stringify({
        model:      "llama-3.3-70b-versatile",
        max_tokens: maxTokens,
        messages:   [{ role:"user", content:prompt }],
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(()=>({}));
      throw new Error(err?.error?.message || `Groq HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return { content:[{ type:"text", text: data?.choices?.[0]?.message?.content||"" }] };
  }

  // ── OpenRouter (FREE — many models, works globally including India) ─────────
  if (provider === "openrouter") {
    const key = getOpenRouterKey();
    if (!key) throw new Error("NO_KEY");
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${key}`,
        "HTTP-Referer":  "http://localhost:3000",
        "X-Title":       "AlphaEdge Trading",
      },
      body: JSON.stringify({
        model:      "openai/gpt-oss-120b:free",
        max_tokens: maxTokens,
        messages:   [{ role:"user", content:prompt }],
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(()=>({}));
      throw new Error(err?.error?.message || `OpenRouter HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return { content:[{ type:"text", text: data?.choices?.[0]?.message?.content||"" }] };
  }

  // ── Google Gemini (restricted in some regions — use Groq/OpenRouter instead) 
  if (provider === "gemini") {
    const key = getGeminiKey();
    if (!key) throw new Error("NO_KEY");
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method:  "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          contents:         [{ parts:[{ text:prompt }] }],
          generationConfig: { maxOutputTokens:maxTokens, temperature:0.7 },
        }),
      }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(()=>({}));
      throw new Error(err?.error?.message || `Gemini HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return { content:[{ type:"text", text: data?.candidates?.[0]?.content?.parts?.[0]?.text||"" }] };
  }

  // ── DeepSeek (OpenAI-compatible) ───────────────────────────────────────────
  const key = getDeepSeekKey();
  if (!key) throw new Error("NO_KEY");
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model:      "deepseek-v4-pro",
      max_tokens: maxTokens,
      messages:   [{ role:"user", content:prompt }],
      stream:     false,
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(()=>({}));
    throw new Error(err?.error?.message || `DeepSeek HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return { content:[{ type:"text", text: data?.choices?.[0]?.message?.content||"" }] };
}

// Legacy alias so older call sites keep working.

// ─── TELEGRAM HELPERS ────────────────────────────────────────────────────────
function getTgToken()  { return localStorage.getItem("alphaedge_tg_token") || ""; }
function getTgChatId() { return localStorage.getItem("alphaedge_tg_chat")  || ""; }
function setTgToken(v) { localStorage.setItem("alphaedge_tg_token", v.trim()); }
function setTgChatId(v){ localStorage.setItem("alphaedge_tg_chat",  v.trim()); }

// Stamped on every alert so this bot's messages are distinguishable from the
// other MT5 apps that post to the same Telegram chat.
const TG_BANNER = "🤖 <b>AlphaEdge</b>";

async function sendTelegram(text) {
  const token  = getTgToken();
  const chatId = getTgChatId();
  if (!token || !chatId) return { ok:false, error:"Token or Chat ID not set in Settings" };
  const body = String(text).startsWith(TG_BANNER) ? text : `${TG_BANNER}\n\n${text}`;
  try {
    // Use HTML parse_mode — much safer than Markdown (no special character conflicts)
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: body, parse_mode: "HTML" }),
    });
    if (resp.ok) return { ok:true };
    const err = await resp.json().catch(()=>({}));
    return { ok:false, error: err?.description || `HTTP ${resp.status}` };
  } catch(e) {
    return { ok:false, error: e.message };
  }
}

// Telegram alerts are restricted to ACTUAL trade events (placed / closed) — no
// signal-generation spam. Used for both MT5 and Dhan fills.
function buildTradeAlert(event, t) {
  const e = s => String(s ?? "");
  const sideTxt = String(t.side || "").toUpperCase().startsWith("B") ? "▲ BUY" : "▼ SELL";
  if (event === "placed") {
    return `🟢 <b>TRADE PLACED</b> · ${e(t.venue || "MT5")}\n` +
      `${sideTxt} <b>${e(t.symbol)}</b>${t.qty ? ` ×${e(t.qty)}` : ""}\n` +
      `Entry <code>${e(t.price)}</code>${t.lot ? ` · Lot <code>${e(t.lot)}</code>` : ""}` +
      (t.sl ? `\nSL <code>${e(t.sl)}</code>` : "") + (t.tp ? ` · TP <code>${e(t.tp)}</code>` : "") +
      (t.ticket ? `\n#${e(t.ticket)}` : "");
  }
  const pnl = Number(t.profit || 0);
  // Spell out PROFIT / LOSS with a signed $ amount — no ambiguity.
  const word   = pnl >= 0 ? "✅ PROFIT" : "🔴 LOSS";
  const pnlStr = `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}`;
  return `📉 <b>TRADE CLOSED</b> · ${e(t.venue || "MT5")}\n` +
    `<b>${e(t.symbol)}</b> ${e(String(t.side || "").toUpperCase())}\n` +
    `Result: ${word} <b>${pnlStr}</b>` +
    (t.open_price != null ? `\nIn <code>${e(t.open_price)}</code> → Out <code>${e(t.close_price)}</code>` : "") +
    (t.ticket ? `\n#${e(t.ticket)}` : "");
}
async function sendTradeAlert(event, t) {
  try { return await sendTelegram(buildTradeAlert(event, t)); } catch { return { ok:false }; }
}

// ─── MT5 TERMINAL BRIDGE ──────────────────────────────────────────────────────
// A browser can't talk to the MT5 terminal directly, so every signal is POSTed to
// the bridge URL configured in Settings (MetaApi, or a local bridge beside MT5).
// Paper mode uses the Demo account config; Live mode uses the Live account config.
// Execution mode is the master switch (set from the Execution page tabs):
//   "paper"     -> simulated only, nothing sent to MT5
//   "mt5_demo"  -> orders sent to the MT5 Demo account
//   "mt5_live"  -> orders sent to the MT5 Live (real) account
function getExecMode() {
  try {
    const s = JSON.parse(localStorage.getItem("alphaedge_settings") || "{}");
    if (s?.broker?.execMode) return s.broker.execMode;
    return s?.broker?.mode === "live" ? "mt5_live" : "paper";  // back-compat
  } catch { return "paper"; }
}

function setExecMode(mode) {
  try {
    const s = JSON.parse(localStorage.getItem("alphaedge_settings") || "{}");
    s.broker = { ...(s.broker || {}), execMode: mode };
    localStorage.setItem("alphaedge_settings", JSON.stringify(s));
  } catch { /* ignore */ }
}

// The local bridge always listens here; used as the default when no URL is set.
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:5000/signal";

function getMT5Config() {
  try {
    const s = JSON.parse(localStorage.getItem("alphaedge_settings") || "{}");
    const em = getExecMode();
    if (em === "paper") return { execMode: "paper", account: "paper", paper: true };
    const which = em === "mt5_live" ? "live" : "demo";
    const acct = s?.broker?.mt5?.[which] || {};
    // Default to the local bridge if no URL is configured (it runs on :5000).
    return { execMode: em, account: which, paper: false, ...acct, bridgeUrl: acct.bridgeUrl || DEFAULT_BRIDGE_URL };
  } catch { return { execMode: "paper", account: "paper", paper: true }; }
}

async function sendToMT5(parsed, assetLabel, tf) {
  const cfg = getMT5Config();
  // Paper Trade mode: simulated only — never send an order to MT5.
  if (cfg.paper) return { ok:true, paper:true, skipped:true };
  if (!cfg.bridgeUrl) return { ok:false, error:"No MT5 bridge URL set in Settings → MT5 Terminal" };

  // ── Discipline guardrails — enforce on LIVE money only ──────────────────────
  // In DEMO we deliberately send EVERY signal so the weekly/monthly dataset is
  // complete (all sessions, all setups) for analysing trade quality. The
  // Discipline Monitor still shows live status; real capital stays protected.
  if (cfg.execMode === "mt5_live") {
    try {
      const gr = evaluateGuardrails(await loadHistory(), parsed, assetLabel);
      if (gr.blocked) {
        const reason = gr.violations[0];
        console.warn("[AlphaEdge] LIVE trade blocked by guardrail:", gr.violations.join("; "));
        return { ok:false, blocked:true, guardrail:true, error:`Blocked by discipline rule: ${reason}`, violations: gr.violations };
      }
    } catch { /* never let the guardrail check itself break execution */ }
  }

  // ── Apply Money Management rules (from the Money Mgt. page) ────────────────
  const mm = getMoneyMgt();
  const isBuy = parsed.bias === "BULLISH";
  const entry = Number(parsed.entry) || 0;
  // Stop loss: use the fixed SL distance if enabled, else the signal's own SL.
  let stopLoss = Number(parsed.stopLoss) || 0;
  if (mm.useSL && mm.slPoints > 0 && entry) {
    stopLoss = isBuy ? entry - mm.slPoints : entry + mm.slPoints;
  }
  const slDist = entry && stopLoss ? Math.abs(entry - stopLoss) : 0;
  // "Trail" mode: run until a far R:R (up to 1:50) with the trailing stop active.
  const trailMode = mm.rr === "trail";
  const rr = trailMode ? Math.min(50, Number(mm.trailMaxRR) || 10) : (Number(mm.rr) || 2);
  const stepTrailEnabled = trailMode ? true : (mm.stepTrailEnabled !== false && !!mm.trailAfter1R);
  const trailAfter1R = stepTrailEnabled;
  const beTriggerR = Math.max(0.1, Number(mm.beTriggerR) || 1);
  const trailStartR = Math.max(beTriggerR, Number(mm.trailStartR) || beTriggerR);
  const trailStepPoints = Math.max(0, Number(mm.trailStepPoints) || 500);
  const trailDistancePoints = Math.max(0, Number(mm.trailDistancePoints) || 500);
  let takeProfit1 = Number(parsed.takeProfit1) || 0;
  let takeProfit2 = Number(parsed.takeProfit2) || 0;
  if (slDist && entry) {
    takeProfit1 = isBuy ? entry + slDist * rr : entry - slDist * rr;
    // In trail mode the single far target is the cap; otherwise TP2 extends a bit.
    const rr2 = trailMode ? rr : rr * 1.5;
    takeProfit2 = isBuy ? entry + slDist * rr2 : entry - slDist * rr2;
  }

  const order = {
    account:    cfg.account,                 // "demo" | "live"
    login:      cfg.login || "",
    server:     cfg.server || "",
    symbol:     assetLabel || "",
    timeframe:  tf || "",
    side:       parsed.bias === "BULLISH" ? "buy" : parsed.bias === "BEARISH" ? "sell" : "flat",
    bias:       parsed.bias,
    entry:      parsed.entry,
    stopLoss,
    takeProfit1,
    takeProfit2,
    lot:          mm.lotSize,        // fixed lot from Money Mgt.
    rr,                              // reward:risk used
    trailAfter1R,                    // bridge trails SL after the configured R trigger
    stepTrailEnabled,
    beTriggerR,
    trailStartR,
    trailStepPoints,
    trailDistancePoints,
    closeOppositeFirst: mm.closeOppositeFirst !== false,
    _origSL:      parsed.stopLoss,
    _origTP1:     parsed.takeProfit1,
    riskReward: parsed.riskReward,
    confidence: parsed.confidence,
    nature:     parsed.nature,
    setup:      parsed.setup || "",  // stamped into the MT5 order comment for attribution
    time:       new Date().toISOString(),
    source:     "AlphaEdge",
  };
  try {
    const resp = await fetch(cfg.bridgeUrl, {
      method:  "POST",
      headers: { "Content-Type":"application/json" },
      body:    JSON.stringify(order),
    });
    if (resp.ok) {
      const data = await resp.json().catch(()=>({}));
      // Fire a Telegram "trade placed" alert for real fills only (not dup/dry-run).
      if (data && data.ok && data.order && !data.skipped && !data.dryRun) {
        sendTradeAlert("placed", { venue:"MT5", symbol:assetLabel, side:order.side,
          price:data.price ?? order.entry, lot:order.lot, sl:order.stopLoss, tp:order.takeProfit1, ticket:data.order });
      }
      return { ok:true, account:cfg.account, order:data.order, price:data.price, ...data };
    }
    const err = await resp.text().catch(()=> "");
    return { ok:false, error:`HTTP ${resp.status}${err?` — ${err.slice(0,120)}`:""}` };
  } catch(e) {
    return { ok:false, error: e.message };
  }
}

function buildTelegramMessage(parsed, assetLabel, tf) {
  const biasEmoji = parsed.bias === "BULLISH" ? "🟢" : parsed.bias === "BEARISH" ? "🔴" : "🟡";
  const dirArrow  = parsed.bias === "BULLISH" ? "▲" : parsed.bias === "BEARISH" ? "▼" : "◆";
  const natEmoji  = parsed.nature === "Scalping" ? "⚡" : parsed.nature === "Intraday" ? "🕐" : "📈";
  const ts = new Date().toLocaleString("en-IN", {
    timeZone:"Asia/Kolkata", hour12:false,
    day:"2-digit", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit"
  });
  // Escape HTML special chars in AI-generated text to prevent parse errors
  const esc = (s="") => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const fmtPrice = (v) => v ? `$${Number(v).toLocaleString()}` : "—";

  return `${biasEmoji} <b>AlphaEdge AI Signal</b>
━━━━━━━━━━━━━━━━━━━━
<b>Asset:</b> ${esc(assetLabel)}  |  <b>TF:</b> ${tf}
${natEmoji} <b>Type:</b> ${esc(parsed.nature||"Intraday")}
<b>Bias:</b> ${dirArrow} ${parsed.bias}  |  <b>Confidence:</b> ${parsed.confidence}%
<b>Setup:</b> ${esc(parsed.setup)}
<b>Kill Zone:</b> ${esc(parsed.killZone)}
━━━━━━━━━━━━━━━━━━━━
📍 <b>Entry:</b>      <code>${fmtPrice(parsed.entry)}</code>
🛑 <b>Stop Loss:</b>  <code>${fmtPrice(parsed.stopLoss)}</code>
🎯 <b>TP1:</b>        <code>${fmtPrice(parsed.takeProfit1)}</code>
🎯 <b>TP2:</b>        <code>${fmtPrice(parsed.takeProfit2)}</code>
⚖️ <b>Risk:Reward:</b> 1:${parsed.riskReward?.toFixed(2)||"—"}
🧭 <b>Rule Gate:</b> ${parsed.ruleAudit?.bigLossBlocked ? "No Big Loss" : "Risk checked"} | Max Risk ${parsed.ruleAudit?.maxRiskPct ?? MAX_SIGNAL_RISK_PCT}% | TP2 RR 1:${parsed.ruleAudit?.rrToTP2 ?? parsed.riskReward ?? "—"}
━━━━━━━━━━━━━━━━━━━━
📊 <b>ICT Factors</b>
${(parsed.ictFactors||[]).map(f=>`• ${esc(f)}`).join("\n")}

🔷 <b>SMC Factors</b>
${(parsed.smcFactors||[]).map(f=>`• ${esc(f)}`).join("\n")}

🌍 <b>Macro Factors</b>
${(parsed.macroFactors||[]).map(f=>`• ${esc(f)}`).join("\n")}
━━━━━━━━━━━━━━━━━━━━
💬 <b>Summary</b>
${esc(parsed.summary)}
━━━━━━━━━━━━━━━━━━━━
❌ <b>Invalidation:</b> ${esc(parsed.invalidation)}
⚠️ <b>Risk Warning:</b> ${esc(parsed.riskWarning)}
━━━━━━━━━━━━━━━━━━━━
🤖 <i>AlphaEdge v3.0  |  ${ts} IST</i>`
}

// ─── CANDLE GENERATION (with UTC timestamps) ──────────────────────────────────
function genCandles(base, n=90, tfMinutes=60) {
  const arr = []; let p = base;
  const now = Date.now();
  // Start from n candles ago
  const startMs = now - n * tfMinutes * 60 * 1000;
  for(let i=0;i<n;i++){
    const ts = startMs + i * tfMinutes * 60 * 1000;
    const o=p, m=(Math.random()-0.48)*base*0.009, c=o+m;
    const h=Math.max(o,c)+Math.abs(m)*Math.random()*0.6;
    const l=Math.min(o,c)-Math.abs(m)*Math.random()*0.6;
    arr.push({open:o,close:c,high:h,low:l,bull:c>=o,vol:Math.random()*1000+200, ts});
    p=c;
  }
  return arr;
}

function runBacktest(candles, stratId) {
  const trades=[]; let equity=10000; const curve=[equity];

  // ── 9/20 EMA Pullback — real signal detection ─────────────────────────────
  if (stratId === "ema_9_20") {
    const calcEma = (arr, period) => {
      const k = 2 / (period + 1);
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        out.push(i === 0 ? arr[i] : out[i-1] * (1 - k) + arr[i] * k);
      }
      return out;
    };
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const ema9   = calcEma(closes, 9);
    const ema20  = calcEma(closes, 20);

    for (let i = 22; i < candles.length - 1; i++) {
      const e9  = ema9[i];
      const e20 = ema20[i];
      const c   = candles[i];
      const prv = candles[i - 1];

      // Skip ranging markets (EMA spread < 0.1%)
      if (Math.abs(e9 - e20) / e20 * 100 < 0.1) continue;

      const next = candles[i + 1];
      let win = null;

      if (e9 > e20) {
        // LONG: pullback touched EMA, green rejection candle, close above both EMAs
        if ((c.low <= e9 || c.low <= e20) &&
            c.close > c.open && c.close > prv.close &&
            c.close > e9 && c.close > e20) {
          // Stop: 3-bar swing low BEFORE the entry candle (exclude bar i)
          const sl = Math.min(lows[i-3], lows[i-2], lows[i-1]) * 0.9995;
          const risk = c.close - sl;
          const tp   = c.close + risk * 3;
          if (next.low <= sl)       win = false;
          else if (next.high >= tp) win = true;
          else win = Math.random() > 0.38; // trade open after 1 bar — probability resolve
          const pnl = win ? equity * 0.01 * 3 : -(equity * 0.01);
          equity += pnl; curve.push(equity);
          trades.push({ i, win, pnl, equity });
        }
      } else if (e9 < e20) {
        // SHORT: rally touched EMA, red candle closing near low, close below both EMAs
        const range = c.high - c.low;
        if ((c.high >= e9 || c.high >= e20) &&
            c.close < c.open && range > 0 &&
            (c.close - c.low) / range <= 0.15 &&
            c.close < e9 && c.close < e20) {
          // Stop: 3-bar swing high BEFORE the entry candle (exclude bar i)
          const sl = Math.max(highs[i-3], highs[i-2], highs[i-1]) * 1.0005;
          const risk = sl - c.close;
          const tp   = c.close - risk * 3;
          if (next.high >= sl)     win = false;
          else if (next.low <= tp) win = true;
          else win = Math.random() > 0.38; // trade open after 1 bar — probability resolve
          const pnl = win ? equity * 0.01 * 3 : -(equity * 0.01);
          equity += pnl; curve.push(equity);
          trades.push({ i, win, pnl, equity });
        }
      }
    }

    const wins     = trades.filter(t => t.win).length;
    const losses   = trades.length - wins;
    const grossWin = trades.filter(t => t.win).reduce((s, t) => s + t.pnl, 0);
    const grossLoss= Math.abs(trades.filter(t => !t.win).reduce((s, t) => s + t.pnl, 0));
    const maxDD    = curve.reduce((acc, v, i, a) => {
      const peak = Math.max(...a.slice(0, i + 1));
      return Math.max(acc, (peak - v) / peak * 100);
    }, 0);
    const returns  = curve.map((v, i) => i === 0 ? 0 : (v - curve[i-1]) / curve[i-1]);
    const mean     = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
    const std      = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length || 1)) || 1;
    return {
      trades, curve, equity,
      winRate:      wins / (trades.length || 1) * 100,
      profitFactor: grossWin / (grossLoss || 1),
      maxDD, sharpe: (mean / std) * Math.sqrt(252),
      totalReturn:  (equity - 10000) / 100,
      totalTrades:  trades.length,
    };
  }

  if (stratId === "golden_setup") {
    // Round-number breakout — nearest 100-point multiple on synthetic price data
    // (Crypto assets in Alphaedge use a ~97000 base; round step = 1000)
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const W = 20; // structural direction window
    const zoneStops = {}; // round_level → consecutive loss count (max 4 per wiki rule)

    for (let i = W * 2 + 1; i < candles.length - 1; i++) {
      const c      = candles[i];
      const prv    = candles[i - 1];
      const next   = candles[i + 1];

      // Structural direction: rolling max/min vs prior window
      const recentH = Math.max(...highs.slice(i - W, i + 1));
      const recentL = Math.min(...lows.slice(i - W, i + 1));
      const prevH   = Math.max(...highs.slice(i - W * 2, i - W + 1));
      const prevL   = Math.min(...lows.slice(i - W * 2, i - W + 1));
      const up      = recentH > prevH && recentL > prevL;
      const down    = recentH < prevH && recentL < prevL;
      if (!up && !down) continue;

      // Nearest round level (1000-pt for crypto, 100-pt for lower-priced assets)
      const STEP = Math.round(c.close / 1000) > 5 ? 1000 : 100;
      const roundLevel = Math.round(c.close / STEP) * STEP;

      // Zone iteration gate: max 4 consecutive stops per round level (wiki rule)
      if ((zoneStops[roundLevel] || 0) >= 4) continue;

      let win = null;
      if (up && prv.close < roundLevel && c.close >= roundLevel) {
        // LONG: close crossed above round level in uptrend
        const stopDist = STEP * 0.3;
        const sl   = roundLevel - stopDist;
        const risk = c.close - sl;
        const tp   = c.close + risk * 5;
        if (next.low <= sl)       win = false;
        else if (next.high >= tp) win = true;
        else win = Math.random() > 0.42; // probability resolve
        zoneStops[roundLevel] = (zoneStops[roundLevel] || 0) + (win ? 0 : 1);
        const pnl = win ? equity * 0.01 * 5 : -(equity * 0.01);
        equity += pnl; curve.push(equity);
        trades.push({ i, win, pnl, equity });
      } else if (down && prv.close > roundLevel && c.close <= roundLevel) {
        // SHORT: close crossed below round level in downtrend
        const stopDist = STEP * 0.3;
        const sl   = roundLevel + stopDist;
        const risk = sl - c.close;
        const tp   = c.close - risk * 5;
        if (next.high >= sl)     win = false;
        else if (next.low <= tp) win = true;
        else win = Math.random() > 0.42; // probability resolve
        zoneStops[roundLevel] = (zoneStops[roundLevel] || 0) + (win ? 0 : 1);
        const pnl = win ? equity * 0.01 * 5 : -(equity * 0.01);
        equity += pnl; curve.push(equity);
        trades.push({ i, win, pnl, equity });
      }
    }

    const wins      = trades.filter(t => t.win).length;
    const grossWin  = trades.filter(t => t.win).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => !t.win).reduce((s, t) => s + t.pnl, 0));
    const maxDD = curve.reduce((acc, v, i, a) => {
      const peak = Math.max(...a.slice(0, i + 1));
      return Math.max(acc, (peak - v) / peak * 100);
    }, 0);
    const returns = curve.map((v, i) => i === 0 ? 0 : (v - curve[i-1]) / curve[i-1]);
    const mean = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
    const std  = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length || 1)) || 1;
    return {
      trades, curve, equity,
      winRate:      wins / (trades.length || 1) * 100,
      profitFactor: grossWin / (grossLoss || 1),
      maxDD, sharpe: (mean / std) * Math.sqrt(252),
      totalReturn:  (equity - 10000) / 100,
      totalTrades:  trades.length,
    };
  }

  // ── Adaptive S&R Pro ─────────────────────────────────────────────────────
  if (stratId === "adaptive_sr") {
    const calcWma = (arr, p) => {
      const w = Array.from({length: p}, (_, i) => i + 1);
      const wSum = w.reduce((a, b) => a + b, 0);
      const out = new Array(arr.length).fill(null);
      for (let i = p - 1; i < arr.length; i++) {
        let s = 0;
        for (let j = 0; j < p; j++) s += (arr[i - p + 1 + j] ?? 0) * w[j];
        out[i] = s / wSum;
      }
      return out;
    };
    const calcHma = (arr, p) => {
      const half = Math.max(Math.floor(p / 2), 2);
      const sq   = Math.max(Math.round(Math.sqrt(p)), 2);
      const wmaH = calcWma(arr, half);
      const wmaF = calcWma(arr, p);
      const raw  = arr.map((_, i) => (wmaH[i] != null && wmaF[i] != null) ? 2 * wmaH[i] - wmaF[i] : null);
      const rawFilled = raw.map(v => v ?? 0);
      return calcWma(rawFilled, sq).map((v, i) => raw[i] != null ? v : null);
    };
    const calcRsi = (arr, p) => {
      const rsi = new Array(arr.length).fill(null);
      let ag = 0, al = 0;
      for (let i = 1; i <= p; i++) {
        const d = arr[i] - arr[i - 1];
        ag += d > 0 ? d : 0;
        al += d < 0 ? -d : 0;
      }
      ag /= p; al /= p;
      rsi[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      for (let i = p + 1; i < arr.length; i++) {
        const d = arr[i] - arr[i - 1];
        ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
        al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
        rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      }
      return rsi;
    };
    const calcAtr = (cds, p) => {
      const atr = new Array(cds.length).fill(null);
      let prev = 0;
      for (let i = 1; i < cds.length; i++) {
        const tr = Math.max(
          cds[i].high - cds[i].low,
          Math.abs(cds[i].high - cds[i-1].close),
          Math.abs(cds[i].low  - cds[i-1].close)
        );
        const a = i < p ? (prev * (i - 1) + tr) / i : (prev * (p - 1) + tr) / p;
        atr[i] = a;
        prev   = a;
      }
      return atr;
    };

    const HF = 9, HS = 20, RSIP = 9, PLB = 20;
    // Fine-tuned thresholds: 30/70 are practical for crypto/forex 1H
    // RSI 25/75 is too strict — BTC hourly rarely touches those extremes
    const RSI_OS = 30, RSI_OB = 70, SL_ATR = 1.5, RR = 2.5;
    const MIN_GAP = 0.002;

    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const hmaF   = calcHma(closes, HF);
    const hmaS   = calcHma(closes, HS);
    const rsi    = calcRsi(closes, RSIP);
    const atr    = calcAtr(candles, 14);
    // CMO = spread between fast HMA and slow HMA (positive = bullish momentum, negative = bearish)
    // This correctly captures institutional momentum shifts at S/R levels
    const cmo    = hmaF.map((v, i) => (v != null && hmaS[i] != null && hmaS[i] > 0)
      ? (v - hmaS[i]) / hmaS[i] * 100
      : null);

    const START = Math.max(HS * 2, PLB + 1, 14);
    let lastSup = null, lastRes = null;

    for (let i = START; i < candles.length - 1; i++) {
      const c    = closes[i];
      const cPrv = closes[i - 1];
      const r    = rsi[i];
      const rPrv = rsi[i - 1];
      const cm   = cmo[i];
      const cmPrv= cmo[i - 1];
      const a    = atr[i];
      if (r == null || cm == null || cmPrv == null || a == null || a <= 0) continue;

      const pivH = Math.max(...highs.slice(i - PLB, i + 1));
      const pivL = Math.min(...lows.slice(i - PLB, i + 1));

      let win = null, sl, tp, risk;

      // SUPPORT / BUY:
      //   - RSI was oversold last bar (< OS threshold) and is now recovering (still < OB)
      //   - CMO positive: fast HMA above slow HMA → bullish momentum building at support
      //   - Price within ±1.5% band of the rolling pivot low (the S/R zone)
      const buyRsi  = rPrv < RSI_OS && r < RSI_OB;
      const buyZone = c >= pivL * 0.985 && c <= pivL * 1.015;
      if (buyRsi && cm > 0 && buyZone) {
        if (lastSup !== null && Math.abs(pivL - lastSup) / Math.abs(lastSup) < MIN_GAP) continue;
        sl   = pivL - a * SL_ATR;
        risk = c - sl;
        if (risk <= 0) continue;
        tp      = c + risk * RR;
        lastSup = pivL;
        const nx = candles[i + 1];
        if (nx.low  <= sl) win = false;
        else if (nx.high >= tp) win = true;
        else win = Math.random() > 0.37;

      // RESISTANCE / SELL:
      //   - RSI was overbought last bar (> OB threshold) and is now retreating (still > OS)
      //   - CMO negative: fast HMA below slow HMA → bearish momentum building at resistance
      //   - Price within ±1.5% band of the rolling pivot high (the S/R zone)
      } else {
        const sellRsi  = rPrv > RSI_OB && r > RSI_OS;
        const sellZone = c >= pivH * 0.985 && c <= pivH * 1.015;
        if (sellRsi && cm < 0 && sellZone) {
          if (lastRes !== null && Math.abs(pivH - lastRes) / Math.abs(lastRes) < MIN_GAP) continue;
          sl   = pivH + a * SL_ATR;
          risk = sl - c;
          if (risk <= 0) continue;
          tp      = c - risk * RR;
          lastRes = pivH;
          const nx = candles[i + 1];
          if (nx.high >= sl) win = false;
          else if (nx.low  <= tp) win = true;
          else win = Math.random() > 0.37;
        }
      }

      if (win !== null) {
        const pnl = win ? equity * 0.01 * RR : -(equity * 0.01);
        equity += pnl; curve.push(equity);
        trades.push({i, win, pnl, equity});
      }
    }

    const wins      = trades.filter(t => t.win).length;
    const grossWin  = trades.filter(t => t.win).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => !t.win).reduce((s, t) => s + t.pnl, 0));
    const maxDD     = curve.reduce((acc, v, i, a) => {
      const peak = Math.max(...a.slice(0, i + 1));
      return Math.max(acc, (peak - v) / peak * 100);
    }, 0);
    const returns = curve.map((v, i) => i === 0 ? 0 : (v - curve[i-1]) / curve[i-1]);
    const mean    = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
    const std     = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length || 1)) || 1;
    return {
      trades, curve, equity,
      winRate:      wins / (trades.length || 1) * 100,
      profitFactor: grossWin / (grossLoss || 1),
      maxDD, sharpe: (mean / std) * Math.sqrt(252),
      totalReturn:  (equity - 10000) / 100,
      totalTrades:  trades.length,
    };
  }

  for(let i=20;i<candles.length-1;i++){
    const signal = Math.random()>0.65;
    if(signal){
      const win=Math.random()>(stratId==="liq_sweep"?0.27:stratId==="rsi_div"?0.41:0.32);
      const rr = 1.8+Math.random()*1.2;
      const risk = equity*0.01;
      const pnl = win ? risk*rr : -risk;
      equity+=pnl; curve.push(equity);
      trades.push({i, win, pnl, equity});
    }
  }
  const wins=trades.filter(t=>t.win).length;
  const losses=trades.length-wins;
  const grossWin=trades.filter(t=>t.win).reduce((s,t)=>s+t.pnl,0);
  const grossLoss=Math.abs(trades.filter(t=>!t.win).reduce((s,t)=>s+t.pnl,0));
  const maxDD = curve.reduce((acc,v,i,a)=>{
    const peak=Math.max(...a.slice(0,i+1));
    return Math.max(acc,(peak-v)/peak*100);
  },0);
  const returns = curve.map((v,i)=>i===0?0:(v-curve[i-1])/curve[i-1]);
  const mean=returns.reduce((s,r)=>s+r,0)/returns.length;
  const std=Math.sqrt(returns.reduce((s,r)=>s+(r-mean)**2,0)/returns.length)||1;
  const sharpe=(mean/std)*Math.sqrt(252);
  return {
    trades, curve, equity,
    winRate:wins/trades.length*100||0,
    profitFactor:grossWin/(grossLoss||1),
    maxDD, sharpe,
    totalReturn:(equity-10000)/100,
    totalTrades:trades.length,
  };
}

// ─── ICT SIGNAL DETECTION ENGINE ─────────────────────────────────────────────
function detectSwings(candles, lb=3) {
  const highs=[], lows=[];
  for(let i=lb; i<candles.length-lb; i++){
    let isH=true, isL=true;
    for(let j=i-lb; j<=i+lb; j++){
      if(j===i) continue;
      if(candles[j].high >= candles[i].high) isH=false;
      if(candles[j].low  <= candles[i].low)  isL=false;
    }
    if(isH) highs.push({i, price:candles[i].high});
    if(isL) lows.push( {i, price:candles[i].low});
  }
  return {highs, lows};
}

function detectFVGs(candles) {
  const fvgs=[];
  for(let i=1; i<candles.length-1; i++){
    // Bullish FVG: C[i+1].low > C[i-1].high  → gap up
    if(candles[i+1].low > candles[i-1].high){
      let filled=false, fillAt=-1;
      for(let j=i+2; j<candles.length; j++){
        if(candles[j].low <= candles[i+1].low){ filled=true; fillAt=j; break; }
      }
      fvgs.push({type:'bull', i, top:candles[i+1].low, bot:candles[i-1].high, filled, fillAt});
    }
    // Bearish FVG: C[i+1].high < C[i-1].low  → gap down
    if(candles[i+1].high < candles[i-1].low){
      let filled=false, fillAt=-1;
      for(let j=i+2; j<candles.length; j++){
        if(candles[j].high >= candles[i-1].low){ filled=true; fillAt=j; break; }
      }
      fvgs.push({type:'bear', i, top:candles[i-1].low, bot:candles[i+1].high, filled, fillAt});
    }
  }
  return fvgs;
}

function detectOrderBlocks(candles, swings) {
  const obs=[];
  const {highs, lows}=swings;
  // Bearish OB: last bullish candle at or before a swing high (before bearish impulse)
  highs.forEach(sh=>{
    const nextLow=lows.find(l=>l.i>sh.i);
    if(!nextLow||sh.price-nextLow.price<sh.price*0.004) return;
    for(let i=sh.i; i>=Math.max(0,sh.i-10); i--){
      if(candles[i].bull){
        const mitigated=candles.slice(i+1).some(c=>c.low<=candles[i].high&&c.low>=candles[i].low);
        obs.push({type:'bear',i,top:candles[i].high,bot:candles[i].low,mitigated});
        break;
      }
    }
  });
  // Bullish OB: last bearish candle at or before a swing low (before bullish impulse)
  lows.forEach(sl=>{
    const nextHigh=highs.find(h=>h.i>sl.i);
    if(!nextHigh||nextHigh.price-sl.price<sl.price*0.004) return;
    for(let i=sl.i; i>=Math.max(0,sl.i-10); i--){
      if(!candles[i].bull){
        const mitigated=candles.slice(i+1).some(c=>c.high>=candles[i].low&&c.high<=candles[i].high);
        obs.push({type:'bull',i,top:candles[i].high,bot:candles[i].low,mitigated});
        break;
      }
    }
  });
  return obs;
}

function detectBOS(candles, swings) {
  const bos=[];
  const {highs, lows}=swings;
  for(let k=1; k<highs.length; k++){
    highs[k].price>highs[k-1].price
      ? bos.push({type:'bull',i:highs[k].i,price:highs[k-1].price,label:'BOS'})
      : bos.push({type:'lh', i:highs[k].i,price:highs[k-1].price,label:'CHoCH'});
  }
  for(let k=1; k<lows.length; k++){
    lows[k].price<lows[k-1].price
      ? bos.push({type:'bear',i:lows[k].i,price:lows[k-1].price,label:'BOS'})
      : bos.push({type:'hl', i:lows[k].i,price:lows[k-1].price,label:'CHoCH'});
  }
  return bos;
}

function detectLiquidity(swings) {
  const lvls=[];
  const {highs, lows}=swings;
  const thr=0.0025;
  for(let i=0;i<highs.length-1;i++) for(let j=i+1;j<highs.length;j++){
    if(Math.abs(highs[i].price-highs[j].price)/highs[i].price<thr)
      lvls.push({type:'eqh',price:(highs[i].price+highs[j].price)/2,i1:highs[i].i,i2:highs[j].i});
  }
  for(let i=0;i<lows.length-1;i++) for(let j=i+1;j<lows.length;j++){
    if(Math.abs(lows[i].price-lows[j].price)/lows[i].price<thr)
      lvls.push({type:'eql',price:(lows[i].price+lows[j].price)/2,i1:lows[i].i,i2:lows[j].i});
  }
  return lvls;
}

function detectMSLabels(swings) {
  const pts=[];
  const {highs, lows}=swings;
  highs.forEach((h,k)=>{ pts.push({i:h.i,price:h.price,label:k===0?'H':highs[k].price>highs[k-1].price?'HH':'LH',side:'high'}); });
  lows.forEach( (l,k)=>{ pts.push({i:l.i,price:l.price,label:k===0?'L':lows[k].price>lows[k-1].price?'HL':'LL', side:'low'}); });
  return pts;
}

function detectPD(swings) {
  const {highs, lows}=swings;
  if(!highs.length||!lows.length) return null;
  const rh=highs[highs.length-1].price, rl=lows[lows.length-1].price;
  return {high:rh, low:rl, mid:(rh+rl)/2};
}

function calcEMAs(candles) {
  const ema=(p)=>{
    const k=2/(p+1), r=[candles[0]?.close||0];
    for(let i=1;i<candles.length;i++) r.push(candles[i].close*k+r[i-1]*(1-k));
    return r;
  };
  return {e20:ema(20), e50:ema(50), e200:ema(200)};
}

function calcRSI(candles, period=14) {
  const rsi=[...Array(period).fill(50)];
  let gains=0, losses=0;
  for(let i=1;i<=period;i++){
    const d=candles[i].close-candles[i-1].close;
    d>0?gains+=d:losses-=d;
  }
  let ag=gains/period, al=losses/period;
  for(let i=period+1;i<candles.length;i++){
    const d=candles[i].close-candles[i-1].close;
    ag=(ag*(period-1)+(d>0?d:0))/period;
    al=(al*(period-1)+(d<0?-d:0))/period;
    rsi.push(al===0?100:100-100/(1+ag/al));
  }
  return rsi;
}

// ─── OHLCV CANDLE FETCHER (per asset + timeframe) ────────────────────────────
const BINANCE_TF = { "1m":"1m","5m":"5m","15m":"15m","1H":"1h","4H":"4h","1D":"1d","1W":"1w" };
const YAHOO_TF   = { "1m":"1m","5m":"5m","15m":"15m","1H":"1h","4H":"1h","1D":"1d","1W":"1wk" };
const YAHOO_RANGE= { "1m":"1d","5m":"5d","15m":"5d","1H":"1mo","4H":"3mo","1D":"6mo","1W":"2y" };

async function fetchCandles(assetId, tf) {
  try {
    // ── Crypto: use Binance ──────────────────────────────────────────────────
    if (assetId === "BTCUSD" || assetId === "ETHUSD") {
      const symbol = assetId === "BTCUSD" ? "BTCUSDT" : "ETHUSDT";
      const interval = BINANCE_TF[tf] || "1h";
      const limit = tf === "1W" ? 52 : tf === "1D" ? 90 : tf === "4H" ? 90 : 120;
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!resp.ok) throw new Error("Binance error");
      const raw = await resp.json();
      // Binance klines: [openTime, open, high, low, close, volume, ...]
      return raw.map(k => ({
        ts:    k[0],
        open:  parseFloat(k[1]),
        high:  parseFloat(k[2]),
        low:   parseFloat(k[3]),
        close: parseFloat(k[4]),
        vol:   parseFloat(k[5]),
        bull:  parseFloat(k[4]) >= parseFloat(k[1]),
      }));
    }

    // ── Gold & Nifty: use Yahoo Finance ─────────────────────────────────────
    const yahooSymbol = assetId === "XAUUSD" ? "GC%3DF" : "%5ENSEI";
    const interval    = YAHOO_TF[tf]    || "1h";
    const range       = YAHOO_RANGE[tf] || "1mo";
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${interval}&range=${range}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) throw new Error("Yahoo error");
    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error("No data");
    const { timestamp, indicators } = result;
    const q = indicators.quote[0];
    return timestamp.map((ts, i) => ({
      ts:    ts * 1000,
      open:  q.open[i]  || 0,
      high:  q.high[i]  || 0,
      low:   q.low[i]   || 0,
      close: q.close[i] || 0,
      vol:   q.volume[i]|| 0,
      bull:  (q.close[i] || 0) >= (q.open[i] || 0),
    })).filter(c => c.open > 0 && c.close > 0);

  } catch(e) {
    return null; // null = fetch failed, keep existing candles
  }
}

// ─── SESSION BLOCK HELPER ────────────────────────────────────────────────────
function drawSessionBlock(ctx, sess, x1, x2, PT, CH) {
  if (x2 <= x1) return;
  ctx.fillStyle = sess.fill;
  ctx.fillRect(x1, PT, x2 - x1, CH);
  ctx.strokeStyle = sess.border;
  ctx.lineWidth   = 1.2;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x1, PT);
  ctx.lineTo(x1, PT + CH);
  ctx.stroke();
  // Only tag the session if the block is wide enough to read — keeps the top clean
  if (x2 - x1 < 46) return;
  const labelX = x1 + 6;
  const labelY = PT + 14;
  ctx.font      = "bold 9px sans-serif";
  ctx.textAlign = "left";
  const tw = ctx.measureText(sess.label).width + 10;
  ctx.fillStyle = sess.fill.replace("0.08", "0.35").replace("0.07", "0.35").replace("0.09", "0.35");
  if (ctx.roundRect) ctx.roundRect(labelX - 4, labelY - 10, tw, 14, 3);
  else ctx.rect(labelX - 4, labelY - 10, tw, 14);
  ctx.fill();
  ctx.fillStyle = sess.textColor;
  ctx.fillText(sess.label, labelX, labelY);
}

// ─── ADVANCED ICT CHART (Canvas) ─────────────────────────────────────────────

function AdvancedICTChart({candles: propCandles, asset, price, change}) {
  const canvasRef    = useRef(null);
  const containerRef = useRef(null);
  const animRef      = useRef(null);
  const dragRef      = useRef(null);

  const [sz,      setSz]      = useState({w:700, h:420});
  const [vs,      setVs]      = useState(0);
  const [vl,      setVl]      = useState(70);
  const [xhair,   setXhair]   = useState(null);
  const [tf,      setTf]      = useState("1H");
  const [ov,      setOv]      = useState({ob:true,fvg:true,bos:true,liq:false,ms:true,pd:false,ema:true,vol:true,rsi:false,sessions:true});
  const [candles, setCandles] = useState(propCandles || []);
  const [loading, setLoading] = useState(false);
  const [fetchErr,setFetchErr]= useState(null);

  // ── Fetch real candles whenever asset or timeframe changes ──────────────────
  useEffect(()=>{
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setFetchErr(null);
      const result = await fetchCandles(asset, tf);
      if (cancelled) return;
      if (result && result.length > 0) {
        setCandles(result);
        setVs(Math.max(0, result.length - vl));
        setFetchErr(null);
      } else {
        // Fallback: use prop candles (simulated)
        setCandles(propCandles || []);
        setFetchErr("Live data unavailable — showing simulated candles");
      }
      setLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, [asset, tf]);

  // Keep propCandles as fallback when fetching fails
  useEffect(()=>{
    if (propCandles && propCandles.length > 0 && candles.length === 0) {
      setCandles(propCandles);
    }
  }, [propCandles]);

  // ICT signal detection — recomputes whenever fetched candles change
  const sigs = useMemo(()=>{
    if(!candles||candles.length<15) return null;
    const swings=detectSwings(candles,3);
    return {
      swings, fvgs:detectFVGs(candles),
      obs:detectOrderBlocks(candles,swings),
      bos:detectBOS(candles,swings),
      liq:detectLiquidity(swings),
      ms:detectMSLabels(swings),
      pd:detectPD(swings),
      emas:calcEMAs(candles),
      rsi:calcRSI(candles),
    };
  },[candles]);

  // Sync viewStart when candles change
  useEffect(()=>{
    if(candles&&candles.length>0)
      setVs(Math.max(0, candles.length - vl));
  },[candles?.length]);

  // ResizeObserver
  useEffect(()=>{
    const el=containerRef.current; if(!el) return;
    const ro=new ResizeObserver(es=>{
      const {width,height}=es[0].contentRect;
      setSz({w:Math.max(300,width), h:Math.max(260,height)});
    });
    ro.observe(el);
    return ()=>ro.disconnect();
  },[]);

  // Render
  useEffect(()=>{
    if(animRef.current) cancelAnimationFrame(animRef.current);
    animRef.current=requestAnimationFrame(()=>drawAll());
  },[candles, sigs, vs, vl, xhair, ov, sz]);

  function coords() {
    const W=sz.w, H=sz.h;
    const PL=60, PR=14, PT=16;
    const VOL_H = ov.vol ? 52 : 0;
    const RSI_H = ov.rsi ? 56 : 0;
    const PB=20+VOL_H+RSI_H;
    const CW=W-PL-PR, CH=H-PT-PB;
    return {W,H,PL,PR,PT,PB,CW,CH,VOL_H,RSI_H};
  }

  function drawAll() {
    const canvas=canvasRef.current;
    if(!canvas||!candles||candles.length<5) return;
    const ctx=canvas.getContext('2d');
    const dpr=window.devicePixelRatio||1;
    const {W,H,PL,PR,PT,PB,CW,CH,VOL_H,RSI_H}=coords();
    canvas.width=W*dpr; canvas.height=H*dpr;
    canvas.style.width=W+'px'; canvas.style.height=H+'px';
    ctx.scale(dpr,dpr);

    const endIdx=Math.min(candles.length, vs+vl);
    const vis=candles.slice(vs, endIdx);
    if(!vis.length) return;

    const cW_px=CW/vis.length;
    const bW=Math.max(1.5, cW_px*0.62);

    // Price range with padding
    const allP=vis.flatMap(c=>[c.high,c.low]);
    const pRaw=[Math.min(...allP),Math.max(...allP)];
    const pPad=(pRaw[1]-pRaw[0])*0.08;
    const pLo=pRaw[0]-pPad, pHi=pRaw[1]+pPad, pRng=pHi-pLo||1;

    const toX=idx=>PL+(((idx-vs)+0.5)/vis.length)*CW;
    const toY=p=>PT+CH-(((p-pLo)/pRng)*CH);

    // ── Background ──────────────────────────────────────────────────────────
    ctx.fillStyle='#060d17';
    ctx.fillRect(0,0,W,H);

    // ── Grid ────────────────────────────────────────────────────────────────
    for(let g=0;g<=6;g++){
      const p=pLo+(pRng*g/6), y=toY(p);
      ctx.strokeStyle='#0d1e35'; ctx.lineWidth=0.5; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(PL,y); ctx.lineTo(W-PR,y); ctx.stroke();
      const fmt=p=>{
        const s=assetObj.id==="NIFTY50"?"₹":"$";
        return p>=10000?`${s}${(p/1000).toFixed(1)}k`:p>=100?`${s}${p.toFixed(0)}`:`${s}${p.toFixed(2)}`;
      };
      ctx.fillStyle='#2a4a6a'; ctx.font='8px monospace'; ctx.textAlign='right';
      ctx.fillText(fmt(p), PL-3, y+3);
    }
    const vStep=Math.max(1,Math.floor(vis.length/7));
    for(let vi=0;vi<vis.length;vi+=vStep){
      const x=toX(vs+vi);
      ctx.strokeStyle='#0d1e35'; ctx.lineWidth=0.4; ctx.beginPath();
      ctx.moveTo(x,PT); ctx.lineTo(x,PT+CH); ctx.stroke();
      ctx.fillStyle='#1a3050'; ctx.font='7px monospace'; ctx.textAlign='center';
      ctx.fillText(`-${vis.length-vi}`, x, H-PB+14);
    }

    // ── Sessions (TradingView ICT-style filled blocks) ────────────────────────
    if(ov.sessions && vis.length>0 && vis[0]?.ts){
      // Define sessions by UTC hour range, label, and fill color (matching screenshot)
      const SESSIONS=[
        { label:"Asia",     startH:0,  endH:9,  fill:"rgba(245,158,11,0.09)",  border:"rgba(245,158,11,0.5)",  textColor:"#f59e0b" },
        { label:"NSE",      startH:3.75,endH:10, fill:"rgba(167,139,250,0.07)",border:"rgba(167,139,250,0.45)",textColor:"#a78bfa" },
        { label:"London",   startH:7,  endH:16, fill:"rgba(34,197,94,0.08)",   border:"rgba(34,197,94,0.5)",   textColor:"#22c55e" },
        { label:"New York", startH:12, endH:21, fill:"rgba(244,63,94,0.08)",   border:"rgba(244,63,94,0.5)",   textColor:"#f43f5e" },
      ];

      // Build a list of session blocks visible in the viewport
      // Strategy: scan all visible candles, group consecutive ones in same session
      const getSessionAt = (utcH) => {
        return SESSIONS.filter(s => {
          if(s.startH < s.endH) return utcH >= s.startH && utcH < s.endH;
          return utcH >= s.startH || utcH < s.endH;
        });
      };

      // For each session, find contiguous x-ranges where it's active
      SESSIONS.forEach(sess=>{
        let blockStart = null;

        vis.forEach((c, vi) => {
          if (!c.ts) return;
          const utcH = new Date(c.ts).getUTCHours() + new Date(c.ts).getUTCMinutes()/60;
          const active = sess.startH < sess.endH
            ? utcH >= sess.startH && utcH < sess.endH
            : utcH >= sess.startH || utcH < sess.endH;

          const x = toX(vs + vi);
          const hw = cW_px / 2 + 1; // half candle width for edge bleed

          if (active && blockStart === null) {
            blockStart = x - hw;
          }
          if (!active && blockStart !== null) {
            // Close block
            const blockEnd = x - hw;
            drawSessionBlock(ctx, sess, blockStart, blockEnd, PT, CH, cW_px);
            blockStart = null;
          }
          // Last candle — close any open block
          if (active && vi === vis.length - 1) {
            drawSessionBlock(ctx, sess, blockStart, W - PR, PT, CH, cW_px);
            blockStart = null;
          }
        });
      });

      // Kill zone dashed vertical lines
      const KZ_DEFS=[
        { label:"London KZ", startH:7,   endH:9.5,  color:"#f59e0b" },
        { label:"NSE KZ",    startH:3.75, endH:5,   color:"#a78bfa" },
        { label:"NY KZ",     startH:12,  endH:14,   color:"#f43f5e" },
        { label:"Asia KZ",   startH:0,   endH:2,    color:"#60a5fa" },
      ];
      const drawnKZ = new Set();
      vis.forEach((c, vi) => {
        if (!c.ts) return;
        const utcH = new Date(c.ts).getUTCHours() + new Date(c.ts).getUTCMinutes()/60;
        KZ_DEFS.forEach(kz => {
          const key = `${kz.label}-${Math.floor(utcH)}`;
          if (drawnKZ.has(key)) return;
          const inKZ = kz.startH < kz.endH
            ? utcH >= kz.startH && utcH < kz.startH + 0.1
            : (utcH >= kz.startH && utcH < kz.startH + 0.1);
          if (inKZ) {
            drawnKZ.add(key);
            const x = toX(vs + vi);
            ctx.strokeStyle = kz.color + "cc";
            ctx.lineWidth   = 1;
            ctx.setLineDash([4, 3]);
            ctx.beginPath(); ctx.moveTo(x, PT); ctx.lineTo(x, PT + CH); ctx.stroke();
            ctx.setLineDash([]);
            // Small KZ label
            ctx.fillStyle  = kz.color + "dd";
            ctx.font       = "bold 7px monospace";
            ctx.textAlign  = "left";
            ctx.fillText("KZ", x + 3, PT + CH - 5);
          }
        });
      });
    } // end ov.sessions

    // ── P/D Zone ────────────────────────────────────────────────────────────
    if(ov.pd&&sigs?.pd){
      const pd=sigs.pd;
      const yHi=toY(pd.high), yMid=toY(pd.mid), yLo=toY(pd.low);
      const gP=ctx.createLinearGradient(0,yHi,0,yMid);
      gP.addColorStop(0,'rgba(239,68,68,0.07)'); gP.addColorStop(1,'rgba(239,68,68,0.01)');
      ctx.fillStyle=gP; ctx.fillRect(PL,yHi,CW,yMid-yHi);
      const gD=ctx.createLinearGradient(0,yMid,0,yLo);
      gD.addColorStop(0,'rgba(34,197,94,0.01)'); gD.addColorStop(1,'rgba(34,197,94,0.07)');
      ctx.fillStyle=gD; ctx.fillRect(PL,yMid,CW,yLo-yMid);
      ctx.strokeStyle='rgba(100,160,240,0.25)'; ctx.lineWidth=0.7; ctx.setLineDash([5,4]);
      ctx.beginPath(); ctx.moveTo(PL,yMid); ctx.lineTo(W-PR,yMid); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle='rgba(100,160,240,0.4)'; ctx.font='7px monospace'; ctx.textAlign='right';
      ctx.fillText('50% EQ', W-PR-2, yMid-2);
      ctx.fillStyle='rgba(239,68,68,0.35)'; ctx.textAlign='left';
      ctx.fillText('PREMIUM ▲', PL+4, yHi+10);
      ctx.fillStyle='rgba(34,197,94,0.35)';
      ctx.fillText('DISCOUNT ▼', PL+4, yLo-3);
    }

    // ── FVG zones ───────────────────────────────────────────────────────────
    if(ov.fvg&&sigs?.fvgs){
      sigs.fvgs.slice(-8).forEach(fvg=>{
        if(fvg.i<vs||fvg.i>=endIdx) return;
        const x1=toX(fvg.i), yT=toY(fvg.top), yB=toY(fvg.bot);
        const x2=W-PR;
        const rgb=fvg.type==='bull'?'6,182,212':'239,68,68';
        const al=fvg.filled?0.04:0.13;
        ctx.fillStyle=`rgba(${rgb},${al})`; ctx.fillRect(x1,yT,x2-x1,yB-yT);
        ctx.strokeStyle=`rgba(${rgb},${fvg.filled?0.15:0.45})`; ctx.lineWidth=0.6;
        ctx.setLineDash([2,2]); ctx.strokeRect(x1,yT,x2-x1,yB-yT); ctx.setLineDash([]);
        if(!fvg.filled&&(yB-yT)>6){
          ctx.fillStyle=`rgba(${rgb},0.7)`; ctx.font='bold 7px monospace'; ctx.textAlign='left';
          ctx.fillText('FVG', x1+3, (yT+yB)/2+3);
        }
      });
    }

    // ── Order Blocks ────────────────────────────────────────────────────────
    if(ov.ob&&sigs?.obs){
      sigs.obs.slice(-6).forEach(ob=>{
        if(ob.i<vs||ob.i>=endIdx) return;
        const x1=toX(ob.i)-bW/2, x2=W-PR;
        const yT=toY(ob.top), yB=toY(ob.bot);
        const rgb=ob.type==='bull'?'245,158,11':'168,85,247';
        const al=ob.mitigated?0.04:0.16;
        ctx.fillStyle=`rgba(${rgb},${al})`; ctx.fillRect(x1,yT,x2-x1,yB-yT);
        ctx.strokeStyle=`rgba(${rgb},${ob.mitigated?0.2:0.55})`; ctx.lineWidth=0.8; ctx.setLineDash([]);
        ctx.strokeRect(x1,yT,x2-x1,yB-yT);
        if(!ob.mitigated&&(yB-yT)>5){
          ctx.fillStyle=`rgba(${rgb},0.8)`; ctx.font='bold 7px monospace'; ctx.textAlign='left';
          ctx.fillText(ob.type==='bull'?'Bullish OB':'Bearish OB', x1+3,
            ob.type==='bull'?yB-3:yT+8);
        }
      });
    }

    // ── BOS / CHoCH ─────────────────────────────────────────────────────────
    if(ov.bos&&sigs?.bos){
      sigs.bos.slice(-7).forEach(b=>{
        if(b.i<vs||b.i>=endIdx) return;
        const y=toY(b.price), xi=toX(b.i), isCh=b.label==='CHoCH';
        const col=b.type==='bull'||b.type==='hl'?'#22c55e':b.type==='bear'||b.type==='lh'?'#ef4444':'#a78bfa';
        ctx.strokeStyle=col+(isCh?'dd':'66'); ctx.lineWidth=isCh?1.2:0.7;
        ctx.setLineDash(isCh?[]:[5,3]);
        ctx.beginPath(); ctx.moveTo(PL,y); ctx.lineTo(xi,y); ctx.stroke();
        ctx.setLineDash([]);
        // Label pill
        const lw=isCh?38:24;
        ctx.fillStyle=col+'28'; ctx.strokeStyle=col+'80'; ctx.lineWidth=0.5;
        ctx.beginPath();
        if(ctx.roundRect) ctx.roundRect(xi-lw-2,y-8,lw,14,3);
        else { ctx.rect(xi-lw-2,y-8,lw,14); }
        ctx.fill(); ctx.stroke();
        ctx.fillStyle=col; ctx.font=`bold 7px monospace`; ctx.textAlign='center';
        ctx.fillText(b.label, xi-lw/2-2, y+4);
        // Arrow
        const d=b.type==='bull'||b.type==='hl'?-3:3;
        ctx.fillStyle=col;
        ctx.beginPath();
        ctx.moveTo(xi+2,y); ctx.lineTo(xi+7,y+d); ctx.lineTo(xi+7,y-d);
        ctx.closePath(); ctx.fill();
      });
    }

    // ── Liquidity ───────────────────────────────────────────────────────────
    if(ov.liq&&sigs?.liq){
      sigs.liq.slice(-5).forEach(l=>{
        const y=toY(l.price);
        const x1=PL, x2=W-PR;
        if(y<PT||y>PT+CH) return;
        const col=l.type==='eqh'?'#f43f5e':'#22d3ee';
        ctx.strokeStyle=col+'88'; ctx.lineWidth=0.9; ctx.setLineDash([3,2]);
        ctx.beginPath(); ctx.moveTo(x1,y); ctx.lineTo(x2,y); ctx.stroke();
        ctx.setLineDash([]);
        // Diamond at equal points
        const drawDia=(cx)=>{
          const s=3.5; ctx.fillStyle=col;
          ctx.beginPath();
          ctx.moveTo(cx,y-s); ctx.lineTo(cx+s,y); ctx.lineTo(cx,y+s); ctx.lineTo(cx-s,y);
          ctx.closePath(); ctx.fill();
        };
        const x_i1=toX(l.i1), x_i2=toX(l.i2);
        if(x_i1>=PL&&x_i1<=W-PR) drawDia(x_i1);
        if(x_i2>=PL&&x_i2<=W-PR) drawDia(x_i2);
        ctx.fillStyle=col+'bb'; ctx.font='bold 7px monospace'; ctx.textAlign='right';
        ctx.fillText(l.type==='eqh'?'EQH ▲':'EQL ▼', W-PR-4, y-2);
      });
    }

    // ── MS Labels (HH/HL/LH/LL) ─────────────────────────────────────────────
    if(ov.ms&&sigs?.ms){
      let lastHiX=-1e9, lastLoX=-1e9;
      sigs.ms.slice(-12).forEach(pt=>{
        if(pt.i<vs||pt.i>=endIdx) return;
        const x=toX(pt.i), y=toY(pt.price);
        const col=pt.side==='high'?'#f43f5e':'#22c55e';
        const off=pt.side==='high'?-10:10;
        // Dot (always)
        ctx.fillStyle=col;
        ctx.beginPath(); ctx.arc(x,y,2,0,Math.PI*2); ctx.fill();
        // Label only when it won't crowd the previous label on this side
        const lastX=pt.side==='high'?lastHiX:lastLoX;
        if(Math.abs(x-lastX)>=28){
          ctx.fillStyle=col+'ee'; ctx.font='bold 8px monospace'; ctx.textAlign='center';
          ctx.fillText(pt.label, x, y+off);
          ctx.strokeStyle=col+'44'; ctx.lineWidth=0.5;
          ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x,y+off*0.6); ctx.stroke();
          if(pt.side==='high') lastHiX=x; else lastLoX=x;
        }
      });
    }

    // ── EMAs ────────────────────────────────────────────────────────────────
    if(ov.ema&&sigs?.emas){
      [
        {d:sigs.emas.e20,  c:'#f59e0b90', w:0.8},
        {d:sigs.emas.e50,  c:'#a78bfa90', w:0.8},
        {d:sigs.emas.e200, c:'#ef444490', w:1.2},
      ].forEach(({d,c,w})=>{
        ctx.strokeStyle=c; ctx.lineWidth=w; ctx.setLineDash([]);
        ctx.beginPath(); let first=true;
        for(let i=vs;i<endIdx&&i<d.length;i++){
          const x=toX(i), y=toY(d[i]);
          if(y<PT-2||y>PT+CH+2){first=true; continue;}
          first?(ctx.moveTo(x,y),first=false):ctx.lineTo(x,y);
        }
        ctx.stroke();
      });
    }

    // ── Volume bars ──────────────────────────────────────────────────────────
    if(ov.vol&&VOL_H>0){
      const vBase=PT+CH+20+VOL_H;
      const maxV=Math.max(...vis.map(c=>c.vol||1));
      ctx.strokeStyle='#1e3a5a'; ctx.lineWidth=0.4;
      ctx.beginPath(); ctx.moveTo(PL,PT+CH+20); ctx.lineTo(W-PR,PT+CH+20); ctx.stroke();
      ctx.fillStyle='#1a3050'; ctx.font='7px monospace'; ctx.textAlign='left';
      ctx.fillText('VOL', PL+2, PT+CH+30);
      vis.forEach((c,vi)=>{
        const x=toX(vs+vi);
        const vh=((c.vol||0)/maxV)*VOL_H;
        ctx.fillStyle=c.bull?'rgba(34,197,94,0.3)':'rgba(239,68,68,0.3)';
        ctx.fillRect(x-bW/2, vBase-vh, bW, vh);
      });
    }

    // ── RSI panel ───────────────────────────────────────────────────────────
    if(ov.rsi&&RSI_H>0&&sigs?.rsi){
      const rBase=PT+CH+20+VOL_H;
      const rTop=rBase+4; const rH2=RSI_H-8;
      ctx.strokeStyle='#1e3a5a'; ctx.lineWidth=0.4;
      ctx.beginPath(); ctx.moveTo(PL,rTop); ctx.lineTo(W-PR,rTop); ctx.stroke();
      ctx.fillStyle='#1a3050'; ctx.font='7px monospace'; ctx.textAlign='left';
      ctx.fillText('RSI 14', PL+2, rTop+10);
      // 70/30 lines
      [70,50,30].forEach(lvl=>{
        const y=rTop+rH2-((lvl/100)*rH2);
        ctx.strokeStyle=lvl===50?'#1e3a5a33':'#1e3a5a22'; ctx.lineWidth=0.4; ctx.setLineDash(lvl===50?[3,2]:[]);
        ctx.beginPath(); ctx.moveTo(PL,y); ctx.lineTo(W-PR,y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle='#1e3a5a'; ctx.font='6px monospace'; ctx.textAlign='right';
        ctx.fillText(lvl, PL-2, y+2);
      });
      // RSI line
      ctx.strokeStyle='#a78bfa'; ctx.lineWidth=1; ctx.beginPath(); let first2=true;
      for(let i=vs;i<endIdx&&i<sigs.rsi.length;i++){
        const x=toX(i), y=rTop+rH2-((sigs.rsi[i]/100)*rH2);
        first2?(ctx.moveTo(x,y),first2=false):ctx.lineTo(x,y);
      }
      ctx.stroke();
      // Overbought/oversold fill
      ctx.fillStyle='rgba(239,68,68,0.08)'; ctx.fillRect(PL,rTop,CW,rH2*(1-70/100));
      ctx.fillStyle='rgba(34,197,94,0.08)'; ctx.fillRect(PL,rTop+rH2*(1-30/100),CW,rH2*(30/100));
    }

    // ── Candles ─────────────────────────────────────────────────────────────
    vis.forEach((c,vi)=>{
      const i=vs+vi;
      const x=toX(i);
      const oY=toY(c.open), cY=toY(c.close), hY=toY(c.high), lY=toY(c.low);
      const col=c.bull?'#22c55e':'#ef4444';
      const bTop=Math.min(oY,cY), bH=Math.max(1.5,Math.abs(oY-cY));
      ctx.strokeStyle=col; ctx.lineWidth=0.9;
      ctx.beginPath(); ctx.moveTo(x,hY); ctx.lineTo(x,lY); ctx.stroke();
      ctx.fillStyle=c.bull?'rgba(34,197,94,0.88)':'rgba(239,68,68,0.88)';
      ctx.fillRect(x-bW/2, bTop, bW, bH);
      ctx.strokeStyle=col; ctx.lineWidth=0.4;
      ctx.strokeRect(x-bW/2, bTop, bW, bH);
    });

    // ── Live price line ──────────────────────────────────────────────────────
    const last=candles[candles.length-1];
    if(last){
      const y=toY(last.close);
      if(y>=PT&&y<=PT+CH){
        ctx.strokeStyle='rgba(34,197,94,0.5)'; ctx.lineWidth=0.6; ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(PL,y); ctx.lineTo(W-PR,y); ctx.stroke();
        ctx.setLineDash([]);
        const s2=assetObj.id==="NIFTY50"?"₹":"$";
        const bLabel=last.close>=10000?`${s2}${(last.close/1000).toFixed(2)}k`:`${s2}${last.close.toFixed(2)}`;
        ctx.fillStyle='#22c55e';
        ctx.beginPath();
        if(ctx.roundRect) ctx.roundRect(W-PR-52,y-8,52,16,3);
        else ctx.rect(W-PR-52,y-8,52,16);
        ctx.fill();
        ctx.fillStyle='#000'; ctx.font='bold 8px monospace'; ctx.textAlign='center';
        ctx.fillText(bLabel, W-PR-26, y+4);
      }
    }

    // ── Crosshair & tooltip ──────────────────────────────────────────────────
    if(xhair){
      const {x,y,ci}=xhair;
      ctx.strokeStyle='rgba(96,165,250,0.35)'; ctx.lineWidth=0.7; ctx.setLineDash([4,3]);
      ctx.beginPath(); ctx.moveTo(PL,y); ctx.lineTo(W-PR,y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x,PT); ctx.lineTo(x,PT+CH); ctx.stroke();
      ctx.setLineDash([]);
      // Y price label
      const hp=pLo+pRng*(1-(y-PT)/CH);
      const hfmt=hp>=10000?`$${(hp/1000).toFixed(2)}k`:`$${hp.toFixed(2)}`;
      ctx.fillStyle='#1e3a5a'; ctx.textAlign='right';
      ctx.fillRect(0,y-8,PL-3,16);
      ctx.fillStyle='#60a5fa'; ctx.font='8px monospace'; ctx.fillText(hfmt,PL-5,y+3);

      if(ci>=0&&ci<candles.length){
        const c=candles[ci];
        const tw=130, th=90;
        const tx=Math.min(x+12,W-PR-tw-2);
        const ty=Math.max(PT+4,Math.min(y-th/2,PT+CH-th-4));
        ctx.fillStyle='rgba(6,13,23,0.96)'; ctx.strokeStyle='#1e3a5a'; ctx.lineWidth=0.5;
        ctx.beginPath();
        if(ctx.roundRect) ctx.roundRect(tx,ty,tw,th,6);
        else ctx.rect(tx,ty,tw,th);
        ctx.fill(); ctx.stroke();
        const col2=c.bull?'#22c55e':'#ef4444';
        ctx.fillStyle=col2; ctx.textAlign='left'; ctx.font='bold 8px monospace';
        ctx.fillText(c.bull?'▲ BULLISH':'▼ BEARISH',tx+8,ty+14);
        [['Open',c.open],['High',c.high],['Low',c.low],['Close',c.close]].forEach(([l,v],idx)=>{
          const s3=assetObj.id==="NIFTY50"?"₹":"$";
          const fmt2=v>=10000?`${s3}${(v/1000).toFixed(2)}k`:`${s3}${v.toFixed(2)}`;
          ctx.fillStyle=l==='Close'?col2:'#64748b';
          ctx.fillText(`${l.padEnd(6)} ${fmt2}`,tx+8,ty+28+idx*14);
        });
        if(sigs?.rsi&&ci<sigs.rsi.length){
          const r=sigs.rsi[ci];
          ctx.fillStyle=r>70?'#ef4444':r<30?'#22c55e':'#94a3b8';
          ctx.fillText(`RSI    ${r.toFixed(1)}`,tx+8,ty+84);
        }
      }
    }

    // ── Chart border ────────────────────────────────────────────────────────
    ctx.strokeStyle='#1e3a5a'; ctx.lineWidth=0.5; ctx.setLineDash([]);
    ctx.strokeRect(PL,PT,CW,CH);
  }

  // Mouse event helpers
  const canvasXY=(e)=>{
    const r=canvasRef.current.getBoundingClientRect();
    return {mx:e.clientX-r.left, my:e.clientY-r.top};
  };

  const handleMove=(e)=>{
    const {mx,my}=canvasXY(e);
    const {W,PL,PR,PT,CW,CH}=coords();
    // Pan while dragging
    if(dragRef.current){
      const dx=mx-dragRef.current.x;
      const shift=Math.round(dx/(CW/vl));
      if(Math.abs(shift)>=1){
        setVs(v=>Math.max(0,Math.min((candles?.length||0)-vl, v-shift)));
        dragRef.current={x:mx,y:my};
      }
    }
    if(mx<PL||mx>W-PR||my<PT||my>PT+CH){setXhair(null);return;}
    const ci=vs+Math.floor(((mx-PL)/(CW))*vl);
    setXhair({x:mx,y:my,ci:Math.max(0,Math.min((candles?.length||0)-1,ci))});
  };

  const handleWheel=(e)=>{
    e.preventDefault();
    const factor=e.deltaY>0?1.12:0.88;
    setVl(v=>Math.max(8,Math.min(candles?.length||90,Math.round(v*factor))));
    // Keep tail pinned
    setVs(v=>{
      const newVl=Math.max(8,Math.min(candles?.length||90,Math.round(vl*factor)));
      return Math.max(0,Math.min((candles?.length||0)-newVl, v));
    });
  };

  const assetObj=ASSETS.find(a=>a.id===asset)||ASSETS[0];
  const pos=change>=0;
  const isNifty=assetObj.id==="NIFTY50";
  const sym=isNifty?"":"$";
  const sfx=isNifty?" pts":"";
  const fmtP=p=>{
    if(p>=10000) return `${sym}${(p/1000).toFixed(2)}k${sfx}`;
    if(p>=100)   return `${sym}${p.toFixed(0)}${sfx}`;
    return `${sym}${p.toFixed(2)}${sfx}`;
  };

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100%',background:'#060d17',
      borderRadius:12,overflow:'hidden',border:'0.5px solid #1e3a5a'}}>

      {/* ── Header ── */}
      <div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',
        borderBottom:'0.5px solid #1e3a5a',flexShrink:0,flexWrap:'wrap'}}>
        <span style={{fontSize:13,fontWeight:800,color:'#e2e8f0'}}>{assetObj.label}</span>
        <span style={{fontSize:19,fontWeight:800,color:pos?'#22c55e':'#ef4444',fontFamily:'monospace'}}>
          {fmtP(price)}
        </span>
        <span style={{fontSize:9,padding:'2px 6px',borderRadius:4,
          color:pos?'#22c55e':'#ef4444',background:pos?'#052e16':'#1a0000',fontWeight:700}}>
          {pos?'+':''}{change.toFixed(2)}%
        </span>
        {/* Timeframe */}
        <div style={{display:'flex',gap:3,marginLeft:4}}>
          {['1m','5m','15m','1H','4H','1D','1W'].map(t=>(
            <span key={t} onClick={()=>setTf(t)}
              style={{fontSize:9,padding:'2px 7px',borderRadius:4,cursor:'pointer',fontFamily:'monospace',
                color:tf===t?'#60a5fa':'#7c8ea8',
                background:tf===t?'#1e3a5a':'transparent',
                border:`0.5px solid ${tf===t?'#3b82f6':'transparent'}`,
                opacity: loading ? 0.5 : 1,
              }}>{t}</span>
          ))}
        </div>
        {/* Loading / status indicator */}
        {loading
          ? <span style={{fontSize:9,color:'#f59e0b',background:'#1c1300',padding:'2px 8px',
              borderRadius:4,border:'0.5px solid #f59e0b40',fontFamily:'monospace',
              animation:'pulse 1s infinite'}}>⟳ Loading {tf}...</span>
          : fetchErr
          ? <span style={{fontSize:9,color:'#f59e0b',background:'#1c1300',padding:'2px 8px',
              borderRadius:4,border:'0.5px solid #f59e0b30'}}>⚠ Simulated</span>
          : <span style={{fontSize:9,color:'#22c55e',background:'#052e16',padding:'2px 7px',
              borderRadius:4,border:'0.5px solid #22c55e30',letterSpacing:'0.04em'}}>● LIVE {tf}</span>
        }
        <div style={{marginLeft:'auto',display:'flex',gap:3,flexWrap:'wrap'}}>
          {[
            {k:'sessions',l:'Sessions', c:'#60a5fa'},
            {k:'ob', l:'Order Block', c:'#f59e0b'},
            {k:'fvg',l:'FVG',         c:'#06b6d4'},
            {k:'bos',l:'BOS/CHoCH',   c:'#22c55e'},
            {k:'liq',l:'Liquidity',   c:'#f43f5e'},
            {k:'ms', l:'Structure',   c:'#a78bfa'},
            {k:'pd', l:'Prem/Disc',   c:'#64748b'},
            {k:'ema',l:'EMAs',        c:'#f59e0b'},
            {k:'vol',l:'Volume',      c:'#7c8ea8'},
            {k:'rsi',l:'RSI',         c:'#a78bfa'},
          ].map(({k,l,c})=>(
            <span key={k} onClick={()=>setOv(o=>({...o,[k]:!o[k]}))}
              style={{fontSize:8,padding:'2px 6px',borderRadius:3,cursor:'pointer',fontFamily:'monospace',
                fontWeight:600,letterSpacing:'0.03em',transition:'all 0.15s',
                background:ov[k]?c+'20':'#060d17',color:ov[k]?c:'#2a4060',
                border:`0.5px solid ${ov[k]?c+'55':'#1e2a3a'}`}}>
              {l}
            </span>
          ))}
        </div>
      </div>

      {/* ── Canvas ── */}
      <div ref={containerRef} style={{flex:1,position:'relative',
        cursor:dragRef.current?'grabbing':'crosshair',minHeight:0}}>
        <canvas ref={canvasRef}
          style={{display:'block',width:'100%',height:'100%',
            opacity: loading ? 0.35 : 1, transition:'opacity 0.3s'}}
          onMouseMove={handleMove}
          onMouseDown={e=>{const {mx,my}=canvasXY(e);dragRef.current={x:mx,y:my};}}
          onMouseUp={()=>{dragRef.current=null;}}
          onMouseLeave={()=>{setXhair(null);dragRef.current=null;}}
          onWheel={handleWheel}
        />
        {loading&&(
          <div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column',
            alignItems:'center',justifyContent:'center',gap:10,background:'rgba(6,13,23,0.55)',
            borderRadius:0}}>
            <div style={{fontSize:28,color:'#f59e0b',animation:'spin 1s linear infinite',
              display:'inline-block'}}>⟳</div>
            <div style={{fontSize:12,color:'#f59e0b',fontFamily:'monospace',fontWeight:600}}>
              Fetching {tf} candles...
            </div>
            <div style={{fontSize:10,color:'#94a3b8',fontFamily:'monospace'}}>
              {asset==='BTCUSD'||asset==='ETHUSD'?'Binance API':'Yahoo Finance'}
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
      `}</style>

      {/* ── EMA legend ── */}
      <div style={{display:'flex',gap:14,padding:'4px 12px',
        borderTop:'0.5px solid #0d1e35',flexShrink:0,flexWrap:'wrap',alignItems:'center'}}>
        {ov.sessions&&<>
          <span style={{fontSize:8,color:"#f59e0b",fontFamily:"monospace"}}>▬ Asia</span>
          <span style={{fontSize:8,color:"#a78bfa",fontFamily:"monospace"}}>▬ NSE</span>
          <span style={{fontSize:8,color:"#22c55e",fontFamily:"monospace"}}>▬ London</span>
          <span style={{fontSize:8,color:"#f43f5e",fontFamily:"monospace"}}>▬ New York</span>
        </>}
        {ov.ema&&[{c:'#f59e0b',l:'EMA 20'},{c:'#a78bfa',l:'EMA 50'},{c:'#ef4444',l:'EMA 200'}].map(e=>(
          <span key={e.l} style={{fontSize:8,color:e.c,fontFamily:'monospace'}}>─── {e.l}</span>
        ))}
        {ov.ob&&<span style={{fontSize:8,color:'#f59e0b',fontFamily:'monospace'}}>■ Order Block</span>}
        {ov.fvg&&<span style={{fontSize:8,color:'#06b6d4',fontFamily:'monospace'}}>■ FVG</span>}
        {ov.bos&&<span style={{fontSize:8,color:'#22c55e',fontFamily:'monospace'}}>── BOS</span>}
        {ov.bos&&<span style={{fontSize:8,color:'#a78bfa',fontFamily:'monospace'}}>─ CHoCH</span>}
        {ov.liq&&<span style={{fontSize:8,color:'#f43f5e',fontFamily:'monospace'}}>◆ EQH/EQL</span>}
        <span style={{marginLeft:'auto',fontSize:7,color:'#1e3a5a'}}>Scroll=zoom · Drag=pan</span>
      </div>
    </div>
  );
}


function Sparkline({data, color="#22c55e", h=32, w=80}) {
  if(!data||data.length<2) return null;
  const mn=Math.min(...data), mx=Math.max(...data), rng=mx-mn||1;
  const pts=data.map((v,i)=>`${(i/(data.length-1))*w},${h-((v-mn)/rng)*h}`).join(" ");
  return <svg width={w} height={h} style={{display:"block"}}>
    <defs>
      <linearGradient id={`sg${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity="0.3"/>
        <stop offset="100%" stopColor={color} stopOpacity="0"/>
      </linearGradient>
    </defs>
    <polygon points={`0,${h} ${pts} ${w},${h}`} fill={`url(#sg${color.replace("#","")})`}/>
    <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/>
  </svg>;
}

function CandleChart({candles, overlays=true}) {
  const [tip, setTip]=useState(null);
  const vis=candles.slice(-70);
  if(!vis.length) return null;
  const highs=vis.map(c=>c.high), lows=vis.map(c=>c.low);
  const pMin=Math.min(...lows), pMax=Math.max(...highs), pRng=pMax-pMin||1;
  const W=700,H=300,PL=58,PR=8,PT=16,PB=28;
  const cW=Math.max(3,(W-PL-PR)/vis.length-1);
  const toX=i=>PL+(i/(vis.length-1))*(W-PL-PR);
  const toY=p=>PT+(H-PT-PB)-(((p-pMin)/pRng)*(H-PT-PB));
  const grids=5;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%"
      style={{display:"block",cursor:"crosshair"}} onMouseLeave={()=>setTip(null)}>
      {/* grid */}
      {Array.from({length:grids},(_,i)=>{
        const p=pMin+(pRng*i)/(grids-1); const y=toY(p);
        return <g key={i}>
          <line x1={PL} y1={y} x2={W-PR} y2={y} stroke="#1a2e44" strokeWidth="0.6"/>
          <text x={PL-4} y={y+4} textAnchor="end" fontSize="8" fill="#7c8ea8"
            fontFamily="monospace">{p>1000?`${(p/1000).toFixed(1)}k`:p.toFixed(1)}</text>
        </g>;
      })}
      {/* volume bars */}
      {vis.map((c,i)=>{
        const x=toX(i); const maxV=Math.max(...vis.map(v=>v.vol));
        const vh=(c.vol/maxV)*40;
        return <rect key={`v${i}`} x={x-cW/2} y={H-PB-vh} width={cW} height={vh}
          fill={c.bull?"#22c55e":"#ef4444"} opacity="0.15"/>;
      })}
      {/* ICT zones overlay */}
      {overlays && <>
        <rect x={PL+(W-PL-PR)*0.25} y={toY(pMin+pRng*0.65)}
          width={(W-PL-PR)*0.1} height={toY(pMin+pRng*0.52)-toY(pMin+pRng*0.65)}
          fill="#f59e0b" opacity="0.12" rx="2"/>
        <text x={PL+(W-PL-PR)*0.26} y={toY(pMin+pRng*0.63)}
          fontSize="8" fill="#f59e0b" opacity="0.9" fontFamily="monospace">OB</text>
        <rect x={PL+(W-PL-PR)*0.62} y={toY(pMin+pRng*0.83)}
          width={(W-PL-PR)*0.08} height={toY(pMin+pRng*0.77)-toY(pMin+pRng*0.83)}
          fill="#06b6d4" opacity="0.14" rx="2"/>
        <text x={PL+(W-PL-PR)*0.63} y={toY(pMin+pRng*0.84)}
          fontSize="8" fill="#06b6d4" opacity="0.9" fontFamily="monospace">FVG</text>
        <line x1={PL+(W-PL-PR)*0.48} y1={PT} x2={PL+(W-PL-PR)*0.48} y2={H-PB}
          stroke="#a78bfa" strokeWidth="0.8" strokeDasharray="3,3" opacity="0.6"/>
        <text x={PL+(W-PL-PR)*0.485} y={PT+10} fontSize="7" fill="#a78bfa" fontFamily="monospace">BOS</text>
        <circle cx={PL+(W-PL-PR)*0.74} cy={toY(pMin+pRng*0.9)} r="6"
          fill="none" stroke="#f43f5e" strokeWidth="1" opacity="0.7"/>
        <text x={PL+(W-PL-PR)*0.755} y={toY(pMin+pRng*0.9)+3}
          fontSize="7" fill="#f43f5e" fontFamily="monospace">Liq</text>
      </>}
      {/* candles */}
      {vis.map((c,i)=>{
        const x=toX(i), oY=toY(c.open), cY=toY(c.close);
        const hY=toY(c.high), lY=toY(c.low);
        const col=c.bull?"#22c55e":"#ef4444";
        const bTop=Math.min(oY,cY), bH=Math.max(1,Math.abs(oY-cY));
        return <g key={i} onMouseEnter={()=>setTip({c,x,y:bTop})}>
          <line x1={x} y1={hY} x2={x} y2={lY} stroke={col} strokeWidth="0.8"/>
          <rect x={x-cW/2} y={bTop} width={cW} height={bH} fill={col} opacity="0.9" rx="0.5"/>
        </g>;
      })}
      {/* live price */}
      {(()=>{
        const last=vis[vis.length-1]; if(!last) return null;
        const y=toY(last.close);
        return <g>
          <line x1={PL} y1={y} x2={W-PR} y2={y} stroke="#22c55e" strokeWidth="0.5" strokeDasharray="4,3" opacity="0.5"/>
          <rect x={W-PR-36} y={y-7} width={36} height={14} fill="#22c55e" rx="3" opacity="0.9"/>
          <text x={W-PR-18} y={y+4} textAnchor="middle" fontSize="7" fill="black" fontFamily="monospace" fontWeight="bold">
            {last.close>1000?`${(last.close/1000).toFixed(2)}k`:last.close.toFixed(2)}
          </text>
        </g>;
      })()}
      {/* tooltip */}
      {tip && <g>
        <rect x={Math.min(tip.x+8,W-100)} y={tip.y-50} width={90} height={52}
          fill="#0a1628" stroke="#1e3a5a" strokeWidth="0.5" rx="4"/>
        <text x={Math.min(tip.x+14,W-94)} y={tip.y-37} fontSize="8" fill={tip.c.bull?"#22c55e":"#ef4444"} fontFamily="monospace">{tip.c.bull?"▲ BULL":"▼ BEAR"}</text>
        {[["O",tip.c.open],["H",tip.c.high],["L",tip.c.low],["C",tip.c.close]].map(([l,v],i)=>(
          <text key={l} x={Math.min(tip.x+14,W-94)} y={tip.y-26+i*9} fontSize="7.5" fill="#94a3b8" fontFamily="monospace">
            {l}: {v>1000?v.toFixed(0):v.toFixed(2)}
          </text>
        ))}
      </g>}
    </svg>
  );
}

function EquityCurve({curve}) {
  if(!curve||curve.length<2) return null;
  const mn=Math.min(...curve), mx=Math.max(...curve), rng=mx-mn||1;
  const W=400,H=120,PL=40,PB=20,PT=10,PR=10;
  const toX=i=>PL+(i/(curve.length-1))*(W-PL-PR);
  const toY=v=>PT+(H-PT-PB)-(((v-mn)/rng)*(H-PT-PB));
  const pts=curve.map((v,i)=>`${toX(i)},${toY(v)}`).join(" ");
  const color=curve[curve.length-1]>=curve[0]?"#22c55e":"#ef4444";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" style={{display:"block"}}>
      <defs>
        <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      {[0,0.25,0.5,0.75,1].map((t,i)=>{
        const v=mn+rng*t; const y=toY(v);
        return <g key={i}>
          <line x1={PL} y1={y} x2={W-PR} y2={y} stroke="#1a2e44" strokeWidth="0.5"/>
          <text x={PL-3} y={y+3} textAnchor="end" fontSize="7" fill="#7c8ea8" fontFamily="monospace">
            {v>=10000?`$${(v/1000).toFixed(0)}k`:`$${v.toFixed(0)}`}
          </text>
        </g>;
      })}
      <polygon points={`${PL},${H-PB} ${pts} ${W-PR},${H-PB}`} fill="url(#eqGrad)"/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  );
}

// ─── TRADINGVIEW ADVANCED CHART ───────────────────────────────────────────────
const TV_SYMBOLS = {
  BTCUSD:  "BINANCE:BTCUSDT",
  XAUUSD:  "OANDA:XAUUSD",
  ETHUSD:  "BINANCE:ETHUSDT",
  NIFTY50: "NSE:NIFTY",
};
const TV_TF_MAP = {
  "1m":"1","5m":"5","15m":"15","1H":"60","4H":"240","1D":"D","1W":"W",
};

function TradingViewChart({ asset, price, change }) {
  const containerRef = useRef(null);
  const [tf, setTf]   = useState("60");
  const [studies, setStudies] = useState(true);

  const symbol  = TV_SYMBOLS[asset] || "BINANCE:BTCUSDT";
  const assetObj = ASSETS.find(a => a.id === asset) || ASSETS[0];
  const pos      = change >= 0;

  const isNifty  = asset === "NIFTY50";
  const sym      = isNifty ? "" : "$";
  const sfx      = isNifty ? " pts" : "";
  const fmtPrice = p =>
    p >= 10000 ? `${sym}${(p/1000).toFixed(2)}k${sfx}` :
    p >= 100   ? `${sym}${p.toFixed(0)}${sfx}`          :
                 `${sym}${p.toFixed(2)}${sfx}`;

  // Re-inject widget when symbol or tf changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Wipe previous widget
    el.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "tradingview-widget-container__widget";
    wrapper.style.height = "100%";
    wrapper.style.width  = "100%";
    el.appendChild(wrapper);

    const config = {
      autosize:              true,
      symbol:                symbol,
      interval:              tf,
      timezone:              "Asia/Kolkata",
      theme:                 "dark",
      style:                 "1",            // candlesticks
      locale:                "en",
      backgroundColor:       "rgba(6,13,23,1)",
      gridColor:             "rgba(14,30,52,0.8)",
      toolbar_bg:            "#0a1628",
      enable_publishing:     false,
      hide_top_toolbar:      false,
      hide_legend:           false,
      hide_side_toolbar:     false,
      allow_symbol_change:   false,
      save_image:            false,
      studies: studies ? [
        "RSI@tv-basicstudies",
        "MAExp@tv-basicstudies",
        "VWAP@tv-basicstudies",
      ] : [],
      container_id:          "tv_chart_container",
      withdateranges:        true,
      details:               true,
      hotlist:               false,
      calendar:              false,
      support_host:          "https://www.tradingview.com",
    };

    const script = document.createElement("script");
    script.type  = "text/javascript";
    script.src   = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.innerHTML = JSON.stringify(config);
    el.appendChild(script);

    return () => { el.innerHTML = ""; };
  }, [symbol, tf, studies]);

  const tfOptions = [
    {label:"1m",  val:"1"},
    {label:"5m",  val:"5"},
    {label:"15m", val:"15"},
    {label:"1H",  val:"60"},
    {label:"4H",  val:"240"},
    {label:"1D",  val:"D"},
    {label:"1W",  val:"W"},
  ];

  return (
    <div style={{height:"100%",display:"flex",flexDirection:"column",
      background:"#060d17",borderRadius:12,overflow:"hidden",
      border:"0.5px solid #1e3a5a"}}>

      {/* ── Header bar ── */}
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",
        borderBottom:"0.5px solid #1e3a5a",flexShrink:0,flexWrap:"wrap",
        background:"#0a1628"}}>

        {/* Symbol + price */}
        <span style={{fontSize:13,fontWeight:800,color:"#e2e8f0",letterSpacing:"0.02em"}}>
          {assetObj.label}
        </span>
        <span style={{fontSize:18,fontWeight:800,
          color:pos?"#22c55e":"#ef4444",fontFamily:"monospace"}}>
          {fmtPrice(price)}
        </span>
        <span style={{fontSize:9,padding:"2px 6px",borderRadius:4,fontWeight:700,
          color:pos?"#22c55e":"#ef4444",
          background:pos?"#052e16":"#1a0000"}}>
          {pos?"+":""}{change.toFixed(2)}%
        </span>

        {/* Exchange tag */}
        <span style={{fontSize:8,color:"#7c8ea8",background:"#0d1b2a",
          padding:"2px 7px",borderRadius:4,border:"0.5px solid #1e3a5a"}}>
          {assetObj.exchange}
        </span>

        <div style={{flex:1}}/>

        {/* Timeframe pills */}
        <div style={{display:"flex",gap:3}}>
          {tfOptions.map(t=>(
            <span key={t.val} onClick={()=>setTf(t.val)}
              style={{fontSize:9,padding:"3px 8px",borderRadius:4,cursor:"pointer",
                fontFamily:"monospace",fontWeight:600,transition:"all 0.15s",
                color:tf===t.val?"#60a5fa":"#7c8ea8",
                background:tf===t.val?"#1e3a5a":"transparent",
                border:`0.5px solid ${tf===t.val?"#3b82f6":"transparent"}`}}>
              {t.label}
            </span>
          ))}
        </div>

        {/* Studies toggle */}
        <div onClick={()=>setStudies(s=>!s)}
          style={{display:"flex",alignItems:"center",gap:5,cursor:"pointer",
            padding:"3px 8px",borderRadius:5,
            background:studies?"#1e3a5a":"transparent",
            border:`0.5px solid ${studies?"#3b82f6":"#1e3a5a"}`}}>
          <span style={{fontSize:8,color:studies?"#60a5fa":"#7c8ea8",fontFamily:"monospace"}}>
            {studies?"◈ Studies ON":"◈ Studies"}
          </span>
        </div>

        {/* Live badge */}
        <span style={{fontSize:8,color:"#22c55e",background:"#052e16",
          padding:"3px 7px",borderRadius:4,border:"0.5px solid #22c55e30",
          fontWeight:700,letterSpacing:"0.04em"}}>
          ● LIVE
        </span>
      </div>

      {/* ── TradingView widget container ── */}
      <div ref={containerRef}
        id="tv_chart_container"
        className="tradingview-widget-container"
        style={{flex:1,width:"100%",minHeight:0}} />
    </div>
  );
}

// ─── DHAN CHART (TradingView Lightweight Charts, fed with real Dhan candles) ──
// Used for Indian indices instead of the TradingView embed, which can't render
// Dhan data. Free open-source library (Apache-2.0); data comes from the bridge.
function DhanLightweightChart({ candles, asset, price, change, marketOpen=true }) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);
  const seriesRef    = useRef(null);

  // Build the chart once.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout:  { background:{ color:"#0a1628" }, textColor:"#94a3b8", fontFamily:"monospace", fontSize:10 },
      grid:    { vertLines:{ color:"#0d1b2d" }, horzLines:{ color:"#0d1b2d" } },
      rightPriceScale: { borderColor:"#1e3a5a" },
      timeScale:       { borderColor:"#1e3a5a", timeVisible:true, secondsVisible:false },
      crosshair:       { mode:0 },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor:"#22c55e", downColor:"#ef4444",
      borderUpColor:"#22c55e", borderDownColor:"#ef4444",
      wickUpColor:"#22c55e", wickDownColor:"#ef4444",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => { try { chart.remove(); } catch {} chartRef.current = null; seriesRef.current = null; };
  }, []);

  // Push candle data whenever it changes (real Dhan candles for Indian indices).
  useEffect(() => {
    if (!seriesRef.current || !Array.isArray(candles) || !candles.length) return;
    const seen = new Set();
    const data = candles
      .filter(c => c && Number.isFinite(c.ts) && Number.isFinite(c.close))
      .map(c => ({ time: Math.floor(c.ts/1000), open:+c.open, high:+c.high, low:+c.low, close:+c.close }))
      .sort((a,b)=>a.time-b.time)
      .filter(d => { if (seen.has(d.time)) return false; seen.add(d.time); return true; }); // lib needs unique asc time
    try { seriesRef.current.setData(data); chartRef.current?.timeScale().fitContent(); } catch {}
  }, [candles]);

  return (
    <div style={{height:"100%",display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"4px 8px",flexShrink:0}}>
        <span style={{fontSize:12,fontWeight:800,color:"#e2e8f0"}}>{ASSETS.find(a=>a.id===asset)?.label||asset}</span>
        <span style={{fontSize:12,fontWeight:800,color:"#e2e8f0",fontFamily:"monospace"}}>
          {Number(price)?.toLocaleString("en-IN",{maximumFractionDigits:2})}
        </span>
        <span style={{fontSize:10,fontWeight:700,color:(change>=0)?"#22c55e":"#ef4444",fontFamily:"monospace"}}>
          {change>=0?"+":""}{Number(change||0).toFixed(2)}%
        </span>
        <span style={{marginLeft:"auto",fontSize:8,color:"#7c8ea8",fontFamily:"monospace"}}>
          {marketOpen?"● Dhan LIVE":"○ Dhan · last close"}
        </span>
      </div>
      <div ref={containerRef} style={{flex:1,minHeight:0,width:"100%"}} />
    </div>
  );
}

// ─── CHART SWITCHER ───────────────────────────────────────────────────────────
const DHAN_CHART_ASSETS = ["NIFTY50", "BANKNIFTY", "SENSEX"];
function ChartSwitcher({ asset, price, change, candles, marketOpen=true }) {
  const [mode, setMode] = useState("tv"); // "tv" | "ict"
  const isDhan = DHAN_CHART_ASSETS.includes(asset);

  return (
    <div style={{height:"100%",display:"flex",flexDirection:"column",gap:0}}>
      {/* Tab bar */}
      <div style={{display:"flex",gap:4,marginBottom:5,flexShrink:0,alignItems:"center"}}>
        <div onClick={()=>setMode("tv")}
          style={{display:"flex",alignItems:"center",gap:6,padding:"4px 12px",borderRadius:6,
            cursor:"pointer",transition:"all 0.15s",
            background:mode==="tv"?"#1e3a5a":"#0a1628",
            border:`0.5px solid ${mode==="tv"?"#3b82f6":"#1e3a5a"}`}}>
          <span style={{fontSize:10,color:mode==="tv"?"#60a5fa":"#7c8ea8",fontWeight:mode==="tv"?700:400}}>
            {isDhan?"📊 Dhan Chart":"📊 TradingView"}
          </span>
          {mode==="tv"&&<span style={{fontSize:7,color:"#22c55e",background:"#052e16",
            padding:"1px 4px",borderRadius:3,border:"0.5px solid #22c55e30"}}>{isDhan?"DHAN DATA":"LIVE"}</span>}
        </div>
        <div onClick={()=>setMode("ict")}
          style={{display:"flex",alignItems:"center",gap:6,padding:"4px 12px",borderRadius:6,
            cursor:"pointer",transition:"all 0.15s",
            background:mode==="ict"?"#1e3a5a":"#0a1628",
            border:`0.5px solid ${mode==="ict"?"#f59e0b":"#1e3a5a"}`}}>
          <span style={{fontSize:10,color:mode==="ict"?"#f59e0b":"#7c8ea8",fontWeight:mode==="ict"?700:400}}>
            ◈ ICT Analysis
          </span>
          {mode==="ict"&&<span style={{fontSize:7,color:"#f59e0b",background:"#1c1300",
            padding:"1px 4px",borderRadius:3,border:"0.5px solid #f59e0b30"}}>OB · FVG · BOS</span>}
        </div>

        {/* ── Session Status (fills the empty space to the right) ── */}
        <SessionStatusBar/>
      </div>

      {/* Chart panels — both mounted, only active one visible */}
      <div style={{flex:1,minHeight:0,position:"relative"}}>
        <div style={{position:"absolute",inset:0,
          opacity:mode==="tv"?1:0,
          pointerEvents:mode==="tv"?"auto":"none",
          transition:"opacity 0.2s"}}>
          {isDhan
            ? <DhanLightweightChart candles={candles} asset={asset} price={price} change={change} marketOpen={marketOpen}/>
            : <TradingViewChart asset={asset} price={price} change={change}/>}
        </div>
        <div style={{position:"absolute",inset:0,
          opacity:mode==="ict"?1:0,
          pointerEvents:mode==="ict"?"auto":"none",
          transition:"opacity 0.2s"}}>
          <AdvancedICTChart candles={candles} asset={asset} price={price} change={change}/>
        </div>
      </div>
    </div>
  );
}

// ─── SESSION STATUS BAR (compact, for chart tab bar) ─────────────────────────
function SessionStatusBar() {
  const [now, setNow] = useState(new Date());
  useEffect(()=>{ const t=setInterval(()=>setNow(new Date()),1000); return()=>clearInterval(t); },[]);

  const utcH = now.getUTCHours() + now.getUTCMinutes()/60 + now.getUTCSeconds()/3600;

  // IST = UTC + 5:30
  const istNow  = new Date(now.getTime() + 5.5*60*60*1000);
  const istStr  = `${String(istNow.getUTCHours()).padStart(2,"0")}:${String(istNow.getUTCMinutes()).padStart(2,"0")}:${String(istNow.getUTCSeconds()).padStart(2,"0")}`;

  const SESSIONS = [
    { name:"Sydney",   start:21,   end:6,    color:"#34d399", icon:"🦘", ist:"02:30–11:30" },
    { name:"Tokyo",    start:0,    end:9,    color:"#60a5fa", icon:"⛩",  ist:"05:30–14:30" },
    { name:"NSE",      start:3.75, end:10,   color:"#a78bfa", icon:"🇮🇳", ist:"09:15–15:30" },
    { name:"London",   start:7,    end:16,   color:"#f59e0b", icon:"🎡", ist:"12:30–21:30" },
    { name:"New York", start:12,   end:21,   color:"#f43f5e", icon:"🗽", ist:"17:30–02:30" },
  ];
  const KILL_ZONES = [
    { name:"London KZ",  start:7,    end:9.5,  color:"#f59e0b", ist:"12:30–15:00" },
    { name:"NY Open KZ", start:12,   end:14,   color:"#f43f5e", ist:"17:30–19:30" },
    { name:"NSE Open KZ",start:3.75, end:5,    color:"#a78bfa", ist:"09:15–10:30" },
    { name:"Asian KZ",   start:0,    end:2,    color:"#60a5fa", ist:"05:30–07:30" },
  ];

  const isActive = (s,e) => s<e ? utcH>=s&&utcH<e : utcH>=s||utcH<e;
  const minsUntil = (t) => { let r=t-utcH; if(r<0)r+=24; return Math.max(0,Math.round(r*60)); };
  const fmtTime = (m) => m<60?`${m}m`:`${Math.floor(m/60)}h ${m%60}m`;

  const active   = SESSIONS.filter(s=>isActive(s.start,s.end));
  const inactive = SESSIONS.filter(s=>!isActive(s.start,s.end));
  const activeKZ = KILL_ZONES.find(kz=>isActive(kz.start,kz.end));
  const nextOpen = inactive.map(s=>({...s,mins:minsUntil(s.start)})).sort((a,b)=>a.mins-b.mins)[0];
  const primary  = active[0];

  return (
    <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8,flexShrink:0}}>

      {/* Kill zone badge — appears when active */}
      {activeKZ&&(
        <div style={{display:"flex",alignItems:"center",gap:4,
          background:"#1c1300",border:`0.5px solid ${activeKZ.color}60`,
          borderRadius:6,padding:"2px 8px",animation:"pulse 2s infinite"}}>
          <span style={{fontSize:9}}>⚡</span>
          <div>
            <div style={{fontSize:8,fontWeight:800,color:activeKZ.color,letterSpacing:"0.05em"}}>{activeKZ.name}</div>
            <div style={{fontSize:7,color:"#94a3b8"}}>{activeKZ.ist} IST · closes {fmtTime(minsUntil(activeKZ.end))}</div>
          </div>
        </div>
      )}

      {/* Session status */}
      <div style={{display:"flex",alignItems:"center",gap:6,
        background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:8,
        padding:"4px 10px"}}>

        {active.length > 0 ? (
          <>
            <div style={{width:6,height:6,borderRadius:"50%",background:primary.color,
              boxShadow:`0 0 6px ${primary.color}`,flexShrink:0,animation:"pulse 2s infinite"}}/>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:3,marginBottom:1}}>
                {active.map(s=>(
                  <span key={s.name} style={{fontSize:9,fontWeight:700,color:s.color}}>
                    {s.icon} {s.name}
                  </span>
                ))}
                <span style={{fontSize:7,color:"#22c55e",background:"#052e16",
                  padding:"0px 4px",borderRadius:2,marginLeft:2,letterSpacing:"0.04em"}}>OPEN</span>
              </div>
              <div style={{fontSize:8,color:"#94a3b8"}}>
                <span style={{color:"#7c8ea8"}}>closes </span>
                <span style={{color:primary.color,fontFamily:"monospace",fontWeight:600}}>{fmtTime(minsUntil(primary.end))}</span>
                {nextOpen&&<span style={{color:"#64748b"}}>
                  {" · "}{nextOpen.icon} {nextOpen.name} in <span style={{color:"#7c8ea8",fontFamily:"monospace"}}>{fmtTime(nextOpen.mins)}</span>
                </span>}
              </div>
            </div>
          </>
        ) : (
          <>
            <div style={{width:6,height:6,borderRadius:"50%",background:"#7c8ea8",flexShrink:0}}/>
            <div>
              <div style={{fontSize:9,color:"#94a3b8",fontWeight:600}}>Off-Session</div>
              {nextOpen&&<div style={{fontSize:8,color:"#7c8ea8"}}>
                {nextOpen.icon} {nextOpen.name} <span style={{fontFamily:"monospace",color:"#94a3b8"}}>{fmtTime(nextOpen.mins)}</span>
              </div>}
            </div>
          </>
        )}

        {/* IST clock */}
        <div style={{borderLeft:"0.5px solid #1e3a5a",paddingLeft:8,marginLeft:2}}>
          <div style={{fontSize:9,fontFamily:"monospace",fontWeight:700,color:"#e2e8f0"}}>{istStr}</div>
          <div style={{fontSize:7,color:"#7c8ea8",textAlign:"center"}}>IST</div>
        </div>
      </div>
    </div>
  );
}

// ─── ICT SCREENER — detects high-probability setups from candle data ──────────
function screenAsset(assetId, livePrice, dayChangePct = null) {
  // Quick technical screening using price action rules
  // Returns { signal: true/false, score: 0-100, bias, reasons }
  //
  // Momentum/bias comes from TODAY'S real % change (MT5 D1 open / Dhan prev
  // close, passed in from the live feed). The old version compared livePrice
  // to the static ASSETS[].base constant — once the market drifted below those
  // stale anchors it screened BEARISH forever (97 of 99 MT5 trades were sells).
  const base  = ASSETS.find(a=>a.id===assetId)?.base || livePrice;
  const drift = ((livePrice - base) / base) * 100; // % from base (fallback only)
  const momentum = Number.isFinite(dayChangePct) ? dayChangePct : drift;

  let score = 50;
  const reasons = [];

  // Volatility check — is price moving TODAY? (signal of active market)
  const absD = Math.abs(momentum);
  if (absD > 0.3)  { score += 10; reasons.push("Price momentum active"); }
  if (absD > 0.8)  { score += 10; reasons.push("Strong directional move"); }
  if (absD > 2.0)  { score += 5;  reasons.push("High volatility"); }

  // Kill zone bonus
  const utcH = new Date().getUTCHours() + new Date().getUTCMinutes()/60;
  const KZ = [
    {s:3.75,e:5,name:"NSE Open KZ"},
    {s:7,   e:9.5,name:"London KZ"},
    {s:12,  e:14, name:"NY Open KZ"},
    {s:0,   e:2,  name:"Asian KZ"},
  ];
  const activeKZ = KZ.find(kz=>utcH>=kz.s&&utcH<kz.e);
  if (activeKZ) { score += 20; reasons.push(`${activeKZ.name} active`); }

  // Session alignment bonus
  const NSE_OPEN = utcH>=3.75 && utcH<10;
  const LONDON   = utcH>=7    && utcH<16;
  const NY       = utcH>=12   && utcH<21;
  if (assetId==="NIFTY50" && NSE_OPEN) { score += 10; reasons.push("NSE session"); }
  if (assetId==="XAUUSD"  && LONDON)   { score += 8;  reasons.push("London Gold session"); }
  if (assetId==="BTCUSD"  && NY)       { score += 8;  reasons.push("NY Crypto session"); }
  if (assetId==="ETHUSD"  && NY)       { score += 8;  reasons.push("NY Crypto session"); }

  // Bias from today's momentum. Flat day (<0.1%) = NEUTRAL = no signal —
  // a coin-flip direction is not a setup.
  const bias = momentum > 0.1 ? "BULLISH" : momentum < -0.1 ? "BEARISH" : "NEUTRAL";

  return {
    signal: score >= 70 && bias !== "NEUTRAL",
    score:  Math.min(score, 95),
    bias,
    reasons,
    activeKZ: activeKZ?.name || null,
  };
}

// ─── SIGNAL DE-DUPLICATION ────────────────────────────────────────────────────
// Stops the SAME setup (asset + bias + entry level) from being fired more than
// once within a window. Persisted to localStorage so it survives page reloads.
const SIGNAL_DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours
// Fingerprint a signal by asset + direction only (NOT exact price), so the same
// setup can't fire twice within the window even if the price drifted a little.
function signalSignature(assetId, bias /* entry intentionally ignored */) {
  return `${assetId}|${bias}`;
}
function isDuplicateSignal(sig) {
  try {
    const arr = JSON.parse(localStorage.getItem("alphaedge_recent_sigs") || "[]");
    const now = Date.now();
    return arr.some(s => s.sig === sig && (now - s.time) < SIGNAL_DEDUP_WINDOW_MS);
  } catch { return false; }
}
function recordSignalSignature(sig) {
  try {
    const now = Date.now();
    let arr = JSON.parse(localStorage.getItem("alphaedge_recent_sigs") || "[]");
    arr = arr.filter(s => now - s.time < 24 * 60 * 60 * 1000); // keep last 24h
    arr.push({ sig, time: now });
    localStorage.setItem("alphaedge_recent_sigs", JSON.stringify(arr));
  } catch { /* ignore */ }
}

// ─── ACTIVE STRATEGIES ────────────────────────────────────────────────────────
// Strategies the user has backtested and activated from the Backtest page.
// The auto-signal engine applies an active strategy (per asset) when generating.
function getActiveStrategies() {
  try { return JSON.parse(localStorage.getItem("alphaedge_active_strategies") || "[]"); }
  catch { return []; }
}
function addActiveStrategy(entry) {
  try {
    const list = getActiveStrategies().filter(s => !(s.id === entry.id && s.assetId === entry.assetId));
    list.push(entry);
    localStorage.setItem("alphaedge_active_strategies", JSON.stringify(list));
  } catch { /* ignore */ }
}
function removeActiveStrategy(id, assetId) {
  try {
    const list = getActiveStrategies().filter(s => !(s.id === id && s.assetId === assetId));
    localStorage.setItem("alphaedge_active_strategies", JSON.stringify(list));
  } catch { /* ignore */ }
}
function isStrategyActive(id, assetId) {
  return getActiveStrategies().some(s => s.id === id && s.assetId === assetId);
}

// ─── MONEY MANAGEMENT ─────────────────────────────────────────────────────────
// User's position-sizing & risk rules, applied to every order before it's sent.
const MONEY_MGT_DEFAULTS = {
  capital: 400000,      // account capital (₹) — default trading capital
  lotSize: 0.01,        // fixed lot size sent to MT5
  useSL: false,         // if true, force the fixed SL distance below
  slPoints: 50,         // fixed stop-loss distance in price points
  rr: 2,                // reward:risk multiple (1, 1.5, 2, 2.5) or "trail"
  trailMaxRR: 3,        // in "trail" mode, run until this R:R (up to 50)
  // Step-trailing default OFF (2026-07-05): strategy-lab full-history grid
  // tested 5 TSL ladders vs fixed SL/TP across 42 strategy×instrument combos —
  // NO ladder beat Fixed (TSL cost −154% net across 60 combos, hurt in 34).
  // Reversion/pullback entries retrace through entry before TP, so breakeven
  // stops scratch winners. Re-enable per-trade from Money Mgt if wanted.
  trailAfter1R: false,  // legacy toggle: move SL to breakeven & trail after 1:1
  stepTrailEnabled: false,
  beTriggerR: 1,
  trailStartR: 1,
  trailStepPoints: 500,
  trailDistancePoints: 500,
  closeOppositeFirst: true,
  fetchCapitalFromMT5: true,
};
function getMoneyMgt() {
  try { return { ...MONEY_MGT_DEFAULTS, ...JSON.parse(localStorage.getItem("alphaedge_money_mgt") || "{}") }; }
  catch { return { ...MONEY_MGT_DEFAULTS }; }
}
function setMoneyMgt(v) {
  try { localStorage.setItem("alphaedge_money_mgt", JSON.stringify(v)); } catch { /* ignore */ }
}

// ─── DISCIPLINE GUARDRAILS ─────────────────────────────────────────────────────
// Mechanical rules derived from the 2026-06-23 Dhan option-buying audit (net
// −₹3.4L). Each maps to a documented flaw and blocks AlphaEdge from executing a
// rule-violating trade. Thresholds are user-editable (Settings → Discipline).
const GUARDRAIL_DEFAULTS = {
  enabled:          true,
  cooldownMin:      15,    // no new entry within N min of closing a loss
  maxTradesPerDay:  5,     // hard daily trade cap
  maxConsecLosses:  2,     // stop for the session after N losses in a row
  openLockout:      true,  // no entries during the volatile open
  openLockoutEnd:   "10:15", // IST — first entries allowed after this
  blockExpiryDay:   true,  // no 0-DTE long options
  minPremium:       40,    // option-buying premium floor (avoid far-OTM lottery)
  maxHoldMin:       30,    // time-stop for open option longs (bridge/alert)
  dailyLossHalt:    0,     // bridge auto-halt: close all + block at −N (MT5 account ccy); 0 = off
  dailyProfitLock:  0,     // bridge profit lock: block NEW entries once day realized ≥ +N; 0 = off
  profitGivebackPct: 50,   // bridge give-back stop: lock when day P&L falls N% off its peak; 0 = off
};
function getGuardrails() {
  try { return { ...GUARDRAIL_DEFAULTS, ...JSON.parse(localStorage.getItem("alphaedge_guardrails") || "{}") }; }
  catch { return { ...GUARDRAIL_DEFAULTS }; }
}
function setGuardrails(v) {
  try { localStorage.setItem("alphaedge_guardrails", JSON.stringify(v)); } catch { /* ignore */ }
}

// Current time in IST as a Date (regardless of the machine's local zone).
function nowIST() {
  const n = new Date();
  return new Date(n.getTime() + (n.getTimezoneOffset() + 330) * 60000);
}
function istDayKey(ts) {
  const n = new Date(ts);
  return new Date(n.getTime() + (n.getTimezoneOffset() + 330) * 60000).toDateString();
}

// Is this an Indian exchange instrument (NSE/BSE)? Open-lockout & expiry rules
// apply to these only — BTC/XAU/ETH trade 24/7 and have no NSE 09:15 open.
function isIndianInstrument(asset) {
  const s = String(asset || "").toUpperCase();
  return /NIFTY|BANKNIFTY|SENSEX|BANKEX|FINNIFTY|MIDCP/.test(s);
}

// Broker-realized per-setup performance (from the 'AE <setup>' MT5 order
// comments) — the closed learning loop for signal generation: fetched from
// the bridge (1h cache) and injected into the auto-screen AI prompt so it
// favors setups that pay at REAL fills and avoids ones that lose. The
// cross-app audit showed theoretical R overstates results 3-8x vs broker.
let SETUP_PERF = null;
let SETUP_PERF_TS = 0;
async function fetchSetupPerformance() {
  if (SETUP_PERF && Date.now() - SETUP_PERF_TS < 60 * 60 * 1000) return SETUP_PERF;
  try {
    const base = (getAnyBridgeUrl() || "").replace(/\/signal\/?$/, "");
    if (!base) return SETUP_PERF;
    const r = await fetch(`${base}/setups/performance?days=30`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    if (d && d.ok) { SETUP_PERF = d; SETUP_PERF_TS = Date.now(); }
  } catch { /* bridge offline — keep last known */ }
  return SETUP_PERF;
}
function setupPerfPromptSection() {
  const rows = (SETUP_PERF?.setups || []).filter(s => s.trades >= 3 && s.setup !== "(untagged)");
  if (!rows.length) return "";
  const lines = rows.map(s => `- ${s.setup}: ${s.trades} trades, ${s.winRate}% win, net $${s.net}`);
  return `\nBROKER-REALIZED SETUP PERFORMANCE (actual MT5 fills, last 30 days — trust this over theoretical win rates):\n`
       + lines.join("\n")
       + `\nPrefer setups with positive realized net. Reject or reduce confidence for setups losing at real fills.\n`;
}

// NSE holiday info — fetched once per session from the bridge, which refreshes
// it daily from Dhan's public holiday calendar. Read synchronously by
// evaluateGuardrails via this module cache.
let NSE_HOLIDAY_INFO = null;
async function fetchNseHolidayInfo() {
  try {
    const base = (getAnyBridgeUrl() || "").replace(/\/signal\/?$/, "");
    if (!base) return null;
    const r = await fetch(`${base}/market/holiday`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    if (d && d.ok) NSE_HOLIDAY_INFO = d;
    return NSE_HOLIDAY_INFO;
  } catch { return NSE_HOLIDAY_INFO; }
}

// Trading session + prime-window flag per asset, in IST. Used to TAG every
// generated signal so the engine "keeps in mind" the best time to trade and the
// weekly analysis can confirm which session is actually most profitable.
//   gold prime  = London–NY overlap 19:00–21:30 IST
//   Indian prime= 14:00–15:30 IST (audit edge); 09:15–10:15 = avoid
function marketSession(asset, at = null) {
  const base = at ? new Date(at) : new Date();
  const ist = new Date(base.getTime() + (base.getTimezoneOffset() + 330) * 60000);
  const dow = ist.getDay();                 // 0 Sun .. 6 Sat
  const m   = ist.getHours() * 60 + ist.getMinutes();
  const a   = String(asset || "").toUpperCase();

  if (isIndianInstrument(a)) {
    if (dow === 0 || dow === 6 || m < 555 || m > 930) return { session: "Closed", prime: false, quality: "closed" };
    if (m < 615)  return { session: "NSE Open (volatile)", prime: false, quality: "avoid" };  // 09:15–10:15
    if (m >= 840) return { session: "NSE Afternoon",       prime: true,  quality: "prime" };  // 14:00–15:30
    return { session: "NSE Midday", prime: false, quality: "ok" };
  }
  if (/XAU|GOLD/.test(a)) {
    // Vantage XAUUSD+ hours, verified from actual M1 bar data (server UTC+3):
    // daily open 03:30 IST → close 02:27 IST next day (break 02:30–03:30 IST).
    // Normal Fridays close Sat ~02:26 IST, BUT US-holiday Fridays close 22:30
    // IST unannounced (Juneteenth 19-Jun, July-4th 3-Jul-26) — so Friday from
    // 21:45 IST is treated as closed; the bridge blocks new gold entries then
    // and flattens open gold at 22:15 IST.
    if (dow === 6 && m > 150)   return { session: "Closed (weekend)", prime: false, quality: "closed" };
    if (dow === 0)              return { session: "Closed (weekend)", prime: false, quality: "closed" };
    if (dow === 1 && m < 210)   return { session: "Closed (weekend)", prime: false, quality: "closed" }; // Mon opens 03:30 IST
    if (dow === 5 && m >= 1305) return { session: "Closed (Fri gold cutoff)", prime: false, quality: "closed" }; // 21:45 IST
    if (m >= 150 && m < 210)    return { session: "Closed (daily break)", prime: false, quality: "closed" }; // 02:30–03:30 IST
    if (m >= 1140 && m <= 1290) return { session: "London–NY Overlap", prime: true,  quality: "prime" }; // 19:00–21:30 ⭐
    if (m >= 750  && m < 1140)  return { session: "London",            prime: false, quality: "ok"    }; // 12:30–19:00
    if (m > 1290 || m < 150)    return { session: "New York",          prime: false, quality: "ok"    }; // 21:30–02:30
    if (m >= 330  && m < 750)   return { session: "Asian (thin)",      prime: false, quality: "thin"  }; // 05:30–12:30
    return { session: "Off-hours (thin)", prime: false, quality: "thin" };
  }
  // Crypto — 24/7; treat US/Europe afternoon as the busier window
  if (/BTC|ETH/.test(a)) {
    if (m >= 750 && m <= 1290) return { session: "Active (EU/US)", prime: false, quality: "ok" };
    return { session: "24/7", prime: false, quality: "ok" };
  }
  return { session: "", prime: false, quality: "ok" };
}

// Evaluate all guardrails against trade history (+ an optional candidate signal).
// `asset` lets exchange-specific rules (NSE open lockout) target Indian markets.
// Returns { blocked, violations[], warnings[], state{} } — drives both the
// execution block and the live Discipline Monitor.
function evaluateGuardrails(history = [], signal = null, asset = null) {
  const g = getGuardrails();
  const ist = nowIST();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const todayKey = ist.toDateString();
  const violations = [], warnings = [];
  const indian = isIndianInstrument(asset || signal?.asset || signal?.symbol);

  const todays = history.filter(s => s && s.timestamp && istDayKey(s.timestamp) === todayKey);
  const resolved = history.filter(isResolvedSignal).sort((a, b) => b.timestamp - a.timestamp);
  let consec = 0;
  for (const s of resolved) { if (isLossSignal(s)) consec++; else break; }
  const lastLoss = resolved.find(isLossSignal);
  // Count cooldown from when the loss CLOSED (MT5 close time) if known, else
  // from signal time — so a freshly-closed MT5 loss triggers the cooldown.
  const lossTime = lastLoss ? (lastLoss.closedAt || lastLoss.timestamp) : 0;
  const cooldownLeft = lastLoss
    ? Math.max(0, Math.ceil(g.cooldownMin - (Date.now() - lossTime) / 60000))
    : 0;

  if (!g.enabled) {
    return { blocked: false, violations, warnings, state: { tradesToday: todays.length, consec, cooldownLeft, disabled: true } };
  }

  // 1) Post-loss cooldown
  if (g.cooldownMin > 0 && cooldownLeft > 0)
    violations.push(`Cooldown active — ${cooldownLeft} min left after last loss (revenge-trade guard)`);
  // 2) Daily trade cap
  if (todays.length >= g.maxTradesPerDay)
    violations.push(`Daily trade cap reached (${todays.length}/${g.maxTradesPerDay}) — stop for today`);
  // 3) Consecutive-loss session stop
  if (consec >= g.maxConsecLosses)
    violations.push(`${consec} consecutive losses — session stop (no revenge trades)`);
  // 4) NSE market-open lockout — Indian instruments only (BTC/XAU/ETH exempt)
  let inNseOpen = false;
  if (g.openLockout) {
    const [h, m] = String(g.openLockoutEnd || "10:15").split(":").map(Number);
    const end = (h || 10) * 60 + (m || 15);
    inNseOpen = mins >= (9 * 60 + 15) && mins < end;
    // Only blocks an actual Indian-instrument trade. When asset is unknown
    // (general monitor view), it's informational, not a block.
    if (inNseOpen && indian)
      violations.push(`NSE open lockout until ${g.openLockoutEnd} IST (worst window in your audit) — Indian instruments only`);
  }
  // 5) Expiry-day / 0-DTE (option signals only)
  if (g.blockExpiryDay && signal && signal.expiry) {
    if (istDayKey(signal.timestamp || Date.now()) === istDayKey(new Date(signal.expiry).getTime()))
      violations.push("0-DTE long blocked — no option buying on expiry day");
  }
  // 6) Premium floor (option signals only)
  if (g.minPremium > 0 && signal && Number.isFinite(Number(signal.optionPremium))) {
    if (Number(signal.optionPremium) < g.minPremium)
      violations.push(`Premium ₹${signal.optionPremium} below floor ₹${g.minPremium} — far-OTM lottery guard`);
  }
  // 7) NSE holiday + intraday square-off (Indian instruments only). The bridge
  //    enforces both server-side; this mirrors them in the UI/engine.
  if (indian) {
    if (NSE_HOLIDAY_INFO?.isHoliday)
      violations.push("NSE holiday today (Dhan calendar) — Indian market closed");
    else if (mins >= 15 * 60 + 5 && mins <= 15 * 60 + 30)
      violations.push("NSE square-off — no new entries after 15:05 IST (flat before 15:20, close 15:30)");
  }
  // Warning (not a block): one trade away from the daily cap
  if (todays.length === g.maxTradesPerDay - 1)
    warnings.push(`Last trade of the day — ${todays.length + 1}/${g.maxTradesPerDay}`);

  return {
    blocked: violations.length > 0,
    violations, warnings,
    state: { tradesToday: todays.length, maxTrades: g.maxTradesPerDay, consec, cooldownLeft,
             nseOpenWindow: inNseOpen,                       // NSE 09:15→lockout-end window active
             inOpenLockout: inNseOpen && (indian || asset===null) },  // chip status for Indian context
  };
}

// ─── AUTO SIGNAL ENGINE ────────────────────────────────────────────────────────
// Screens ALL assets every 5 minutes → AI validates → broadcasts if high confidence
function AutoSignalEngine({ prices, changes, enabled, onSignalSaved }) {
  const [status,     setStatus]     = useState("idle");
  const [lastSignal, setLastSignal] = useState(null);
  const [nextScan,   setNextScan]   = useState(null);
  const [scanLog,    setScanLog]    = useState([]);

  // Per-asset cooldown: don't re-broadcast same asset within 30 mins
  const cooldowns = useRef({});

  const hasTelegram = () => getTgToken() && getTgChatId();
  const hasAI       = () => getGroqKey()||getGeminiKey()||getDeepSeekKey()||getOpenRouterKey();

  const scanAllAssets = async () => {
    if (!hasTelegram() || !hasAI()) return;

    setStatus("scanning");
    await fetchSetupPerformance();   // refresh realized per-setup stats (1h cache)
    const log = [];

    for (const assetObj of ASSETS) {
      const livePrice = prices[assetObj.id] || assetObj.base;
      const screen    = screenAsset(assetObj.id, livePrice, changes?.[assetObj.id]);

      log.push({ asset: assetObj.label, score: screen.score, signal: screen.signal });

      // Skip if below threshold or in cooldown
      const cooldownMs = 30 * 60 * 1000; // 30 min per asset
      const lastTime   = cooldowns.current[assetObj.id] || 0;
      if (!screen.signal || Date.now() - lastTime < cooldownMs) continue;

      // ── AI Validation ──────────────────────────────────────────────────────
      setStatus(`validating ${assetObj.label}...`);

      const sym    = assetObj.id==="NIFTY50"?"₹":"$";
      const slPct  = assetObj.id==="NIFTY50"?0.6:assetObj.id==="XAUUSD"?0.5:1.2;
      const tp1Pct = slPct*1.5, tp2Pct=slPct*3.0;
      const exEntry= Math.round(livePrice);
      const exSL   = Math.round(livePrice*(1-(screen.bias==="BULLISH"?slPct:-slPct)/100));
      const exTP1  = Math.round(livePrice*(1+(screen.bias==="BULLISH"?tp1Pct:-tp1Pct)/100));
      const exTP2  = Math.round(livePrice*(1+(screen.bias==="BULLISH"?tp2Pct:-tp2Pct)/100));
      const ruleContext = signalRuleContextForPrompt(assetObj, "Auto", "Auto-Screen");
      const activeStrat = getActiveStrategies().find(s => s.assetId === assetObj.id);
      const stratContext = activeStrat
        ? `\nACTIVE STRATEGY: Apply the user's backtested strategy "${activeStrat.name}" (win rate ${activeStrat.winRate}%, profit factor ${activeStrat.profitFactor}). Use it as the primary setup logic and name it in "setup".\n`
        : "";
      const autoWikiCtx = await fetchWikiContext(assetObj.id, "ict");
      const autoWikiSection = autoWikiCtx
        ? `\n\n===== TRADER'S WIKI =====\n${autoWikiCtx}\n===== END WIKI =====\n`
        : "";

      const prompt = `You are an elite ICT/SMC trader validating a trade signal.

Asset: ${assetObj.label}
Current Live Price: ${sym}${livePrice.toLocaleString(undefined,{maximumFractionDigits:2})}
Pre-screen bias: ${screen.bias}
Pre-screen score: ${screen.score}/100
Reasons: ${screen.reasons.join(", ")}
Kill Zone: ${screen.activeKZ||"None"}
${autoWikiSection}
${stratContext}
${setupPerfPromptSection()}
${ruleContext}

TASK: Validate if this is a HIGH PROBABILITY trade. Only approve confidence >= 75.
All price levels must be realistic and near ${sym}${livePrice.toLocaleString(undefined,{maximumFractionDigits:2})}.

Respond ONLY with this JSON:
{"approved":true,"confidence":82,"nature":"Intraday","bias":"${screen.bias}","setup":"ICT Order Block + Kill Zone","entry":${exEntry},"stopLoss":${exSL},"takeProfit1":${exTP1},"takeProfit2":${exTP2},"riskReward":3.0,"quadrantPlan":{"smallLoss":"Exit at SL, no averaging down","smallProfit":"TP1/trailing stop only","bigLoss":"Blocked by mandatory SL","bigProfit":"Hold TP2 for 1:3 RR when trend confirms"},"ruleAudit":{"passed":true,"minRR":3,"stopIsMandatory":true,"bigLossBlocked":true},"learningAdjustments":["Applied recent outcome memory"],"ictFactors":["Order Block respected","FVG above unfilled"],"smcFactors":["BOS confirmed"],"macroFactors":["Kill zone momentum"],"killZone":"${screen.activeKZ||"Active Session"}","invalidation":"4H close beyond SL","summary":"Strong ICT confluence validated during kill zone. High probability setup.","riskWarning":"Manage position size appropriately"}

If NOT a high probability trade, set "approved":false and "confidence" below 75.
JSON only, no markdown:`;

      try {
        const data   = await callAI(prompt, 900);
        const raw    = data.content?.[0]?.text || "";
        const match  = raw.match(/\{[\s\S]*\}/);
        if (!match) continue;
        const parsed = JSON.parse(match[0]);

        if (!parsed.approved || (parsed.confidence||0) < 75) continue;
        const guarded = enforceSignalRules(parsed, { assetObj, livePrice, source:"Auto-Screen" });

        // ── De-dup: skip if this exact setup already fired recently ──────────
        const sigKey = signalSignature(assetObj.id, guarded.bias, guarded.entry);
        if (isDuplicateSignal(sigKey)) { log.push({ asset: assetObj.label, skipped:"duplicate" }); continue; }

        // ── Approved! Save to history + broadcast ───────────────────────────
        cooldowns.current[assetObj.id] = Date.now();
        recordSignalSignature(sigKey);

        const record = {
          id:          `AUTO-${Date.now()}`,
          timestamp:   Date.now(),
          asset:       assetObj.label,
          assetId:     assetObj.id,
          timeframe:   guarded.nature==="Scalping"?"5m": guarded.nature==="Swing"?"4H":"1H",
          nature:      guarded.nature    || "Intraday",
          bias:        guarded.bias,
          confidence:  guarded.confidence,
          setup:       guarded.setup,
          entry:       guarded.entry,
          stopLoss:    guarded.stopLoss,
          takeProfit1: guarded.takeProfit1,
          takeProfit2: guarded.takeProfit2,
          riskReward:  guarded.riskReward,
          killZone:    guarded.killZone,
          summary:     guarded.summary,
          ictFactors:  guarded.ictFactors,
          smcFactors:  guarded.smcFactors,
          macroFactors:guarded.macroFactors,
          invalidation:guarded.invalidation,
          riskWarning: guarded.riskWarning,
          quadrantPlan:guarded.quadrantPlan,
          ruleAudit:   guarded.ruleAudit,
          learningSnapshot: guarded.learningSnapshot,
          learningAdjustments: guarded.learningAdjustments,
          outcome:     "pending",
          source:      "Auto-Screen",
          tradeType:   getExecMode()==="mt5_live" ? "Real" : getExecMode()==="mt5_demo" ? "Demo" : "Paper",
          session:     marketSession(assetObj.label).session,
          primeWindow: marketSession(assetObj.label).prime,
          sessionQuality: marketSession(assetObj.label).quality,
        };
        const updated = await appendSignal(record);
        if (onSignalSaved) onSignalSaved(updated);

        // No Telegram on signal generation — alerts fire only on trade placed/closed.
        // Auto-screened signal still routes to the MT5 bridge (which alerts on fill).
        const autoMt5 = await sendToMT5(guarded, assetObj.label, record.timeframe);
        await attachMt5Ticket(record.id, autoMt5);
        setLastSignal({
          asset:      assetObj.label,
          confidence: guarded.confidence,
          nature:     guarded.nature,
          bias:       guarded.bias,
          sent:       autoMt5.ok,
          time:       new Date(),
        });
        setStatus(autoMt5.ok ? "sent" : "validated-nosend");
        setTimeout(()=>setStatus("idle"), 10000);
        // Only one signal per scan cycle
        break;

      } catch { continue; }
    }

    setScanLog(log);
    if (status === "scanning" || status.startsWith("validating")) {
      setStatus("idle");
    }

    // Schedule next scan in 5 minutes
    setNextScan(new Date(Date.now() + 5*60*1000));
  };

  // Run every 5 minutes
  useEffect(()=>{
    if (!enabled) { setStatus("idle"); setNextScan(null); return; }

    // First scan after 10s (let prices load), then every 5 min
    const first = setTimeout(()=>scanAllAssets(), 10000);
    const interval = setInterval(()=>scanAllAssets(), 5*60*1000);
    setNextScan(new Date(Date.now() + 10000));

    return ()=>{ clearTimeout(first); clearInterval(interval); };
  }, [enabled, prices]);

  if (!enabled) return null;

  const minsToNext = nextScan ? Math.max(0, Math.round((nextScan-Date.now())/60000)) : 5;
  const secsToNext = nextScan ? Math.max(0, Math.round((nextScan-Date.now())/1000)%60) : 0;

  // Floating "Auto-Screen" status box removed per user request — the engine still
  // runs in the background; strategy control now lives on the Backtest page.
  return null;
  /* eslint-disable no-unreachable */
  return (
    <div style={{position:"fixed",bottom:16,right:16,zIndex:9999,
      background:"#0a1628",border:`0.5px solid ${status==="sent"?"#22c55e":"#1e3a5a"}`,
      borderRadius:10,padding:"10px 14px",minWidth:240,
      boxShadow:`0 4px 20px rgba(0,0,0,0.6)${status==="sent"?", 0 0 20px #22c55e30":""}`}}>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
        <div style={{width:7,height:7,borderRadius:"50%",flexShrink:0,
          background:status==="idle"?"#60a5fa":status.startsWith("scan")?"#f59e0b":
            status.startsWith("valid")?"#a78bfa":status==="sent"?"#22c55e":"#ef4444",
          boxShadow:`0 0 6px ${status==="sent"?"#22c55e":status.startsWith("valid")?"#a78bfa":"#60a5fa"}`}}/>
        <span style={{fontSize:10,fontWeight:700,color:"#e2e8f0",fontFamily:"monospace"}}>
          🤖 Auto-Screen
        </span>
        <span style={{fontSize:7,color:"#22c55e",background:"#052e16",
          padding:"1px 5px",borderRadius:3,marginLeft:"auto",letterSpacing:"0.04em"}}>ACTIVE</span>
      </div>

      <div style={{fontSize:9,color:"#94a3b8",fontFamily:"monospace",marginBottom:4}}>
        {status==="idle"           && `⏱ Next scan: ${minsToNext}m ${secsToNext}s`}
        {status==="scanning"       && "🔍 Screening all assets..."}
        {status.startsWith("valid")&& `🧠 AI validating ${status.replace("validating ","")}...`}
        {status==="sent"           && "✅ Signal routed to MT5!"}
        {status==="validated-nosend"&&"⚠️ Validated · MT5 send failed"}
      </div>

      {lastSignal&&(
        <div style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,
          padding:"5px 8px",marginBottom:4}}>
          <div style={{fontSize:8,color:"#7c8ea8",marginBottom:2}}>Last signal sent</div>
          <div style={{fontSize:9,fontWeight:700,
            color:lastSignal.bias==="BULLISH"?"#22c55e":"#ef4444",fontFamily:"monospace"}}>
            {lastSignal.nature==="Scalping"?"⚡":lastSignal.nature==="Intraday"?"🕐":"📈"} {lastSignal.asset}
            {" "}{lastSignal.bias==="BULLISH"?"▲":"▼"} {lastSignal.confidence}%
          </div>
          <div style={{fontSize:7,color:"#7c8ea8",marginTop:1,fontFamily:"monospace"}}>
            {lastSignal.time?.toLocaleString("en-IN",{timeZone:"Asia/Kolkata",
              hour:"2-digit",minute:"2-digit",hour12:false})} IST
            {" · "}{lastSignal.sent?"✓ Sent":"✗ Not sent"}
          </div>
        </div>
      )}

      {scanLog.length>0&&(
        <div>
          <div style={{fontSize:7,color:"#7c8ea8",marginBottom:3,letterSpacing:"0.06em"}}>LAST SCAN</div>
          <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
            {scanLog.map(l=>(
              <span key={l.asset} style={{fontSize:7,fontFamily:"monospace",
                padding:"1px 5px",borderRadius:3,
                color:l.signal?"#22c55e":"#7c8ea8",
                background:l.signal?"#052e16":"#060d17",
                border:`0.5px solid ${l.signal?"#22c55e30":"#1e2a3a"}`}}>
                {l.asset.split("/")[0]} {l.score}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{fontSize:7,color:"#64748b",marginTop:5,fontFamily:"monospace"}}>
        Scans every 5min · Broadcasts confidence ≥75
      </div>
    </div>
  );
}
// Live discipline cockpit — reads trade history, evaluates guardrails, shows a
// GREEN/AMBER/RED "clear to trade?" verdict + per-rule status. Serves both the
// AlphaEdge signal engine and the user's own manual option trading.
function DisciplineMonitor() {
  const [hist, setHist] = useState([]);
  const [tick, setTick] = useState(0);
  const [risk, setRisk] = useState(null);   // bridge kill-switch / daily-loss state
  const [busy, setBusy] = useState(false);
  const prevHalted = useRef(false);
  useEffect(() => {
    let stop = false;
    const load = async () => { const h = await loadHistory(); if (!stop) setHist(h); };
    const loadRisk = async () => {
      try {
        const base = (getAnyBridgeUrl() || "").replace(/\/signal\/?$/, "");
        if (!base) return;
        const r = await fetch(`${base}/risk`, { signal: AbortSignal.timeout(8000) });
        const d = await r.json();
        if (stop) return;
        // Alert the moment an AUTO halt engages (bridge already closed everything).
        if (d.halted && !prevHalted.current && d.autoHaltDay)
          sendTelegram(`🛑 <b>AUTO-HALT</b>\n${d.reason}\nAll AlphaEdge positions closed — trading blocked until tomorrow (or manual resume).`);
        prevHalted.current = !!d.halted;
        setRisk(d);
      } catch { if (!stop) setRisk(null); }
    };
    load(); loadRisk();
    fetchNseHolidayInfo();   // daily first-login check (bridge caches per IST day)
    const iv = setInterval(() => { load(); loadRisk(); setTick(t => t + 1); }, 30000);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  const riskPost = async (payload) => {
    setBusy(true);
    try {
      const base = (getAnyBridgeUrl() || "").replace(/\/signal\/?$/, "");
      const r = await fetch(`${base}/risk`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
      const d = await r.json().catch(()=>null);
      if (d && typeof d.halted === "boolean") { prevHalted.current = d.halted; setRisk(d); }
      return d;
    } catch { return null; }
    finally { setBusy(false); }
  };
  const killSwitch = async () => {
    const n = risk?.pnl?.openPositions ?? 0;
    if (!window.confirm(`KILL SWITCH — close ${n} open AlphaEdge position(s) at market and block ALL trading until you resume?`)) return;
    const d = await riskPost({ action:"halt", reason:"Manual kill switch" });
    if (d) sendTelegram(`🛑 <b>KILL SWITCH</b> pressed — ${d.closeResult?.closed?.length ?? 0} position(s) closed, trading halted.`);
  };
  const resumeTrading = async () => {
    if (!window.confirm("Resume trading? The halt (incl. today's daily-loss stop, if it tripped) will be lifted.")) return;
    await riskPost({ action:"resume" });
  };

  const g  = getGuardrails();
  const ev = evaluateGuardrails(hist);
  const color   = !g.enabled ? "#64748b" : ev.blocked ? "#ef4444" : ev.warnings.length ? "#f59e0b" : "#22c55e";
  const verdict = !g.enabled ? "GUARDRAILS OFF" : ev.blocked ? "STAND DOWN" : ev.warnings.length ? "CAUTION" : "CLEAR TO TRADE";
  const st = ev.state;
  const chips = [
    { k:"Cooldown",    ok: st.cooldownLeft===0,            v: st.cooldownLeft ? `${st.cooldownLeft}m` : "clear" },
    { k:"Trades today",ok: st.tradesToday < g.maxTradesPerDay, v: `${st.tradesToday}/${g.maxTradesPerDay}` },
    { k:"Loss streak", ok: st.consec < g.maxConsecLosses,  v: `${st.consec}/${g.maxConsecLosses}` },
    { k:"NSE open",    ok: !st.nseOpenWindow,              v: st.nseOpenWindow ? `till ${g.openLockoutEnd}` : "clear" },
  ];

  return (
    <div style={{background:"#0a1628",border:`0.5px solid ${color}55`,borderRadius:10,padding:"10px 12px",flexShrink:0}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
        <span style={{width:9,height:9,borderRadius:"50%",background:color,boxShadow:`0 0 6px ${color}`}}/>
        <span style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em"}}>DISCIPLINE</span>
        <span style={{marginLeft:"auto",fontSize:11,fontWeight:800,color,fontFamily:"monospace"}}>{verdict}</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
        {chips.map(c=>(
          <div key={c.k} style={{display:"flex",alignItems:"center",gap:5,background:"#060d17",border:`0.5px solid ${c.ok?"#1e3a5a":"#ef444450"}`,borderRadius:6,padding:"5px 7px"}}>
            <span style={{fontSize:9,color:c.ok?"#22c55e":"#ef4444"}}>{c.ok?"✓":"✗"}</span>
            <span style={{fontSize:8,color:"#7c8ea8",flex:1}}>{c.k}</span>
            <span style={{fontSize:9,color:c.ok?"#94a3b8":"#ef4444",fontFamily:"monospace",fontWeight:700}}>{c.v}</span>
          </div>
        ))}
      </div>
      {ev.blocked && (
        <div style={{marginTop:7,background:"#1a0000",border:"0.5px solid #ef444440",borderRadius:6,padding:"6px 8px"}}>
          {ev.violations.map((v,i)=><div key={i} style={{fontSize:9,color:"#fca5a5",lineHeight:1.5}}>🛑 {v}</div>)}
        </div>
      )}
      {!ev.blocked && ev.warnings.map((w,i)=>(
        <div key={i} style={{marginTop:6,fontSize:9,color:"#f59e0b"}}>⚠ {w}</div>
      ))}
      {NSE_HOLIDAY_INFO?.isHoliday && (
        <div style={{marginTop:6,fontSize:9,color:"#f59e0b"}}>📅 NSE holiday today — Indian market closed (Dhan calendar)</div>
      )}
      {/* Bridge kill switch + daily-loss auto-halt */}
      <div style={{marginTop:8,background:"#060d17",border:`0.5px solid ${risk?.halted?"#ef4444":"#1e3a5a"}`,borderRadius:6,padding:"7px 8px"}}>
        {risk ? (<>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:8,color:"#7c8ea8",flex:1}}>MT5 P&L TODAY</span>
            <span style={{fontSize:11,fontWeight:800,fontFamily:"monospace",color:(risk.pnl?.total??0)<0?"#ef4444":"#22c55e"}}>
              {risk.pnl ? `${risk.pnl.total>=0?"+":""}${risk.pnl.total.toFixed(2)}` : "—"}
            </span>
            <span style={{fontSize:8,color:risk.dailyLossLimit>0?"#64748b":"#f59e0b"}}>
              {risk.dailyLossLimit>0 ? `auto-halt at −${risk.dailyLossLimit}` : "auto-halt OFF"}
            </span>
          </div>
          {risk.halted && (
            <div style={{marginTop:5,fontSize:9,color:"#fca5a5",lineHeight:1.4}}>🛑 TRADING HALTED — {risk.reason}</div>
          )}
          {!risk.halted && risk.profitLock?.active && (
            <div style={{marginTop:5,fontSize:9,color:"#4ade80",lineHeight:1.4}}>🔒 {risk.profitLock.reason}</div>
          )}
          <button onClick={risk.halted?resumeTrading:killSwitch} disabled={busy}
            style={{marginTop:6,width:"100%",padding:"7px 0",borderRadius:6,cursor:"pointer",fontWeight:800,fontSize:10,letterSpacing:"0.08em",
              border:`1px solid ${risk.halted?"#22c55e":"#ef4444"}`,color:risk.halted?"#22c55e":"#fff",
              background:risk.halted?"transparent":"#b91c1c",opacity:busy?0.6:1}}>
            {busy ? "…" : risk.halted ? "RESUME TRADING" : `🛑 KILL SWITCH — CLOSE ALL${risk.pnl?.openPositions?` (${risk.pnl.openPositions})`:""}`}
          </button>
        </>) : (
          <div style={{fontSize:8,color:"#64748b"}}>Kill switch: bridge offline — start the MT5 bridge on :5000</div>
        )}
      </div>
      <div style={{marginTop:6,fontSize:8,color:"#64748b",lineHeight:1.4}}>
        Also active for option buys: no 0-DTE · ATM/ITM only (≥₹{g.minPremium}) · {g.maxHoldMin}m time-stop. Edit in Settings → Discipline.
      </div>
    </div>
  );
}

// Homepage "GEO ALERTS" panel — live macro/geo headlines, auto-refreshing.
// Seeds from whatever the module cache holds (fallback on first paint), fetches
// on mount, and re-polls every 5 minutes. A ticking clock keeps the "3h ago"
// labels current between fetches.
function GeoAlertsPanel() {
  const [alerts, setAlerts] = useState(() => getGeoAlerts());
  const [, setTick]         = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const live = await fetchGeoAlerts();
      if (alive && live && live.length) setAlerts(live);
    };
    load();
    const poll = setInterval(load, 5 * 60 * 1000);   // refetch every 5 min
    const tick = setInterval(() => alive && setTick(t => t + 1), 60 * 1000); // refresh "x ago"
    return () => { alive = false; clearInterval(poll); clearInterval(tick); };
  }, []);

  return (
    <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:10,
      padding:"10px 10px",flexShrink:0}}>
      <div style={{fontSize:8,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:8}}>GEO ALERTS</div>
      <div style={{display:"flex",flexDirection:"column",gap:5}}>
        {alerts.slice(0,3).map((g,i)=>{
          const ic=g.impact==="high"?"#ef4444":g.impact==="medium"?"#f59e0b":"#94a3b8";
          const when = g.ts ? geoTimeAgo(g.ts) : g.time;
          return (
            <div key={i} style={{background:"#060d17",borderLeft:`2px solid ${ic}`,
              borderRadius:"0 6px 6px 0",padding:"6px 9px"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                <span style={{fontSize:7,fontWeight:700,color:ic,letterSpacing:"0.06em"}}>{g.impact.toUpperCase()}</span>
                <span style={{fontSize:7,color:"#7c8ea8"}}>{when}</span>
              </div>
              <div style={{fontSize:10,color:"#94a3b8",lineHeight:1.4}}>{g.text}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DashboardPage({prices, changes, candles, sources={}, activeAsset, setActiveAsset, marketOpen=true, onRefresh, refreshing}) {
  const asset=ASSETS.find(a=>a.id===activeAsset);
  const price=prices[activeAsset]||asset.base;
  const change=changes[activeAsset]||0;
  const cdata=candles[activeAsset]||[];
  const isNifty=activeAsset==="NIFTY50";

  const fmtP=(id,p)=>{
    const a=ASSETS.find(x=>x.id===id)||asset;
    const sym=a.id==="NIFTY50"?"":"$";
    const sfx=a.id==="NIFTY50"?" pts":"";
    if(p>=10000) return `${sym}${(p/1000).toFixed(2)}k${sfx}`;
    if(p>=100)   return `${sym}${p.toFixed(1)}${sfx}`;
    return `${sym}${p.toFixed(2)}${sfx}`;
  };

  const ASSET_SIGNALS={
    BTCUSD:[
      {dir:"BUY",   nature:"Intraday", name:"ICT OB Bounce",        conf:87, strategy:"ICT",   entry:96800, sl:95200, tp:99400},
      {dir:"BUY",   nature:"Swing",    name:"SMC MSS + FVG",        conf:74, strategy:"SMC",   entry:97100, sl:95800, tp:100200},
      {dir:"SELL",  nature:"Intraday", name:"Geo-risk Hedge",       conf:61, strategy:"Macro", entry:97500, sl:98800, tp:94000},
      {dir:"NEUTRAL",nature:"Scalping",name:"RSI Divergence",       conf:55, strategy:"Classic",entry:null,  sl:null,  tp:null},
    ],
    XAUUSD:[
      {dir:"BUY",   nature:"Swing",    name:"Safe-haven Bid",       conf:91, strategy:"Macro", entry:4520,  sl:4480,  tp:4620},
      {dir:"BUY",   nature:"Intraday", name:"ICT OB Weekly",        conf:78, strategy:"ICT",   entry:4510,  sl:4470,  tp:4600},
    ],
    ETHUSD:[
      {dir:"SELL",  nature:"Scalping", name:"Liquidity Sweep",      conf:69, strategy:"ICT",   entry:3210,  sl:3290,  tp:3050},
      {dir:"SELL",  nature:"Intraday", name:"CHoCH Bearish",        conf:63, strategy:"SMC",   entry:3195,  sl:3260,  tp:3000},
    ],
    NIFTY50:[
      {dir:"BUY",   nature:"Intraday", name:"RBI Rate Hold Bounce", conf:82, strategy:"Macro", entry:24650, sl:24300, tp:25200},
      {dir:"BUY",   nature:"Intraday", name:"FII Inflow OB",        conf:76, strategy:"ICT",   entry:24700, sl:24400, tp:25400},
      {dir:"BUY",   nature:"Scalping", name:"NSE Open Kill Zone",   conf:71, strategy:"ICT",   entry:24720, sl:24450, tp:25100},
      {dir:"SELL",  nature:"Swing",    name:"Budget Risk Hedge",    conf:55, strategy:"Macro", entry:24900, sl:25200, tp:24100},
    ],
  };
  const signals=ASSET_SIGNALS[activeAsset]||ASSET_SIGNALS.BTCUSD;

  return (
    <div style={{display:"flex",gap:10,height:"100%",overflow:"hidden"}}>

      {/* ── LEFT: Asset ribbon + Signals + Geo Alerts ── */}
      {/* overflowY:auto so on short windows the whole cockpit scrolls instead of
          hard-clipping the Geo Alerts panel at the bottom (only 1 of 3 showing). */}
      <div style={{width:290,display:"flex",flexDirection:"column",gap:8,overflowY:"auto",flexShrink:0}}>

        {/* Asset ribbon */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,flexShrink:0}}>
          {ASSETS.map(a=>{
            const p=prices[a.id]||a.base, ch=changes[a.id]||0, pos=ch>=0;
            const spark=(candles[a.id]||[]).slice(-20).map(c=>c.close);
            const src=sources[a.id];
            const isMT5=src==="MT5";
            return (
              <div key={a.id} onClick={()=>setActiveAsset(a.id)}
                style={{background:a.id===activeAsset?"#111e30":"#0a1628",
                  border:`0.5px solid ${a.id===activeAsset?"#3b82f6":"#1e3a5a"}`,
                  borderRadius:8,padding:"7px 8px",cursor:"pointer",transition:"all 0.15s"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div>
                    <div style={{fontSize:9,fontWeight:700,color:a.id===activeAsset?"#60a5fa":"#64748b"}}>{a.label}</div>
                    <div style={{fontSize:13,fontWeight:800,color:"#e2e8f0",marginTop:1,fontFamily:"monospace"}}>
                      {fmtP(a.id,p)}
                    </div>
                    <div style={{fontSize:9,color:pos?"#22c55e":"#ef4444",marginTop:1}}>
                      {pos?"+":""}{ch.toFixed(2)}%
                    </div>
                  </div>
                  <Sparkline data={spark} color={pos?"#22c55e":"#ef4444"} h={32} w={50}/>
                </div>
                {src&&(
                  <div style={{marginTop:4,fontSize:7,fontWeight:700,letterSpacing:"0.04em",
                    color:isMT5?"#22c55e":"#7c8ea8"}}>
                    {isMT5?"● via MT5":`○ ${src}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Stats strip */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:5,flexShrink:0}}>
          {[
            {l:"Today P&L", v:"+$1,240", c:"#22c55e"},
            {l:"Win Rate",  v:"68%",     c:"#e2e8f0"},
            {l:"Drawdown",  v:"-2.1%",   c:"#ef4444"},
          ].map(m=>(
            <div key={m.l} style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:7,padding:"6px 8px"}}>
              <div style={{fontSize:7,color:"#94a3b8",marginBottom:2,letterSpacing:"0.06em"}}>{m.l.toUpperCase()}</div>
              <div style={{fontSize:14,fontWeight:800,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
            </div>
          ))}
        </div>

        {/* Discipline guardrail monitor */}
        <DisciplineMonitor/>

        {/* Active Signals — vertical list */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:10,
          padding:"10px 10px",flex:1,display:"flex",flexDirection:"column",minHeight:0,overflow:"hidden"}}>
          <div style={{fontSize:8,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:8,flexShrink:0}}>
            ACTIVE SIGNALS — {asset.label}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6,overflowY:"auto",flex:1}}>
            {signals.map((s,i)=>{
              const col=s.dir==="BUY"?"#22c55e":s.dir==="SELL"?"#ef4444":"#64748b";
              const cc=CAT_COLOR[s.strategy]||"#64748b";
              const nc=s.nature==="Scalping"?"#f43f5e":s.nature==="Intraday"?"#f59e0b":"#60a5fa";
              return (
                <div key={i} style={{background:"#060d17",border:`0.5px solid ${col}20`,
                  borderLeft:`2px solid ${col}`,borderRadius:6,padding:"7px 9px",flexShrink:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:4}}>
                    <span style={{fontSize:7,fontWeight:800,color:nc,background:nc+"18",
                      padding:"1px 5px",borderRadius:3,border:`0.5px solid ${nc}40`}}>
                      {s.nature==="Scalping"?"⚡ SCALP":s.nature==="Intraday"?"🕐 INTRADAY":"📈 SWING"}
                    </span>
                    <span style={{fontSize:9,fontWeight:700,color:col,marginLeft:"auto"}}>
                      {s.dir==="BUY"?"▲":s.dir==="SELL"?"▼":"◆"} {s.dir}
                    </span>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                    <div style={{fontSize:11,fontWeight:600,color:"#e2e8f0"}}>{s.name}</div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:8,color:cc,background:cc+"18",padding:"1px 4px",borderRadius:3,marginBottom:2}}>{s.strategy}</div>
                      <div style={{fontSize:14,fontWeight:800,color:col,fontFamily:"monospace"}}>{s.conf}%</div>
                    </div>
                  </div>
                  <div style={{height:3,background:"#1e2a3a",borderRadius:1.5}}>
                    <div style={{height:3,width:`${s.conf}%`,background:col,borderRadius:1.5}}/>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Geo Alerts — live, auto-refreshing */}
        <GeoAlertsPanel/>

      </div>

      {/* ── RIGHT: Chart only — full height ── */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
        {isNifty && (
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",
            background:marketOpen?"#07111f":"#1c1300",
            border:`0.5px solid ${marketOpen?"#22c55e30":"#f59e0b30"}`,
            borderRadius:8,padding:"6px 10px",marginBottom:6,flexShrink:0}}>
            <span style={{width:7,height:7,borderRadius:"50%",
              background:marketOpen?"#22c55e":"#f59e0b",
              boxShadow:marketOpen?"0 0 6px #22c55e":"none"}}/>
            <span style={{fontSize:9,fontWeight:700,letterSpacing:"0.08em",
              color:marketOpen?"#22c55e":"#f59e0b",fontFamily:"monospace"}}>
              {marketOpen?"NSE LIVE · 09:15–15:30 IST":"MARKET CLOSED · showing last close"}
            </span>
            <span style={{fontSize:8,color:"#7c8ea8",fontFamily:"monospace"}}>via Dhan</span>
            {onRefresh && (
              <button onClick={onRefresh} disabled={refreshing}
                style={{marginLeft:"auto",fontSize:8,padding:"3px 9px",borderRadius:5,fontFamily:"monospace",
                  background:"#111e30",border:"0.5px solid #1e3a5a",color:"#60a5fa",
                  cursor:refreshing?"default":"pointer"}}>
                {refreshing?"↻ …":"↻ Refresh"}
              </button>
            )}
          </div>
        )}
        <ChartSwitcher asset={activeAsset} price={price} change={change} candles={cdata} marketOpen={marketOpen}/>
      </div>

    </div>
  );
}

function AISignalPage({ onSignalSaved, prices = {} }) {
  const [loading, setLoading]=useState(false);
  const [result, setResult]=useState(null);
  const [asset, setAsset]=useState("BTCUSD");
  const [tf, setTf]=useState("1H");
  const [error, setError]=useState(null);
  const [saved, setSaved]=useState(false);
  const [tgStatus, setTgStatus]=useState(null);
  const [tgEnabled, setTgEnabled]=useState(true);
  const [mt5Status, setMt5Status]=useState(null);
  const [strategy, setStrategy]=useState("ict_smc"); // "ict_smc" | "eagle_eye"

  // ── Strategy Definitions ───────────────────────────────────────────────────
  const STRATEGIES_CONFIG = {
    ict_smc: {
      id:      "ict_smc",
      name:    "ICT / SMC",
      icon:    "◈",
      color:   "#60a5fa",
      desc:    "Order Blocks, FVG, BOS, CHoCH, Kill Zones",
      badge:   "DEFAULT",
    },
    eagle_eye: {
      id:      "eagle_eye",
      name:    "Eagle's Eye Golden Setup",
      icon:    "🦅",
      color:   "#f59e0b",
      desc:    "EMA 50/200 Trend · ATR Expansion · Strong Momentum Candle · Round Level Breakout",
      badge:   "PINE SCRIPT",
      params: {
        emaFast:      50,
        emaSlow:      200,
        atrLen:       14,
        atrMaLen:     20,
        bodyPct:      0.60,
        atrMult:      1.5,
        roundStep:    500,
      },
    },
  };

  const buildPrompt = (assetObj, livePrice, sym, wikiCtx="") => {
    const wikiSection = wikiCtx
      ? `\n\n===== TRADER'S OWN WIKI / STRATEGY RULEBOOK =====\nThe trader has documented their personal edge in this knowledge base. Apply these rules with HIGHEST priority — they override generic ICT/SMC defaults:\n\n${wikiCtx}\n===== END OF WIKI =====\n`
      : "";
    const slRange  = asset==="NIFTY50" ? 0.6 : asset==="XAUUSD" ? 0.4 : asset==="ETHUSD" ? 1.2 : 1.5;
    const tp1Range = slRange * 1.5;
    const tp2Range = slRange * 3;
    const pct = (p, v) => Math.round(p * (1 + v/100));
    const exBull = { entry:Math.round(livePrice), sl:pct(livePrice,-slRange), tp1:pct(livePrice,tp1Range),  tp2:pct(livePrice,tp2Range)  };
    const exBear = { entry:Math.round(livePrice), sl:pct(livePrice, slRange), tp1:pct(livePrice,-tp1Range), tp2:pct(livePrice,-tp2Range) };
    const ruleContext = signalRuleContextForPrompt(assetObj, tf, STRATEGIES_CONFIG[strategy]?.name || strategy);

    if (strategy === "eagle_eye") {
      const p = STRATEGIES_CONFIG.eagle_eye.params;
      // Calculate round levels near current price
      const roundLevel   = Math.round(livePrice / p.roundStep) * p.roundStep;
      const nextRound    = roundLevel + p.roundStep;
      const prevRound    = roundLevel - p.roundStep;
      const atrEstimate  = asset==="NIFTY50" ? livePrice*0.006 : asset==="XAUUSD" ? livePrice*0.005 : asset==="BTCUSD" ? livePrice*0.012 : livePrice*0.010;
      const sl_atr       = Math.round(atrEstimate * p.atrMult);
      const liveRounded  = `${sym}${livePrice.toLocaleString(undefined,{maximumFractionDigits:2})}`;

      return `You are an expert quantitative trader using the "Eagle's Eye Golden Setup" strategy on ${assetObj.label}.

CURRENT LIVE PRICE: ${liveRounded}
Timeframe: ${tf}
${wikiSection}
${ruleContext}

STRATEGY RULES (Pine Script logic translated to analysis):
1. EMA TREND FILTER
   - EMA Fast (${p.emaFast}): price must be ABOVE EMA200 for LONG, BELOW for SHORT
   - EMA Slow (${p.emaSlow}): EMA50 must be above EMA200 for bullish trend confirmation
   - Current price ${liveRounded} — assess if EMA50 > EMA200 (bullish) or EMA50 < EMA200 (bearish)

2. ATR EXPANSION (ATR ${p.atrLen} > ATR SMA ${p.atrMaLen})
   - Estimated ATR: ${sym}${atrEstimate.toFixed(2)}
   - Market must show volatility expansion (ATR above its 20-period SMA)
   - This confirms momentum is real, not a fake-out

3. STRONG MOMENTUM CANDLE
   - Candle body must be ≥${(p.bodyPct*100).toFixed(0)}% of total range (high-low)
   - For LONG: close must be in top 15% of candle range (strong bullish close)
   - For SHORT: close must be in bottom 15% of candle range (strong bearish close)
   - This filters out doji/spinning tops and ensures conviction

4. ROUND LEVEL BREAKOUT
   - Round level step: ${sym}${p.roundStep.toLocaleString()}
   - Key round levels near current price: ${sym}${prevRound.toLocaleString()}, ${sym}${roundLevel.toLocaleString()}, ${sym}${nextRound.toLocaleString()}
   - LONG: price must cross ABOVE a round level (bullish breakout)
   - SHORT: price must cross BELOW a round level (bearish breakdown)

5. STOP LOSS & TARGETS (ATR-based, multiplier ${p.atrMult}x)
   - SL distance = ATR × ${p.atrMult} = ~${sym}${sl_atr.toLocaleString()}
   - LONG: Entry ~${sym}${exBull.entry.toLocaleString()}, SL ~${sym}${(exBull.entry-sl_atr).toLocaleString()}, TP1 ~${sym}${(exBull.entry+sl_atr*2).toLocaleString()}, TP2 ~${sym}${(exBull.entry+sl_atr*3).toLocaleString()}
   - SHORT: Entry ~${sym}${exBear.entry.toLocaleString()}, SL ~${sym}${(exBear.entry+sl_atr).toLocaleString()}, TP1 ~${sym}${(exBear.entry-sl_atr*2).toLocaleString()}, TP2 ~${sym}${(exBear.entry-sl_atr*3).toLocaleString()}
   - TP1 can be partial profit near 1:2; TP2 must be 1:3 minimum for Big Profit.

TASK: Apply all 4 rules above to give a HIGH QUALITY signal for ${assetObj.label} at ${liveRounded} on ${tf}.
All price levels must be realistic and near ${liveRounded}.

Respond ONLY with this JSON object (no markdown, start with {):
{"approved":true,"bias":"BULLISH","nature":"Intraday","confidence":80,"setup":"Eagle Eye — EMA Trend + ATR + Round Level Breakout","entry":${exBull.entry},"stopLoss":${exBull.entry-sl_atr},"takeProfit1":${exBull.entry+sl_atr*2},"takeProfit2":${exBull.entry+sl_atr*3},"riskReward":3.0,"quadrantPlan":{"smallLoss":"Exit at SL, no averaging down","smallProfit":"TP1/trailing stop only","bigLoss":"Blocked by mandatory SL","bigProfit":"Hold TP2 for 1:3 RR when trend confirms"},"ruleAudit":{"passed":true,"minRR":3,"stopIsMandatory":true,"bigLossBlocked":true},"learningAdjustments":["Applied recent outcome memory"],"ictFactors":["EMA50 above EMA200 — bullish trend confirmed","ATR expanding above 20-SMA — momentum valid","Strong bullish candle body ≥60% of range"],"smcFactors":["Round level ${sym}${roundLevel.toLocaleString()} breakout confirmed","Price closed in top 15% of candle range"],"macroFactors":["Trend alignment with higher TF","Session momentum supporting direction"],"killZone":"Active Session","invalidation":"Close below SL ${sym}${(exBull.entry-sl_atr).toLocaleString()}","summary":"Eagle Eye Golden Setup triggered: EMA trend aligned, ATR expanding, strong momentum candle with round level breakout. All 4 conditions met.","riskWarning":"Wait for candle close confirmation before entry. ATR-based SL is dynamic."}

Now analyse the CURRENT situation for ${assetObj.label} at ${liveRounded} and provide your real assessment. If the setup cannot obey the rules, return {"approved":false,"noTradeReason":"reason"}. JSON only:`;
    }

    // Default ICT/SMC prompt
    return `You are an elite professional ICT and SMC trader.

CURRENT LIVE PRICE of ${assetObj.label}: ${sym}${livePrice.toLocaleString(undefined,{maximumFractionDigits:2})}
Timeframe: ${tf}
${wikiSection}
${ruleContext}

IMPORTANT: All price levels (entry, stopLoss, takeProfit1, takeProfit2) MUST be close to the current live price of ${sym}${livePrice.toLocaleString(undefined,{maximumFractionDigits:2})}. Do NOT use generic placeholder prices.

For a BULLISH setup, example price levels would be around:
  entry: ${exBull.entry}, stopLoss: ${exBull.sl}, takeProfit1: ${exBull.tp1}, takeProfit2: ${exBull.tp2}

For a BEARISH setup, example price levels would be around:
  entry: ${exBear.entry}, stopLoss: ${exBear.sl}, takeProfit1: ${exBear.tp1}, takeProfit2: ${exBear.tp2}

Respond with ONLY a raw JSON object (no markdown, no code blocks, start with {):

{"approved":true,"bias":"BULLISH","nature":"Intraday","confidence":78,"setup":"ICT Bullish OB","entry":${exBull.entry},"stopLoss":${exBull.sl},"takeProfit1":${exBull.tp1},"takeProfit2":${exBull.tp2},"riskReward":3.0,"quadrantPlan":{"smallLoss":"Exit at SL, no averaging down","smallProfit":"TP1/trailing stop only","bigLoss":"Blocked by mandatory SL","bigProfit":"Hold TP2 for 1:3 RR when trend confirms"},"ruleAudit":{"passed":true,"minRR":3,"stopIsMandatory":true,"bigLossBlocked":true},"learningAdjustments":["Applied recent outcome memory"],"ictFactors":["Bullish OB identified","FVG above unfilled","Kill zone active"],"smcFactors":["BOS confirmed bullish","Premium zone rejection"],"macroFactors":["Risk-on sentiment","DXY weakness"],"killZone":"London Open","invalidation":"Close below ${exBull.sl}","summary":"Price swept lows and bounced from bullish OB. Targeting FVG fill above current price.","riskWarning":"High impact news event nearby"}

Now give YOUR analysis for ${assetObj.label} at ${sym}${livePrice.toLocaleString(undefined,{maximumFractionDigits:2})} on ${tf}. Use ICT/SMC: Order Blocks, FVG, BOS, CHoCH, Liquidity Sweeps, Kill Zones, Premium/Discount. Consider geopolitical context (Fed, Middle East, India/RBI for Nifty).
Choose nature: Scalping (1-15min,tight SL), Intraday (same session), Swing (multi-day).
All prices must be realistic and close to ${sym}${livePrice.toLocaleString(undefined,{maximumFractionDigits:2})}.
If no safe trade meets AlphaEdge rules, return {"approved":false,"noTradeReason":"reason"}.
Respond ONLY with the JSON object:`;
  };

  const runAnalysis=async()=>{
    setLoading(true); setResult(null); setError(null); setSaved(false);
    const assetObj  = ASSETS.find(a=>a.id===asset);
    const livePrice = prices[asset] || assetObj.base;
    const provider  = getAIProvider();
    const isNifty   = asset === "NIFTY50";
    const sym       = isNifty ? "₹" : "$";
    const wikiCtx   = await fetchWikiContext(asset, strategy);
    const prompt    = buildPrompt(assetObj, livePrice, sym, wikiCtx);

    try {
      const data = await callAI(prompt, 1200);
      const rawText = data.content?.[0]?.text || "";

      // Robust JSON extraction — handles markdown, extra text, etc.
      let clean = rawText.trim();
      // Remove markdown code fences
      clean = clean.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
      // Extract JSON object if surrounded by other text
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`No JSON found in response. Raw: ${clean.slice(0,200)}`);
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.approved === false) throw new Error(parsed.noTradeReason || "No safe trade met AlphaEdge rules.");

      // Validate required fields
      if (!parsed.bias || !parsed.entry) throw new Error("Incomplete analysis returned. Please try again.");
      const guarded = enforceSignalRules(parsed, { assetObj, livePrice, source:strategy==="eagle_eye" ? "Eagle's Eye" : "Manual AI" });

      setResult(guarded);

      // Auto-save to history
      const record = {
        id: `SIG-${Date.now()}`,
        timestamp: Date.now(),
        asset: assetObj.label,
        assetId: asset,
        timeframe: tf,
        nature:      guarded.nature      || "Intraday",
        bias:        guarded.bias,
        confidence:  guarded.confidence,
        setup:       guarded.setup,
        entry:       guarded.entry,
        stopLoss:    guarded.stopLoss,
        takeProfit1: guarded.takeProfit1,
        takeProfit2: guarded.takeProfit2,
        riskReward:  guarded.riskReward,
        killZone:    guarded.killZone,
        summary:     guarded.summary,
        ictFactors:  guarded.ictFactors,
        smcFactors:  guarded.smcFactors,
        macroFactors:guarded.macroFactors,
        invalidation:guarded.invalidation,
        riskWarning: guarded.riskWarning,
        quadrantPlan:guarded.quadrantPlan,
        ruleAudit:   guarded.ruleAudit,
        learningSnapshot: guarded.learningSnapshot,
        learningAdjustments: guarded.learningAdjustments,
        outcome: "pending",
        source: strategy==="eagle_eye" ? `Eagle's Eye (${provider})` : `AI ICT/SMC (${provider})`,
        tradeType: getExecMode()==="mt5_live" ? "Real" : getExecMode()==="mt5_demo" ? "Demo" : "Paper",
        session:     marketSession(assetObj.label).session,
        primeWindow: marketSession(assetObj.label).prime,
        sessionQuality: marketSession(assetObj.label).quality,
      };
      const updated = await appendSignal(record);
      setSaved(true);
      if (onSignalSaved) onSignalSaved(updated);

      // ── Route EVERY signal according to the Execution-page mode ─────────────
      setMt5Status("sending");
      const mt5Result = await sendToMT5(guarded, assetObj.label, tf);
      await attachMt5Ticket(record.id, mt5Result);
      setMt5Status(
        mt5Result.paper ? "paper"
        : mt5Result.ok  ? `sent:${mt5Result.account}`
        : mt5Result.guarded || mt5Result.guardrail ? `blocked:${mt5Result.error||""}`
        : `failed:${mt5Result.error||""}`
      );
      setTimeout(()=>setMt5Status(null), 10000);

      // Telegram alerts are sent only when a trade is actually PLACED/CLOSED
      // (handled in sendToMT5 + the trade watcher), not on signal generation.
    } catch(e) {
      if(e.message==="NO_KEY")
        setError(`No API key set. Go to Settings → select ${getAIProvider().toUpperCase()} → paste your key → Save Settings.`);
      else
        setError(`Analysis failed: ${e.message}`);
    }
    setLoading(false);
  };

  const biasColor=result?.bias==="BULLISH"?"#22c55e":result?.bias==="BEARISH"?"#ef4444":"#f59e0b";
  const [streaming,setStreaming]=useState("");

  return (
    <div style={{height:"100%",overflow:"auto"}}>
      <div style={{maxWidth:900,margin:"0 auto"}}>
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:16,marginBottom:12}}>
          <div style={{fontSize:11,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:12}}>AI SIGNAL SYNTHESIS</div>

          {/* ── Strategy Selector ────────────────────────────────────────────── */}
          <div style={{marginBottom:14}}>
            <div style={{fontSize:9,color:"#94a3b8",marginBottom:8,letterSpacing:"0.06em"}}>STRATEGY ENGINE</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {Object.values(STRATEGIES_CONFIG).map(s=>(
                <div key={s.id} onClick={()=>setStrategy(s.id)}
                  style={{flex:1,minWidth:220,padding:"10px 14px",borderRadius:8,cursor:"pointer",
                    background:strategy===s.id ? s.color+"15" : "#060d17",
                    border:`1px solid ${strategy===s.id ? s.color : "#1e3a5a"}`,
                    transition:"all 0.2s",
                    boxShadow:strategy===s.id?`0 0 12px ${s.color}20`:"none"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                    <span style={{fontSize:18}}>{s.icon}</span>
                    <div>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontSize:11,fontWeight:700,
                          color:strategy===s.id?s.color:"#94a3b8"}}>{s.name}</span>
                        <span style={{fontSize:7,fontWeight:800,
                          color:strategy===s.id?s.color:"#7c8ea8",
                          background:strategy===s.id?s.color+"25":"#0d1525",
                          padding:"1px 5px",borderRadius:3,
                          border:`0.5px solid ${strategy===s.id?s.color+"60":"#1e2a3a"}`}}>
                          {s.badge}
                        </span>
                      </div>
                      <div style={{fontSize:9,color:"#94a3b8",marginTop:2,lineHeight:1.4}}>
                        {s.desc}
                      </div>
                    </div>
                    {strategy===s.id&&(
                      <div style={{marginLeft:"auto",width:8,height:8,borderRadius:"50%",
                        background:s.color,boxShadow:`0 0 6px ${s.color}`,flexShrink:0}}/>
                    )}
                  </div>
                  {/* Eagle's Eye params pill row */}
                  {s.id==="eagle_eye"&&strategy==="eagle_eye"&&s.params&&(
                    <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:6}}>
                      {[
                        {l:"EMA Fast",v:`${s.params.emaFast}`},
                        {l:"EMA Slow",v:`${s.params.emaSlow}`},
                        {l:"ATR",v:`${s.params.atrLen}`},
                        {l:"Body",v:`≥${(s.params.bodyPct*100).toFixed(0)}%`},
                        {l:"ATR SL",v:`${s.params.atrMult}×`},
                        {l:"Round Step",v:`${s.params.roundStep}`},
                      ].map(p=>(
                        <div key={p.l} style={{background:"#0a1628",border:`0.5px solid ${s.color}40`,
                          borderRadius:4,padding:"2px 6px"}}>
                          <span style={{fontSize:7,color:"#94a3b8"}}>{p.l}: </span>
                          <span style={{fontSize:8,fontWeight:700,color:s.color,fontFamily:"monospace"}}>{p.v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Controls row */}
          <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
            <div>
              <div style={{fontSize:9,color:"#94a3b8",marginBottom:4}}>ASSET</div>
              <select value={asset} onChange={e=>setAsset(e.target.value)}
                style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"6px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}>
                {ASSETS.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </div>
            <div>
              <div style={{fontSize:9,color:"#94a3b8",marginBottom:4}}>TIMEFRAME</div>
              <div style={{display:"flex",gap:4}}>
                {["5m","15m","1H","4H","1D"].map(t=>(
                  <span key={t} onClick={()=>setTf(t)}
                    style={{padding:"6px 10px",borderRadius:6,fontSize:11,cursor:"pointer",fontFamily:"monospace",
                      background:tf===t?"#1e3a5a":"#060d17",color:tf===t?"#60a5fa":"#94a3b8",
                      border:`0.5px solid ${tf===t?"#3b82f6":"#1e3a5a"}`}}>{t}</span>
                ))}
              </div>
            </div>
            <button onClick={runAnalysis} disabled={loading}
              style={{marginLeft:"auto",padding:"8px 20px",
                background:loading?"#1e3a5a":strategy==="eagle_eye"
                  ?"linear-gradient(135deg,#d97706,#f59e0b)"
                  :"linear-gradient(135deg,#1d4ed8,#7c3aed)",
                border:"none",borderRadius:8,color:"white",fontSize:12,fontWeight:700,
                cursor:loading?"not-allowed":"pointer",
                fontFamily:"monospace",letterSpacing:"0.05em",
                boxShadow:loading?"none":strategy==="eagle_eye"?"0 0 14px #f59e0b30":"0 0 14px #1d4ed830"}}>
              {loading?"◌ ANALYSING...":strategy==="eagle_eye"?"🦅 RUN EAGLE'S EYE":"◈ RUN AI ANALYSIS"}
            </button>
            {/* Telegram toggle */}
            {(()=>{
              const hasTg = getTgToken() && getTgChatId();
              return (
                <div style={{display:"flex",alignItems:"center",gap:7,background:"#060d17",
                  border:`0.5px solid ${hasTg&&tgEnabled?"#2563eb40":"#1e3a5a"}`,borderRadius:8,padding:"6px 10px"}}>
                  <span style={{fontSize:16}}>✈️</span>
                  <div style={{fontSize:10,lineHeight:1.3}}>
                    <div style={{fontWeight:600,color:hasTg&&tgEnabled?"#60a5fa":"#94a3b8"}}>Telegram</div>
                    <div style={{fontSize:8,color:hasTg?"#22c55e":"#ef4444"}}>
                      {hasTg ? "✓ Configured" : "⚠ Not set — go to Settings"}
                    </div>
                  </div>
                  <div onClick={()=>setTgEnabled(e=>!e)}
                    style={{width:34,height:18,borderRadius:9,
                      background:tgEnabled&&hasTg?"#2563eb":"#1e2a3a",
                      border:`0.5px solid ${tgEnabled&&hasTg?"#60a5fa":"#1e3a5a"}`,
                      position:"relative",cursor:"pointer",transition:"all 0.2s",marginLeft:4}}>
                    <div style={{width:13,height:13,borderRadius:"50%",
                      background:tgEnabled&&hasTg?"white":"#94a3b8",
                      position:"absolute",top:2.5,left:tgEnabled?18:2,transition:"left 0.2s"}}/>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>

        {/* AI Learning — continuously updated from marked outcomes + geo context */}
        {(()=>{
          const L = getSignalLearning();
          const pct = v => v==null?"—":`${v.toFixed(0)}%`;
          return (
            <div style={{background:"#0a1628",border:"0.5px solid #7c3aed40",borderRadius:12,padding:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{fontSize:9,color:"#a78bfa",letterSpacing:"0.1em"}}>🧠 AI LEARNING — GROWS FROM YOUR MARKED OUTCOMES</div>
                <div style={{fontSize:9,color:"#7c8ea8"}}>learned from {L.resolved||0} of {L.total||0} signals</div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:10}}>
                {[
                  {l:"Win Rate",v:pct(L.winRate),c:"#22c55e"},
                  {l:"Expectancy",v:`${(L.expectancyR||0).toFixed(2)}R`,c:(L.expectancyR||0)>=0?"#22c55e":"#ef4444"},
                  {l:"Big Profits",v:L.counts?.big_profit||0,c:"#22c55e"},
                  {l:"Big Losses",v:L.counts?.big_loss||0,c:"#ef4444"},
                ].map(m=>(
                  <div key={m.l} style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:8,padding:"8px 10px"}}>
                    <div style={{fontSize:7,color:"#94a3b8",marginBottom:3,letterSpacing:"0.06em"}}>{m.l.toUpperCase()}</div>
                    <div style={{fontSize:16,fontWeight:800,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
                  </div>
                ))}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <div>
                  <div style={{fontSize:8,color:"#22c55e",letterSpacing:"0.06em",marginBottom:4}}>FAVORS (high win rate)</div>
                  {(L.favor||[]).length ? (L.favor||[]).slice(0,3).map(g=>(
                    <div key={g.key} style={{fontSize:10,color:"#cbd5e1",fontFamily:"monospace",marginBottom:2}}>
                      {g.label} — {pct(g.winRate)} WR, RR {g.avgRR?.toFixed(1)}
                    </div>
                  )) : <div style={{fontSize:9,color:"#7c8ea8"}}>learning… mark more outcomes</div>}
                </div>
                <div>
                  <div style={{fontSize:8,color:"#ef4444",letterSpacing:"0.06em",marginBottom:4}}>AVOIDS (weak / big-loss)</div>
                  {(L.avoid||[]).length ? (L.avoid||[]).slice(0,3).map(g=>(
                    <div key={g.key} style={{fontSize:10,color:"#cbd5e1",fontFamily:"monospace",marginBottom:2}}>
                      {g.label} — {g.wins}W/{g.losses}L{g.bigLoss?`, ${g.bigLoss} BL`:""}
                    </div>
                  )) : <div style={{fontSize:9,color:"#7c8ea8"}}>learning… mark more outcomes</div>}
                </div>
              </div>
              {(L.notes||[]).length>0 && (
                <div style={{marginTop:10,fontSize:9,color:"#a78bfa",lineHeight:1.5}}>💡 {(L.notes||[])[0]}</div>
              )}
              <div style={{fontSize:8,color:"#7c8ea8",marginTop:8,lineHeight:1.5}}>
                These insights are fed into every new analysis along with live geopolitical context. Mark each signal&apos;s outcome (win/loss) in the History tab and the AI keeps getting sharper.
              </div>
            </div>
          );
        })()}

        {loading && (
          <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:32,textAlign:"center"}}>
            <div style={{fontSize:28,marginBottom:12,animation:"spin 1s linear infinite",display:"inline-block"}}>◌</div>
            <div style={{fontSize:13,color:"#60a5fa",fontFamily:"monospace"}}>Synthesizing ICT + SMC + Macro signals...</div>
            <div style={{fontSize:10,color:"#7c8ea8",marginTop:6}}>Analyzing order blocks, fair value gaps, market structure, geopolitical context</div>
          </div>
        )}

        {error && (
          <div style={{background:"#1a0000",border:"0.5px solid #ef444440",borderRadius:12,padding:16,color:"#ef4444",fontSize:12,fontFamily:"monospace"}}>{error}</div>
        )}

        {result && (
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {saved && (
              <div style={{background:"#052e16",border:"0.5px solid #22c55e40",borderRadius:8,padding:"8px 14px",display:"flex",alignItems:"center",gap:8}}>
                <span style={{color:"#22c55e",fontSize:13}}>✓</span>
                <span style={{fontSize:11,color:"#22c55e",fontFamily:"monospace"}}>Signal saved to History</span>
                <span style={{fontSize:10,color:"#7c8ea8",marginLeft:4}}>— outcome tracking active</span>
              </div>
            )}
            {tgStatus==="sending" && (
              <div style={{background:"#0a1e35",border:"0.5px solid #2563eb40",borderRadius:8,padding:"8px 14px",display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:14,animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>
                <span style={{fontSize:11,color:"#60a5fa",fontFamily:"monospace"}}>Sending to Telegram...</span>
              </div>
            )}
            {tgStatus==="sent" && (
              <div style={{background:"#0d1e35",border:"0.5px solid #2563eb60",borderRadius:8,padding:"8px 14px",display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:14}}>✈️</span>
                <span style={{fontSize:11,color:"#60a5fa",fontFamily:"monospace"}}>✓ Signal sent to Telegram</span>
              </div>
            )}
            {tgStatus&&tgStatus.startsWith("failed") && (
              <div style={{background:"#1a0a00",border:"0.5px solid #f59e0b40",borderRadius:8,padding:"8px 12px"}}>
                <div style={{fontSize:11,color:"#f59e0b",fontFamily:"monospace",marginBottom:tgStatus.length>7?4:0}}>
                  ⚠️ Telegram failed
                </div>
                {tgStatus.length>7&&<div style={{fontSize:10,color:"#94a3b8",fontFamily:"monospace",wordBreak:"break-all"}}>
                  {tgStatus.replace("failed:","") || "Check Bot Token & Chat ID in Settings"}
                </div>}
              </div>
            )}
            {/* MT5 terminal broadcast status */}
            {mt5Status==="paper" && (
              <div style={{background:"#0a1e35",border:"0.5px solid #2563eb40",borderRadius:8,padding:"8px 14px",display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:14}}>📝</span>
                <span style={{fontSize:11,color:"#60a5fa",fontFamily:"monospace"}}>Paper Trade mode — signal logged, no MT5 order placed</span>
              </div>
            )}
            {mt5Status==="sending" && (
              <div style={{background:"#0a1e35",border:"0.5px solid #2563eb40",borderRadius:8,padding:"8px 14px",display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:14,animation:"spin 1s linear infinite",display:"inline-block"}}>◌</span>
                <span style={{fontSize:11,color:"#60a5fa",fontFamily:"monospace"}}>Sending order to MT5 terminal...</span>
              </div>
            )}
            {mt5Status&&mt5Status.startsWith("sent") && (
              <div style={{background:"#052e16",border:"0.5px solid #22c55e60",borderRadius:8,padding:"8px 14px",display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:14}}>📈</span>
                <span style={{fontSize:11,color:"#22c55e",fontFamily:"monospace"}}>✓ Signal sent to MT5 ({mt5Status.replace("sent:","")} account)</span>
              </div>
            )}
            {mt5Status&&mt5Status.startsWith("failed") && (
              <div style={{background:"#1a0a00",border:"0.5px solid #f59e0b40",borderRadius:8,padding:"8px 12px"}}>
                <div style={{fontSize:11,color:"#f59e0b",fontFamily:"monospace",marginBottom:4}}>⚠️ MT5 not sent</div>
                <div style={{fontSize:10,color:"#94a3b8",fontFamily:"monospace",wordBreak:"break-all"}}>
                  {mt5Status.replace("failed:","") || "Add an MT5 Bridge URL in Settings → MT5 Terminal"}
                </div>
              </div>
            )}
            {mt5Status&&mt5Status.startsWith("blocked") && (
              <div style={{background:"#1a0000",border:"0.5px solid #ef444450",borderRadius:8,padding:"8px 12px"}}>
                <div style={{fontSize:11,color:"#ef4444",fontFamily:"monospace",marginBottom:4}}>🛑 Trade blocked by Discipline guardrail</div>
                <div style={{fontSize:10,color:"#fca5a5",fontFamily:"monospace",wordBreak:"break-word"}}>
                  {mt5Status.replace("blocked:","").replace("Blocked by discipline rule: ","")}
                </div>
                <div style={{fontSize:9,color:"#94a3b8",marginTop:4}}>Signal saved to History, but not executed. Adjust in Settings → Discipline.</div>
              </div>
            )}
            <div style={{background:`linear-gradient(135deg,${biasColor}15,${biasColor}05)`,border:`0.5px solid ${biasColor}40`,borderRadius:12,padding:16,display:"flex",alignItems:"center",gap:16}}>
              <div style={{fontSize:40,fontWeight:900,color:biasColor,fontFamily:"monospace",lineHeight:1}}>
                {result.bias==="BULLISH"?"▲":result.bias==="BEARISH"?"▼":"◆"}
              </div>
              <div style={{flex:1}}>
                {/* Nature badge */}
                {result.nature&&(()=>{
                  const nc=result.nature==="Scalping"?"#f43f5e":result.nature==="Intraday"?"#f59e0b":"#60a5fa";
                  const ni=result.nature==="Scalping"?"⚡":result.nature==="Intraday"?"🕐":"📈";
                  return (
                    <span style={{fontSize:10,fontWeight:800,color:nc,background:nc+"20",
                      padding:"2px 10px",borderRadius:4,border:`0.5px solid ${nc}50`,
                      letterSpacing:"0.06em",display:"inline-block",marginBottom:6,marginRight:6}}>
                      {ni} {result.nature.toUpperCase()}
                    </span>
                  );
                })()}
                {/* Session / best-time badge */}
                {(()=>{
                  const sess = marketSession(ASSETS.find(a=>a.id===asset)?.label || asset);
                  const c = sess.quality==="prime"?"#22c55e":sess.quality==="avoid"||sess.quality==="thin"?"#f59e0b":sess.quality==="closed"?"#ef4444":"#64748b";
                  const ic = sess.prime?"⭐":sess.quality==="closed"?"⛔":sess.quality==="thin"||sess.quality==="avoid"?"⚠":"●";
                  return (
                    <span title="Trading session — gold prime = London–NY overlap 19:00–21:30 IST"
                      style={{fontSize:10,fontWeight:800,color:c,background:c+"20",padding:"2px 10px",borderRadius:4,
                        border:`0.5px solid ${c}50`,letterSpacing:"0.04em",display:"inline-block",marginBottom:6}}>
                      {ic} {sess.session}{sess.prime?" · PRIME":""}
                    </span>
                  );
                })()}
                <div style={{fontSize:22,fontWeight:800,color:biasColor,fontFamily:"monospace"}}>{result.bias}</div>
                <div style={{fontSize:12,color:"#94a3b8",marginTop:2}}>{result.setup}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:11,color:"#94a3b8",marginBottom:4}}>AI CONFIDENCE</div>
                <div style={{fontSize:32,fontWeight:800,color:biasColor,fontFamily:"monospace"}}>{result.confidence}%</div>
                <div style={{width:80,height:4,background:"#1e2a3a",borderRadius:2,marginTop:6}}>
                  <div style={{height:4,width:`${result.confidence}%`,background:biasColor,borderRadius:2}}/>
                </div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:10,color:"#94a3b8",marginBottom:2}}>Kill Zone</div>
                <div style={{fontSize:12,color:"#f59e0b",fontFamily:"monospace"}}>{result.killZone}</div>
                <div style={{fontSize:10,color:"#94a3b8",marginTop:6,marginBottom:2}}>Risk:Reward</div>
                <div style={{fontSize:16,fontWeight:700,color:"#22c55e",fontFamily:"monospace"}}>1:{result.riskReward?.toFixed(1)}</div>
              </div>
            </div>

            {/* Levels grid */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
              {[
                {l:"Entry",v:result.entry,c:"#94a3b8"},
                {l:"Stop Loss",v:result.stopLoss,c:"#ef4444"},
                {l:"Take Profit 1",v:result.takeProfit1,c:"#22c55e"},
                {l:"Take Profit 2",v:result.takeProfit2,c:"#34d399"},
              ].map(m=>(
                <div key={m.l} style={{background:"#0a1628",border:`0.5px solid ${m.c}30`,borderRadius:8,padding:"10px 12px",textAlign:"center"}}>
                  <div style={{fontSize:9,color:"#94a3b8",marginBottom:4}}>{m.l.toUpperCase()}</div>
                  <div style={{fontSize:16,fontWeight:700,color:m.c,fontFamily:"monospace"}}>${m.v?.toLocaleString()}</div>
                </div>
              ))}
            </div>

            {result.ruleAudit && (
              <div style={{background:"#07111f",border:"0.5px solid #22c55e35",borderRadius:8,padding:12}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                  <span style={{fontSize:9,color:"#22c55e",letterSpacing:"0.1em"}}>ALPHAEDGE RULE GATE PASSED</span>
                  <span style={{fontSize:10,color:"#94a3b8",fontFamily:"monospace"}}>Max risk {result.ruleAudit.maxRiskPct}%</span>
                  <span style={{fontSize:10,color:"#94a3b8",fontFamily:"monospace"}}>TP2 RR 1:{result.ruleAudit.rrToTP2}</span>
                  <span style={{fontSize:10,color:"#94a3b8",fontFamily:"monospace"}}>SL distance {result.ruleAudit.stopDistancePct}%</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                  {[
                    {l:"Small Loss",v:result.quadrantPlan?.smallLoss,c:"#ef4444"},
                    {l:"Small Profit",v:result.quadrantPlan?.smallProfit,c:"#f59e0b"},
                    {l:"Big Loss",v:result.quadrantPlan?.bigLoss,c:"#ef4444"},
                    {l:"Big Profit",v:result.quadrantPlan?.bigProfit,c:"#22c55e"},
                  ].map(q=>(
                    <div key={q.l} style={{background:"#060d17",border:`0.5px solid ${q.c}25`,borderRadius:7,padding:"8px 10px"}}>
                      <div style={{fontSize:8,color:q.c,letterSpacing:"0.06em",marginBottom:5}}>{q.l.toUpperCase()}</div>
                      <div style={{fontSize:10,color:"#94a3b8",lineHeight:1.45}}>{q.v}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Factors */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
              {[
                {title:"ICT Factors",items:result.ictFactors||[],color:"#f59e0b"},
                {title:"SMC Factors",items:result.smcFactors||[],color:"#06b6d4"},
                {title:"Macro Factors",items:result.macroFactors||[],color:"#34d399"},
              ].map(g=>(
                <div key={g.title} style={{background:"#0a1628",border:`0.5px solid ${g.color}20`,borderRadius:8,padding:12}}>
                  <div style={{fontSize:9,color:g.color,letterSpacing:"0.1em",marginBottom:8}}>{g.title.toUpperCase()}</div>
                  {(g.items||[]).map((item,i)=>(
                    <div key={i} style={{display:"flex",alignItems:"flex-start",gap:6,marginBottom:5}}>
                      <span style={{color:g.color,fontSize:10,marginTop:1}}>▸</span>
                      <span style={{fontSize:11,color:"#94a3b8",lineHeight:1.4}}>{item}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {/* Summary + invalidation */}
            <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:10}}>
              <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:8,padding:14}}>
                <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:8}}>AI ANALYSIS SUMMARY</div>
                <div style={{fontSize:12,color:"#cbd5e1",lineHeight:1.7}}>{result.summary}</div>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <div style={{background:"#1a0000",border:"0.5px solid #ef444430",borderRadius:8,padding:12,flex:1}}>
                  <div style={{fontSize:9,color:"#ef4444",letterSpacing:"0.1em",marginBottom:6}}>INVALIDATION</div>
                  <div style={{fontSize:11,color:"#94a3b8",lineHeight:1.5}}>{result.invalidation}</div>
                </div>
                <div style={{background:"#1c1300",border:"0.5px solid #f59e0b30",borderRadius:8,padding:12,flex:1}}>
                  <div style={{fontSize:9,color:"#f59e0b",letterSpacing:"0.1em",marginBottom:6}}>RISK WARNING</div>
                  <div style={{fontSize:11,color:"#94a3b8",lineHeight:1.5}}>{result.riskWarning}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {!loading&&!result&&!error&&(
          <div style={{background:"#0a1628",border:"0.5px dashed #1e3a5a",borderRadius:12,padding:48,textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:12,color:"#64748b"}}>◈</div>
            <div style={{fontSize:13,color:"#7c8ea8"}}>Select an asset and timeframe, then run AI analysis</div>
            <div style={{fontSize:10,color:"#64748b",marginTop:6}}>Powered by DeepSeek — ICT + SMC + Macro synthesis</div>
          </div>
        )}
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// REAL deterministic backtest on actual candles (EMA 9/21 crossover + RSI gate +
// ATR stop, RR 2). Replaces the random simulator for real Dhan-futures data.
// Computes true ₹ P&L for futures = point move × lots × lotSize, net of brokerage.
function realCandleBacktest(candles, { lots=1, lotSize=1, brokerageRT=0, capital=200000 }={}) {
  const n = candles.length;
  if (n < 50) return { trades:[], totalTrades:0, winRate:0, profitFactor:0, maxDD:0, sharpe:0, totalReturn:0, grossPnl:0, brokerage:0, netPnl:0, real:true };
  const closes = candles.map(c=>c.close);
  const emaArr = p => { const k=2/(p+1), o=[]; for(let i=0;i<n;i++) o[i]= i===0?closes[0] : closes[i]*k + o[i-1]*(1-k); return o; };
  const fast=emaArr(9), slow=emaArr(21);
  const rsi=new Array(n).fill(null);
  { let g=0,l=0; for(let i=1;i<n;i++){ const d=closes[i]-closes[i-1], up=Math.max(d,0), dn=Math.max(-d,0);
      if(i<=14){ g+=up; l+=dn; if(i===14) rsi[i]=100-100/(1+(g/14)/((l/14)||1e-9)); }
      else { g=(g*13+up)/14; l=(l*13+dn)/14; rsi[i]=100-100/(1+g/(l||1e-9)); } } }
  const atr=new Array(n).fill(null);
  { const tr=[0]; for(let i=1;i<n;i++) tr.push(Math.max(candles[i].high-candles[i].low, Math.abs(candles[i].high-candles[i-1].close), Math.abs(candles[i].low-candles[i-1].close)));
    for(let i=14;i<n;i++){ let s=0; for(let j=i-13;j<=i;j++) s+=tr[j]; atr[i]=s/14; } }

  const trades=[]; const RR=2, SLm=1.5;
  let i=22;
  while(i<n-1){
    if(fast[i]==null||slow[i]==null||rsi[i]==null||atr[i]==null){ i++; continue; }
    const up = fast[i-1]<=slow[i-1] && fast[i]>slow[i] && rsi[i]>45 && rsi[i]<72;
    const dn = fast[i-1]>=slow[i-1] && fast[i]<slow[i] && rsi[i]<55 && rsi[i]>28;
    if(up||dn){
      const isBuy=up, entry=closes[i], a=atr[i];
      const sl=isBuy?entry-SLm*a:entry+SLm*a, risk=Math.abs(entry-sl);
      if(risk<=0){ i++; continue; }
      const tp=isBuy?entry+RR*risk:entry-RR*risk;
      let exit=null, win=null, k=i+1;
      for(; k<Math.min(i+200,n); k++){
        const h=candles[k].high, lo=candles[k].low;
        if(isBuy){ if(lo<=sl){exit=sl;win=false;break;} if(h>=tp){exit=tp;win=true;break;} }
        else     { if(h>=sl){exit=sl;win=false;break;} if(lo<=tp){exit=tp;win=true;break;} }
      }
      if(exit==null){ const last=Math.min(i+200,n-1); exit=candles[last].close; win=isBuy?exit>entry:exit<entry; k=last; }
      const points=isBuy?exit-entry:entry-exit;
      const gross=points*lots*lotSize;
      trades.push({ entry, exit, win, points, gross, net:gross-brokerageRT*lots });
      i=k+1;
    } else i++;
  }
  const totalGross=trades.reduce((s,t)=>s+t.gross,0);
  const totalBrok=brokerageRT*lots*trades.length;
  const totalNet=totalGross-totalBrok;
  const wins=trades.filter(t=>t.win).length;
  const gw=trades.filter(t=>t.net>0).reduce((s,t)=>s+t.net,0);
  const gl=Math.abs(trades.filter(t=>t.net<=0).reduce((s,t)=>s+t.net,0));
  let eq=capital; const curve=[capital];
  trades.forEach(t=>{ eq+=t.net; t.pnl=t.net; t.equity=eq; curve.push(eq); });
  const maxDD=curve.reduce((acc,v,idx,arr)=>{ const peak=Math.max(...arr.slice(0,idx+1)); return Math.max(acc,(peak-v)/peak*100); },0);
  const rets=curve.map((v,idx)=>idx===0?0:(v-curve[idx-1])/curve[idx-1]);
  const mean=rets.reduce((s,r)=>s+r,0)/(rets.length||1);
  const std=Math.sqrt(rets.reduce((s,r)=>s+(r-mean)**2,0)/(rets.length||1))||1;
  return {
    trades, totalTrades:trades.length,
    winRate: trades.length?wins/trades.length*100:0,
    profitFactor: gl?gw/gl:(gw>0?99:0),
    maxDD, sharpe:(mean/std)*Math.sqrt(252),
    totalReturn: capital?totalNet/capital*100:0,    // NET return on capital
    grossPnl: totalGross, brokerage: totalBrok, netPnl: totalNet, real:true,
  };
}

function BacktestPage({candles}) {
  const [stratId,setStratId]=useState("ict_ob");
  const [assetId,setAssetId]=useState("BTCUSD");
  const [period,setPeriod]=useState(300);
  const [running,setRunning]=useState(false);
  const [results,setResults]=useState(null);
  const [activated,setActivated]=useState(false);
  const [assignments,setAssignments]=useState(()=>getActiveStrategies());
  const refreshAssignments=()=>setAssignments(getActiveStrategies());

  // Data source: "auto" = live/synthetic (default); "dhan" = real Dhan history.
  const [dataSource,setDataSource]=useState("auto");
  const [dhanInstrument,setDhanInstrument]=useState("NIFTY50");
  const [dhanTf,setDhanTf]=useState("5m");
  const [dhanMsg,setDhanMsg]=useState("");

  // Indian-exchange awareness: ₹ currency, brokerage box, lots dropdown.
  const isIndian = dataSource==="dhan";
  const curr = isIndian ? "₹" : "$";
  const FUT_BROKERAGE = { NIFTY50:464, BANKNIFTY:240, SENSEX:175 };  // ~round-trip charges/lot
  const FUT_LOT       = { NIFTY50:getLotSize("NIFTY50"), BANKNIFTY:getLotSize("BANKNIFTY"), SENSEX:getLotSize("SENSEX") };
  const [capital,setCapital]     = useState(10000);
  const [brokerage,setBrokerage] = useState(0);
  const [lots,setLots]           = useState(1);
  // Default capital/brokerage when switching market type or instrument.
  useEffect(()=>{
    if (isIndian) { setCapital(400000); setBrokerage(FUT_BROKERAGE[dhanInstrument]||450); }
    else          { setCapital(10000);  setBrokerage(0); }
  }, [isIndian, dhanInstrument]);

  const runBT=async ()=>{
    setRunning(true); setResults(null); setActivated(false); setDhanMsg("");

    if (dataSource==="dhan") {
      if (!getDhanToken()) {
        setDhanMsg("No Dhan token — add it in Settings → Dhan Data API.");
        setRunning(false); return;
      }
      // Pull the last ~30 days of intraday history (or 1y for daily).
      const today = new Date();
      const back  = dhanTf==="1D" ? 365 : 30;
      const from  = new Date(today.getTime()-back*86400000);
      const fmt   = d=>d.toISOString().slice(0,10);
      setDhanMsg(`Fetching ${DHAN_INSTRUMENTS[dhanInstrument].label} ${dhanTf} from Dhan...`);
      const c = await fetchDhanHistorical(dhanInstrument, dhanTf, fmt(from), fmt(today));
      if (!c || c.length<50) {
        setDhanMsg(c
          ? `Only ${c?.length||0} candles returned — widen the range or change timeframe.`
          : `Dhan fetch failed: ${dhanLastError || "unknown"}. ${
              /Invalid Token|token/i.test(dhanLastError) ? "RESTART the bridge so it uses the auto-refreshed token, or regenerate the token."
              : /bridge/i.test(dhanLastError) ? "Start/restart bridge.py and set its URL in Settings → MT5 Terminal."
              : "For bulk, use strategy-lab/dhan_collector.py."}`);
        setRunning(false); return;
      }
      setDhanMsg(`Loaded ${c.length} real ${DHAN_INSTRUMENTS[dhanInstrument].label} FUTURES candles from Dhan (auto-rolled contract). Real backtest, net of ${curr}${brokerage}/RT × ${lots} lot${lots>1?"s":""}.`);
      // REAL price-action backtest on the actual futures candles (not the random
      // simulator), with true ₹ futures P&L = points × lots × lotSize − brokerage.
      setResults(realCandleBacktest(c.slice(-period), {
        lots, lotSize: FUT_LOT[dhanInstrument]||1, brokerageRT: brokerage, capital,
      }));
      setRunning(false);
      return;
    }

    setTimeout(()=>{
      const live=candles[assetId];
      // Use live candles if available, otherwise generate synthetic ones with the chosen period
      const c=live && live.length>=period ? live.slice(-period)
             : genCandles(ASSETS.find(a=>a.id===assetId)?.base||1000, period);
      setResults(runBacktest(c,stratId));
      setRunning(false);
    },1800);
  };

  const strat=STRATEGIES.find(s=>s.id===stratId);
  // Net-of-cost financials in account currency. Real Dhan backtests carry true
  // ₹ futures P&L; synthetic runs fall back to a %-on-capital approximation.
  const fin = results ? (results.real ? {
    grossPnl:  results.grossPnl,
    totalBrok: results.brokerage,
    netPnl:    results.netPnl,
    netPct:    capital ? results.netPnl/capital*100 : 0,
  } : (()=>{
    const grossPnl  = capital * (results.totalReturn/100) * lots;
    const totalBrok = brokerage * results.totalTrades * lots;
    const netPnl    = grossPnl - totalBrok;
    return { grossPnl, totalBrok, netPnl, netPct: capital ? netPnl/capital*100 : 0 };
  })()) : null;
  const profitable = results && (isIndian ? (fin && fin.netPct > 0) : results.totalReturn > 0)
                     && results.winRate >= 50 && results.profitFactor >= 1;
  const alreadyActive = assignments.some(s=>s.id===stratId && s.assetId===assetId);

  return (
    <div style={{height:"100%",overflow:"auto"}}>
      <div style={{maxWidth:900,margin:"0 auto",display:"flex",flexDirection:"column",gap:10}}>
        {/* Strategy assignments — which strategy runs on which asset */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em"}}>STRATEGIES IN USE — TICK WHICH RUNS ON EACH ASSET</div>
            <div style={{fontSize:9,color:assignments.length?"#22c55e":"#7c8ea8"}}>{assignments.length} active</div>
          </div>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:"monospace"}}>
            <thead>
              <tr>
                <th style={{textAlign:"left",padding:"6px 8px",fontSize:8,color:"#94a3b8",borderBottom:"0.5px solid #1e3a5a",letterSpacing:"0.06em"}}>STRATEGY</th>
                {ASSETS.map(a=>(
                  <th key={a.id} style={{textAlign:"center",padding:"6px 8px",fontSize:8,color:"#94a3b8",borderBottom:"0.5px solid #1e3a5a"}}>{a.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {STRATEGIES.map(s=>(
                <tr key={s.id} style={{borderBottom:"0.5px solid #0d1b2a"}}>
                  <td style={{padding:"7px 8px",color:"#e2e8f0"}}>{s.name}</td>
                  {ASSETS.map(a=>{
                    const on=assignments.some(x=>x.id===s.id&&x.assetId===a.id);
                    return (
                      <td key={a.id} style={{textAlign:"center",padding:"7px 8px"}}>
                        <input type="checkbox" checked={on}
                          onChange={e=>{
                            if(e.target.checked){
                              addActiveStrategy({id:s.id,name:s.name,assetId:a.id,assetLabel:a.label,winRate:0,profitFactor:0,totalReturn:0,addedAt:Date.now()});
                            } else {
                              removeActiveStrategy(s.id,a.id);
                            }
                            refreshAssignments();
                          }}
                          style={{width:15,height:15,cursor:"pointer",accentColor:"#22c55e"}}/>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{fontSize:8,color:"#7c8ea8",marginTop:8,lineHeight:1.5}}>
            Checked = the signal engine applies that strategy to that asset. Activating a profitable strategy from a backtest below also ticks it here.
          </div>
        </div>

        {/* Config */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:12}}>BACKTEST CONFIGURATION</div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
            <div>
              <div style={{fontSize:9,color:"#94a3b8",marginBottom:4}}>STRATEGY</div>
              <select value={stratId} onChange={e=>setStratId(e.target.value)}
                style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"6px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}>
                {STRATEGIES.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{fontSize:9,color:"#94a3b8",marginBottom:4}}>ASSET</div>
              <select value={assetId} onChange={e=>setAssetId(e.target.value)} disabled={dataSource==="dhan"}
                style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"6px 10px",color:dataSource==="dhan"?"#475569":"#e2e8f0",fontSize:12,fontFamily:"monospace"}}>
                {ASSETS.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </div>
            <div>
              <div style={{fontSize:9,color:"#94a3b8",marginBottom:4}}>DATA SOURCE</div>
              <select value={dataSource} onChange={e=>setDataSource(e.target.value)}
                style={{background:"#060d17",border:`0.5px solid ${dataSource==="dhan"?"#a78bfa":"#1e3a5a"}`,borderRadius:6,padding:"6px 10px",color:dataSource==="dhan"?"#a78bfa":"#e2e8f0",fontSize:12,fontFamily:"monospace"}}>
                <option value="auto">Live / Synthetic</option>
                <option value="dhan">Dhan Historical</option>
              </select>
            </div>
            {dataSource==="dhan"&&(
              <>
                <div>
                  <div style={{fontSize:9,color:"#94a3b8",marginBottom:4}}>DHAN INSTRUMENT</div>
                  <select value={dhanInstrument} onChange={e=>setDhanInstrument(e.target.value)}
                    style={{background:"#060d17",border:"0.5px solid #a78bfa",borderRadius:6,padding:"6px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}>
                    {Object.entries(DHAN_INSTRUMENTS).map(([k,m])=><option key={k} value={k}>{m.label}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{fontSize:9,color:"#94a3b8",marginBottom:4}}>TIMEFRAME</div>
                  <select value={dhanTf} onChange={e=>setDhanTf(e.target.value)}
                    style={{background:"#060d17",border:"0.5px solid #a78bfa",borderRadius:6,padding:"6px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}>
                    {["1m","5m","15m","1H","1D"].map(tf=><option key={tf} value={tf}>{tf}</option>)}
                  </select>
                </div>
              </>
            )}
            <div>
              <div style={{fontSize:9,color:"#94a3b8",marginBottom:4}}>INITIAL CAPITAL ({curr})</div>
              <div style={{display:"flex",alignItems:"center",gap:2,background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"0 8px",width:120}}>
                <span style={{fontSize:12,color:"#7c8ea8"}}>{curr}</span>
                <input type="number" value={capital} onChange={e=>setCapital(Number(e.target.value)||0)}
                  style={{background:"transparent",border:"none",padding:"6px 2px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace",width:"100%",outline:"none"}}/>
              </div>
            </div>
            <div>
              <div style={{fontSize:9,color:"#94a3b8",marginBottom:4}}>RISK PER TRADE</div>
              <input defaultValue="1%" style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"6px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace",width:80}}/>
            </div>
            {isIndian && (
              <>
                <div>
                  <div style={{fontSize:9,color:"#94a3b8",marginBottom:4}}>BROKERAGE ({curr}/RT)</div>
                  <input type="number" value={brokerage} onChange={e=>setBrokerage(Number(e.target.value)||0)}
                    title="All-in round-trip charges per lot (brokerage + STT + exchange + GST)"
                    style={{background:"#060d17",border:"0.5px solid #a78bfa50",borderRadius:6,padding:"6px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace",width:90}}/>
                </div>
                <div>
                  <div style={{fontSize:9,color:"#94a3b8",marginBottom:4}}>LOTS ({FUT_LOT[dhanInstrument]||"–"}/lot)</div>
                  <select value={lots} onChange={e=>setLots(Number(e.target.value))}
                    style={{background:"#060d17",border:"0.5px solid #a78bfa50",borderRadius:6,padding:"6px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace",width:70}}>
                    {[1,2,3,5,10,15,20].map(n=><option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </>
            )}
            <div>
              <div style={{fontSize:9,color:"#94a3b8",marginBottom:4}}>PERIOD (CANDLES)</div>
              <select value={period} onChange={e=>setPeriod(Number(e.target.value))}
                style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"6px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace",width:110}}>
                {[90,150,300,500,800].map(n=><option key={n} value={n}>{n} candles</option>)}
              </select>
            </div>
            <button onClick={runBT} disabled={running}
              style={{marginLeft:"auto",padding:"8px 20px",background:running?"#1e3a5a":"linear-gradient(135deg,#059669,#0d9488)",
                border:"none",borderRadius:8,color:"white",fontSize:12,fontWeight:700,cursor:running?"not-allowed":"pointer",fontFamily:"monospace"}}>
              {running?"⟳ RUNNING...":"⟳ RUN BACKTEST"}
            </button>
          </div>
          {dataSource==="dhan"&&dhanMsg&&(
            <div style={{marginTop:10,fontSize:10,color:dhanMsg.includes("Loaded")?"#22c55e":dhanMsg.includes("Fetching")?"#f59e0b":"#ef4444",fontFamily:"monospace"}}>
              {dhanMsg}
            </div>
          )}
          {dataSource==="dhan"&&(
            <div style={{marginTop:6,fontSize:9,color:"#7c8ea8",lineHeight:1.5}}>
              Real candles from your Dhan Data API subscription. Browser pulls route through a CORS proxy and can be rate-limited —
              for bulk/automated backtests use <span style={{color:"#a78bfa",fontFamily:"monospace"}}>strategy-lab/dhan_collector.py</span>.
            </div>
          )}
        </div>

        {running&&(
          <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:32,textAlign:"center"}}>
            <div style={{fontSize:28,marginBottom:8,color:"#059669",animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</div>
            <div style={{fontSize:12,color:"#34d399",fontFamily:"monospace"}}>Vectorised backtest running on {ASSETS.find(a=>a.id===assetId)?.label}...</div>
          </div>
        )}

        {results&&(
          <>
            {/* Metrics grid */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8}}>
              {[
                {l:"Total Return",v:`${results.totalReturn>=0?"+":""}${results.totalReturn.toFixed(1)}%`,c:results.totalReturn>=0?"#22c55e":"#ef4444"},
                {l:"Win Rate",v:`${results.winRate.toFixed(1)}%`,c:"#60a5fa"},
                {l:"Profit Factor",v:results.profitFactor.toFixed(2),c:results.profitFactor>=1?"#22c55e":"#ef4444"},
                {l:"Max Drawdown",v:`-${results.maxDD.toFixed(1)}%`,c:"#ef4444"},
                {l:"Sharpe Ratio",v:results.sharpe.toFixed(2),c:results.sharpe>=1?"#22c55e":"#f59e0b"},
                {l:"Total Trades",v:results.totalTrades,c:"#e2e8f0"},
              ].map(m=>(
                <div key={m.l} style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:8,padding:"10px 12px",textAlign:"center"}}>
                  <div style={{fontSize:8,color:"#94a3b8",marginBottom:4}}>{m.l.toUpperCase()}</div>
                  <div style={{fontSize:18,fontWeight:800,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
                </div>
              ))}
            </div>

            {/* Net-of-brokerage P&L (Indian futures: capital + lots + brokerage) */}
            {isIndian && fin && (
              <div style={{background:"#0a1628",border:"0.5px solid #a78bfa40",borderRadius:12,padding:"10px 14px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                  <span style={{fontSize:9,color:"#a78bfa",letterSpacing:"0.08em",fontWeight:700}}>NET OF BROKERAGE</span>
                  <span style={{fontSize:9,color:"#7c8ea8"}}>{lots} lot{lots>1?"s":""} · {curr}{capital.toLocaleString("en-IN")} capital · {curr}{brokerage}/RT × {results.totalTrades} trades</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                  {[
                    {l:"Gross P&L",  v:`${fin.grossPnl>=0?"+":"-"}${curr}${Math.abs(fin.grossPnl).toLocaleString("en-IN",{maximumFractionDigits:0})}`, c:fin.grossPnl>=0?"#22c55e":"#ef4444"},
                    {l:"Brokerage",  v:`-${curr}${fin.totalBrok.toLocaleString("en-IN",{maximumFractionDigits:0})}`, c:"#f59e0b"},
                    {l:"Net P&L",    v:`${fin.netPnl>=0?"+":"-"}${curr}${Math.abs(fin.netPnl).toLocaleString("en-IN",{maximumFractionDigits:0})}`, c:fin.netPnl>=0?"#22c55e":"#ef4444"},
                    {l:"Net Return", v:`${fin.netPct>=0?"+":""}${fin.netPct.toFixed(1)}%`, c:fin.netPct>=0?"#22c55e":"#ef4444"},
                  ].map(m=>(
                    <div key={m.l} style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:8,padding:"8px 10px",textAlign:"center"}}>
                      <div style={{fontSize:8,color:"#94a3b8",marginBottom:3}}>{m.l.toUpperCase()}</div>
                      <div style={{fontSize:16,fontWeight:800,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
                    </div>
                  ))}
                </div>
                <div style={{fontSize:8,color:"#64748b",marginTop:7,lineHeight:1.4}}>
                  Real ₹ futures P&L = point move × lots × {FUT_LOT[dhanInstrument]} (lot size), minus brokerage ({curr}{brokerage}/round-trip/lot). Quick-check only: the browser runs ONE real engine (EMA 9/21 + RSI + ATR stop, RR 2) — the strategy dropdown doesn't change it here. For the full 10-strategy suite + exact tick-level charges, use strategy-lab/backtester.py.
                </div>
              </div>
            )}

            {/* Activate strategy for live signals */}
            <div style={{background:"#0a1628",border:`0.5px solid ${profitable?"#22c55e40":"#1e3a5a"}`,borderRadius:12,padding:14,
              display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
              <div>
                <div style={{fontSize:11,color:"#e2e8f0",fontWeight:700}}>
                  {strat?.name} · {ASSETS.find(a=>a.id===assetId)?.label}
                </div>
                <div style={{fontSize:9,color:profitable?"#22c55e":"#f59e0b",marginTop:3,lineHeight:1.5}}>
                  {profitable
                    ? "Profitable in backtest — activate it so the signal engine uses this strategy for this asset."
                    : "Not profitable enough to activate (needs positive return, win rate ≥ 50%, and profit factor ≥ 1)."}
                </div>
              </div>
              <button disabled={!profitable || activated || alreadyActive}
                onClick={()=>{
                  addActiveStrategy({
                    id:          stratId,
                    name:        strat?.name || stratId,
                    assetId,
                    assetLabel:  ASSETS.find(a=>a.id===assetId)?.label,
                    winRate:     +results.winRate.toFixed(1),
                    profitFactor:+results.profitFactor.toFixed(2),
                    totalReturn: +results.totalReturn.toFixed(1),
                    addedAt:     Date.now(),
                  });
                  setActivated(true);
                  refreshAssignments();
                }}
                style={{padding:"9px 18px",borderRadius:8,border:"none",fontSize:11,fontWeight:700,fontFamily:"monospace",flexShrink:0,
                  cursor:(profitable&&!activated&&!alreadyActive)?"pointer":"not-allowed",
                  background:(activated||alreadyActive)?"#052e16":profitable?"linear-gradient(135deg,#059669,#0d9488)":"#1e3a5a",
                  color:(activated||alreadyActive)?"#22c55e":profitable?"white":"#7c8ea8"}}>
                {(activated||alreadyActive)?"✓ Active for signals":"➕ Activate for live signals"}
              </button>
            </div>

            {/* Equity curve */}
            <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
              <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:10}}>EQUITY CURVE</div>
              <div style={{height:130}}>
                <EquityCurve curve={results.curve}/>
              </div>
            </div>

            {/* Trade log */}
            <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
              <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:10}}>
                TRADE LOG — {results.totalTrades} TRADES
              </div>
              <div style={{maxHeight:200,overflowY:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:"monospace"}}>
                  <thead>
                    <tr>{["#","Result","P&L","Cumulative Equity"].map(h=>(
                      <th key={h} style={{textAlign:"left",padding:"4px 8px",fontSize:8,color:"#94a3b8",borderBottom:"0.5px solid #1e3a5a",letterSpacing:"0.06em"}}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {results.trades.slice(-20).map((t,i)=>(
                      <tr key={i} style={{borderBottom:"0.5px solid #0d1b2a"}}>
                        <td style={{padding:"4px 8px",color:"#7c8ea8"}}>{results.trades.length-19+i}</td>
                        <td style={{padding:"4px 8px",color:t.win?"#22c55e":"#ef4444",fontWeight:600}}>{t.win?"WIN":"LOSS"}</td>
                        <td style={{padding:"4px 8px",color:t.pnl>=0?"#22c55e":"#ef4444"}}>{t.pnl>=0?"+":"-"}{curr}{Math.abs(t.pnl).toLocaleString("en-IN",{maximumFractionDigits:0})}</td>
                        <td style={{padding:"4px 8px",color:"#e2e8f0"}}>{curr}{t.equity.toLocaleString("en-IN",{maximumFractionDigits:0})}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function ExecutionPage({prices}) {
  const [orders,setOrders]=useState([
    {id:"ORD001",asset:"BTC/USD",dir:"LONG", entry:96800,current:97420,size:0.5,sl:95200,tp:99400,pnl:310, pct:2.4, status:"open",  strategy:"ICT OB"},
    {id:"ORD002",asset:"XAU/USD",dir:"LONG", entry:2330, current:2341, size:2,  sl:2310, tp:2390, pnl:22,  pct:0.47,status:"open",  strategy:"Macro"},
    {id:"ORD003",asset:"ETH/USD",dir:"SHORT",entry:3210, current:3184, size:3,  sl:3290, tp:3000, pnl:78,  pct:0.81,status:"open",  strategy:"SMC BOS"},
    {id:"ORD004",asset:"BTC/USD",dir:"LONG", entry:94200,current:97420,size:0.3,sl:92000,tp:98000,pnl:966, pct:3.4, status:"closed",strategy:"FVG"},
    {id:"ORD005",asset:"ETH/USD", dir:"LONG", entry:3050, current:3184, size:2,   sl:2950, tp:3300, pnl:268, pct:4.4, status:"closed",strategy:"FVG Fill"},
  ]);
  const [newOrder,setNewOrder]=useState({asset:"BTCUSD",dir:"BUY",size:"",sl:"",tp:"",strategy:"ICT OB"});
  const [showForm,setShowForm]=useState(false);
  const [apiMode,setApiMode]=useState(getExecMode());

  // ── MT5 bridge connectivity — pings the Bridge URL for the selected mode ──
  const [bridge,setBridge]=useState({state:"checking"});
  useEffect(()=>{
    let stop=false;
    const ping=async()=>{
      const cfg=getMT5Config();
      if(cfg.paper){ if(!stop) setBridge({state:"paper"}); return; }
      if(!cfg.bridgeUrl){ if(!stop) setBridge({state:"unconfigured"}); return; }
      try{
        const r=await fetch(cfg.bridgeUrl,{method:"GET",signal:AbortSignal.timeout(4000)});
        const d=await r.json().catch(()=>({}));
        if(!stop) setBridge(r.ok?{state:"connected",dryRun:d.dryRun}:{state:"offline"});
      }catch{ if(!stop) setBridge({state:"offline"}); }
    };
    ping();
    const t=setInterval(ping,10000);
    return ()=>{ stop=true; clearInterval(t); };
  },[apiMode]);

  const open=orders.filter(o=>o.status==="open");
  const closed=orders.filter(o=>o.status==="closed");
  const totalPnl=open.reduce((s,o)=>s+o.pnl,0);

  return (
    <div style={{height:"100%",overflow:"auto"}}>
      <div style={{maxWidth:900,margin:"0 auto",display:"flex",flexDirection:"column",gap:10}}>
        {/* Controls */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14,display:"flex",gap:12,alignItems:"center"}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em"}}>EXECUTION MODE</div>
          <div style={{display:"flex",gap:4}}>
            {[
              {id:"paper",    label:"Paper Trade", c:"#60a5fa"},
              {id:"mt5_demo", label:"MT5 Demo",    c:"#22c55e"},
              {id:"mt5_live", label:"MT5 Live",    c:"#ef4444"},
            ].map(m=>(
              <span key={m.id} onClick={()=>{ setApiMode(m.id); setExecMode(m.id); }}
                style={{padding:"5px 12px",borderRadius:6,fontSize:10,cursor:"pointer",fontFamily:"monospace",fontWeight:apiMode===m.id?700:400,
                  background:apiMode===m.id?m.c+"22":"#060d17",color:apiMode===m.id?m.c:"#94a3b8",
                  border:`0.5px solid ${apiMode===m.id?m.c:"#1e3a5a"}`}}>{m.label}</span>
            ))}
          </div>
          {apiMode==="mt5_live"&&<span style={{fontSize:9,color:"#ef4444",background:"#1a0000",padding:"2px 8px",borderRadius:4,border:"0.5px solid #ef444430"}}>⚠ REAL FUNDS</span>}
          {/* MT5 bridge status */}
          {(()=>{
            const map={
              checking:    {c:"#94a3b8", t:"MT5 bridge: checking…"},
              connected:   {c:"#22c55e", t:`MT5 bridge: connected${bridge.dryRun?" · DRY-RUN":""}`},
              offline:     {c:"#ef4444", t:"MT5 bridge: offline"},
              unconfigured:{c:"#f59e0b", t:"MT5 bridge: not set"},
              paper:       {c:"#60a5fa", t:"Paper mode — MT5 not used"},
            };
            const s=map[bridge.state]||map.checking;
            return (
              <span title="Pings the Bridge / API URL set in Settings → MT5 Terminal"
                style={{display:"flex",alignItems:"center",gap:6,fontSize:10,fontFamily:"monospace",
                  color:s.c,background:"#060d17",border:`0.5px solid ${s.c}40`,borderRadius:6,padding:"4px 10px"}}>
                <span style={{width:7,height:7,borderRadius:"50%",background:s.c,
                  boxShadow:bridge.state==="connected"?`0 0 6px ${s.c}`:"none"}}/>
                {s.t}
              </span>
            );
          })()}
          <div style={{marginLeft:"auto",display:"flex",gap:6}}>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:9,color:"#94a3b8"}}>OPEN PNL</div>
              <div style={{fontSize:16,fontWeight:800,color:totalPnl>=0?"#22c55e":"#ef4444",fontFamily:"monospace"}}>{totalPnl>=0?"+":""}${totalPnl.toFixed(0)}</div>
            </div>
            <button onClick={()=>setShowForm(f=>!f)}
              style={{padding:"8px 16px",background:"linear-gradient(135deg,#1d4ed8,#7c3aed)",border:"none",borderRadius:8,color:"white",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
              ⚡ NEW ORDER
            </button>
          </div>
        </div>

        {/* New order form */}
        {showForm&&(
          <div style={{background:"#0a1628",border:"0.5px solid #3b82f640",borderRadius:12,padding:16}}>
            <div style={{fontSize:9,color:"#60a5fa",letterSpacing:"0.1em",marginBottom:12}}>NEW ORDER — {apiMode.toUpperCase()} MODE</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8}}>
              {[
                {l:"Asset",k:"asset",type:"select",opts:ASSETS.map(a=>a.id)},
                {l:"Direction",k:"dir",type:"select",opts:["BUY","SELL"]},
                {l:"Size",k:"size",type:"input",ph:"0.1"},
                {l:"Stop Loss",k:"sl",type:"input",ph:"95000"},
                {l:"Take Profit",k:"tp",type:"input",ph:"100000"},
                {l:"Strategy",k:"strategy",type:"select",opts:STRATEGIES.map(s=>s.name)},
              ].map(f=>(
                <div key={f.k}>
                  <div style={{fontSize:8,color:"#94a3b8",marginBottom:3}}>{f.l.toUpperCase()}</div>
                  {f.type==="select"
                    ? <select value={newOrder[f.k]} onChange={e=>setNewOrder(o=>({...o,[f.k]:e.target.value}))}
                        style={{width:"100%",background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"5px 8px",color:"#e2e8f0",fontSize:11,fontFamily:"monospace"}}>
                        {f.opts.map(o=><option key={o} value={o}>{o}</option>)}
                      </select>
                    : <input placeholder={f.ph} value={newOrder[f.k]} onChange={e=>setNewOrder(o=>({...o,[f.k]:e.target.value}))}
                        style={{width:"100%",background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"5px 8px",color:"#e2e8f0",fontSize:11,fontFamily:"monospace"}}/>
                  }
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button onClick={()=>{
                const newO={id:`ORD00${orders.length+1}`,asset:ASSETS.find(a=>a.id===newOrder.asset)?.label||newOrder.asset,
                  dir:newOrder.dir,entry:prices[newOrder.asset]||90000,current:prices[newOrder.asset]||90000,
                  size:parseFloat(newOrder.size)||0.1,sl:parseFloat(newOrder.sl)||0,tp:parseFloat(newOrder.tp)||0,
                  pnl:0,pct:0,status:"open",strategy:newOrder.strategy};
                setOrders(o=>[newO,...o]); setShowForm(false);
              }} style={{padding:"8px 20px",background:"#22c55e",border:"none",borderRadius:7,color:"black",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"monospace"}}>
                ✓ PLACE ORDER
              </button>
              <button onClick={()=>setShowForm(false)} style={{padding:"8px 16px",background:"#1e2a3a",border:"none",borderRadius:7,color:"#94a3b8",fontSize:11,cursor:"pointer"}}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Open positions */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:10}}>OPEN POSITIONS ({open.length})</div>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:"monospace"}}>
            <thead>
              <tr>{["ID","Asset","Dir","Entry","Current","Size","P&L","P&L %","Strategy","Action"].map(h=>(
                <th key={h} style={{textAlign:"left",padding:"5px 8px",fontSize:8,color:"#94a3b8",borderBottom:"0.5px solid #1e3a5a",letterSpacing:"0.06em"}}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {open.map(o=>{
                const col=o.pnl>=0?"#22c55e":"#ef4444";
                return <tr key={o.id} style={{borderBottom:"0.5px solid #0d1b2a"}}>
                  <td style={{padding:"7px 8px",color:"#7c8ea8"}}>{o.id}</td>
                  <td style={{padding:"7px 8px",color:"#e2e8f0",fontWeight:600}}>{o.asset}</td>
                  <td style={{padding:"7px 8px"}}><span style={{color:o.dir==="LONG"?"#22c55e":"#ef4444",fontWeight:700}}>{o.dir}</span></td>
                  <td style={{padding:"7px 8px",color:"#94a3b8"}}>{o.entry.toLocaleString()}</td>
                  <td style={{padding:"7px 8px",color:"#e2e8f0"}}>{o.current.toLocaleString()}</td>
                  <td style={{padding:"7px 8px",color:"#94a3b8"}}>{o.size}</td>
                  <td style={{padding:"7px 8px",color:col,fontWeight:700}}>{o.pnl>=0?"+":""}${o.pnl}</td>
                  <td style={{padding:"7px 8px",color:col}}>{o.pct>=0?"+":""}{o.pct}%</td>
                  <td style={{padding:"7px 8px"}}><span style={{color:CAT_COLOR["ICT"]||"#f59e0b",fontSize:9,background:"#1e2a3a",padding:"1px 5px",borderRadius:3}}>{o.strategy}</span></td>
                  <td style={{padding:"7px 8px"}}>
                    <button onClick={()=>setOrders(ords=>ords.map(ord=>ord.id===o.id?{...ord,status:"closed"}:ord))}
                      style={{fontSize:9,padding:"2px 7px",background:"#1a0000",border:"0.5px solid #ef444430",borderRadius:4,color:"#ef4444",cursor:"pointer",fontFamily:"monospace"}}>
                      Close
                    </button>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>

        {/* Trade history */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:10}}>TRADE HISTORY</div>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:"monospace"}}>
            <thead>
              <tr>{["ID","Asset","Dir","Entry","P&L","Result","Strategy"].map(h=>(
                <th key={h} style={{textAlign:"left",padding:"5px 8px",fontSize:8,color:"#94a3b8",borderBottom:"0.5px solid #1e3a5a",letterSpacing:"0.06em"}}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {closed.map(o=>(
                <tr key={o.id} style={{borderBottom:"0.5px solid #0d1b2a",opacity:0.7}}>
                  <td style={{padding:"6px 8px",color:"#7c8ea8"}}>{o.id}</td>
                  <td style={{padding:"6px 8px",color:"#94a3b8"}}>{o.asset}</td>
                  <td style={{padding:"6px 8px",color:o.dir==="LONG"?"#22c55e":"#ef4444"}}>{o.dir}</td>
                  <td style={{padding:"6px 8px",color:"#64748b"}}>{o.entry.toLocaleString()}</td>
                  <td style={{padding:"6px 8px",color:o.pnl>=0?"#22c55e":"#ef4444",fontWeight:600}}>{o.pnl>=0?"+":""}${o.pnl}</td>
                  <td style={{padding:"6px 8px"}}>
                    <span style={{color:o.pnl>=0?"#22c55e":"#ef4444",background:o.pnl>=0?"#052e16":"#1a0000",padding:"1px 7px",borderRadius:4,fontSize:9}}>
                      {o.pnl>=0?"WIN":"LOSS"}
                    </span>
                  </td>
                  <td style={{padding:"6px 8px",color:"#94a3b8",fontSize:10}}>{o.strategy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PortfolioPage() {
  const [acct, setAcct] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(()=>{
    let stop=false;
    const load=async()=>{ const a=await fetchMT5Account(); if(!stop){ setAcct(a); setLoading(false); } };
    load();
    const t=setInterval(load, 15000);
    return ()=>{ stop=true; clearInterval(t); };
  },[]);

  const L = getSignalLearning();
  const live = !!acct;
  const cur = acct?.currency || "USD";
  const positions = acct?.positions || [];
  const fmt = (v)=> v==null||!isFinite(v) ? "—" : Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  const pct = v => v==null ? "—" : `${v.toFixed(0)}%`;

  const cards = [
    {l:"Equity",      v: live?`${fmt(acct.equity)} ${cur}`:"—", c:"#e2e8f0"},
    {l:"Balance",     v: live?`${fmt(acct.balance)} ${cur}`:"—", c:"#e2e8f0"},
    {l:"Open P&L",    v: live?`${acct.profit>=0?"+":""}${fmt(acct.profit)} ${cur}`:"—", c:(acct?.profit||0)>=0?"#22c55e":"#ef4444"},
    {l:"Free Margin", v: live?`${fmt(acct.free_margin)} ${cur}`:"—", c:"#60a5fa"},
  ];
  const stats = [
    {l:"Signals (resolved)", v:`${L.resolved||0}/${L.total||0}`, c:"#e2e8f0"},
    {l:"Win Rate",           v:pct(L.winRate), c:"#22c55e"},
    {l:"Expectancy",         v:`${(L.expectancyR||0).toFixed(2)}R`, c:(L.expectancyR||0)>=0?"#22c55e":"#ef4444"},
    {l:"Big Profit",         v:L.counts?.big_profit||0, c:"#22c55e"},
    {l:"Big Loss",           v:L.counts?.big_loss||0, c:"#ef4444"},
    {l:"Small Loss",         v:L.counts?.small_loss||0, c:"#f59e0b"},
  ];

  return (
    <div style={{height:"100%",overflow:"auto"}}>
      <div style={{maxWidth:900,margin:"0 auto",display:"flex",flexDirection:"column",gap:10}}>
        {/* live status */}
        {live ? (
          <div style={{fontSize:10,color:"#22c55e",fontFamily:"monospace"}}>● Live from MT5 — account {acct.login} ({acct.server})</div>
        ) : !loading && (
          <div style={{background:"#1a0a00",border:"0.5px solid #f59e0b40",borderRadius:10,padding:"10px 14px",fontSize:11,color:"#f59e0b",fontFamily:"monospace"}}>
            ⚠ MT5 bridge not reachable — no live account data. Start the bridge (and pick an MT5 mode) to see your real balance & positions.
          </div>
        )}

        {/* account cards */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
          {cards.map(m=>(
            <div key={m.l} style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:"12px 16px"}}>
              <div style={{fontSize:8,color:"#94a3b8",marginBottom:6,letterSpacing:"0.08em"}}>{m.l.toUpperCase()}</div>
              <div style={{fontSize:20,fontWeight:800,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
            </div>
          ))}
        </div>

        {/* open positions */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:10}}>OPEN POSITIONS — {positions.length}</div>
          {positions.length===0 ? (
            <div style={{fontSize:11,color:"#7c8ea8",fontFamily:"monospace"}}>{live?"No open positions.":"—"}</div>
          ) : (
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:"monospace"}}>
              <thead><tr>{["Symbol","Side","Vol","Open","SL","TP","P&L"].map(h=>(
                <th key={h} style={{textAlign:"left",padding:"5px 8px",fontSize:8,color:"#94a3b8",borderBottom:"0.5px solid #1e3a5a"}}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {positions.map(p=>(
                  <tr key={p.ticket} style={{borderBottom:"0.5px solid #0d1b2a"}}>
                    <td style={{padding:"5px 8px",color:"#e2e8f0"}}>{p.symbol}</td>
                    <td style={{padding:"5px 8px",color:p.side==="buy"?"#22c55e":"#ef4444",fontWeight:600}}>{p.side.toUpperCase()}</td>
                    <td style={{padding:"5px 8px",color:"#cbd5e1"}}>{p.volume}</td>
                    <td style={{padding:"5px 8px",color:"#cbd5e1"}}>{p.price_open}</td>
                    <td style={{padding:"5px 8px",color:"#7c8ea8"}}>{p.sl||"—"}</td>
                    <td style={{padding:"5px 8px",color:"#7c8ea8"}}>{p.tp||"—"}</td>
                    <td style={{padding:"5px 8px",color:p.profit>=0?"#22c55e":"#ef4444",fontWeight:600}}>{p.profit>=0?"+":""}{p.profit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* performance from marked outcomes */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:10}}>SIGNAL PERFORMANCE (from your marked outcomes)</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8}}>
            {stats.map(m=>(
              <div key={m.l} style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:8,padding:"10px 12px"}}>
                <div style={{fontSize:8,color:"#94a3b8",marginBottom:4}}>{m.l.toUpperCase()}</div>
                <div style={{fontSize:18,fontWeight:800,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
              </div>
            ))}
          </div>
          <div style={{fontSize:8,color:"#7c8ea8",marginTop:8}}>These build up as you mark signal outcomes in the History tab.</div>
        </div>
      </div>
    </div>
  );
}

function AlertsPage({ prices={}, history=[] }) {
  // Helper to format price with correct symbol
  const fmtPrice = (id, p) => {
    if (!p) return "—";
    if (id === "NIFTY50") return `₹${Math.round(p).toLocaleString("en-IN")} pts`;
    if (p >= 10000) return `$${(p/1000).toFixed(2)}k`;
    return `$${p.toFixed(2)}`;
  };

  const btc   = prices.BTCUSD;
  const xau   = prices.XAUUSD;
  const eth   = prices.ETHUSD;
  const nifty = prices.NIFTY50;

  // Round level helpers
  const nearestRound = (p, step) => Math.round(p/step)*step;
  const pct = (a, b) => b ? (((a-b)/b)*100).toFixed(2) : "0.00";

  // Build dynamic alerts based on live prices
  const buildAlerts = () => {
    const now = Date.now();
    const IST = (ago) => {
      const d = new Date(now - ago);
      return d.toLocaleString("en-IN",{timeZone:"Asia/Kolkata",
        hour:"2-digit",minute:"2-digit",hour12:false}) + " IST";
    };

    const list = [];

    // 1. Signals from history (last 5 pending/recent)
    const recentSignals = [...history]
      .sort((a,b)=>b.timestamp-a.timestamp)
      .slice(0,3);
    recentSignals.forEach((sig,i)=>{
      const sym = sig.assetId==="NIFTY50"?"₹":"$";
      const entry = sig.entry ? `${sym}${Number(sig.entry).toLocaleString()}` : "";
      const biasEmoji = sig.bias==="BULLISH"?"▲":"▼";
      const natIcon   = sig.nature==="Scalping"?"⚡":sig.nature==="Intraday"?"🕐":"📈";
      list.push({
        id: `sig-${sig.id}`,
        type:"signal",
        asset: sig.asset,
        assetId: sig.assetId,
        severity: sig.confidence>=80?"high":sig.confidence>=65?"medium":"low",
        read: false,
        time: IST(i*4*60*1000),
        msg: `${natIcon} ${biasEmoji} ${sig.bias} — ${sig.setup} ${entry?`at ${entry}`:""} | Conf: ${sig.confidence}% | ${sig.nature}`,
        source: sig.source,
      });
    });

    // 2. BTC price alert vs round levels
    if (btc) {
      const btcRound = nearestRound(btc, 1000);
      const btcDist  = Math.abs(btc - btcRound);
      const btcPct   = (btcDist / btcRound * 100).toFixed(2);
      list.push({
        id:"btc-round",type:"price",asset:"BTC/USD",assetId:"BTCUSD",
        severity: btcDist < btcRound*0.005 ? "high" : "medium",
        read:false, time: IST(5*60*1000),
        msg:`BTC/USD at ${fmtPrice("BTCUSD",btc)} — ${btcDist < btcRound*0.005 ? "testing" : "near"} round level $${btcRound.toLocaleString()} (${btcPct}% away). Watch for breakout/rejection.`,
      });
    }

    // 3. Gold (XAU) price alert
    if (xau) {
      const xauRound = nearestRound(xau, 100);
      const xauDist  = Math.abs(xau - xauRound);
      list.push({
        id:"xau-price",type:"price",asset:"XAU/USD",assetId:"XAUUSD",
        severity: xauDist < xauRound*0.005 ? "high" : "medium",
        read:false, time: IST(12*60*1000),
        msg:`Gold at ${fmtPrice("XAUUSD",xau)} — ${xauDist < xauRound*0.005?"at":"approaching"} key round $${xauRound.toLocaleString()}. Safe-haven demand ${xau>4500?"elevated":"moderate"}.`,
      });
    }

    // 4. ETH alert
    if (eth) {
      const ethRound = nearestRound(eth, 100);
      list.push({
        id:"eth-price",type:"price",asset:"ETH/USD",assetId:"ETHUSD",
        severity:"medium", read:true, time: IST(20*60*1000),
        msg:`ETH/USD at ${fmtPrice("ETHUSD",eth)} — round level $${ethRound.toLocaleString()} ${eth>ethRound?"acting as support":"as resistance"}. Monitor for continuation.`,
      });
    }

    // 5. Nifty 50 alert
    if (nifty) {
      const niftyRound = nearestRound(nifty, 100);
      const niftyDist  = Math.abs(nifty - niftyRound);
      list.push({
        id:"nifty-price",type:"price",asset:"Nifty 50",assetId:"NIFTY50",
        severity: niftyDist < niftyRound*0.003 ? "high" : "medium",
        read:false, time: IST(8*60*1000),
        msg:`Nifty 50 at ${fmtPrice("NIFTY50",nifty)} — ${niftyDist < niftyRound*0.003?"testing":"near"} key level ₹${niftyRound.toLocaleString()}. FII flows & RBI stance key drivers.`,
      });
    }

    // 6. Geo alerts (static but relevant)
    const GEO = [
      {id:"geo-fed",  type:"geo",asset:"ALL",   severity:"high",  read:false, time:IST(35*60*1000), msg:"Fed rate decision watch — markets pricing 87% hold. Volatility spike expected at announcement."},
      {id:"geo-me",   type:"geo",asset:"XAU",   severity:"high",  read:true,  time:IST(55*60*1000), msg:`Middle East tensions elevated — Gold ${xau?fmtPrice("XAUUSD",xau):""} safe-haven bid active. Long Gold bias.`},
      {id:"geo-rbi",  type:"geo",asset:"NIFTY50",severity:"medium",read:true, time:IST(90*60*1000), msg:`RBI policy stance: neutral. FII net buyers this week. ${nifty?`Nifty ${fmtPrice("NIFTY50",nifty)}`:""} range-bound.`},
      {id:"geo-dxy",  type:"geo",asset:"BTC/USD",severity:"medium",read:true, time:IST(120*60*1000),msg:`DXY weakening — risk assets benefiting. ${btc?`BTC ${fmtPrice("BTCUSD",btc)}`:""} correlation 0.84 with DXY inverse.`},
    ];
    list.push(...GEO);

    return list.sort((a,b)=> a.read===b.read ? 0 : a.read?1:-1);
  };

  const [alerts, setAlerts] = useState([]);
  const [filterType, setFilterType] = useState("ALL");

  // Rebuild alerts whenever prices or history change
  useEffect(()=>{ setAlerts(buildAlerts()); }, [prices.BTCUSD, prices.XAUUSD, prices.ETHUSD, prices.NIFTY50, history.length]);

  const filtered = filterType==="ALL" ? alerts : alerts.filter(a=>a.type===filterType);
  const unread   = alerts.filter(a=>!a.read).length;

  const sc={high:"#ef4444",medium:"#f59e0b",low:"#22c55e"};
  const tc={signal:"#a78bfa",geo:"#34d399",price:"#60a5fa",backtest:"#f59e0b"};
  const ti={signal:"📊",geo:"🌍",price:"💰",backtest:"⟳"};

  return (
    <div style={{height:"100%",overflow:"auto"}}>
      <div style={{maxWidth:720,margin:"0 auto",display:"flex",flexDirection:"column",gap:8}}>
        {/* Header */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,
          padding:"10px 14px",display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em"}}>ALERTS & NOTIFICATIONS</div>
          {unread>0&&<span style={{background:"#ef4444",color:"white",fontSize:9,fontWeight:700,
            padding:"2px 7px",borderRadius:10}}>{unread} new</span>}
          {/* Filter pills */}
          <div style={{display:"flex",gap:4,marginLeft:8}}>
            {["ALL","signal","price","geo"].map(f=>(
              <span key={f} onClick={()=>setFilterType(f)}
                style={{fontSize:8,padding:"2px 8px",borderRadius:4,cursor:"pointer",
                  fontFamily:"monospace",fontWeight:600,
                  background:filterType===f?"#1e3a5a":"transparent",
                  color:filterType===f?"#60a5fa":tc[f]||"#94a3b8",
                  border:`0.5px solid ${filterType===f?"#3b82f6":"#1e3a5a"}`}}>
                {f==="ALL"?"ALL":f.toUpperCase()}
              </span>
            ))}
          </div>
          <button onClick={()=>setAlerts(a=>a.map(al=>({...al,read:true})))}
            style={{marginLeft:"auto",fontSize:10,padding:"4px 10px",background:"#1e3a5a",
              border:"none",borderRadius:6,color:"#60a5fa",cursor:"pointer",fontFamily:"monospace"}}>
            Mark all read
          </button>
        </div>

        {/* Alert cards */}
        {filtered.map(a=>(
          <div key={a.id}
            onClick={()=>setAlerts(als=>als.map(al=>al.id===a.id?{...al,read:true}:al))}
            style={{background:a.read?"#0a1628":"#0d1e35",
              border:`0.5px solid ${a.read?"#1e3a5a":sc[a.severity]+"50"}`,
              borderLeft:`3px solid ${a.read?sc[a.severity]+"40":sc[a.severity]}`,
              borderRadius:"0 10px 10px 0",padding:"10px 14px",
              cursor:"pointer",transition:"all 0.15s",opacity:a.read?0.65:1}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                {!a.read&&<div style={{width:6,height:6,borderRadius:"50%",
                  background:sc[a.severity],flexShrink:0,marginTop:1,
                  boxShadow:`0 0 5px ${sc[a.severity]}`}}/>}
                <span style={{fontSize:8,fontWeight:700,color:tc[a.type],
                  background:tc[a.type]+"18",padding:"1px 6px",borderRadius:3,
                  fontFamily:"monospace",letterSpacing:"0.06em"}}>
                  {ti[a.type]} {a.type.toUpperCase()}
                </span>
                <span style={{fontSize:9,color:"#60a5fa",fontWeight:600}}>{a.asset}</span>
                {a.source&&<span style={{fontSize:7,color:"#7c8ea8",background:"#060d17",
                  padding:"1px 4px",borderRadius:3}}>{a.source}</span>}
              </div>
              <span style={{fontSize:8,color:"#7c8ea8",fontFamily:"monospace",flexShrink:0,marginLeft:10}}>
                {a.time}
              </span>
            </div>
            <div style={{fontSize:11,color:a.read?"#94a3b8":"#cbd5e1",lineHeight:1.5,
              fontFamily:"monospace"}}>{a.msg}</div>
          </div>
        ))}

        {filtered.length===0&&(
          <div style={{textAlign:"center",padding:40,color:"#7c8ea8",fontSize:11}}>
            No {filterType!=="ALL"?filterType+" ":""} alerts yet
          </div>
        )}
      </div>
    </div>
  );
}

// ─── KILL ZONE CLOCK ─────────────────────────────────────────────────────────
function KillZoneClock({ expanded=false }) {
  const [now, setNow] = useState(new Date());
  useEffect(()=>{ const t=setInterval(()=>setNow(new Date()),1000); return()=>clearInterval(t); },[]);

  // IST = UTC + 5h 30m
  const istNow   = new Date(now.getTime() + 5.5*60*60*1000);
  const istHours = istNow.getUTCHours();
  const istMins  = istNow.getUTCMinutes();
  const istSecs  = istNow.getUTCSeconds();
  const istStr   = `${String(istHours).padStart(2,"0")}:${String(istMins).padStart(2,"0")}:${String(istSecs).padStart(2,"0")}`;
  const utcH     = now.getUTCHours() + now.getUTCMinutes()/60;

  const sessions = [
    { name:"Sydney",    start:21,   end:6,    color:"#34d399", icon:"🦘", ist:"02:30–11:30" },
    { name:"Tokyo",     start:0,    end:9,    color:"#60a5fa", icon:"⛩",  ist:"05:30–14:30" },
    { name:"NSE India", start:3.75, end:10,   color:"#a78bfa", icon:"🇮🇳", ist:"09:15–15:30" },
    { name:"London",    start:7,    end:16,   color:"#f59e0b", icon:"🎡", ist:"12:30–21:30" },
    { name:"New York",  start:12,   end:21,   color:"#f43f5e", icon:"🗽", ist:"17:30–02:30" },
  ];
  const killZones = [
    { name:"Asian KZ",    start:0,    end:2,   color:"#60a5fa", ist:"05:30–07:30" },
    { name:"NSE Open KZ", start:3.75, end:5,   color:"#a78bfa", ist:"09:15–10:30" },
    { name:"London KZ",   start:7,    end:9.5, color:"#f59e0b", ist:"12:30–15:00" },
    { name:"NY Open KZ",  start:12,   end:14,  color:"#f43f5e", ist:"17:30–19:30" },
    { name:"London Close",start:15,   end:16,  color:"#94a3b8", ist:"20:30–21:30" },
  ];

  const isActive=(s,e)=>{ const h=utcH; return s<e?h>=s&&h<e:h>=s||h<e; };
  const pctElapsed=(s,e)=>{ const dur=(e-s+24)%24||24; let el=utcH-s; if(el<0)el+=24; return Math.min(1,Math.max(0,el/dur)); };
  const minsUntil=(t)=>{ let r=t-utcH; if(r<0)r+=24; return Math.max(0,Math.round(r*60)); };
  const fmtMins=(m)=>m<60?`${m}m`:`${Math.floor(m/60)}h ${m%60}m`;

  const activeSession = sessions.find(s=>isActive(s.start,s.end));
  const activeKZ      = killZones.find(kz=>isActive(kz.start,kz.end));

  const cSize = expanded ? 220 : 160;
  const cx = cSize/2, cy = cSize/2, r = expanded ? 88 : 60;

  const arcPath=(s,e,rad)=>{
    const a1=(s/24)*Math.PI*2-Math.PI/2, a2=(e/24)*Math.PI*2-Math.PI/2;
    const x1=cx+rad*Math.cos(a1), y1=cy+rad*Math.sin(a1);
    const x2=cx+rad*Math.cos(a2), y2=cy+rad*Math.sin(a2);
    const large=((e-s+24)%24)>12?1:0;
    return `M${x1},${y1} A${rad},${rad},0,${large},1,${x2},${y2}`;
  };
  const nowA=((utcH/24)*360-90)*(Math.PI/180);
  const nowX=cx+r*Math.cos(nowA), nowY=cy+r*Math.sin(nowA);

  return (
    <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,
      padding:expanded?16:14,height:"100%",display:"flex",flexDirection:"column",gap:10}}>

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
        <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em"}}>SESSION CLOCK</div>
        <div style={{fontFamily:"monospace",fontSize:expanded?20:13,fontWeight:800,color:"#e2e8f0"}}>
          {istStr} <span style={{fontSize:9,color:"#94a3b8",fontWeight:400}}>IST</span>
        </div>
      </div>

      {/* Active banner */}
      {activeSession&&(
        <div style={{background:activeSession.color+"15",border:`0.5px solid ${activeSession.color}50`,
          borderRadius:8,padding:"6px 10px",display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <span style={{fontSize:14}}>{activeSession.icon}</span>
          <div style={{flex:1}}>
            <div style={{fontSize:10,fontWeight:700,color:activeSession.color}}>{activeSession.name} — OPEN</div>
            <div style={{fontSize:8,color:"#94a3b8",marginTop:1}}>closes in {fmtMins(minsUntil(activeSession.end))} · {activeSession.ist} IST</div>
          </div>
          {activeKZ&&(
            <div style={{background:"#1c1300",border:`0.5px solid ${activeKZ.color}80`,
              borderRadius:5,padding:"2px 8px",textAlign:"center"}}>
              <div style={{fontSize:8,fontWeight:800,color:activeKZ.color}}>⚡ {activeKZ.name}</div>
              <div style={{fontSize:7,color:"#94a3b8"}}>{activeKZ.ist} IST</div>
            </div>
          )}
        </div>
      )}

      {/* Clock face + session list */}
      <div style={{display:"flex",gap:12,flex:1,minHeight:0}}>
        <svg width={cSize} height={cSize} style={{flexShrink:0}}>
          <circle cx={cx} cy={cy} r={r+5} fill="#060d17" stroke="#1e3a5a" strokeWidth="0.5"/>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#0d1e35" strokeWidth={expanded?12:10}/>
          {sessions.map(s=>(
            <path key={s.name} d={arcPath(s.start,s.end,r)}
              fill="none" stroke={s.color}
              strokeWidth={isActive(s.start,s.end)?expanded?12:8:expanded?5:4}
              strokeOpacity={isActive(s.start,s.end)?0.95:0.2} strokeLinecap="round"/>
          ))}
          {killZones.map(kz=>(
            <path key={kz.name} d={arcPath(kz.start,kz.end,r-(expanded?10:6))}
              fill="none" stroke={kz.color+"bb"}
              strokeWidth={isActive(kz.start,kz.end)?expanded?6:5:2}
              strokeOpacity={isActive(kz.start,kz.end)?1:0.25} strokeLinecap="round"/>
          ))}
          {[0,3,6,9,12,15,18,21].map(h=>{
            const a=(h/24)*Math.PI*2-Math.PI/2;
            return <g key={h}>
              <line x1={cx+(r-12)*Math.cos(a)} y1={cy+(r-12)*Math.sin(a)}
                x2={cx+(r+5)*Math.cos(a)} y2={cy+(r+5)*Math.sin(a)} stroke="#1e3a5a" strokeWidth="0.8"/>
              <text x={cx+(r+14)*Math.cos(a)} y={cy+(r+14)*Math.sin(a)+3}
                textAnchor="middle" fontSize="7" fill="#7c8ea8" fontFamily="monospace">{h}</text>
            </g>;
          })}
          <line x1={cx} y1={cy} x2={nowX} y2={nowY} stroke="#ffffff22" strokeWidth="0.8"/>
          <circle cx={nowX} cy={nowY} r={expanded?7:5} fill="#e2e8f0" stroke="#060d17" strokeWidth="1.5"/>
          <circle cx={cx} cy={cy} r={expanded?4:3} fill="#60a5fa"/>
          <text x={cx} y={cy-6} textAnchor="middle" fontSize="7" fill="#94a3b8" fontFamily="monospace">IST</text>
          <text x={cx} y={cy+7} textAnchor="middle" fontSize={expanded?"12":"9"} fill="#94a3b8" fontFamily="monospace" fontWeight="600">
            {String(istHours).padStart(2,"0")}:{String(istMins).padStart(2,"0")}
          </text>
        </svg>

        {/* Sessions + KZ list */}
        <div style={{flex:1,display:"flex",flexDirection:"column",gap:4,overflowY:"auto",minHeight:0}}>
          <div style={{fontSize:8,color:"#7c8ea8",letterSpacing:"0.08em",marginBottom:2}}>SESSIONS (IST time)</div>
          {sessions.map(s=>{
            const active=isActive(s.start,s.end);
            const pct=active?pctElapsed(s.start,s.end)*100:0;
            return (
              <div key={s.name} style={{background:active?"#060d17":"transparent",
                border:`0.5px solid ${active?s.color+"60":"#1e2a3a"}`,borderRadius:6,padding:"5px 8px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:s.color,
                      opacity:active?1:0.2,boxShadow:active?`0 0 5px ${s.color}`:"none",flexShrink:0}}/>
                    <span style={{fontSize:11,fontWeight:active?700:400,color:active?s.color:"#7c8ea8"}}>{s.name} {s.icon}</span>
                  </div>
                  <span style={{fontSize:8,fontFamily:"monospace",color:active?s.color:"#64748b"}}>
                    {active?`closes ${fmtMins(minsUntil(s.end))}`:`opens ${fmtMins(minsUntil(s.start))}`}
                  </span>
                </div>
                <div style={{fontSize:8,color:"#64748b",marginTop:2}}>{s.ist} IST</div>
                {active&&<div style={{height:2,background:"#1e2a3a",borderRadius:1,marginTop:3}}>
                  <div style={{height:2,width:`${pct}%`,background:s.color,borderRadius:1,transition:"width 1s"}}/>
                </div>}
              </div>
            );
          })}
          <div style={{fontSize:8,color:"#7c8ea8",letterSpacing:"0.08em",marginTop:4,marginBottom:2}}>KILL ZONES (IST)</div>
          {killZones.map(kz=>{
            const active=isActive(kz.start,kz.end);
            return (
              <div key={kz.name} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                padding:"3px 8px",borderRadius:5,
                background:active?kz.color+"15":"transparent",
                border:`0.5px solid ${active?kz.color+"60":"#1e2a3a"}`}}>
                <span style={{fontSize:10,color:active?kz.color:"#7c8ea8",fontWeight:active?700:400}}>
                  {active?"⚡ ":""}{kz.name}
                </span>
                <span style={{fontSize:8,color:"#64748b",fontFamily:"monospace"}}>{kz.ist}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RiskCalcPage() {
  const [acctSize,  setAcctSize]  = useState(10000);
  const [riskPct,   setRiskPct]   = useState(1);
  const [entry,     setEntry]     = useState(97000);
  const [sl,        setSl]        = useState(95500);
  const [tp1,       setTp1]       = useState(99500);
  const [tp2,       setTp2]       = useState(101000);
  const [asset,     setAsset]     = useState("BTCUSD");
  const [leverage,  setLeverage]  = useState(1);
  const [dir,       setDir]       = useState("LONG");
  const [scenarios, setScenarios] = useState([]);

  // Money management rules (applied to every live order)
  const [mm,      setMm]      = useState(()=>getMoneyMgt());
  const [mmSaved, setMmSaved] = useState(false);
  const [mt5CapitalMsg, setMt5CapitalMsg] = useState("");
  const saveMm = (next)=>{ setMm(next); setMoneyMgt(next); setMmSaved(true); setTimeout(()=>setMmSaved(false),2500); };

  useEffect(()=>{
    let stop = false;
    if (mm.fetchCapitalFromMT5 === false) {
      setMt5CapitalMsg("");
      return () => { stop = true; };
    }
    setMt5CapitalMsg("Checking MT5 balance...");
    fetchMT5Account().then(acct=>{
      if (stop) return;
      const balance = Number(acct?.balance);
      if (Number.isFinite(balance) && balance > 0) {
        setMm(prev=>{
          if (prev.fetchCapitalFromMT5 === false) return prev;
          const next = { ...prev, capital: balance };
          setMoneyMgt(next);
          return next;
        });
        setMt5CapitalMsg(`Using MT5 balance ${balance.toFixed(2)} ${acct?.currency || "USD"}`);
      } else {
        setMt5CapitalMsg("MT5 balance not available");
      }
    });
    return () => { stop = true; };
  }, [mm.fetchCapitalFromMT5]);

  const riskAmt   = acctSize * riskPct / 100;
  const slPips    = Math.abs(entry - sl);
  const slPct     = (slPips / entry) * 100;
  const posSize   = slPips > 0 ? (riskAmt / slPips) : 0;
  const posVal    = posSize * entry;
  const tp1Pips   = Math.abs(tp1 - entry);
  const tp2Pips   = Math.abs(tp2 - entry);
  const rr1       = slPips > 0 ? tp1Pips / slPips : 0;
  const rr2       = slPips > 0 ? tp2Pips / slPips : 0;
  const reward1   = posSize * tp1Pips;
  const reward2   = posSize * tp2Pips;
  const reqMargin = posVal / leverage;

  // Scenario matrix
  const buildScenarios = () => {
    const sc = [0.5,1,1.5,2,3].map(r => ({
      risk: r,
      riskAmt: acctSize*r/100,
      posSize: slPips>0?(acctSize*r/100)/slPips:0,
      reward1: slPips>0?((acctSize*r/100)/slPips)*tp1Pips:0,
      reward2: slPips>0?((acctSize*r/100)/slPips)*tp2Pips:0,
      newBalWin: acctSize+(slPips>0?((acctSize*r/100)/slPips)*tp1Pips:0),
      newBalLoss: acctSize-(acctSize*r/100),
    }));
    setScenarios(sc);
  };

  const colCard=(label,value,sub,c="#e2e8f0")=>(
    <div style={{background:"#060d17",border:`0.5px solid ${c}20`,borderRadius:8,padding:"10px 12px"}}>
      <div style={{fontSize:8,color:"#94a3b8",marginBottom:3,letterSpacing:"0.06em"}}>{label.toUpperCase()}</div>
      <div style={{fontSize:16,fontWeight:800,color:c,fontFamily:"monospace"}}>{value}</div>
      {sub&&<div style={{fontSize:9,color:"#7c8ea8",marginTop:2}}>{sub}</div>}
    </div>
  );

  const fmtN=(n,d=2)=>isFinite(n)?n.toFixed(d):"—";
  const inp=(val,set,label,step=100)=>(
    <div>
      <div style={{fontSize:8,color:"#94a3b8",marginBottom:3,letterSpacing:"0.06em"}}>{label}</div>
      <input type="number" value={val} step={step}
        onChange={e=>set(parseFloat(e.target.value)||0)}
        style={{width:"100%",background:"#060d17",border:"0.5px solid #1e3a5a",
          borderRadius:6,padding:"6px 8px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}/>
    </div>
  );

  return (
    <div style={{height:"100%",overflow:"auto"}}>
      <div style={{maxWidth:900,margin:"0 auto",display:"flex",flexDirection:"column",gap:10}}>
        {/* Money management rules */}
        <div style={{background:"#0a1628",border:"0.5px solid #3b82f640",borderRadius:12,padding:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em"}}>MONEY MANAGEMENT — APPLIED TO EVERY LIVE ORDER</div>
            {mmSaved&&<span style={{fontSize:10,color:"#22c55e",fontFamily:"monospace"}}>✓ Saved</span>}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12}}>
            <div>
              <div style={{display:"flex",justifyContent:"space-between",gap:8,alignItems:"center",marginBottom:3}}>
                <div style={{fontSize:8,color:"#94a3b8",letterSpacing:"0.06em"}}>CAPITAL ($)</div>
                {mt5CapitalMsg&&<div style={{fontSize:8,color:"#22c55e",textAlign:"right"}}>{mt5CapitalMsg}</div>}
              </div>
              <input type="number" value={mm.capital} step={100} min={0}
                onChange={e=>saveMm({...mm,capital:parseFloat(e.target.value)||0})}
                style={{width:"100%",background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"7px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}/>
            </div>
            <div>
              <div style={{fontSize:8,color:"#94a3b8",marginBottom:3,letterSpacing:"0.06em"}}>LOT SIZE</div>
              <input type="number" value={mm.lotSize} step={0.01} min={0.01}
                onChange={e=>saveMm({...mm,lotSize:parseFloat(e.target.value)||0.01})}
                style={{width:"100%",background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"7px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}/>
            </div>
          </div>

          <div style={{marginTop:10,display:"flex",alignItems:"center",gap:10}}>
            <div onClick={()=>saveMm({...mm,fetchCapitalFromMT5:mm.fetchCapitalFromMT5===false})}
              style={{width:38,height:20,borderRadius:10,background:mm.fetchCapitalFromMT5!==false?"#22c55e":"#1e2a3a",
                border:`0.5px solid ${mm.fetchCapitalFromMT5!==false?"#22c55e":"#1e3a5a"}`,position:"relative",cursor:"pointer",flexShrink:0}}>
              <div style={{width:14,height:14,borderRadius:"50%",background:mm.fetchCapitalFromMT5!==false?"white":"#94a3b8",position:"absolute",top:3,left:mm.fetchCapitalFromMT5!==false?21:3,transition:"left 0.2s"}}/>
            </div>
            <div>
              <div style={{fontSize:12,color:"#e2e8f0"}}>Use MT5 balance as capital</div>
              <div style={{fontSize:9,color:"#7c8ea8"}}>When the bridge is running, this refreshes capital from the terminal balance.</div>
            </div>
          </div>

          {/* Optional fixed SL */}
          <div style={{marginTop:12,display:"flex",alignItems:"center",gap:10}}>
            <div onClick={()=>saveMm({...mm,useSL:!mm.useSL})}
              style={{width:38,height:20,borderRadius:10,background:mm.useSL?"#3b82f6":"#1e2a3a",
                border:`0.5px solid ${mm.useSL?"#60a5fa":"#1e3a5a"}`,position:"relative",cursor:"pointer",flexShrink:0}}>
              <div style={{width:14,height:14,borderRadius:"50%",background:mm.useSL?"white":"#94a3b8",position:"absolute",top:3,left:mm.useSL?21:3,transition:"left 0.2s"}}/>
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:12,color:"#e2e8f0"}}>Use fixed Stop Loss</div>
              <div style={{fontSize:9,color:"#7c8ea8"}}>If on, every order uses this SL distance instead of the signal&apos;s.</div>
            </div>
            <input type="number" value={mm.slPoints} step={1} min={0} disabled={!mm.useSL}
              onChange={e=>saveMm({...mm,slPoints:parseFloat(e.target.value)||0})}
              style={{width:120,background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"7px 10px",
                color:mm.useSL?"#e2e8f0":"#475569",fontSize:12,fontFamily:"monospace",textAlign:"right"}}/>
            <span style={{fontSize:10,color:"#94a3b8"}}>pts</span>
          </div>

          {/* Reward : Risk */}
          <div style={{marginTop:12}}>
            <div style={{fontSize:8,color:"#94a3b8",marginBottom:5,letterSpacing:"0.06em"}}>REWARD : RISK</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
              {[{l:"1:1",v:1},{l:"1:1.5",v:1.5},{l:"1:2",v:2},{l:"1:2.5",v:2.5},{l:"Trail →",v:"trail"}].map(o=>{
                const sel=mm.rr===o.v;
                const isTrail=o.v==="trail";
                return (
                  <span key={String(o.v)} onClick={()=>saveMm({...mm,rr:o.v})}
                    style={{padding:"6px 16px",borderRadius:6,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace",
                      background:sel?(isTrail?"#052e16":"#1e3a5a"):"#060d17",color:sel?(isTrail?"#22c55e":"#60a5fa"):"#94a3b8",
                      border:`0.5px solid ${sel?(isTrail?"#22c55e":"#3b82f6"):"#1e3a5a"}`}}>{o.l}</span>
                );
              })}
              {mm.rr==="trail"&&(
                <span style={{display:"flex",alignItems:"center",gap:6,marginLeft:4}}>
                  <span style={{fontSize:10,color:"#94a3b8"}}>run until 1:</span>
                  <input type="number" value={mm.trailMaxRR} min={2} max={50} step={1}
                    onChange={e=>saveMm({...mm,trailMaxRR:Math.min(50,Math.max(2,parseFloat(e.target.value)||10))})}
                    style={{width:70,background:"#060d17",border:"0.5px solid #22c55e40",borderRadius:6,padding:"5px 8px",color:"#e2e8f0",fontSize:11,fontFamily:"monospace",textAlign:"right"}}/>
                  <span style={{fontSize:9,color:"#7c8ea8"}}>(max 50)</span>
                </span>
              )}
            </div>
            {mm.rr==="trail"&&(
              <div style={{fontSize:9,color:"#22c55e",marginTop:6,lineHeight:1.5}}>
                Trail mode: stop trails after 1:1 and the trade runs until it reaches 1:{mm.trailMaxRR} (or the trailing stop is hit). Trailing is forced on.
              </div>
            )}
          </div>

          {/* Step trailing SL */}
          <div style={{marginTop:14,display:"flex",alignItems:"center",gap:10}}>
            <div onClick={()=>saveMm({...mm,stepTrailEnabled:!mm.stepTrailEnabled,trailAfter1R:!mm.stepTrailEnabled})}
              style={{width:38,height:20,borderRadius:10,background:mm.stepTrailEnabled!==false?"#22c55e":"#1e2a3a",
                border:`0.5px solid ${mm.stepTrailEnabled!==false?"#22c55e":"#1e3a5a"}`,position:"relative",cursor:"pointer",flexShrink:0}}>
              <div style={{width:14,height:14,borderRadius:"50%",background:mm.stepTrailEnabled!==false?"white":"#94a3b8",position:"absolute",top:3,left:mm.stepTrailEnabled!==false?21:3,transition:"left 0.2s"}}/>
            </div>
            <div>
              <div style={{fontSize:12,color:"#e2e8f0"}}>Step trailing stop</div>
              <div style={{fontSize:9,color:"#7c8ea8"}}>Move SL to breakeven at 1:1, then trail in fixed point steps. The bridge never moves SL backward.</div>
            </div>
          </div>

          {mm.stepTrailEnabled!==false&&(
            <div style={{marginTop:10,display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
              <div>
                <div style={{fontSize:8,color:"#94a3b8",marginBottom:3,letterSpacing:"0.06em"}}>BE AT</div>
                <select value={mm.beTriggerR || 1} onChange={e=>saveMm({...mm,beTriggerR:parseFloat(e.target.value)||1})}
                  style={{width:"100%",background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"7px 8px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}>
                  <option value={1}>1:1</option>
                </select>
              </div>
              <div>
                <div style={{fontSize:8,color:"#94a3b8",marginBottom:3,letterSpacing:"0.06em"}}>START TSL</div>
                <select value={mm.trailStartR || 1} onChange={e=>saveMm({...mm,trailStartR:parseFloat(e.target.value)||1})}
                  style={{width:"100%",background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"7px 8px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}>
                  <option value={1}>After 1:1</option>
                  <option value={1.5}>After 1:1.5</option>
                </select>
              </div>
              <div>
                <div style={{fontSize:8,color:"#94a3b8",marginBottom:3,letterSpacing:"0.06em"}}>STEP</div>
                <input type="number" value={mm.trailStepPoints ?? 500} step={50} min={1}
                  onChange={e=>saveMm({...mm,trailStepPoints:parseFloat(e.target.value)||500})}
                  style={{width:"100%",background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"7px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}/>
              </div>
              <div>
                <div style={{fontSize:8,color:"#94a3b8",marginBottom:3,letterSpacing:"0.06em"}}>TRAIL DISTANCE</div>
                <input type="number" value={mm.trailDistancePoints ?? 500} step={50} min={1}
                  onChange={e=>saveMm({...mm,trailDistancePoints:parseFloat(e.target.value)||500})}
                  style={{width:"100%",background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"7px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}/>
              </div>
              <div style={{gridColumn:"1 / -1",fontSize:9,color:"#7c8ea8",lineHeight:1.5}}>
                On your gold symbol, 500 points is about a $5 price move when 100 points equals $1.
              </div>
            </div>
          )}

          <div style={{marginTop:12,display:"flex",alignItems:"center",gap:10}}>
            <div onClick={()=>saveMm({...mm,closeOppositeFirst:mm.closeOppositeFirst===false})}
              style={{width:38,height:20,borderRadius:10,background:mm.closeOppositeFirst!==false?"#3b82f6":"#1e2a3a",
                border:`0.5px solid ${mm.closeOppositeFirst!==false?"#60a5fa":"#1e3a5a"}`,position:"relative",cursor:"pointer",flexShrink:0}}>
              <div style={{width:14,height:14,borderRadius:"50%",background:mm.closeOppositeFirst!==false?"white":"#94a3b8",position:"absolute",top:3,left:mm.closeOppositeFirst!==false?21:3,transition:"left 0.2s"}}/>
            </div>
            <div>
              <div style={{fontSize:12,color:"#e2e8f0"}}>Close opposite AlphaEdge trade first</div>
              <div style={{fontSize:9,color:"#7c8ea8"}}>If a buy triggers, the bridge closes running AlphaEdge sell positions on that symbol before opening the buy, and vice versa.</div>
            </div>
          </div>
          <div style={{fontSize:8,color:"#7c8ea8",marginTop:12,lineHeight:1.5}}>
            These rules are sent with every order: fixed lot size, optional fixed SL, take-profit from the chosen R:R, step trailing, and opposite-side protection managed by the MT5 bridge.
          </div>
        </div>

        {/* Inputs */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:12}}>POSITION SIZING CALCULATOR</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:10}}>
            <div>
              <div style={{fontSize:8,color:"#94a3b8",marginBottom:3}}>ASSET</div>
              <select value={asset} onChange={e=>setAsset(e.target.value)}
                style={{width:"100%",background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"6px 8px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}>
                {ASSETS.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </div>
            <div>
              <div style={{fontSize:8,color:"#94a3b8",marginBottom:3}}>DIRECTION</div>
              <div style={{display:"flex",gap:4}}>
                {["LONG","SHORT"].map(d=>(
                  <span key={d} onClick={()=>setDir(d)}
                    style={{flex:1,textAlign:"center",padding:"6px",borderRadius:6,cursor:"pointer",fontSize:11,fontFamily:"monospace",fontWeight:700,
                      background:dir===d?(d==="LONG"?"#052e16":"#1a0000"):"#060d17",
                      color:dir===d?(d==="LONG"?"#22c55e":"#ef4444"):"#94a3b8",
                      border:`0.5px solid ${dir===d?(d==="LONG"?"#22c55e40":"#ef444440"):"#1e3a5a"}`}}>
                    {d==="LONG"?"▲":"▼"} {d}
                  </span>
                ))}
              </div>
            </div>
            {inp(acctSize,setAcctSize,"Account Size ($)",1000)}
            {inp(riskPct,setRiskPct,"Risk % per Trade",0.25)}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
            {inp(entry,setEntry,"Entry Price",10)}
            {inp(sl,setSl,"Stop Loss",10)}
            {inp(tp1,setTp1,"Take Profit 1",10)}
            {inp(tp2,setTp2,"Take Profit 2",10)}
            {inp(leverage,setLeverage,"Leverage (x)",1)}
          </div>
        </div>

        {/* Results */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8}}>
          {colCard("Risk Amount",`$${fmtN(riskAmt,0)}`,`${riskPct}% of account`,"#ef4444")}
          {colCard("Position Size",fmtN(posSize,4),`$${fmtN(posVal,0)} notional`,"#60a5fa")}
          {colCard("SL Distance",`${fmtN(slPips,0)} pts`,`${fmtN(slPct,2)}% from entry`,"#ef4444")}
          {colCard("Reward TP1",`$${fmtN(reward1,0)}`,`RR 1:${fmtN(rr1,2)}`,"#22c55e")}
          {colCard("Reward TP2",`$${fmtN(reward2,0)}`,`RR 1:${fmtN(rr2,2)}`,"#34d399")}
          {colCard("Margin Req",`$${fmtN(reqMargin,0)}`,`${leverage}x leverage`,"#a78bfa")}
        </div>

        {/* Visual RR bar */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:10}}>RISK / REWARD VISUALISATION</div>
          <div style={{position:"relative",height:56}}>
            {/* Price line */}
            <div style={{position:"absolute",top:26,left:0,right:0,height:2,background:"#1e2a3a",borderRadius:1}}/>
            {/* Entry */}
            <div style={{position:"absolute",top:14,left:"50%",transform:"translateX(-50%)",textAlign:"center"}}>
              <div style={{width:2,height:28,background:"#e2e8f0",margin:"0 auto"}}/>
              <div style={{fontSize:8,color:"#e2e8f0",marginTop:2,fontFamily:"monospace"}}>Entry</div>
            </div>
            {/* SL */}
            <div style={{position:"absolute",top:14,left:dir==="LONG"?"15%":"85%",transform:"translateX(-50%)",textAlign:"center"}}>
              <div style={{width:2,height:28,background:"#ef4444",margin:"0 auto"}}/>
              <div style={{fontSize:8,color:"#ef4444",marginTop:2,fontFamily:"monospace"}}>SL</div>
            </div>
            {/* TP1 */}
            <div style={{position:"absolute",top:14,left:dir==="LONG"?"70%":"30%",transform:"translateX(-50%)",textAlign:"center"}}>
              <div style={{width:2,height:28,background:"#22c55e",margin:"0 auto"}}/>
              <div style={{fontSize:8,color:"#22c55e",marginTop:2,fontFamily:"monospace"}}>TP1</div>
            </div>
            {/* TP2 */}
            <div style={{position:"absolute",top:14,left:dir==="LONG"?"88%":"12%",transform:"translateX(-50%)",textAlign:"center"}}>
              <div style={{width:2,height:28,background:"#34d399",margin:"0 auto"}}/>
              <div style={{fontSize:8,color:"#34d399",marginTop:2,fontFamily:"monospace"}}>TP2</div>
            </div>
            {/* Risk zone */}
            <div style={{position:"absolute",top:20,left:dir==="LONG"?"15%":"50%",width:dir==="LONG"?"35%":"35%",height:12,
              background:"rgba(239,68,68,0.15)",border:"0.5px solid rgba(239,68,68,0.3)",borderRadius:2}}/>
            {/* Reward zone */}
            <div style={{position:"absolute",top:20,left:dir==="LONG"?"50%":"12%",width:"38%",height:12,
              background:"rgba(34,197,94,0.12)",border:"0.5px solid rgba(34,197,94,0.3)",borderRadius:2}}/>
          </div>
          <div style={{display:"flex",justifyContent:"center",gap:20,marginTop:4}}>
            <span style={{fontSize:9,color:"#ef4444"}}>◀ Risk: ${fmtN(riskAmt,0)}</span>
            <span style={{fontSize:10,color:"#60a5fa",fontWeight:700}}>Entry: ${fmtN(entry,0)}</span>
            <span style={{fontSize:9,color:"#22c55e"}}>Reward TP1: ${fmtN(reward1,0)} ▶</span>
          </div>
        </div>

        {/* Scenario matrix */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em"}}>RISK SCENARIO MATRIX</div>
            <button onClick={buildScenarios}
              style={{fontSize:9,padding:"4px 12px",background:"#1e3a5a",border:"0.5px solid #3b82f640",
                borderRadius:6,color:"#60a5fa",cursor:"pointer",fontFamily:"monospace"}}>
              Generate Scenarios
            </button>
          </div>
          {scenarios.length>0&&(
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:"monospace"}}>
              <thead>
                <tr>{["Risk %","Risk $","Pos Size","Reward TP1","Reward TP2","Bal if Win","Bal if Loss"].map(h=>(
                  <th key={h} style={{textAlign:"left",padding:"5px 8px",fontSize:8,color:"#94a3b8",
                    borderBottom:"0.5px solid #1e3a5a",letterSpacing:"0.05em"}}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {scenarios.map((sc,i)=>(
                  <tr key={i} style={{borderBottom:"0.5px solid #0d1b2a",
                    background:sc.risk===riskPct?"#111e30":"transparent"}}>
                    <td style={{padding:"6px 8px",color:sc.risk===riskPct?"#60a5fa":"#94a3b8",fontWeight:sc.risk===riskPct?700:400}}>{sc.risk}%</td>
                    <td style={{padding:"6px 8px",color:"#ef4444"}}>-${fmtN(sc.riskAmt,0)}</td>
                    <td style={{padding:"6px 8px",color:"#e2e8f0"}}>{fmtN(sc.posSize,4)}</td>
                    <td style={{padding:"6px 8px",color:"#22c55e"}}>+${fmtN(sc.reward1,0)}</td>
                    <td style={{padding:"6px 8px",color:"#34d399"}}>+${fmtN(sc.reward2,0)}</td>
                    <td style={{padding:"6px 8px",color:"#22c55e"}}>${fmtN(sc.newBalWin,0)}</td>
                    <td style={{padding:"6px 8px",color:"#ef4444"}}>${fmtN(sc.newBalLoss,0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {scenarios.length===0&&(
            <div style={{textAlign:"center",padding:"20px",color:"#7c8ea8",fontSize:11}}>
              Click "Generate Scenarios" to see risk comparison matrix
            </div>
          )}
        </div>

        {/* Kelly Criterion */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:10}}>KELLY CRITERION — OPTIMAL POSITION SIZING</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
            {[
              {wr:0.65,label:"Conservative (65% WR)"},
              {wr:0.68,label:"Current System (68% WR)"},
              {wr:0.72,label:"Optimistic (72% WR)"},
            ].map(({wr,label})=>{
              const kelly=wr-(1-wr)/rr1;
              const halfKelly=kelly/2;
              return (
                <div key={label} style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:8,padding:"10px 12px"}}>
                  <div style={{fontSize:9,color:"#94a3b8",marginBottom:6}}>{label}</div>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <div>
                      <div style={{fontSize:8,color:"#7c8ea8"}}>Full Kelly</div>
                      <div style={{fontSize:14,fontWeight:700,color:kelly>0?"#22c55e":"#ef4444",fontFamily:"monospace"}}>{(kelly*100).toFixed(1)}%</div>
                    </div>
                    <div>
                      <div style={{fontSize:8,color:"#7c8ea8"}}>Half Kelly ✓</div>
                      <div style={{fontSize:14,fontWeight:700,color:"#60a5fa",fontFamily:"monospace"}}>{(halfKelly*100).toFixed(1)}%</div>
                    </div>
                    <div>
                      <div style={{fontSize:8,color:"#7c8ea8"}}>$</div>
                      <div style={{fontSize:14,fontWeight:700,color:"#60a5fa",fontFamily:"monospace"}}>${(acctSize*halfKelly).toFixed(0)}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{marginTop:8,fontSize:10,color:"#7c8ea8",lineHeight:1.6}}>
            ⚑ Half-Kelly is recommended for live trading — reduces variance while capturing 75% of Kelly growth rate.
            Current 1% risk is {rr1>0?(1/rr1*100).toFixed(1):"-"}% of full Kelly at {fmtN(rr1,2)} RR.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── ECONOMIC CALENDAR PAGE ───────────────────────────────────────────────────
// Seed / offline-fallback economic calendar. Shown only until a live fetch
// succeeds (or if every source is unreachable). Real events come from
// fetchEconEvents(). NOTE: these dates are fixed and will read as "past" once
// the real week rolls over — that's expected; live data replaces them on load.
const ECON_EVENTS_FALLBACK = [
  {id:1, datetime:"2026-05-16T13:30",title:"US CPI m/m",              currency:"USD",impact:"high",  forecast:"0.3%",  previous:"0.4%",  actual:null},
  {id:2, datetime:"2026-05-16T14:00",title:"FOMC Meeting Minutes",    currency:"USD",impact:"high",  forecast:"—",     previous:"—",     actual:null},
  {id:3, datetime:"2026-05-16T09:15",title:"India WPI Inflation",     currency:"INR",impact:"medium",forecast:"2.4%",  previous:"2.1%",  actual:null},
  {id:4, datetime:"2026-05-17T07:00",title:"UK CPI y/y",              currency:"GBP",impact:"high",  forecast:"3.1%",  previous:"3.2%",  actual:null},
  {id:5, datetime:"2026-05-17T09:00",title:"ECB Economic Bulletin",   currency:"EUR",impact:"medium",forecast:"—",     previous:"—",     actual:null},
  {id:6, datetime:"2026-05-17T13:30",title:"US Retail Sales m/m",     currency:"USD",impact:"high",  forecast:"0.4%",  previous:"0.7%",  actual:null},
  {id:7, datetime:"2026-05-18T02:00",title:"China GDP q/q",           currency:"CNY",impact:"high",  forecast:"1.4%",  previous:"1.5%",  actual:null},
  {id:8, datetime:"2026-05-18T07:45",title:"ECB Interest Rate",       currency:"EUR",impact:"high",  forecast:"3.15%", previous:"3.4%",  actual:null},
  {id:9, datetime:"2026-05-19T04:00",title:"RBI Monetary Policy",     currency:"INR",impact:"high",  forecast:"6.25%", previous:"6.50%", actual:null},
  {id:10,datetime:"2026-05-19T09:15",title:"Nifty 50 Derivatives Expiry",currency:"INR",impact:"high",forecast:"—",   previous:"—",     actual:null},
  {id:11,datetime:"2026-05-19T13:30",title:"US Initial Jobless Claims",currency:"USD",impact:"medium",forecast:"215K",previous:"212K",  actual:null},
  {id:12,datetime:"2026-05-20T03:30",title:"India CPI y/y",           currency:"INR",impact:"high",  forecast:"4.2%",  previous:"4.6%",  actual:null},
  {id:13,datetime:"2026-05-20T09:15",title:"India Industrial Production",currency:"INR",impact:"medium",forecast:"5.1%",previous:"4.8%",actual:null},
  {id:14,datetime:"2026-05-20T13:30",title:"US Nonfarm Payrolls",     currency:"USD",impact:"high",  forecast:"185K",  previous:"177K",  actual:null},
  {id:15,datetime:"2026-05-20T13:30",title:"US Unemployment Rate",    currency:"USD",impact:"high",  forecast:"4.0%",  previous:"4.1%",  actual:null},
  {id:16,datetime:"2026-05-21T09:15",title:"India Trade Balance",     currency:"INR",impact:"medium",forecast:"-$18B", previous:"-$20B", actual:null},
  {id:17,datetime:"2026-05-21T09:30",title:"Bank of England Speech",  currency:"GBP",impact:"medium",forecast:"—",     previous:"—",     actual:null},
  {id:18,datetime:"2026-05-22T04:00",title:"India GDP Growth Rate",   currency:"INR",impact:"high",  forecast:"7.2%",  previous:"8.4%",  actual:null},
];

const ASSET_IMPACT={
  USD:["BTCUSD","XAUUSD"],
  EUR:["XAUUSD"],
  GBP:["XAUUSD"],
  CNY:["BTCUSD","XAUUSD"],
  INR:["NIFTY50"],
};

// Live economic-calendar cache, populated by fetchEconEvents(). Module scope so
// the value survives Calendar-page unmount/remount within a session.
let LIVE_ECON_EVENTS = null;
function getEconEvents() {
  return (LIVE_ECON_EVENTS && LIVE_ECON_EVENTS.length) ? LIVE_ECON_EVENTS : ECON_EVENTS_FALLBACK;
}

// ForexFactory's free weekly calendar export (JSON, no API key) — the current
// trading week (Sun–Sat), refreshed by the source as actuals print.
const ECON_CALENDAR_FEEDS = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
];

// Fetch the live economic calendar and normalise it into the app's event shape.
// Returns an array on success (and updates the module cache), or null if every
// source failed — callers then keep showing the last cache / static fallback.
async function fetchEconEvents() {
  const all = [];
  for (const feed of ECON_CALENDAR_FEEDS) {
    for (const proxy of CORS_PROXIES) {
      try {
        const r = await fetch(proxy(feed), { signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const arr = await r.json();
        if (!Array.isArray(arr) || !arr.length) continue;
        arr.forEach((it, i) => {
          if (!it?.date || !it?.title) return;
          const imp = String(it.impact || "").toLowerCase();
          all.push({
            id:       `${feed.includes("next") ? "n" : "t"}${i}`,
            datetime: it.date,                       // ISO w/ offset — Date parses correctly
            title:    it.title,
            currency: it.country || "",              // FF "country" is already a currency code
            impact:   imp === "high" ? "high" : imp === "medium" ? "medium" : "low",
            forecast: it.forecast || "",
            previous: it.previous || "",
            actual:   it.actual || null,
          });
        });
        break;   // this feed succeeded — move to the next feed
      } catch { /* try next proxy */ }
    }
  }
  if (!all.length) return null;
  all.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  LIVE_ECON_EVENTS = all;
  return all;
}

function CalendarPage() {
  const [filterImpact,setFilterImpact]=useState("ALL");
  const [filterCurrency,setFilterCurrency]=useState("ALL");
  const [selectedId,setSelectedId]=useState(null);
  const [events,setEvents]=useState(()=>getEconEvents());
  const [live,setLive]=useState(!!LIVE_ECON_EVENTS);
  const now=new Date();

  // Load the live calendar on mount and re-poll every 15 min (actuals fill in
  // through the day). Falls back to the seed list if every source is unreachable.
  useEffect(()=>{
    let alive=true;
    const load=async()=>{
      const data=await fetchEconEvents();
      if(alive&&data&&data.length){ setEvents(data); setLive(true); }
    };
    load();
    const poll=setInterval(load,15*60*1000);
    return ()=>{ alive=false; clearInterval(poll); };
  },[]);

  const filtered=events.filter(e=>{
    if(filterImpact!=="ALL"&&e.impact!==filterImpact) return false;
    if(filterCurrency!=="ALL"&&e.currency!==filterCurrency) return false;
    return true;
  });

  const grouped=filtered.reduce((acc,ev)=>{
    const day=ev.datetime.split("T")[0];
    acc[day]=[...(acc[day]||[]),ev];
    return acc;
  },{});

  const impactColor={high:"#ef4444",medium:"#f59e0b",low:"#22c55e"};
  const currencyColor={USD:"#22c55e",EUR:"#60a5fa",GBP:"#f59e0b",CNY:"#f43f5e",INR:"#a78bfa"};
  const fmtTime=(dt)=>new Date(dt).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Kolkata"});
  const fmtDay=(d)=>new Date(d+"T05:30:00").toLocaleDateString("en-IN",{weekday:"short",month:"short",day:"numeric",timeZone:"Asia/Kolkata"});
  const isPast=(dt)=>new Date(dt)<now;
  const isNear=(dt)=>{ const diff=(new Date(dt)-now)/60000; return diff>0&&diff<120; };

  return (
    <div style={{height:"100%",overflow:"auto"}}>
      <div style={{maxWidth:900,margin:"0 auto",display:"flex",flexDirection:"column",gap:10}}>
        {/* Header */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14,display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em"}}>ECONOMIC CALENDAR</div>
          <div style={{display:"flex",gap:3}}>
            {["ALL","high","medium","low"].map(v=>(
              <span key={v} onClick={()=>setFilterImpact(v)}
                style={{fontSize:9,padding:"3px 8px",borderRadius:5,cursor:"pointer",fontFamily:"monospace",
                  background:filterImpact===v?"#1e3a5a":"#060d17",
                  color:filterImpact===v?"#60a5fa":impactColor[v]||"#94a3b8",
                  border:`0.5px solid ${filterImpact===v?"#3b82f6":"#1e3a5a"}`}}>
                {v==="ALL"?"All Impact":v.charAt(0).toUpperCase()+v.slice(1)}
              </span>
            ))}
          </div>
          <div style={{display:"flex",gap:3}}>
            {["ALL","USD","EUR","GBP","CNY","INR"].map(v=>(
              <span key={v} onClick={()=>setFilterCurrency(v)}
                style={{fontSize:9,padding:"3px 8px",borderRadius:5,cursor:"pointer",fontFamily:"monospace",
                  background:filterCurrency===v?"#1e3a5a":"#060d17",
                  color:filterCurrency===v?"#60a5fa":currencyColor[v]||"#94a3b8",
                  border:`0.5px solid ${filterCurrency===v?"#3b82f6":"#1e3a5a"}`}}>
                {v}
              </span>
            ))}
          </div>
          <div style={{marginLeft:"auto",fontSize:9,color:"#7c8ea8",display:"flex",alignItems:"center",gap:6}}>
            <span style={{width:6,height:6,borderRadius:"50%",background:live?"#22c55e":"#f59e0b",
              boxShadow:live?"0 0 5px #22c55e":"none"}}/>
            <span>{live?"LIVE · ForexFactory":"cached"} · {filtered.length} events</span>
          </div>
        </div>

        {/* High impact summary */}
        <div style={{background:"#0a1628",border:"0.5px solid #ef444430",borderRadius:10,padding:"10px 14px"}}>
          <div style={{fontSize:9,color:"#ef4444",letterSpacing:"0.08em",marginBottom:6}}>⚡ HIGH IMPACT THIS WEEK — ASSETS AT RISK</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {events.filter(e=>e.impact==="high"&&new Date(e.datetime)>=now).map(e=>(
              <div key={e.id} style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"4px 10px"}}>
                <span style={{fontSize:9,color:currencyColor[e.currency]||"#e2e8f0",fontFamily:"monospace",fontWeight:700}}>{e.currency}</span>
                <span style={{fontSize:9,color:"#64748b",marginLeft:4}}>{e.title}</span>
                <span style={{fontSize:8,color:"#7c8ea8",marginLeft:6}}>{fmtTime(e.datetime)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Events by day */}
        {Object.entries(grouped).map(([day,events])=>(
          <div key={day}>
            <div style={{fontSize:9,color:"#7c8ea8",letterSpacing:"0.1em",marginBottom:6,paddingLeft:2}}>
              ── {fmtDay(day).toUpperCase()}
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {events.map(ev=>{
                const near=isNear(ev.datetime);
                const past=isPast(ev.datetime);
                const ic=impactColor[ev.impact];
                const cc=currencyColor[ev.currency]||"#e2e8f0";
                const affected=ASSET_IMPACT[ev.currency]||[];
                return (
                  <div key={ev.id} onClick={()=>setSelectedId(s=>s===ev.id?null:ev.id)}
                    style={{background:near?"#0d1e2a":past?"#060d17":"#0a1628",
                      border:`0.5px solid ${near?ic+"60":"#1e3a5a"}`,
                      borderLeft:`3px solid ${past?"#1e3a5a":ic}`,
                      borderRadius:"0 10px 10px 0",padding:"10px 14px",cursor:"pointer",
                      opacity:past?0.55:1,transition:"all 0.15s"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                      <span style={{fontSize:10,fontFamily:"monospace",color:"#7c8ea8",minWidth:42}}>{fmtTime(ev.datetime)}</span>
                      {/* Impact dots */}
                      <div style={{display:"flex",gap:2}}>
                        {[0,1,2].map(i=>(
                          <div key={i} style={{width:6,height:6,borderRadius:"50%",
                            background:i<(ev.impact==="high"?3:ev.impact==="medium"?2:1)?ic:"#1e2a3a"}}/>
                        ))}
                      </div>
                      <span style={{fontSize:9,color:cc,fontFamily:"monospace",fontWeight:700,minWidth:28}}>{ev.currency}</span>
                      <span style={{fontSize:12,color:near?"#e2e8f0":past?"#94a3b8":"#94a3b8",fontWeight:near?700:400,flex:1}}>{ev.title}</span>
                      {near&&<span style={{fontSize:8,color:"#f59e0b",background:"#1c1300",padding:"2px 7px",borderRadius:4,fontFamily:"monospace",border:"0.5px solid #f59e0b40",animation:"pulse 1s infinite"}}>SOON</span>}
                      {past&&<span style={{fontSize:8,color:"#7c8ea8"}}>RELEASED</span>}
                      <div style={{display:"flex",gap:6,fontSize:9,fontFamily:"monospace"}}>
                        <span style={{color:"#94a3b8"}}>F: {ev.forecast||"—"}</span>
                        <span style={{color:"#94a3b8"}}>P: {ev.previous||"—"}</span>
                        {ev.actual&&<span style={{color:"#22c55e",fontWeight:700}}>A: {ev.actual}</span>}
                      </div>
                    </div>
                    {selectedId===ev.id&&(
                      <div style={{marginTop:10,paddingTop:10,borderTop:"0.5px solid #1e3a5a"}}>
                        <div style={{fontSize:9,color:"#94a3b8",marginBottom:6}}>AFFECTED ASSETS</div>
                        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                          {affected.length>0
                            ? affected.map(a=><span key={a} style={{fontSize:9,color:"#60a5fa",background:"#111e30",padding:"2px 8px",borderRadius:4,fontFamily:"monospace"}}>{ASSETS.find(x=>x.id===a)?.label||a}</span>)
                            : <span style={{fontSize:10,color:"#7c8ea8"}}>Monitor all majors</span>}
                        </div>
                        <div style={{marginTop:8,fontSize:10,color:"#94a3b8",lineHeight:1.6}}>
                          <strong style={{color:"#94a3b8"}}>Trading note:</strong>{" "}
                          {ev.impact==="high"
                            ? "Avoid new entries 15min before release. Widen stops or reduce position size. ICT traders look for stop hunts immediately after print."
                            : ev.impact==="medium"
                            ? "Monitor price reaction. Wait for 1-2 candles to close before entering. FVG may form during spike."
                            : "Low volatility expected. Proceed with normal strategy parameters."}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}`}</style>
    </div>
  );
}

// ─── SETTINGS PAGE ────────────────────────────────────────────────────────────
// ─── SETTINGS STORAGE HELPERS ────────────────────────────────────────────────
const SETTINGS_KEY = "alphaedge_settings";

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function persistSettings(data) {
  try {
    const existing = loadSettings() || {};
    const merged = { ...existing, ...data };
    // Deep-merge broker so fields set elsewhere — execMode (the live/demo/paper
    // master switch from the Execution page) and the mt5 sub-configs — are NOT
    // wiped when the Settings page saves its partial broker state. Without this,
    // saving Settings reset the app to Paper on the next restart.
    merged.broker = {
      ...(existing.broker || {}),
      ...(data.broker || {}),
      mt5: { ...((existing.broker || {}).mt5 || {}), ...((data.broker || {}).mt5 || {}) },
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  } catch {}
}

function SettingsPage() {
  // Load persisted settings on first render
  const saved0 = loadSettings() || {};

  const [apiKeys, setApiKeys] = useState({
    deepseek:     getDeepSeekKey(),
    dhan:         getDhanToken(),
    dhanClientId: getDhanClientId(),
    binance:      saved0.apiKeys?.binance      || "",
    alpaca:       saved0.apiKeys?.alpaca       || "",
    oanda:        saved0.apiKeys?.oanda        || "",
    alphavantage: saved0.apiKeys?.alphavantage || "",
  });
  const [aiProvider, setAIProviderState] = useState(
    (saved0.aiProvider === "anthropic" ? "deepseek" : saved0.aiProvider) || getAIProvider() || "groq"
  );
  const [geminiKey,      setGeminiKeyState]      = useState(getGeminiKey());
  const [groqKey,        setGroqKeyState]        = useState(getGroqKey());
  const [openRouterKey,  setOpenRouterKeyState]  = useState(getOpenRouterKey());
  const [tgToken,  setTgTokenState]  = useState(getTgToken());
  const [tgChatId, setTgChatIdState] = useState(getTgChatId());
  const [tgTestStatus, setTgTestStatus] = useState(null);
  const [tgTestMsg,    setTgTestMsg]    = useState("");
  const [keyStatus,  setKeyStatus]   = useState(null);
  const [dhanStatus, setDhanStatus]  = useState(null);

  // Index lot sizes (live from Dhan scrip master).
  const [lotState, setLotState] = useState({
    lots: getStoredLots(), updated: getLotsUpdatedAt(), busy: false, msg: "",
  });
  const updateLots = async () => {
    setLotState(s => ({ ...s, busy: true, msg: "Fetching from Dhan…" }));
    const r = await refreshLotSizes();
    if (r.ok) setLotState({ lots: r.lots, updated: r.updated || new Date().toISOString(), busy: false, msg: `✓ Updated ${Object.keys(r.lots).length} instruments` });
    else setLotState(s => ({ ...s, busy: false, msg: `✗ ${r.error}` }));
  };

  const [risk, setRisk] = useState({
    maxRiskPct:   saved0.risk?.maxRiskPct   ?? 1,
    maxDailyLoss: saved0.risk?.maxDailyLoss ?? 3,
    maxPositions: saved0.risk?.maxPositions ?? 5,
    leverage:     saved0.risk?.leverage     ?? 1,
  });

  const [notif, setNotif] = useState({
    telegram:    saved0.notif?.telegram    ?? false,
    email:       saved0.notif?.email       ?? false,
    telegramBot: saved0.notif?.telegramBot || "",
    emailAddr:   saved0.notif?.emailAddr   || "",
    signalAlert: saved0.notif?.signalAlert ?? true,
    geoAlert:    saved0.notif?.geoAlert    ?? true,
    pnlAlert:    saved0.notif?.pnlAlert    ?? true,
  });

  const mkMt5 = (a={}) => ({
    login:     a.login     || "",
    password:  a.password  || "",
    server:    a.server    || "",
    bridgeUrl: a.bridgeUrl || "",
  });
  const _oldMt5 = saved0.broker?.mt5 || {};
  const [broker, setBroker] = useState({
    // Reflect the real execution mode (set on the Execution page) so this
    // toggle isn't misleadingly stuck on "Paper" after a restart.
    mode:     getExecMode() !== "paper" ? "live" : (saved0.broker?.mode || "paper"),
    exchange: saved0.broker?.exchange || "binance",
    mt5: {
      // Migrate any previously-saved single MT5 config into the Demo slot
      demo: mkMt5(_oldMt5.demo || (_oldMt5.login !== undefined ? _oldMt5 : {})),
      live: mkMt5(_oldMt5.live),
    },
  });
  const [mt5Tab, setMt5Tab] = useState("demo");
  const setMt5 = (field,value)=>setBroker(b=>({
    ...b, mt5:{ ...b.mt5, [mt5Tab]:{ ...b.mt5[mt5Tab], [field]:value } }
  }));

  const [historyDays, setHistoryDays] = useState(saved0.historyDays || "30");
  const [autoSave,    setAutoSave]    = useState(saved0.autoSave    ?? true);
  const [savedMsg,    setSavedMsg]    = useState(false);

  // Test a provider using the CURRENT state key (not yet saved to localStorage)
  const testProvider = async (provider, key) => {
    setKeyStatus("testing");
    try {
      let resp, text;

      if (provider === "gemini") {
        resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: "Reply with one word: OK" }] }],
              generationConfig: { maxOutputTokens: 20 },
            }),
          }
        );
        if (!resp.ok) {
          const e = await resp.json().catch(()=>({}));
          throw new Error(e?.error?.message || `HTTP ${resp.status}`);
        }
        const d = await resp.json();
        text = d?.candidates?.[0]?.content?.parts?.[0]?.text || "";

      } else if (provider === "openrouter") {
        resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${key}`,
            "HTTP-Referer":  "http://localhost:3000",
            "X-Title":       "AlphaEdge Trading",
          },
          body: JSON.stringify({
            model:      "openai/gpt-oss-120b:free",
            max_tokens: 20,
            messages:   [{ role:"user", content:"Reply with one word: OK" }],
          }),
        });
        if (!resp.ok) {
          const e = await resp.json().catch(()=>({}));
          throw new Error(e?.error?.message || `HTTP ${resp.status}`);
        }
        const d = await resp.json();
        text = d?.choices?.[0]?.message?.content || "";

      } else if (provider === "groq") {
        resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${key}`,
          },
          body: JSON.stringify({
            model:      "llama-3.3-70b-versatile",
            max_tokens: 20,
            messages:   [{ role: "user", content: "Reply with one word: OK" }],
          }),
        });
        if (!resp.ok) {
          const e = await resp.json().catch(()=>({}));
          throw new Error(e?.error?.message || `HTTP ${resp.status}`);
        }
        const d = await resp.json();
        text = d?.choices?.[0]?.message?.content || "";

      } else if (provider === "deepseek") {
        resp = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${key}`,
          },
          body: JSON.stringify({
            model:      "deepseek-v4-flash",
            max_tokens: 20,
            messages:   [{ role: "user", content: "Reply with one word: OK" }],
            stream:     false,
          }),
        });
        if (!resp.ok) {
          const e = await resp.json().catch(()=>({}));
          throw new Error(e?.error?.message || `HTTP ${resp.status}`);
        }
        const d = await resp.json();
        text = d?.choices?.[0]?.message?.content || "";
      } else {
        throw new Error("Unknown AI provider");
      }

      setKeyStatus(text.trim().length > 0 ? "ok" : "fail");
    } catch(e) {
      setKeyStatus(`fail:${e.message}`);
    }
    setTimeout(()=>setKeyStatus(null), 6000);
  };

  // Save ALL settings to localStorage + also persist API keys in their own keys
  const [guardrails, setGuardrailsState] = useState(getGuardrails());
  const setGr = (patch)=>setGuardrailsState(g=>({...g,...patch}));

  const save = () => {
    // Persist all API keys
    if (apiKeys.deepseek)  setDeepSeekKey(apiKeys.deepseek);
    if (apiKeys.dhan)      setDhanToken(apiKeys.dhan);
    if (apiKeys.dhanClientId) setDhanClientId(apiKeys.dhanClientId);
    if (geminiKey)         setGeminiKey(geminiKey);
    if (groqKey)           setGroqKey(groqKey);
    if (openRouterKey)     setOpenRouterKey(openRouterKey);
    if (tgToken)           setTgToken(tgToken);
    if (tgChatId)          setTgChatId(tgChatId);
    setAIProvider(aiProvider);
    setGuardrails(guardrails);   // discipline rules
    // Push the bridge-enforced limits (loss auto-halt + profit lock) to the MT5
    // bridge — the bridge is the enforcer, this is just the config sync.
    try {
      const base = (getAnyBridgeUrl() || "").replace(/\/signal\/?$/, "");
      if (base) fetch(`${base}/risk`, { method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ action:"config",
          dailyLossLimit:    Number(guardrails.dailyLossHalt)    || 0,
          dailyProfitLock:   Number(guardrails.dailyProfitLock)  || 0,
          profitGivebackPct: Number(guardrails.profitGivebackPct)|| 0 }) }).catch(()=>{});
    } catch { /* bridge offline — limits sync on the next save */ }

    // Persist all other settings
    persistSettings({ apiKeys, risk, notif, broker, historyDays, autoSave, aiProvider });

    setSavedMsg(true);
    setTimeout(()=>setSavedMsg(false), 3000);
  };

  const section=(title,children)=>(
    <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:16,marginBottom:10}}>
      <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:14}}>{title}</div>
      {children}
    </div>
  );
  const row=(label,hint,children)=>(
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,gap:12}}>
      <div style={{flex:1}}>
        <div style={{fontSize:12,color:"#94a3b8"}}>{label}</div>
        {hint&&<div style={{fontSize:9,color:"#7c8ea8",marginTop:1}}>{hint}</div>}
      </div>
      <div style={{flexShrink:0}}>{children}</div>
    </div>
  );
  const toggle=(val,set)=>(
    <div onClick={()=>set(!val)}
      style={{width:38,height:20,borderRadius:10,background:val?"#3b82f6":"#1e2a3a",
        border:`0.5px solid ${val?"#60a5fa":"#1e3a5a"}`,position:"relative",cursor:"pointer",transition:"all 0.2s"}}>
      <div style={{width:14,height:14,borderRadius:"50%",background:val?"white":"#94a3b8",
        position:"absolute",top:3,left:val?21:3,transition:"left 0.2s"}}/>
    </div>
  );
  const numInput=(val,set,min,max,step=0.5)=>(
    <input type="number" value={val} min={min} max={max} step={step}
      onChange={e=>set(parseFloat(e.target.value)||0)}
      style={{width:80,background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,
        padding:"5px 8px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace",textAlign:"right"}}/>
  );
  const textInput=(val,set,ph)=>(
    <input value={val} onChange={e=>set(e.target.value)} placeholder={ph}
      style={{width:200,background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,
        padding:"5px 8px",color:"#e2e8f0",fontSize:11,fontFamily:"monospace"}}/>
  );
  const pwInput=(ph,val,set)=>(
    <input type="password" value={val} onChange={e=>set(e.target.value)} placeholder={ph}
      style={{width:220,background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,
        padding:"5px 8px",color:"#e2e8f0",fontSize:11,fontFamily:"monospace"}}/>
  );

  return (
    <div style={{height:"100%",overflow:"auto"}}>
      <div style={{maxWidth:700,margin:"0 auto"}}>
        {/* ── AI Provider — Gemini, Groq, OpenRouter, or DeepSeek ── */}
        {section("AI PROVIDER — Signal Analysis Engine",
          <>
            {/* Provider selector */}
            <div style={{marginBottom:16}}>
              <div style={{fontSize:9,color:"#94a3b8",marginBottom:8,letterSpacing:"0.06em"}}>SELECT PROVIDER</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {[
                  {id:"groq",       label:"Groq",            badge:"FREE ✓",  badgeC:"#22c55e", desc:"14,400/day · Llama 3.3 70B · Works in India",    color:"#f43f5e"},
                  {id:"openrouter", label:"OpenRouter",       badge:"FREE ✓",  badgeC:"#22c55e", desc:"Free tier · GPT-OSS 120B · Works everywhere",     color:"#60a5fa"},
                  {id:"gemini",     label:"Google Gemini",    badge:"LIMITED", badgeC:"#f59e0b", desc:"Quota=0 in India · Free elsewhere",              color:"#4285f4"},
                  {id:"deepseek",   label:"DeepSeek",         badge:"PRO",     badgeC:"#22c55e", desc:"Direct API · V4 Pro/Flash · Trading analysis",   color:"#7c3aed"},
                ].map(p=>(
                  <div key={p.id} onClick={()=>setAIProviderState(p.id)}
                    style={{flex:1,padding:"10px 12px",borderRadius:8,cursor:"pointer",
                      background:aiProvider===p.id?p.color+"15":"#060d17",
                      border:`0.5px solid ${aiProvider===p.id?p.color:"#64748b"}`,
                      transition:"all 0.2s"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                      <span style={{fontSize:11,fontWeight:700,color:aiProvider===p.id?p.color:"#94a3b8"}}>{p.label}</span>
                      <span style={{fontSize:7,fontWeight:800,color:p.badgeC,background:p.badgeC+"20",
                        padding:"1px 5px",borderRadius:3}}>{p.badge}</span>
                    </div>
                    <div style={{fontSize:9,color:"#94a3b8",lineHeight:1.4}}>{p.desc}</div>
                    {aiProvider===p.id&&<div style={{width:8,height:8,borderRadius:"50%",background:p.color,marginTop:6}}/>}
                  </div>
                ))}
              </div>
            </div>

            {/* OpenRouter key */}
            {aiProvider==="openrouter"&&(
              <>
                <div style={{background:"#0a1e35",border:"0.5px solid #60a5fa30",borderRadius:8,padding:"10px 14px",marginBottom:12}}>
                  <div style={{fontSize:10,color:"#60a5fa",marginBottom:4,fontWeight:600}}>🆓 How to get a FREE OpenRouter key (works in India)</div>
                  <div style={{fontSize:11,color:"#94a3b8",lineHeight:1.7}}>
                    1. Go to <span style={{color:"#60a5fa"}}>https://openrouter.ai/keys</span><br/>
                    2. Sign up with Google/GitHub (free)<br/>
                    3. Click <strong style={{color:"#e2e8f0"}}>"Create Key"</strong><br/>
                    4. Copy the key (starts with <code style={{color:"#60a5fa"}}>sk-or-...</code>) and paste below<br/>
                    <span style={{color:"#94a3b8",fontSize:10}}>Free tier: Llama 3.3 70B · No credit card · Works globally</span>
                  </div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:8,color:"#94a3b8",marginBottom:4,letterSpacing:"0.06em"}}>OPENROUTER API KEY</div>
                    <input type="password" value={openRouterKey}
                      onChange={e=>setOpenRouterKeyState(e.target.value)}
                      placeholder="sk-or-v1-..."
                      style={{width:"100%",background:"#060d17",border:`0.5px solid ${openRouterKey?"#60a5fa":"#1e3a5a"}`,
                        borderRadius:6,padding:"8px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}/>
                  </div>
                  <button onClick={()=>testProvider("openrouter", openRouterKey)}
                    style={{padding:"8px 14px",background:"#0d9488",border:"none",borderRadius:7,
                    color:"white",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>Test</button>
                </div>
                {openRouterKey&&<div style={{marginTop:6,fontSize:10,color:"#7c8ea8",fontFamily:"monospace"}}>Active: {openRouterKey.slice(0,14)}...</div>}
              </>
            )}

            {/* Gemini key */}
            {aiProvider==="gemini"&&(
              <>
                <div style={{background:"#052e16",border:"0.5px solid #22c55e30",borderRadius:8,padding:"10px 14px",marginBottom:12}}>
                  <div style={{fontSize:10,color:"#22c55e",marginBottom:4,fontWeight:600}}>🆓 How to get a FREE Gemini API key</div>
                  <div style={{fontSize:11,color:"#94a3b8",lineHeight:1.7}}>
                    1. Go to <span style={{color:"#22c55e"}}>https://aistudio.google.com/app/apikey</span><br/>
                    2. Sign in with your Google account<br/>
                    3. Click <strong style={{color:"#e2e8f0"}}>"Create API key"</strong><br/>
                    4. Copy the key (starts with <code style={{color:"#22c55e"}}>AIza...</code>) and paste below<br/>
                    <span style={{color:"#94a3b8",fontSize:10}}>Free tier: 15 requests/min · 1,500/day · No credit card needed</span>
                  </div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:8,color:"#94a3b8",marginBottom:4,letterSpacing:"0.06em"}}>GEMINI API KEY</div>
                    <input type="password" value={geminiKey}
                      onChange={e=>setGeminiKeyState(e.target.value)}
                      placeholder="AIzaSy..."
                      style={{width:"100%",background:"#060d17",border:`0.5px solid ${geminiKey?"#22c55e":"#1e3a5a"}`,
                        borderRadius:6,padding:"8px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}/>
                  </div>
                  <button onClick={()=>testProvider("gemini", geminiKey)}
                    style={{padding:"8px 14px",background:"#0d9488",border:"none",borderRadius:7,
                    color:"white",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>Test</button>
                </div>
                {geminiKey&&<div style={{marginTop:6,fontSize:10,color:"#7c8ea8",fontFamily:"monospace"}}>Active: {geminiKey.slice(0,10)}...</div>}
              </>
            )}

            {/* Groq key */}
            {aiProvider==="groq"&&(
              <>
                <div style={{background:"#1a0010",border:"0.5px solid #f43f5e30",borderRadius:8,padding:"10px 14px",marginBottom:12}}>
                  <div style={{fontSize:10,color:"#f43f5e",marginBottom:4,fontWeight:600}}>🆓 How to get a FREE Groq API key</div>
                  <div style={{fontSize:11,color:"#94a3b8",lineHeight:1.7}}>
                    1. Go to <span style={{color:"#f43f5e"}}>https://console.groq.com/keys</span><br/>
                    2. Sign up with Google/GitHub (free)<br/>
                    3. Click <strong style={{color:"#e2e8f0"}}>"Create API Key"</strong><br/>
                    4. Copy the key (starts with <code style={{color:"#f43f5e"}}>gsk_...</code>) and paste below<br/>
                    <span style={{color:"#94a3b8",fontSize:10}}>Free tier: 14,400 req/day · Llama 3.1 70B · No credit card</span>
                  </div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:8,color:"#94a3b8",marginBottom:4,letterSpacing:"0.06em"}}>GROQ API KEY</div>
                    <input type="password" value={groqKey}
                      onChange={e=>setGroqKeyState(e.target.value)}
                      placeholder="gsk_..."
                      style={{width:"100%",background:"#060d17",border:`0.5px solid ${groqKey?"#f43f5e":"#1e3a5a"}`,
                        borderRadius:6,padding:"8px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}/>
                  </div>
                  <button onClick={()=>testProvider("groq", groqKey)}
                    style={{padding:"8px 14px",background:"#0d9488",border:"none",borderRadius:7,
                    color:"white",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>Test</button>
                </div>
                {groqKey&&<div style={{marginTop:6,fontSize:10,color:"#7c8ea8",fontFamily:"monospace"}}>Active: {groqKey.slice(0,10)}...</div>}
              </>
            )}

            {/* DeepSeek key */}
            {aiProvider==="deepseek"&&(
              <>
                <div style={{background:"#0d1e35",border:"0.5px solid #7c3aed40",borderRadius:8,padding:"10px 14px",marginBottom:12}}>
                  <div style={{fontSize:10,color:"#a78bfa",marginBottom:4,fontWeight:600}}>DeepSeek API Key</div>
                  <div style={{fontSize:11,color:"#94a3b8",lineHeight:1.6}}>
                    1. Go to <span style={{color:"#a78bfa"}}>https://platform.deepseek.com/api_keys</span><br/>
                    2. Create a new API key and copy it here<br/>
                    3. AlphaEdge uses <strong style={{color:"#e2e8f0"}}>deepseek-v4-pro</strong> for signal analysis
                  </div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:8,color:"#94a3b8",marginBottom:4,letterSpacing:"0.06em"}}>DEEPSEEK API KEY</div>
                    <input type="password" value={apiKeys.deepseek}
                      onChange={e=>setApiKeys(k=>({...k,deepseek:e.target.value}))}
                      placeholder="sk-..."
                      style={{width:"100%",background:"#060d17",border:`0.5px solid ${apiKeys.deepseek?"#7c3aed":"#1e3a5a"}`,
                        borderRadius:6,padding:"8px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}/>
                  </div>
                  <button onClick={()=>testProvider("deepseek", apiKeys.deepseek)}
                    style={{padding:"8px 14px",background:"#0d9488",border:"none",borderRadius:7,
                    color:"white",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>Test</button>
                </div>
                {apiKeys.deepseek&&<div style={{marginTop:6,fontSize:10,color:"#7c8ea8",fontFamily:"monospace"}}>Active: {apiKeys.deepseek.slice(0,14)}...</div>}
              </>
            )}

            {keyStatus==="testing" && <div style={{marginTop:8,fontSize:11,color:"#f59e0b",fontFamily:"monospace"}}>◌ Testing AI connection...</div>}
            {keyStatus==="ok"      && <div style={{marginTop:8,fontSize:11,color:"#22c55e",fontFamily:"monospace"}}>✓ Connected! AI analysis is ready.</div>}
            {keyStatus&&keyStatus.startsWith("fail:") && (
              <div style={{marginTop:8,background:"#1a0000",border:"0.5px solid #ef444430",borderRadius:7,padding:"8px 12px"}}>
                <div style={{fontSize:11,color:"#ef4444",fontFamily:"monospace",marginBottom:4}}>✗ Connection failed</div>
                <div style={{fontSize:10,color:"#94a3b8",fontFamily:"monospace",wordBreak:"break-all"}}>{keyStatus.replace("fail:","")}</div>
              </div>
            )}
            {keyStatus==="fail" && <div style={{marginTop:8,fontSize:11,color:"#ef4444",fontFamily:"monospace"}}>✗ Connection failed — check key or internet.</div>}
          </>
        )}

        {/* ── Dhan API — live Nifty price + historical data for backtesting ── */}
        {section("DHAN DATA API — Live Price + Historical Backtest Data",
          <>
            <div style={{background:"#0d1e35",border:"0.5px solid #a78bfa40",borderRadius:8,padding:"10px 14px",marginBottom:12}}>
              <div style={{fontSize:10,color:"#a78bfa",marginBottom:4,fontWeight:600}}>How to get your Dhan access token &amp; client ID</div>
              <div style={{fontSize:11,color:"#94a3b8",lineHeight:1.7}}>
                1. Log in at <span style={{color:"#a78bfa"}}>https://web.dhan.co</span><br/>
                2. Go to <strong style={{color:"#e2e8f0"}}>My Account → DhanHQ Trading APIs</strong> (or visit <span style={{color:"#a78bfa"}}>https://dhanhq.co</span>)<br/>
                3. Click <strong style={{color:"#e2e8f0"}}>"Generate Access Token"</strong> (choose a validity, e.g. 30 days), then copy it below<br/>
                4. Copy your <strong style={{color:"#e2e8f0"}}>Client ID</strong> (the numeric dhanClientId shown on the same page)<br/>
                <span style={{color:"#94a3b8",fontSize:10}}>
                  Both are needed for the Historical Data API used to backtest Nifty 50 / Bank Nifty.
                  Without a token, live Nifty price falls back to Yahoo Finance (^NSEI).
                </span>
              </div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"flex-end",flexWrap:"wrap"}}>
              <div style={{flex:1,minWidth:240}}>
                <div style={{fontSize:8,color:"#94a3b8",marginBottom:4,letterSpacing:"0.06em"}}>DHAN ACCESS TOKEN</div>
                <input
                  type="password"
                  value={apiKeys.dhan}
                  onChange={e=>setApiKeys(k=>({...k,dhan:e.target.value}))}
                  placeholder="eyJ0eXAiOiJKV1QiLCJhbGciOi..."
                  style={{width:"100%",background:"#060d17",border:`0.5px solid ${apiKeys.dhan?"#a78bfa":"#1e3a5a"}`,
                    borderRadius:6,padding:"8px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}
                />
              </div>
              <div style={{width:180}}>
                <div style={{fontSize:8,color:"#94a3b8",marginBottom:4,letterSpacing:"0.06em"}}>CLIENT ID</div>
                <input
                  type="text"
                  value={apiKeys.dhanClientId}
                  onChange={e=>setApiKeys(k=>({...k,dhanClientId:e.target.value}))}
                  placeholder="1000000003"
                  style={{width:"100%",background:"#060d17",border:`0.5px solid ${apiKeys.dhanClientId?"#a78bfa":"#1e3a5a"}`,
                    borderRadius:6,padding:"8px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}
                />
              </div>
              <button onClick={()=>{
                setDhanToken(apiKeys.dhan);
                setDhanClientId(apiKeys.dhanClientId);
                setDhanStatus("saved");
                setTimeout(()=>setDhanStatus(null),3000);
              }} style={{padding:"8px 18px",background:"#7c3aed",border:"none",borderRadius:7,
                color:"white",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace",flexShrink:0}}>
                Save
              </button>
              <button onClick={async()=>{
                // Persist current inputs so the test uses them.
                setDhanToken(apiKeys.dhan);
                setDhanClientId(apiKeys.dhanClientId);
                setDhanStatus("testing");
                // Validate the token server-side through the local bridge (no CORS).
                const base = getAnyBridgeUrl();
                if (!base) {
                  setDhanStatus("nobridge");
                  setTimeout(()=>setDhanStatus(null),7000);
                  return;
                }
                try {
                  const url = base.replace(/\/signal\/?$/, "") + "/dhan/profile";
                  const resp = await fetch(url, {
                    method:"POST", headers:{ "Content-Type":"application/json" },
                    body: JSON.stringify({ token: apiKeys.dhan, clientId: apiKeys.dhanClientId }),
                    signal: AbortSignal.timeout(20000),
                  });
                  const d = await resp.json();
                  if (d?.ok) {
                    const plan = d.dataPlan === "Active"
                      ? `Data plan Active${d.dataValidity?` until ${String(d.dataValidity).slice(0,10)}`:""}`
                      : `Data plan: ${d.dataPlan || "inactive"}`;
                    setDhanStatus(`ok:Token valid · ${plan}`);
                  } else {
                    setDhanStatus(`fail:${d?.error || "token rejected by Dhan"}`);
                  }
                } catch {
                  setDhanStatus("nobridge");
                }
                setTimeout(()=>setDhanStatus(null),8000);
              }} style={{padding:"8px 14px",background:"#0d9488",border:"none",borderRadius:7,
                color:"white",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace",flexShrink:0}}>
                Test
              </button>
            </div>
            {dhanStatus==="saved" &&<div style={{marginTop:8,fontSize:11,color:"#a78bfa",fontFamily:"monospace"}}>✓ Dhan token saved</div>}
            {dhanStatus==="testing"&&<div style={{marginTop:8,fontSize:11,color:"#f59e0b",fontFamily:"monospace"}}>◌ Validating token via local bridge...</div>}
            {typeof dhanStatus==="string"&&dhanStatus.startsWith("ok:")&&<div style={{marginTop:8,fontSize:11,color:"#22c55e",fontFamily:"monospace"}}>✓ {dhanStatus.slice(3)}</div>}
            {typeof dhanStatus==="string"&&dhanStatus.startsWith("fail:")&&(
              <div style={{marginTop:8,background:"#1a0000",border:"0.5px solid #ef444430",borderRadius:7,padding:"8px 12px"}}>
                <div style={{fontSize:11,color:"#ef4444",fontFamily:"monospace",marginBottom:4}}>✗ {dhanStatus.slice(5)}</div>
                <div style={{fontSize:10,color:"#94a3b8"}}>If it says Invalid Token, the token was superseded — generate a fresh one on Dhan and copy it via the copy icon.</div>
              </div>
            )}
            {dhanStatus==="nobridge"&&(
              <div style={{marginTop:8,background:"#1c1300",border:"0.5px solid #f59e0b30",borderRadius:7,padding:"8px 12px"}}>
                <div style={{fontSize:11,color:"#f59e0b",fontFamily:"monospace",marginBottom:4}}>⚠ Can't reach the local bridge</div>
                <div style={{fontSize:10,color:"#94a3b8"}}>The browser can't call Dhan directly (CORS). Start the MT5 bridge (bridge.py) and set its URL in Settings → MT5 Terminal — Dhan calls route through it. Token still saves fine for the Python pipeline.</div>
              </div>
            )}
            {getDhanToken()&&<div style={{marginTop:6,fontSize:10,color:"#7c8ea8",fontFamily:"monospace"}}>
              Active: {getDhanToken().slice(0,16)}...
            </div>}
          </>
        )}

        {/* ── Broker mode ── */}
        {section("BROKER & EXECUTION MODE",
          <>
            {row("Trading Mode","Paper = simulated, Live = real funds. (Finer control — Demo/Live — on the Execution page.)",
              <div style={{display:"flex",gap:4}}>
                {["paper","live"].map(m=>(
                  <span key={m} onClick={()=>{
                    setBroker(b=>({...b,mode:m}));
                    // Drive the master execMode immediately so the choice takes
                    // effect and persists across restarts without needing Save.
                    setExecMode(m === "live" ? "mt5_live" : "paper");
                  }}
                    style={{padding:"5px 14px",borderRadius:6,fontSize:11,cursor:"pointer",fontFamily:"monospace",fontWeight:700,
                      background:broker.mode===m?(m==="live"?"#1a0000":"#052e16"):"#060d17",
                      color:broker.mode===m?(m==="live"?"#ef4444":"#22c55e"):"#94a3b8",
                      border:`0.5px solid ${broker.mode===m?(m==="live"?"#ef444440":"#22c55e40"):"#1e3a5a"}`}}>
                    {m==="live"?"⚡ LIVE":"◎ PAPER"}
                  </span>
                ))}
              </div>
            )}
            {broker.mode==="live"&&(
              <div style={{background:"#1a0000",border:"0.5px solid #ef444430",borderRadius:8,padding:"8px 12px",marginBottom:12}}>
                <div style={{fontSize:10,color:"#ef4444",fontWeight:700}}>⚠ LIVE TRADING ENABLED — Real funds at risk</div>
                <div style={{fontSize:9,color:"#94a3b8",marginTop:2}}>All orders will be sent to your connected broker. Ensure API keys are set and risk parameters are correct.</div>
              </div>
            )}
            {row("Default Exchange","Exchange used for crypto execution",
              <select value={broker.exchange} onChange={e=>setBroker(b=>({...b,exchange:e.target.value}))}
                style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"5px 8px",color:"#e2e8f0",fontSize:11,fontFamily:"monospace"}}>
                <option value="binance">Binance</option>
                <option value="coinbase">Coinbase</option>
                <option value="bybit">ByBit</option>
                <option value="alpaca">Alpaca (US Stocks)</option>
                <option value="oanda">OANDA (Forex/Gold)</option>
                <option value="mt5">MetaTrader 5 (MT5)</option>
              </select>
            )}
          </>
        )}

        {/* MetaTrader 5 (MT5) terminal — Demo / Live tabs */}
        {section("METATRADER 5 (MT5) TERMINAL",
          <>
            {/* Account type tabs */}
            <div style={{display:"flex",gap:6,marginBottom:14}}>
              {[
                {id:"demo",label:"◎ Demo Account",        c:"#22c55e"},
                {id:"live",label:"⚡ Live (Real Account)", c:"#ef4444"},
              ].map(t=>{
                const cfg=broker.mt5[t.id];
                const ready=cfg.login&&cfg.server;
                const active=mt5Tab===t.id;
                return (
                  <span key={t.id} onClick={()=>setMt5Tab(t.id)}
                    style={{flex:1,textAlign:"center",padding:"8px 14px",borderRadius:7,fontSize:11,fontWeight:700,
                      cursor:"pointer",fontFamily:"monospace",transition:"all 0.15s",
                      background:active?t.c+"18":"#060d17",
                      color:active?t.c:"#94a3b8",
                      border:`0.5px solid ${active?t.c+"66":"#1e3a5a"}`}}>
                    {t.label}{ready?" ✓":""}
                  </span>
                );
              })}
            </div>

            {/* Live account warning */}
            {mt5Tab==="live"&&(
              <div style={{background:"#1a0000",border:"0.5px solid #ef444430",borderRadius:8,padding:"8px 12px",marginBottom:12}}>
                <div style={{fontSize:10,color:"#ef4444",fontWeight:700}}>⚠ REAL ACCOUNT — Real funds at risk</div>
                <div style={{fontSize:9,color:"#94a3b8",marginTop:2}}>Orders sent through a connected bridge use real money. Double-check the credentials and your risk settings.</div>
              </div>
            )}

            <div style={{background:"#0a1e35",border:"0.5px solid #60a5fa30",borderRadius:8,padding:"10px 14px",marginBottom:12}}>
              <div style={{fontSize:10,color:"#60a5fa",marginBottom:4,fontWeight:600}}>
                {mt5Tab==="demo"?"Connect your MT5 Demo account":"Connect your MT5 Live (real) account"}
              </div>
              <div style={{fontSize:10,color:"#94a3b8",lineHeight:1.7}}>
                Enter the login details from your broker&apos;s MT5 {mt5Tab==="demo"?"demo":"live"} account. A browser cannot
                talk to the MT5 terminal directly, so order execution also needs a bridge — a hosted API such as
                <span style={{color:"#60a5fa"}}> MetaApi</span>, or a small local bridge next to your MT5 terminal.
                Without a bridge, details are stored for reference only.
              </div>
            </div>

            {row("Account Login","Your MT5 account number",
              textInput(broker.mt5[mt5Tab].login, v=>setMt5("login",v),
                mt5Tab==="demo"?"e.g. 51234567 (demo)":"e.g. 71234567 (real)"))}
            {row("Password","Trading or investor password",
              pwInput("••••••••", broker.mt5[mt5Tab].password, v=>setMt5("password",v)))}
            {row("Server","Broker server name (exactly as shown in MT5)",
              textInput(broker.mt5[mt5Tab].server, v=>setMt5("server",v),
                mt5Tab==="demo"?"e.g. ICMarkets-Demo02":"e.g. ICMarkets-Live03"))}
            {row("Bridge / API URL","Optional — endpoint that relays orders to MT5",
              textInput(broker.mt5[mt5Tab].bridgeUrl, v=>setMt5("bridgeUrl",v), "https://...  (MetaApi or local bridge)"))}

            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}>
              <span style={{fontSize:10,
                color:(broker.mt5[mt5Tab].login&&broker.mt5[mt5Tab].server)?"#22c55e":"#f59e0b"}}>
                {(broker.mt5[mt5Tab].login&&broker.mt5[mt5Tab].server)
                  ? `✓ ${mt5Tab==="demo"?"Demo":"Live"} account ready — set "Default Exchange" to MetaTrader 5 and Save.`
                  : `⚠ Enter at least Login and Server for the ${mt5Tab==="demo"?"Demo":"Live"} account, then Save.`}
              </span>
            </div>
            <div style={{fontSize:9,color:"#7c8ea8",marginTop:8,lineHeight:1.6}}>
              🔒 Passwords are stored only in this browser. Paper mode uses your <b>Demo</b> account; Live mode uses your
              <b> Live</b> account. Prefer an <b>investor (read-only)</b> password unless a trusted bridge is set up.
            </div>
          </>
        )}

        {/* API Keys */}
        {section("API KEYS",
          <>
            {[
              {label:"Binance API Key",hint:"For BTC/ETH execution",key:"binance"},
              {label:"Alpaca API Key",hint:"For US indices and stocks",key:"alpaca"},
              {label:"OANDA API Key",hint:"For XAU/USD and Forex",key:"oanda"},
              {label:"Alpha Vantage Key",hint:"News and sentiment data",key:"alphavantage"},
            ].map(f=>(
              <div key={f.key}>
                {row(f.label,f.hint,pwInput("sk-xxxx...",apiKeys[f.key],v=>setApiKeys(k=>({...k,[f.key]:v}))))}
              </div>
            ))}
            <div style={{fontSize:9,color:"#7c8ea8",marginTop:4,lineHeight:1.6}}>
              🔒 API keys are stored locally in your browser — never sent to external servers. Use read-only keys where possible.
            </div>
          </>
        )}

        {/* Risk parameters */}
        {section("RISK MANAGEMENT PARAMETERS",
          <>
            {row("Max Risk per Trade","Signal engine caps planned risk at 1% to block Big Losses",
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                {numInput(risk.maxRiskPct,v=>setRisk(r=>({...r,maxRiskPct:v})),0.1,5,0.25)}
                <span style={{fontSize:10,color:"#94a3b8"}}>%</span>
              </div>
            )}
            {row("Max Daily Loss","Auto-stop trading after this % daily loss",
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                {numInput(risk.maxDailyLoss,v=>setRisk(r=>({...r,maxDailyLoss:v})),0.5,20,0.5)}
                <span style={{fontSize:10,color:"#94a3b8"}}>%</span>
              </div>
            )}
            {row("Max Open Positions","Maximum concurrent positions",
              numInput(risk.maxPositions,v=>setRisk(r=>({...r,maxPositions:v})),1,20,1)
            )}
            {row("Default Leverage","Leverage multiplier for position sizing",
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                {numInput(risk.leverage,v=>setRisk(r=>({...r,leverage:v})),1,100,1)}
                <span style={{fontSize:10,color:"#94a3b8"}}>x</span>
              </div>
            )}
          </>
        )}

        {/* Index lot sizes — live from Dhan scrip master */}
        {section("INDEX LOT SIZES — live from Dhan",
          <>
            <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:10}}>
              <button onClick={updateLots} disabled={lotState.busy}
                style={{fontSize:11,padding:"6px 14px",background:"#0a1f14",border:"0.5px solid #22c55e40",borderRadius:6,color:"#22c55e",cursor:lotState.busy?"default":"pointer",fontFamily:"monospace"}}>
                {lotState.busy?"◌ Updating…":"⟳ Update lot sizes"}
              </button>
              {lotState.updated && <span style={{fontSize:9,color:"#7c8ea8"}}>updated {new Date(lotState.updated).toLocaleString("en-IN")}</span>}
              {lotState.msg && <span style={{fontSize:10,color:lotState.msg.startsWith("✓")?"#22c55e":lotState.msg.startsWith("✗")?"#ef4444":"#94a3b8"}}>{lotState.msg}</span>}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:6}}>
              {Object.entries(Object.keys(lotState.lots||{}).length ? lotState.lots : {NIFTY:65,BANKNIFTY:30,FINNIFTY:60,SENSEX:20})
                .sort((a,b)=>a[0].localeCompare(b[0])).map(([sym,lot])=>(
                <div key={sym} style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:7,padding:"6px 10px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:9,color:"#94a3b8",fontFamily:"monospace"}}>{sym}</span>
                  <span style={{fontSize:13,fontWeight:800,color:"#e2e8f0",fontFamily:"monospace"}}>{lot}</span>
                </div>
              ))}
            </div>
            <div style={{fontSize:9,color:"#7c8ea8",marginTop:8,lineHeight:1.5}}>
              Pulled from Dhan&apos;s scrip master (SEM_LOT_UNITS) via the bridge — futures &amp; options share the same lot per index. Used for Options-desk sizing and futures backtests. {Object.keys(lotState.lots||{}).length?"":"(showing last-known defaults — click to fetch live)"} Needs the MT5 bridge running.
            </div>
          </>
        )}

        {/* Discipline guardrails */}
        {section("DISCIPLINE GUARDRAILS — auto-enforced from your Dhan audit",
          <>
            <div style={{background:"#1a0000",border:"0.5px solid #ef444430",borderRadius:8,padding:"8px 12px",marginBottom:12}}>
              <div style={{fontSize:10,color:"#ef4444",fontWeight:700,marginBottom:2}}>Blocks rule-violating trades before execution</div>
              <div style={{fontSize:9,color:"#94a3b8",lineHeight:1.5}}>Derived from your 12-month audit (net −₹3.4L). When a rule is hit, AlphaEdge saves the signal to History but does NOT send it to MT5. The Dashboard shows a live CLEAR / STAND-DOWN verdict.</div>
            </div>
            {row("Enable guardrails","Master switch for all discipline rules",toggle(guardrails.enabled,v=>setGr({enabled:v})))}
            {guardrails.enabled && (<>
              {row("Post-loss cooldown (min)","No new entry within N min of a loss — kills revenge trading",
                numInput(guardrails.cooldownMin,v=>setGr({cooldownMin:v}),0,120,5))}
              {row("Max trades per day","Hard daily cap — stops over-trading",
                numInput(guardrails.maxTradesPerDay,v=>setGr({maxTradesPerDay:v}),1,50,1))}
              {row("Consecutive-loss stop","Stop for the session after N losses in a row",
                numInput(guardrails.maxConsecLosses,v=>setGr({maxConsecLosses:v}),1,10,1))}
              {row("Block NSE open","No Indian-market entries during the volatile open (BTC/XAU/ETH exempt)",toggle(guardrails.openLockout,v=>setGr({openLockout:v})))}
              {guardrails.openLockout && row("NSE lockout ends (IST)","First Indian-instrument entries allowed after this time",
                <input type="time" value={guardrails.openLockoutEnd} onChange={e=>setGr({openLockoutEnd:e.target.value})}
                  style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"5px 8px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}/>)}
              {row("Block 0-DTE longs","No option buying on expiry day (option signals)",toggle(guardrails.blockExpiryDay,v=>setGr({blockExpiryDay:v})))}
              {row("Min option premium (₹)","Avoid far-OTM lottery tickets — ATM/ITM only",
                numInput(guardrails.minPremium,v=>setGr({minPremium:v}),0,500,5))}
              {row("Time-stop (min)","Exit long option after N min (theta guard — bridge/alert)",
                numInput(guardrails.maxHoldMin,v=>setGr({maxHoldMin:v}),5,240,5))}
            </>)}
            {row("Daily-loss auto-halt ($)","Bridge closes ALL AlphaEdge positions + blocks trading for the day when today's MT5 P&L hits −N (account currency). 0 = off. Enforced bridge-side even with guardrails off.",
              numInput(guardrails.dailyLossHalt,v=>setGr({dailyLossHalt:v}),0,100000,10))}
            {row("Daily profit lock ($)","Bank the day: once today's REALIZED MT5 P&L reaches +N, the bridge rejects new signals until tomorrow (IST). Open positions keep trailing. 0 = off.",
              numInput(guardrails.dailyProfitLock,v=>setGr({dailyProfitLock:v}),0,100000,5))}
            {row("Give-back stop (% off peak)","Once the day peaks at ≥ half the lock target, lock if realized P&L gives back this % of the peak — stops a green day bleeding out through fresh trades' SLs. 0 = off.",
              numInput(guardrails.profitGivebackPct,v=>setGr({profitGivebackPct:v}),0,100,5))}
          </>
        )}

        {/* Notifications */}
        {section("NOTIFICATIONS — TELEGRAM",
          <>
            {/* Bot Token */}
            <div style={{marginBottom:12}}>
              <div style={{fontSize:8,color:"#94a3b8",marginBottom:4,letterSpacing:"0.06em"}}>BOT TOKEN (from @BotFather)</div>
              <div style={{display:"flex",gap:8}}>
                <input type="password" value={tgToken}
                  onChange={e=>setTgTokenState(e.target.value)}
                  placeholder="8207949300:AAGVctZ-lf..."
                  style={{flex:1,background:"#060d17",border:`0.5px solid ${tgToken?"#60a5fa":"#1e3a5a"}`,
                    borderRadius:6,padding:"8px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}/>
              </div>
              <div style={{fontSize:8,color:"#7c8ea8",marginTop:3}}>
                Get from Telegram: open @BotFather → /newbot → copy the token
              </div>
            </div>
            {/* Chat ID */}
            <div style={{marginBottom:12}}>
              <div style={{fontSize:8,color:"#94a3b8",marginBottom:4,letterSpacing:"0.06em"}}>CHAT ID (your personal chat)</div>
              <div style={{display:"flex",gap:8}}>
                <input value={tgChatId}
                  onChange={e=>setTgChatIdState(e.target.value)}
                  placeholder="898661475"
                  style={{flex:1,background:"#060d17",border:`0.5px solid ${tgChatId?"#60a5fa":"#1e3a5a"}`,
                    borderRadius:6,padding:"8px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}/>
              </div>
              <div style={{fontSize:8,color:"#7c8ea8",marginTop:3}}>
                Get from Telegram: open @userinfobot and it will send your Chat ID
              </div>
            </div>
            {/* Test button */}
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <button onClick={async()=>{
                setTgTestStatus("testing"); setTgTestMsg("");
                const token  = (tgToken  || getTgToken()).trim();
                const chatId = (tgChatId || getTgChatId()).trim();
                if (!token||!chatId){ setTgTestStatus("noconfig"); return; }
                try {
                  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
                    method:"POST",
                    headers:{"Content-Type":"application/json"},
                    body:JSON.stringify({chat_id:chatId,
                      text:"✅ <b>AlphaEdge</b> — Telegram connected! AI signals will be delivered here.",
                      parse_mode:"HTML"})
                  });
                  // Telegram returns {ok:false, description:"..."} on errors — surface it
                  const data = await resp.json().catch(()=>({}));
                  if (resp.ok && data.ok) {
                    setTgTestStatus("ok");
                  } else {
                    setTgTestStatus("fail");
                    setTgTestMsg(data?.description || `HTTP ${resp.status}`);
                  }
                } catch(e) {
                  setTgTestStatus("fail");
                  setTgTestMsg(/Failed to fetch|NetworkError|ERR_/i.test(e.message||"")
                    ? "Could not reach Telegram — check your internet, ad-blocker, or VPN/firewall (api.telegram.org may be blocked on your network)."
                    : (e.message||"Unknown error"));
                }
                setTimeout(()=>{setTgTestStatus(null); setTgTestMsg("");},9000);
              }} style={{padding:"7px 16px",background:"#2563eb",border:"none",borderRadius:7,
                color:"white",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
                ✈️ Send Test Message
              </button>
              {tgToken&&tgChatId&&<span style={{fontSize:10,color:"#22c55e"}}>✓ Configured</span>}
              {(!tgToken||!tgChatId)&&<span style={{fontSize:10,color:"#f59e0b"}}>⚠ Fill both fields above</span>}
            </div>
            {tgTestStatus==="testing"  &&<div style={{marginTop:8,fontSize:11,color:"#f59e0b",fontFamily:"monospace"}}>◌ Sending test message...</div>}
            {tgTestStatus==="ok"       &&<div style={{marginTop:8,fontSize:11,color:"#22c55e",fontFamily:"monospace"}}>✓ Test message sent! Check your Telegram.</div>}
            {tgTestStatus==="fail"     &&<div style={{marginTop:8,fontSize:11,color:"#ef4444",fontFamily:"monospace"}}>
              ✗ Failed: {tgTestMsg||"check Token and Chat ID are correct."}
              <div style={{color:"#f59e0b",marginTop:5,fontSize:10,lineHeight:1.6}}>
                Most common fix: open Telegram, search for your bot, and press <b>Start</b> once — a bot cannot message you until you have started a chat with it. Also confirm the Chat ID is your numeric ID from @userinfobot.
              </div>
            </div>}
            {tgTestStatus==="noconfig" &&<div style={{marginTop:8,fontSize:11,color:"#f59e0b",fontFamily:"monospace"}}>⚠ Enter Bot Token and Chat ID first.</div>}
            <div style={{height:"0.5px",background:"#1e3a5a",margin:"12px 0"}}/>
            {row("Signal Alerts","Send AI signals to Telegram",toggle(notif.signalAlert,v=>setNotif(n=>({...n,signalAlert:v}))))}
            {row("Geopolitical Alerts","High-impact geo event notifications",toggle(notif.geoAlert,v=>setNotif(n=>({...n,geoAlert:v}))))}
            {row("P&L Alerts","Daily P&L summary and drawdown warnings",toggle(notif.pnlAlert,v=>setNotif(n=>({...n,pnlAlert:v}))))}
          </>
        )}

        {/* Signal history */}
        {section("SIGNAL HISTORY SETTINGS",
          <>
            {row("Retention Window","Signals older than this are auto-purged",
              <select value={historyDays} onChange={e=>setHistoryDays(e.target.value)}
                style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"5px 8px",color:"#e2e8f0",fontSize:11,fontFamily:"monospace"}}>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="60">60 days</option>
                <option value="90">90 days</option>
              </select>
            )}
            {row("Auto-save AI Signals","Save every AI analysis to History automatically",
              toggle(autoSave, v=>setAutoSave(v))
            )}
            {row("Export History","Download signal history as CSV",
              <button onClick={()=>{
                const hist = localStorage.getItem("signal-history") || "[]";
                const data = JSON.parse(hist);
                const csv  = ["ID,Date,Asset,TF,Nature,Bias,Confidence,Setup,Entry,SL,TP1,TP2,RR,Outcome,Source,RuleRR,MaxRiskPct,BigLossBlocked",
                  ...data.map(s=>[s.id,new Date(s.timestamp).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}),
                    s.asset,s.timeframe,s.nature,s.bias,s.confidence,
                    `"${s.setup}"`,s.entry,s.stopLoss,s.takeProfit1,s.takeProfit2,s.riskReward,s.outcome,s.source,
                    s.ruleAudit?.rrToTP2 || "", s.ruleAudit?.maxRiskPct || "", s.ruleAudit?.bigLossBlocked ?? ""
                  ].join(","))
                ].join("\n");
                const blob = new Blob([csv], {type:"text/csv"});
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `alphaedge-signals-${new Date().toISOString().split("T")[0]}.csv`;
                a.click();
              }} style={{padding:"5px 14px",background:"#1e3a5a",border:"0.5px solid #3b82f640",borderRadius:6,color:"#60a5fa",fontSize:10,cursor:"pointer",fontFamily:"monospace"}}>
                ↓ Export CSV
              </button>
            )}
          </>
        )}

        {/* Save button */}
        <div style={{display:"flex",justifyContent:"flex-end",gap:8,paddingBottom:20}}>
          {savedMsg&&<span style={{fontSize:11,color:"#22c55e",alignSelf:"center",fontFamily:"monospace"}}>✓ All settings saved to local storage</span>}
          <button onClick={save}
            style={{padding:"10px 28px",background:"linear-gradient(135deg,#1d4ed8,#7c3aed)",border:"none",
              borderRadius:8,color:"white",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"monospace",letterSpacing:"0.05em"}}>
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── HISTORY PAGE ─────────────────────────────────────────────────────────────
function HistoryPage({ history, setHistory }) {
  const [filterAsset, setFilterAsset]     = useState("ALL");
  const [filterOutcome, setFilterOutcome] = useState("ALL");
  const [filterNature, setFilterNature]   = useState("ALL");
  const [filterBias, setFilterBias]       = useState("ALL");
  const [expanded, setExpanded]           = useState(null);
  const [loading, setLoading]             = useState(false);
  const [mt5Trades, setMt5Trades]         = useState([]);
  const [lastSync, setLastSync]           = useState(null);
  const [tgFlash, setTgFlash]             = useState({});
  const [exportMsg, setExportMsg]         = useState(null);   // Obsidian export feedback

  const outcomeColor = { small_loss:"#ef4444", small_profit:"#f59e0b", big_profit:"#22c55e", big_loss:"#b91c1c", win:"#22c55e", loss:"#ef4444", open:"#f59e0b", missed:"#f59e0b", pending:"#94a3b8" };
  const outcomeLabel = { small_loss:"SL", small_profit:"WIN", big_profit:"BIG WIN", big_loss:"BIG LOSS", win:"WIN", loss:"LOSS", missed:"MISSED", pending:"PENDING" };
  const biasColor    = { BULLISH:"#22c55e", BEARISH:"#ef4444", NEUTRAL:"#f59e0b" };

  // ── Pull AlphaEdge's real MT5 trades and reconcile signal outcomes from them ──
  const syncFromMT5 = useCallback(async () => {
    const trades = await fetchMT5History(45);
    setMt5Trades(trades);
    if (trades.length) {
      const cur = await loadHistory();
      let changed = false;
      const next = cur.map(s => {
        const t = matchTradeToSignal(s, trades);
        if (!t) return s;
        const patch = { mt5Ticket: s.mt5Ticket || t.ticket, realizedUsd: t.profit, mt5State: t.state };
        if (t.state === "closed") {
          patch.outcome = t.profit >= 0 ? "win" : "loss";
          if (t.close_time) patch.closedAt = t.close_time * 1000;   // for cooldown guardrail
        }
        const same = s.outcome===patch.outcome && s.realizedUsd===patch.realizedUsd && s.mt5State===patch.mt5State && String(s.mt5Ticket)===String(patch.mt5Ticket) && s.closedAt===patch.closedAt;
        if (!same) changed = true;
        return { ...s, ...patch };
      });
      if (changed) { await saveHistory(next); setHistory(next); }
    }
    setLastSync(Date.now());
  }, [setHistory]);

  // On mount: load history, then sync from MT5; refresh trades every 20s.
  useEffect(() => {
    setLoading(true);
    loadHistory().then(h => { setHistory(h); setLoading(false); syncFromMT5(); });
    const iv = setInterval(syncFromMT5, 20000);
    return () => clearInterval(iv);
  }, [syncFromMT5, setHistory]);

  const setManualOutcome = async (id, outcome) => { setHistory(await updateOutcome(id, outcome)); };

  const clearAll = async () => {
    if (!window.confirm("Clear all AlphaEdge signal history?")) return;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify([])); } catch {}
    try { localStorage.removeItem(SIGNAL_LEARNING_KEY); } catch {}
    setHistory([]);
  };

  // Manual "Export to Obsidian" — force-writes every month (incl. the current,
  // in-progress one) to E:\Obsidian\Trading_Mind\raw\trades\alphaedge\ via the
  // bridge. Complements the automatic month-end catch-up that runs on load.
  const exportObsidian = async () => {
    setExportMsg("exporting…");
    const r = await exportMonthlyToObsidian({ includeCurrent: true, force: true });
    if (r.error)                    setExportMsg(`✗ ${r.error}`);
    else if (r.written?.length)     setExportMsg(`✓ exported ${r.written.join(", ")}${r.failed?.length ? ` · failed ${r.failed.join(", ")}` : ""}`);
    else if (r.failed?.length)      setExportMsg(`✗ failed ${r.failed.join(", ")} (bridge running?)`);
    else                            setExportMsg(r.note || "nothing to export");
    setTimeout(() => setExportMsg(null), 7000);
  };

  // ── Trade matching + effective status (MT5 first, manual fallback) ──────────
  const tradeFor = (sig) => matchTradeToSignal(sig, mt5Trades);
  const statusOf = (sig, t) => {
    if (t) {
      if (t.state === "open") return { key:"open", label:"OPEN", color:"#f59e0b", live:true };
      return t.profit >= 0
        ? { key:"win",  label:"WIN",  color:"#22c55e" }
        : { key:"loss", label:"LOSS", color:"#ef4444" };
    }
    const b = outcomeBucket(sig);
    if (b === "pending") return { key:"pending", label: sig.tradeType==="Paper" ? "PAPER" : "PENDING", color:"#94a3b8" };
    return { key:b, label: outcomeLabel[b]||b.toUpperCase(), color: outcomeColor[b]||"#94a3b8" };
  };

  // ── Filters ──────────────────────────────────────────────────────────────
  const filtered = history.filter(s => {
    if (filterAsset   !== "ALL" && s.assetId !== filterAsset) return false;
    if (filterBias    !== "ALL" && s.bias    !== filterBias)  return false;
    if (filterNature  !== "ALL" && s.nature  !== filterNature) return false;
    if (filterOutcome !== "ALL") {
      const st = statusOf(s, tradeFor(s));
      if (st.key !== filterOutcome) return false;
    }
    return true;
  });

  // ── Summary metrics ────────────────────────────────────────────────────────
  const resolved = history.filter(isResolvedSignal);
  const wins   = resolved.filter(isWinSignal).length;
  const losses = resolved.filter(isLossSignal).length;
  const openCt = history.filter(s => { const t=tradeFor(s); return t && t.state==="open"; }).length;
  const pending = history.filter(s => outcomeBucket(s)==="pending" && !(tradeFor(s))).length;
  const winRate = resolved.length ? ((wins/resolved.length)*100).toFixed(1) : "—";
  const netR = resolved.reduce((a,s)=>a+signalPnlR(s),0);
  const netUsd = history.reduce((a,s)=>{ const t=tradeFor(s); return a + (t && Number.isFinite(t.profit) ? t.profit : 0); }, 0);
  const hasUsd = mt5Trades.length > 0;

  // ── Performance aggregation — profitable strategy / timeframe / RR ──────────
  const perfBy = (keyFn) => {
    const groups = {};
    resolved.forEach(s => {
      const key = keyFn(s) || "—";
      if (!groups[key]) groups[key] = { key, trades:0, wins:0, losses:0, netR:0, netUsd:0, sumRR:0, rrN:0 };
      const g = groups[key];
      g.trades += 1;
      if (isWinSignal(s))  g.wins += 1;
      if (isLossSignal(s)) g.losses += 1;
      g.netR += signalPnlR(s);
      const t = tradeFor(s); if (t && Number.isFinite(t.profit)) g.netUsd += t.profit;
      const rr = Number(s.riskReward||0); if (rr>0){ g.sumRR += rr; g.rrN += 1; }
    });
    return Object.values(groups).map(g => ({ ...g,
      winRate: g.trades ? g.wins/g.trades*100 : 0,
      avgRR:   g.rrN ? g.sumRR/g.rrN : 0,
    })).sort((a,b)=> b.netR - a.netR);
  };
  const rrBucket = (rr) => !rr ? "—" : rr < 1.5 ? "<1:1.5" : rr < 2 ? "1:1.5–2" : rr < 3 ? "1:2–3" : "1:3+";
  const perfTables = [
    { title:"By Strategy",  keyLabel:"Strategy",  rows:perfBy(s => s.setup || s.source || "—") },
    { title:"By Timeframe", keyLabel:"Timeframe", rows:perfBy(s => s.timeframe || "—") },
    { title:"By RR Ratio",  keyLabel:"RR Ratio",  rows:perfBy(s => rrBucket(Number(s.riskReward||0))) },
    // Session derived live from each signal's own time+asset (covers old + new) —
    // reveals the profitable window (gold London-NY overlap, NSE afternoon, etc.)
    { title:"By Session",   keyLabel:"Session",   rows:perfBy(s => s.session || marketSession(s.asset, s.timestamp).session) },
  ];

  // ── Formatters ──────────────────────────────────────────────────────────────
  const fmtDay  = ts => new Date(ts).toLocaleDateString("en-IN",{day:"2-digit",month:"short",timeZone:"Asia/Kolkata"});
  const fmtTime = ts => new Date(ts).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Asia/Kolkata"});
  const fmtDate = ts => `${fmtDay(ts)} ${fmtTime(ts)} IST`;
  const fmtPx   = v => Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-IN",{maximumFractionDigits:2}) : "—";
  const styleMeta = n => n==="Scalping" ? {c:"#f43f5e",i:"⚡"} : n==="Swing" ? {c:"#60a5fa",i:"📈"} : {c:"#f59e0b",i:"🕐"};
  const wrColor = w => w>=60?"#22c55e":w>=45?"#f59e0b":"#ef4444";

  const broadcastSignal = async (sig) => {
    setTgFlash(f=>({...f,[sig.id]:"sending"}));
    const parsed = { bias:sig.bias, nature:sig.nature||"Intraday", confidence:sig.confidence, setup:sig.setup,
      entry:sig.entry, stopLoss:sig.stopLoss, takeProfit1:sig.takeProfit1, takeProfit2:sig.takeProfit2,
      riskReward:sig.riskReward, killZone:sig.killZone, summary:sig.summary, invalidation:sig.invalidation, riskWarning:sig.riskWarning };
    const tgR = await sendTelegram(buildTelegramMessage(parsed, sig.asset, sig.timeframe));
    setTgFlash(f=>({...f,[sig.id]:tgR.ok?"sent":"failed"}));
    setTimeout(()=>setTgFlash(f=>{const n={...f};delete n[sig.id];return n;}),4000);
  };

  const head = ["Date / Time","Symbol","Signal","Strategy","Style","Entry","SL","TP","RR","Status","Result ($)"];
  const th = (t,extra={}) => <th key={t} style={{padding:"8px 9px",textAlign:"left",fontSize:8,color:"#94a3b8",letterSpacing:"0.07em",borderBottom:"0.5px solid #1e3a5a",whiteSpace:"nowrap",...extra}}>{t.toUpperCase()}</th>;

  return (
    <div style={{height:"100%",overflow:"auto"}}>
      <div style={{maxWidth:1280,margin:"0 auto",display:"flex",flexDirection:"column",gap:10}}>

        {/* ── Summary strip ── */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:"12px 16px",display:"flex",alignItems:"center",gap:18,flexWrap:"wrap"}}>
          <div style={{fontSize:10,color:"#94a3b8",letterSpacing:"0.12em",fontWeight:700}}>TRADE HISTORY</div>
          {[
            {l:"Total",   v:history.length,                          c:"#e2e8f0"},
            {l:"Wins",    v:wins,                                     c:"#22c55e"},
            {l:"Losses",  v:losses,                                   c:"#ef4444"},
            {l:"Open",    v:openCt,                                   c:"#f59e0b"},
            {l:"Win Rate",v:resolved.length?`${winRate}%`:"—",        c:resolved.length?wrColor(parseFloat(winRate)):"#94a3b8"},
            {l:"Net R",   v:`${netR>=0?"+":""}${netR.toFixed(1)}R`,   c:netR>=0?"#22c55e":"#ef4444"},
            {l:"MT5 P&L", v:hasUsd?`${netUsd>=0?"+":""}$${netUsd.toFixed(2)}`:"—", c:hasUsd?(netUsd>=0?"#22c55e":"#ef4444"):"#94a3b8"},
          ].map(m=>(
            <div key={m.l} style={{textAlign:"center",minWidth:56}}>
              <div style={{fontSize:8,color:"#7c8ea8",letterSpacing:"0.06em"}}>{m.l.toUpperCase()}</div>
              <div style={{fontSize:18,fontWeight:800,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
            </div>
          ))}
          <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center"}}>
            <button onClick={async()=>{ setLoading(true); const h=await loadHistory(); setHistory(h); await syncFromMT5(); setLoading(false); }}
              style={{fontSize:10,padding:"5px 12px",background:"#111e30",border:"0.5px solid #1e3a5a",borderRadius:6,color:"#60a5fa",cursor:"pointer",fontFamily:"monospace"}}>
              {loading?"◌":"⟳"} Sync MT5
            </button>
            <button onClick={exportObsidian} disabled={exportMsg==="exporting…"}
              title="Write monthly trade rollups to E:\Obsidian\Trading_Mind\raw\trades\alphaedge\"
              style={{fontSize:10,padding:"5px 12px",background:"#0a1f14",border:"0.5px solid #22c55e40",borderRadius:6,color:"#22c55e",cursor:"pointer",fontFamily:"monospace"}}>
              {exportMsg==="exporting…"?"◌ Exporting…":"⬍ Export → Obsidian"}
            </button>
            <button onClick={clearAll}
              style={{fontSize:10,padding:"5px 12px",background:"#1a0000",border:"0.5px solid #ef444430",borderRadius:6,color:"#ef4444",cursor:"pointer",fontFamily:"monospace"}}>
              ✕ Clear
            </button>
          </div>
        </div>

        {exportMsg && exportMsg!=="exporting…" && (
          <div style={{fontSize:9,color:exportMsg.startsWith("✓")?"#22c55e":"#f59e0b",padding:"0 4px",fontFamily:"monospace"}}>
            Obsidian export: {exportMsg}
          </div>
        )}

        {/* Source note */}
        <div style={{display:"flex",alignItems:"center",gap:8,fontSize:9,color:"#7c8ea8",padding:"0 4px",flexWrap:"wrap"}}>
          <span style={{color:mt5Trades.length?"#22c55e":"#f59e0b"}}>●</span>
          <span>Outcomes auto-synced from MT5 Terminal (Trade + History tabs) · AlphaEdge trades only (magic 532025)</span>
          {lastSync && <span style={{marginLeft:"auto"}}>last sync {fmtTime(lastSync)} IST · {mt5Trades.length} MT5 trade{mt5Trades.length!==1?"s":""}</span>}
        </div>

        {/* ── Filters ── */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:10,padding:"9px 14px",display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"}}>
          <span style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.08em"}}>FILTER</span>
          <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
            {["ALL",...ASSETS.map(a=>a.id)].map(v=>(
              <span key={v} onClick={()=>setFilterAsset(v)} style={{fontSize:9,padding:"3px 9px",borderRadius:5,cursor:"pointer",fontFamily:"monospace",background:filterAsset===v?"#1e3a5a":"#060d17",color:filterAsset===v?"#60a5fa":"#94a3b8",border:`0.5px solid ${filterAsset===v?"#3b82f6":"#1e3a5a"}`}}>
                {v==="ALL"?"All":ASSETS.find(a=>a.id===v)?.label||v}
              </span>
            ))}
          </div>
          <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
            {[["ALL","All Outcomes"],["open","OPEN"],["win","WIN"],["loss","LOSS"],["pending","PENDING"]].map(([v,l])=>(
              <span key={v} onClick={()=>setFilterOutcome(v)} style={{fontSize:9,padding:"3px 9px",borderRadius:5,cursor:"pointer",fontFamily:"monospace",background:filterOutcome===v?"#1e3a5a":"#060d17",color:filterOutcome===v?"#60a5fa":outcomeColor[v]||"#94a3b8",border:`0.5px solid ${filterOutcome===v?"#3b82f6":"#1e3a5a"}`}}>{l}</span>
            ))}
          </div>
          <div style={{display:"flex",gap:3}}>
            {[{v:"ALL",l:"All"},{v:"Scalping",l:"⚡ Scalp"},{v:"Intraday",l:"🕐 Intraday"},{v:"Swing",l:"📈 Swing"}].map(({v,l})=>(
              <span key={v} onClick={()=>setFilterNature(v)} style={{fontSize:9,padding:"3px 9px",borderRadius:5,cursor:"pointer",fontFamily:"monospace",background:filterNature===v?"#1e3a5a":"#060d17",color:filterNature===v?"#60a5fa":"#94a3b8",border:`0.5px solid ${filterNature===v?"#3b82f6":"#1e3a5a"}`}}>{l}</span>
            ))}
          </div>
          <span style={{marginLeft:"auto",fontSize:9,color:"#7c8ea8"}}>{filtered.length} shown</span>
        </div>

        {/* ── Empty / loading ── */}
        {loading && (
          <div style={{background:"#0a1628",border:"0.5px dashed #1e3a5a",borderRadius:12,padding:34,textAlign:"center"}}>
            <div style={{fontSize:22,color:"#64748b",animation:"spin 1s linear infinite",display:"inline-block"}}>◷</div>
            <div style={{fontSize:12,color:"#7c8ea8",marginTop:8,fontFamily:"monospace"}}>Loading & syncing from MT5…</div>
          </div>
        )}
        {!loading && history.length===0 && (
          <div style={{background:"#0a1628",border:"0.5px dashed #1e3a5a",borderRadius:12,padding:44,textAlign:"center"}}>
            <div style={{fontSize:34,color:"#64748b",marginBottom:10}}>◷</div>
            <div style={{fontSize:13,color:"#7c8ea8"}}>No AlphaEdge trades yet</div>
            <div style={{fontSize:10,color:"#64748b",marginTop:6}}>Signals generated by AlphaEdge appear here and their outcomes sync from MT5.</div>
          </div>
        )}

        {/* ── Main table ── */}
        {!loading && history.length>0 && (
          <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,overflow:"hidden"}}>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",minWidth:1080}}>
                <thead><tr style={{background:"#07111f"}}>{head.map(h=>th(h, h==="Result ($)"?{textAlign:"right"}:{}))}</tr></thead>
                <tbody>
                  {filtered.map(sig=>{
                    const bc = biasColor[sig.bias]||"#94a3b8";
                    const sm = styleMeta(sig.nature);
                    const t  = tradeFor(sig);
                    const st = statusOf(sig, t);
                    const isExp = expanded===sig.id;
                    const sideTxt = sig.bias==="BULLISH"?"BUY":sig.bias==="BEARISH"?"SELL":(sig.bias||"—");
                    const pnl = t && Number.isFinite(t.profit) ? t.profit : null;
                    return (
                      <React.Fragment key={sig.id}>
                        <tr onClick={()=>setExpanded(isExp?null:sig.id)} style={{cursor:"pointer",borderBottom:"0.5px solid #102033",background:isExp?"#0d1b2d":"#0a1628",borderLeft:`2px solid ${bc}`}}>
                          <td style={{padding:"9px 9px",whiteSpace:"nowrap"}}><div style={{fontSize:10,color:"#e2e8f0",fontFamily:"monospace"}}>{fmtDay(sig.timestamp)}</div><div style={{fontSize:9,color:"#7c8ea8",fontFamily:"monospace"}}>{fmtTime(sig.timestamp)} IST</div></td>
                          <td style={{padding:"9px 9px",whiteSpace:"nowrap"}}><div style={{fontWeight:700,color:"#e2e8f0",fontSize:11}}>{sig.asset}</div><div style={{fontSize:9,color:"#3b82f6"}}>{sig.timeframe||"—"}</div></td>
                          <td style={{padding:"9px 9px",whiteSpace:"nowrap"}}><span style={{color:bc,fontWeight:800,fontFamily:"monospace",fontSize:10}}>{sig.bias==="BULLISH"?"▲":sig.bias==="BEARISH"?"▼":"◆"} {sideTxt}</span></td>
                          <td style={{padding:"9px 9px",whiteSpace:"nowrap"}}><span style={{display:"inline-block",maxWidth:170,overflow:"hidden",textOverflow:"ellipsis",verticalAlign:"bottom",color:"#cbd5e1",background:"#111e30",border:"0.5px solid #1e3a5a",padding:"2px 7px",borderRadius:4,fontWeight:600,fontSize:10}} title={sig.setup}>{sig.setup||sig.source||"—"}</span></td>
                          <td style={{padding:"9px 9px",textAlign:"center",whiteSpace:"nowrap"}}><span style={{color:sm.c,fontSize:10,fontWeight:600}}>{sm.i} {sig.nature||"—"}</span></td>
                          <td style={{padding:"9px 9px",fontFamily:"monospace",fontSize:10,color:"#e2e8f0",whiteSpace:"nowrap"}}>{fmtPx(sig.entry)}</td>
                          <td style={{padding:"9px 9px",fontFamily:"monospace",fontSize:10,color:"#ef4444",whiteSpace:"nowrap"}}>{fmtPx(sig.stopLoss)}</td>
                          <td style={{padding:"9px 9px",fontFamily:"monospace",fontSize:10,color:"#22c55e",whiteSpace:"nowrap"}}>{fmtPx(sig.takeProfit1)}</td>
                          <td style={{padding:"9px 9px",fontFamily:"monospace",fontSize:10,color:"#60a5fa",whiteSpace:"nowrap"}}>{Number.isFinite(Number(sig.riskReward))?`1:${Number(sig.riskReward).toFixed(1)}`:"—"}</td>
                          <td style={{padding:"9px 9px",whiteSpace:"nowrap"}}>
                            <span style={{color:st.color,background:st.color+"18",border:`0.5px solid ${st.color}40`,borderRadius:4,padding:"2px 8px",fontFamily:"monospace",fontWeight:700,fontSize:9}}>
                              {st.live?"● ":""}{st.label}
                            </span>
                          </td>
                          <td style={{padding:"9px 9px",textAlign:"right",fontFamily:"monospace",fontWeight:800,fontSize:10,whiteSpace:"nowrap",color:pnl==null?"#64748b":pnl>=0?"#22c55e":"#ef4444"}}>
                            {pnl==null ? "—" : `${pnl>=0?"+":""}$${pnl.toFixed(2)}`}
                          </td>
                        </tr>
                        {isExp && (
                          <tr>
                            <td colSpan={11} style={{padding:0,background:"#07111f",borderBottom:"0.5px solid #1e3a5a"}}>
                              <div style={{padding:14,display:"grid",gridTemplateColumns:"2fr 1fr 1fr",gap:10}}>
                                <div style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:8,padding:"10px 12px"}}>
                                  <div style={{fontSize:8,color:"#94a3b8",marginBottom:5}}>SIGNAL SUMMARY</div>
                                  <div style={{fontSize:11,color:"#cbd5e1",lineHeight:1.55}}>{sig.summary||"—"}</div>
                                  <div style={{marginTop:8,display:"flex",gap:14,flexWrap:"wrap"}}>
                                    <span style={{fontSize:10,color:"#94a3b8"}}>TP2: <span style={{color:"#34d399",fontFamily:"monospace"}}>{fmtPx(sig.takeProfit2)}</span></span>
                                    <span style={{fontSize:10,color:"#94a3b8"}}>Conf: <span style={{color:bc}}>{sig.confidence||"—"}%</span></span>
                                    <span style={{fontSize:10,color:"#94a3b8"}}>Kill Zone: <span style={{color:"#f59e0b"}}>{sig.killZone||"—"}</span></span>
                                  </div>
                                </div>
                                <div style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:8,padding:"10px 12px"}}>
                                  <div style={{fontSize:8,color:"#94a3b8",marginBottom:5}}>MT5 TRADE</div>
                                  {t ? (<>
                                    <div style={{fontSize:10,color:"#94a3b8",lineHeight:1.7}}>Ticket: <span style={{color:"#60a5fa",fontFamily:"monospace"}}>#{t.ticket}</span></div>
                                    <div style={{fontSize:10,color:"#94a3b8",lineHeight:1.7}}>State: <span style={{color:st.color}}>{t.state}</span></div>
                                    <div style={{fontSize:10,color:"#94a3b8",lineHeight:1.7}}>Open: <span style={{color:"#e2e8f0",fontFamily:"monospace"}}>{fmtPx(t.open_price)}</span>{t.close_price?<> → <span style={{color:"#e2e8f0",fontFamily:"monospace"}}>{fmtPx(t.close_price)}</span></>:""}</div>
                                    <div style={{fontSize:10,color:"#94a3b8",lineHeight:1.7}}>Vol: <span style={{color:"#e2e8f0",fontFamily:"monospace"}}>{t.volume}</span> · P&L <span style={{color:t.profit>=0?"#22c55e":"#ef4444",fontFamily:"monospace"}}>{t.profit>=0?"+":""}${t.profit.toFixed(2)}</span></div>
                                  </>) : (
                                    <div style={{fontSize:10,color:"#7c8ea8",lineHeight:1.6}}>
                                      No MT5 trade linked ({sig.tradeType==="Paper"?"paper signal":"not executed"}).
                                      <div style={{marginTop:6,display:"flex",gap:3,flexWrap:"wrap"}}>
                                        {[["pending","PEND"],["win","WIN"],["loss","LOSS"]].map(([v,l])=>(
                                          <button key={v} onClick={(e)=>{e.stopPropagation();setManualOutcome(sig.id,v);}} style={{fontSize:8,padding:"2px 7px",borderRadius:4,cursor:"pointer",fontFamily:"monospace",fontWeight:700,background:sig.outcome===v?(outcomeColor[v]||"#64748b")+"30":"#0a1628",color:sig.outcome===v?(outcomeColor[v]||"#94a3b8"):"#64748b",border:`0.5px solid ${sig.outcome===v?(outcomeColor[v]||"#64748b")+"70":"#1e3a5a"}`}}>{l}</button>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                                <div style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:8,padding:"10px 12px"}}>
                                  <div style={{fontSize:8,color:"#ef4444",marginBottom:5}}>RISK NOTES</div>
                                  <div style={{fontSize:10,color:"#94a3b8",lineHeight:1.5}}>{sig.invalidation||"Invalidation: SL hit."}</div>
                                  <div style={{fontSize:10,color:"#f59e0b",lineHeight:1.5,marginTop:6}}>{sig.riskWarning||""}</div>
                                  <div onClick={(e)=>{e.stopPropagation();broadcastSignal(sig);}} style={{marginTop:8,fontSize:10,color:"#60a5fa",cursor:"pointer",fontFamily:"monospace"}}>
                                    {tgFlash[sig.id]==="sending"?"◌ sending…":tgFlash[sig.id]==="sent"?"✅ sent":tgFlash[sig.id]==="failed"?"❌ failed":"✈️ Re-broadcast"}
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {filtered.length===0 && <tr><td colSpan={11} style={{padding:26,textAlign:"center",fontSize:11,color:"#7c8ea8"}}>No signals match the selected filters.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Performance Record ── */}
        {resolved.length>0 && (
          <div style={{background:"#0a1628",border:"0.5px solid #22c55e30",borderRadius:12,padding:"12px 14px"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,flexWrap:"wrap"}}>
              <span style={{fontSize:12,fontWeight:700,color:"#22c55e"}}>📊 Performance Record</span>
              <span style={{fontSize:10,color:"#7c8ea8"}}>What's actually profitable — from {resolved.length} resolved trade{resolved.length!==1?"s":""}</span>
              <span style={{marginLeft:"auto",fontSize:9,color:"#64748b"}}>green ✓ = net positive · Net R from R-multiples · $ from MT5</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}>
              {perfTables.map(({title,keyLabel,rows})=>{
                const best = rows.filter(r=>r.netR>0)[0];
                return (
                  <div key={title} style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:8,overflow:"hidden"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,padding:"8px 10px",borderBottom:"0.5px solid #1e3a5a"}}>
                      <span style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.08em",fontWeight:700}}>{title.toUpperCase()}</span>
                      {best && <span style={{marginLeft:"auto",fontSize:8,color:"#22c55e",background:"#052e16",padding:"1px 6px",borderRadius:3,border:"0.5px solid #22c55e40",maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>★ {best.key}</span>}
                    </div>
                    <div style={{overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",minWidth:330}}>
                        <thead><tr style={{background:"#07111f"}}>
                          {[keyLabel,"Trades","Win%","Avg RR","Net R","$",""].map(h=>(
                            <th key={h} style={{padding:"6px 7px",textAlign:h===keyLabel?"left":"right",fontSize:8,color:"#7c8ea8",letterSpacing:"0.04em",borderBottom:"0.5px solid #1e3a5a",whiteSpace:"nowrap"}}>{h.toUpperCase()}</th>
                          ))}
                        </tr></thead>
                        <tbody>
                          {rows.map(g=>{ const good=g.netR>0; return (
                            <tr key={g.key} style={{borderBottom:"0.5px solid #102033"}}>
                              <td style={{padding:"7px 7px",fontSize:10,color:"#e2e8f0",fontWeight:600,whiteSpace:"nowrap",maxWidth:110,overflow:"hidden",textOverflow:"ellipsis"}} title={g.key}>{g.key}</td>
                              <td style={{padding:"7px 7px",fontSize:10,color:"#94a3b8",textAlign:"right",fontFamily:"monospace"}}>{g.trades}</td>
                              <td style={{padding:"7px 7px",fontSize:10,textAlign:"right",fontFamily:"monospace",color:wrColor(g.winRate)}}>{g.winRate.toFixed(0)}%</td>
                              <td style={{padding:"7px 7px",fontSize:10,color:"#60a5fa",textAlign:"right",fontFamily:"monospace"}}>{g.avgRR?`1:${g.avgRR.toFixed(1)}`:"—"}</td>
                              <td style={{padding:"7px 7px",fontSize:10,textAlign:"right",fontFamily:"monospace",fontWeight:800,color:good?"#22c55e":"#ef4444"}}>{good?"+":""}{g.netR.toFixed(1)}</td>
                              <td style={{padding:"7px 7px",fontSize:9,textAlign:"right",fontFamily:"monospace",color:g.netUsd>=0?"#69db7c":"#f85149"}}>{g.netUsd?`${g.netUsd>=0?"+":""}${g.netUsd.toFixed(0)}`:"—"}</td>
                              <td style={{padding:"7px 5px",fontSize:10,textAlign:"center"}}>{good?<span style={{color:"#22c55e"}}>✓</span>:<span style={{color:"#ef4444"}}>✕</span>}</td>
                            </tr>
                          );})}
                          {rows.length===0 && <tr><td colSpan={7} style={{padding:14,textAlign:"center",fontSize:10,color:"#64748b"}}>No data yet</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}


// ─── OPTIONS DESK — live Greeks/IV strike selector ───────────────────────────
// Surfaces delta / IV / OI for ATM±N strikes and recommends the right strike to
// BUY, flagging the audit's flaws (far-OTM lottery, 0-DTE, premium floor).
// ─── OPTIONS REGIME ENGINE ────────────────────────────────────────────────────
// ─── INDEX LOT SIZES (live from Dhan) ─────────────────────────────────────────
// NSE/BSE revise F&O lot sizes periodically, so rather than hardcode them we pull
// the current values from Dhan's scrip master (Settings → "Update lot sizes")
// and cache them. Futures and options share the same lot per index. Defaults
// below are the last-known values, used until a refresh runs.
const LOT_SIZE_DEFAULTS = { NIFTY50: 65, BANKNIFTY: 30, SENSEX: 20, FINNIFTY: 60 };
const APP_TO_DHAN = { NIFTY50: "NIFTY", BANKNIFTY: "BANKNIFTY", SENSEX: "SENSEX", FINNIFTY: "FINNIFTY" };

function getStoredLots() {
  try { return JSON.parse(localStorage.getItem("alphaedge_lot_sizes") || "{}"); }
  catch { return {}; }
}
// Lot size for an app symbol (NIFTY50/BANKNIFTY/SENSEX/…): live value if fetched,
// else the last-known default.
function getLotSize(appSym) {
  const stored = getStoredLots();
  const dhanKey = APP_TO_DHAN[appSym] || appSym;
  const live = Number(stored[dhanKey]);
  return live > 0 ? live : (LOT_SIZE_DEFAULTS[appSym] || 50);
}
function getLotsUpdatedAt() {
  return localStorage.getItem("alphaedge_lot_sizes_updated") || "";
}

// Pull current index lot sizes from Dhan's scrip master via the bridge and cache
// them. Returns {ok, lots, updated} | {ok:false, error}.
async function refreshLotSizes() {
  const base = (getAnyBridgeUrl() || "").replace(/\/signal\/?$/, "");
  if (!base) return { ok: false, error: "No bridge URL set (Settings → MT5 Terminal)." };
  try {
    const r = await fetch(`${base}/dhan/lotsizes`, { signal: AbortSignal.timeout(70000) });
    const d = await r.json();
    if (d && d.ok && d.lots && Object.keys(d.lots).length) {
      localStorage.setItem("alphaedge_lot_sizes", JSON.stringify(d.lots));
      localStorage.setItem("alphaedge_lot_sizes_updated", d.updated || new Date().toISOString());
      return { ok: true, lots: d.lots, updated: d.updated };
    }
    return { ok: false, error: d?.error || "Bridge returned no lot sizes." };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Exponential moving average series.
function emaSeries(vals, period) {
  if (!vals.length) return [];
  const k = 2 / (period + 1);
  let prev = vals[0];
  const out = [prev];
  for (let i = 1; i < vals.length; i++) { prev = vals[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}

// Detect the market regime from the underlying's candles + the option chain, and
// recommend NO_TRADE / BUY_CALL / BUY_PUT. Long options need a directional trend
// and reasonable IV; ranges and rich IV are buyer-hostile (theta/vega bleed).
function detectOptionsRegime({ candles, chain, guardrails }) {
  const reasons = [];

  // ── Trend from candles (EMA20 vs EMA50 + slope) ──
  let trend = "unknown", slopePct = 0, emaGap = 0, strength = 0;
  if (candles && candles.length >= 30) {
    const closes = candles.map(c => c.close);
    const e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50);
    const last = closes[closes.length - 1], l20 = e20[e20.length - 1], l50 = e50[e50.length - 1];
    const prev20 = e20[Math.max(0, e20.length - 6)] || l20;
    slopePct = l20 ? (l20 - prev20) / l20 * 100 : 0;
    emaGap   = l50 ? (l20 - l50) / l50 * 100 : 0;
    if (last > l20 && l20 >= l50 && slopePct > 0.02) trend = "up";
    else if (last < l20 && l20 <= l50 && slopePct < -0.02) trend = "down";
    else trend = "range";
    strength = Math.min(1, Math.abs(emaGap) / 0.5 + Math.abs(slopePct) / 0.2);
    reasons.push(`Trend: ${trend === "up" ? "↑ price > EMA20 > EMA50" : trend === "down" ? "↓ price < EMA20 < EMA50" : "→ EMAs flat / mixed"} (slope ${slopePct.toFixed(2)}%, EMA gap ${emaGap.toFixed(2)}%)`);
  } else {
    reasons.push("Trend: not enough candles — bridge/market may be off; using chain signals only.");
  }

  // ── Volatility from ATM IV percentile ──
  const ivp = chain?.ivPercentile;
  const volState = ivp == null ? "unknown" : ivp > 75 ? "rich" : ivp < 30 ? "cheap" : "normal";
  if (ivp != null) reasons.push(`IV ${ivp}th pct — options ${volState === "rich" ? "expensive (buyer-hostile)" : volState === "cheap" ? "cheap (buyer-friendly)" : "fairly priced"}`);

  // ── PCR + ATM IV skew from the chain ──
  let pcr = null, skew = null;
  if (chain?.strikes?.length) {
    const ceOI = chain.strikes.reduce((a, s) => a + (s.ce?.oi || 0), 0);
    const peOI = chain.strikes.reduce((a, s) => a + (s.pe?.oi || 0), 0);
    pcr = ceOI ? peOI / ceOI : null;
    const atmRow = chain.strikes.find(s => s.atm) || chain.strikes[Math.floor(chain.strikes.length / 2)];
    if (atmRow) skew = (atmRow.pe?.iv || 0) - (atmRow.ce?.iv || 0);
    if (pcr != null) reasons.push(`PCR ${pcr.toFixed(2)} (${pcr > 1.2 ? "bullish — put writers supporting" : pcr < 0.8 ? "bearish — call writers capping" : "neutral"})`);
    if (skew != null) reasons.push(`ATM IV skew ${skew > 0 ? "+" : ""}${skew.toFixed(1)} (${skew > 1 ? "put bid — downside fear" : skew < -1 ? "call bid — upside demand" : "flat"})`);
  }

  // ── Decide ──
  const expiryBlock = chain?.isExpiryToday && guardrails?.blockExpiryDay;
  let suggestion = "NO_TRADE", why;
  if (expiryBlock)                              why = "Expiry day (0-DTE) — guardrail blocks buying.";
  else if (trend === "range")                   why = "Sideways / choppy — long options bleed theta in a range.";
  else if (volState === "rich" && strength < 0.6) why = "IV rich without a strong trend — poor risk/reward for buyers.";
  else if (trend === "up")   { suggestion = "BUY_CALL"; why = `Uptrend${pcr > 1.2 ? " + supportive PCR" : ""}${skew < 0 ? " + call demand" : ""}.`; }
  else if (trend === "down") { suggestion = "BUY_PUT";  why = `Downtrend${pcr < 0.8 ? " + weak PCR" : ""}${skew > 1 ? " + downside fear" : ""}.`; }
  else                                          why = "No clear directional edge.";
  reasons.push(why);

  const label = suggestion !== "NO_TRADE"
    ? `${trend === "up" ? "Uptrend" : "Downtrend"}${volState === "cheap" ? " · cheap IV" : volState === "rich" ? " · rich IV" : ""}`
    : expiryBlock ? "0-DTE — Stand aside"
    : trend === "range" ? "Range / Chop — Stand aside"
    : volState === "rich" ? "High IV, no trend — Stand aside"
    : "No edge — Stand aside";

  return { suggestion, label, why, trend, volState, ivp, pcr, skew, strength, reasons };
}

// Position plan for a chosen option leg, sized from Money Mgt (capital + RR + SL)
// and the risk policy (max % account risk per trade).
function optionsTradePlan({ rec, underlying, mm, riskPct }) {
  if (!rec || !(rec.ltp > 0)) return null;
  const lotUnits = getLotSize(underlying);
  const capital  = Number(mm.capital) || 0;
  const budget   = capital * (riskPct / 100);             // ₹ risk allowed this trade
  const entry    = Number(rec.ltp) || 0;
  // SL on the premium: fixed points if the user set one and it's sane, else 30%
  // of premium; never more than the premium itself (max loss on a long option).
  let slPts = (mm.useSL && mm.slPoints > 0) ? Number(mm.slPoints) : Math.round(entry * 0.30);
  slPts = Math.max(1, Math.min(slPts, Math.floor(entry)));
  const rr = mm.rr === "trail" ? (Number(mm.trailMaxRR) || 3) : (Number(mm.rr) || 2);
  const tgtPts = +(slPts * rr).toFixed(2);
  const riskPerLot = slPts * lotUnits;
  const lots = riskPerLot > 0 ? Math.floor(budget / riskPerLot) : 0;
  return {
    lotUnits, capital, riskPct, budget, entry, slPts, tgtPts, rr, lots,
    slPrice:  +(entry - slPts).toFixed(2),
    tgtPrice: +(entry + tgtPts).toFixed(2),
    riskRs:   lots * riskPerLot,
    rewardRs: lots * tgtPts * lotUnits,
    outlayRs: lots * entry * lotUnits,
    oneLotRisk: riskPerLot,
    affordable: lots >= 1,
  };
}

function OptionsDeskPage() {
  const [underlying, setUnderlying] = useState("NIFTY50");
  const [dir, setDir]   = useState("CALL");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]   = useState("");
  const [candles, setCandles] = useState([]);   // underlying candles for regime
  const [autoDir, setAutoDir] = useState(true);  // let the regime pick CALL/PUT

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    const [r, cs] = await Promise.all([
      fetchOptionChain(underlying, 6),
      fetchDhanChartCandles(underlying, "15m").catch(() => null),
    ]);
    if (r && r.ok) setData(r); else { setData(null); setErr(r?.error || "Option chain unavailable"); }
    setCandles(Array.isArray(cs) ? cs : []);
    setLoading(false);
  }, [underlying]);
  useEffect(()=>{ load(); }, [load]);

  const g = getGuardrails();
  const mm = getMoneyMgt();
  const riskPct = getRiskPolicy().maxRiskPct;

  // Market-regime read → NO_TRADE / BUY_CALL / BUY_PUT (recomputed on new data).
  const regime = useMemo(
    () => detectOptionsRegime({ candles, chain: data, guardrails: g }),
    // g is cheap/stable; depend on the live inputs only
    [candles, data], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Let the regime drive the CALL/PUT view unless the user has toggled manually.
  useEffect(() => {
    if (autoDir && regime.suggestion === "BUY_CALL") setDir("CALL");
    else if (autoDir && regime.suggestion === "BUY_PUT") setDir("PUT");
  }, [autoDir, regime.suggestion]);
  const label = { NIFTY50:"Nifty 50", BANKNIFTY:"Bank Nifty", SENSEX:"Sensex" }[underlying] || underlying;
  const fmt = v => Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-IN",{maximumFractionDigits:2}) : "—";

  let rec = null, legs = [];
  if (data) {
    legs = data.strikes.map(s => {
      const leg = dir==="CALL" ? s.ce : s.pe;
      return { strike:s.strike, atm:s.atm, ...leg, adelta:Math.abs(leg.delta||0) };
    });
    const eligible = legs.filter(l => l.ltp >= g.minPremium && l.adelta >= 0.35);
    rec = (eligible.length?eligible:legs).slice().sort((a,b)=>Math.abs(a.adelta-0.55)-Math.abs(b.adelta-0.55))[0];
  }
  const recFlags = [];
  if (rec) {
    if (data.isExpiryToday && g.blockExpiryDay) recFlags.push({c:"#ef4444",t:"🛑 Expiry day (0-DTE) — guardrail blocks this buy"});
    if (rec.ltp < g.minPremium) recFlags.push({c:"#f59e0b",t:`⚠ Premium ₹${fmt(rec.ltp)} below floor ₹${g.minPremium}`});
    if (rec.adelta < 0.4) recFlags.push({c:"#f59e0b",t:`⚠ OTM — delta ${rec.adelta.toFixed(2)} needs a big fast move`});
    if (data.ivPercentile != null && data.ivPercentile > 70) recFlags.push({c:"#f59e0b",t:`⚠ IV high (${data.ivPercentile}th pct) — options expensive to buy`});
    if (!recFlags.length) recFlags.push({c:"#22c55e",t:"✓ ATM/ITM with adequate premium — sound buy zone"});
  }
  const dirColor = dir==="CALL" ? "#22c55e" : "#ef4444";
  const plan = optionsTradePlan({ rec, underlying, mm, riskPct });
  const noTrade = regime.suggestion === "NO_TRADE";
  const sugColor = noTrade ? "#f59e0b" : regime.suggestion === "BUY_CALL" ? "#22c55e" : "#ef4444";
  const sugText  = noTrade ? "NO TRADE" : regime.suggestion === "BUY_CALL" ? "BUY CALLS" : "BUY PUTS";

  return (
    <div style={{height:"100%",overflow:"auto"}}>
      <div style={{maxWidth:1100,margin:"0 auto",display:"flex",flexDirection:"column",gap:10}}>

        {/* Controls */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:"12px 16px",display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{fontSize:10,color:"#94a3b8",letterSpacing:"0.12em",fontWeight:700}}>OPTIONS DESK</div>
          <div style={{display:"flex",gap:4}}>
            {["NIFTY50","BANKNIFTY","SENSEX"].map(u=>(
              <span key={u} onClick={()=>setUnderlying(u)} style={{fontSize:10,padding:"4px 10px",borderRadius:6,cursor:"pointer",fontFamily:"monospace",
                background:underlying===u?"#1e3a5a":"#060d17",color:underlying===u?"#60a5fa":"#94a3b8",border:`0.5px solid ${underlying===u?"#3b82f6":"#1e3a5a"}`}}>
                {u==="NIFTY50"?"Nifty":u==="BANKNIFTY"?"BankNifty":"Sensex"}
              </span>
            ))}
          </div>
          <div style={{display:"flex",gap:4,marginLeft:6}}>
            {["CALL","PUT"].map(d=>(
              <span key={d} onClick={()=>setDir(d)} style={{fontSize:10,padding:"4px 14px",borderRadius:6,cursor:"pointer",fontFamily:"monospace",fontWeight:700,
                background:dir===d?(d==="CALL"?"#052e16":"#1a0000"):"#060d17",color:dir===d?(d==="CALL"?"#22c55e":"#ef4444"):"#94a3b8",
                border:`0.5px solid ${dir===d?(d==="CALL"?"#22c55e":"#ef4444"):"#1e3a5a"}`}}>
                BUY {d}
              </span>
            ))}
          </div>
          {data && (
            <div style={{display:"flex",alignItems:"center",gap:8,marginLeft:"auto"}}>
              <span style={{fontSize:11,color:"#e2e8f0",fontFamily:"monospace"}}>{label} <b>{fmt(data.under_ltp)}</b></span>
              <span style={{fontSize:9,color:"#7c8ea8"}}>exp {data.expiry}</span>
              <span style={{fontSize:8,fontWeight:700,padding:"2px 7px",borderRadius:4,fontFamily:"monospace",
                background:data.stale?"#1c1300":"#052e16",color:data.stale?"#f59e0b":"#22c55e",border:`0.5px solid ${data.stale?"#f59e0b40":"#22c55e40"}`}}>
                {data.stale?`◷ ${String(data.snapshotTime||"").slice(5,16)} (closed)`:"● LIVE"}
              </span>
            </div>
          )}
          <button onClick={load} disabled={loading} style={{fontSize:10,padding:"5px 12px",background:"#111e30",border:"0.5px solid #1e3a5a",borderRadius:6,color:"#60a5fa",cursor:"pointer",fontFamily:"monospace"}}>
            {loading?"◌":"⟳"} Refresh
          </button>
        </div>

        {/* ── MARKET REGIME FILTER — buy calls / buy puts / stand aside ── */}
        {data && (
          <div style={{background:"#0a1628",border:`0.5px solid ${sugColor}55`,borderRadius:12,padding:"14px 16px"}}>
            <div style={{display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
              <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.12em",fontWeight:700}}>MARKET REGIME</div>
              <span style={{fontSize:15,fontWeight:900,letterSpacing:"0.04em",color:sugColor,
                background:sugColor+"18",border:`0.5px solid ${sugColor}55`,borderRadius:8,padding:"4px 14px",fontFamily:"monospace"}}>
                {noTrade?"⛔ ":regime.suggestion==="BUY_CALL"?"▲ ":"▼ "}{sugText}
              </span>
              <span style={{fontSize:11,color:"#e2e8f0",fontWeight:700}}>{regime.label}</span>
              <label style={{marginLeft:"auto",fontSize:10,color:"#7c8ea8",display:"flex",alignItems:"center",gap:5,cursor:"pointer"}}>
                <input type="checkbox" checked={autoDir} onChange={e=>setAutoDir(e.target.checked)}/>
                Auto-follow regime
              </label>
            </div>
            <div style={{marginTop:10,display:"flex",flexWrap:"wrap",gap:"4px 18px"}}>
              {regime.reasons.map((t,i)=>(
                <div key={i} style={{fontSize:10,color:"#94a3b8",lineHeight:1.5,minWidth:220}}>• {t}</div>
              ))}
            </div>
          </div>
        )}

        {err && !data && (
          <div style={{background:"#0a1628",border:"0.5px dashed #f59e0b40",borderRadius:12,padding:36,textAlign:"center"}}>
            <div style={{fontSize:13,color:"#f59e0b"}}>{err}</div>
            <div style={{fontSize:10,color:"#7c8ea8",marginTop:6}}>Live chain needs the bridge running + market hours; off-hours it uses the last collected snapshot (collect with dhan_options_collector.py).</div>
          </div>
        )}

        {data && (
          <div style={{display:"grid",gridTemplateColumns:"1.1fr 2fr",gap:10}}>
            {/* Recommendation + IV */}
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{background:"#0a1628",border:`0.5px solid ${dirColor}50`,borderRadius:12,padding:14}}>
                <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:8}}>RECOMMENDED STRIKE TO BUY</div>
                {rec ? (<>
                  <div style={{display:"flex",alignItems:"baseline",gap:8}}>
                    <span style={{fontSize:26,fontWeight:900,color:dirColor,fontFamily:"monospace"}}>{rec.strike}</span>
                    <span style={{fontSize:13,fontWeight:700,color:dirColor}}>{dir}</span>
                    <span style={{marginLeft:"auto",fontSize:18,fontWeight:800,color:"#e2e8f0",fontFamily:"monospace"}}>₹{fmt(rec.ltp)}</span>
                  </div>
                  <div style={{display:"flex",gap:14,marginTop:8,flexWrap:"wrap"}}>
                    <span style={{fontSize:10,color:"#94a3b8"}}>Delta <b style={{color:"#60a5fa"}}>{rec.delta}</b></span>
                    <span style={{fontSize:10,color:"#94a3b8"}}>IV <b style={{color:"#a78bfa"}}>{rec.iv}%</b></span>
                    <span style={{fontSize:10,color:"#94a3b8"}}>Theta <b style={{color:"#ef4444"}}>{rec.theta}</b></span>
                    <span style={{fontSize:10,color:"#94a3b8"}}>OI <b style={{color:"#e2e8f0"}}>{fmt(rec.oi)}</b></span>
                  </div>
                  <div style={{marginTop:10,display:"flex",flexDirection:"column",gap:4}}>
                    {recFlags.map((f,i)=><div key={i} style={{fontSize:10,color:f.c,lineHeight:1.4}}>{f.t}</div>)}
                  </div>
                </>) : <div style={{fontSize:11,color:"#7c8ea8"}}>No eligible strike.</div>}
              </div>

              {/* Trade plan — sized from Money Mgt (capital, RR, SL) + risk policy */}
              <div style={{background:"#0a1628",border:`0.5px solid ${noTrade?"#f59e0b40":sugColor+"50"}`,borderRadius:12,padding:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <span style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em"}}>TRADE PLAN · from Money Mgt</span>
                  <span style={{fontSize:8,color:"#7c8ea8",fontFamily:"monospace"}}>cap ₹{fmt(mm.capital)} · risk {riskPct}%</span>
                </div>
                {noTrade ? (
                  <div style={{fontSize:11,color:"#f59e0b",lineHeight:1.5}}>
                    ⛔ Regime says stand aside — {regime.why} No position sized.
                  </div>
                ) : !plan ? (
                  <div style={{fontSize:11,color:"#7c8ea8"}}>No eligible strike to size.</div>
                ) : (<>
                  <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:8}}>
                    <span style={{fontSize:18,fontWeight:900,color:sugColor,fontFamily:"monospace"}}>{rec.strike} {dir}</span>
                    <span style={{marginLeft:"auto",fontSize:13,fontWeight:800,color:plan.affordable?"#e2e8f0":"#f59e0b",fontFamily:"monospace"}}>
                      {plan.lots} lot{plan.lots===1?"":"s"} × {plan.lotUnits}
                    </span>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                    {[
                      {l:"ENTRY", v:`₹${fmt(plan.entry)}`, c:"#e2e8f0"},
                      {l:`SL (−${fmt(plan.slPts)})`, v:`₹${fmt(plan.slPrice)}`, c:"#ef4444"},
                      {l:`TGT (1:${plan.rr})`, v:`₹${fmt(plan.tgtPrice)}`, c:"#22c55e"},
                    ].map(m=>(
                      <div key={m.l} style={{background:"#060d17",borderRadius:7,padding:"7px 9px"}}>
                        <div style={{fontSize:7,color:"#7c8ea8",letterSpacing:"0.05em",marginBottom:2}}>{m.l}</div>
                        <div style={{fontSize:13,fontWeight:800,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:"3px 14px",marginTop:9}}>
                    <span style={{fontSize:10,color:"#94a3b8"}}>Risk <b style={{color:"#ef4444"}}>₹{fmt(plan.riskRs)}</b></span>
                    <span style={{fontSize:10,color:"#94a3b8"}}>Reward <b style={{color:"#22c55e"}}>₹{fmt(plan.rewardRs)}</b></span>
                    <span style={{fontSize:10,color:"#94a3b8"}}>Outlay <b style={{color:"#e2e8f0"}}>₹{fmt(plan.outlayRs)}</b></span>
                  </div>
                  {!plan.affordable && (
                    <div style={{marginTop:8,fontSize:9,color:"#f59e0b",lineHeight:1.4}}>
                      ⚠ 1 lot risks ₹{fmt(plan.oneLotRisk)} &gt; your ₹{fmt(plan.budget)} risk budget ({riskPct}% of ₹{fmt(plan.capital)}). Widen SL, add capital, or skip.
                    </div>
                  )}
                  <div style={{marginTop:8,fontSize:8,color:"#7c8ea8",lineHeight:1.4}}>
                    Sized so max loss ≈ risk budget. SL {mm.useSL?`fixed ${fmt(mm.slPts||mm.slPoints)} pts`:"= 30% of premium"} · RR from Money Mgt. Lot {plan.lotUnits}/unit (verify current exchange lot).
                  </div>
                </>)}
              </div>

              {/* IV gauge */}
              <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                  <span style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em"}}>ATM IV PERCENTILE</span>
                  <span style={{fontSize:11,fontWeight:800,fontFamily:"monospace",color:data.ivPercentile==null?"#64748b":data.ivPercentile>70?"#ef4444":data.ivPercentile<30?"#22c55e":"#f59e0b"}}>
                    {data.ivPercentile==null?"accruing":`${data.ivPercentile}th`}
                  </span>
                </div>
                <div style={{height:8,background:"#060d17",borderRadius:4,overflow:"hidden"}}>
                  <div style={{height:8,width:`${data.ivPercentile||0}%`,background:data.ivPercentile>70?"#ef4444":data.ivPercentile<30?"#22c55e":"#f59e0b",transition:"width .4s"}}/>
                </div>
                <div style={{fontSize:9,color:"#7c8ea8",marginTop:6,lineHeight:1.4}}>
                  {data.ivPercentile==null?"Building from collected snapshots." : data.ivPercentile>70?"IV rich — buying premium is expensive; favour spreads or wait." : data.ivPercentile<30?"IV cheap — better conditions for buying options." : "IV mid-range."}
                </div>
              </div>
            </div>

            {/* Strike ladder */}
            <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,overflow:"hidden"}}>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",minWidth:560}}>
                  <thead><tr style={{background:"#07111f"}}>
                    {["CE Δ","CE IV","CE OI","CE LTP","STRIKE","PE LTP","PE OI","PE IV","PE Δ"].map(h=>(
                      <th key={h} style={{padding:"7px 8px",fontSize:8,color:"#94a3b8",letterSpacing:"0.05em",borderBottom:"0.5px solid #1e3a5a",whiteSpace:"nowrap",textAlign:h==="STRIKE"?"center":"right"}}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {data.strikes.map(s=>{
                      const isRec = rec && s.strike===rec.strike;
                      const cellCE = dir==="CALL";
                      return (
                        <tr key={s.strike} style={{borderBottom:"0.5px solid #102033",background:s.atm?"#0d1b2d":isRec?(dirColor+"14"):"transparent"}}>
                          <td style={{padding:"6px 8px",fontSize:10,textAlign:"right",fontFamily:"monospace",color:cellCE?"#60a5fa":"#5b6b82"}}>{s.ce.delta}</td>
                          <td style={{padding:"6px 8px",fontSize:9,textAlign:"right",fontFamily:"monospace",color:"#7c8ea8"}}>{s.ce.iv}</td>
                          <td style={{padding:"6px 8px",fontSize:9,textAlign:"right",fontFamily:"monospace",color:"#5b6b82"}}>{(s.ce.oi/1000).toFixed(0)}k</td>
                          <td style={{padding:"6px 8px",fontSize:10,textAlign:"right",fontFamily:"monospace",color:cellCE?"#22c55e":"#7c8ea8",fontWeight:cellCE?700:400}}>{fmt(s.ce.ltp)}</td>
                          <td style={{padding:"6px 8px",fontSize:11,textAlign:"center",fontFamily:"monospace",fontWeight:800,color:s.atm?"#f59e0b":"#e2e8f0"}}>{s.strike}{s.atm?" ◆":""}</td>
                          <td style={{padding:"6px 8px",fontSize:10,textAlign:"right",fontFamily:"monospace",color:!cellCE?"#ef4444":"#7c8ea8",fontWeight:!cellCE?700:400}}>{fmt(s.pe.ltp)}</td>
                          <td style={{padding:"6px 8px",fontSize:9,textAlign:"right",fontFamily:"monospace",color:"#5b6b82"}}>{(s.pe.oi/1000).toFixed(0)}k</td>
                          <td style={{padding:"6px 8px",fontSize:9,textAlign:"right",fontFamily:"monospace",color:"#7c8ea8"}}>{s.pe.iv}</td>
                          <td style={{padding:"6px 8px",fontSize:10,textAlign:"right",fontFamily:"monospace",color:!cellCE?"#60a5fa":"#5b6b82"}}>{s.pe.delta}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{padding:"7px 10px",fontSize:8,color:"#64748b",borderTop:"0.5px solid #1e3a5a"}}>
                ◆ = ATM · highlighted row = recommended {dir} · Δ≈0.5 is ATM, lower Δ = further OTM (cheaper but lottery). Guardrails: ≥₹{g.minPremium} premium, no 0-DTE.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MTF CONFLUENCE PAGE ─────────────────────────────────────────────────────
const MTF_TFS = ["1m","5m","15m","1H","4H","1D","1W"];
const ICT_CONCEPTS = ["Order Block","FVG","BOS","CHoCH","Liquidity Sweep","EMA Alignment","Kill Zone","PD Array","Inducement","MSS"];

function MTFConfluencePage({ candles, prices }) {
  const [asset, setAsset] = useState("BTCUSD");
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);

  // Simulate MTF data from candles (in a real app, you'd fetch per-TF from API)
  const mtfData = useMemo(()=>{
    const c = candles[asset] || [];
    if(c.length < 30) return null;
    const tfs = {};
    MTF_TFS.forEach((tf, ti)=>{
      const step = Math.max(1, Math.pow(2, ti));
      const agg = [];
      for(let i=0; i<c.length; i+=step){
        const slice = c.slice(i, i+step);
        if(!slice.length) break;
        agg.push({
          open:  slice[0].open,
          close: slice[slice.length-1].close,
          high:  Math.max(...slice.map(x=>x.high)),
          low:   Math.min(...slice.map(x=>x.low)),
          bull:  slice[slice.length-1].close >= slice[0].open,
          vol:   slice.reduce((s,x)=>s+(x.vol||0),0),
        });
      }
      const last5 = agg.slice(-5);
      const bullCount = last5.filter(x=>x.bull).length;
      const bias = bullCount>=4?"BULLISH":bullCount<=1?"BEARISH":"NEUTRAL";
      const strength = Math.abs(bullCount - 2.5) / 2.5;

      // Detect concepts
      const detected = [];
      if(agg.length>=3){
        const a=agg, n=a.length;
        // OB: last bearish before a bullish move
        if(!a[n-2].bull && a[n-1].bull) detected.push("Order Block");
        // FVG check
        if(n>=3 && a[n-1].low > a[n-3].high) detected.push("FVG");
        if(n>=3 && a[n-1].high < a[n-3].low) detected.push("FVG");
        // BOS: higher high
        if(n>=4 && a[n-1].high > a[n-3].high) detected.push("BOS");
        // CHoCH: failed new high after uptrend
        if(n>=4 && a[n-2].bull && !a[n-1].bull && a[n-1].low < a[n-3].low) detected.push("CHoCH");
        // Liquidity
        if(n>=5){
          const prev2Highs=[a[n-4].high,a[n-3].high,a[n-2].high];
          if(a[n-1].high > Math.max(...prev2Highs)) detected.push("Liquidity Sweep");
        }
        // EMA
        const closes = agg.map(x=>x.close);
        const ema20 = closes.slice(-20).reduce((s,v)=>s+v,0)/Math.min(20,closes.length);
        if(a[n-1].close > ema20) detected.push("EMA Alignment");
        // Kill zone (simulate)
        const nowH = new Date().getUTCHours();
        if((nowH>=7&&nowH<9)||(nowH>=12&&nowH<14)) detected.push("Kill Zone");
        // PD
        if(bullCount>=3) detected.push("PD Array");
      }

      tfs[tf] = { bias, strength, bullCount, detected, last:agg[agg.length-1] };
    });
    return tfs;
  }, [candles, asset]);

  // Count how many TFs agree
  const confluence = useMemo(()=>{
    if(!mtfData) return null;
    const vals = Object.values(mtfData);
    const bullTFs = vals.filter(t=>t.bias==="BULLISH").length;
    const bearTFs = vals.filter(t=>t.bias==="BEARISH").length;
    const overallBias = bullTFs > bearTFs ? "BULLISH" : bearTFs > bullTFs ? "BEARISH" : "NEUTRAL";
    const score = Math.round(Math.max(bullTFs, bearTFs) / vals.length * 100);
    // Concepts appearing on 2+ TFs
    const conceptCount = {};
    vals.forEach(t=>t.detected.forEach(c=>{ conceptCount[c]=(conceptCount[c]||0)+1; }));
    const multiTFConcepts = Object.entries(conceptCount).filter(([,v])=>v>=2).sort((a,b)=>b[1]-a[1]);
    return { overallBias, score, bullTFs, bearTFs, multiTFConcepts, conceptCount };
  }, [mtfData]);

  const runAIConfluence = async () => {
    if(!mtfData||!confluence) return;
    setLoading(true); setError(null);
    const assetLabel = ASSETS.find(a=>a.id===asset)?.label||asset;
    const mtfSummary = MTF_TFS.map(tf=>{
      const d=mtfData[tf];
      return `${tf}: ${d.bias} (${d.bullCount}/5 bull candles), signals: ${d.detected.join(", ")||"none"}`;
    }).join("\n");
    const prompt=`You are an elite ICT trader. Given this multi-timeframe analysis for ${assetLabel}:
${mtfSummary}

Overall confluence: ${confluence.overallBias} at ${confluence.score}% score.
Multi-TF concepts: ${confluence.multiTFConcepts.map(([c,n])=>`${c} (${n}TF)`).join(", ")}

Provide a trading plan JSON:
{
  "verdict": "STRONG BUY"|"BUY"|"NEUTRAL"|"SELL"|"STRONG SELL",
  "confluenceScore": 0-100,
  "htfBias": "what HTF (4H/1D) says",
  "ltfEntry": "what LTF (5m/15m) should confirm before entry",
  "entryTrigger": "exact trigger description",
  "optimalTF": "best timeframe to trade this setup",
  "riskNote": "key risk in this confluence",
  "tradePlan": "2-sentence execution plan",
  "waitFor": ["condition1","condition2"]
}
Return ONLY valid JSON.`;
    try {
      const data = await callAI(prompt, 1000);
      const txt  = data.content?.[0]?.text || "";
      const clean2 = txt.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
      const jsonMatch2 = clean2.match(/\{[\s\S]*\}/);
      if (!jsonMatch2) throw new Error("No JSON in response");
      setAnalysis(JSON.parse(jsonMatch2[0]));
    } catch(e){
      setError(e.message==="NO_KEY"
        ? "API key not set. Go to Settings → DeepSeek API Key."
        : "AI confluence analysis failed.");
    }
    setLoading(false);
  };

  const biasColor={BULLISH:"#22c55e",BEARISH:"#ef4444",NEUTRAL:"#f59e0b"};
  const verdictColor={"STRONG BUY":"#22c55e","BUY":"#4ade80","NEUTRAL":"#f59e0b","SELL":"#f87171","STRONG SELL":"#ef4444"};

  return (
    <div style={{height:"100%",overflow:"auto"}}>
      <div style={{maxWidth:1000,margin:"0 auto",display:"flex",flexDirection:"column",gap:10}}>

        {/* Header */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14,display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em"}}>MULTI-TIMEFRAME ICT CONFLUENCE</div>
          <select value={asset} onChange={e=>setAsset(e.target.value)}
            style={{background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,padding:"5px 10px",color:"#e2e8f0",fontSize:12,fontFamily:"monospace"}}>
            {ASSETS.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          {confluence&&(
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:10,fontWeight:700,color:biasColor[confluence.overallBias]||"#e2e8f0"}}>{confluence.overallBias}</span>
              <span style={{fontSize:9,color:"#94a3b8"}}>{confluence.bullTFs}▲ / {confluence.bearTFs}▼ TFs</span>
              <div style={{width:80,height:6,background:"#1e2a3a",borderRadius:3}}>
                <div style={{height:6,width:`${confluence.score}%`,background:biasColor[confluence.overallBias],borderRadius:3}}/>
              </div>
              <span style={{fontSize:9,color:biasColor[confluence.overallBias],fontFamily:"monospace",fontWeight:700}}>{confluence.score}%</span>
            </div>
          )}
          <button onClick={runAIConfluence} disabled={loading||!mtfData}
            style={{marginLeft:"auto",padding:"7px 16px",background:loading?"#1e3a5a":"linear-gradient(135deg,#0d9488,#0891b2)",
              border:"none",borderRadius:8,color:"white",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
            {loading?"◌ ANALYSING...":"◐ AI CONFLUENCE PLAN"}
          </button>
        </div>

        {/* MTF Grid */}
        {mtfData&&(
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:8}}>
            {MTF_TFS.map(tf=>{
              const d=mtfData[tf];
              const bc=biasColor[d.bias]||"#64748b";
              return (
                <div key={tf} style={{background:"#0a1628",border:`0.5px solid ${bc}30`,borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
                  <div style={{fontSize:9,fontWeight:700,color:"#64748b",letterSpacing:"0.1em",marginBottom:6}}>{tf}</div>
                  {/* Bull/Bear bar */}
                  <div style={{height:4,background:"#1e2a3a",borderRadius:2,marginBottom:8}}>
                    <div style={{height:4,width:`${(d.bullCount/5)*100}%`,background:bc,borderRadius:2}}/>
                  </div>
                  {/* Candle mini visual */}
                  <div style={{display:"flex",justifyContent:"center",gap:2,marginBottom:6}}>
                    {Array.from({length:5},(_,i)=>(
                      <div key={i} style={{width:8,height:24,background:i<d.bullCount?"#22c55e30":"#ef444430",
                        border:`0.5px solid ${i<d.bullCount?"#22c55e":"#ef4444"}`,borderRadius:1}}/>
                    ))}
                  </div>
                  <div style={{fontSize:10,fontWeight:800,color:bc,marginBottom:6}}>{d.bias==="BULLISH"?"▲":d.bias==="BEARISH"?"▼":"◆"}</div>
                  {/* Detected signals */}
                  <div style={{display:"flex",flexDirection:"column",gap:2}}>
                    {d.detected.slice(0,3).map(sig=>(
                      <div key={sig} style={{fontSize:7,color:"#60a5fa",background:"#111e30",borderRadius:3,padding:"1px 3px",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{sig}</div>
                    ))}
                    {d.detected.length>3&&<div style={{fontSize:7,color:"#7c8ea8"}}>+{d.detected.length-3} more</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Multi-TF concept heatmap */}
        {confluence&&confluence.multiTFConcepts.length>0&&(
          <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
            <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:12}}>CONCEPT CONFLUENCE — appearing on multiple timeframes</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
              {ICT_CONCEPTS.map(concept=>{
                const count = confluence.conceptCount[concept]||0;
                const pct = count/MTF_TFS.length;
                const col = pct>0.6?"#22c55e":pct>0.3?"#f59e0b":"#1e3a5a";
                return (
                  <div key={concept} style={{background:"#060d17",border:`0.5px solid ${col}40`,borderRadius:7,padding:"8px 10px"}}>
                    <div style={{fontSize:9,color:count>0?"#e2e8f0":"#7c8ea8",marginBottom:4,fontWeight:count>=2?600:400}}>{concept}</div>
                    <div style={{display:"flex",gap:3,alignItems:"center"}}>
                      {MTF_TFS.map((tf,i)=>{
                        const has=(mtfData[tf]?.detected||[]).includes(concept);
                        return <div key={tf} title={tf} style={{width:7,height:16,borderRadius:1,background:has?col:"#1e2a3a"}}/>;
                      })}
                    </div>
                    <div style={{fontSize:8,color:col,marginTop:4,fontFamily:"monospace"}}>{count}/{MTF_TFS.length} TFs</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* AI Trade Plan */}
        {loading&&<div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:32,textAlign:"center"}}>
          <div style={{fontSize:24,color:"#0d9488",animation:"spin 1s linear infinite",display:"inline-block"}}>◌</div>
          <div style={{fontSize:12,color:"#0d9488",marginTop:10,fontFamily:"monospace"}}>Building confluence trade plan...</div>
        </div>}
        {error&&<div style={{background:"#1a0000",border:"0.5px solid #ef444440",borderRadius:10,padding:14,color:"#ef4444",fontSize:11,fontFamily:"monospace"}}>{error}</div>}
        {analysis&&!loading&&(
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {/* Verdict */}
            <div style={{background:`linear-gradient(135deg,${verdictColor[analysis.verdict]||"#60a5fa"}15,transparent)`,
              border:`0.5px solid ${verdictColor[analysis.verdict]||"#60a5fa"}40`,borderRadius:12,padding:16,
              display:"flex",alignItems:"center",gap:16}}>
              <div style={{fontSize:32,fontWeight:900,color:verdictColor[analysis.verdict],fontFamily:"monospace"}}>{analysis.verdict}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:11,color:"#94a3b8",marginBottom:4}}>Optimal TF: <span style={{color:"#60a5fa",fontWeight:700}}>{analysis.optimalTF}</span></div>
                <div style={{fontSize:12,color:"#cbd5e1",lineHeight:1.6}}>{analysis.tradePlan}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:9,color:"#94a3b8"}}>CONFLUENCE</div>
                <div style={{fontSize:28,fontWeight:800,color:verdictColor[analysis.verdict],fontFamily:"monospace"}}>{analysis.confluenceScore}%</div>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:10,padding:12}}>
                <div style={{fontSize:9,color:"#94a3b8",marginBottom:6}}>HTF BIAS</div>
                <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.5}}>{analysis.htfBias}</div>
                <div style={{fontSize:9,color:"#7c8ea8",marginTop:8}}>LTF ENTRY TRIGGER</div>
                <div style={{fontSize:12,color:"#60a5fa",marginTop:3,lineHeight:1.5}}>{analysis.ltfEntry}</div>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <div style={{background:"#052e16",border:"0.5px solid #22c55e20",borderRadius:8,padding:10,flex:1}}>
                  <div style={{fontSize:9,color:"#22c55e",marginBottom:5}}>WAIT FOR</div>
                  {(analysis.waitFor||[]).map((w,i)=>(
                    <div key={i} style={{display:"flex",gap:5,marginBottom:4}}>
                      <span style={{color:"#22c55e",fontSize:9}}>⏳</span>
                      <span style={{fontSize:11,color:"#94a3b8"}}>{w}</span>
                    </div>
                  ))}
                </div>
                <div style={{background:"#1c1300",border:"0.5px solid #f59e0b20",borderRadius:8,padding:10}}>
                  <div style={{fontSize:9,color:"#f59e0b",marginBottom:4}}>RISK NOTE</div>
                  <div style={{fontSize:11,color:"#94a3b8",lineHeight:1.4}}>{analysis.riskNote}</div>
                </div>
              </div>
            </div>
          </div>
        )}
        {!analysis&&!loading&&<div style={{background:"#0a1628",border:"0.5px dashed #1e3a5a",borderRadius:12,padding:40,textAlign:"center"}}>
          <div style={{fontSize:28,color:"#64748b",marginBottom:8}}>◐</div>
          <div style={{fontSize:12,color:"#7c8ea8"}}>MTF analysis loaded — click "AI Confluence Plan" for a full trade plan</div>
        </div>}
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ─── TRADE JOURNAL PAGE ───────────────────────────────────────────────────────
const JOURNAL_STORAGE_KEY = "trade-journal";

async function loadJournal() {
  try { const r=localStorage.getItem(JOURNAL_STORAGE_KEY); return r?JSON.parse(r):[]; } catch { return []; }
}
async function saveJournal(entries) {
  try { localStorage.setItem(JOURNAL_STORAGE_KEY,JSON.stringify(entries)); } catch {}
  return entries;
}

const EMOTIONS = ["Calm","Confident","Anxious","FOMO","Greedy","Disciplined","Hesitant","Overconfident"];
const MISTAKES = ["Moved SL","Entered early","Chased price","Ignored plan","Over-leveraged","No setup","Revenge trade","None"];

function JournalPage() {
  const [entries,   setEntries]   = useState([]);
  const [showForm,  setShowForm]  = useState(false);
  const [expanded,  setExpanded]  = useState(null);
  const [filter,    setFilter]    = useState("ALL");
  const [loading,   setLoading]   = useState(true);

  const empty = { asset:"BTCUSD",dir:"LONG",entry:"",exit:"",size:"",pnl:"",
    outcome:"win",emotion:"Calm",mistake:"None",setup:"ICT Order Block",
    grade:"A",note:"",screenshot:"",date:new Date().toISOString().split("T")[0] };
  const [form, setForm] = useState(empty);
  const fld = (k,v) => setForm(f=>({...f,[k]:v}));

  useEffect(()=>{ loadJournal().then(e=>{setEntries(e);setLoading(false);}); },[]);

  const submit = async () => {
    if(!form.asset||!form.pnl) return;
    const e=[{...form,id:`JE-${Date.now()}`,createdAt:Date.now()},...entries];
    const saved=await saveJournal(e); setEntries(saved); setShowForm(false); setForm(empty);
  };
  const del = async (id) => {
    const e=entries.filter(x=>x.id!==id); const saved=await saveJournal(e); setEntries(saved);
  };

  const filtered = filter==="ALL"?entries:entries.filter(e=>e.outcome===filter);
  const wins=entries.filter(e=>e.outcome==="win");
  const losses=entries.filter(e=>e.outcome==="loss");
  const totalPnl=entries.reduce((s,e)=>s+(parseFloat(e.pnl)||0),0);
  const avgWin=wins.length?wins.reduce((s,e)=>s+(parseFloat(e.pnl)||0),0)/wins.length:0;
  const avgLoss=losses.length?Math.abs(losses.reduce((s,e)=>s+(parseFloat(e.pnl)||0),0)/losses.length):0;

  const gradeColor={A:"#22c55e",B:"#60a5fa",C:"#f59e0b",D:"#f87171",F:"#ef4444"};
  const emotionColor={Calm:"#22c55e",Confident:"#60a5fa",Disciplined:"#34d399",
    Anxious:"#f59e0b",FOMO:"#ef4444",Greedy:"#f43f5e",Hesitant:"#a78bfa",Overconfident:"#f87171"};

  const inp=(label,k,type="text",opts=null)=>(
    <div>
      <div style={{fontSize:8,color:"#94a3b8",marginBottom:2,letterSpacing:"0.05em"}}>{label}</div>
      {opts
        ? <select value={form[k]} onChange={e=>fld(k,e.target.value)}
            style={{width:"100%",background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:5,padding:"5px 7px",color:"#e2e8f0",fontSize:11,fontFamily:"monospace"}}>
            {opts.map(o=><option key={o} value={o}>{o}</option>)}
          </select>
        : <input type={type} value={form[k]} onChange={e=>fld(k,e.target.value)}
            style={{width:"100%",background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:5,padding:"5px 7px",color:"#e2e8f0",fontSize:11,fontFamily:"monospace"}}/>
      }
    </div>
  );

  return (
    <div style={{height:"100%",overflow:"auto"}}>
      <div style={{maxWidth:900,margin:"0 auto",display:"flex",flexDirection:"column",gap:10}}>

        {/* Stats */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
          {[
            {l:"Total Trades",v:entries.length,c:"#e2e8f0"},
            {l:"Total P&L",v:`${totalPnl>=0?"+":""}$${totalPnl.toFixed(0)}`,c:totalPnl>=0?"#22c55e":"#ef4444"},
            {l:"Win Rate",v:entries.length?`${(wins.length/entries.length*100).toFixed(0)}%`:"—",c:"#60a5fa"},
            {l:"Avg Win",v:avgWin?`$${avgWin.toFixed(0)}`:"—",c:"#22c55e"},
            {l:"Avg Loss",v:avgLoss?`-$${avgLoss.toFixed(0)}`:"—",c:"#ef4444"},
          ].map(m=>(
            <div key={m.l} style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:10,padding:"10px 12px"}}>
              <div style={{fontSize:8,color:"#94a3b8",marginBottom:4,letterSpacing:"0.06em"}}>{m.l.toUpperCase()}</div>
              <div style={{fontSize:18,fontWeight:800,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
            </div>
          ))}
        </div>

        {/* Mistakes breakdown */}
        {entries.length>0&&(()=>{
          const mc={}; entries.forEach(e=>{if(e.mistake&&e.mistake!=="None") mc[e.mistake]=(mc[e.mistake]||0)+1;});
          const mEntries=Object.entries(mc).sort((a,b)=>b[1]-a[1]).slice(0,5);
          if(!mEntries.length) return null;
          return (
            <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
              <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:10}}>TOP MISTAKES — psychology tracker</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {mEntries.map(([m,n])=>(
                  <div key={m} style={{background:"#1a0000",border:"0.5px solid #ef444430",borderRadius:7,padding:"6px 12px"}}>
                    <div style={{fontSize:10,color:"#ef4444",fontWeight:600}}>{m}</div>
                    <div style={{fontSize:12,color:"#94a3b8",fontFamily:"monospace",marginTop:2}}>×{n}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Toolbar */}
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <div style={{display:"flex",gap:3}}>
            {["ALL","win","loss","breakeven"].map(f=>(
              <span key={f} onClick={()=>setFilter(f)}
                style={{fontSize:9,padding:"3px 9px",borderRadius:5,cursor:"pointer",fontFamily:"monospace",
                  background:filter===f?"#1e3a5a":"#060d17",color:filter===f?"#60a5fa":f==="win"?"#22c55e":f==="loss"?"#ef4444":"#94a3b8",
                  border:`0.5px solid ${filter===f?"#3b82f6":"#1e3a5a"}`}}>
                {f==="ALL"?"All":f.charAt(0).toUpperCase()+f.slice(1)}
              </span>
            ))}
          </div>
          <span style={{fontSize:9,color:"#7c8ea8"}}>{filtered.length} entries</span>
          <button onClick={()=>setShowForm(f=>!f)} style={{marginLeft:"auto",padding:"7px 16px",
            background:"linear-gradient(135deg,#1d4ed8,#7c3aed)",border:"none",borderRadius:8,
            color:"white",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"monospace"}}>
            {showForm?"✕ Cancel":"✎ New Entry"}
          </button>
        </div>

        {/* New entry form */}
        {showForm&&(
          <div style={{background:"#0a1628",border:"0.5px solid #3b82f640",borderRadius:12,padding:16}}>
            <div style={{fontSize:9,color:"#60a5fa",letterSpacing:"0.1em",marginBottom:12}}>NEW JOURNAL ENTRY</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:10}}>
              {inp("Date","date","date")}
              {inp("Asset","asset","text",ASSETS.map(a=>a.label))}
              {inp("Direction","dir","text",["LONG","SHORT"])}
              {inp("Outcome","outcome","text",["win","loss","breakeven"])}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:10}}>
              {inp("Entry Price","entry","number")}
              {inp("Exit Price","exit","number")}
              {inp("Size","size","number")}
              {inp("P&L ($)","pnl","number")}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:10}}>
              {inp("Setup","setup","text",["ICT Order Block","SMC BOS","FVG Fill","Liquidity Sweep","RSI Divergence","EMA Bounce","Other"])}
              {inp("Grade","grade","text",["A","B","C","D","F"])}
              {inp("Emotion","emotion","text",EMOTIONS)}
              {inp("Mistake","mistake","text",MISTAKES)}
            </div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:8,color:"#94a3b8",marginBottom:2}}>TRADE NOTES</div>
              <textarea value={form.note} onChange={e=>fld("note",e.target.value)} rows={3}
                placeholder="What happened? What did you see? What would you do differently?"
                style={{width:"100%",background:"#060d17",border:"0.5px solid #1e3a5a",borderRadius:6,
                  padding:"7px 10px",color:"#e2e8f0",fontSize:11,fontFamily:"monospace",resize:"vertical"}}/>
            </div>
            <button onClick={submit} style={{padding:"8px 24px",background:"#22c55e",border:"none",borderRadius:8,color:"black",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"monospace"}}>
              ✓ Save Entry
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loading&&entries.length===0&&!showForm&&(
          <div style={{background:"#0a1628",border:"0.5px dashed #1e3a5a",borderRadius:12,padding:48,textAlign:"center"}}>
            <div style={{fontSize:36,color:"#64748b",marginBottom:12}}>✎</div>
            <div style={{fontSize:13,color:"#7c8ea8"}}>No journal entries yet</div>
            <div style={{fontSize:10,color:"#64748b",marginTop:6}}>Log your trades to build a psychology + performance record</div>
          </div>
        )}

        {/* Entries */}
        {filtered.map(e=>{
          const pnl=parseFloat(e.pnl)||0;
          const isExp=expanded===e.id;
          return (
            <div key={e.id} style={{background:"#0a1628",
              border:`0.5px solid ${e.outcome==="win"?"#22c55e25":e.outcome==="loss"?"#ef444425":"#1e3a5a"}`,
              borderLeft:`3px solid ${e.outcome==="win"?"#22c55e":e.outcome==="loss"?"#ef4444":"#f59e0b"}`,
              borderRadius:"0 10px 10px 0",overflow:"hidden"}}>
              <div onClick={()=>setExpanded(x=>x===e.id?null:e.id)}
                style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",cursor:"pointer",flexWrap:"wrap"}}>
                <span style={{fontSize:9,color:"#7c8ea8",fontFamily:"monospace",minWidth:70}}>{e.date}</span>
                <span style={{fontSize:10,fontWeight:700,color:e.dir==="LONG"?"#22c55e":"#ef4444"}}>{e.dir==="LONG"?"▲":"▼"} {e.dir}</span>
                <span style={{fontSize:11,fontWeight:600,color:"#e2e8f0"}}>{e.asset}</span>
                <span style={{fontSize:10,color:"#64748b"}}>{e.setup}</span>
                <span style={{fontSize:11,fontWeight:700,color:pnl>=0?"#22c55e":"#ef4444",fontFamily:"monospace",marginLeft:"auto"}}>
                  {pnl>=0?"+":""}${pnl.toFixed(0)}
                </span>
                <span style={{fontSize:10,fontWeight:700,color:gradeColor[e.grade]||"#60a5fa",
                  background:(gradeColor[e.grade]||"#60a5fa")+"20",padding:"1px 7px",borderRadius:4}}>{e.grade}</span>
                <span style={{fontSize:9,color:emotionColor[e.emotion]||"#94a3b8",
                  background:(emotionColor[e.emotion]||"#94a3b8")+"15",padding:"1px 6px",borderRadius:4}}>{e.emotion}</span>
                {e.mistake!=="None"&&<span style={{fontSize:9,color:"#ef4444",background:"#1a0000",padding:"1px 6px",borderRadius:4}}>⚠ {e.mistake}</span>}
                <span style={{fontSize:9,color:"#7c8ea8"}}>{isExp?"▲":"▼"}</span>
                <button onClick={ev=>{ev.stopPropagation();del(e.id);}}
                  style={{fontSize:9,padding:"1px 7px",background:"#1a0000",border:"0.5px solid #ef444420",borderRadius:4,color:"#ef4444",cursor:"pointer"}}>
                  ✕
                </button>
              </div>
              {isExp&&(
                <div style={{padding:"0 14px 14px",borderTop:"0.5px solid #1e3a5a"}}>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginTop:12,marginBottom:10}}>
                    {[["Entry",e.entry,"#94a3b8"],["Exit",e.exit,"#e2e8f0"],["Size",e.size,"#60a5fa"],["P&L",`${pnl>=0?"+":""}$${pnl.toFixed(0)}`,pnl>=0?"#22c55e":"#ef4444"]].map(([l,v,c])=>(
                      <div key={l} style={{background:"#060d17",border:"0.5px solid #1e2a3a",borderRadius:6,padding:"7px 10px",textAlign:"center"}}>
                        <div style={{fontSize:8,color:"#94a3b8",marginBottom:2}}>{l}</div>
                        <div style={{fontSize:13,fontWeight:700,color:c,fontFamily:"monospace"}}>{v||"—"}</div>
                      </div>
                    ))}
                  </div>
                  {e.note&&<div style={{background:"#060d17",border:"0.5px solid #1e2a3a",borderRadius:7,padding:"10px 12px",fontSize:12,color:"#94a3b8",lineHeight:1.6}}>{e.note}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── ANALYTICS PAGE ───────────────────────────────────────────────────────────
function AnalyticsPage({ candles, prices, history }) {
  const [tab, setTab] = useState("performance");

  // Equity curve from history signals treated as trades
  const historyTrades = history.filter(isResolvedSignal);
  const equityCurve = useMemo(()=>{
    let eq=10000; const curve=[eq];
    historyTrades.forEach(t=>{
      const pnl=eq*0.01*signalPnlR(t);
      eq+=pnl; curve.push(Math.max(0,eq));
    });
    return curve;
  },[historyTrades]);

  // Per-strategy performance
  const stratPerf = useMemo(()=>{
    const sp={};
    history.forEach(h=>{
      const k=h.setup||"Unknown";
      if(!sp[k]) sp[k]={wins:0,losses:0,pending:0,totalRR:0};
      if(isWinSignal(h)){sp[k].wins++; sp[k].totalRR+=(h.riskReward||MIN_BIG_PROFIT_RR);}
      else if(isLossSignal(h)) sp[k].losses++;
      else sp[k].pending++;
    });
    return Object.entries(sp).map(([name,v])=>({
      name, ...v,
      winRate:v.wins+v.losses>0?v.wins/(v.wins+v.losses)*100:null,
      avgRR:v.wins>0?v.totalRR/v.wins:null,
    })).sort((a,b)=>(b.winRate||0)-(a.winRate||0));
  },[history]);

  // Asset correlation (mock — real requires price return matrix)
  const corrMatrix = useMemo(()=>{
    const assetIds=ASSETS.map(a=>a.id);
    const returns={};
    assetIds.forEach(id=>{
      const c=candles[id]||[];
      returns[id]=c.slice(-30).map((x,i,arr)=>i===0?0:(x.close-arr[i-1].close)/arr[i-1].close);
    });
    const corr={};
    assetIds.forEach(a=>{
      corr[a]={};
      assetIds.forEach(b=>{
        const ra=returns[a]||[], rb=returns[b]||[];
        const n=Math.min(ra.length,rb.length);
        if(n<2){corr[a][b]=a===b?1:0; return;}
        const ma=ra.slice(0,n).reduce((s,v)=>s+v,0)/n;
        const mb=rb.slice(0,n).reduce((s,v)=>s+v,0)/n;
        let num=0,da=0,db=0;
        for(let i=0;i<n;i++){
          num+=(ra[i]-ma)*(rb[i]-mb);
          da+=(ra[i]-ma)**2; db+=(rb[i]-mb)**2;
        }
        corr[a][b]=da&&db?num/Math.sqrt(da*db):a===b?1:0;
      });
    });
    return corr;
  },[candles]);

  // Heatmap color: -1=red, 0=neutral, 1=green
  const heatColor=(v)=>{
    const r=v<0?239:v>0?34:100;
    const g=v<0?68:v>0?197:116;
    const b=v<0?68:v>0?94:126;
    const a=Math.abs(v)*0.7+0.1;
    return `rgba(${r},${g},${b},${a})`;
  };

  // Hourly PnL heatmap (which hours are most profitable in history)
  const hourlyPnl = useMemo(()=>{
    const hp=Array.from({length:24},(_,h)=>({h,count:0,wins:0}));
    history.forEach(s=>{
      if(!s.timestamp) return;
      const h=new Date(s.timestamp).getUTCHours();
      hp[h].count++;
      if(isWinSignal(s)) hp[h].wins++;
    });
    return hp;
  },[history]);

  const assetLabels=ASSETS.map(a=>a.label);

  return (
    <div style={{height:"100%",overflow:"auto"}}>
      <div style={{maxWidth:1000,margin:"0 auto",display:"flex",flexDirection:"column",gap:10}}>

        {/* Tabs */}
        <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:"10px 14px",display:"flex",gap:6}}>
          {[{id:"performance",l:"Performance"},
            {id:"strategy",l:"Strategy Stats"},
            {id:"correlation",l:"Correlation Heatmap"},
            {id:"hourly",l:"Hourly Analysis"},
          ].map(t=>(
            <span key={t.id} onClick={()=>setTab(t.id)}
              style={{fontSize:10,padding:"5px 12px",borderRadius:6,cursor:"pointer",fontFamily:"monospace",fontWeight:tab===t.id?700:400,
                background:tab===t.id?"#1e3a5a":"transparent",color:tab===t.id?"#60a5fa":"#94a3b8",
                border:`0.5px solid ${tab===t.id?"#3b82f6":"transparent"}`}}>
              {t.l}
            </span>
          ))}
        </div>

        {/* Performance tab */}
        {tab==="performance"&&(
          <>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
              {[
                {l:"Total Signals",v:history.length,c:"#e2e8f0"},
                {l:"Resolved",v:historyTrades.length,c:"#60a5fa"},
                {l:"Win Rate",v:historyTrades.length?`${(historyTrades.filter(isWinSignal).length/historyTrades.length*100).toFixed(1)}%`:"—",c:"#22c55e"},
                {l:"Avg Confidence",v:history.length?`${(history.reduce((s,h)=>s+h.confidence,0)/history.length).toFixed(0)}%`:"—",c:"#f59e0b"},
              ].map(m=>(
                <div key={m.l} style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:10,padding:"10px 12px"}}>
                  <div style={{fontSize:8,color:"#94a3b8",marginBottom:4,letterSpacing:"0.06em"}}>{m.l.toUpperCase()}</div>
                  <div style={{fontSize:20,fontWeight:800,color:m.c,fontFamily:"monospace"}}>{m.v}</div>
                </div>
              ))}
            </div>
            <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
              <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:10}}>EQUITY CURVE (from signal history)</div>
              <div style={{height:160}}>
                {equityCurve.length>1
                  ? <EquityCurve curve={equityCurve}/>
                  : <div style={{textAlign:"center",paddingTop:60,color:"#7c8ea8",fontSize:11}}>Run AI signals and mark outcomes to see equity curve</div>
                }
              </div>
            </div>
            {/* Bias distribution donut (SVG) */}
            {history.length>0&&(()=>{
              const bull=history.filter(h=>h.bias==="BULLISH").length;
              const bear=history.filter(h=>h.bias==="BEARISH").length;
              const neut=history.filter(h=>h.bias==="NEUTRAL").length;
              const total=history.length;
              const segs=[
                {label:"Bullish",count:bull,color:"#22c55e"},
                {label:"Bearish",count:bear,color:"#ef4444"},
                {label:"Neutral",count:neut,color:"#f59e0b"},
              ];
              let angle=-Math.PI/2;
              const cx=70,cy=70,r=56,ir=30;
              const arcs=segs.map(s=>{
                const pct=s.count/total;
                const a=pct*2*Math.PI;
                const x1=cx+r*Math.cos(angle), y1=cy+r*Math.sin(angle);
                const x2=cx+r*Math.cos(angle+a), y2=cy+r*Math.sin(angle+a);
                const xi1=cx+ir*Math.cos(angle), yi1=cy+ir*Math.sin(angle);
                const xi2=cx+ir*Math.cos(angle+a), yi2=cy+ir*Math.sin(angle+a);
                const lg=a>Math.PI?1:0;
                const path=`M${xi1},${yi1} L${x1},${y1} A${r},${r},0,${lg},1,${x2},${y2} L${xi2},${yi2} A${ir},${ir},0,${lg},0,${xi1},${yi1}`;
                angle+=a;
                return {...s,path,pct};
              });
              return (
                <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14,display:"flex",gap:16,alignItems:"center"}}>
                  <svg width={140} height={140}>
                    {arcs.map(a=><path key={a.label} d={a.path} fill={a.color} opacity="0.85"/>)}
                    <text x={cx} y={cy-4} textAnchor="middle" fontSize="9" fill="#94a3b8" fontFamily="monospace">BIAS</text>
                    <text x={cx} y={cy+8} textAnchor="middle" fontSize="12" fill="#e2e8f0" fontFamily="monospace" fontWeight="bold">{total}</text>
                  </svg>
                  <div style={{flex:1}}>
                    {arcs.map(a=>(
                      <div key={a.label} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                        <div style={{width:10,height:10,borderRadius:"50%",background:a.color,flexShrink:0}}/>
                        <span style={{fontSize:11,color:"#94a3b8",flex:1}}>{a.label}</span>
                        <span style={{fontSize:12,fontWeight:700,color:a.color,fontFamily:"monospace"}}>{a.count}</span>
                        <span style={{fontSize:9,color:"#94a3b8"}}>({(a.pct*100).toFixed(0)}%)</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </>
        )}

        {/* Strategy stats tab */}
        {tab==="strategy"&&(
          <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
            <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:12}}>STRATEGY PERFORMANCE BREAKDOWN</div>
            {stratPerf.length===0
              ? <div style={{textAlign:"center",padding:40,color:"#7c8ea8",fontSize:11}}>No resolved signals yet — mark outcomes in History to see stats</div>
              : <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:"monospace"}}>
                  <thead><tr>{["Setup","Wins","Losses","Pending","Win Rate","Avg RR"].map(h=>(
                    <th key={h} style={{textAlign:"left",padding:"5px 10px",fontSize:8,color:"#94a3b8",borderBottom:"0.5px solid #1e3a5a",letterSpacing:"0.06em"}}>{h}</th>
                  ))}</tr></thead>
                  <tbody>
                    {stratPerf.map(s=>(
                      <tr key={s.name} style={{borderBottom:"0.5px solid #0d1b2a"}}>
                        <td style={{padding:"8px 10px",color:"#e2e8f0",fontWeight:600}}>{s.name}</td>
                        <td style={{padding:"8px 10px",color:"#22c55e"}}>{s.wins}</td>
                        <td style={{padding:"8px 10px",color:"#ef4444"}}>{s.losses}</td>
                        <td style={{padding:"8px 10px",color:"#94a3b8"}}>{s.pending}</td>
                        <td style={{padding:"8px 10px"}}>
                          {s.winRate!=null
                            ? <><div style={{display:"flex",alignItems:"center",gap:6}}>
                                <div style={{width:60,height:5,background:"#1e2a3a",borderRadius:2}}>
                                  <div style={{height:5,width:`${s.winRate}%`,background:s.winRate>60?"#22c55e":s.winRate>50?"#f59e0b":"#ef4444",borderRadius:2}}/>
                                </div>
                                <span style={{color:s.winRate>60?"#22c55e":s.winRate>50?"#f59e0b":"#ef4444"}}>{s.winRate.toFixed(0)}%</span>
                              </div></>
                            : <span style={{color:"#7c8ea8"}}>—</span>
                          }
                        </td>
                        <td style={{padding:"8px 10px",color:"#60a5fa"}}>{s.avgRR?`1:${s.avgRR.toFixed(2)}`:"—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
            }
          </div>
        )}

        {/* Correlation heatmap tab */}
        {tab==="correlation"&&(
          <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
            <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:12}}>ASSET CORRELATION HEATMAP — 30-candle returns</div>
            <div style={{overflowX:"auto"}}>
              <table style={{borderCollapse:"collapse",fontFamily:"monospace",fontSize:10}}>
                <thead>
                  <tr>
                    <td style={{width:80,padding:"4px 6px"}}/>
                    {ASSETS.map(a=>(
                      <td key={a.id} style={{padding:"4px 8px",fontSize:8,color:"#64748b",textAlign:"center",minWidth:72,letterSpacing:"0.05em"}}>{a.label}</td>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ASSETS.map(rowA=>(
                    <tr key={rowA.id}>
                      <td style={{padding:"4px 8px",fontSize:9,color:"#64748b",textAlign:"right",fontWeight:600}}>{rowA.label}</td>
                      {ASSETS.map(colA=>{
                        const v=corrMatrix[rowA.id]?.[colA.id]??0;
                        const isD=rowA.id===colA.id;
                        return (
                          <td key={colA.id} style={{padding:3}}>
                            <div style={{width:66,height:44,borderRadius:5,background:isD?"#1e3a5a":heatColor(v),
                              display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                              border:`0.5px solid ${isD?"#3b82f6":"transparent"}`}}>
                              <span style={{fontSize:11,fontWeight:700,color:isD?"#60a5fa":Math.abs(v)>0.5?"#e2e8f0":"#94a3b8"}}>
                                {isD?"1.00":v.toFixed(2)}
                              </span>
                              <span style={{fontSize:7,color:"#94a3b8",marginTop:1}}>
                                {isD?"diagonal":Math.abs(v)>0.7?"strong":Math.abs(v)>0.4?"moderate":"weak"}
                              </span>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{display:"flex",gap:12,marginTop:12,alignItems:"center"}}>
              <span style={{fontSize:9,color:"#94a3b8"}}>LEGEND</span>
              {[[-1,"#ef4444","Strong -ve"],[0,"#7c8ea8","Neutral"],[1,"#22c55e","Strong +ve"]].map(([v,c,l])=>(
                <div key={l} style={{display:"flex",alignItems:"center",gap:4}}>
                  <div style={{width:18,height:12,borderRadius:2,background:c,opacity:0.7}}/>
                  <span style={{fontSize:8,color:"#94a3b8"}}>{l}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Hourly analysis tab */}
        {tab==="hourly"&&(
          <div style={{background:"#0a1628",border:"0.5px solid #1e3a5a",borderRadius:12,padding:14}}>
            <div style={{fontSize:9,color:"#94a3b8",letterSpacing:"0.1em",marginBottom:4}}>SIGNAL SUCCESS BY HOUR (UTC)</div>
            <div style={{fontSize:8,color:"#64748b",marginBottom:14}}>Which UTC hours generate the highest-quality ICT signals from your history</div>
            {history.length<3
              ? <div style={{textAlign:"center",padding:40,color:"#7c8ea8",fontSize:11}}>Need at least 3 resolved signals to show hourly breakdown</div>
              : <div style={{display:"flex",gap:4,alignItems:"flex-end",height:120}}>
                  {hourlyPnl.map(h=>{
                    const wr=h.count>0?h.wins/h.count:0;
                    const barH=Math.max(4,wr*100);
                    const isKZ=(h.h>=7&&h.h<9)||(h.h>=12&&h.h<14)||(h.h>=0&&h.h<2);
                    const col=isKZ?"#f59e0b":wr>0.6?"#22c55e":wr>0.4?"#60a5fa":"#1e3a5a";
                    return (
                      <div key={h.h} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                        <div style={{fontSize:7,color:col,fontFamily:"monospace",fontWeight:isKZ?700:400}}>
                          {h.count>0?`${Math.round(wr*100)}%`:""}
                        </div>
                        <div style={{width:"100%",height:barH,background:col,borderRadius:"2px 2px 0 0",opacity:h.count?0.9:0.15,position:"relative"}}>
                          {isKZ&&<div style={{position:"absolute",top:-2,left:"50%",transform:"translateX(-50%)",width:4,height:4,borderRadius:"50%",background:"#f59e0b"}}/>}
                        </div>
                        <div style={{fontSize:6,color:"#7c8ea8",fontFamily:"monospace"}}>{h.h}</div>
                      </div>
                    );
                  })}
                </div>
            }
            <div style={{display:"flex",gap:12,marginTop:10}}>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:10,height:10,borderRadius:"50%",background:"#f59e0b"}}/>
                <span style={{fontSize:8,color:"#94a3b8"}}>Kill Zone hours</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:10,height:10,borderRadius:2,background:"#22c55e"}}/>
                <span style={{fontSize:8,color:"#94a3b8"}}>High win rate (60%+)</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DHAN API HELPERS ─────────────────────────────────────────────────────────
function getDhanToken() { return localStorage.getItem("alphaedge_dhan_token") || ""; }
function setDhanToken(t) { localStorage.setItem("alphaedge_dhan_token", t.trim()); }
function getDhanClientId() { return localStorage.getItem("alphaedge_dhan_client_id") || ""; }
function setDhanClientId(c) { localStorage.setItem("alphaedge_dhan_client_id", c.trim()); }

// Dhan securityId map for the instruments we can backtest in the browser.
// Index IDs are stable; add stocks/F&O via dhan_lookup.py (Python) if needed.
const DHAN_INSTRUMENTS = {
  NIFTY50:   { securityId: "13", segment: "IDX_I", instrument: "INDEX", label: "Nifty 50" },
  BANKNIFTY: { securityId: "25", segment: "IDX_I", instrument: "INDEX", label: "Bank Nifty" },
  SENSEX:    { securityId: "51", segment: "IDX_I", instrument: "INDEX", label: "Sensex" },
};

// Dhan intraday interval (minutes) keyed by our timeframe label.
const DHAN_TF_INTERVAL = { "1m": "1", "5m": "5", "15m": "15", "1H": "60" };

// Last Dhan-fetch error, surfaced to the Backtest UI for clear diagnostics.
let dhanLastError = "";

// Fetch historical candles from Dhan for backtesting.
// PRIMARY: route through the local MT5 bridge (Python, no CORS) — reliable, and
// it uses the AUTO-REFRESHED config token (the browser token may be stale).
// FALLBACK: a public CORS proxy (allorigins) if the bridge isn't running.
// `tf` is one of: "1m","5m","15m","1H","1D". Returns [{time,...}] or null.
async function fetchDhanHistorical(instrumentKey, tf, fromDate, toDate) {
  const token  = getDhanToken();
  const client = getDhanClientId();
  const meta   = DHAN_INSTRUMENTS[instrumentKey];
  if (!meta) return null;        // bridge supplies the token; browser token optional
  dhanLastError = "";

  const toRow = (t, o, h, l, c, v) => ({
    time: new Date(Number(t) * 1000).toISOString(),
    open: Number(o), high: Number(h), low: Number(l), close: Number(c),
    volume: Number(v || 0),
  });

  // ── 1) Local bridge (preferred — uses the fresh auto-refreshed token) ─────
  const bridgeBase = getAnyBridgeUrl();
  if (bridgeBase) {
    try {
      const url = bridgeBase.replace(/\/signal\/?$/, "") + "/dhan/historical";
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument: instrumentKey, tf, fromDate, toDate, token, clientId: client }),
        signal: AbortSignal.timeout(20000),
      });
      const d = await r.json().catch(()=>null);
      if (r.ok && d?.ok && Array.isArray(d.candles) && d.candles.length) {
        return d.candles.map(k => toRow(k.time, k.open, k.high, k.low, k.close, k.volume));
      }
      if (d?.error) dhanLastError = d.error;   // surface the bridge's real reason
    } catch (e) { dhanLastError = "bridge unreachable — is bridge.py running?"; }
  } else {
    dhanLastError = "no MT5 bridge URL set in Settings → MT5 Terminal";
  }

  // ── 2) Public CORS proxy (fallback) ──────────────────────────────────────
  const isDaily = tf === "1D";
  const endpoint = isDaily
    ? "https://api.dhan.co/v2/charts/historical"
    : "https://api.dhan.co/v2/charts/intraday";
  const body = isDaily
    ? { securityId: meta.securityId, exchangeSegment: meta.segment, instrument: meta.instrument,
        expiryCode: 0, oi: false, dhanClientId: client, fromDate, toDate }
    : { securityId: meta.securityId, exchangeSegment: meta.segment, instrument: meta.instrument,
        interval: Number(DHAN_TF_INTERVAL[tf] || "5"), oi: false, dhanClientId: client, fromDate, toDate };

  try {
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(endpoint)}`;
    const resp = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "access-token": token,
        ...(client ? { "client-id": client } : {}),
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const raw = await resp.json();
    const d = raw?.data || raw;
    const o = d?.open, h = d?.high, l = d?.low, c = d?.close, v = d?.volume, t = d?.timestamp;
    if (!Array.isArray(o) || !Array.isArray(t) || !o.length) return null;
    const n = Math.min(o.length, h.length, l.length, c.length, t.length);
    const out = [];
    for (let i = 0; i < n; i++) out.push(toRow(t[i], o[i], h[i], l[i], c[i], Array.isArray(v) ? v[i] : 0));
    return out;
  } catch { return null; }
}

// Indian cash market hours: Mon–Fri 09:15–15:30 IST.
function isIndianMarketOpen() {
  const now = new Date();
  // Convert to IST (UTC+5:30) regardless of the machine's local zone.
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;       // Sun/Sat
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);  // 555..930
}

// Real Dhan candles for a homepage chart, in the app's candle shape.
// Pulls intraday history (last ~5 days) via the bridge-backed historical path.
async function fetchDhanChartCandles(instrumentKey, tf = "5m") {
  const today = new Date();
  const from  = new Date(today.getTime() - 5 * 86400000);
  const fmt   = d => d.toISOString().slice(0, 10);
  const rows  = await fetchDhanHistorical(instrumentKey, tf, fmt(from), fmt(today));
  if (!rows || rows.length < 10) return null;
  return rows.map(r => ({
    open: r.open, high: r.high, low: r.low, close: r.close,
    bull: r.close >= r.open, vol: r.volume || 0, ts: new Date(r.time).getTime(),
  }));
}

// Last-resort live Nifty quote when the bridge isn't running. The primary
// source is the bridge /price (Dhan, server-side); this allorigins proxy path
// is flaky and only a fallback.
async function fetchDhanNifty() {
  const token = getDhanToken();
  if (!token) return null;
  try {
    // Use allorigins proxy to bypass CORS
    const body    = JSON.stringify({ IDX_I: ["13"] });
    const encoded = encodeURIComponent("https://api.dhan.co/v2/marketfeed/quote");
    const proxyUrl = `https://api.allorigins.win/raw?url=${encoded}`;
    const resp = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "access-token":  token,
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const q = data?.data?.IDX_I?.["13"]
           || data?.IDX_I?.["13"]
           || data?.["13"];
    if (!q) return null;
    const ltp  = parseFloat(q.ltp || q.LTP || q.last_price || 0);
    const prev = parseFloat(q.close || q.Close || q.prev_close || q.prevClose || 0);
    if (!ltp) return null;
    return { price: ltp, change: prev ? ((ltp-prev)/prev)*100 : 0, source:"Dhan" };
  } catch { return null; }
}

// Live prices straight from the MT5 terminal, via the local bridge.
// Uses whichever MT5 account has a Bridge URL set (price data is the same for
// demo/live), so it works regardless of the Execution mode. Returns {} if no
// bridge URL is set or the bridge isn't running — callers then use web sources.
function getAnyBridgeUrl() {
  try {
    const s = JSON.parse(localStorage.getItem("alphaedge_settings") || "{}");
    // Fall back to the local bridge (always on :5000) so Dhan/Options/History
    // features work out-of-the-box when the bridge is running.
    return s?.broker?.mt5?.demo?.bridgeUrl || s?.broker?.mt5?.live?.bridgeUrl || DEFAULT_BRIDGE_URL;
  } catch { return DEFAULT_BRIDGE_URL; }
}

async function fetchMT5Prices() {
  const base = getAnyBridgeUrl();
  if (!base) return {};
  const url = base.replace(/\/signal\/?$/, "") + "/price";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return {};
    const d = await r.json();
    return (d && typeof d === "object" && !d.error) ? d : {};
  } catch { return {}; }
}

async function fetchMT5Account() {
  const base = getAnyBridgeUrl();
  if (!base) return null;
  const url = base.replace(/\/signal\/?$/, "") + "/account";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const d = await r.json();
    return (d && d.balance != null) ? d : null;
  } catch { return null; }
}

// AlphaEdge-only MT5 trades (open + closed, magic-filtered) from the bridge —
// the source of truth for History outcomes. Returns [] if the bridge is down.
async function fetchMT5History(days = 30) {
  const base = getAnyBridgeUrl();
  if (!base) return [];
  const url = base.replace(/\/signal\/?$/, "") + `/history?days=${days}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.trades) ? d.trades : [];
  } catch { return []; }
}

// Live option chain (ATM±range, greeks/IV) via the bridge. Falls back to the
// last collected snapshot off-hours (the bridge handles that). Returns the
// bridge response or {ok:false,error}.
async function fetchOptionChain(underlying, range = 6) {
  const base = getAnyBridgeUrl();
  if (!base) return { ok:false, error:"Start the MT5 bridge — Dhan calls route through it." };
  try {
    const url = base.replace(/\/signal\/?$/, "") + "/dhan/optionchain";
    const r = await fetch(url, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ underlying, range, token:getDhanToken(), clientId:getDhanClientId() }),
      signal: AbortSignal.timeout(20000),
    });
    return await r.json();
  } catch (e) { return { ok:false, error:String(e) }; }
}

// Match an AlphaEdge signal to its MT5 trade. Primary: stored ticket. Fallback:
// same symbol + side, opened within 12h after the signal, nearest entry price.
function matchTradeToSignal(sig, trades) {
  if (!sig || !Array.isArray(trades)) return null;
  if (sig.mt5Ticket) {
    const byTicket = trades.find(t => String(t.ticket) === String(sig.mt5Ticket));
    if (byTicket) return byTicket;
  }
  const side = sig.bias === "BULLISH" ? "buy" : sig.bias === "BEARISH" ? "sell" : null;
  if (!side) return null;
  const symKey = String(sig.asset || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const sigSec = Math.floor((sig.timestamp || 0) / 1000);
  const cands = trades.filter(t => {
    const tSym = String(t.symbol || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
    const sameSym = tSym.includes(symKey) || symKey.includes(tSym);
    const dt = (t.open_time || 0) - sigSec;
    return sameSym && t.side === side && dt >= -300 && dt <= 12 * 3600;
  });
  if (!cands.length) return null;
  const entry = Number(sig.entry) || 0;
  return cands.sort((a, b) =>
    Math.abs((a.open_price || 0) - entry) - Math.abs((b.open_price || 0) - entry))[0];
}

// ─── REAL PRICE FETCHER ───────────────────────────────────────────────────────
async function fetchRealPrices() {
  const result = {};

  // ── Primary: live prices from the MT5 terminal (via local bridge) ──────────
  const mt5p = await fetchMT5Prices();
  if (mt5p.BTCUSD) result.BTCUSD = mt5p.BTCUSD;
  if (mt5p.ETHUSD) result.ETHUSD = mt5p.ETHUSD;

  // ── BTC + ETH fallback: Binance (only for whatever MT5 didn't provide) ─────
  if (!result.BTCUSD || !result.ETHUSD) {
    try {
      const resp = await fetch(
        "https://api.binance.com/api/v3/ticker/24hr?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22%5D",
        { signal: AbortSignal.timeout(4000) }
      );
      if (resp.ok) {
        const data = await resp.json();
        data.forEach(t => {
          if (t.symbol === "BTCUSDT" && !result.BTCUSD)
            result.BTCUSD = { price:parseFloat(t.lastPrice), change:parseFloat(t.priceChangePercent), source:"Binance" };
          if (t.symbol === "ETHUSDT" && !result.ETHUSD)
            result.ETHUSD = { price:parseFloat(t.lastPrice), change:parseFloat(t.priceChangePercent), source:"Binance" };
        });
      }
    } catch {}
  }

  // ── Gold: MT5 first, then web fallbacks ────────────────────────────────────
  let goldPrice = mt5p.XAUUSD || null;

  // Source 1: goldprice.org public CORS-enabled API (real-time spot ~$4538)
  if (!goldPrice) {
    try {
      const resp = await fetch(
        "https://data-asg.goldprice.org/dbXRates/USD",
        { signal: AbortSignal.timeout(4000) }
      );
      if (resp.ok) {
        const gd    = await resp.json();
        const item  = gd?.items?.[0];
        const price = parseFloat(item?.xauPrice || 0);
        if (price > 1000) goldPrice = { price, change: 0, source: "GoldPrice.org" };
      }
    } catch {}
  }

  // Source 2: gold-api.com (free, no key)
  if (!goldPrice) {
    try {
      const resp = await fetch(
        "https://api.gold-api.com/price/XAU",
        { signal: AbortSignal.timeout(4000) }
      );
      if (resp.ok) {
        const gd    = await resp.json();
        const price = parseFloat(gd?.price || gd?.Price || 0);
        if (price > 1000) goldPrice = { price, change: parseFloat(gd?.chp || 0), source: "GoldAPI.com" };
      }
    } catch {}
  }

  // Source 3: Yahoo Finance GC=F using last real candle close (not cached meta)
  if (!goldPrice) {
    try {
      const resp = await fetch(
        "https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1m&range=1d",
        { signal: AbortSignal.timeout(4000) }
      );
      if (resp.ok) {
        const gd      = await resp.json();
        const result0 = gd?.chart?.result?.[0];
        const closes  = result0?.indicators?.quote?.[0]?.close || [];
        const cur     = [...closes].reverse().find(v => v != null && v > 1000);
        const prev    = parseFloat(result0?.meta?.chartPreviousClose || 0);
        if (cur) goldPrice = { price: cur, change: prev ? ((cur-prev)/prev)*100 : 0, source: "Yahoo GC=F" };
      }
    } catch {}
  }

  // Source 4: metals.dev via CORS proxy
  if (!goldPrice) {
    try {
      const url  = encodeURIComponent("https://api.metals.dev/v1/spot?api_key=goldbackedtoken&unit=toz&currency=USD");
      const resp = await fetch(`https://api.allorigins.win/raw?url=${url}`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const gd    = await resp.json();
        const price = parseFloat(gd?.metals?.gold || 0);
        if (price > 1000) goldPrice = { price, change: 0, source: "Metals.dev" };
      }
    } catch {}
  }

  if (goldPrice) result.XAUUSD = goldPrice;

  // ── Nifty 50: MT5 first (if offered), then web sources ─────────────────────
  let nifty = mt5p.NIFTY50 || null;

  // Source 1: Dhan (most accurate, live, via proxy)
  if (!nifty) nifty = await fetchDhanNifty();

  // Source 2: Yahoo Finance ^NSEI
  if (!nifty) {
    try {
      const resp = await fetch(
        "https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1m&range=1d",
        { signal: AbortSignal.timeout(4000) }
      );
      if (resp.ok) {
        const nd   = await resp.json();
        const meta = nd?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice) {
          const cur  = parseFloat(meta.regularMarketPrice);
          const prev = parseFloat(meta.chartPreviousClose || meta.regularMarketPreviousClose || cur);
          nifty = { price:cur, change:prev?((cur-prev)/prev)*100:0, source:"Yahoo ^NSEI" };
        }
      }
    } catch {}
  }

  // Source 3: Yahoo Finance NSEI.NS (Nifty index via allorigins proxy)
  if (!nifty) {
    try {
      const url = encodeURIComponent("https://query2.finance.yahoo.com/v8/finance/chart/^NSEI?interval=1m&range=1d");
      const resp = await fetch(`https://api.allorigins.win/raw?url=${url}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (resp.ok) {
        const nd   = await resp.json();
        const meta = nd?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice) {
          const cur  = parseFloat(meta.regularMarketPrice);
          const prev = parseFloat(meta.chartPreviousClose || cur);
          nifty = { price:cur, change:prev?((cur-prev)/prev)*100:0, source:"Yahoo2 ^NSEI" };
        }
      }
    } catch {}
  }

  // Source 4: NSEIndia open data (no key, browser accessible)
  if (!nifty) {
    try {
      const resp = await fetch(
        "https://www.nseindia.com/api/allIndices",
        {
          signal: AbortSignal.timeout(5000),
          headers: { "Accept":"application/json", "Referer":"https://www.nseindia.com/" }
        }
      );
      if (resp.ok) {
        const nd = await resp.json();
        const nifty50 = nd?.data?.find(d=>d.index==="NIFTY 50");
        if (nifty50) {
          nifty = {
            price:  parseFloat(nifty50.last || nifty50.indexValue || 0),
            change: parseFloat(nifty50.percentChange || 0),
            source: "NSEIndia",
          };
        }
      }
    } catch {}
  }

  if (nifty) result.NIFTY50 = nifty;
  return result;
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function AlphaEdge() {
  const [page, setPage]           = useState(0);
  const [activeAsset, setActiveAsset] = useState("BTCUSD");
  const [history, setHistory]     = useState([]);
  const [clock, setClock]         = useState(new Date());
  const [autoSignalOn, setAutoSignalOn] = useState(
    localStorage.getItem("alphaedge_autosignal") === "true"
  );
  const toggleAutoSignal = () => {
    const next = !autoSignalOn;
    setAutoSignalOn(next);
    localStorage.setItem("alphaedge_autosignal", String(next));
  };

  const [candles, setCandles] = useState(()=>{
    const d={};
    // Candles start with base prices — will be anchored to real price on first fetch
    ASSETS.forEach(a=>{d[a.id]=genCandles(a.base, 300);});
    return d;
  });
  const [prices,  setPrices]  = useState(()=>Object.fromEntries(ASSETS.map(a=>[a.id,a.base])));
  const [changes, setChanges] = useState(()=>Object.fromEntries(ASSETS.map(a=>[a.id,0])));
  const [sources, setSources] = useState({}); // per-asset price source label, e.g. "MT5"
  const [priceSource, setPriceSource] = useState("loading"); // "live" | "simulated" | "loading"
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [marketOpen, setMarketOpen] = useState(isIndianMarketOpen());
  // Asset ids whose candles are REAL (from Dhan) — excluded from synthetic ticks.
  const realCandlesRef = useRef(new Set());

  // Load history from storage on mount + purge expired
  useEffect(()=>{
    loadHistory().then(h=>setHistory(h));
  },[]);

  // Month-end Obsidian export (catch-up on load): writes any completed, not-yet-
  // exported month's trades to E:\Obsidian\Trading_Mind\raw\trades\alphaedge\ via
  // the bridge. Delayed slightly so it never competes with first-paint work.
  useEffect(()=>{
    const t=setTimeout(()=>{ exportMonthlyToObsidian(); }, 4000);
    return ()=>clearTimeout(t);
  },[]);

  // Live clock
  useEffect(()=>{
    const t=setInterval(()=>setClock(new Date()),30000);
    return ()=>clearInterval(t);
  },[]);

  // ── Real price fetcher — applies live prices + re-anchors synthetic charts ──
  const fetchAndApply = useCallback(async () => {
    const real = await fetchRealPrices();

    if (Object.keys(real).length > 0) {
      setPriceSource("live");

      setPrices(prev => {
        const next = { ...prev };
        Object.entries(real).forEach(([id, d]) => { next[id] = d.price; });
        return next;
      });

      setChanges(prev => {
        const next = { ...prev };
        Object.entries(real).forEach(([id, d]) => { next[id] = d.change; });
        return next;
      });

      setSources(prev => {
        const next = { ...prev };
        Object.entries(real).forEach(([id, d]) => { if (d.source) next[id] = d.source; });
        return next;
      });

      // Surface Indian market open/closed (the bridge tags Dhan quotes).
      if (real.NIFTY50 && typeof real.NIFTY50.marketOpen === "boolean") {
        setMarketOpen(real.NIFTY50.marketOpen);
      } else {
        setMarketOpen(isIndianMarketOpen());
      }

      // Re-anchor synthetic candles to real price — but NOT assets that already
      // have real Dhan candles (those must not be distorted).
      setCandles(prev => {
        const next = { ...prev };
        Object.entries(real).forEach(([id, d]) => {
          if (realCandlesRef.current.has(id)) return;
          const arr = prev[id];
          if (!arr || !arr.length) return;
          const last   = arr[arr.length - 1];
          const ratio  = d.price / last.close;
          if (Math.abs(ratio - 1) > 0.005) {
            next[id] = arr.map((c, i) => {
              const weight = (i / arr.length) * (ratio - 1) + 1;
              return { ...c, open:c.open*weight, close:c.close*weight, high:c.high*weight, low:c.low*weight };
            });
          }
        });
        return next;
      });

    } else {
      setPriceSource("simulated");
    }
  }, []);

  // Load REAL intraday candles from Dhan for Indian indices (chart data).
  const loadDhanCandles = useCallback(async () => {
    if (!getDhanToken()) return;
    const real = await fetchDhanChartCandles("NIFTY50", "5m");
    if (real && real.length) {
      realCandlesRef.current.add("NIFTY50");
      setCandles(prev => ({ ...prev, NIFTY50: real.slice(-90) }));
    }
  }, []);

  // Manual refresh — triggered by clicking the AlphaEdge logo on the homepage.
  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.all([fetchAndApply(), loadDhanCandles()]); }
    finally { setLastRefresh(Date.now()); setRefreshing(false); }
  }, [fetchAndApply, loadDhanCandles]);

  useEffect(()=>{
    let cancelled = false;
    const tick = async () => { if (!cancelled) await fetchAndApply(); };
    tick();
    loadDhanCandles();
    const interval = setInterval(tick, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [fetchAndApply, loadDhanCandles]);

  // ── Simulated micro-ticks between real fetches (small jitter only) ─────────
  useEffect(()=>{
    const t = setInterval(()=>{
      setPrices(prev=>{
        const next={...prev};
        // Tiny jitter ±0.03% — keeps ticker live-feeling between 15s fetches.
        // Skip NIFTY50 — it carries a real Dhan price (and is frozen when the
        // Indian market is closed); fake jitter would misrepresent it.
        ASSETS.forEach(a=>{ if(a.id!=="NIFTY50") next[a.id] = prev[a.id] * (1 + (Math.random()-0.5)*0.0003); });
        return next;
      });
    }, 2000);
    return ()=>clearInterval(t);
  },[]);

  // Candle ticks
  useEffect(()=>{
    const t=setInterval(()=>{
      setCandles(prev=>{
        const next={...prev};
        ASSETS.forEach(a=>{
          if(realCandlesRef.current.has(a.id)) return; // real Dhan candles — don't synthesise
          const arr=prev[a.id]||[];
          if(!arr.length) return;
          const last=arr[arr.length-1];
          const mv=(Math.random()-0.48)*last.close*0.001; // smaller moves — 0.1%
          const c=last.close+mv;
          const h=Math.max(last.close,c)+Math.abs(mv)*Math.random()*0.4;
          const l=Math.min(last.close,c)-Math.abs(mv)*Math.random()*0.4;
          const ts=Date.now();
          next[a.id]=[...arr.slice(-89),{open:last.close,close:c,high:h,low:l,bull:c>=last.close,vol:Math.random()*800+200,ts}];
        });
        return next;
      });
    },3000);
    return ()=>clearInterval(t);
  },[]);

  // ── Trade-CLOSED Telegram watcher ──────────────────────────────────────────
  // Polls MT5 history app-wide and alerts on newly-closed AlphaEdge trades.
  // Dedups via localStorage; the first run on an empty store is a silent
  // baseline so historical closes don't spam on first launch.
  useEffect(()=>{
    const KEY = "alphaedge_notified_closed";
    let seen; try { seen = new Set(JSON.parse(localStorage.getItem(KEY)||"[]")); } catch { seen = new Set(); }
    let baseline = seen.size === 0;
    let stop = false;
    const tick = async () => {
      const trades = await fetchMT5History(7);
      if (stop || !Array.isArray(trades)) return;
      let changed = false;
      for (const t of trades) {
        const id = String(t.ticket);
        if (t.state === "closed" && !seen.has(id)) {
          if (!baseline) sendTradeAlert("closed", { venue:"MT5", ...t });
          seen.add(id); changed = true;
        }
      }
      if (baseline) { baseline = false; changed = true; }
      if (changed) { try { localStorage.setItem(KEY, JSON.stringify([...seen].slice(-1000))); } catch {} }
    };
    tick();
    const iv = setInterval(tick, 30000);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  // Called by AISignalPage after saving a new signal
  const handleSignalSaved = useCallback((updatedHistory)=>{
    setHistory(updatedHistory);
  },[]);

  const pendingCount = history.filter(s=>s.outcome==="pending").length;
  const sideItems    = PAGES.map((p,i)=>({label:p,icon:PAGE_ICONS[i]}));

  const pageComponents=[
    <DashboardPage key="dash"
      prices={prices} changes={changes} candles={candles} sources={sources}
      activeAsset={activeAsset} setActiveAsset={setActiveAsset}
      marketOpen={marketOpen} onRefresh={refreshNow} refreshing={refreshing}/>,

    <AISignalPage key="ai"
      onSignalSaved={handleSignalSaved}
      prices={prices}/>,

    <BacktestPage key="bt" candles={candles}/>,

    <ExecutionPage key="exec" prices={prices}/>,

    <PortfolioPage key="port"/>,

    <AlertsPage key="alerts" prices={prices} history={history}/>,

    <HistoryPage key="hist"
      history={history} setHistory={setHistory}/>,

    <RiskCalcPage key="risk"/>,

    <CalendarPage key="cal"/>,

    <MTFConfluencePage key="mtf" candles={candles} prices={prices}/>,

    <JournalPage key="journal"/>,

    <AnalyticsPage key="analytics" candles={candles} prices={prices} history={history}/>,

    <OptionsDeskPage key="options"/>,

    <SettingsPage key="settings"/>,
  ];

  return (
    <div style={{display:"flex",height:"100vh",background:"#060d17",
      fontFamily:"'JetBrains Mono','Fira Code',monospace",color:"#cbd5e1",overflow:"hidden"}}>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>

      {/* ── Sidebar ── */}
      <div style={{width:204,background:"#0a1628",borderRight:"0.5px solid #1e3a5a",
        display:"flex",flexDirection:"column",padding:"12px 0",flexShrink:0,overflowY:"auto"}}>

        {/* Logo — doubles as the homepage refresh button */}
        <div
          onClick={()=>{ setPage(0); refreshNow(); }}
          title={lastRefresh ? `Refresh homepage · last ${new Date(lastRefresh).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",second:"2-digit",timeZone:"Asia/Kolkata"})} IST` : "Refresh homepage data"}
          style={{flexShrink:0,boxSizing:"border-box",padding:"6px 10px 10px",borderBottom:"0.5px solid #1e3a5a",marginBottom:8,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
          <img
            src="/assets/alphaedge-logo-sidebar.png"
            alt="AlphaEdge — click to refresh"
            style={{width:"100%",height:"auto",maxHeight:62,objectFit:"contain",display:"block",borderRadius:6,
              opacity:refreshing?0.55:1,
              animation:refreshing?"spin 0.9s linear infinite":"none",transition:"opacity 0.2s"}}
          />
          <div style={{fontSize:7,letterSpacing:"0.1em",color:refreshing?"#60a5fa":"#475569",marginTop:3,fontFamily:"monospace"}}>
            {refreshing?"REFRESHING…":"↻ CLICK TO REFRESH"}
          </div>
        </div>

        {/* Nav items */}
        {sideItems.map((s,i)=>{
          const isActive = page===i;
          // Badges: Alerts(5)=live price alerts unread, History(6)=pending, Calendar(8)=high-impact events
          const priceAlertCount = [prices.BTCUSD, prices.XAUUSD, prices.ETHUSD, prices.NIFTY50].filter(Boolean).length;
          const badge = i===5 ? priceAlertCount
            : i===6 && pendingCount>0 ? pendingCount
            : i===8 ? getEconEvents().filter(e=>e.impact==="high"&&!e.actual&&new Date(e.datetime).getTime()>=Date.now()).length
            : 0;
          return (
            <div key={s.label} onClick={()=>setPage(i)}
              style={{display:"flex",alignItems:"center",gap:10,padding:"8px 16px",
                cursor:"pointer",transition:"all 0.15s",
                color:isActive?"#60a5fa":"#94a3b8",
                fontSize:12,fontWeight:isActive?700:400,
                borderLeft:`2px solid ${isActive?"#3b82f6":"transparent"}`,
                background:isActive?"#111e30":"transparent"}}>
              <span style={{fontSize:14,flexShrink:0}}>{s.icon}</span>
              <span style={{flex:1}}>{s.label}</span>
              {badge>0 && (
                <span style={{background:i===6?"#7c3aed":i===8?"#f59e0b":"#ef4444",color:i===8?"black":"white",
                  fontSize:8,fontWeight:700,padding:"1px 5px",borderRadius:8,minWidth:16,textAlign:"center"}}>
                  {badge}
                </span>
              )}
            </div>
          );
        })}

        <div style={{flex:1}}/>

        {/* History storage info */}
        <div style={{padding:"8px 16px",borderTop:"0.5px solid #1e3a5a",borderBottom:"0.5px solid #1e3a5a",marginBottom:4}}>
          <div style={{fontSize:8,color:"#64748b",letterSpacing:"0.08em",marginBottom:4}}>SIGNAL STORAGE</div>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:9,color:"#7c8ea8"}}>{history.length} signals</span>
            <span style={{fontSize:9,color:"#7c8ea8"}}>30-day window</span>
          </div>
          {history.length>0&&(
            <div style={{height:3,background:"#1e2a3a",borderRadius:2,marginTop:5}}>
              <div style={{height:3,width:`${Math.min(history.length/50*100,100)}%`,
                background:"linear-gradient(90deg,#3b82f6,#7c3aed)",borderRadius:2}}/>
            </div>
          )}
        </div>

        {/* Auto-Signal quick toggle in sidebar */}
        <div onClick={toggleAutoSignal}
          style={{margin:"4px 8px",display:"flex",alignItems:"center",gap:8,cursor:"pointer",
            background:autoSignalOn?"#052e16":"#0d1525",
            border:`1px solid ${autoSignalOn?"#22c55e80":"#1e3a5a"}`,
            borderRadius:8,padding:"8px 10px",transition:"all 0.2s",
            boxShadow:autoSignalOn?"0 0 12px #22c55e25":"none"}}>
          <span style={{fontSize:16}}>🤖</span>
          <div style={{flex:1}}>
            <div style={{fontSize:10,fontWeight:700,color:autoSignalOn?"#22c55e":"#94a3b8",
              letterSpacing:"0.04em"}}>AUTO SIGNAL</div>
            <div style={{fontSize:8,color:autoSignalOn?"#16a34a":"#7c8ea8",marginTop:1}}>
              {autoSignalOn?"Broadcasts during kill zones":"Click to enable"}
            </div>
          </div>
          <div style={{width:32,height:17,borderRadius:9,flexShrink:0,
            background:autoSignalOn?"#22c55e":"#1e2a3a",
            border:`1px solid ${autoSignalOn?"#22c55e":"#1e3a5a"}`,
            position:"relative",transition:"all 0.2s"}}>
            <div style={{width:13,height:13,borderRadius:"50%",
              background:autoSignalOn?"white":"#94a3b8",
              position:"absolute",top:2,left:autoSignalOn?17:2,
              transition:"left 0.2s"}}/>
          </div>
        </div>

        {/* User footer */}
        <div style={{padding:"10px 16px"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:28,height:28,borderRadius:"50%",
              background:"linear-gradient(135deg,#1d4ed8,#7c3aed)",
              display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:11,color:"white",fontWeight:700,flexShrink:0}}>A</div>
            <div>
              <div style={{fontSize:11,color:"#e2e8f0",fontWeight:600}}>Trader</div>
              {(()=>{
                const em=getExecMode();
                const m=em==="mt5_live"?{t:"MT5 Live",c:"#ef4444"}
                      :em==="mt5_demo"?{t:"MT5 Demo",c:"#22c55e"}
                      :{t:"Paper Mode",c:"#60a5fa"};
                return <div style={{fontSize:8,color:m.c}}>● {m.t}</div>;
              })()}
            </div>
          </div>
        </div>
      </div>

      {/* ── Main area ── */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>

        {/* Topbar */}
        <div style={{height:44,background:"#0a1628",borderBottom:"0.5px solid #1e3a5a",
          display:"flex",alignItems:"center",padding:"0 16px",gap:12,flexShrink:0}}>
          <span style={{fontSize:12,fontWeight:700,color:"#e2e8f0"}}>{PAGES[page]}</span>

          {/* Breadcrumb path */}
          <span style={{fontSize:9,color:"#64748b"}}>/ {PAGES[page].toLowerCase()}</span>

          <div style={{flex:1}}/>

          {/* History quick-stat in header when on other pages */}
          {page!==6 && history.length>0 && (
            <span onClick={()=>setPage(6)}
              style={{fontSize:9,color:"#a78bfa",background:"#1e1040",padding:"3px 8px",borderRadius:5,
                border:"0.5px solid #7c3aed40",cursor:"pointer",letterSpacing:"0.04em"}}>
              ◷ {history.length} signals · {pendingCount} pending
            </span>
          )}

          <span style={{fontSize:9,color:"#22c55e",background:"#052e16",padding:"3px 8px",
            borderRadius:5,border:"0.5px solid #22c55e30"}}>● MARKETS OPEN</span>

          {/* Price source indicator */}
          <span style={{fontSize:9,padding:"3px 8px",borderRadius:5,fontFamily:"monospace",
            color: priceSource==="live"?"#22c55e": priceSource==="simulated"?"#f59e0b":"#94a3b8",
            background: priceSource==="live"?"#052e16": priceSource==="simulated"?"#1c1300":"#0a1628",
            border:`0.5px solid ${priceSource==="live"?"#22c55e30": priceSource==="simulated"?"#f59e0b30":"#1e3a5a"}`}}>
            {priceSource==="live"
              ? `📡 Live${getDhanToken()?" · Dhan+Binance":" · Binance+Yahoo"}`
              : priceSource==="simulated"?"⚠ Simulated":"⟳ Fetching..."}
          </span>

          <span style={{fontSize:9,color:"#60a5fa",background:"#111e30",padding:"3px 8px",borderRadius:5,fontFamily:"monospace"}}>
            {new Date(clock.getTime()+5.5*60*60*1000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"UTC"})} IST
          </span>

          {/* Auto-Signal toggle — prominent */}
          <div onClick={toggleAutoSignal} style={{
            display:"flex",alignItems:"center",gap:6,cursor:"pointer",
            background: autoSignalOn
              ? "linear-gradient(135deg,#052e16,#0a2e1a)"
              : "#0a1628",
            border:`1px solid ${autoSignalOn?"#22c55e":"#7c8ea8"}`,
            borderRadius:7,padding:"4px 10px",transition:"all 0.2s",
            boxShadow: autoSignalOn?"0 0 10px #22c55e30":"none",
          }}>
            <span style={{fontSize:13}}>🤖</span>
            <div>
              <div style={{fontSize:9,fontWeight:700,
                color:autoSignalOn?"#22c55e":"#64748b",
                letterSpacing:"0.04em",lineHeight:1}}>
                AUTO SIGNAL
              </div>
              <div style={{fontSize:7,color:autoSignalOn?"#16a34a":"#7c8ea8",lineHeight:1.4}}>
                {autoSignalOn?"● ON — Kill zones":"○ OFF"}
              </div>
            </div>
            {/* Toggle pill */}
            <div style={{width:28,height:15,borderRadius:8,
              background:autoSignalOn?"#22c55e":"#1e2a3a",
              border:`1px solid ${autoSignalOn?"#22c55e":"#1e3a5a"}`,
              position:"relative",transition:"all 0.2s",flexShrink:0}}>
              <div style={{width:11,height:11,borderRadius:"50%",
                background:autoSignalOn?"white":"#94a3b8",
                position:"absolute",top:2,
                left:autoSignalOn?15:2,
                transition:"left 0.2s"}}/>
            </div>
          </div>

          <span style={{fontSize:9,color:"#7c8ea8"}}>v2.1 — DeepSeek V4</span>
        </div>

        {/* Page content */}
        <div style={{flex:1,overflow:"hidden",padding:12}}>
          {pageComponents[page]}
        </div>

        {/* Auto-Signal Engine — runs in background */}
        <AutoSignalEngine prices={prices} changes={changes} enabled={autoSignalOn} onSignalSaved={handleSignalSaved}/>

      </div>
    </div>
  );
}
