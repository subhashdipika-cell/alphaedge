// ─── TELEGRAM — PAPER-TRADE EVENT ALERTS ──────────────────────────────────────
// Alerts fire on ACTUAL trade events only (paper open / paper close) — no
// signal-generation spam, same policy as the other trading apps. Shared by the
// browser (manual paper trades + browser-side resolution) and the headless
// scanner (Node injects the same localStorage keys from env/config at startup).
//
// Credentials: localStorage "alphaedge_tg_token" / "alphaedge_tg_chat"
// (set in Settings → Telegram; the scanner mirrors them from
// strategy-lab/telegram_config.json or TG_BOT_TOKEN / TG_CHAT_ID env vars).

export function getTgToken()  { return localStorage.getItem("alphaedge_tg_token") || ""; }
export function getTgChatId() { return localStorage.getItem("alphaedge_tg_chat")  || ""; }
export function tgConfigured() { return !!(getTgToken() && getTgChatId()); }

const TG_BANNER = "🤖 <b>AlphaEdge</b>";
const fmtRs = (v) => `${v >= 0 ? "+" : "−"}₹${Math.abs(Math.round(Number(v) || 0)).toLocaleString("en-IN")}`;

export async function sendTelegram(text) {
  const token = getTgToken(), chatId = getTgChatId();
  if (!token || !chatId) return { ok: false, error: "Telegram token/chat not configured" };
  const body = String(text).startsWith(TG_BANNER) ? text : `${TG_BANNER}\n\n${text}`;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: body, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) return { ok: true };
    const err = await resp.json().catch(() => ({}));
    return { ok: false, error: err?.description || `HTTP ${resp.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

// t = the paper-trade record (handlePaperTrade / scanner shape).
export function buildPaperOpenAlert(t) {
  const dir = t.direction === "CE" ? "▲ CALL" : "▼ PUT";
  const s = t.structure || {};
  const structBits = [];
  if (s.rrStructure != null) structBits.push(`room ${s.rrStructure}R to ${s.barrier ?? "?"}`);
  if (s.tgtCapped) structBits.push("target capped to structure");
  return `🟢 <b>PAPER OPENED</b> · ${t.source || "AlphaEdge"}\n` +
    `${dir} <b>${t.assetId} ${t.strike}${t.direction}</b> ×${t.lots}×${t.lotSize}\n` +
    `Entry <code>₹${t.optionPremium}</code> · SL <code>₹${t.slPremium}</code> · TGT <code>₹${t.tgtPremium}</code>\n` +
    `${t.style || "—"} · score ${t.confidence ?? "—"} · exp ${String(t.expiry || "").slice(5)}` +
    (structBits.length ? `\n🧭 ${structBits.join(" · ")}` : "");
}

// t = the resolved record (trade merged with the resolver's outcome patch).
export function buildPaperCloseAlert(t) {
  const pnl = Number(t.pnlRs) || 0;
  const word = pnl >= 0 ? "✅ PROFIT" : "🔴 LOSS";
  const r = Number.isFinite(t.rMultiple) ? ` · ${t.rMultiple >= 0 ? "+" : ""}${t.rMultiple}R` : "";
  return `📉 <b>PAPER CLOSED</b>\n` +
    `<b>${t.assetId} ${t.strike}${t.direction}</b>\n` +
    `Result: ${word} <b>${fmtRs(pnl)}</b> <i>(net of costs)</i>${r}\n` +
    `In <code>₹${t.optionPremium}</code> → Out <code>₹${t.exitPremium}</code>\n` +
    `Why: ${t.exitReason || "—"}`;
}

// Fire-and-forget senders (never throw — an alert failure must not break trading).
export async function sendPaperOpenAlert(t) {
  try { return await sendTelegram(buildPaperOpenAlert(t)); } catch { return { ok: false }; }
}
export async function sendPaperCloseAlert(t) {
  try { return await sendTelegram(buildPaperCloseAlert(t)); } catch { return { ok: false }; }
}
