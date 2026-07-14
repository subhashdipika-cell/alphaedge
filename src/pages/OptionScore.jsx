import React, { useState, useEffect, useCallback, useMemo } from "react";
import { ASSETS } from "../data/constants.js";
import { fetchScoreInputs } from "../data/bridge.js";
import { analyzeOiTrend } from "../engines/oi.js";
import { scoreOption } from "../engines/score.js";
import { getMoneyMgt } from "../state/settings.js";
import { getRiskPolicy } from "../state/settings.js";
import { loadHistory } from "../state/history.js";

// ─── OPTION SCORE — the 0–100 decision engine, explained ──────────────────────

const C = {
  card: "#0a1628", edge: "#1e3a5a", ink: "#e2e8f0", dim: "#94a3b8", faint: "#7c8ea8",
  green: "#22c55e", red: "#ef4444", amber: "#f59e0b", blue: "#60a5fa", bg: "#060d17",
};
const verdictColor = (v) => (v === "TRADE" ? C.green : v === "WATCH" ? C.amber : C.red);
const dirColor = (d) => (d === "CE" ? C.green : d === "PE" ? C.red : C.amber);
const toneColor = (t) => (t === "good" ? C.green : t === "bad" ? C.red : t === "warn" ? C.amber : C.ink);
const fmt = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-IN", { maximumFractionDigits: d }) : "—");

const FACTOR_LABELS = {
  trend: "Trend & Structure", momentum: "Momentum", ict: "ICT / SMC", chainOi: "Chain & OI",
  greeks: "Greeks", ivVix: "IV & VIX", risk: "Risk Mgmt", news: "News & Events",
};

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

