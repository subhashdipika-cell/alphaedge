// ─── SETTINGS + MONEY-MGT + RISK-POLICY STORAGE ───────────────────────────────
// localStorage-backed app settings, position-sizing rules, and the derived risk
// policy the score/plan engines read.

import { MIN_BIG_PROFIT_RR, MAX_SIGNAL_RISK_PCT } from "../engines/learning.js";

export const SETTINGS_KEY = "alphaedge_settings";

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function persistSettings(data) {
  try {
    const existing = loadSettings() || {};
    const merged = { ...existing, ...data };
    // Deep-merge broker so fields set elsewhere are not wiped when the Settings
    // page saves its partial broker state.
    merged.broker = { ...(existing.broker || {}), ...(data.broker || {}) };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  } catch {}
}

// ─── Money management (position-sizing rules for the paper-trade plan) ──
export const MONEY_MGT_DEFAULTS = {
  capital: 400000,      // account capital (₹) — default trading capital
  useSL: false,         // if true, force the fixed SL distance below
  slPoints: 50,         // fixed stop-loss distance in premium points
  rr: 2,                // reward:risk multiple (1, 1.5, 2, 2.5) or "trail"
  trailMaxRR: 3,        // in "trail" mode, run until this R:R (up to 50)
};
export function getMoneyMgt() {
  try { return { ...MONEY_MGT_DEFAULTS, ...JSON.parse(localStorage.getItem("alphaedge_money_mgt") || "{}") }; }
  catch { return { ...MONEY_MGT_DEFAULTS }; }
}
export function setMoneyMgt(v) {
  try { localStorage.setItem("alphaedge_money_mgt", JSON.stringify(v)); } catch { /* ignore */ }
}

// ─── Risk policy — caps planned per-trade risk to protect against Big Losses ──
export function getRiskPolicy() {
  let configuredRiskPct = 1;
  let configuredDailyPct = 3;
  try {
    const settings = loadSettings() || {};
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
