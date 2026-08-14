"""
AlphaEdge  ->  Dhan (India)  local data bridge
==============================================

A browser cannot call api.dhan.co directly (CORS), so this service sits in
the middle as a pure DATA bridge for the AlphaEdge app:

    AlphaEdge (browser)  --GET/POST-->  this bridge  --HTTPS-->  Dhan API

It serves index quotes, historical candles, the option chain (with greeks/IV
and an off-hours CSV-snapshot fallback), India VIX, lot sizes, the NSE
holiday calendar, and the Obsidian wiki/monthly-export helpers.

AlphaEdge is decision-support + paper trading only: this bridge places NO
broker orders of any kind (the MT5 execution path was removed 2026-07 in the
Indian-options revamp).

HOW TO USE
----------
1. Run this bridge (double-click run.bat, or:  python bridge.py).
2. AlphaEdge -> Settings -> Local Data Bridge defaults to http://127.0.0.1:5000.
3. Dhan credentials auto-refresh from strategy-lab/dhan_config.json (TOTP).
"""

import json
import os
import pathlib
import re
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from dhanhq import DhanContext, dhanhq as _dhanhq
except ImportError:
    DhanContext = _dhanhq = None  # /dhan/* endpoints return a friendly error

import oi_metrics  # Trending-OI + premium series from the collected chain CSVs

# Optional Chronos inference. The bridge remains fully usable without the
# package; /ai/timing returns an explicit unavailable response instead.
try:
    import sys
    _strategy_lab = pathlib.Path(__file__).resolve().parent.parent / "strategy-lab"
    if str(_strategy_lab) not in sys.path:
        sys.path.insert(0, str(_strategy_lab))
    from chronos_timing import forecast_timing
except ImportError:
    forecast_timing = None


# ─── CONFIG — edit these to taste ─────────────────────────────────────────────
HOST = "127.0.0.1"
PORT = 5000

# Path to the Obsidian Trading_Mind wiki folder
WIKI_ROOT = pathlib.Path(r"E:\Obsidian\Trading_Mind\wiki")

# Where monthly trade rollups are written, one subfolder per app. The apps POST
# their built markdown to /obsidian/monthly and this bridge writes the file.
RAW_TRADES_ROOT = pathlib.Path(r"E:\Obsidian\Trading_Mind\raw\trades")
EXPORT_APPS = {"alphaedge", "intellitrade", "smart-money-trader", "tradingbrain"}

def get_prices():
    """Live Dhan index quotes (NIFTY50/BANKNIFTY/SENSEX/FINNIFTY + INDIAVIX)."""
    return dhan_index_quotes()


# Cache Dhan index quotes briefly (Dhan data API rate limit is ~5/sec; the app
# polls every several seconds, so a short cache avoids hammering the endpoint).
_DHAN_QUOTE_CACHE = {"ts": 0.0, "data": {}}
_DHAN_QUOTE_TTL = 3.0


def dhan_index_quotes():
    """Live LTP + %change for the Indian indices + India VIX via Dhan ohlc_data."""
    if _dhanhq is None:
        return {}
    now = time.time()
    if now - _DHAN_QUOTE_CACHE["ts"] < _DHAN_QUOTE_TTL:
        return _DHAN_QUOTE_CACHE["data"]
    token, client = _dhan_credentials({})
    if not token or not client:
        return {}
    # securityId -> app asset id
    id_map = {"13": "NIFTY50", "25": "BANKNIFTY", "51": "SENSEX", "27": "FINNIFTY", "21": "INDIAVIX"}
    out = {}
    try:
        dhan = _dhanhq(DhanContext(client, token))
        resp = dhan.ohlc_data({"IDX_I": [13, 25, 51, 27, 21]})
        node = (((resp or {}).get("data") or {}).get("data") or {}).get("IDX_I") or {}
        for sec_id, app_id in id_map.items():
            q = node.get(sec_id) or {}
            ltp = float(q.get("last_price") or 0)
            prev = float((q.get("ohlc") or {}).get("close") or 0)
            if ltp:
                out[app_id] = {
                    "price": ltp,
                    "change": round(((ltp - prev) / prev * 100.0) if prev else 0.0, 2),
                    "source": "Dhan",
                    "marketOpen": indian_market_open(),
                }
    except Exception:
        return _DHAN_QUOTE_CACHE["data"]  # serve stale on error
    _DHAN_QUOTE_CACHE["ts"] = now
    _DHAN_QUOTE_CACHE["data"] = out
    return out


def indian_market_open():
    """True if NSE/BSE cash session is live: Mon-Fri 09:15-15:30 IST,
    excluding trading holidays (Dhan holiday calendar, refreshed daily)."""
    from datetime import datetime as _dt, timezone, timedelta
    ist = _dt.now(timezone.utc).astimezone(timezone(timedelta(hours=5, minutes=30)))
    if ist.weekday() >= 5:  # Sat/Sun
        return False
    mins = ist.hour * 60 + ist.minute
    if not ((9 * 60 + 15) <= mins <= (15 * 60 + 30)):
        return False
    try:
        return is_indian_trading_day()
    except Exception:
        return True   # calendar trouble must never mark a live session closed


