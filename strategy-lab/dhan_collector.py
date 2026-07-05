"""
dhan_collector.py — Dhan Historical Data API collector
======================================================
Pulls historical OHLCV candles from Dhan's Data APIs and writes them to the
SAME daily-CSV format the MT5 collector uses, so backtester.py can consume
Dhan (Indian market) data exactly like XAUUSD+/BTCUSD.

Endpoints (Dhan v2):
  - Intraday : POST https://api.dhan.co/v2/charts/intraday   (1/5/15/25/60-min)
  - Daily    : POST https://api.dhan.co/v2/charts/historical  (1 candle / day)

Credentials:
  Reads dhan_config.json (copy from dhan_config.example.json), OR the
  environment variables DHAN_ACCESS_TOKEN and DHAN_CLIENT_ID.

Usage:
  python dhan_collector.py                 # pull default instruments, last 5 days intraday
  python dhan_collector.py --days 30       # last 30 calendar days
  python dhan_collector.py --daily --days 365   # daily candles for swing backtests
  python dhan_collector.py --only NIFTY50,BANKNIFTY
"""

import argparse
import csv
import io
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Force UTF-8 output on Windows consoles
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# Official Dhan SDK — handles auth headers, the required dhanClientId body field,
# and integer intervals. Install with:  pip install dhanhq
try:
    from dhanhq import DhanContext, dhanhq
except ImportError:
    DhanContext = dhanhq = None

# ── Paths ────────────────────────────────────────────────────────────────────
HERE        = Path(__file__).parent
DATA_DIR    = HERE / "data"
LOG_FILE    = HERE / "dhan_collector.log"
CONFIG_FILE = HERE / "dhan_config.json"
DATA_DIR.mkdir(exist_ok=True)

# ── Instruments ──────────────────────────────────────────────────────────────
# We trade the tradable MONTHLY INDEX FUTURES (FUTIDX), not the untradable index
# spot. dhan_futures.current_futures() resolves the nearest-expiry contract per
# underlying from Dhan's scrip master and AUTO-ROLLS to next month after expiry.
try:
    from dhan_futures import current_futures
    INSTRUMENTS = current_futures()     # {NIFTY50: {security_id, segment:NSE_FNO, instrument:FUTIDX, lot, expiry, display}, ...}
except Exception as _e:
    INSTRUMENTS = {}
    print(f"WARNING: could not resolve index futures: {_e}")

# Dhan intraday interval (minutes, int per the SDK) -> our timeframe label.
INTRADAY_TFS = {
    1:  "M1",
    5:  "M5",
    60: "H1",
}

# Dhan intraday allows at most ~90 days of history per request.
MAX_INTRADAY_DAYS = 90


# ── Helpers ──────────────────────────────────────────────────────────────────

def log(msg: str):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def build_client():
    """Build an authenticated dhanhq client from config file or environment."""
    if dhanhq is None:
        log("ERROR: dhanhq package not installed. Run:  pip install dhanhq")
        sys.exit(1)
    token = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()
    client = os.environ.get("DHAN_CLIENT_ID", "").strip()
    if (not token or not client) and CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            token  = token  or str(cfg.get("access_token", "")).strip()
            client = client or str(cfg.get("client_id", "")).strip()
        except Exception as e:
            log(f"ERROR: could not read {CONFIG_FILE.name}: {e}")
    if not token or token.startswith("PASTE_") or not client or client.startswith("PASTE_"):
        log("ERROR: missing Dhan credentials. Copy dhan_config.example.json to "
            "dhan_config.json and fill in BOTH access_token and client_id "
            "(or set DHAN_ACCESS_TOKEN / DHAN_CLIENT_ID).")
        sys.exit(1)
    ctx = DhanContext(client, token)
    return dhanhq(ctx)


