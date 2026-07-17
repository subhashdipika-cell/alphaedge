"""
dhan_options_collector.py — forward options-chain collector (Dhan)
==================================================================
Dhan has NO historical options-premium database, so the only way to get
backtestable options data is to accumulate live snapshots going forward.
This polls the option chain for NIFTY50 / BANKNIFTY / SENSEX every minute
during Indian market hours and appends ATM±N strikes (CE & PE: LTP, OI, IV,
volume, greeks) to daily CSVs. Over days/weeks this builds a real premium
database you can backtest options strategies on.

Output (long format, one row per strike-leg per snapshot):
  data/options/{UNDERLYING}_OPT_{YYYY-MM-DD}.csv
  columns: time, underlying, under_ltp, expiry, strike, type, ltp, oi,
           prev_oi, iv, volume, delta, theta, vega, bid, ask

Usage:
  python dhan_options_collector.py                 # poll until market close
  python dhan_options_collector.py --range 7       # ATM +/- 7 strikes
  python dhan_options_collector.py --once          # single snapshot then exit
"""
import argparse
import csv
import io
import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

try:
    from dhanhq import DhanContext, dhanhq
except ImportError:
    DhanContext = dhanhq = None

HERE        = Path(__file__).parent
DATA_DIR    = HERE / "data" / "options"
LOG_FILE    = HERE / "dhan_options.log"
CONFIG_FILE = HERE / "dhan_config.json"
DATA_DIR.mkdir(parents=True, exist_ok=True)

UNDERLYINGS = {
    "NIFTY50":   {"id": 13, "seg": "IDX_I"},
    "BANKNIFTY": {"id": 25, "seg": "IDX_I"},
    "SENSEX":    {"id": 51, "seg": "IDX_I"},
    "FINNIFTY":  {"id": 27, "seg": "IDX_I"},   # monthly-only expiries since NSE dropped its weekly
}

POLL_SECONDS      = 60     # snapshot cadence
RATE_LIMIT_SEC    = 3.5    # Dhan option-chain limit is ~1 request / 3s — be safe
MAX_CHAIN_RETRIES = 2      # retry a throttled option-chain call (the bridge shares this account's limit)
RETRY_BACKOFF_SEC = 4.0    # wait past Dhan's ~3s throttle window before retrying
COLUMNS = ["time","underlying","under_ltp","expiry","strike","type","ltp","oi",
           "prev_oi","iv","volume","delta","theta","vega","bid","ask"]


def log(msg: str):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def build_client():
    if dhanhq is None:
        log("ERROR: dhanhq not installed — run: pip install dhanhq"); sys.exit(1)
    token = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()
    client = os.environ.get("DHAN_CLIENT_ID", "").strip()
    if (not token or not client) and CONFIG_FILE.exists():
        cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        token  = token  or str(cfg.get("access_token", "")).strip()
        client = client or str(cfg.get("client_id", "")).strip()
    if not token or token.startswith("PASTE_") or not client:
        log("ERROR: missing Dhan credentials in dhan_config.json."); sys.exit(1)
    return dhanhq(DhanContext(client, token))


def indian_market_open() -> bool:
    ist = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=5, minutes=30)))
    if ist.weekday() >= 5:
        return False
    mins = ist.hour * 60 + ist.minute
    return (9 * 60 + 15) <= mins <= (15 * 60 + 30)


def _unwrap(resp):
    """Peel the SDK {status,remarks,data} + API {status,data} wrappers."""
    if not isinstance(resp, dict):
        return {}
    if resp.get("status") == "failure":
        return {"_error": resp.get("remarks")}
    d = resp.get("data", resp)
    if isinstance(d, dict) and "data" in d and isinstance(d["data"], dict):
        d = d["data"]
    return d if isinstance(d, dict) else {}


def _is_throttle(err) -> bool:
    """A Dhan option-chain rate-limit hit returns an empty/None-filled remarks
    dict (error_code/type/message all None) or a 'rate limit' string. Those are
    transient (the bridge shares this account's ~1-req/3s budget) and worth a
    retry; a real error (bad token, bad params) is surfaced instead."""
    if err in (None, "", {}):
        return True
    if isinstance(err, dict):
        return all(v in (None, "", "null") for v in err.values())
    s = str(err).lower()
    return any(k in s for k in ("rate", "limit", "too many", "904", "throttl"))


def future_expiries(dhan, meta) -> list[str]:
    """Sorted future expiry dates for an underlying (today's expiry included)."""
    resp = dhan.expiry_list(meta["id"], meta["seg"])
    d = _unwrap(resp)
    if "_error" in d:
        log(f"  expiry_list failed: {d['_error']}"); return []
    exps = d.get("data") or (resp.get("data") if isinstance(resp.get("data"), list) else None)
    if not exps:
        exps = resp.get("data", {}).get("data") if isinstance(resp.get("data"), dict) else None
    if not exps:
        return []
    today = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d")
    future = sorted(str(e) for e in exps if str(e) >= today)
    return future or sorted(str(e) for e in exps)


def nearest_expiry(dhan, meta) -> str | None:
    resp = dhan.expiry_list(meta["id"], meta["seg"])
    d = _unwrap(resp)
    if "_error" in d:
        log(f"  expiry_list failed: {d['_error']}"); return None
    exps = d.get("data") if isinstance(d.get("data"), list) else (d if isinstance(d, list) else None)
    if not exps:
        # some responses put the list directly under 'data'
        exps = resp.get("data", {}).get("data") if isinstance(resp.get("data"), dict) else None
    if not exps:
        return None
    today = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d")
    future = [e for e in exps if str(e) >= today]
    return (future or exps)[0]


