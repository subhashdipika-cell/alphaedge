import React, { useState, useEffect, useCallback, useMemo } from "react";
import { ASSETS } from "../data/constants.js";
import { fetchOiTrend } from "../data/bridge.js";
import { analyzeOiTrend } from "../engines/oi.js";

// ─── OI PULSE — Trending-OI dashboard ─────────────────────────────────────────
// Treats open interest as a live time series: velocity/acceleration heat table,
// OI walls vs spot, confirmation matrix, OI spurts, Max Pain / gamma wall, and a
// smart-money composite. All analytics come from engines/oi.js.

const C = {
  card: "#0a1628", edge: "#1e3a5a", ink: "#e2e8f0", dim: "#94a3b8", faint: "#7c8ea8",
  green: "#22c55e", red: "#ef4444", amber: "#f59e0b", blue: "#60a5fa", bg: "#060d17",
};
const biasColor = (b) => (b === "BULLISH" ? C.green : b === "BEARISH" ? C.red : C.amber);
const fmtOi = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return (n / 1e7).toFixed(2) + "Cr";
  if (Math.abs(n) >= 1e5) return (n / 1e5).toFixed(2) + "L";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
};
const fmtNum = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-IN", { maximumFractionDigits: d }) : "—");

// Heat colour for a ΔOI value scaled to the row's magnitude.
function heat(v, max) {
  if (!max || !v) return "transparent";
  const t = Math.max(-1, Math.min(1, v / max));
  return t >= 0 ? `rgba(34,197,94,${0.08 + 0.5 * t})` : `rgba(239,68,68,${0.08 + 0.5 * -t})`;
}

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