def _ist_now():
    from datetime import datetime as _dt, timezone, timedelta
    return _dt.now(timezone.utc).astimezone(timezone(timedelta(hours=5, minutes=30)))


def _ist_day(ts=None):
    from datetime import datetime as _dt, timezone, timedelta
    base = _dt.fromtimestamp(ts, tz=timezone.utc) if ts else _dt.now(timezone.utc)
    return base.astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d")


# ─── INDIAN MARKET CALENDAR + INTRADAY SQUARE-OFF ────────────────────────────
# NSE cash session (verified from Dhan M1 data): 09:15–15:30 IST, Mon–Fri.
# Rule: every Indian intraday position is CLOSED before 15:20 IST — new
# entries are blocked from 15:05, open Indian positions flattened at 15:15.
# Holidays are refreshed once per IST day from Dhan's public holiday page
# (only the TRADING-holiday table — clearing holidays are normal trading
# days), cached to disk, with a hardcoded 2026 fallback list.
IN_SQOFF_BLOCK_MIN   = 15 * 60 + 5    # 15:05 IST — no new Indian entries
IN_SQOFF_FLATTEN_MIN = 15 * 60 + 15   # 15:15 IST — flatten Indian positions
DHAN_HOLIDAY_URL = "https://dhan.co/market-holiday/"
HOLIDAY_CACHE_FILE = pathlib.Path(__file__).parent / "nse_holidays.json"
NSE_HOLIDAYS_2026_FALLBACK = [
    "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03",
    "2026-04-14", "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14",
    "2026-10-02", "2026-10-20", "2026-11-10", "2026-11-24", "2026-12-25",
]
_MONTHS3 = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
_HOLIDAY_MEM = {"day": None, "list": []}   # in-memory day cache (avoids file reads per quote)


