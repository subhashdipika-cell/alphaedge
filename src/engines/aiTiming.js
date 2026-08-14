// Chronos timing-layer adapter.
//
// This module deliberately does not approve, size, or execute trades. It turns
// a forecast distribution into an auditable shadow assessment that the existing
// deterministic score and risk engines may log, but never bypass.

export const AI_TIMING_VERSION = "chronos-2-shadow-v1";

function finite(v) {
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

export function evaluateTimingShadow({
  entryPremium,
  q10,
  q50,
  q90,
  stopPremium,
  targetPremium,
  horizonMin = 10,
  model = "chronos-2",
  modelVersion = AI_TIMING_VERSION,
  dataTimestamp = null,
} = {}) {
  const entry = finite(entryPremium);
  const lower = finite(q10);
  const median = finite(q50);
  const upper = finite(q90);
  const stop = finite(stopPremium);
  const target = finite(targetPremium);
  const missing = [entry, lower, median, upper, stop, target].some(v => v == null);

  if (missing || entry <= 0 || lower <= 0 || median <= 0 || upper <= 0) {
    return {
      ok: false,
      shadowOnly: true,
      allow: false,
      status: "UNAVAILABLE",
      reason: "Incomplete forecast or trade levels",
      model,
      modelVersion,
      horizonMin,
      dataTimestamp,
    };
  }

  const downside = Math.max(0, entry - lower);
  const upside = Math.max(0, upper - entry);
  const plannedRisk = stop != null ? Math.max(0, entry - stop) : null;
  const plannedReward = target != null ? Math.max(0, target - entry) : null;
  const forecastR = downside > 0 ? upside / downside : upside > 0 ? Infinity : 0;

  // This is a conservative diagnostic, not a calibrated probability. A real
  // go/no-go gate must be trained and calibrated on AlphaEdge outcomes.
  const directionalSupport = median > entry;
  const rangeSupportsPlan = plannedRisk == null || upside >= plannedRisk;
  const targetHasRoom = plannedReward == null || upper >= target;
  const allow = directionalSupport && rangeSupportsPlan && targetHasRoom;

  return {
    ok: true,
    shadowOnly: true,
    allow,
    status: allow ? "SUPPORTIVE" : "CAUTION",
    reason: allow
      ? "Forecast median and upper range support the planned premium move"
      : "Forecast does not support the planned premium move before the timing horizon",
    model,
    modelVersion,
    horizonMin,
    dataTimestamp,
    entryPremium: entry,
    q10: lower,
    q50: median,
    q90: upper,
    downside,
    upside,
    forecastR: Number.isFinite(forecastR) ? +forecastR.toFixed(2) : null,
    directionalSupport,
    rangeSupportsPlan,
    targetHasRoom,
  };
}

export function timingFromChronosResponse(payload, trade = {}) {
  if (!payload?.ok) {
    return evaluateTimingShadow({ ...trade, model: payload?.model || "chronos-2", dataTimestamp: payload?.dataTimestamp });
  }
  return evaluateTimingShadow({
    ...trade,
    q10: payload.q10 ?? payload.quantiles?.q10,
    q50: payload.q50 ?? payload.quantiles?.q50,
    q90: payload.q90 ?? payload.quantiles?.q90,
    model: payload.model || "chronos-2",
    modelVersion: payload.modelVersion || AI_TIMING_VERSION,
    dataTimestamp: payload.dataTimestamp || null,
    horizonMin: payload.horizonMin || trade.horizonMin || 10,
  });
}
