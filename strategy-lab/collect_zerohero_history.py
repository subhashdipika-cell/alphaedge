"""
Collect the data required by Zero-Hero Divergence.

Dhan historical API -> NIFTY50/BANKNIFTY index candles (backfillable).
Dhan option-chain API -> option snapshots (forward-only; Dhan does not expose
historical option-chain/premium snapshots).  Use --live-options to hand off to
the existing rate-limit-aware options collector after index backfill.

Examples:
  python collect_zerohero_history.py --days 365 --intervals 1,5
  python collect_zerohero_history.py --days 365 --expired-options
  python collect_zerohero_history.py --days 365 --intervals 1,5 --live-options
  python collect_zerohero_history.py --live-options --once
"""
import argparse
import csv
import io
import json
import os
import subprocess
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

try:
    from dhanhq import DhanContext, dhanhq
except ImportError:
    DhanContext = dhanhq = None

HERE = Path(__file__).parent
DATA_DIR = HERE / "data"
CONFIG_FILE = HERE / "dhan_config.json"
MANIFEST = DATA_DIR / "zerohero_collection_manifest.json"
INDEXES = {
    # Dhan index security IDs, IDX_I segment. These are the spot/index series
    # used for direction confirmation, not tradable futures.
    "NIFTY50": {"security_id": 13, "segment": "IDX_I", "instrument": "INDEX"},
    "BANKNIFTY": {"security_id": 25, "segment": "IDX_I", "instrument": "INDEX"},
}
HEADERS = ["time", "open", "high", "low", "close", "tick_volume", "spread", "real_volume"]
MAX_INTRADAY_DAYS = 90
IST = timezone(timedelta(hours=5, minutes=30))


def log(message):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def today_ist():
    return datetime.now(timezone.utc).astimezone(IST).date()


def build_client():
    if dhanhq is None:
        raise RuntimeError("dhanhq is not installed; install it in AlphaEdge's Python environment")
    token = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()
    client_id = os.environ.get("DHAN_CLIENT_ID", "").strip()
    if (not token or not client_id) and CONFIG_FILE.exists():
        cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        token = token or str(cfg.get("access_token", "")).strip()
        client_id = client_id or str(cfg.get("client_id", "")).strip()
    if not token or not client_id or token.startswith("PASTE_"):
        raise RuntimeError("missing Dhan credentials in dhan_config.json or DHAN_* environment variables")
    return dhanhq(DhanContext(client_id, token))


def unwrap_candles(response):
    if not isinstance(response, dict) or response.get("status") == "failure":
        return []
    data = response.get("data", response)
    if not isinstance(data, dict):
        return []
    fields = [data.get(k) or [] for k in ("open", "high", "low", "close", "volume", "timestamp")]
    count = min(len(fields[0]), len(fields[1]), len(fields[2]), len(fields[3]), len(fields[5]))
    rows = []
    for i in range(count):
        stamp = datetime.fromtimestamp(int(fields[5][i]), tz=timezone.utc)
        rows.append({
            "time": stamp.strftime("%Y-%m-%d %H:%M:%S"),
            "open": fields[0][i], "high": fields[1][i], "low": fields[2][i],
            "close": fields[3][i], "volume": fields[4][i] if i < len(fields[4]) else 0,
        })
    return rows


def fetch_chunk(dhan, meta, interval, start, end):
    response = dhan.intraday_minute_data(
        security_id=meta["security_id"], exchange_segment=meta["segment"],
        instrument_type=meta["instrument"], from_date=start.isoformat(),
        to_date=end.isoformat(), interval=interval,
    )
    return unwrap_candles(response)


def write_daily(symbol, rows):
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["time"][:10]].append(row)
    added = 0
    for day, day_rows in grouped.items():
        path = DATA_DIR / f"{symbol}_M{str(INTERVAL).strip()}_{day}.csv"
        existing = set()
        if path.exists():
            with path.open(newline="", encoding="utf-8") as fh:
                existing = {r.get("time") for r in csv.DictReader(fh)}
        new_rows = [r for r in day_rows if r["time"] not in existing]
        if not new_rows:
            continue
        write_header = not path.exists()
        with path.open("a", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh)
            if write_header:
                writer.writerow(HEADERS)
            for row in sorted(new_rows, key=lambda r: r["time"]):
                writer.writerow([row["time"], row["open"], row["high"], row["low"], row["close"], row["volume"], 0, row["volume"]])
                added += 1
    return added