def _fetch_dhan_holidays():
    """Parse trading-holiday dates ('26 Jan 2026' style) from Dhan's holiday
    page — only the section BEFORE the 'Clearing Holidays' table."""
    import urllib.request
    req = urllib.request.Request(DHAN_HOLIDAY_URL, headers={"User-Agent": "Mozilla/5.0 AlphaEdge"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", "replace")
    cut = re.search(r"Clearing\s+Holidays", html, re.I)
    section = html[:cut.start()] if cut else html
    out = set()
    for d, mon, y in re.findall(
            r"(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{4})", section):
        out.add(f"{int(y):04d}-{_MONTHS3[mon]:02d}-{int(d):02d}")
    return sorted(out)


def indian_holidays():
    """Trading-holiday list, refreshed once per IST day ('verify on first login')."""
    today = _ist_day()
    if _HOLIDAY_MEM["day"] == today and _HOLIDAY_MEM["list"]:
        return _HOLIDAY_MEM["list"]
    cache = {}
    try:
        cache = json.loads(HOLIDAY_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    holidays = None
    if cache.get("fetched") == today and cache.get("holidays"):
        holidays = cache["holidays"]
    else:
        try:
            fetched = _fetch_dhan_holidays()
            if fetched:
                holidays = fetched
                HOLIDAY_CACHE_FILE.write_text(
                    json.dumps({"fetched": today, "holidays": fetched}, indent=2), encoding="utf-8")
                print(f"  [NSE] holiday calendar refreshed from Dhan ({len(fetched)} dates)")
        except Exception as e:
            print(f"  [NSE] holiday fetch failed ({e}) — using cached/fallback list")
    if not holidays:
        holidays = cache.get("holidays") or NSE_HOLIDAYS_2026_FALLBACK
    _HOLIDAY_MEM["day"] = today
    _HOLIDAY_MEM["list"] = holidays
    return holidays


def is_indian_trading_day():
    return _ist_now().weekday() < 5 and _ist_day() not in set(indian_holidays())


def _is_indian_symbol(name):
    return bool(re.search(r"NIFTY|BANKNIFTY|SENSEX|BANKEX|FINNIFTY|MIDCP", str(name or "").upper()))


def _atm_iv_percentile(under_name, current_iv):
    """Best-effort IV percentile: where today's ATM IV sits vs the near-ATM IV
    we've collected in data/options/*.csv. Returns 0-100 or None if too little data."""
    try:
        import csv as _csv, glob as _glob
        ivs = []
        folder = pathlib.Path(__file__).parent.parent / "strategy-lab" / "data" / "options"
        for fp in _glob.glob(str(folder / f"{under_name}_OPT_*.csv")):
            with open(fp, newline="", encoding="utf-8") as f:
                for r in _csv.DictReader(f):
                    try:
                        ltp_u = float(r.get("under_ltp") or 0); sk = float(r.get("strike") or 0)
                        iv = float(r.get("iv") or 0)
                        if r.get("type") == "CE" and iv > 0 and ltp_u and abs(sk - ltp_u) <= ltp_u * 0.005:
                            ivs.append(iv)
                    except Exception:
                        continue
        if len(ivs) < 50 or not current_iv:
            return None
        below = sum(1 for v in ivs if v <= current_iv)
        return round(below / len(ivs) * 100, 0)
    except Exception:
        return None


def _optionchain_from_csv(under_name, rng):
    """Off-hours fallback: rebuild the chain from the most recent collected
    snapshot in data/options/*.csv so the strike selector works 24/7."""
    try:
        import csv as _csv, glob as _glob
        folder = pathlib.Path(__file__).parent.parent / "strategy-lab" / "data" / "options"
        files = sorted(_glob.glob(str(folder / f"{under_name}_OPT_*.csv")))
        if not files:
            return None
        rows = list(_csv.DictReader(open(files[-1], newline="", encoding="utf-8")))
        if not rows:
            return None
        last_ts = rows[-1]["time"]
        snap = [r for r in rows if r["time"] == last_ts]
        # Expiry-day files carry two expiries (front + next) — serve the front.
        _exps = sorted({r.get("expiry", "") for r in snap if r.get("expiry")})
        if len(_exps) > 1:
            snap = [r for r in snap if r.get("expiry") == _exps[0]]
        under = float(snap[0].get("under_ltp") or 0)
        expiry = snap[0].get("expiry", "")
        by_strike = {}
        for r in snap:
            sk = float(r.get("strike") or 0)
            leg = {"ltp": float(r.get("ltp") or 0), "oi": float(r.get("oi") or 0),
                   "volume": float(r.get("volume") or 0),
                   "iv": round(float(r.get("iv") or 0), 2), "delta": round(float(r.get("delta") or 0), 3),
                   "theta": round(float(r.get("theta") or 0), 2),
                   "bid": round(float(r.get("bid") or 0), 2), "ask": round(float(r.get("ask") or 0), 2)}
            by_strike.setdefault(sk, {})[r.get("type", "").lower()] = leg
        sks = sorted(by_strike.keys())
        if not sks or not under:
            return None
        atm = min(sks, key=lambda s: abs(s - under))
        ai = sks.index(atm)
        sel = sks[max(0, ai - rng):min(len(sks), ai + rng + 1)]
        out = [{"strike": round(s, 2), "atm": s == atm,
                "ce": by_strike[s].get("ce", {"ltp":0,"oi":0,"volume":0,"iv":0,"delta":0,"theta":0}),
                "pe": by_strike[s].get("pe", {"ltp":0,"oi":0,"volume":0,"iv":0,"delta":0,"theta":0})} for s in sel]
        return {"ok": True, "underlying": under_name, "under_ltp": round(under, 2), "expiry": expiry,
                "isExpiryToday": False, "atmStrike": atm,
                "ivPercentile": _atm_iv_percentile(under_name, by_strike[atm].get("ce", {}).get("iv", 0)),
                "strikes": out, "stale": True, "snapshotTime": last_ts}
    except Exception:
        return None


# In-memory option-chain cache. Dhan's chain endpoint is rate-limited (~1 req/3s),
# so cache each (underlying, expiry) response for 45s. The app, the score scanner
# and the paper-trade tracker can then all poll freely without hammering Dhan.
_CHAIN_CACHE = {}   # (underlying, expiry|"") -> {"ts": float, "data": {...}}
_CHAIN_TTL = 45.0


def dhan_optionchain(req):
    """Live option chain (ATM +/- range) with greeks/IV for the strike selector.
    Accepts an optional `expiry` (else nearest) and returns the full `expiries`
    list so the app can offer weekly-vs-monthly selection. Falls back to the last
    collected snapshot when the market is closed. 45s in-memory cache."""
    under_name = req.get("underlying", "")
    rng = int(req.get("range", 6))
    want_expiry = str(req.get("expiry") or "")

    cache_key = (under_name, want_expiry)
    hit = _CHAIN_CACHE.get(cache_key)
    if hit and (time.time() - hit["ts"] < _CHAIN_TTL):
        return hit["data"]

    if _dhanhq is None:
        return {"ok": False, "error": "dhanhq not installed on bridge host"}
    token, client = _dhan_credentials(req)
    if not token or not client:
        return {"ok": False, "error": "missing Dhan token/clientId"}
    meta = DHAN_INSTRUMENTS.get(under_name)
    if not meta:
        return {"ok": False, "error": f"unknown underlying '{under_name}'"}
    try:
        dhan = _dhanhq(DhanContext(client, token))
        sid = int(meta["security_id"]); seg = meta["segment"]
        el = dhan.expiry_list(sid, seg)
        eld = (el.get("data") or {}).get("data") or el.get("data") or []
        if isinstance(eld, dict):
            eld = eld.get("data") or []
        if not eld:
            fb = _optionchain_from_csv(under_name, rng)
            return fb if fb else {"ok": False, "error": "no expiries (market closed?) and no saved snapshot"}
        import datetime as _dt
        today = _dt.datetime.now(_dt.timezone.utc).astimezone(_dt.timezone(_dt.timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d")
        expiries = [str(e) for e in eld]
        if want_expiry and want_expiry in expiries:
            expiry = want_expiry
        else:
            expiry = next((e for e in expiries if e >= today), expiries[0])
        time.sleep(0.3)
        oc = dhan.option_chain(sid, seg, expiry)
        d = oc.get("data", oc)
        if isinstance(d, dict) and isinstance(d.get("data"), dict):
            d = d["data"]
        under = float(d.get("last_price") or 0)
        ocmap = d.get("oc") or {}
        if not ocmap or not under:
            fb = _optionchain_from_csv(under_name, rng)
            return fb if fb else {"ok": False, "error": "empty option chain"}
        strikes = sorted(ocmap.keys(), key=lambda s: float(s))
        floats = [float(s) for s in strikes]
        atm_i = min(range(len(floats)), key=lambda i: abs(floats[i] - under))
        lo, hi = max(0, atm_i - rng), min(len(strikes), atm_i + rng + 1)
        rows = []
        for sk in strikes[lo:hi]:
            node = ocmap[sk]
            def leg(t):
                x = node.get(t) or {}
                g = x.get("greeks") or {}
                return {"ltp": x.get("last_price", 0), "oi": x.get("oi", 0),
                        "volume": x.get("volume", x.get("total_traded_volume", 0)),
                        "iv": round(float(x.get("implied_volatility") or 0), 2),
                        "delta": round(float(g.get("delta") or 0), 3),
                        "theta": round(float(g.get("theta") or 0), 2),
                        "bid": round(float(x.get("top_bid_price") or x.get("bid_price") or 0), 2),
                        "ask": round(float(x.get("top_ask_price") or x.get("ask_price") or 0), 2)}
            rows.append({"strike": round(float(sk), 2), "atm": float(sk) == floats[atm_i],
                         "ce": leg("ce"), "pe": leg("pe")})
        atm_ce_iv = next((r["ce"]["iv"] for r in rows if r["atm"]), 0)
        result = {"ok": True, "underlying": under_name, "under_ltp": round(under, 2),
                  "expiry": expiry, "isExpiryToday": str(expiry) == today,
                  "expiries": expiries,
                  "atmStrike": floats[atm_i], "ivPercentile": _atm_iv_percentile(under_name, atm_ce_iv),
                  "strikes": rows}
        _CHAIN_CACHE[cache_key] = {"ts": time.time(), "data": result}
        return result
    except Exception as e:
        fb = _optionchain_from_csv(under_name, rng)
        return fb if fb else {"ok": False, "error": f"option chain failed: {e}"}


def get_wiki_page(slug):
    """
    Read a single wiki markdown file by slug.
    slug examples: "strategies/golden-setup", "concepts/support-resistance"
    Returns {"slug": ..., "content": ...} or {"error": ...}.
    """
    if not WIKI_ROOT.exists():
        return {"error": f"Wiki root not found: {WIKI_ROOT}"}
    # Sanitise: no path traversal
    safe = slug.replace("..", "").strip("/").replace("\\", "/")
    path = WIKI_ROOT / (safe + ".md") if not safe.endswith(".md") else WIKI_ROOT / safe
    if not path.resolve().is_relative_to(WIKI_ROOT.resolve()):
        return {"error": "invalid path"}
    if not path.exists():
        return {"error": f"page not found: {safe}"}
    return {"slug": safe, "content": path.read_text(encoding="utf-8")}


def get_wiki_index():
    """
    Return a flat list of all wiki pages grouped by subfolder.
    """
    if not WIKI_ROOT.exists():
        return {"error": f"Wiki root not found: {WIKI_ROOT}"}
    index = {}
    for md in sorted(WIKI_ROOT.rglob("*.md")):
        rel = md.relative_to(WIKI_ROOT).as_posix().removesuffix(".md")
        parts = rel.split("/")
        folder = parts[0] if len(parts) > 1 else "root"
        index.setdefault(folder, []).append(rel)
    return {"wiki_root": str(WIKI_ROOT), "pages": index}


def get_wiki_context(asset_id, strategy):
    """
    Build a combined context string from relevant wiki pages for the given
    asset and strategy. AlphaEdge calls this before every AI analysis.
    """
    pages_to_load = []

    # Always include the overview (thesis + market regime)
    pages_to_load.append("overview")

    # Strategy-specific pages
    strategy_map = {
        "ict":          ["strategies/golden-setup"],
        "eagle_eye":    ["strategies/golden-setup", "strategies/9-20-ema-pullback"],
        "ema_9_20":     ["strategies/9-20-ema-pullback", "strategies/pullback-to-ema"],
        "golden_setup": ["strategies/golden-setup"],
        "choch":        [],
        "smc":          [],
    }
    for key, pages in strategy_map.items():
        if key in (strategy or "").lower():
            pages_to_load.extend(pages)
            break

    # Asset-specific pages
    asset_page_map = {
        "BTCUSD":  "instruments/btcusd",
        "XAUUSD":  "instruments/xauusd",
        "ETHUSD":  "instruments/ethusd",
        "NIFTY50": "instruments/nifty50",
    }
    if asset_id in asset_page_map:
        pages_to_load.append(asset_page_map[asset_id])

    # Core concept pages always useful
    pages_to_load += [
        "concepts/four-quadrants-of-trading",
        "concepts/support-resistance",
    ]

    sections = []
    seen = set()
    for slug in pages_to_load:
        if slug in seen:
            continue
        seen.add(slug)
        result = get_wiki_page(slug)
        if "content" in result:
            sections.append(f"## [{slug}]\n{result['content']}")

    return "\n\n---\n\n".join(sections) if sections else ""


# ─── DHAN HISTORICAL DATA (proxied for the browser to avoid CORS) ─────────────
# The browser can't call api.dhan.co directly (CORS). It POSTs to this local
# bridge instead, which calls Dhan server-side via the official SDK.
DHAN_INSTRUMENTS = {
    "NIFTY50":   {"security_id": "13", "segment": "IDX_I", "instrument": "INDEX"},
    "BANKNIFTY": {"security_id": "25", "segment": "IDX_I", "instrument": "INDEX"},
    "SENSEX":    {"security_id": "51", "segment": "IDX_I", "instrument": "INDEX"},
    "FINNIFTY":  {"security_id": "27", "segment": "IDX_I", "instrument": "INDEX"},
}
DHAN_TF_INTERVAL = {"1m": 1, "5m": 5, "15m": 15, "1H": 60}
# Use the strategy-lab config — it auto-refreshes the 24h token daily via TOTP.
# Falls back to a local bridge copy if the strategy-lab one isn't present.
DHAN_CONFIG_FILE = pathlib.Path(__file__).parent.parent / "strategy-lab" / "dhan_config.json"
if not DHAN_CONFIG_FILE.exists():
    DHAN_CONFIG_FILE = pathlib.Path(__file__).parent / "dhan_config.json"

# Resolve the current tradable MONTHLY INDEX FUTURES (auto-rolling) so the
# browser backtester pulls FUTURES — matching the strategy-lab pipeline.
import sys as _sys
_sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "strategy-lab"))
try:
    from dhan_futures import current_futures as _current_futures
except Exception:
    _current_futures = None

_FUT_CACHE = {"date": None, "data": {}}
def _futures_map():
    """Cached map of pipeline-symbol -> current futures contract (refresh daily)."""
    import datetime as _dt
    today = _dt.date.today().isoformat()
    if _FUT_CACHE["date"] != today or not _FUT_CACHE["data"]:
        try:
            _FUT_CACHE["data"] = _current_futures() if _current_futures else {}
            _FUT_CACHE["date"] = today
        except Exception:
            pass
    return _FUT_CACHE["data"]


def _dhan_credentials(req):
    """Token + client id. PREFER the auto-refreshed config file (valid 24h via
    TOTP) over the browser-sent token, which is pasted manually and goes stale.
    Read fresh from disk every call so a daily token refresh is picked up."""
    token = client = ""
    if DHAN_CONFIG_FILE.exists():
        try:
            cfg = json.loads(DHAN_CONFIG_FILE.read_text(encoding="utf-8"))
            token  = str(cfg.get("access_token", "")).strip()
            client = str(cfg.get("client_id", "")).strip()
        except Exception:
            pass
    # Fall back to whatever the browser sent only if the config is missing/empty.
    if not token or token.startswith("PASTE_"):
        token = (req.get("token") or "").strip()
    if not client:
        client = (req.get("clientId") or "").strip()
    return token, client


def dhan_profile(req):
    """Validate the Dhan token via GET /v2/profile and return validity + data plan."""
    token, client = _dhan_credentials(req)
    if not token or not client:
        return {"ok": False, "error": "missing Dhan token/clientId"}
    try:
        import urllib.request as _u, urllib.error as _ue
        r = _u.Request("https://api.dhan.co/v2/profile", method="GET")
        r.add_header("access-token", token)
        r.add_header("client-id", client)
        r.add_header("Accept", "application/json")
        with _u.urlopen(r, timeout=20) as resp:
            prof = json.loads(resp.read().decode())
        return {"ok": True,
                "tokenValidity": prof.get("tokenValidity"),
                "dataPlan":      prof.get("dataPlan"),
                "dataValidity":  prof.get("dataValidity"),
                "activeSegment": prof.get("activeSegment")}
    except _ue.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:200]
        return {"ok": False, "error": f"Dhan rejected token (HTTP {e.code}): {body}"}
    except Exception as e:
        return {"ok": False, "error": f"profile check failed: {e}"}


def dhan_historical(req):
    """Fetch historical candles from Dhan and return them to the browser."""
    if _dhanhq is None:
        return {"ok": False, "error": "dhanhq not installed on bridge host — run: pip install dhanhq"}
    token, client = _dhan_credentials(req)
    if not token or not client:
        return {"ok": False, "error": "missing Dhan token/clientId"}

    inst = req.get("instrument", "")
    # Default to the current FUTURES contract (tradable, auto-rolling); fall back
    # to spot only if futures can't be resolved or futures=False is requested.
    meta = None
    if req.get("futures", True):
        meta = _futures_map().get(inst)
    if not meta:
        meta = DHAN_INSTRUMENTS.get(inst)
    if not meta:
        return {"ok": False, "error": f"unknown instrument '{inst}'"}

    tf = req.get("tf", "5m")
    from_date = req.get("fromDate")
    to_date   = req.get("toDate")
    try:
        ctx  = DhanContext(client, token)
        dhan = _dhanhq(ctx)
        if tf == "1D":
            resp = dhan.historical_daily_data(
                security_id=meta["security_id"], exchange_segment=meta["segment"],
                instrument_type=meta["instrument"], from_date=from_date, to_date=to_date)
        else:
            resp = dhan.intraday_minute_data(
                security_id=meta["security_id"], exchange_segment=meta["segment"],
                instrument_type=meta["instrument"], from_date=from_date, to_date=to_date,
                interval=DHAN_TF_INTERVAL.get(tf, 5))
    except Exception as e:
        return {"ok": False, "error": f"Dhan call failed: {e}"}

    if isinstance(resp, dict) and resp.get("status") == "failure":
        return {"ok": False, "error": f"Dhan API: {resp.get('remarks')}"}
    data = resp.get("data", resp) if isinstance(resp, dict) else {}
    o, h, l = data.get("open") or [], data.get("high") or [], data.get("low") or []
    c, v, t = data.get("close") or [], data.get("volume") or [], data.get("timestamp") or []
    n = min(len(o), len(h), len(l), len(c), len(t))
    candles = [{
        "time": float(t[i]), "open": o[i], "high": h[i],
        "low": l[i], "close": c[i], "volume": (v[i] if i < len(v) else 0) or 0,
    } for i in range(n)]
    return {"ok": True, "instrument": inst, "tf": tf, "candles": candles,
            "contract": meta.get("display") or ("FUTURES" if meta.get("instrument")=="FUTIDX" else "SPOT"),
            "is_futures": meta.get("instrument") == "FUTIDX"}


def write_monthly_export(body):
    """Write an app's monthly trade rollup to
    E:\\Obsidian\\Trading_Mind\\raw\\trades\\<app>\\<YYYY-MM>.md

    The browser app builds the markdown (it knows its own trade shape) and POSTs
    {app, month, markdown}; we only validate and write. `app` is checked against
    a whitelist and `month` against YYYY-MM so the path can't escape the folder.
    """
    app      = str(body.get("app", "")).strip().lower()
    month    = str(body.get("month", "")).strip()
    markdown = body.get("markdown", "")

    if app not in EXPORT_APPS:
        return {"ok": False, "error": f"unknown app '{app}' (allowed: {sorted(EXPORT_APPS)})"}
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        return {"ok": False, "error": "month must be 'YYYY-MM'"}
    if not isinstance(markdown, str) or not markdown.strip():
        return {"ok": False, "error": "empty markdown"}

    try:
        folder = RAW_TRADES_ROOT / app
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{month}.md"
        path.write_text(markdown, encoding="utf-8")
        print(f"  [obsidian] wrote {app}/{month}.md ({len(markdown.encode('utf-8'))} bytes)")
        return {"ok": True, "path": str(path), "bytes": len(markdown.encode("utf-8"))}
    except OSError as exc:
        return {"ok": False, "error": f"write failed: {exc}"}


# Dhan's public scrip master (per-instrument lot sizes). Index F&O lot sizes are
# revised periodically; the browser pulls the current values via this endpoint.
DHAN_SCRIP_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master.csv"
_INDEX_UNDERLYINGS = {
    "NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "MIDCPNIFTY", "BANKEX",
    "NIFTYNXT50", "SENSEX50",
}


def fetch_lot_sizes():
    """Download the Dhan scrip master and return current index option lot sizes
    ({'NIFTY': 65, 'BANKNIFTY': 30, ...}). Lot size is per-underlying, so the
    first OPTIDX row for each index is enough."""
    import csv
    import io
    import urllib.request

    try:
        req = urllib.request.Request(DHAN_SCRIP_MASTER_URL, headers={"User-Agent": "AlphaEdge"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - surface any download failure
        return {"ok": False, "error": f"scrip master download failed: {exc}"}

    lots = {}
    for row in csv.DictReader(io.StringIO(text)):
        if (row.get("SEM_INSTRUMENT_NAME") or "").strip().upper() != "OPTIDX":
            continue
        under = (row.get("SEM_TRADING_SYMBOL") or "").strip().upper().split("-")[0]
        if under not in _INDEX_UNDERLYINGS or under in lots:
            continue
        try:
            lot = int(float(row.get("SEM_LOT_UNITS") or 0))
        except ValueError:
            continue
        if lot > 0:
            lots[under] = lot
    if not lots:
        return {"ok": False, "error": "no OPTIDX lot sizes found in scrip master"}
    return {"ok": True, "lots": lots, "updated": time.strftime("%Y-%m-%dT%H:%M:%S")}


# ─── INDIA VIX ─────────────────────────────────────────────────────────────────
# Live India VIX (Dhan IDX_I security 21) with a collected-ATM-IV percentile
# proxy as fallback so the score engine can still reason about vol off-hours.
def rd_replay():
    """Serve the latest options-premium score replay (scripts/replay.mjs output)
    for the R&D page. Read-only — the browser can't touch strategy-lab/results."""
    fp = pathlib.Path(__file__).parent.parent / "strategy-lab" / "results" / "replay_latest.json"
    try:
        if not fp.exists():
            return {"ok": False, "error": "no replay yet — run: node scripts/replay.mjs"}
        data = json.loads(fp.read_text(encoding="utf-8"))
        return {"ok": True, **data}
    except Exception as e:
        return {"ok": False, "error": f"replay read failed: {e}"}


def paper_auto():
    """Serve the headless scanner's paper-trade track record
    (scripts/scanner.mjs output) for the app's Paper Trades page. Read-only —
    the browser can't touch strategy-lab/paper; the scanner is the only writer."""
    fp = pathlib.Path(__file__).parent.parent / "strategy-lab" / "paper" / "auto_paper_trades.json"
    try:
        if not fp.exists():
            return {"ok": True, "trades": [], "summary": {}, "note": "scanner not run yet — start scripts/scanner.mjs"}
        data = json.loads(fp.read_text(encoding="utf-8"))
        return {"ok": True, **data}
    except Exception as e:
        return {"ok": False, "error": f"auto paper read failed: {e}"}


_ECON_CAL_CACHE = {"at": 0.0, "data": None}
def econ_calendar():
    """Live economic calendar (Forex Factory weekly JSON) fetched server-side so
    the browser skips the flaky CORS-proxy chain. Covers global/US high-impact
    events that move Nifty via FII flows (Forex Factory carries no India/INR
    events). Cached ~30 min; serves stale cache if a refresh fails."""
    import urllib.request
    now = time.time()
    c = _ECON_CAL_CACHE
    if c["data"] and (now - c["at"] < 1800):
        return c["data"]
    events = []
    for url in ("https://nfs.faireconomy.media/ff_calendar_thisweek.json",):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 AlphaEdge"})
            with urllib.request.urlopen(req, timeout=12) as resp:
                arr = json.loads(resp.read().decode("utf-8"))
        except Exception:
            continue
        for it in arr:
            if not it.get("date") or not it.get("title"):
                continue
            imp = str(it.get("impact", "")).lower()
            events.append({
                "id":       f"ff{len(events)}",
                "datetime": it["date"],                 # ISO 8601 with UTC offset
                "title":    it["title"],
                "currency": it.get("country", ""),      # FF "country" is already a currency code
                "impact":   "high" if imp == "high" else "medium" if imp == "medium" else "low",
                "forecast": it.get("forecast") or "",
                "previous": it.get("previous") or "",
                "actual":   it.get("actual") or None,
            })
    if not events:
        return c["data"] or {"ok": False, "error": "calendar feed unreachable"}
    events.sort(key=lambda e: e["datetime"])
    data = {"ok": True, "events": events, "source": "forexfactory", "asOf": _ist_now().isoformat()}
    c["at"], c["data"] = now, data
    return data


def dhan_vix():
    quotes = dhan_index_quotes()
    vix = quotes.get("INDIAVIX") or {}
    # Proxy: percentile of the latest collected NIFTY ATM IV vs its history —
    # lets the score engine reason about vol even when the VIX quote is down.
    proxy_ivp = None
    try:
        snap = _optionchain_from_csv("NIFTY50", 1)
        if snap:
            proxy_ivp = snap.get("ivPercentile")
    except Exception:
        pass
    if vix.get("price"):
        return {"ok": True, "source": "dhan",
                "vix": {"ltp": vix["price"], "changePct": vix.get("change", 0.0),
                        "updatedAt": _ist_now().isoformat()},
                "proxy": {"ivPercentile": proxy_ivp, "underlying": "NIFTY50"}}
    return {"ok": proxy_ivp is not None, "source": "proxy",
            "error": None if proxy_ivp is not None else "VIX quote unavailable and no collected IV history",
            "proxy": {"ivPercentile": proxy_ivp, "underlying": "NIFTY50"}}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            # Client (browser) closed the connection before we finished — e.g. a
            # fetch timeout or page reload. Harmless; ignore quietly.
            pass

    def do_OPTIONS(self):  # CORS preflight from the browser
        self._send(204, {})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs     = urllib.parse.parse_qs(parsed.query)

        if parsed.path.startswith("/price"):
            self._send(200, get_prices())
        elif parsed.path.startswith("/dhan/lotsizes"):
            self._send(200, fetch_lot_sizes())
        elif parsed.path.startswith("/dhan/vix"):
            self._send(200, dhan_vix())
        elif parsed.path.startswith("/rd/replay"):
            self._send(200, rd_replay())
        elif parsed.path.startswith("/paper/auto"):
            self._send(200, paper_auto())
        elif parsed.path.startswith("/calendar"):
            self._send(200, econ_calendar())
        elif parsed.path.startswith("/market/holiday"):
            today = _ist_day()
            hols = indian_holidays()
            self._send(200, {"ok": True, "today": today, "isHoliday": today in set(hols),
                             "tradingDay": is_indian_trading_day(),
                             "squareOff": {"blockFrom": "15:05", "flattenAt": "15:15", "close": "15:30"},
                             "holidays": hols})
        elif parsed.path == "/wiki/index":
            self._send(200, get_wiki_index())
        elif parsed.path == "/wiki/context":
            asset    = qs.get("asset",    [""])[0]
            strategy = qs.get("strategy", [""])[0]
            context  = get_wiki_context(asset, strategy)
            self._send(200, {"ok": True, "context": context, "asset": asset, "strategy": strategy})
        elif parsed.path.startswith("/wiki/page/"):
            slug = parsed.path.removeprefix("/wiki/page/")
            self._send(200, get_wiki_page(urllib.parse.unquote(slug)))
        else:
            self._send(200, {"ok": True, "service": "AlphaEdge Dhan/India data bridge", "ordersEnabled": False})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"ok": False, "error": "invalid JSON"})
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/dhan/historical"):
            result = dhan_historical(body)
            self._send(200 if result.get("ok") else 400, result)
            return
        if parsed.path.startswith("/dhan/profile"):
            result = dhan_profile(body)
            self._send(200 if result.get("ok") else 400, result)
            return
        if parsed.path.startswith("/dhan/optionchain"):
            result = dhan_optionchain(body)
            self._send(200 if result.get("ok") else 400, result)
            return
        if parsed.path.startswith("/dhan/oitrend"):
            result = oi_metrics.build_oitrend(
                body.get("underlying", ""),
                bucket_min=int(body.get("bucketMin", 5)),
            )
            self._send(200 if result.get("ok") else 400, result)
            return
        if parsed.path.startswith("/dhan/premium"):
            result = oi_metrics.build_premium_series(
                body.get("underlying", ""), body.get("strike"), body.get("type"),
                expiry=body.get("expiry"), since_ts=body.get("sinceTs"),
            )
            self._send(200 if result.get("ok") else 400, result)
            return
        if parsed.path.startswith("/ai/timing"):
            result = forecast_timing(body) if forecast_timing else {
                "ok": False, "shadowOnly": True, "model": "chronos-2",
                "error": "Chronos timing module unavailable",
            }
            self._send(200, result)
            return
        if parsed.path.startswith("/obsidian/monthly"):
            result = write_monthly_export(body)
            self._send(200 if result.get("ok") else 400, result)
            return
        self._send(404, {"ok": False, "error": "Unknown endpoint. This bridge is a Dhan data service - it places no orders."})

    def log_message(self, *args):  # silence default per-request logging
        pass


def main():
    print("=" * 60)
    print("  AlphaEdge  ->  Dhan (India) data bridge - NO broker orders")
    print("=" * 60)
    if _dhanhq is None:
        print("  WARNING: dhanhq not installed - /dhan/* endpoints will fail.")
        print("           Run:  pip install dhanhq")
    # Warm the index-futures cache so the first browser backtest is instant.
    try:
        fm = _futures_map()
        if fm:
            print("  Index futures: " + ", ".join(f"{k}={v['display'].strip()}" for k, v in fm.items()))
    except Exception:
        pass
    wiki_ok = WIKI_ROOT.exists()
    print(f"  Obsidian wiki: {'found at ' + str(WIKI_ROOT) if wiki_ok else 'NOT FOUND at ' + str(WIKI_ROOT)}")
    print(f"  Listening on http://{HOST}:{PORT}  (quotes, candles, option chain, VIX, holidays)")
    print("  Press Ctrl+C to stop.")
    print("=" * 60)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping bridge.")


if __name__ == "__main__":
    main()
