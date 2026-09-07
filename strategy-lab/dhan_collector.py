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
if __name__ == "__main__":
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
from market_archive import INDEX_INSTRUMENTS, append_verified

# Dhan intraday interval (minutes, int per the SDK) -> our timeframe label.
INTRADAY_TFS = {
    1:  "M1",
    5:  "M5",
    60: "H1",
}

# This is a per-request limit, NOT a retention limit. Longer ranges are chunked.
MAX_INTRADAY_DAYS = 90


def request_windows(start, end, chunk_days=30):
    """Inclusive calendar dates, explicit session bounds, no 90-day truncation."""
    start, end = datetime.strptime(start, '%Y-%m-%d').date(), datetime.strptime(end, '%Y-%m-%d').date()
    if start > end or not 1 <= chunk_days <= MAX_INTRADAY_DAYS:
        raise ValueError('Invalid history date range or chunk size')
    while start <= end:
        stop = min(end, start + timedelta(days=chunk_days - 1))
        yield f'{start} 09:15:00', f'{stop} 15:30:00'
        start = stop + timedelta(days=1)


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
    parser.add_argument("--indices-only", action="store_true", help="Skip futures resolution and futures requests")
    parser.add_argument("--from-date", help="First date, YYYY-MM-DD (overrides --days)")
    parser.add_argument("--to-date", help="Last date inclusive, YYYY-MM-DD (default today IST)")
    parser.add_argument("--chunk-days", type=int, default=30, help="Calendar days per request, 1–90")
    args = parser.parse_args()

    today = datetime.now(timezone(timedelta(minutes=330))).date()
    if args.days < 1:
        parser.error('--days must be positive')
    from_date = args.from_date or (today - timedelta(days=args.days)).isoformat()
    to_date = args.to_date or today.isoformat()
    try:
        windows = list(request_windows(from_date, to_date, args.chunk_days))
        if datetime.strptime(to_date, '%Y-%m-%d').date() > today:
            raise ValueError('Future end date is not allowed')
    except ValueError as exc:
        parser.error(str(exc))
    dhan = build_client()

    chosen = dict(INDEX_INSTRUMENTS)
    try:
        if not args.indices_only:
            from dhan_futures import current_futures
            chosen.update({name + ':FUTIDX': meta for name, meta in current_futures().items()})
    except Exception as exc:
        log(f"Futures resolution unavailable; continuing index collection: {type(exc).__name__}")
    if args.only:
        want = {s.strip().upper() for s in args.only.split(",") if s.strip()}
        missing = want - {k.split(':')[0].upper() for k in chosen}
        chosen = {k: v for k, v in chosen.items() if k.split(':')[0].upper() in want}
        for m in missing:
            log(f"WARNING: '{m}' not in INSTRUMENTS — add it via dhan_lookup.py first")

    if not chosen:
        log("No instruments selected. Add some to INSTRUMENTS or check --only.")
        return 2

    mode = "DAILY" if args.daily else "INTRADAY"
    log(f"=== Dhan collector starting ({mode}, {from_date} -> {to_date}) ===")
    log(f"Instruments: {', '.join(chosen)}")

    failures = []
    for name, meta in chosen.items():
        if args.daily:
            rows = fetch_daily(dhan, meta, from_date, to_date)
            n = append_verified(DATA_DIR, name.split(':')[0], "D1", rows, meta)
            log(f"  {name} D1: +{n} new bars ({len(rows)} fetched)")
            if not rows:
                failures.append(f'{name}/D1: empty or failed response')
            time.sleep(0.6)  # be gentle on rate limits
        else:
            for interval, tf in INTRADAY_TFS.items():
                for start, end in windows:
                    try:
                        rows = fetch_intraday(dhan, meta, interval, start, end)
                        n = append_verified(DATA_DIR, name.split(':')[0], tf, rows, meta)
                        log(f"  {name} {tf} {start[:10]}..{end[:10]}: +{n} new bars ({len(rows)} fetched)")
                        if not rows:
                            failures.append(f'{name}/{tf}/{start[:10]}: empty or failed response')
                    except Exception as exc:
                        # Do not log exception bodies which might contain request credentials.
                        failures.append(f'{name}/{tf}/{start[:10]}: {type(exc).__name__}')
                        log(f"  {name} {tf}: request/archive failed ({type(exc).__name__})")
                    time.sleep(1.1)

    if failures:
        log(f"=== Incomplete history collection: {len(failures)} empty/failed requests; not evidence of coverage ===")
        for failure in failures:
            log(failure)
        return 2
    log("=== Dhan collector done ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
