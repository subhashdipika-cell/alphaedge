// ─── SIGNAL / RECOMMENDATION HISTORY STORAGE ──────────────────────────────────
// 30-day live signal history + a ~400-day durable archive for the monthly
// Obsidian export. Every save re-trains the learning profile.

import { saveSignalLearning } from "../engines/learning.js";

export const HISTORY_KEY = "signal-history";
export const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

export async function loadHistory() {
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

export async function saveHistory(records) {
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
export const TRADE_ARCHIVE_KEY = "alphaedge_trade_archive";
export const ARCHIVE_RETENTION = 400 * 24 * 60 * 60 * 1000;

export function archiveTrades(records) {
  try {
    const raw  = localStorage.getItem(TRADE_ARCHIVE_KEY);
    const byId = new Map((raw ? JSON.parse(raw) : []).map(r => [r.id, r]));
    (records || []).forEach(r => { if (r && r.id) byId.set(r.id, { ...byId.get(r.id), ...r }); });
    const cutoff = Date.now() - ARCHIVE_RETENTION;
    const merged = [...byId.values()].filter(r => (r.timestamp || 0) > cutoff);
    localStorage.setItem(TRADE_ARCHIVE_KEY, JSON.stringify(merged));
  } catch { /* archive is best-effort — never break a normal save */ }
}

export function loadTradeArchive() {
  try { const raw = localStorage.getItem(TRADE_ARCHIVE_KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}

export async function appendSignal(signal) {
  const existing = await loadHistory();
  const updated = [signal, ...existing];
  return saveHistory(updated);
}

export async function updateOutcome(id, outcome) {
  const existing = await loadHistory();
  const updated = existing.map(s => s.id === id ? { ...s, outcome } : s);
  const saved = saveHistory(updated);
  // Re-train the learning profile every time an outcome is marked.
  try { saveSignalLearning(updated); } catch { /* ignore */ }
  return saved;
}
