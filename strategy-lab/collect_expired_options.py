"""Backfill Dhan expired-options rolling data for Zero-Hero research.

Dhan returns minute OHLC, IV, volume, OI and spot for ATM-relative contracts.
It does not return historical bid/ask or Greeks, and the returned strike can
move as the ATM reference moves. Files are therefore kept separate from live
option-chain snapshots and are never treated as exact fixed-contract fills.

Example:
  python collect_expired_options.py --days 365 --interval 1
"""
import argparse
import csv
import io
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys_stdout = io.TextIOWrapper(__import__("sys").stdout.buffer, encoding="utf-8", errors="replace")
__import__("sys").stdout = sys_stdout

try:
    from dhanhq import DhanContext, dhanhq
except ImportError:
    DhanContext = dhanhq = None

HERE = Path(__file__).parent
DATA_DIR = HERE / "data" / "expired_options"
CONFIG = HERE / "dhan_config.json"
MANIFEST = HERE / "data" / "zerohero_expired_options_manifest.json"
INDEXES = {"NIFTY50": 13, "BANKNIFTY": 25}
ROWS = ["time", "underlying", "spot", "strike", "relative_strike", "type",
        "open", "high", "low", "close", "iv", "volume", "oi", "source"]
MAX_DAYS = 30


def log(message):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def client():
    if dhanhq is None:
        raise RuntimeError("dhanhq is not installed")
    token = os.environ.get("DHAN_ACCESS_TOKEN", "")
    client_id = os.environ.get("DHAN_CLIENT_ID", "")
    if (not token or not client_id) and CONFIG.exists():
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
        token = token or str(cfg.get("access_token", ""))
        client_id = client_id or str(cfg.get("client_id", ""))
    if not token or not client_id or token.startswith("PASTE_"):
        raise RuntimeError("missing Dhan credentials")
    return dhanhq(DhanContext(client_id.strip(), token.strip()))


def series_rows(response, symbol, option_type, relative):
    if not isinstance(response, dict) or response.get("status") == "failure":
        return []
    data = response.get("data", response)
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data["data"]
    leg = data.get("ce" if option_type == "CALL" else "pe") if isinstance(data, dict) else None
    if not isinstance(leg, dict):
        return []
    fields = {key: leg.get(key) or [] for key in ("timestamp", "spot", "strike", "open", "high", "low", "close", "iv", "volume", "oi")}
    count = len(fields["timestamp"])
    out = []
    for i in range(count):
        stamp = datetime.fromtimestamp(int(fields["timestamp"][i]), tz=timezone.utc)
        out.append({
            "time": stamp.strftime("%Y-%m-%d %H:%M:%S"), "underlying": symbol,
            "spot": fields["spot"][i] if i < len(fields["spot"]) else "",
            "strike": fields["strike"][i] if i < len(fields["strike"]) else "",
            "relative_strike": relative, "type": "CE" if option_type == "CALL" else "PE",
            "open": fields["open"][i] if i < len(fields["open"]) else "",
            "high": fields["high"][i] if i < len(fields["high"]) else "",
            "low": fields["low"][i] if i < len(fields["low"]) else "",
            "close": fields["close"][i] if i < len(fields["close"]) else "",
            "iv": fields["iv"][i] if i < len(fields["iv"]) else "",
            "volume": fields["volume"][i] if i < len(fields["volume"]) else "",
            "oi": fields["oi"][i] if i < len(fields["oi"]) else "",
            "source": "Dhan rollingoption",
        })
    return out


def write_rows(rows):
    grouped = {}
    for row in rows:
        grouped.setdefault(row["time"][:10], []).append(row)
    written = 0
    for day, day_rows in grouped.items():
        path = DATA_DIR / f"{day}.csv"
        existing = set()
        if path.exists():
            with path.open(newline="", encoding="utf-8") as fh:
                existing = {(r.get("underlying"), r.get("time"), r.get("relative_strike"), r.get("type")) for r in csv.DictReader(fh)}
        new = [r for r in day_rows if (r["underlying"], r["time"], r["relative_strike"], r["type"]) not in existing]
        if not new:
            continue
        with path.open("a", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=ROWS)
            if not path.stat().st_size:
                writer.writeheader()
            writer.writerows(new)
        written += len(new)
    return written


def main():
    ap = argparse.ArgumentParser(description="Backfill Dhan expired-options rolling data")
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--interval", type=int, choices=(1, 5, 15, 25, 60), default=1)
    ap.add_argument("--expiry-flag", choices=("WEEK", "MONTH"), default="WEEK")
    ap.add_argument("--expiry-code", type=int, default=0, help="Dhan rolling expiry code")
    ap.add_argument("--strikes", default="ATM,ATM+1,ATM-1", help="comma-separated Dhan ATM-relative strikes")
    args = ap.parse_args()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    dhan = client()
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=max(1, args.days))
    strikes = [s.strip().upper() for s in args.strikes.split(",") if s.strip()]
    required = ["open", "high", "low", "close", "iv", "volume", "strike", "oi", "spot"]
    summary = {"updatedAt": datetime.now(timezone.utc).isoformat(), "from": start.isoformat(), "to": end.isoformat(), "interval": args.interval, "expiryFlag": args.expiry_flag, "expiryCode": args.expiry_code, "strikes": strikes, "rows": 0, "errors": []}
    cursor = start
    while cursor <= end:
        chunk_end = min(end, cursor + timedelta(days=MAX_DAYS - 1))
        for symbol, security_id in INDEXES.items():
            for relative in strikes:
                for option_type in ("CALL", "PUT"):
                    try:
                        response = dhan.expired_options_data(
                            security_id=security_id, exchange_segment="NSE_FNO", instrument_type="OPTIDX",
                            expiry_flag=args.expiry_flag, expiry_code=args.expiry_code, strike=relative,
                            drv_option_type=option_type, required_data=required,
                            from_date=cursor.isoformat(), to_date=(chunk_end + timedelta(days=1)).isoformat(), interval=args.interval)
                        rows = series_rows(response, symbol, option_type, relative)
                        if not rows and isinstance(response, dict):
                            remarks = response.get("remarks") or response.get("errorMessage") or "empty data"
                            payload = response.get("data") if isinstance(response.get("data"), dict) else {}
                            log(f"  {symbol} {relative} {option_type}: Dhan response has no bars ({remarks}); keys={list(response.keys())}, data_keys={list(payload.keys())}")
                        summary["rows"] += write_rows(rows)
                        log(f"{symbol} {relative} {option_type} {cursor}->{chunk_end}: {len(rows)} bars")
                    except Exception as exc:
                        error = f"{symbol} {relative} {option_type} {cursor}->{chunk_end}: {exc}"
                        summary["errors"].append(error)
                        log(f"ERROR {error}")
                    time.sleep(0.25)
        cursor = chunk_end + timedelta(days=1)
    MANIFEST.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    log(f"Expired-options manifest written to {MANIFEST}")
    if summary["errors"] and not summary["rows"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
