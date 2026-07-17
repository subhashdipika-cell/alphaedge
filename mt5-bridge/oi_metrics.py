"""
oi_metrics.py - Trending-OI + premium series from the collected option-chain CSVs
=================================================================================

The options collector (strategy-lab/dhan_options_collector.py) snapshots the ATM
+/- N option chain once a minute into data/options/{UNDERLYING}_OPT_{IST-date}.csv
with columns:

  time, underlying, under_ltp, expiry, strike, type, ltp, oi, prev_oi, iv,
  volume, delta, theta, vega, bid, ask

`time` is UTC (the collector writes datetime.now(timezone.utc)); the filename date
is IST. This module is a THIN transformer: it turns those rows into a downsampled
per-strike TIME SERIES. All the derived analytics (velocity, acceleration, walls,
centroids, writing/unwinding strength, confirmation matrix, smart-money bias) live
in the frontend engine (src/engines/oi.js) so the same JS is reused by the R&D
replay script. Keeping the math in one place avoids Python/JS drift.

Pure standard library (csv, glob, datetime) - no pandas. Unit-testable in isolation.
"""

import csv
import glob
import os
import pathlib
from datetime import datetime, timezone, timedelta

_IST = timezone(timedelta(hours=5, minutes=30))
_OPTIONS_DIR = pathlib.Path(__file__).parent.parent / "strategy-lab" / "data" / "options"


def _ist_today():
    return datetime.now(_IST).strftime("%Y-%m-%d")