export default function OptionScorePage({ onPaperTrade }) {
  const [underlying, setUnderlying] = useState("NIFTY50");
  const [raw, setRaw] = useState(null);      // { chain, oiTrend, vix, candles* }
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [styleOverride, setStyleOverride] = useState(null);  // null = auto-select

  useEffect(() => { loadHistory().then(setHistory); }, []);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    const inputs = await fetchScoreInputs(underlying, 8);
    if (!inputs.chain?.ok && !inputs.chain?.strikes?.length) setErr(inputs.chain?.error || "Option chain unavailable — is the bridge running?");
    setRaw(inputs);
    setLoading(false);
  }, [underlying]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, [load]);

  const result = useMemo(() => {
    if (!raw) return null;
    const oi = raw.oiTrend ? analyzeOiTrend(raw.oiTrend) : { ok: false };
    return scoreOption({
      underlying,
      candles5m: raw.candles5m, candles15m: raw.candles15m, candles1H: raw.candles1H,
      chain: raw.chain, oi, vix: raw.vix, style: styleOverride,
      history, events: {}, mm: getMoneyMgt(), riskPct: getRiskPolicy().maxRiskPct,
    });
  }, [raw, history, underlying, styleOverride]);

  const label = ASSETS.find(a => a.id === underlying)?.label || underlying;

  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10 }}>

        {/* Controls */}
        <Card
          title="OPTION BUYING SCORE — DECISION ENGINE"
          right={
            <button onClick={load} disabled={loading}
              style={{ fontSize: 10, padding: "4px 12px", background: C.bg, border: `0.5px solid ${C.edge}`,
                borderRadius: 6, color: C.blue, cursor: loading ? "default" : "pointer", fontFamily: "monospace" }}>
              {loading ? "◌ scoring…" : "⟳ Rescore"}
            </button>
          }
        >
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {ASSETS.map(a => (
              <span key={a.id} onClick={() => setUnderlying(a.id)}
                style={{ fontSize: 11, padding: "5px 13px", borderRadius: 6, cursor: "pointer", fontFamily: "monospace",
                  fontWeight: underlying === a.id ? 700 : 400,
                  background: underlying === a.id ? "#1e3a5a" : C.bg,
                  color: underlying === a.id ? C.blue : C.dim,
                  border: `0.5px solid ${underlying === a.id ? "#3b82f6" : C.edge}` }}>
                {a.label}
              </span>
            ))}
            {/* Style selector — Auto lets the engine pick from the regime */}
            <div style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 8, color: C.faint, letterSpacing: "0.06em" }}>STYLE</span>
              {[["auto", "Auto"], ["SCALP", "Scalp"], ["INTRADAY", "Intraday"], ["SWING", "Swing"]].map(([v, l]) => {
                const active = (styleOverride || "auto") === v;
                return (
                  <span key={v} onClick={() => setStyleOverride(v === "auto" ? null : v)}
                    style={{ fontSize: 9, padding: "4px 9px", borderRadius: 5, cursor: "pointer", fontFamily: "monospace",
                      fontWeight: active ? 700 : 400,
                      background: active ? "#1e3a5a" : C.bg, color: active ? C.amber : C.dim,
                      border: `0.5px solid ${active ? C.amber : C.edge}` }}>
                    {l}
                  </span>
                );
              })}
            </div>
          </div>
        </Card>

        {err && (
          <div style={{ background: "#1a0a00", border: `0.5px solid ${C.amber}40`, borderRadius: 10, padding: "10px 14px", fontSize: 11, color: C.amber, fontFamily: "monospace" }}>⚠ {err}</div>
        )}

        {result && result.ok && (
          <>
            {/* ── Verdict hero ── */}
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 12 }}>
              <Card style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 190 }}>
                <div style={{ fontSize: 46, fontWeight: 900, color: verdictColor(result.verdict), fontFamily: "monospace", lineHeight: 1 }}>{result.score}</div>
                <div style={{ fontSize: 9, color: C.faint, letterSpacing: "0.1em", marginTop: 2 }}>/ 100</div>
                <div style={{ marginTop: 8, fontSize: 14, fontWeight: 800, color: verdictColor(result.verdict), fontFamily: "monospace" }}>{result.verdict}</div>
                {result.direction !== "NO_TRADE" && (
                  <div style={{ marginTop: 4, fontSize: 12, fontWeight: 700, color: dirColor(result.direction) }}>
                    {result.direction === "CE" ? "▲ BUY CALL" : "▼ BUY PUT"}
                  </div>
                )}
                <div style={{ marginTop: 6, fontSize: 8, color: C.faint }}>coverage {result.coverage}%</div>
              </Card>

              <Card title="DECISION REPORT">
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 12, rowGap: 4 }}>
                  {result.report.map((l, i) => (
                    <React.Fragment key={i}>
                      <span style={{ fontSize: 10, color: C.faint, whiteSpace: "nowrap" }}>{l.k}</span>
                      <span style={{ fontSize: 11, color: toneColor(l.tone), fontFamily: "monospace", fontWeight: l.tone ? 700 : 400 }}>{l.v}</span>
                    </React.Fragment>
                  ))}
                </div>
                {result.verdict !== "NO_TRADE" && result.strike && (
                  <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
                    <button
                      disabled={!result.plan?.affordable}
                      onClick={() => onPaperTrade && onPaperTrade(result)}
                      style={{ padding: "8px 18px", borderRadius: 8, border: "none", fontSize: 11, fontWeight: 800, fontFamily: "monospace",
                        cursor: result.plan?.affordable ? "pointer" : "not-allowed",
                        background: result.plan?.affordable ? "linear-gradient(135deg,#1d4ed8,#7c3aed)" : "#1e2a3a",
                        color: result.plan?.affordable ? "#fff" : C.faint }}>
                      📝 Paper trade this
                    </button>
                    {!result.plan?.affordable && (
                      <span style={{ fontSize: 9, color: C.amber }}>0 lots at {fmt(getRiskPolicy().maxRiskPct)}% risk — raise risk %, pick a cheaper strike, or add capital</span>
                    )}
                  </div>
                )}
              </Card>
            </div>

            {result.gates.length > 0 && (
              <Card title="HARD GATES (WHY IT'S BLOCKED)">
                {result.gates.map((g, i) => <div key={i} style={{ fontSize: 10, color: C.red, lineHeight: 1.6 }}>🛑 {g}</div>)}
              </Card>
            )}

            {/* ── Regime + Style ── */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Card title="MARKET REGIME">
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: result.regime.favorable ? C.green : C.amber, fontFamily: "monospace" }}>{result.regime.label}</span>
                  <span style={{ fontSize: 10, color: C.faint }}>{result.regime.confidence}%</span>
                  <span style={{ marginLeft: "auto", fontSize: 9, color: result.regime.favorable ? C.green : C.red, background: C.bg, border: `0.5px solid ${(result.regime.favorable ? C.green : C.red)}40`, borderRadius: 4, padding: "2px 8px", fontFamily: "monospace" }}>
                    {result.regime.favorable ? "buyer-friendly" : "buyer-hostile"}
                  </span>
                </div>
                {result.regime.reasons.map((r, i) => <div key={i} style={{ fontSize: 10, color: C.dim, lineHeight: 1.5 }}>• {r}</div>)}
              </Card>

              {result.style && (
                <Card title="TRADE STYLE (STRATEGY SELECTOR)">
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span style={{ fontSize: 15, fontWeight: 800, color: C.blue, fontFamily: "monospace" }}>{result.style.label}</span>
                    <span style={{ fontSize: 10, color: C.faint }}>hold {result.style.hold}</span>
                    <span style={{ marginLeft: "auto", fontSize: 8, color: styleOverride ? C.amber : C.green }}>{styleOverride ? "manual" : "auto"}</span>
                  </div>
                  {result.style.reasons.map((r, i) => <div key={i} style={{ fontSize: 10, color: C.dim, lineHeight: 1.5 }}>• {r}</div>)}
                  {result.style.alternatives?.length > 0 && (
                    <div style={{ marginTop: 5, fontSize: 9, color: C.faint }}>alt: {result.style.alternatives.join(", ")}</div>
                  )}
                </Card>
              )}
            </div>

            {/* ── Factor breakdown ── */}
            <Card title="FACTOR BREAKDOWN — WEIGHTED CONTRIBUTIONS">
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {Object.entries(result.factors).map(([k, f]) => {
                  const pct = f.missing ? 0 : f.score01;
                  const col = f.missing ? C.faint : pct >= 0.66 ? C.green : pct >= 0.4 ? C.amber : C.red;
                  const open = expanded === k;
                  return (
                    <div key={k}>
                      <div onClick={() => setExpanded(open ? null : k)} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                        <span style={{ fontSize: 10, color: C.ink, width: 140, flexShrink: 0 }}>{FACTOR_LABELS[k]}</span>
                        <div style={{ flex: 1, height: 12, background: C.bg, borderRadius: 3, overflow: "hidden", position: "relative" }}>
                          <div style={{ width: `${pct * 100}%`, height: "100%", background: col, transition: "width 0.3s" }} />
                        </div>
                        <span style={{ fontSize: 10, fontFamily: "monospace", color: col, width: 62, textAlign: "right", flexShrink: 0 }}>
                          {f.missing ? "n/a" : `${f.points}/${f.weight}`}
                        </span>
                        <span style={{ fontSize: 8, color: C.faint, width: 10 }}>{open ? "▾" : "▸"}</span>
                      </div>
                      {open && (
                        <div style={{ margin: "3px 0 6px 148px", paddingLeft: 8, borderLeft: `1px solid ${C.edge}` }}>
                          {(f.reasons || []).map((r, i) => <div key={i} style={{ fontSize: 9, color: C.dim, lineHeight: 1.6 }}>• {r}</div>)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 8, fontSize: 8, color: C.faint }}>Click a factor to see the per-check reasoning. Weights are user-tunable in R&D once the forward-test record justifies it.</div>
            </Card>

            {/* ── Strike + plan (only when actionable) ── */}
            {result.strike && result.verdict !== "NO_TRADE" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Card title="RECOMMENDED STRIKE">
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontSize: 20, fontWeight: 800, color: dirColor(result.direction), fontFamily: "monospace" }}>{fmt(result.strike.strike, 0)} {result.direction}</span>
                    <span style={{ fontSize: 10, color: C.faint }}>{result.strike.moneyness} · exp {result.strike.expiry?.slice(5)}</span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 11, fontFamily: "monospace", color: C.ink }}>₹{fmt(result.strike.ltp)} <span style={{ color: C.faint, fontSize: 9 }}>premium</span></div>
                  <div style={{ marginTop: 2, fontSize: 9, color: C.dim, fontFamily: "monospace" }}>Δ {fmt(result.strike.delta)} · θ {fmt(result.strike.theta, 1)}/day · IV {fmt(result.strike.iv)}</div>
                  {result.expectedMove && <div style={{ marginTop: 6, fontSize: 9, color: C.amber }}>Expected move ≈ {fmt(result.expectedMove.points, 0)} pts ({fmt(result.expectedMove.pct)}%) by expiry</div>}
                  <div style={{ marginTop: 6 }}>{(result.strike.reasons || []).map((r, i) => <div key={i} style={{ fontSize: 9, color: C.faint, lineHeight: 1.5 }}>• {r}</div>)}</div>
                </Card>

                <Card title="TRADE PLAN">
                  {result.plan ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      <Stat label="Lots" value={result.plan.lots} color={result.plan.affordable ? C.ink : C.red} />
                      <Stat label="Entry" value={`₹${fmt(result.plan.entry)}`} />
                      <Stat label="Stop" value={`₹${fmt(result.plan.slPrice)}`} color={C.red} />
                      <Stat label="Target" value={`₹${fmt(result.plan.tgtPrice)}`} color={C.green} />
                      <Stat label="Risk" value={`₹${fmt(result.plan.riskRs, 0)}`} color={C.red} />
                      <Stat label="Reward" value={`₹${fmt(result.plan.rewardRs, 0)}`} color={C.green} />
                      <Stat label="Outlay" value={`₹${fmt(result.plan.outlayRs, 0)}`} />
                      <Stat label="R:R" value={`1:${result.plan.rr}`} color={C.blue} />
                    </div>
                  ) : <div style={{ fontSize: 10, color: C.faint }}>No plan — sizing needs a valid premium.</div>}
                </Card>
              </div>
            )}

            <div style={{ fontSize: 8, color: C.faint, textAlign: "center", padding: "4px 0 16px" }}>
              Deterministic 8-factor score · every recommendation is logged with its full breakdown for R&D · decision-support only, place orders manually.
            </div>
          </>
        )}

        {loading && !result && (
          <div style={{ background: C.card, border: `0.5px dashed ${C.edge}`, borderRadius: 12, padding: 40, textAlign: "center" }}>
            <div style={{ fontSize: 22, color: "#64748b", animation: "spin 1s linear infinite", display: "inline-block" }}>◷</div>
            <div style={{ fontSize: 12, color: C.faint, marginTop: 8, fontFamily: "monospace" }}>Scoring {label}…</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ background: C.bg, border: `0.5px solid ${C.edge}`, borderRadius: 6, padding: "6px 9px" }}>
      <div style={{ fontSize: 8, color: C.faint }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: color || C.ink, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}