def csv_path(name: str) -> Path:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return DATA_DIR / f"{name}_OPT_{today}.csv"


def append_rows(name: str, rows: list[dict]) -> int:
    if not rows:
        return 0
    path = csv_path(name)
    write_header = not path.exists()
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        if write_header:
            w.writeheader()
        for r in rows:
            w.writerow(r)
    return len(rows)


def snapshot(dhan, name: str, meta: dict, expiry: str, atm_range: int) -> int:
    # Retry a throttled option-chain call: the bridge (app + scanner) shares this
    # Dhan account's ~1-req/3s limit, so a collision throttles us intermittently.
    # A short backoff clears the window, so the retry almost always succeeds.
    d = {}
    for attempt in range(1 + MAX_CHAIN_RETRIES):
        d = _unwrap(dhan.option_chain(meta["id"], meta["seg"], expiry))
        if "_error" not in d:
            break
        throttled = _is_throttle(d["_error"])
        if throttled and attempt < MAX_CHAIN_RETRIES:
            log(f"  {name}: option_chain throttled (shared Dhan rate limit) — retry {attempt + 1}/{MAX_CHAIN_RETRIES} in {RETRY_BACKOFF_SEC:.0f}s")
            time.sleep(RETRY_BACKOFF_SEC)
            continue
        log(f"  {name}: option_chain failed{' after retries' if throttled else ''}: {d['_error']}")
        return 0
    under_ltp = float(d.get("last_price") or 0)
    oc_map = d.get("oc") or {}
    if not oc_map or not under_ltp:
        return 0

    # ATM strike = nearest strike to the underlying LTP; take ATM +/- atm_range.
    strikes = sorted(oc_map.keys(), key=lambda s: float(s))
    floats  = [float(s) for s in strikes]
    atm_i   = min(range(len(floats)), key=lambda i: abs(floats[i] - under_ltp))
    lo, hi  = max(0, atm_i - atm_range), min(len(strikes), atm_i + atm_range + 1)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    rows = []
    for sk in strikes[lo:hi]:
        node = oc_map[sk]
        for typ in ("ce", "pe"):
            leg = node.get(typ) or {}
            if not leg:
                continue
            g = leg.get("greeks") or {}
            rows.append({
                "time": ts, "underlying": name, "under_ltp": round(under_ltp, 2),
                "expiry": expiry, "strike": round(float(sk), 2), "type": typ.upper(),
                "ltp": leg.get("last_price", 0), "oi": leg.get("oi", 0),
                "prev_oi": leg.get("previous_oi", 0),
                "iv": leg.get("implied_volatility", 0), "volume": leg.get("volume", 0),
                "delta": g.get("delta", 0), "theta": g.get("theta", 0), "vega": g.get("vega", 0),
                "bid": leg.get("top_bid_price", 0), "ask": leg.get("top_ask_price", 0),
            })
    return append_rows(name, rows)


def main():
    ap = argparse.ArgumentParser(description="Dhan forward options-chain collector")
    ap.add_argument("--range", type=int, default=5, help="ATM +/- N strikes (default 5)")
    ap.add_argument("--once", action="store_true", help="single snapshot then exit")
    args = ap.parse_args()

    dhan = build_client()
    log(f"=== Options collector starting (ATM +/- {args.range} strikes) ===")
    expiries: dict[str, list[str]] = {}
    for name, meta in UNDERLYINGS.items():
        expiries[name] = future_expiries(dhan, meta)
        log(f"  {name}: nearest expiry {expiries[name][0] if expiries[name] else '?'}")
        time.sleep(RATE_LIMIT_SEC)

    def _today() -> str:
        return datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d")

    while True:
        if not indian_market_open() and not args.once:
            log("Market closed — sleeping 5 min.")
            time.sleep(300)
            continue
        today = _today()
        for name, meta in UNDERLYINGS.items():
            exps = expiries.get(name) or []
            # Refresh when unknown or stale (front expiry already in the past —
            # happens when the collector runs across an expiry into the next day).
            if not exps or exps[0] < today:
                expiries[name] = exps = future_expiries(dhan, meta)
                time.sleep(RATE_LIMIT_SEC)
            if not exps:
                continue
            try:
                n = snapshot(dhan, name, meta, exps[0], args.range)
                if n:
                    log(f"  {name} {exps[0]}: +{n} legs -> {csv_path(name).name}")
            except Exception as e:
                log(f"  {name}: snapshot error: {e}")
            time.sleep(RATE_LIMIT_SEC)   # respect option-chain rate limit
            # Expiry day: ALSO collect the next expiry — the scoring stack rolls
            # to it (no 0-DTE buying), so its premium history must exist for
            # paper-trade resolution. Same file; consumers filter by expiry.
            if exps[0] == today and len(exps) > 1:
                try:
                    n2 = snapshot(dhan, name, meta, exps[1], args.range)
                    if n2:
                        log(f"  {name} {exps[1]} (next, expiry-day roll): +{n2} legs")
                except Exception as e:
                    log(f"  {name}: next-expiry snapshot error: {e}")
                time.sleep(RATE_LIMIT_SEC)
        if args.once:
            break
        time.sleep(POLL_SECONDS)

    log("=== Options collector done ===")


if __name__ == "__main__":
    main()
