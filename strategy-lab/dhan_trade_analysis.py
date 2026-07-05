"""
dhan_trade_analysis.py — audit your real Dhan option-buying trades
==================================================================
Pulls your executed trades from Dhan (Trading API trade history), pairs
BUY->SELL legs per contract into round-trip trades, and flags the classic
option-BUYER flaws: theta bleed (holding too long), expiry-day gambling,
over-trading / brokerage drag, asymmetric win/loss, revenge clusters,
time-of-day leaks, OTM lottery tickets, and net P&L after all charges.

This is YOUR data, via YOUR token in dhan_config.json. Read-only.

Usage:
  python dhan_trade_analysis.py                 # last 365 days
  python dhan_trade_analysis.py --days 180
"""
import argparse
import csv
import io
import json
import sys
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HERE   = Path(__file__).parent
CONFIG = HERE / "dhan_config.json"
OUT_CSV = HERE / "data" / "trade_audit_pairs.csv"
CHARGE_KEYS = ["sebiTax", "stt", "brokerageCharges", "serviceTax",
               "exchangeTransactionCharges", "stampDuty"]


def client():
    from dhanhq import DhanContext, dhanhq
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    return dhanhq(DhanContext(cfg["client_id"], cfg["access_token"]))


def parse_dt(s):
    try: return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S")
    except Exception: return None


def fetch_all(dhan, days):
    """Fetch trade history in <=90-day chunks (API-friendly), paginated."""
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=days)
    rows, cur = [], start
    while cur <= today:
        chunk_to = min(cur + timedelta(days=90), today)
        page = 0
        while True:
            r = dhan.get_trade_history(cur.isoformat(), chunk_to.isoformat(), page)
            d = r.get("data")
            if r.get("status") != "success" or not isinstance(d, list) or not d:
                break
            rows.extend(d); page += 1
            if len(d) < 20 or page > 500:
                break
            time.sleep(0.2)
        cur = chunk_to + timedelta(days=1)
    return rows


def charges(ex):
    return sum(float(ex.get(k) or 0) for k in CHARGE_KEYS)


def pair_trades(execs):
    """FIFO-pair BUY(open)->SELL(close) per securityId into round trips."""
    for e in execs:
        e["_dt"] = parse_dt(e.get("exchangeTime", ""))
    execs = [e for e in execs if e["_dt"]]
    execs.sort(key=lambda e: e["_dt"])
    open_buys = defaultdict(deque)   # securityId -> deque of open buy lots
    trades = []
    for e in execs:
        sid = e.get("securityId")
        qty = int(e.get("tradedQuantity") or 0)
        px  = float(e.get("tradedPrice") or 0)
        chg_per = charges(e) / qty if qty else 0
        if e.get("transactionType") == "BUY":
            open_buys[sid].append({"qty": qty, "px": px, "dt": e["_dt"], "chg": chg_per, "e": e})
        else:  # SELL closes long option lots
            remain = qty
            while remain > 0 and open_buys[sid]:
                lot = open_buys[sid][0]
                m = min(remain, lot["qty"])
                gross = (px - lot["px"]) * m
                tcharge = (lot["chg"] + chg_per) * m
                under = str(e.get("customSymbol", "")).split(" ")[0] or "?"
                trades.append({
                    "underlying": under,
                    "symbol": e.get("customSymbol", ""),
                    "type": e.get("drvOptionType", ""),
                    "strike": float(e.get("drvStrikePrice") or 0),
                    "expiry": e.get("drvExpiryDate", ""),
                    "qty": m,
                    "entry_px": lot["px"], "exit_px": px,
                    "entry_dt": lot["dt"], "exit_dt": e["_dt"],
                    "hold_min": round((e["_dt"] - lot["dt"]).total_seconds() / 60, 1),
                    "gross": round(gross, 2),
                    "charges": round(tcharge, 2),
                    "net": round(gross - tcharge, 2),
                })
                lot["qty"] -= m; remain -= m
                if lot["qty"] == 0:
                    open_buys[sid].popleft()
    return trades