// Small inline sparkline.
function Spark({ data, color = C.blue, h = 30, w = 120 }) {
  if (!data || data.length < 2) return null;
  const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - mn) / rng) * h}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export default function OiPulsePage() {
  const [underlying, setUnderlying] = useState("NIFTY50");
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    const r = await fetchOiTrend(underlying, 5);
    if (r && r.ok) setPayload(r);
    else { setPayload(null); setErr(r?.error || "OI-trend data unavailable — is the collector running?"); }
    setLoading(false);
  }, [underlying]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 60000);   // refresh each minute (bridge caches)
    return () => clearInterval(iv);
  }, [load]);

  const oi = useMemo(() => (payload ? analyzeOiTrend(payload) : null), [payload]);
  const label = ASSETS.find(a => a.id === underlying)?.label || underlying;

  // Max |ΔOI-since-open| across the visible rows, for the heat scale.
  const maxDelta = useMemo(() => {
    if (!oi) return 1;
    return Math.max(1, ...oi.rows.flatMap(r => [Math.abs(r.ce.dOiOpen), Math.abs(r.pe.dOiOpen)]));
  }, [oi]);

  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10 }}>

        {/* ── Controls + headline ── */}
        <Card
          title="OI PULSE — TRENDING OPEN INTEREST"
          right={
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {payload && (
                <span style={{ fontSize: 8, color: payload.source === "live-csv" ? C.green : C.amber,
                  background: C.bg, border: `0.5px solid ${(payload.source === "live-csv" ? C.green : C.amber)}40`,
                  borderRadius: 4, padding: "2px 7px", fontFamily: "monospace" }}>
                  {payload.source === "live-csv" ? `● LIVE · ${payload.asOf} IST` : `◐ STALE (${payload.date})`}
                </span>
              )}
              <button onClick={load} disabled={loading}
                style={{ fontSize: 10, padding: "4px 12px", background: C.bg, border: `0.5px solid ${C.edge}`,
                  borderRadius: 6, color: C.blue, cursor: loading ? "default" : "pointer", fontFamily: "monospace" }}>
                {loading ? "◌" : "⟳"} Refresh
              </button>
            </div>
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
            {oi && (
              <div style={{ marginLeft: "auto", display: "flex", gap: 16, alignItems: "center" }}>
                <Metric label="SPOT" value={fmtNum(oi.underLtp)} sub={`${oi.dayChange >= 0 ? "+" : ""}${fmtNum(oi.dayChange)}`} subColor={oi.dayChange >= 0 ? C.green : C.red} />
                <Metric label="ATM" value={fmtNum(oi.atmStrike, 0)} />
                <Metric label="PCR" value={fmtNum(oi.pcr)} valueColor={oi.pcr > 1.15 ? C.green : oi.pcr < 0.85 ? C.red : C.amber} />
                <Metric label="EXPIRY" value={oi.expiry?.slice(5) || "—"} />
              </div>
            )}
          </div>
        </Card>

        {err && (
          <div style={{ background: "#1a0a00", border: `0.5px solid ${C.amber}40`, borderRadius: 10, padding: "10px 14px", fontSize: 11, color: C.amber, fontFamily: "monospace" }}>
            ⚠ {err}
          </div>
        )}

        {oi && (
          <>
            {/* ── Smart-money + matrix row ── */}
            <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr", gap: 10 }}>
              <Card title="SMART-MONEY READ">
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 22, fontWeight: 900, color: biasColor(oi.smartMoney.bias), fontFamily: "monospace" }}>
                    {oi.smartMoney.bias}
                  </span>
                  <div style={{ flex: 1, height: 6, background: C.bg, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${oi.smartMoney.strength * 100}%`, height: "100%", background: biasColor(oi.smartMoney.bias) }} />
                  </div>
                  <span style={{ fontSize: 11, color: C.faint, fontFamily: "monospace" }}>{(oi.smartMoney.strength * 100).toFixed(0)}%</span>
                </div>
                {oi.smartMoney.reasons.map((r, i) => (
                  <div key={i} style={{ fontSize: 10, color: C.dim, lineHeight: 1.5 }}>• {r}</div>
                ))}
              </Card>

              <Card title="PRICE ↔ OI MATRIX">
                <Badge label={oi.matrix.underlying.replace(/_/g, " ")} color={/BUILDUP|COVERING/.test(oi.matrix.underlying) ? (oi.matrix.underlying.includes("LONG") || oi.matrix.underlying.includes("COVERING") ? C.green : C.red) : C.amber} />
                <div style={{ marginTop: 8, fontSize: 10, color: C.dim, lineHeight: 1.7 }}>
                  <div>Writer bias: <b style={{ color: biasColor(oi.matrix.writerBias) }}>{oi.matrix.writerBias}</b></div>
                  <div>ΔPCR 15m: <b style={{ color: oi.matrix.dPcr15 >= 0 ? C.green : C.red, fontFamily: "monospace" }}>{oi.matrix.dPcr15 >= 0 ? "+" : ""}{oi.matrix.dPcr15}</b></div>
                  {oi.matrix.divergence && <div>Divergence: <b style={{ color: biasColor(oi.matrix.divergence) }}>{oi.matrix.divergence}</b></div>}
                </div>
              </Card>

              <Card title="PINNING">
                <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.9 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><span>Max Pain</span><b style={{ color: C.ink, fontFamily: "monospace" }}>{fmtNum(oi.maxPain, 0)}</b></div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><span>Gamma wall</span><b style={{ color: C.ink, fontFamily: "monospace" }}>{fmtNum(oi.gammaWall, 0)}</b></div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><span>Spot vs pain</span><b style={{ color: oi.underLtp >= oi.maxPain ? C.green : C.red, fontFamily: "monospace" }}>{oi.underLtp >= oi.maxPain ? "above" : "below"}</b></div>
                </div>
              </Card>
            </div>

            {/* ── Walls ladder + PCR sparkline ── */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Card title="OI WALLS vs SPOT">
                <WallRow tag="Resistance (CE wall)" strike={oi.walls.resistance.strike} oi={oi.walls.resistance.oi} strength={oi.walls.resistance.strength} color={C.red} />
                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0", padding: "5px 8px", background: C.bg, borderRadius: 6, border: `0.5px dashed ${C.blue}55` }}>
                  <span style={{ fontSize: 9, color: C.blue }}>◆ SPOT</span>
                  <span style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 12, color: C.ink }}>{fmtNum(oi.underLtp)}</span>
                </div>
                <WallRow tag="Support (PE wall)" strike={oi.walls.support.strike} oi={oi.walls.support.oi} strength={oi.walls.support.strength} color={C.green} />
                <div style={{ marginTop: 8, fontSize: 9, color: C.faint, lineHeight: 1.5 }}>
                  PE centroid {oi.walls.peCentroid.shift >= 0 ? "↑" : "↓"} {fmtNum(oi.walls.peCentroid.shiftSteps)} strikes · CE centroid {oi.walls.ceCentroid.shift >= 0 ? "↑" : "↓"} {fmtNum(oi.walls.ceCentroid.shiftSteps)} strikes since open
                </div>
              </Card>

              <Card title="PCR TREND (SINCE OPEN)">
                <Spark data={oi.series.pcr} color={C.amber} h={40} w={520} />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 9, color: C.faint }}>
                  <span>{oi.series.times[0]}</span>
                  <span>PCR {fmtNum(oi.pcr)} — {oi.pcr > 1.15 ? "put writers supporting" : oi.pcr < 0.85 ? "call writers capping" : "balanced"}</span>
                  <span>{oi.asOf}</span>
                </div>
              </Card>
            </div>

            {/* ── Per-strike heat table ── */}
            <Card title="STRIKE OI HEAT — ΔOI SINCE OPEN & VELOCITY">
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "monospace", minWidth: 760 }}>
                  <thead>
                    <tr style={{ color: C.faint }}>
                      <th style={thCss}>CE ΔOI</th><th style={thCss}>CE OI</th><th style={thCss}>CE v5</th>
                      <th style={{ ...thCss, textAlign: "center", color: C.ink }}>STRIKE</th>
                      <th style={thCss}>PE v5</th><th style={thCss}>PE OI</th><th style={thCss}>PE ΔOI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {oi.rows.map(r => (
                      <tr key={r.strike} style={{ borderTop: `0.5px solid #0d1b2a`, background: r.atm ? "#0d1b2d" : "transparent" }}>
                        <td style={{ ...tdCss, background: heat(r.ce.dOiOpen, maxDelta), color: r.ce.dOiOpen >= 0 ? C.green : C.red }}>{r.ce.dOiOpen >= 0 ? "+" : ""}{fmtOi(r.ce.dOiOpen)}</td>
                        <td style={{ ...tdCss, color: C.dim }}>{fmtOi(r.ce.oi)}</td>
                        <td style={{ ...tdCss, color: r.ce.vel[5] >= 0 ? C.green : C.red }}>{r.ce.vel[5] >= 0 ? "+" : ""}{fmtOi(r.ce.vel[5])}</td>
                        <td style={{ ...tdCss, textAlign: "center", fontWeight: 700, color: r.atm ? C.blue : C.ink }}>{fmtNum(r.strike, 0)}{r.atm ? " ◆" : ""}</td>
                        <td style={{ ...tdCss, color: r.pe.vel[5] >= 0 ? C.green : C.red }}>{r.pe.vel[5] >= 0 ? "+" : ""}{fmtOi(r.pe.vel[5])}</td>
                        <td style={{ ...tdCss, color: C.dim }}>{fmtOi(r.pe.oi)}</td>
                        <td style={{ ...tdCss, background: heat(r.pe.dOiOpen, maxDelta), color: r.pe.dOiOpen >= 0 ? C.green : C.red }}>{r.pe.dOiOpen >= 0 ? "+" : ""}{fmtOi(r.pe.dOiOpen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* ── Spurts + active strikes ── */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Card title="OI SPURTS — FASTEST BUILD SINCE OPEN">
                {oi.spurts.length === 0 ? <Empty /> : oi.spurts.map((s, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderTop: i ? `0.5px solid #0d1b2a` : "none" }}>
                    <span style={{ fontSize: 10, fontFamily: "monospace", color: s.type === "CE" ? C.green : C.red, fontWeight: 700 }}>{fmtNum(s.strike, 0)} {s.type}</span>
                    <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: "monospace", color: C.amber }}>+{s.pct}%</span>
                    <span style={{ fontSize: 9, fontFamily: "monospace", color: C.faint, minWidth: 64, textAlign: "right" }}>{fmtOi(s.oi)} OI</span>
                  </div>
                ))}
              </Card>
              <Card title="MOST ACTIVE STRIKES (VOLUME)">
                {oi.activeStrikes.length === 0 ? <Empty /> : oi.activeStrikes.map((s, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderTop: i ? `0.5px solid #0d1b2a` : "none" }}>
                    <span style={{ fontSize: 10, fontFamily: "monospace", color: C.ink, fontWeight: 700 }}>{fmtNum(s.strike, 0)}</span>
                    <span style={{ fontSize: 9, fontFamily: "monospace", color: C.green }}>CE {fmtOi(s.ceVol)}</span>
                    <span style={{ fontSize: 9, fontFamily: "monospace", color: C.red }}>PE {fmtOi(s.peVol)}</span>
                    <span style={{ marginLeft: "auto", fontSize: 9, fontFamily: "monospace", color: C.faint }}>{fmtOi(s.vol)}</span>
                  </div>
                ))}
              </Card>
            </div>

            <div style={{ fontSize: 8, color: C.faint, textAlign: "center", padding: "4px 0 16px" }}>
              OI as a time series · velocity = contracts/min · walls = max-OI strikes · gamma wall = Black-Scholes γ×OI peak · Max Pain = min writer payout. Data: 1-min collected chain snapshots.
            </div>
          </>
        )}

        {!oi && !err && loading && (
          <div style={{ background: C.card, border: `0.5px dashed ${C.edge}`, borderRadius: 12, padding: 40, textAlign: "center" }}>
            <div style={{ fontSize: 22, color: "#64748b", animation: "spin 1s linear infinite", display: "inline-block" }}>◷</div>
            <div style={{ fontSize: 12, color: C.faint, marginTop: 8, fontFamily: "monospace" }}>Loading OI series…</div>
          </div>
        )}
      </div>
    </div>
  );
}