def candles_from_response(resp: dict) -> list[dict]:
    """Convert the SDK response into a list of OHLCV row dicts.

    The SDK wraps payloads as {'status','remarks','data'}; the actual OHLCV
    column-arrays live under 'data'. We also accept a bare data dict.
    """
    if not resp:
        return []
    if resp.get("status") == "failure":
        log(f"  Dhan API failure: {resp.get('remarks')}")
        return []
    data = resp.get("data", resp) if isinstance(resp, dict) else {}
    if not isinstance(data, dict):
        return []
    opens  = data.get("open")  or []
    highs  = data.get("high")  or []
    lows   = data.get("low")   or []
    closes = data.get("close") or []
    vols   = data.get("volume") or []
    times  = data.get("timestamp") or []
    n = min(len(opens), len(highs), len(lows), len(closes), len(times))
    rows = []
    for i in range(n):
        # Dhan timestamps are epoch seconds (UTC).
        ts = datetime.fromtimestamp(int(times[i]), tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        vol = vols[i] if i < len(vols) else 0
        rows.append({
            "time": ts, "open": opens[i], "high": highs[i],
            "low": lows[i], "close": closes[i], "volume": vol or 0,
        })
    return rows


def csv_path(symbol: str, tf: str) -> Path:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return DATA_DIR / f"{symbol}_{tf}_{today}.csv"


def load_existing_times(path: Path) -> set:
    if not path.exists():
        return set()
    with open(path, newline="") as f:
        return {row["time"] for row in csv.DictReader(f)}


def append_rows(symbol: str, tf: str, rows: list[dict]) -> int:
    """Append new candles to the daily CSV in the MT5 collector's format."""
    if not rows:
        return 0
    path = csv_path(symbol, tf)
    existing = load_existing_times(path)
    write_header = not path.exists()
    new = 0
    with open(path, "a", newline="") as f:
        writer = csv.writer(f)
        if write_header:
            writer.writerow(["time", "open", "high", "low", "close",
                             "tick_volume", "spread", "real_volume"])
        for r in rows:
            if r["time"] in existing:
                continue
            # spread is unknown from Dhan -> 0; real_volume mirrors volume.
            writer.writerow([r["time"], r["open"], r["high"], r["low"],
                             r["close"], r["volume"], 0, r["volume"]])
            existing.add(r["time"])
            new += 1
    return new


# ── Fetchers ─────────────────────────────────────────────────────────────────

def fetch_intraday(dhan, meta: dict, interval: int,
                   from_date: str, to_date: str) -> list[dict]:
    resp = dhan.intraday_minute_data(
        security_id     = meta["security_id"],
        exchange_segment= meta["segment"],
        instrument_type = meta["instrument"],
        from_date       = from_date,
        to_date         = to_date,
        interval        = interval,
    )
    return candles_from_response(resp)


def fetch_daily(dhan, meta: dict, from_date: str, to_date: str) -> list[dict]:
    resp = dhan.historical_daily_data(
        security_id     = meta["security_id"],
        exchange_segment= meta["segment"],
        instrument_type = meta["instrument"],
        from_date       = from_date,
        to_date         = to_date,
    )
    return candles_from_response(resp)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Dhan historical data collector")
    parser.add_argument("--days", type=int, default=5,
                        help="Calendar days of history to pull (default 5)")
    parser.add_argument("--daily", action="store_true",
                        help="Pull daily candles (for swing backtests) instead of intraday")
    parser.add_argument("--only", type=str, default="",
                        help="Comma-separated instrument names to limit to (e.g. NIFTY50,BANKNIFTY)")
    args = parser.parse_args()

    dhan = build_client()

    chosen = INSTRUMENTS
    if args.only:
        want = {s.strip().upper() for s in args.only.split(",") if s.strip()}
        chosen = {k: v for k, v in INSTRUMENTS.items() if k.upper() in want}
        missing = want - {k.upper() for k in INSTRUMENTS}
        for m in missing:
            log(f"WARNING: '{m}' not in INSTRUMENTS — add it via dhan_lookup.py first")

    if not chosen:
        log("No instruments selected. Add some to INSTRUMENTS or check --only.")
        return

    today = datetime.now(timezone.utc).date()
    days  = args.days
    if not args.daily and days > MAX_INTRADAY_DAYS:
        log(f"Intraday history capped at {MAX_INTRADAY_DAYS} days — using {MAX_INTRADAY_DAYS}.")
        days = MAX_INTRADAY_DAYS
    from_date = (today - timedelta(days=days)).strftime("%Y-%m-%d")
    to_date   = today.strftime("%Y-%m-%d")

    mode = "DAILY" if args.daily else "INTRADAY"
    log(f"=== Dhan collector starting ({mode}, {from_date} -> {to_date}) ===")
    log(f"Instruments: {', '.join(chosen)}")

    for name, meta in chosen.items():
        if args.daily:
            rows = fetch_daily(dhan, meta, from_date, to_date)
            n = append_rows(name, "D1", rows)
            log(f"  {name} D1: +{n} new bars ({len(rows)} fetched)")
            time.sleep(0.6)  # be gentle on rate limits
        else:
            for interval, tf in INTRADAY_TFS.items():
                rows = fetch_intraday(dhan, meta, interval, from_date, to_date)
                n = append_rows(name, tf, rows)
                log(f"  {name} {tf}: +{n} new bars ({len(rows)} fetched)")
                time.sleep(0.6)

    log("=== Dhan collector done ===")


if __name__ == "__main__":
    main()
