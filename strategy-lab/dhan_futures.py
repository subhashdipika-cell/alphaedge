"""
dhan_futures.py — current-month INDEX FUTURES (auto-rolling) + futures charges.

Replaces the (untradable) index spot with the tradable monthly index future.
`current_futures()` reads Dhan's scrip master and returns the nearest-expiry
FUTIDX contract per underlying — so it AUTO-ROLLS to next month after expiry.

Charges: Dhan's margin_calculator returns margin but a 0 brokerage field, so
transaction costs use the standard NSE/BSE regulatory structure (the same STT /
exchange / SEBI / stamp / GST every broker levies) + Dhan's flat Rs 20/order.
Futures cost is TURNOVER-based (STT on full notional), unlike options.
"""
import csv
import io
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib import request as urlrequest

HERE       = Path(__file__).parent
MASTER     = HERE / "dhan_scrip_master.csv"
MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv"

# pipeline symbol -> scrip-master UNDERLYING_SYMBOL
FUT_UNDERLYINGS = {"NIFTY50": "NIFTY", "BANKNIFTY": "BANKNIFTY", "SENSEX": "SENSEX"}


def _ensure_master(refresh=False):
    if refresh or not MASTER.exists() or MASTER.stat().st_size == 0:
        with urlrequest.urlopen(MASTER_URL, timeout=90) as r:
            MASTER.write_bytes(r.read())
    return MASTER


def _ist_today():
    return datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=5, minutes=30))).date()


def current_futures(today=None, refresh=False):
    """{pipeline_symbol: {security_id, segment, instrument, lot, expiry, display}}
    — nearest-expiry FUTIDX contract >= today (auto-rolls after each expiry)."""
    _ensure_master(refresh)
    today = today or _ist_today()
    want = set(FUT_UNDERLYINGS.values())
    rows = {}
    with open(MASTER, encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            if row.get("INSTRUMENT") != "FUTIDX":
                continue
            us = row.get("UNDERLYING_SYMBOL")
            if us not in want:
                continue
            try:
                exp = datetime.strptime(row["SM_EXPIRY_DATE"], "%Y-%m-%d").date()
            except Exception:
                continue
            rows.setdefault(us, []).append((exp, row))
    out = {}
    for sym, under in FUT_UNDERLYINGS.items():
        cands = sorted((e, r) for e, r in rows.get(under, []) if e >= today)
        if not cands:
            continue
        exp, row = cands[0]
        out[sym] = {
            "security_id": row["SECURITY_ID"],
            "segment":     f'{row["EXCH_ID"]}_FNO',   # NSE_FNO / BSE_FNO
            "instrument":  "FUTIDX",
            "lot":         int(float(row["LOT_SIZE"])),
            "expiry":      exp.isoformat(),
            "display":     (row.get("DISPLAY_NAME") or "").strip(),
        }
    return out


# ── Index-futures transaction charges (NSE/BSE regulatory + Dhan brokerage) ─────
BROKERAGE_PER_ORDER = 20.0      # Dhan flat Rs 20/order (futures: 20 < 0.03% of notional)
STT_SELL_PCT        = 0.0002    # 0.02% on SELL-side notional (post 01-Oct-2024)
EXCH_TXN_PCT        = 0.000019  # NSE index futures ~0.0019% per side
SEBI_PCT            = 0.000001  # 0.0001% (Rs 10/crore) per side
STAMP_BUY_PCT       = 0.00002   # 0.002% on BUY-side notional
GST_PCT             = 0.18      # on brokerage + exchange txn + SEBI


def futures_round_trip_cost(entry_notional, exit_notional):
    """Total round-trip charges (Rs) for one futures trade, given buy/sell notional."""
    brokerage = BROKERAGE_PER_ORDER * 2
    stt   = STT_SELL_PCT  * exit_notional
    exch  = EXCH_TXN_PCT  * (entry_notional + exit_notional)
    sebi  = SEBI_PCT      * (entry_notional + exit_notional)
    stamp = STAMP_BUY_PCT * entry_notional
    gst   = GST_PCT * (brokerage + exch + sebi)
    return brokerage + stt + exch + sebi + stamp + gst


if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    fut = current_futures(refresh=("--refresh" in sys.argv))
    print(f"Current index futures (as of {_ist_today()}):")
    for sym, m in fut.items():
        notional = 24000 * m["lot"]   # rough, for a cost illustration
        rt = futures_round_trip_cost(notional, notional)
        print(f"  {sym:<10} {m['display']:<22} secId={m['security_id']:<9} {m['segment']:<8} "
              f"lot={m['lot']:<3} exp={m['expiry']}  ~Rs{rt:,.0f}/lot round-trip")