def pct(n, d): return (n / d * 100) if d else 0


def analyze(trades):
    if not trades:
        print("No paired round-trip trades found."); return
    n = len(trades)
    wins = [t for t in trades if t["net"] > 0]
    losses = [t for t in trades if t["net"] <= 0]
    net = sum(t["net"] for t in trades)
    gross = sum(t["gross"] for t in trades)
    fees = sum(t["charges"] for t in trades)
    gw = sum(t["net"] for t in wins); gl = -sum(t["net"] for t in losses)
    avg_w = gw / len(wins) if wins else 0
    avg_l = gl / len(losses) if losses else 0
    span = f"{min(t['entry_dt'] for t in trades).date()} -> {max(t['exit_dt'] for t in trades).date()}"

    P = print
    P("\n" + "="*64)
    P("  DHAN OPTION-BUYING AUDIT")
    P("="*64)
    P(f"  Period: {span} | Round-trip trades: {n}")
    P(f"  Net P&L (after charges): Rs {net:,.0f}   Gross: Rs {gross:,.0f}   Charges: Rs {fees:,.0f}")
    P(f"  Win rate: {pct(len(wins),n):.1f}%   ({len(wins)}W / {len(losses)}L)")
    P(f"  Avg win: Rs {avg_w:,.0f}   Avg loss: Rs {avg_l:,.0f}   Payoff: {(avg_w/avg_l if avg_l else 0):.2f}")
    pf = gw / gl if gl else 0
    exp = net / n
    P(f"  Profit factor: {pf:.2f}   Expectancy: Rs {exp:,.0f}/trade")

    P("\n  --- FLAW SCAN " + "-"*49)

    # 1) Charges drag
    P(f"  [Charges] Brokerage+taxes ate Rs {fees:,.0f} "
      f"({pct(fees, abs(gross) or 1):.0f}% of gross). {n} trades x ~Rs55.")

    # 2) Theta / holding time
    avg_hold = sum(t["hold_min"] for t in trades) / n
    long_hold = [t for t in trades if t["hold_min"] > 60]
    lh_net = sum(t["net"] for t in long_hold)
    P(f"  [Theta] Avg hold {avg_hold:.0f} min. {len(long_hold)} trades held >60min "
      f"(net Rs {lh_net:,.0f}) — option buyers bleed time decay on long holds.")

    # 3) Expiry-day (0-DTE) gambling
    edt = [t for t in trades if str(t["entry_dt"].date()) == str(t["expiry"])]
    if edt:
        ew = pct(len([t for t in edt if t['net']>0]), len(edt))
        P(f"  [Expiry-day] {len(edt)} trades ({pct(len(edt),n):.0f}%) entered on expiry day "
          f"(0-DTE): win {ew:.0f}%, net Rs {sum(t['net'] for t in edt):,.0f}.")

    # 4) Asymmetry / cutting winners
    if avg_l and avg_w/avg_l < 1:
        P(f"  [Asymmetry] Avg loss (Rs {avg_l:,.0f}) > avg win (Rs {avg_w:,.0f}) — "
          f"losses run bigger than wins; payoff {avg_w/avg_l:.2f} needs >65% win rate to profit.")

    # 5) OTM lottery tickets (cheap premium entries)
    cheap = [t for t in trades if t["entry_px"] < 20]
    if cheap:
        cw = pct(len([t for t in cheap if t['net']>0]), len(cheap))
        P(f"  [OTM lottery] {len(cheap)} trades bought <Rs20 premium: win {cw:.0f}%, "
          f"net Rs {sum(t['net'] for t in cheap):,.0f} — far-OTM cheap options rarely pay.")

    # 6) Over-trading by day + revenge clusters
    by_day = defaultdict(list)
    for t in trades: by_day[t["entry_dt"].date()].append(t)
    busy = sorted(by_day.items(), key=lambda kv: len(kv[1]), reverse=True)[:3]
    P(f"  [Over-trading] {len(by_day)} trading days, avg {n/len(by_day):.1f} trades/day. "
      f"Busiest: " + ", ".join(f"{d} ({len(ts)})" for d,ts in busy))
    # revenge: a trade entered <5min after a losing exit
    srt = sorted(trades, key=lambda t: t["entry_dt"])
    revenge = 0
    for i in range(1, len(srt)):
        prev = srt[i-1]
        if prev["net"] < 0 and (srt[i]["entry_dt"] - prev["exit_dt"]).total_seconds() < 300:
            revenge += 1
    P(f"  [Revenge] {revenge} trades entered <5min after a loss — impulsive re-entry.")

    # 7) Time-of-day
    by_hr = defaultdict(lambda: [0,0.0])
    for t in trades:
        h = t["entry_dt"].hour; by_hr[h][0]+=1; by_hr[h][1]+=t["net"]
    worst = sorted(by_hr.items(), key=lambda kv: kv[1][1])[:2]
    best  = sorted(by_hr.items(), key=lambda kv: kv[1][1], reverse=True)[:2]
    P("  [Time] Worst entry hours (IST-ish): " +
      ", ".join(f"{h}:00 (Rs {v[1]:,.0f}, {v[0]}t)" for h,v in worst))
    P("         Best entry hours:  " +
      ", ".join(f"{h}:00 (Rs {v[1]:,.0f}, {v[0]}t)" for h,v in best))

    # 8) CE vs PE
    for typ in ("CALL","PUT"):
        ts=[t for t in trades if t["type"]==typ]
        if ts:
            P(f"  [{typ}] {len(ts)} trades, win {pct(len([x for x in ts if x['net']>0]),len(ts)):.0f}%, "
              f"net Rs {sum(x['net'] for x in ts):,.0f}")

    # 9) Underlying
    for u in sorted({t["underlying"] for t in trades}):
        ts=[t for t in trades if t["underlying"]==u]
        P(f"  [{u}] {len(ts)} trades, win {pct(len([x for x in ts if x['net']>0]),len(ts)):.0f}%, "
          f"net Rs {sum(x['net'] for x in ts):,.0f}")

    # 10) Max consecutive losses + worst trade
    cur=mx=0
    for t in sorted(trades, key=lambda t:t["entry_dt"]):
        if t["net"]<0: cur+=1; mx=max(mx,cur)
        else: cur=0
    worst_t = min(trades, key=lambda t:t["net"])
    P(f"  [Streaks] Max consecutive losses: {mx}. Worst single trade: "
      f"Rs {worst_t['net']:,.0f} ({worst_t['symbol']}).")
    P("="*64)

    # dump pairs for reference
    OUT_CSV.parent.mkdir(exist_ok=True)
    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["entry_dt","exit_dt","underlying","symbol","type","strike","expiry",
                    "qty","entry_px","exit_px","hold_min","gross","charges","net"])
        for t in sorted(trades, key=lambda t:t["entry_dt"]):
            w.writerow([t["entry_dt"],t["exit_dt"],t["underlying"],t["symbol"],t["type"],
                        t["strike"],t["expiry"],t["qty"],t["entry_px"],t["exit_px"],
                        t["hold_min"],t["gross"],t["charges"],t["net"]])
    P(f"\nPaired trades written to {OUT_CSV}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=365)
    args = ap.parse_args()
    dhan = client()
    print(f"Fetching trade history (last {args.days} days)...")
    execs = fetch_all(dhan, args.days)
    print(f"Fetched {len(execs)} executions.")
    trades = pair_trades(execs)
    print(f"Paired into {len(trades)} round-trip trades.")
    analyze(trades)


if __name__ == "__main__":
    main()