const thCss = { padding: "5px 8px", textAlign: "right", fontSize: 8, letterSpacing: "0.05em", borderBottom: "0.5px solid #1e3a5a", whiteSpace: "nowrap" };
const tdCss = { padding: "5px 8px", textAlign: "right", whiteSpace: "nowrap" };

function Metric({ label, value, sub, subColor, valueColor }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: 8, color: C.faint, letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 800, color: valueColor || C.ink, fontFamily: "monospace" }}>
        {value}{sub && <span style={{ fontSize: 9, color: subColor, marginLeft: 4 }}>{sub}</span>}
      </div>
    </div>
  );
}
function Badge({ label, color }) {
  return <span style={{ fontSize: 11, fontWeight: 800, color, background: `${color}18`, border: `0.5px solid ${color}40`, borderRadius: 5, padding: "3px 10px", fontFamily: "monospace" }}>{label}</span>;
}
function WallRow({ tag, strike, oi, strength, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", background: `${color}0d`, borderRadius: 6, border: `0.5px solid ${color}30` }}>
      <span style={{ fontSize: 9, color }}>{tag}</span>
      <span style={{ marginLeft: "auto", fontSize: 12, fontFamily: "monospace", color: C.ink }}>{fmtNum(strike, 0)}</span>
      <span style={{ fontSize: 9, fontFamily: "monospace", color: C.faint }}>{fmtOi(oi)} · {fmtNum(strength)}×</span>
    </div>
  );
}
function Empty() {
  return <div style={{ fontSize: 10, color: C.faint, fontFamily: "monospace", padding: "6px 0" }}>No data yet</div>;
}
