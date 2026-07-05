"""
dhan_lookup.py — find a Dhan securityId for a stock or F&O symbol
=================================================================
Dhan identifies every tradable instrument by a numeric securityId. Indices are
well-known (Nifty 50 = 13, Bank Nifty = 25) but stocks and F&O contracts are
not, so look them up in Dhan's public scrip master.

Usage:
  python dhan_lookup.py RELIANCE
  python dhan_lookup.py HDFCBANK --segment NSE_EQ
  python dhan_lookup.py "NIFTY" --segment NSE_FNO        # futures/options rows

Then copy the printed securityId/segment/instrument into INSTRUMENTS in
dhan_collector.py.
"""

import argparse
import csv
import io
import sys
from pathlib import Path
from urllib import request as urlrequest

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# Dhan publishes a "detailed" scrip master CSV (refreshed daily).
SCRIP_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv"
CACHE = Path(__file__).parent / "dhan_scrip_master.csv"


def ensure_master() -> Path:
    if CACHE.exists() and CACHE.stat().st_size > 0:
        return CACHE
    print(f"Downloading scrip master from {SCRIP_MASTER_URL} ...")
    with urlrequest.urlopen(SCRIP_MASTER_URL, timeout=60) as resp:
        CACHE.write_bytes(resp.read())
    print(f"Saved to {CACHE.name} ({CACHE.stat().st_size//1024} KB)")
    return CACHE


def search(symbol: str, segment: str | None):
    path = ensure_master()
    symbol_u = symbol.upper()
    matches = []
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        # Column names vary across Dhan's master versions; resolve them loosely.
        fields = reader.fieldnames or []
        def col(*cands):
            for c in cands:
                for fn in fields:
                    if fn and fn.strip().upper() == c.upper():
                        return fn
            return None
        sec_col = col("SECURITY_ID", "SEM_SMST_SECURITY_ID", "securityId")
        sym_col = col("SYMBOL_NAME", "SEM_TRADING_SYMBOL", "SM_SYMBOL_NAME",
                      "UNDERLYING_SYMBOL", "DISPLAY_NAME")
        seg_col = col("EXCH_ID", "SEM_EXM_EXCH_ID", "EXCHANGE_SEGMENT", "SEGMENT")
        ins_col = col("INSTRUMENT", "SEM_INSTRUMENT_NAME", "INSTRUMENT_TYPE")
        for row in reader:
            sym_val = (row.get(sym_col) or "") if sym_col else ""
            if symbol_u not in sym_val.upper():
                continue
            seg_val = (row.get(seg_col) or "") if seg_col else ""
            if segment and segment.upper() not in seg_val.upper():
                continue
            matches.append({
                "security_id": row.get(sec_col, "?") if sec_col else "?",
                "symbol":      sym_val,
                "segment":     seg_val,
                "instrument":  (row.get(ins_col) or "") if ins_col else "",
            })
    return matches


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("symbol", help="Symbol to search, e.g. RELIANCE")
    parser.add_argument("--segment", default=None,
                        help="Filter by segment substring, e.g. NSE_EQ, NSE_FNO, IDX")
    parser.add_argument("--limit", type=int, default=25)
    args = parser.parse_args()

    rows = search(args.symbol, args.segment)
    if not rows:
        print(f"No matches for '{args.symbol}'"
              + (f" in segment '{args.segment}'" if args.segment else ""))
        return
    print(f"\n{len(rows)} match(es) — showing up to {args.limit}:\n")
    print(f"{'securityId':<12} {'segment':<10} {'instrument':<12} symbol")
    print("-" * 70)
    for r in rows[:args.limit]:
        print(f"{r['security_id']:<12} {r['segment']:<10} {r['instrument']:<12} {r['symbol']}")
    print("\nAdd the one you want to INSTRUMENTS in dhan_collector.py.")


if __name__ == "__main__":
    main()
