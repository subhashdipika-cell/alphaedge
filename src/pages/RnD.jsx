import React, { useState, useEffect, useMemo, useCallback } from "react";
import { loadHistory } from "../state/history.js";
import { fetchReplay } from "../data/bridge.js";
import { styleMetaLearning, regimeAttribution, factorAttribution, tuneWeights, MIN_SAMPLE } from "../engines/rnd.js";
import { getOptionPaperTrades } from "../state/paperTrades.js";
import { getScoreWeights, setScoreWeights, DEFAULT_WEIGHTS } from "../engines/score.js";
import { promotionGate, promotionGatesByStrategy } from "../engines/learning.js";

// ─── R&D — meta-learning over the paper-trade / replay track record ───────────

const C = {
  card: "#0a1628", edge: "#1e3a5a", ink: "#e2e8f0", dim: "#94a3b8", faint: "#7c8ea8",
  green: "#22c55e", red: "#ef4444", amber: "#f59e0b", blue: "#60a5fa", bg: "#060d17", violet: "#a78bfa",
};
const fmt = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-IN", { maximumFractionDigits: d }) : "—");
const FACTOR_LABELS = { trend: "Trend & Structure", momentum: "Momentum", ict: "ICT / SMC", chainOi: "Chain & OI", greeks: "Greeks", ivVix: "IV & VIX", risk: "Risk Mgmt", news: "News & Events" };

function Card({ title, right, children, style }) {
  return (
    <div style={{ background: C.card, border: `0.5px solid ${C.edge}`, borderRadius: 12, padding: 14, ...style }}>
      {(title || right) && (
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 9, color: C.dim, letterSpacing: "0.1em" }}>{title}</span>
          <span style={{ marginLeft: "auto" }}>{right}</span>
        </div>
      )}
      {children}
    </div>
  );
}