def collect_index_history(dhan, days, intervals):
    global INTERVAL
    end = today_ist()
    start = end - timedelta(days=max(1, days))
    summary = {"from": start.isoformat(), "to": end.isoformat(), "intervals": {}, "errors": []}
    for interval in intervals:
        if interval not in (1, 5, 15, 25, 60):
            summary["errors"].append(f"unsupported interval {interval}")
            continue
        INTERVAL = interval
        summary["intervals"][str(interval)] = {}
        for symbol, meta in INDEXES.items():
            rows = []
            cursor = start
            while cursor <= end:
                chunk_end = min(end, cursor + timedelta(days=MAX_INTRADAY_DAYS - 1))
                try:
                    got = fetch_chunk(dhan, meta, interval, cursor, chunk_end)
                    rows.extend(got)
                    log(f"{symbol} M{interval}: {cursor} -> {chunk_end}: {len(got)} bars")
                except Exception as exc:
                    message = f"{symbol} M{interval} {cursor}->{chunk_end}: {exc}"
                    summary["errors"].append(message)
                    log(f"ERROR {message}")
                cursor = chunk_end + timedelta(days=1)
                time.sleep(0.7)
            unique = {r["time"]: r for r in rows}
            summary["intervals"][str(interval)][symbol] = {"fetched": len(unique), "written": 0}
            summary["intervals"][str(interval)][symbol]["written"] = write_daily(symbol, list(unique.values()))
    return summary


def start_options_collector(once=False, strike_range=7):
    command = [sys.executable, str(HERE / "dhan_options_collector.py"), "--range", str(strike_range)]
    if once:
        command.append("--once")
    log("Starting forward option-chain collection; historical option premiums are unavailable from Dhan.")
    return subprocess.call(command)


def collect_expired_options(days, interval):
    command = [sys.executable, str(HERE / "collect_expired_options.py"),
               "--days", str(days), "--interval", str(interval)]
    log("Starting Dhan expired-options historical backfill (rolling ATM data).")
    return subprocess.call(command)


def main():
    parser = argparse.ArgumentParser(description="Build Zero-Hero index history and start forward option collection")
    parser.add_argument("--days", type=int, default=365, help="calendar days of index history (default 365)")
    parser.add_argument("--intervals", default="1,5", help="Dhan minute intervals, e.g. 1,5")
    parser.add_argument("--no-index", action="store_true", help="skip index backfill")
    parser.add_argument("--live-options", action="store_true", help="run the existing live option-chain collector")
    parser.add_argument("--expired-options", action="store_true", help="backfill Dhan rolling expired-options OHLC/OI/IV data")
    parser.add_argument("--expired-interval", type=int, choices=(1, 5, 15, 25, 60), default=1)
    parser.add_argument("--once", action="store_true", help="one option snapshot instead of running through market close")
    parser.add_argument("--range", type=int, default=7, help="ATM +/- strikes for live option snapshots")
    args = parser.parse_args()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "strategy": "ZeroHeroDivergenceStrategy",
        "indexSource": "Dhan historical intraday API, IDX_I spot series",
        "optionSource": "Dhan live option-chain snapshots only",
        "historicalOptionChainAvailable": False,
        "historicalExpiredOptionsAvailable": False,
        "requestedDays": args.days,
    }
    if not args.no_index:
        try:
            dhan = build_client()
            intervals = [int(x.strip()) for x in args.intervals.split(",") if x.strip()]
            manifest["index"] = collect_index_history(dhan, args.days, intervals)
        except Exception as exc:
            manifest["indexError"] = str(exc)
            log(f"Index collection failed: {exc}")
    if args.live_options:
        manifest["optionsCollectorExitCode"] = start_options_collector(args.once, args.range)
    if args.expired_options:
        manifest["expiredOptionsExitCode"] = collect_expired_options(args.days, args.expired_interval)
        manifest["historicalExpiredOptionsAvailable"] = manifest["expiredOptionsExitCode"] == 0
    MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log(f"Collection manifest written to {MANIFEST}")
    if manifest.get("indexError"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
