"""
consolidated_audit.py — merge Dhan + Stocko option-buying into one P&L view,
and break the Stocko data down by month, time-of-day and strike/premium.

Stocko: parsed from raw/trades/DerivativeTradeConfirmation_Stocko.txt (leg rows),
        FIFO-paired buy->sell into round trips (same method as the Dhan audit).
Dhan:   loaded from data/trade_audit_pairs.csv (already paired round trips).
"""
import csv
import io
import re
import sys
from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
STOCKO_TXT = HERE.parent.parent / "Obsidian" / "Trading_Mind" / "raw" / "trades" / "DerivativeTradeConfirmation_Stocko.txt"
if not STOCKO_TXT.exists():
    STOCKO_TXT = Path(r"E:\Obsidian\Trading_Mind\raw\trades\DerivativeTradeConfirmation_Stocko.txt")
DHAN_CSV = HERE / "data" / "trade_audit_pairs.csv"

ROW = re.compile(
    r"^(\d{2}-\d{2}-\d{4})\s+\d+\s+OPTIDX\s+(\w+)\s+(\d{2}/\d{2}/\d{4})\s+"
    r"([\d,]+\.\d+)\s+(CE|PE)\s+11\s+(\d{2}:\d{2}:\d{2})\s+(-?\d+)\s+([\d.]+)"
)


def parse_stocko():
    legs = []
    for line in STOCKO_TXT.read_text(encoding="utf-8", errors="replace").splitlines():
        m = ROW.match(line.strip())
        if not m:
            continue
        d, sym, exp, strike, typ, t, qty, rate = m.groups()
        dt = datetime.strptime(f"{d} {t}", "%d-%m-%Y %H:%M:%S")
        legs.append({
            "dt": dt, "symbol": sym, "expiry": exp,
            "strike": float(strike.replace(",", "")), "type": typ,
            "qty": int(qty), "rate": float(rate),
        })
    return legs


def fifo_pairs(legs):
    """Pair buy(open)->sell(close) per contract into round trips."""
    legs.sort(key=lambda x: x["dt"])
    book = defaultdict(deque)
    trades = []
    for e in legs:
        key = (e["symbol"], e["expiry"], e["strike"], e["type"])
        if e["qty"] > 0:
            book[key].append({"q": e["qty"], "px": e["rate"], "dt": e["dt"]})
        else:
            rem = -e["qty"]
            while rem > 0 and book[key]:
                lot = book[key][0]
                m = min(rem, lot["q"])
                trades.append({
                    "symbol": e["symbol"], "type": e["type"], "strike": e["strike"],
                    "entry_dt": lot["dt"], "exit_dt": e["dt"], "qty": m,
                    "entry_px": lot["px"], "exit_px": e["rate"],
                    "pnl": round((e["rate"] - lot["px"]) * m, 2),
                })
                lot["q"] -= m; rem -= m
                if lot["q"] == 0:
                    book[key].popleft()
    return trades


def load_dhan():
    if not DHAN_CSV.exists():
        return []
    out = []
    for r in csv.DictReader(open(DHAN_CSV, encoding="utf-8")):
        out.append({
            "entry_dt": datetime.fromisoformat(r["entry_dt"]),
            "symbol": r["underlying"], "type": r["type"],
            "entry_px": float(r["entry_px"]),
            "gross": float(r["gross"]), "net": float(r["net"]),
        })
    return out


def pct(n, d): return (n / d * 100) if d else 0