export default function RnDPage() {
  const [source, setSource] = useState("replay");   // "replay" | "live"
  const [replay, setReplay] = useState(null);
  const [live, setLive] = useState([]);
  const [loading, setLoading] = useState(false);
  const [weights, setWeights] = useState(getScoreWeights());
  const [applied, setApplied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [rp, h] = await Promise.all([fetchReplay(), loadHistory()]);
    setReplay(rp?.ok ? rp : null);
    setLive(getOptionPaperTrades(h));
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const trades = useMemo(() => (source === "replay" ? (replay?.trades || []) : live), [source, replay, live]);
  const resolved = useMemo(() => trades.filter(t => t.outcome === "win" || t.outcome === "loss"), [trades]);
  const styleML = useMemo(() => styleMetaLearning(resolved), [resolved]);
  const regimes = useMemo(() => regimeAttribution(resolved), [resolved]);
  const factors = useMemo(() => factorAttribution(resolved), [resolved]);
  const tuning = useMemo(() => tuneWeights(resolved, weights), [resolved, weights]);
  const promotion = useMemo(() => promotionGate(trades, { paperOnly: true }), [trades]);
  const promotionByStrategy = useMemo(() => promotionGatesByStrategy(trades, { paperOnly: true }), [trades]);

  const applyWeights = (w) => { setScoreWeights(w); setWeights(w); setApplied(true); setTimeout(() => setApplied(false), 2500); };
  const resetWeights = () => applyWeights(DEFAULT_WEIGHTS);

  const netRs = resolved.reduce((s, t) => s + (Number(t.pnlRs) || 0), 0);
  const wins = resolved.filter(t => t.outcome === "win").length;

  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10 }}>

        {/* Controls */}
        <Card
          title="R&D — META-LEARNING & WEIGHT TUNING"
          right={
            <button onClick={load} disabled={loading}
              style={{ fontSize: 10, padding: "4px 12px", background: C.bg, border: `0.5px solid ${C.edge}`, borderRadius: 6, color: C.blue, cursor: loading ? "default" : "pointer", fontFamily: "monospace" }}>
              {loading ? "◌" : "⟳"} Refresh
            </button>
          }
        >
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {[["replay", "Replay (out-of-sample)"], ["live", "Live paper trades"]].map(([v, l]) => (
              <span key={v} onClick={() => setSource(v)}
                style={{ fontSize: 10, padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontFamily: "monospace",
                  fontWeight: source === v ? 700 : 400, background: source === v ? "#1e3a5a" : C.bg,
                  color: source === v ? C.blue : C.dim, border: `0.5px solid ${source === v ? "#3b82f6" : C.edge}` }}>
                {l}
              </span>
            ))}
            <div style={{ marginLeft: "auto", display: "flex", gap: 16 }}>
              <Stat label="Trades" value={resolved.length} />
              <Stat label="Win Rate" value={resolved.length ? `${(wins / resolved.length * 100).toFixed(0)}%` : "—"} color={wins / resolved.length >= 0.5 ? C.green : C.red} />
              <Stat label="Net P&L" value={resolved.length ? `${netRs >= 0 ? "+" : ""}₹${fmt(netRs, 0)}` : "—"} color={netRs >= 0 ? C.green : C.red} />
            </div>
          </div>
          {source === "replay" && replay?.summary && (
            <div style={{ marginTop: 8, fontSize: 9, color: C.faint }}>
              Replay {replay.summary.from} → {replay.summary.to} · {replay.summary.underlyings?.join(", ")} · every {replay.summary.step}m · risk {replay.summary.risk}% · net of costs.
            </div>
          )}
          {source === "replay" && !replay && (
            <div style={{ marginTop: 8, fontSize: 10, color: C.amber, fontFamily: "monospace" }}>
              No replay found. Run <b>node scripts/replay.mjs</b> (bridge must be running) to backtest the score over the collected chain CSVs.
            </div>
          )}
        </Card>

        {resolved.length < MIN_SAMPLE && (
          <div style={{ background: "#1a1200", border: `0.5px solid ${C.amber}40`, borderRadius: 10, padding: "10px 14px", fontSize: 10, color: C.amber, fontFamily: "monospace" }}>
            ⚠ {resolved.length}/{MIN_SAMPLE} resolved trades — attribution shown for insight, but recommendations are suppressed below {MIN_SAMPLE} to guard against overfitting on thin data.
          </div>
        )}

        <Card title="PROMOTION GATE — PAPER EVIDENCE REQUIRED">
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: promotion.approved ? C.green : C.amber, fontFamily: "monospace" }}>
              {promotion.status}
            </span>
            <span style={{ fontSize: 9, color: C.dim, fontFamily: "monospace" }}>
              {promotion.trades} paper trades · {promotion.winRatePct.toFixed(1)}% WR · {promotion.expectancyR.toFixed(2)}R expectancy · PF {Number.isFinite(promotion.profitFactor) ? promotion.profitFactor.toFixed(2) : "∞"}
            </span>
          </div>
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table style={tbl}>
              <thead><tr style={{ color: C.faint }}>{["Strategy", "Trades", "Win%", "Exp R", "PF", "Status"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{promotionByStrategy.map(p => (
                <tr key={p.key} style={{ borderTop: `0.5px solid #0d1b2a` }}>
                  <td style={{ ...td, textAlign: "left", color: C.ink }}>{p.label}</td>
                  <td style={td}>{p.trades}</td>
                  <td style={td}>{p.trades ? `${p.winRatePct.toFixed(1)}%` : "—"}</td>
                  <td style={{ ...td, color: p.expectancyR >= 0 ? C.green : C.red }}>{p.trades ? `${p.expectancyR >= 0 ? "+" : ""}${p.expectancyR.toFixed(2)}R` : "—"}</td>
                  <td style={td}>{p.trades ? (Number.isFinite(p.profitFactor) ? p.profitFactor.toFixed(2) : "∞") : "—"}</td>
                  <td style={{ ...td, color: p.approved ? C.green : C.amber, fontWeight: 700 }}>{p.status}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div style={{ marginTop: 7, fontSize: 9, color: promotion.approved ? C.green : C.amber, fontFamily: "monospace" }}>
            {source === "replay" ? "Replay results never authorize promotion; use Live paper trades for this gate." : promotion.approved ? "All promotion checks passed. Keep monitoring before any external execution." : `Hold paper-only: ${promotion.reasons.join(" · ")}.`}
          </div>
        </Card>

        {/* ── Style meta-learning ── */}
        <Card title="PER-STYLE META-LEARNING — WHICH STYLE PAYS">
          {styleML.rows.length === 0 ? <Empty msg="No resolved trades yet." /> : (
            <table style={tbl}>
              <thead><tr style={{ color: C.faint }}>{["Style", "Trades", "Win%", "Expectancy", "Avg ₹", "Net ₹"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {styleML.rows.map(r => (
                  <tr key={r.style} style={{ borderTop: `0.5px solid #0d1b2a` }}>
                    <td style={{ ...td, textAlign: "left", color: C.ink, fontWeight: 600 }}>{r.label}</td>
                    <td style={td}>{r.n}</td>
                    <td style={{ ...td, color: r.winRate >= 50 ? C.green : C.red }}>{r.winRate.toFixed(0)}%</td>
                    <td style={{ ...td, color: r.expectancyR >= 0 ? C.green : C.red, fontWeight: 700 }}>{r.expectancyR >= 0 ? "+" : ""}{r.expectancyR.toFixed(2)}R</td>
                    <td style={{ ...td, color: r.avgNetRs >= 0 ? C.green : C.red }}>{r.avgNetRs >= 0 ? "+" : ""}₹{fmt(r.avgNetRs, 0)}</td>
                    <td style={{ ...td, color: r.netRs >= 0 ? C.green : C.red }}>{r.netRs >= 0 ? "+" : ""}₹{fmt(r.netRs, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {styleML.recs.map((r, i) => <div key={i} style={{ marginTop: 7, fontSize: 10, color: C.violet, lineHeight: 1.5 }}>▸ {r}</div>)}
        </Card>

        {/* ── Factor attribution ── */}
        <Card title="FACTOR ATTRIBUTION — WHICH FACTORS PREDICT WINS">
          {factors.every(f => f.corr == null) ? <Empty msg="Need a few resolved trades to attribute factors." /> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {factors.map(f => {
                const corr = f.corr ?? 0;
                const col = corr > 0.1 ? C.green : corr < -0.1 ? C.red : C.faint;
                const w = Math.min(1, Math.abs(corr) / 0.5);
                return (
                  <div key={f.factor} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 10, color: C.ink, width: 130, flexShrink: 0 }}>{FACTOR_LABELS[f.factor]}</span>
                    <div style={{ flex: 1, height: 10, background: C.bg, borderRadius: 3, position: "relative", overflow: "hidden" }}>
                      <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: C.edge }} />
                      <div style={{ position: "absolute", left: corr >= 0 ? "50%" : `${50 - w * 50}%`, width: `${w * 50}%`, top: 0, bottom: 0, background: col }} />
                    </div>
                    <span style={{ fontSize: 9, fontFamily: "monospace", color: col, width: 52, textAlign: "right" }}>{corr >= 0 ? "+" : ""}{corr.toFixed(2)}</span>
                    <span style={{ fontSize: 8, color: C.faint, width: 66, textAlign: "right" }}>{f.lift != null ? `${f.lift >= 0 ? "+" : ""}${f.lift}% lift` : "—"}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 8, color: C.faint }}>Point-biserial correlation of each factor's sub-score with the win/loss outcome. Positive = the factor's high scores precede wins. Lift = win-rate above vs below the factor's median.</div>
        </Card>

        {/* ── Regime attribution ── */}
        <Card title="PER-REGIME EXPECTANCY">
          {regimes.length === 0 ? <Empty msg="No resolved trades yet." /> : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {regimes.map(r => (
                <span key={r.regime} style={{ fontSize: 9, fontFamily: "monospace", color: C.dim, background: C.bg, border: `0.5px solid ${C.edge}`, borderRadius: 5, padding: "4px 9px" }}>
                  {r.regime}: {r.n} · {r.winRate.toFixed(0)}% · <b style={{ color: r.expectancyR >= 0 ? C.green : C.red }}>{r.expectancyR >= 0 ? "+" : ""}{r.expectancyR.toFixed(2)}R</b>
                </span>
              ))}
            </div>
          )}
        </Card>

        {/* ── Weight tuner ── */}
        <Card
          title="WEIGHT TUNER — SUGGESTED FACTOR WEIGHTS"
          right={applied ? <span style={{ fontSize: 9, color: C.green, fontFamily: "monospace" }}>✓ applied</span> : <button onClick={resetWeights} style={{ fontSize: 9, padding: "3px 9px", background: C.bg, border: `0.5px solid ${C.edge}`, borderRadius: 5, color: C.faint, cursor: "pointer", fontFamily: "monospace" }}>reset to default</button>}
        >
          <div style={{ fontSize: 9, color: C.faint, marginBottom: 8 }}>
            Current weights (separation vs outcome: <b style={{ color: C.ink }}>{tuning.baseSeparation}</b>): {Object.entries(weights).map(([k, v]) => `${k} ${v}`).join(" · ")}
          </div>
          {!tuning.ready ? (
            <div style={{ fontSize: 10, color: C.amber, fontFamily: "monospace" }}>Need ≥ {tuning.minSample} resolved trades to suggest weights ({tuning.n} so far). Recommendations suppressed to avoid overfitting.</div>
          ) : tuning.candidates.length === 0 ? (
            <div style={{ fontSize: 10, color: C.dim, fontFamily: "monospace" }}>No weight vector beat the current one — the current weights already separate winners best on this sample.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {tuning.candidates.map((c, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, background: C.bg, border: `0.5px solid ${C.edge}`, borderRadius: 6, padding: "6px 10px" }}>
                  <span style={{ fontSize: 9, color: C.green, fontFamily: "monospace", width: 60 }}>sep {c.separation}</span>
                  <span style={{ fontSize: 9, color: C.dim, flex: 1 }}>{c.changed} — {Object.entries(c.weights).map(([k, v]) => `${k} ${v}`).join(", ")}</span>
                  <button onClick={() => applyWeights(c.weights)} style={{ fontSize: 9, padding: "3px 10px", background: "#0a1f14", border: `0.5px solid ${C.green}40`, borderRadius: 5, color: C.green, cursor: "pointer", fontFamily: "monospace" }}>apply</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 8, color: C.faint }}>Deterministic search re-scores every logged trade from its stored factor breakdown — no refetch. Suggestions never auto-apply; you opt in. Out-of-sample replay is the honest test.</div>
        </Card>

        <div style={{ fontSize: 8, color: C.faint, textAlign: "center", padding: "4px 0 16px" }}>
          Continuously recalibrates confidence weights from historical performance while guarding against overfitting (min-sample gates + out-of-sample replay). Rules stay explicit and auditable.
        </div>
      </div>
    </div>
  );
}

const tbl = { width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "monospace" };
const th = { padding: "5px 8px", textAlign: "right", fontSize: 8, letterSpacing: "0.05em", borderBottom: "0.5px solid #1e3a5a" };
const td = { padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap" };
function Stat({ label, value, color }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: 8, color: C.faint }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 14, fontWeight: 800, color: color || C.ink, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}
function Empty({ msg }) { return <div style={{ fontSize: 10, color: C.faint, fontFamily: "monospace", padding: "8px 0", textAlign: "center" }}>{msg}</div>; }
