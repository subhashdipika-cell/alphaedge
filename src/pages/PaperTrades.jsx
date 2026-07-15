import React, { useState, useEffect, useCallback, useMemo } from "react";
import { loadHistory, saveHistory } from "../state/history.js";
import { getOptionPaperTrades, openPaperTrades, paperTradeStats, resolveOpenPaperTrades } from "../state/paperTrades.js";
import { fetchPremiumSeries, fetchAutoPaperTrades } from "../data/bridge.js";
import { entryTsToUtc } from "../engines/resolve.js";
import { netOptionPnl, exchangeFor } from "../engines/costs.js";

// ─── PAPER TRADES — option paper-position blotter ─────────────────────────────
// Recommendations accepted from the Option Score page are tracked here against
// the live PREMIUM series (not underlying spot): live P&L, MFE/MAE, and
// win/loss/time-stop/square-off resolution.

const C = {
  card: "#0a1628", edge: "#1e3a5a", ink: "#e2e8f0", dim: "#94a3b8", faint: "#7c8ea8",
  green: "#22c55e", red: "#ef4444", amber: "#f59e0b", blue: "#60a5fa", bg: "#060d17",
};
const fmt = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-IN", { maximumFractionDigits: d }) : "—");
const fmtRs = (v) => (Number.isFinite(Number(v)) ? `${v >= 0 ? "+" : ""}₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : "—");
const styleLabel = { SCALP: "Scalp", INTRADAY: "Intraday", SWING: "Swing" };

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

export default function PaperTradesPage() {
  const [history, setHistory] = useState([]);
  const [livePrem, setLivePrem] = useState({});   // id → last premium
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(null);          // headless-scanner track record (bridge /paper/auto)

  const refresh = useCallback(async () => {
    setBusy(true);
    // Autonomous scanner's record (separate source — a JSON file the bridge serves).
    try { setAuto(await fetchAutoPaperTrades()); } catch { /* bridge offline */ }
    const h = await loadHistory();
    // resolve any that have hit SL/target/time-stop
    try {
      const { changed, next } = await resolveOpenPaperTrades(h);
      if (changed) { await saveHistory(next); setHistory(next); }
      else setHistory(h);
    } catch { setHistory(h); }
    // pull last premium for the still-open trades (live P&L)
    const open = openPaperTrades(h);
    const prem = {};
    await Promise.all(open.map(async t => {
      try {
        const type = t.direction || (t.bias === "BULLISH" ? "CE" : "PE");
        const r = await fetchPremiumSeries(t.assetId, t.strike, type, { expiry: t.expiry, sinceTs: entryTsToUtc(t.entryTs || t.timestamp) });
        if (r?.ok && r.series?.length) prem[t.id] = r.last ?? r.series.at(-1).ltp;
      } catch { /* ignore */ }
    }));
    setLivePrem(prem);
    setBusy(false);
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 60000);
    return () => clearInterval(iv);
  }, [refresh]);

  const trades = useMemo(() => getOptionPaperTrades(history), [history]);
  const open = useMemo(() => trades.filter(t => (t.outcome || "pending") === "pending"), [trades]);
  const closed = useMemo(() => trades.filter(t => t.outcome === "win" || t.outcome === "loss").sort((a, b) => b.timestamp - a.timestamp), [trades]);
  const stats = useMemo(() => paperTradeStats(history), [history]);
  const byStyle = useMemo(() => paperTradeStats(history, t => t.style || "—"), [history]);

  // ── Autonomous headless-scanner track record (from the bridge, not localStorage) ──
  const autoTrades = useMemo(() => (auto?.ok && Array.isArray(auto.trades)) ? auto.trades : [], [auto]);
  const autoOpen = useMemo(() => autoTrades.filter(t => (t.outcome || "pending") === "pending"), [autoTrades]);
  const autoClosed = useMemo(() => autoTrades.filter(t => t.outcome === "win" || t.outcome === "loss").sort((a, b) => b.timestamp - a.timestamp), [autoTrades]);
  const autoStats = useMemo(() => paperTradeStats(autoTrades), [autoTrades]);
  const autoUpdated = auto?.updatedAt ? new Date(auto.updatedAt) : null;

  // Live P&L NET of estimated round-trip cost (brokerage + taxes).
  const livePnl = (t) => {
    const p = livePrem[t.id];
    if (!Number.isFinite(p)) return null;
    return netOptionPnl({ entryPremium: t.optionPremium || t.entry, exitPremium: p, qty: (t.lots || 0) * (t.lotSize || 0), exchange: exchangeFor(t.assetId) }).netRs;
  };

  const manualClose = async (t) => {
    if (!window.confirm(`Close ${t.strike}${t.direction} manually? Marked at the last premium, net of costs.`)) return;
    const p = livePrem[t.id] ?? t.optionPremium;
    const { grossRs, costRs, netRs } = netOptionPnl({ entryPremium: t.optionPremium || t.entry, exitPremium: p, qty: (t.lots || 0) * (t.lotSize || 0), exchange: exchangeFor(t.assetId) });
    const next = (await loadHistory()).map(s => s.id === t.id ? {
      ...s, outcome: netRs >= 0 ? "win" : "loss", exitPremium: +Number(p).toFixed(2),
      pnlRs: netRs, grossPnlRs: grossRs, costRs,
      rMultiple: (t.optionPremium - t.slPremium) ? +((p - t.optionPremium) / (t.optionPremium - t.slPremium)).toFixed(2) : 0,
      exitReason: "Manual close", resolvedBy: "manual", resolvedAt: Date.now(),
    } : s);
    await saveHistory(next); setHistory(next);
  };

  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <div style={{ maxWidth: 1120, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10 }}>

        {/* ── Summary ── */}
        <Card
          title="MANUAL PAPER TRADES — PREMIUM-TRACKED BLOTTER"
          right={
            <button onClick={refresh} disabled={busy}
              style={{ fontSize: 10, padding: "4px 12px", background: C.bg, border: `0.5px solid ${C.edge}`, borderRadius: 6, color: C.blue, cursor: busy ? "default" : "pointer", fontFamily: "monospace" }}>
              {busy ? "◌" : "⟳"} Refresh
            </button>
          }
        >
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            <Stat label="Open" value={open.length} color={C.amber} />
            <Stat label="Resolved" value={stats.n} />
            <Stat label="Win Rate" value={stats.n ? `${stats.winRate.toFixed(0)}%` : "—"} color={stats.winRate >= 50 ? C.green : C.red} />
            <Stat label="Expectancy" value={stats.n ? `${stats.expectancyR >= 0 ? "+" : ""}${stats.expectancyR.toFixed(2)}R` : "—"} color={stats.expectancyR >= 0 ? C.green : C.red} />
            <Stat label="Net P&L" value={stats.n ? fmtRs(stats.pnlRs) : "—"} color={stats.pnlRs >= 0 ? C.green : C.red} />
          </div>
          {Object.keys(byStyle).length > 0 && (
            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {Object.entries(byStyle).map(([k, g]) => (
                <span key={k} style={{ fontSize: 9, fontFamily: "monospace", color: C.dim, background: C.bg, border: `0.5px solid ${C.edge}`, borderRadius: 5, padding: "3px 8px" }}>
                  {styleLabel[k] || k}: {g.n} · {g.winRate.toFixed(0)}% · {g.expectancyR >= 0 ? "+" : ""}{g.expectancyR.toFixed(2)}R
                </span>
              ))}
            </div>
          )}
        </Card>

        {/* ── Autonomous headless scanner ── */}
        <Card
          title="⬡ AUTONOMOUS SCANNER — HEADLESS TRACK RECORD"
          right={
            <span style={{ fontSize: 8, fontFamily: "monospace", color: autoTrades.length ? C.green : C.faint }}>
              {autoTrades.length ? `● running · ${autoUpdated ? autoUpdated.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : ""}` : "○ not started"}
            </span>
          }
          style={{ borderColor: autoTrades.length ? "#22c55e40" : C.edge }}
        >
          {autoTrades.length === 0 ? (
            <Empty msg={auto?.note || "Scanner hasn't logged any trades yet. Start it with:  node scripts/scanner.mjs  (the launcher starts it automatically)."} />
          ) : (
            <>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                <Stat label="Open" value={autoOpen.length} color={C.amber} />
                <Stat label="Resolved" value={autoStats.n} />
                <Stat label="Win Rate" value={autoStats.n ? `${autoStats.winRate.toFixed(0)}%` : "—"} color={autoStats.winRate >= 50 ? C.green : C.red} />
                <Stat label="Expectancy" value={autoStats.n ? `${autoStats.expectancyR >= 0 ? "+" : ""}${autoStats.expectancyR.toFixed(2)}R` : "—"} color={autoStats.expectancyR >= 0 ? C.green : C.red} />
                <Stat label="Net P&L" value={autoStats.n ? fmtRs(autoStats.pnlRs) : "—"} color={autoStats.pnlRs >= 0 ? C.green : C.red} />
              </div>
              {autoOpen.length > 0 && (
                <div style={{ overflowX: "auto", marginTop: 10 }}>
                  <div style={{ fontSize: 8, color: C.faint, marginBottom: 4 }}>OPEN ({autoOpen.length})</div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "monospace", minWidth: 700 }}>
                    <thead><tr style={{ color: C.faint }}>{["Leg", "Style", "Entry ₹", "SL ₹", "Target ₹", "Lots", "Opened"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {autoOpen.map(t => (
                        <tr key={t.id} style={{ borderTop: `0.5px solid #0d1b2a` }}>
                          <td style={{ ...td, color: t.direction === "CE" ? C.green : C.red, fontWeight: 700 }}>{t.strike} {t.direction}<div style={{ fontSize: 8, color: C.faint }}>{t.assetId} · {t.expiry?.slice(5)}</div></td>
                          <td style={td}>{styleLabel[t.style] || "—"}</td>
                          <td style={td}>{fmt(t.optionPremium)}</td>
                          <td style={{ ...td, color: C.red }}>{fmt(t.slPremium)}</td>
                          <td style={{ ...td, color: C.green }}>{fmt(t.tgtPremium)}</td>
                          <td style={td}>{t.lots}×{t.lotSize}</td>
                          <td style={{ ...td, color: C.faint }}>{new Date(t.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {autoClosed.length > 0 && (
                <div style={{ overflowX: "auto", marginTop: 10 }}>
                  <div style={{ fontSize: 8, color: C.faint, marginBottom: 4 }}>RESOLVED ({autoClosed.length})</div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "monospace", minWidth: 760 }}>
                    <thead><tr style={{ color: C.faint }}>{["Date", "Leg", "Style", "Entry ₹", "Exit ₹", "R", "Net P&L", "Result", "Why"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {autoClosed.slice(0, 40).map(t => (
                        <tr key={t.id} style={{ borderTop: `0.5px solid #0d1b2a`, opacity: 0.92 }}>
                          <td style={{ ...td, color: C.faint }}>{new Date(t.timestamp).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</td>
                          <td style={{ ...td, color: t.direction === "CE" ? C.green : C.red }}>{t.strike} {t.direction}</td>
                          <td style={td}>{styleLabel[t.style] || "—"}</td>
                          <td style={td}>{fmt(t.optionPremium)}</td>
                          <td style={td}>{fmt(t.exitPremium)}</td>
                          <td style={{ ...td, color: (t.rMultiple || 0) >= 0 ? C.green : C.red }}>{Number.isFinite(t.rMultiple) ? `${t.rMultiple >= 0 ? "+" : ""}${t.rMultiple}R` : "—"}</td>
                          <td style={{ ...td, color: (t.pnlRs || 0) >= 0 ? C.green : C.red, fontWeight: 700 }}>{fmtRs(t.pnlRs)}</td>
                          <td style={td}><span style={{ color: t.outcome === "win" ? C.green : C.red, background: (t.outcome === "win" ? C.green : C.red) + "18", border: `0.5px solid ${(t.outcome === "win" ? C.green : C.red)}40`, borderRadius: 4, padding: "1px 7px", fontSize: 9 }}>{t.outcome.toUpperCase()}</span></td>
                          <td style={{ ...td, color: C.faint, textAlign: "left", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.exitReason}>{t.exitReason || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          <div style={{ marginTop: 8, fontSize: 8, color: C.faint }}>
            Runs headless (no browser needed) via scripts/scanner.mjs — scores all indices every ~5 min in-session and auto-logs every TRADE-grade setup. Same engines as the Option Score page. Paper only.
          </div>
        </Card>

        {/* ── Open positions ── */}
        <Card title={`MANUAL — OPEN POSITIONS (${open.length})`}>
          {open.length === 0 ? (
            <Empty msg="No open paper trades. Accept one from the Option Score page." />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "monospace", minWidth: 820 }}>
                <thead><tr style={{ color: C.faint }}>
                  {["Leg", "Style", "Entry ₹", "Live ₹", "SL ₹", "Target ₹", "Lots", "Live P&L", ""].map(h => <th key={h} style={th}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {open.map(t => {
                    const pnl = livePnl(t);
                    const p = livePrem[t.id];
                    return (
                      <tr key={t.id} style={{ borderTop: `0.5px solid #0d1b2a` }}>
                        <td style={{ ...td, color: t.direction === "CE" ? C.green : C.red, fontWeight: 700 }}>{t.strike} {t.direction}<div style={{ fontSize: 8, color: C.faint }}>{t.assetId} · {t.expiry?.slice(5)}</div></td>
                        <td style={td}>{styleLabel[t.style] || "—"}</td>
                        <td style={td}>{fmt(t.optionPremium)}</td>
                        <td style={{ ...td, color: Number.isFinite(p) ? (p >= t.optionPremium ? C.green : C.red) : C.faint }}>{Number.isFinite(p) ? fmt(p) : "…"}</td>
                        <td style={{ ...td, color: C.red }}>{fmt(t.slPremium)}</td>
                        <td style={{ ...td, color: C.green }}>{fmt(t.tgtPremium)}</td>
                        <td style={td}>{t.lots}×{t.lotSize}</td>
                        <td style={{ ...td, color: pnl == null ? C.faint : pnl >= 0 ? C.green : C.red, fontWeight: 700 }}>{pnl == null ? "…" : fmtRs(pnl)}</td>
                        <td style={td}><button onClick={() => manualClose(t)} style={closeBtn}>close</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 8, color: C.faint }}>
            Resolves automatically against the /dhan/premium series: SL-first on ambiguity, {`theta time-stop`}, 15:15 IST square-off. Runs even if the app was closed.
          </div>
        </Card>

        {/* ── Resolved ── */}
        <Card title={`MANUAL — RESOLVED (${closed.length})`}>
          {closed.length === 0 ? <Empty msg="No resolved paper trades yet." /> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "monospace", minWidth: 820 }}>
                <thead><tr style={{ color: C.faint }}>
                  {["Date", "Leg", "Style", "Entry ₹", "Exit ₹", "R", "Gross", "Cost", "Net P&L", "Result", "Why"].map(h => <th key={h} style={th}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {closed.map(t => (
                    <tr key={t.id} style={{ borderTop: `0.5px solid #0d1b2a`, opacity: 0.92 }}>
                      <td style={{ ...td, color: C.faint }}>{new Date(t.timestamp).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</td>
                      <td style={{ ...td, color: t.direction === "CE" ? C.green : C.red }}>{t.strike} {t.direction}</td>
                      <td style={td}>{styleLabel[t.style] || "—"}</td>
                      <td style={td}>{fmt(t.optionPremium)}</td>
                      <td style={td}>{fmt(t.exitPremium)}</td>
                      <td style={{ ...td, color: (t.rMultiple || 0) >= 0 ? C.green : C.red }}>{Number.isFinite(t.rMultiple) ? `${t.rMultiple >= 0 ? "+" : ""}${t.rMultiple}R` : "—"}</td>
                      <td style={{ ...td, color: C.faint }}>{t.grossPnlRs != null ? fmtRs(t.grossPnlRs) : "—"}</td>
                      <td style={{ ...td, color: C.amber }}>{t.costRs != null ? `−₹${fmt(t.costRs, 0)}` : "—"}</td>
                      <td style={{ ...td, color: (t.pnlRs || 0) >= 0 ? C.green : C.red, fontWeight: 700 }}>{fmtRs(t.pnlRs)}</td>
                      <td style={td}><span style={{ color: t.outcome === "win" ? C.green : C.red, background: (t.outcome === "win" ? C.green : C.red) + "18", border: `0.5px solid ${(t.outcome === "win" ? C.green : C.red)}40`, borderRadius: 4, padding: "1px 7px", fontSize: 9 }}>{t.outcome.toUpperCase()}</span></td>
                      <td style={{ ...td, color: C.faint, textAlign: "left", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.exitReason}>{t.exitReason || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div style={{ fontSize: 8, color: C.faint, textAlign: "center", padding: "4px 0 16px" }}>
          Paper trading only — no broker orders. Outcomes feed the R&D learning engine (per-style expectancy). Place real trades manually in your broker app.
        </div>
      </div>
    </div>
  );
}

const th = { padding: "5px 8px", textAlign: "right", fontSize: 8, letterSpacing: "0.05em", borderBottom: "0.5px solid #1e3a5a", whiteSpace: "nowrap" };
const td = { padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap" };
const closeBtn = { fontSize: 8, padding: "2px 7px", background: "#1a0000", border: "0.5px solid #ef444430", borderRadius: 4, color: "#ef4444", cursor: "pointer", fontFamily: "monospace" };

function Stat({ label, value, color }) {
  return (
    <div style={{ textAlign: "center", minWidth: 60 }}>
      <div style={{ fontSize: 8, color: C.faint, letterSpacing: "0.06em" }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: color || C.ink, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}
function Empty({ msg }) {
  return <div style={{ fontSize: 10, color: C.faint, fontFamily: "monospace", padding: "10px 0", textAlign: "center" }}>{msg}</div>;
}