def main():
    P = print
    st = fifo_pairs(parse_stocko())
    dh = load_dhan()

    st_pnl = sum(t["pnl"] for t in st)
    st_w = sum(1 for t in st if t["pnl"] > 0)
    dh_gross = sum(t["gross"] for t in dh)
    dh_net = sum(t["net"] for t in dh)
    dh_w = sum(1 for t in dh if t["net"] > 0)
    # Stocko net estimate: ~Rs 50 round-trip brokerage+taxes
    st_cost = len(st) * 50.0
    st_net = st_pnl - st_cost

    P("\n" + "="*66)
    P("  CONSOLIDATED OPTION-BUYING P&L — Dhan + Stocko")
    P("="*66)
    P(f"  {'Broker':<10}{'Trades':>8}{'WinRate':>9}{'Gross P&L':>14}{'Net P&L':>14}")
    P("  " + "-"*62)
    P(f"  {'Dhan':<10}{len(dh):>8}{pct(dh_w,len(dh)):>8.1f}%{('Rs '+format(dh_gross,',.0f')):>14}{('Rs '+format(dh_net,',.0f')):>14}")
    P(f"  {'Stocko':<10}{len(st):>8}{pct(st_w,len(st)):>8.1f}%{('Rs '+format(st_pnl,',.0f')):>14}{('Rs '+format(st_net,',.0f')):>14}*")
    P("  " + "-"*62)
    tot_tr = len(dh) + len(st)
    tot_g = dh_gross + st_pnl
    tot_n = dh_net + st_net
    P(f"  {'TOTAL':<10}{tot_tr:>8}{pct(dh_w+st_w,tot_tr):>8.1f}%{('Rs '+format(tot_g,',.0f')):>14}{('Rs '+format(tot_n,',.0f')):>14}")
    P(f"  * Stocko net estimates Rs50/round-trip brokerage (Rs {st_cost:,.0f} total); confirmation is gross.")
    P(f"\n  COMBINED NET (both brokers): Rs {tot_n:,.0f}  across {tot_tr} round-trip trades")

    # ── Stocko breakdowns ──────────────────────────────────────────────────────
    P("\n" + "="*66)
    P("  STOCKO BREAKDOWN")
    P("="*66)

    P("\n  By MONTH (entry):")
    P(f"  {'Month':<10}{'Trades':>8}{'Win%':>7}{'Net P&L (Rs)':>15}")
    bym = defaultdict(list)
    for t in st: bym[t["entry_dt"].strftime("%Y-%m")].append(t)
    for k in sorted(bym):
        ts = bym[k]; p = sum(x["pnl"] for x in ts)
        P(f"  {k:<10}{len(ts):>8}{pct(sum(1 for x in ts if x['pnl']>0),len(ts)):>6.0f}%{p:>15,.0f}")

    P("\n  By TIME-OF-DAY (entry hour, IST):")
    P(f"  {'Hour':<10}{'Trades':>8}{'Win%':>7}{'Net P&L (Rs)':>15}")
    byh = defaultdict(list)
    for t in st: byh[t["entry_dt"].hour].append(t)
    for h in sorted(byh):
        ts = byh[h]; p = sum(x["pnl"] for x in ts)
        P(f"  {str(h)+':00':<10}{len(ts):>8}{pct(sum(1 for x in ts if x['pnl']>0),len(ts)):>6.0f}%{p:>15,.0f}")

    P("\n  By ENTRY PREMIUM (moneyness proxy — far-OTM are cheap):")
    P(f"  {'Premium':<14}{'Trades':>8}{'Win%':>7}{'Net P&L (Rs)':>15}")
    def bucket(px): return "< Rs20 (OTM)" if px<20 else "Rs20-50" if px<50 else "Rs50-100" if px<100 else "Rs100-200" if px<200 else "Rs200+ (ITM)"
    byp = defaultdict(list)
    for t in st: byp[bucket(t["entry_px"])].append(t)
    for k in ["< Rs20 (OTM)","Rs20-50","Rs50-100","Rs100-200","Rs200+ (ITM)"]:
        ts = byp.get(k,[])
        if not ts: continue
        p = sum(x["pnl"] for x in ts)
        P(f"  {k:<14}{len(ts):>8}{pct(sum(1 for x in ts if x['pnl']>0),len(ts)):>6.0f}%{p:>15,.0f}")

    P("\n  By UNDERLYING & TYPE:")
    for sym in sorted({t["symbol"] for t in st}):
        for typ in ("CE","PE"):
            ts=[t for t in st if t["symbol"]==sym and t["type"]==typ]
            if not ts: continue
            p=sum(x["pnl"] for x in ts)
            P(f"  {sym} {typ}: {len(ts)} trades, win {pct(sum(1 for x in ts if x['pnl']>0),len(ts)):.0f}%, net Rs {p:,.0f}")
    P("="*66)


if __name__ == "__main__":
    main()
