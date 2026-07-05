"""
AlphaEdge  ->  MetaTrader 5  local bridge
============================================

A browser cannot talk to the MetaTrader 5 terminal directly, so this little
program sits in the middle:

    AlphaEdge (browser)  --POST signal-->  this bridge  --order_send-->  MT5 terminal

HOW TO USE
----------
1. Make sure your MT5 terminal is OPEN and logged into a working account.
2. In MT5: Tools -> Options -> Expert Advisors -> tick "Allow algorithmic trading".
3. Run this bridge (double-click run.bat, or:  python bridge.py).
4. In AlphaEdge -> Settings -> MT5 Terminal, set the
   "Bridge / API URL" field to:   http://localhost:5000/signal
5. IMPORTANT: this starts in DRY-RUN mode (it only logs what it *would* do).
   When you are happy it works, set  DRY_RUN = False  below to place real orders.

Requires the official package:   pip install MetaTrader5
(Windows only — that is where the MT5 terminal runs.)
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
    import MetaTrader5 as mt5
except ImportError:
    mt5 = None  # handled at startup with a friendly message

try:
    from dhanhq import DhanContext, dhanhq as _dhanhq
except ImportError:
    DhanContext = _dhanhq = None  # /dhan/* endpoints return a friendly error


# ─── CONFIG — edit these to taste ─────────────────────────────────────────────
HOST = "127.0.0.1"
PORT = 5000

# Safety switch. True = only log what it would do (no real trades).
# Set to False once you've confirmed everything works.
# NOTE: now LIVE-PLACING on whatever account the MT5 terminal is logged into.
# Keep that terminal on your DEMO account to trade demo only.
DRY_RUN = False

# Path to the Obsidian Trading_Mind wiki folder
WIKI_ROOT = pathlib.Path(r"E:\Obsidian\Trading_Mind\wiki")

# Where monthly trade rollups are written, one subfolder per app. The apps POST
# their built markdown to /obsidian/monthly and this bridge writes the file.
RAW_TRADES_ROOT = pathlib.Path(r"E:\Obsidian\Trading_Mind\raw\trades")
EXPORT_APPS = {"alphaedge", "intellitrade", "smart-money-trader", "tradingbrain"}

# Lot sizing
DEFAULT_LOT  = 0.01    # used when RISK_PERCENT is 0, or if sizing can't be computed
RISK_PERCENT = 0.0     # 0 = always use DEFAULT_LOT. e.g. 1.0 = risk 1% of balance per trade
MAX_LOT      = 0.10    # hard cap, never trade bigger than this

DEVIATION = 20         # max allowed price slippage, in points
MAGIC     = 532025     # an ID stamped on orders from this bridge

# Duplicate guard: skip a new order if an AlphaEdge position is already open on
# the same symbol + direction within this % of the price. Set 0 to skip on ANY
# matching symbol+direction regardless of price.
DEDUP_PRICE_TOLERANCE_PCT = 0.5

# Map AlphaEdge asset labels -> your broker's MT5 symbol name.
# The bridge also auto-tries common suffixes (+, .m, etc.), so usually you
# only need to change these if your broker uses very different names.
SYMBOL_MAP = {
    "BTC/USD":  "BTCUSD",
    "ETH/USD":  "ETHUSD",
    "XAU/USD":  "XAUUSD",
    "Nifty 50": "NIFTY50",
}

# App asset ids to serve live prices for. Symbols are auto-resolved to your
# broker's names (e.g. XAUUSD -> XAUUSD+). NIFTY50 is skipped if your broker
# doesn't offer it (the app falls back to a web source for it).
PRICE_ASSETS = ["BTCUSD", "ETHUSD", "XAUUSD", "NIFTY50"]

# Optional: log in to a specific account on startup.
# Leave MT5_LOGIN = 0 to simply attach to whatever account the terminal is
# already logged into (recommended).
MT5_LOGIN    = 0          # e.g. 25600027
MT5_PASSWORD = ""
MT5_SERVER   = ""         # e.g. "VantageMarkets-Demo"
# Pin to THIS app's terminal so the bridge never grabs IntelliTrade's terminal
# (D:\MT5IntelliTrade). Both alphaedge and smart-money-trader use this one.
MT5_PATH     = r"C:\Program Files\Vantage Markets MT5 Terminal\terminal64.exe"
# ──────────────────────────────────────────────────────────────────────────────


_MT5_FAIL = {"ts": 0.0, "err": ""}   # last failed initialize attempt (for fail-fast)
_MT5_INIT_LOCK = threading.Lock()    # only ONE thread may run a (slow) initialize


def ensure_mt5():
    """Connect to the running MT5 terminal. Returns (ok, error).

    initialize() blocks for its full timeout when the terminal is down, and
    this is called on every request — so fail FAST: if already connected, a
    cheap terminal_info() confirms it; otherwise retry a real initialize at
    most once every 30s (single-flight) and return the cached error meanwhile.
    """
    if mt5 is None:
        return False, "MetaTrader5 package not installed. Run:  pip install MetaTrader5"
    try:
        if mt5.terminal_info() is not None:
            return True, None
    except Exception:
        pass
    now = time.time()
    if now - _MT5_FAIL["ts"] < 30:
        return False, _MT5_FAIL["err"] or "MT5 terminal not reachable (retrying soon)"
    if not _MT5_INIT_LOCK.acquire(blocking=False):
        return False, "MT5 reconnect already in progress"
    try:
        kwargs = {"path": MT5_PATH} if MT5_PATH else {}
        kwargs["timeout"] = 15000   # ms — don't hang requests for the default 60s
        if MT5_LOGIN:
            kwargs.update({"login": int(MT5_LOGIN), "password": MT5_PASSWORD, "server": MT5_SERVER})
        if mt5.initialize(**kwargs):
            _MT5_FAIL["ts"] = 0.0
            return True, None
        err = f"mt5.initialize failed: {mt5.last_error()}"
        _MT5_FAIL["ts"] = time.time()
        _MT5_FAIL["err"] = err
        return False, err
    finally:
        _MT5_INIT_LOCK.release()


def resolve_symbol(label):
    """Find the real MT5 symbol name for an AlphaEdge asset label."""
    base = SYMBOL_MAP.get(label) or (label or "").replace("/", "").replace(" ", "")
    if not base:
        return None
    candidates = [base, base + "+", base + ".m", base + "m", base + ".", base + "-", base + "#", base + "_raw"]
    for c in candidates:
        if mt5.symbol_info(c) is not None:
            return c
    # Last resort: search every symbol the broker offers
    for s in (mt5.symbols_get() or []):
        if base.upper() in s.name.upper():
            return s.name
    return None


def clamp_lot(lot, info=None):
    lo = getattr(info, "volume_min", 0.01) if info else 0.01
    hi = min(getattr(info, "volume_max", MAX_LOT) if info else MAX_LOT, MAX_LOT)
    return max(lo, min(lot, hi))


def calc_lot(symbol, price, sl):
    """Risk-based lot size, falling back to DEFAULT_LOT."""
    info = mt5.symbol_info(symbol)
    if RISK_PERCENT <= 0 or not sl:
        return clamp_lot(DEFAULT_LOT, info)
    acc = mt5.account_info()
    if acc is None or info is None:
        return clamp_lot(DEFAULT_LOT, info)
    dist = abs(price - sl)
    tick_size = info.trade_tick_size or info.point
    tick_value = info.trade_tick_value
    if dist <= 0 or not tick_size or not tick_value:
        return clamp_lot(DEFAULT_LOT, info)
    loss_per_lot = (dist / tick_size) * tick_value
    if loss_per_lot <= 0:
        return clamp_lot(DEFAULT_LOT, info)
    risk_money = acc.balance * (RISK_PERCENT / 100.0)
    lot = risk_money / loss_per_lot
    step = info.volume_step or 0.01
    lot = round(lot / step) * step
    return clamp_lot(lot, info)


def as_float(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def symbol_digits(symbol):
    info = mt5.symbol_info(symbol)
    return int(getattr(info, "digits", 5) or 5)


def point_value(symbol):
    info = mt5.symbol_info(symbol)
    return float(getattr(info, "point", 0.00001) or 0.00001)


def close_position(pos):
    symbol = pos.symbol
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"ok": False, "error": f"no price available to close {symbol} ticket #{pos.ticket}"}
    close_type = mt5.ORDER_TYPE_SELL if pos.type == mt5.POSITION_TYPE_BUY else mt5.ORDER_TYPE_BUY
    price = tick.bid if pos.type == mt5.POSITION_TYPE_BUY else tick.ask
    base_req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": pos.volume,
        "type": close_type,
        "position": pos.ticket,
        "price": price,
        "deviation": DEVIATION,
        "magic": MAGIC,
        "comment": "AlphaEdge close opposite",
        "type_time": mt5.ORDER_TIME_GTC,
    }
    for filling in (mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN):
        result = mt5.order_send(dict(base_req, type_filling=filling))
        if result is None:
            return {"ok": False, "error": f"close returned None: {mt5.last_error()}"}
        if result.retcode == mt5.TRADE_RETCODE_DONE:
            TRAILING.pop(pos.ticket, None)
            return {"ok": True, "ticket": pos.ticket, "price": result.price}
        if result.retcode != 10030:
            return {"ok": False, "retcode": result.retcode, "error": result.comment}
    return {"ok": False, "error": f"no supported filling mode to close ticket #{pos.ticket}"}


def close_opposite_positions(symbol, side, dry_run=False):
    want_opposite = mt5.POSITION_TYPE_SELL if side == "buy" else mt5.POSITION_TYPE_BUY
    closed = []
    for pos in (mt5.positions_get(symbol=symbol) or []):
        if pos.type != want_opposite or getattr(pos, "magic", 0) != MAGIC:
            continue
        if dry_run:
            closed.append({"ticket": pos.ticket, "side": "sell" if pos.type == mt5.POSITION_TYPE_SELL else "buy", "dryRun": True})
            continue
        result = close_position(pos)
        if not result.get("ok"):
            return result, closed
        closed.append(result)
    return {"ok": True}, closed


def trail_settings(sig, symbol):
    step_points = max(1.0, as_float(sig.get("trailStepPoints"), 500.0))
    distance_points = max(1.0, as_float(sig.get("trailDistancePoints"), 500.0))
    be_trigger_r = max(0.1, as_float(sig.get("beTriggerR"), 1.0))
    trail_start_r = max(be_trigger_r, as_float(sig.get("trailStartR"), be_trigger_r))
    point = point_value(symbol)
    return {
        "be_trigger_r": be_trigger_r,
        "trail_start_r": trail_start_r,
        "step_dist": step_points * point,
        "trail_dist": distance_points * point,
        "step_points": step_points,
        "distance_points": distance_points,
        "last_step": -1,
    }


def place_order(sig):
    """Translate an AlphaEdge signal into an MT5 market order."""
    side = (sig.get("side") or "").lower()
    if side not in ("buy", "sell"):
        return {"ok": False, "error": f"signal side '{side}' is not tradeable (neutral/flat) — skipped"}

    symbol = resolve_symbol(sig.get("symbol", ""))
    if not symbol:
        return {"ok": False, "error": f"no MT5 symbol found for '{sig.get('symbol')}'. Add it to SYMBOL_MAP."}
    if not mt5.symbol_select(symbol, True):
        return {"ok": False, "error": f"could not add {symbol} to Market Watch"}

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"ok": False, "error": f"no price available for {symbol}"}

    price = tick.ask if side == "buy" else tick.bid
    sl = float(sig.get("stopLoss") or 0) or 0.0
    tp = float(sig.get("takeProfit1") or 0) or 0.0
    # Lot: use the fixed lot from Money Management if provided, else auto-size.
    lot = float(sig.get("lot") or 0) or calc_lot(symbol, price, sl)
    lot = clamp_lot(lot, mt5.symbol_info(symbol))
    order_type = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL

    close_opposite_first = sig.get("closeOppositeFirst", True) is not False
    closed_opposite = []
    if close_opposite_first:
        close_result, closed_opposite = close_opposite_positions(symbol, side, dry_run=DRY_RUN)
        if not close_result.get("ok"):
            return {"ok": False, "error": f"could not close opposite position before new {side}: {close_result.get('error', close_result)}"}
        if closed_opposite:
            print(f"   closed opposite AlphaEdge position(s): {closed_opposite}")

    # Duplicate guard: don't stack a second AlphaEdge position of the same
    # symbol + direction near the same price.
    try:
        want_type = mt5.POSITION_TYPE_BUY if side == "buy" else mt5.POSITION_TYPE_SELL
        tol = DEDUP_PRICE_TOLERANCE_PCT / 100.0
        for pos in (mt5.positions_get(symbol=symbol) or []):
            if pos.type == want_type and getattr(pos, "magic", 0) == MAGIC:
                if not tol or (price and abs(price - pos.price_open) / price <= tol):
                    msg = f"duplicate skipped — already holding {symbol} {side} (ticket #{pos.ticket})"
                    print(f"   skip: {msg}")
                    return {"ok": True, "duplicate": True, "skipped": True, "message": msg}
    except Exception:
        pass

    plan = {"symbol": symbol, "side": side, "lot": lot, "price": price, "sl": sl, "tp": tp, "closedOpposite": closed_opposite}

    if DRY_RUN:
        print(f"   [DRY-RUN] would place: {plan}")
        return {"ok": True, "dryRun": True, "wouldSend": plan}

    # Stamp the strategy/setup into the order comment (MT5 caps at ~31 chars)
    # so History/audits can attribute every trade to its strategy.
    setup = re.sub(r"[^A-Za-z0-9 +/_-]", "", str(sig.get("setup") or ""))[:20].strip()
    comment = f"AE {setup}" if setup else "AlphaEdge"

    base_req = {
        "action":    mt5.TRADE_ACTION_DEAL,
        "symbol":    symbol,
        "volume":    lot,
        "type":      order_type,
        "price":     price,
        "sl":        sl,
        "tp":        tp,
        "deviation": DEVIATION,
        "magic":     MAGIC,
        "comment":   comment,
        "type_time": mt5.ORDER_TIME_GTC,
    }

    # Different brokers accept different "filling" modes — try the common ones.
    for filling in (mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN):
        req = dict(base_req, type_filling=filling)
        result = mt5.order_send(req)
        if result is None:
            return {"ok": False, "error": f"order_send returned None: {mt5.last_error()}"}
        if result.retcode == mt5.TRADE_RETCODE_DONE:
            print(f"   [LIVE] order placed #{result.order} {symbol} {side} {lot} @ {result.price}")
            # Register for step trailing if the Money Management rule asks for it.
            if (sig.get("stepTrailEnabled") or sig.get("trailAfter1R")) and sl:
                settings = trail_settings(sig, symbol)
                TRAILING[result.order] = {
                    "side": side, "entry": result.price,
                    "sl_dist": abs(result.price - sl), "symbol": symbol,
                    **settings,
                }
                ensure_trail_thread()
                print(f"   step trail armed for #{result.order} (BE at {settings['be_trigger_r']}R, start {settings['trail_start_r']}R, step {settings['step_points']} points)")
            return {"ok": True, "order": result.order, "volume": result.volume, "price": result.price, "closedOpposite": closed_opposite}
        # 10030 = unsupported filling mode -> try the next one
        if result.retcode != 10030:
            return {"ok": False, "retcode": result.retcode, "error": result.comment}
    return {"ok": False, "error": "no supported filling mode for this symbol"}


def get_prices():
    """Live prices: MT5 (forex/crypto) + Dhan (Indian indices), merged.

    Dhan index quotes are independent of MT5, so they're returned even if the
    MT5 terminal isn't connected.
    """
    out = {}
    ok, _ = ensure_mt5()
    if not ok:
        out.update(dhan_index_quotes())
        return out
    for app_id in PRICE_ASSETS:
        try:
            sym = resolve_symbol(app_id)
            if not sym or not mt5.symbol_select(sym, True):
                continue
            tick = mt5.symbol_info_tick(sym)
            if tick is None:
                continue
            last = tick.last or 0
            if not last:  # CFDs/forex often have last=0 -> use bid/ask midpoint
                bid, ask = tick.bid or 0, tick.ask or 0
                last = (bid + ask) / 2 if (bid and ask) else (bid or ask)
            if not last:
                continue
            change = 0.0
            try:
                rates = mt5.copy_rates_from_pos(sym, mt5.TIMEFRAME_D1, 0, 1)
                if rates is not None and len(rates) >= 1:
                    day_open = float(rates[-1]["open"])
                    if day_open:
                        change = (last - day_open) / day_open * 100.0
            except Exception:
                pass
            out[app_id] = {"price": last, "change": round(change, 2), "source": "MT5", "symbol": sym}
        except Exception:
            continue
    # Merge live Indian index quotes from Dhan (Nifty/BankNifty/Sensex).
    out.update(dhan_index_quotes())
    return out


# Cache Dhan index quotes briefly (Dhan data API rate limit is ~5/sec; the app
# polls every several seconds, so a short cache avoids hammering the endpoint).
_DHAN_QUOTE_CACHE = {"ts": 0.0, "data": {}}
_DHAN_QUOTE_TTL = 3.0


def dhan_index_quotes():
    """Live LTP + %change for Nifty 50 / Bank Nifty / Sensex via Dhan ohlc_data."""
    if _dhanhq is None:
        return {}
    now = time.time()
    if now - _DHAN_QUOTE_CACHE["ts"] < _DHAN_QUOTE_TTL:
        return _DHAN_QUOTE_CACHE["data"]
    token, client = _dhan_credentials({})
    if not token or not client:
        return {}
    # securityId -> app asset id
    id_map = {"13": "NIFTY50", "25": "BANKNIFTY", "51": "SENSEX"}
    out = {}
    try:
        dhan = _dhanhq(DhanContext(client, token))
        resp = dhan.ohlc_data({"IDX_I": [13, 25, 51]})
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


# ─── TRAILING STOP ────────────────────────────────────────────────────────────
# Tickets to trail: move SL to breakeven at the configured R trigger, then
# trail in fixed point steps. SL is only moved in the protective direction.
TRAILING = {}            # ticket -> {side, entry, sl_dist, symbol, trail settings}
_trail_started = False


def _trail_loop():
    while True:
        try:
            for ticket, info in list(TRAILING.items()):
                positions = mt5.positions_get(ticket=ticket) or []
                if not positions:
                    TRAILING.pop(ticket, None)   # closed -> stop tracking
                    continue
                pos = positions[0]
                tick = mt5.symbol_info_tick(info["symbol"])
                if tick is None:
                    continue
                price = tick.bid if info["side"] == "buy" else tick.ask
                entry, dist = info["entry"], info["sl_dist"]
                if dist <= 0:
                    continue
                profit = (price - entry) if info["side"] == "buy" else (entry - price)
                be_trigger = dist * float(info.get("be_trigger_r", 1.0))
                trail_start = dist * float(info.get("trail_start_r", 1.0))
                step_dist = float(info.get("step_dist", dist) or dist)
                trail_dist = float(info.get("trail_dist", dist) or dist)
                if profit < be_trigger:
                    continue
                new_sl = entry
                step_no = int((profit - trail_start) // step_dist) if profit >= trail_start and step_dist > 0 else -1
                if step_no > int(info.get("last_step", -1)):
                    if info["side"] == "buy":
                        new_sl = max(entry, price - trail_dist)
                    else:
                        new_sl = min(entry, price + trail_dist)
                if info["side"] == "buy":
                    better = new_sl > (pos.sl or 0)
                else:
                    better = (pos.sl == 0) or (new_sl < pos.sl)
                if better:
                    rounded_sl = round(new_sl, symbol_digits(info["symbol"]))
                    result = mt5.order_send({
                        "action":   mt5.TRADE_ACTION_SLTP,
                        "symbol":   info["symbol"],
                        "position": ticket,
                        "sl":       rounded_sl,
                        "tp":       pos.tp,
                    })
                    if result is not None and result.retcode == mt5.TRADE_RETCODE_DONE:
                        if step_no > int(info.get("last_step", -1)):
                            info["last_step"] = step_no
                        print(f"   trail: #{ticket} SL -> {rounded_sl}")
        except Exception:
            pass
        time.sleep(5)


def ensure_trail_thread():
    global _trail_started
    if not _trail_started:
        _trail_started = True
        threading.Thread(target=_trail_loop, daemon=True).start()


# ─── KILL SWITCH + DAILY-LOSS AUTO-HALT ──────────────────────────────────────
# Persistent trading-halt state. While halted, /signal rejects every order.
# A monitor thread watches today's AlphaEdge P&L (realized + floating) and
# trips the halt automatically when the daily-loss limit is breached, closing
# every open AlphaEdge position. State lives in risk_state.json so a halt
# survives bridge restarts; an AUTO halt clears itself on the next IST day,
# a manual kill-switch halt stays until manually resumed.
RISK_FILE = pathlib.Path(__file__).parent / "risk_state.json"
_RISK_LOCK = threading.Lock()
_RISK_DEFAULTS = {
    "halted": False,          # master halt flag — blocks /signal
    "reason": "",             # why (manual kill switch / daily loss)
    "haltedAt": "",           # when the halt engaged
    "autoHaltDay": "",        # IST day of an AUTO halt — auto-clears next day
    "dailyLossLimit": 0.0,    # account-ccy loss that trips the halt (0 = off)
    # Daily PROFIT lock — once today's realized P&L reaches the target, new
    # signals are rejected for the rest of the IST day. Open positions are NOT
    # closed (trailing keeps managing them); this only blocks fresh entries.
    # The give-back stop locks earlier when a green day starts bleeding back:
    # it arms once the day's realized peak reaches half the target.
    "dailyProfitLock": 0.0,   # bank the day at +N account-ccy realized (0 = off)
    "profitGivebackPct": 50.0,  # lock when realized P&L falls this % off today's peak (0 = off)
}


def _ist_now():
    from datetime import datetime as _dt, timezone, timedelta
    return _dt.now(timezone.utc).astimezone(timezone(timedelta(hours=5, minutes=30)))


def _ist_day(ts=None):
    from datetime import datetime as _dt, timezone, timedelta
    base = _dt.fromtimestamp(ts, tz=timezone.utc) if ts else _dt.now(timezone.utc)
    return base.astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d")


# ─── GOLD FRIDAY CUTOFF ──────────────────────────────────────────────────────
# Vantage XAUUSD+ session, verified from actual M1 bar data (server = UTC+3):
# daily open 03:30 IST, close 02:27 IST next day. Normal Fridays run the full
# session (close ~02:26 IST Sat) — but US-HOLIDAY Fridays (Juneteenth 19-Jun,
# July-4th-observed 3-Jul) closed at 22:29 IST with no warning to the apps.
# Rule: gold goes flat before 22:30 IST EVERY Friday — worst case we skip the
# thin US afternoon, best case we dodge a 2.5-day weekend gap.
GOLD_FRI_BLOCK_MIN   = 21 * 60 + 45   # 21:45 IST Fri — reject new gold entries
GOLD_FRI_FLATTEN_MIN = 22 * 60 + 15   # 22:15 IST Fri — close open gold positions


def gold_friday_state():
    """(block_new, flatten) for the Friday gold cutoff, in IST."""
    ist = _ist_now()
    if ist.weekday() != 4:   # Friday only
        return False, False
    mins = ist.hour * 60 + ist.minute
    return mins >= GOLD_FRI_BLOCK_MIN, mins >= GOLD_FRI_FLATTEN_MIN


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


def indian_entry_block():
    """Reason string when new Indian entries must be rejected, else ''. """
    ist = _ist_now()
    if ist.weekday() >= 5:
        return "Indian market closed (weekend)."
    if _ist_day() in set(indian_holidays()):
        return "NSE holiday today (Dhan holiday calendar) — Indian market closed."
    mins = ist.hour * 60 + ist.minute
    if mins >= IN_SQOFF_BLOCK_MIN:
        return ("Indian intraday square-off: no new NSE entries after 15:05 IST "
                "(positions flat before 15:20; market closes 15:30).")
    return ""


def indian_flatten_window():
    """True during the 15:15–15:45 IST flatten window on trading days (bounded
    so failed closes after the 15:30 market close don't spam forever)."""
    if not is_indian_trading_day():
        return False
    ist = _ist_now()
    mins = ist.hour * 60 + ist.minute
    return IN_SQOFF_FLATTEN_MIN <= mins <= (15 * 60 + 45)


def flatten_indian_positions():
    """Close every open AlphaEdge Indian-instrument position (daily square-off).
    Idempotent — once closed, later calls find nothing."""
    ok, _ = ensure_mt5()
    if not ok:
        return
    for pos in (mt5.positions_get() or []):
        if getattr(pos, "magic", 0) != MAGIC:
            continue
        if not _is_indian_symbol(pos.symbol):
            continue
        result = close_position(pos)
        print(f"   [NSE-SQOFF] flattened #{pos.ticket} {pos.symbol} before 15:20 IST: {result}")


def flatten_gold_positions():
    """Close every open AlphaEdge gold position (Friday pre-close). Idempotent —
    once they're closed, subsequent calls find nothing to do."""
    ok, _ = ensure_mt5()
    if not ok:
        return
    for pos in (mt5.positions_get() or []):
        if getattr(pos, "magic", 0) != MAGIC:
            continue
        if not pos.symbol.upper().startswith("XAU"):
            continue
        result = close_position(pos)
        print(f"   [GOLD-FRI] flattened #{pos.ticket} {pos.symbol} before Friday gold close: {result}")


def _read_risk_file():
    state = dict(_RISK_DEFAULTS)
    try:
        if RISK_FILE.exists():
            state.update(json.loads(RISK_FILE.read_text(encoding="utf-8")))
    except Exception:
        pass
    return state


def _risk_state():
    with _RISK_LOCK:
        state = _read_risk_file()
        # An automatic daily-loss halt only lasts for that IST trading day.
        if state["halted"] and state["autoHaltDay"] and state["autoHaltDay"] != _ist_day():
            state.update({"halted": False, "reason": "", "haltedAt": "", "autoHaltDay": ""})
            try:
                RISK_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
            except Exception:
                pass
        return state


def _save_risk(**patch):
    with _RISK_LOCK:
        state = _read_risk_file()
        state.update(patch)
        try:
            RISK_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
        except Exception as e:
            print(f"   ! risk state save failed: {e}")
        return state


_PNL_CACHE = {"ts": 0.0, "data": None}


def daily_pnl():
    """Today's AlphaEdge P&L: realized (closed MAGIC deals, IST day) + floating.
    Cached 5s — the risk loop and /risk polls share the same computation."""
    now = time.time()
    if _PNL_CACHE["data"] is not None and now - _PNL_CACHE["ts"] < 5:
        return _PNL_CACHE["data"]
    ok, err = ensure_mt5()
    if not ok:
        return {"ok": False, "error": err}
    import datetime as _dt
    # Wide bounds — deal.time is broker-server time; filter by IST day below.
    to_t   = _dt.datetime.now() + _dt.timedelta(days=1)
    from_t = _dt.datetime.now() - _dt.timedelta(days=3)
    today = _ist_day()
    realized = peak = 0.0
    day_deals = [d for d in (mt5.history_deals_get(from_t, to_t) or [])
                 if getattr(d, "magic", 0) == MAGIC and _ist_day(int(d.time)) == today]
    day_deals.sort(key=lambda d: int(d.time))
    for d in day_deals:
        realized += float(d.profit) + float(getattr(d, "commission", 0)) + float(getattr(d, "swap", 0))
        peak = max(peak, realized)   # intraday peak — what the give-back stop protects
    floating = 0.0
    open_count = 0
    for p in (mt5.positions_get() or []):
        if getattr(p, "magic", 0) != MAGIC:
            continue
        floating += float(p.profit) + float(getattr(p, "swap", 0))
        open_count += 1
    result = {"ok": True, "realized": round(realized, 2), "peak": round(peak, 2),
              "floating": round(floating, 2), "total": round(realized + floating, 2),
              "openPositions": open_count, "day": today}
    _PNL_CACHE["ts"] = now
    _PNL_CACHE["data"] = result
    return result


def close_all_positions(scope="alphaedge"):
    """Close open positions at market (kill switch). scope: 'alphaedge' = only
    positions this bridge opened (MAGIC stamp), 'all' = every position on the
    account (including manual ones)."""
    ok, err = ensure_mt5()
    if not ok:
        return {"ok": False, "error": err, "closed": [], "errors": []}
    closed, errors = [], []
    for pos in (mt5.positions_get() or []):
        if scope != "all" and getattr(pos, "magic", 0) != MAGIC:
            continue
        result = close_position(pos)
        entry = {"symbol": pos.symbol, "ticket": pos.ticket, **result}
        (closed if result.get("ok") else errors).append(entry)
    return {"ok": not errors, "closed": closed, "errors": errors}


def activate_halt(reason, auto=False, close=True, scope="alphaedge"):
    close_result = close_all_positions(scope) if close else {"ok": True, "closed": [], "errors": []}
    import datetime as _dt
    _save_risk(halted=True, reason=reason,
               haltedAt=_dt.datetime.now().isoformat(timespec="seconds"),
               autoHaltDay=_ist_day() if auto else "")
    tail = f", {len(close_result['errors'])} close error(s)" if close_result.get("errors") else ""
    print(f"   [HALT] {reason} — closed {len(close_result.get('closed', []))} position(s){tail}")
    return close_result


_risk_started = False


def _risk_loop():
    while True:
        try:
            # Friday gold cutoff — flatten open XAU positions from 22:15 IST.
            _, flatten = gold_friday_state()
            if flatten:
                flatten_gold_positions()
            # Indian intraday square-off — flatten NSE positions 15:15 IST.
            if indian_flatten_window():
                flatten_indian_positions()
            state = _risk_state()
            limit = float(state.get("dailyLossLimit") or 0)
            if limit > 0 and not state.get("halted"):
                pnl = daily_pnl()
                if pnl.get("ok") and pnl["total"] <= -limit:
                    activate_halt(
                        f"Daily loss limit hit: {pnl['total']:.2f} <= -{limit:.2f} "
                        f"(realized {pnl['realized']:.2f}, floating {pnl['floating']:.2f})",
                        auto=True, close=True)
        except Exception:
            pass
        time.sleep(10)


def ensure_risk_thread():
    global _risk_started
    if not _risk_started:
        _risk_started = True
        threading.Thread(target=_risk_loop, daemon=True).start()


def profit_lock_check(state=None, pnl=None):
    """Is the daily profit lock active? Returns (locked, reason). Uses REALIZED
    P&L only — floating profit isn't banked yet, so it can't bank the day."""
    state = state or _risk_state()
    lock_amt = float(state.get("dailyProfitLock") or 0)
    if lock_amt <= 0:
        return False, ""
    pnl = pnl or daily_pnl()
    if not pnl.get("ok"):
        return False, ""
    if pnl["realized"] >= lock_amt:
        return True, (f"Profit lock: today +{pnl['realized']:.2f} >= target +{lock_amt:.2f} "
                      f"— day banked, no new entries until tomorrow (IST).")
    gb = float(state.get("profitGivebackPct") or 0)
    if gb > 0 and pnl["peak"] >= lock_amt / 2 and pnl["realized"] <= pnl["peak"] * (1 - gb / 100.0):
        return True, (f"Give-back stop: day peaked +{pnl['peak']:.2f}, now +{pnl['realized']:.2f} "
                      f"(>= {gb:g}% given back) — locking what's left until tomorrow (IST).")
    return False, ""


def risk_status():
    state = _risk_state()
    pnl = daily_pnl()
    locked, lock_reason = profit_lock_check(state, pnl if pnl.get("ok") else None)
    return {"ok": True, **{k: state[k] for k in _RISK_DEFAULTS},
            "pnl": pnl if pnl.get("ok") else None,
            "pnlError": None if pnl.get("ok") else pnl.get("error"),
            "profitLock": {"active": locked, "reason": lock_reason}}


def risk_command(body):
    """POST /risk — {action: halt|resume|config, ...}. /killswitch = halt."""
    action = str(body.get("action", "")).strip().lower()
    if action in ("halt", "kill", "killswitch"):
        scope = "all" if str(body.get("scope", "")).lower() == "all" else "alphaedge"
        close = body.get("closePositions", True) is not False
        reason = str(body.get("reason") or "Manual kill switch")
        result = activate_halt(reason, auto=False, close=close, scope=scope)
        return {**risk_status(), "closeResult": result}
    if action == "resume":
        _save_risk(halted=False, reason="", haltedAt="", autoHaltDay="")
        print("   [HALT] trading resumed (manual)")
        return risk_status()
    if action == "config":
        patch = {}
        for key in ("dailyLossLimit", "dailyProfitLock", "profitGivebackPct"):
            if body.get(key) is None:
                continue
            try:
                patch[key] = max(0.0, float(body[key]))
            except (TypeError, ValueError):
                return {"ok": False, "error": f"{key} must be a number"}
        if not patch:
            return {"ok": False, "error": "config needs dailyLossLimit / dailyProfitLock / profitGivebackPct"}
        _save_risk(**patch)
        print("   [RISK] config: " + ", ".join(f"{k}={v:g}" for k, v in patch.items()))
        return risk_status()
    return {"ok": False, "error": f"unknown action '{action}' (use halt | resume | config)"}


def get_account():
    """Live account balance/equity and open positions from MT5."""
    ok, _ = ensure_mt5()
    if not ok:
        return {}
    acc = mt5.account_info()
    if acc is None:
        return {}
    positions = []
    for p in (mt5.positions_get() or []):
        positions.append({
            "ticket": p.ticket,
            "symbol": p.symbol,
            "side": "buy" if p.type == mt5.POSITION_TYPE_BUY else "sell",
            "volume": p.volume,
            "price_open": p.price_open,
            "sl": p.sl,
            "tp": p.tp,
            "profit": round(p.profit, 2),
        })
    return {
        "login": acc.login,
        "server": acc.server,
        "currency": acc.currency,
        "balance": round(acc.balance, 2),
        "equity": round(acc.equity, 2),
        "margin": round(acc.margin, 2),
        "free_margin": round(acc.margin_free, 2),
        "profit": round(acc.profit, 2),
        "positions": positions,
    }


def get_alphaedge_trades(days=30):
    """AlphaEdge-only MT5 trades (open + closed) for the History page.

    Filtered strictly by this bridge's MAGIC so ONLY trades that originated
    from AlphaEdge signals are returned — never manual or other-app trades.
    Closed trades come from deal history (realized P&L); open trades from the
    live positions list (floating P&L), mirroring MT5's History and Trade tabs.
    """
    ok, _ = ensure_mt5()
    if not ok:
        return {"trades": [], "error": "MT5 not connected"}
    import datetime as _dt
    # MT5 deal.time is BROKER-SERVER time (can run hours ahead of local), so a
    # tight upper bound clips just-closed trades out of History. Over-shoot it —
    # there are no real deals in the future, so a wide `to` is safe.
    to_t   = _dt.datetime.now() + _dt.timedelta(days=1)
    from_t = _dt.datetime.now() - _dt.timedelta(days=max(1, int(days)) + 1)

    # ── Closed trades: pair entry/exit deals by position_id (AlphaEdge magic) ──
    deals = mt5.history_deals_get(from_t, to_t) or []
    pos = {}
    for d in deals:
        if getattr(d, "magic", 0) != MAGIC:
            continue
        g = pos.setdefault(d.position_id, {
            "position_id": d.position_id, "symbol": d.symbol,
            "profit": 0.0, "in": None, "out": None, "volume": 0.0, "comment": "",
        })
        g["profit"] += float(d.profit) + float(getattr(d, "commission", 0)) + float(getattr(d, "swap", 0))
        if d.entry == mt5.DEAL_ENTRY_IN:
            g["in"] = d; g["symbol"] = d.symbol; g["volume"] = d.volume
            g["side"] = "buy" if d.type == mt5.DEAL_TYPE_BUY else "sell"
            g["comment"] = getattr(d, "comment", "") or ""
        elif d.entry in (mt5.DEAL_ENTRY_OUT, getattr(mt5, "DEAL_ENTRY_OUT_BY", 2)):
            g["out"] = d

    open_ids = {p.ticket for p in (mt5.positions_get() or [])}
    trades = []
    for pid, g in pos.items():
        if not g["in"]:
            continue
        closed = g["out"] is not None and pid not in open_ids
        trades.append({
            "ticket":      pid,
            "symbol":      g["symbol"],
            "side":        g.get("side", "buy"),
            "volume":      g["volume"],
            "open_price":  round(float(g["in"].price), 5),
            "close_price": round(float(g["out"].price), 5) if g["out"] else None,
            "open_time":   int(g["in"].time),
            "close_time":  int(g["out"].time) if (closed and g["out"]) else None,
            "profit":      round(g["profit"], 2),
            "state":       "closed" if closed else "open",
            "comment":     g["comment"],
        })

    # ── Open trades: live positions stamped with AlphaEdge magic ──────────────
    for p in (mt5.positions_get() or []):
        if getattr(p, "magic", 0) != MAGIC:
            continue
        trades.append({
            "ticket":      p.ticket,
            "symbol":      p.symbol,
            "side":        "buy" if p.type == mt5.POSITION_TYPE_BUY else "sell",
            "volume":      p.volume,
            "open_price":  round(float(p.price_open), 5),
            "close_price": None,
            "open_time":   int(p.time),
            "close_time":  None,
            "profit":      round(float(p.profit), 2),   # floating P&L
            "sl":          float(p.sl), "tp": float(p.tp),
            "state":       "open",
            "comment":     getattr(p, "comment", "") or "",
        })

    # newest first, de-dup by ticket (prefer the open/live row if both exist)
    seen = {}
    for t in trades:
        if t["ticket"] not in seen or t["state"] == "open":
            seen[t["ticket"]] = t
    out = sorted(seen.values(), key=lambda t: t["open_time"], reverse=True)
    return {"trades": out, "magic": MAGIC, "count": len(out)}


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
        under = float(snap[0].get("under_ltp") or 0)
        expiry = snap[0].get("expiry", "")
        by_strike = {}
        for r in snap:
            sk = float(r.get("strike") or 0)
            leg = {"ltp": float(r.get("ltp") or 0), "oi": float(r.get("oi") or 0),
                   "iv": round(float(r.get("iv") or 0), 2), "delta": round(float(r.get("delta") or 0), 3),
                   "theta": round(float(r.get("theta") or 0), 2)}
            by_strike.setdefault(sk, {})[r.get("type", "").lower()] = leg
        sks = sorted(by_strike.keys())
        if not sks or not under:
            return None
        atm = min(sks, key=lambda s: abs(s - under))
        ai = sks.index(atm)
        sel = sks[max(0, ai - rng):min(len(sks), ai + rng + 1)]
        out = [{"strike": round(s, 2), "atm": s == atm,
                "ce": by_strike[s].get("ce", {"ltp":0,"oi":0,"iv":0,"delta":0,"theta":0}),
                "pe": by_strike[s].get("pe", {"ltp":0,"oi":0,"iv":0,"delta":0,"theta":0})} for s in sel]
        return {"ok": True, "underlying": under_name, "under_ltp": round(under, 2), "expiry": expiry,
                "isExpiryToday": False, "atmStrike": atm,
                "ivPercentile": _atm_iv_percentile(under_name, by_strike[atm].get("ce", {}).get("iv", 0)),
                "strikes": out, "stale": True, "snapshotTime": last_ts}
    except Exception:
        return None


def dhan_optionchain(req):
    """Live option chain (ATM +/- range) with greeks/IV for the strike selector.
    Falls back to the last collected snapshot when the market is closed."""
    if _dhanhq is None:
        return {"ok": False, "error": "dhanhq not installed on bridge host"}
    token, client = _dhan_credentials(req)
    if not token or not client:
        return {"ok": False, "error": "missing Dhan token/clientId"}
    meta = DHAN_INSTRUMENTS.get(req.get("underlying", ""))
    if not meta:
        return {"ok": False, "error": f"unknown underlying '{req.get('underlying')}'"}
    rng = int(req.get("range", 6))
    try:
        dhan = _dhanhq(DhanContext(client, token))
        sid = int(meta["security_id"]); seg = meta["segment"]
        el = dhan.expiry_list(sid, seg)
        eld = (el.get("data") or {}).get("data") or el.get("data") or []
        if isinstance(eld, dict):
            eld = eld.get("data") or []
        if not eld:
            fb = _optionchain_from_csv(req.get("underlying"), rng)
            return fb if fb else {"ok": False, "error": "no expiries (market closed?) and no saved snapshot"}
        import datetime as _dt
        today = _dt.datetime.now(_dt.timezone.utc).astimezone(_dt.timezone(_dt.timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d")
        expiry = next((e for e in eld if str(e) >= today), eld[0])
        time.sleep(0.3)
        oc = dhan.option_chain(sid, seg, expiry)
        d = oc.get("data", oc)
        if isinstance(d, dict) and isinstance(d.get("data"), dict):
            d = d["data"]
        under = float(d.get("last_price") or 0)
        ocmap = d.get("oc") or {}
        if not ocmap or not under:
            fb = _optionchain_from_csv(req.get("underlying"), rng)
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
                        "iv": round(float(x.get("implied_volatility") or 0), 2),
                        "delta": round(float(g.get("delta") or 0), 3),
                        "theta": round(float(g.get("theta") or 0), 2)}
            rows.append({"strike": round(float(sk), 2), "atm": float(sk) == floats[atm_i],
                         "ce": leg("ce"), "pe": leg("pe")})
        atm_ce_iv = next((r["ce"]["iv"] for r in rows if r["atm"]), 0)
        return {"ok": True, "underlying": req.get("underlying"), "under_ltp": round(under, 2),
                "expiry": expiry, "isExpiryToday": str(expiry) == today,
                "atmStrike": floats[atm_i], "ivPercentile": _atm_iv_percentile(req.get("underlying"), atm_ce_iv),
                "strikes": rows}
    except Exception as e:
        fb = _optionchain_from_csv(req.get("underlying"), rng)
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


def handle_signal(sig):
    state = _risk_state()
    if state.get("halted"):
        msg = f"TRADING HALTED — {state.get('reason') or 'kill switch active'}. Resume from the Dashboard Discipline panel."
        print(f"   ! signal rejected: {msg}")
        return {"ok": False, "halted": True, "error": msg}
    locked, lock_reason = profit_lock_check(state)
    if locked:
        print(f"   ! signal rejected: {lock_reason}")
        return {"ok": False, "profitLocked": True, "error": lock_reason}
    if "XAU" in str(sig.get("symbol") or "").upper().replace("/", ""):
        block_gold, _ = gold_friday_state()
        if block_gold:
            msg = ("Gold entries blocked after 21:45 IST on Fridays — Vantage closes XAUUSD+ "
                   "early (22:30 IST) on US-holiday Fridays; open gold is flattened at 22:15 IST.")
            print(f"   ! signal rejected: {msg}")
            return {"ok": False, "goldFridayBlock": True, "error": msg}
    if _is_indian_symbol(str(sig.get("symbol") or "").replace(" ", "").replace("/", "")):
        block_reason = indian_entry_block()
        if block_reason:
            print(f"   ! signal rejected: {block_reason}")
            return {"ok": False, "indianMarketBlock": True, "error": block_reason}
    ok, err = ensure_mt5()
    if not ok:
        print(f"   ! {err}")
        return {"ok": False, "error": err}
    label = sig.get("symbol", "?")
    acct = sig.get("account", "?")
    print(f"-> signal: {label} {sig.get('side','?')} (account={acct}, conf={sig.get('confidence','?')})")
    try:
        return place_order(sig)
    except Exception as e:  # noqa: BLE001 - report any unexpected error back to the app
        print(f"   ! error: {e}")
        return {"ok": False, "error": str(e)}


# ─── DHAN HISTORICAL DATA (proxied for the browser to avoid CORS) ─────────────
# The browser can't call api.dhan.co directly (CORS). It POSTs to this local
# bridge instead, which calls Dhan server-side via the official SDK.
DHAN_INSTRUMENTS = {
    "NIFTY50":   {"security_id": "13", "segment": "IDX_I", "instrument": "INDEX"},
    "BANKNIFTY": {"security_id": "25", "segment": "IDX_I", "instrument": "INDEX"},
    "SENSEX":    {"security_id": "51", "segment": "IDX_I", "instrument": "INDEX"},
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
        elif parsed.path.startswith("/account"):
            self._send(200, get_account())
        elif parsed.path.startswith("/risk"):
            self._send(200, risk_status())
        elif parsed.path.startswith("/market/holiday"):
            today = _ist_day()
            hols = indian_holidays()
            self._send(200, {"ok": True, "today": today, "isHoliday": today in set(hols),
                             "tradingDay": is_indian_trading_day(),
                             "squareOff": {"blockFrom": "15:05", "flattenAt": "15:15", "close": "15:30"},
                             "holidays": hols})
        elif parsed.path.startswith("/history"):
            days = int(qs.get("days", ["30"])[0] or 30)
            self._send(200, get_alphaedge_trades(days))
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
            self._send(200, {"ok": True, "service": "AlphaEdge MT5 bridge", "dryRun": DRY_RUN})

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
        if parsed.path.startswith("/obsidian/monthly"):
            result = write_monthly_export(body)
            self._send(200 if result.get("ok") else 400, result)
            return
        if parsed.path.startswith("/killswitch"):
            body.setdefault("action", "halt")
            result = risk_command(body)
            self._send(200 if result.get("ok") else 400, result)
            return
        if parsed.path.startswith("/risk"):
            result = risk_command(body)
            self._send(200 if result.get("ok") else 400, result)
            return
        result = handle_signal(body)
        self._send(200 if result.get("ok") else 400, result)

    def log_message(self, *args):  # silence default per-request logging
        pass


def rearm_existing_positions():
    """Re-register AlphaEdge positions for TSL on bridge start.

    The TRAILING dict is in-memory and is lost when the bridge restarts.
    This scans open positions placed by this bridge (MAGIC stamp) and
    re-arms them so trailing-stop coverage is not lost after a restart.
    """
    if mt5 is None:
        return
    positions = mt5.positions_get() or []
    count = 0
    for pos in positions:
        if getattr(pos, "magic", 0) != MAGIC:
            continue
        if pos.ticket in TRAILING:
            continue
        entry = float(pos.price_open or 0)
        if not entry:
            continue
        sl = float(pos.sl or 0)
        pv = point_value(pos.symbol)
        sl_dist = abs(entry - sl) if sl else entry * 0.01
        side = "buy" if pos.type == mt5.POSITION_TYPE_BUY else "sell"
        TRAILING[pos.ticket] = {
            "side":             side,
            "entry":            entry,
            "sl_dist":          sl_dist,
            "symbol":           pos.symbol,
            "be_trigger_r":     1.0,
            "trail_start_r":    1.0,
            "step_dist":        sl_dist,
            "trail_dist":       sl_dist,
            "step_points":      sl_dist / pv if pv else 500,
            "distance_points":  sl_dist / pv if pv else 500,
            "last_step":        -1,
        }
        count += 1
    if count:
        ensure_trail_thread()
        print(f"   [TSL] re-armed {count} existing AlphaEdge position(s) for trailing stop")


def main():
    print("=" * 60)
    print("  AlphaEdge  ->  MetaTrader 5  bridge")
    print("=" * 60)
    ok, err = ensure_mt5()
    if ok:
        acc = mt5.account_info()
        if acc:
            print(f"  Connected to MT5: account {acc.login} ({acc.server})  balance {acc.balance} {acc.currency}")
        rearm_existing_positions()
    else:
        print(f"  WARNING: {err}")
        print("  The bridge will still start, but orders will fail until MT5 is reachable.")
    print(f"  Mode: {'DRY-RUN (no real orders)' if DRY_RUN else 'LIVE — orders will be placed!'}")
    ensure_risk_thread()
    rs = _risk_state()
    if rs.get("halted"):
        print(f"  !! TRADING HALTED (persisted): {rs.get('reason')}")
    limit = float(rs.get("dailyLossLimit") or 0)
    print("  Daily-loss auto-halt: " + (f"-{limit:.2f} (closes all AlphaEdge positions)" if limit else "OFF - set it in AlphaEdge Settings > Discipline"))
    # Warm the index-futures cache so the first browser backtest is instant.
    try:
        fm = _futures_map()
        if fm:
            print("  Index futures: " + ", ".join(f"{k}={v['display'].strip()}" for k, v in fm.items()))
    except Exception:
        pass
    print(f"  Listening on http://{HOST}:{PORT}/signal")
    print(f"  Wiki context: http://{HOST}:{PORT}/wiki/context?asset=BTCUSD&strategy=ict")
    wiki_ok = WIKI_ROOT.exists()
    print(f"  Obsidian wiki: {'found at ' + str(WIKI_ROOT) if wiki_ok else 'NOT FOUND at ' + str(WIKI_ROOT)}")
    print("  Paste that URL into AlphaEdge -> Settings -> MT5 Terminal -> Bridge / API URL")
    print("  Press Ctrl+C to stop.")
    print("=" * 60)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping bridge.")
    finally:
        if mt5 is not None:
            mt5.shutdown()


if __name__ == "__main__":
    main()