def _to_ist_hhmm(utc_str):
    """'2026-07-14 03:45:35' (UTC) -> '09:15' (IST)."""
    try:
        dt = datetime.strptime(utc_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        return dt.astimezone(_IST).strftime("%H:%M")
    except Exception:
        return utc_str[-8:-3]


def _latest_file(underlying):
    """Return (path, date_str, is_today) for the newest CSV of this underlying, or
    (None, None, False) if none exist."""
    files = sorted(glob.glob(str(_OPTIONS_DIR / f"{underlying}_OPT_*.csv")))
    if not files:
        return None, None, False
    path = files[-1]
    date_str = os.path.basename(path).replace(f"{underlying}_OPT_", "").replace(".csv", "")
    return path, date_str, (date_str == _ist_today())


def _read_rows(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _num(v, cast=float, default=0):
    try:
        return cast(v)
    except (TypeError, ValueError):
        return default


def build_oitrend(underlying, bucket_min=5, max_points=80):
    """Downsampled per-strike OI/LTP/IV/volume time series for one underlying.

    Returns a JSON-able dict; the frontend oi.js engine derives velocity,
    acceleration, walls, centroids, matrix and smart-money bias from it.
    """
    path, date_str, is_today = _latest_file(underlying)
    if not path:
        return {"ok": False, "error": f"no collected option-chain CSV for {underlying}"}

    rows = _read_rows(path)
    if not rows:
        return {"ok": False, "error": "CSV is empty"}

    # Expiry-day files carry TWO expiries (the expiring front chain + the next
    # one the scoring stack rolls to). OI analysis targets the FRONT expiry —
    # mixing both would double-count per-strike OI.
    _exps = sorted({r.get("expiry", "") for r in rows if r.get("expiry")})
    if len(_exps) > 1:
        rows = [r for r in rows if r.get("expiry") == _exps[0]]

    # Group rows by snapshot timestamp (preserve first-seen order = chronological).
    snaps = {}
    order = []
    for r in rows:
        t = r.get("time")
        if t not in snaps:
            snaps[t] = []
            order.append(t)
        snaps[t].append(r)

    # Downsample: keep the LAST snapshot within each bucket_min window (IST minutes).
    def bucket_key(utc_str):
        try:
            dt = datetime.strptime(utc_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).astimezone(_IST)
            m = (dt.hour * 60 + dt.minute) // bucket_min
            return m
        except Exception:
            return utc_str

    kept = {}
    for t in order:
        kept[bucket_key(t)] = t          # later timestamp in the bucket overwrites
    kept_ts = [kept[k] for k in kept]     # dict preserves insertion (chronological) order
    if len(kept_ts) > max_points:
        kept_ts = kept_ts[-max_points:]   # keep the most recent window

    # Assemble per-strike aligned arrays across the kept snapshots.
    expiry = rows[0].get("expiry", "")
    times, under_ltp = [], []
    # strike -> {"ce": {oi:[...], ...}, "pe": {...}, "prevOiCe":.., "prevOiPe":..}
    strikes = {}

    def leg_slot():
        return {"oi": [], "ltp": [], "iv": [], "vol": [], "delta": None, "prevOi": None}

    for t in kept_ts:
        snap = snaps[t]
        times.append(_to_ist_hhmm(t))
        under_ltp.append(round(_num(snap[0].get("under_ltp")), 2))
        # index this snapshot's legs by (strike, type)
        by_key = {}
        for r in snap:
            sk = round(_num(r.get("strike")), 2)
            by_key[(sk, r.get("type"))] = r
            if sk not in strikes:
                strikes[sk] = {"ce": leg_slot(), "pe": leg_slot()}
        # append aligned values for every strike we've ever seen
        for sk, legs in strikes.items():
            for typ, key in (("CE", "ce"), ("PE", "pe")):
                r = by_key.get((sk, typ))
                slot = legs[key]
                if r:
                    slot["oi"].append(int(_num(r.get("oi"), int, 0)))
                    slot["ltp"].append(round(_num(r.get("ltp")), 2))
                    slot["iv"].append(round(_num(r.get("iv")), 2))
                    slot["vol"].append(int(_num(r.get("volume"), int, 0)))
                    slot["delta"] = round(_num(r.get("delta")), 3)
                    slot["prevOi"] = int(_num(r.get("prev_oi"), int, 0))
                else:
                    # carry-forward gap fill keeps arrays aligned to `times`
                    slot["oi"].append(slot["oi"][-1] if slot["oi"] else 0)
                    slot["ltp"].append(slot["ltp"][-1] if slot["ltp"] else 0)
                    slot["iv"].append(slot["iv"][-1] if slot["iv"] else 0)
                    slot["vol"].append(slot["vol"][-1] if slot["vol"] else 0)

    last_under = under_ltp[-1] if under_ltp else 0
    sorted_sks = sorted(strikes.keys())
    atm = min(sorted_sks, key=lambda s: abs(s - last_under)) if (sorted_sks and last_under) else None

    strike_out = [{
        "strike": sk,
        "atm": sk == atm,
        "ce": strikes[sk]["ce"],
        "pe": strikes[sk]["pe"],
    } for sk in sorted_sks]

    return {
        "ok": True,
        "underlying": underlying,
        "expiry": expiry,
        "asOf": _to_ist_hhmm(kept_ts[-1]) if kept_ts else None,
        "date": date_str,
        "marketOpen": is_today and _market_open_now(),
        "source": "live-csv" if is_today else "stale-csv",
        "bucketMin": bucket_min,
        "atmStrike": atm,
        "times": times,
        "underLtp": under_ltp,
        "strikes": strike_out,
    }


def build_premium_series(underlying, strike, opt_type, expiry=None, since_ts=None):
    """Minute-level premium path for one option leg (SL/target-touch resolution).

    Returns {ok, leg, series:[{t, ltp, bid, ask, iv, oi, delta, theta}], high, low, last}.
    `since_ts` filters to rows at/after that 'YYYY-MM-DD HH:MM:SS' UTC timestamp.
    """
    path, _date, _is_today = _latest_file(underlying)
    if not path:
        return {"ok": False, "error": f"no collected option-chain CSV for {underlying}"}
    sk = round(_num(strike), 2)
    typ = str(opt_type or "").upper()
    series = []
    for r in _read_rows(path):
        if round(_num(r.get("strike")), 2) != sk or r.get("type") != typ:
            continue
        if expiry and r.get("expiry") != expiry:
            continue
        if since_ts and r.get("time", "") < since_ts:
            continue
        series.append({
            "t": _to_ist_hhmm(r.get("time")),
            "ltp": round(_num(r.get("ltp")), 2),
            "bid": round(_num(r.get("bid")), 2),
            "ask": round(_num(r.get("ask")), 2),
            "iv": round(_num(r.get("iv")), 2),
            "oi": int(_num(r.get("oi"), int, 0)),
            "delta": round(_num(r.get("delta")), 3),
            "theta": round(_num(r.get("theta")), 2),
        })
    if not series:
        return {"ok": False, "error": "no rows for that strike/type/expiry"}
    ltps = [p["ltp"] for p in series]
    return {
        "ok": True,
        "leg": f"{underlying} {int(sk)}{typ} {expiry or ''}".strip(),
        "series": series,
        "high": max(ltps),
        "low": min(ltps),
        "last": ltps[-1],
    }


def _market_open_now():
    ist = datetime.now(_IST)
    if ist.weekday() >= 5:
        return False
    mins = ist.hour * 60 + ist.minute
    return (9 * 60 + 15) <= mins <= (15 * 60 + 30)
