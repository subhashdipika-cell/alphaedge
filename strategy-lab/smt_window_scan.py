"""
smt_window_scan.py — which UTC sessions, assets and entry styles pay in SMT?

Companion to buy_window_scan.py, but for the Smart-Money-Trader signal log
(D:/smart-money-trader/backend/signals_log.json — 380 signals, 2026-05-25 ->
2026-07-18).  That log records only the SETUP (entry/sl/tp) and the resolver's
verdict; it holds no post-signal price path, so every question below is answered
by REPLAYING each signal against real Binance 1-minute candles.

Four questions:

  Q1  Which UTC sessions pay?  (the log has no session field — sessions are
      derived from `sent_at`; only 13 signals mention one in `confluences`)
  Q2  Is ETH structurally unprofitable, or is the -718 pts an artifact of
      which ETH signals happened to fill?
  Q3  Does the limit entry lose to a market entry?  285 of 380 signals expired
      unfilled; replaying them as market fills prices the adverse selection.
  Q4  Does ATR_Trailing hold up beyond n=10?

The replay mirrors app/services/live_signal_service.py::resolve_open_outcomes:

  fill   : touch fill — BUY fills when low <= entry, SELL when high >= entry
  expiry : 24h unfilled -> EXPIRED;  filled trades get a 48h safety cap
  runaway: unfilled and >=1.5% past entry after 4h -> EXPIRED
  exit   : SL checked BEFORE TP within a candle (conservative), and the fill
           candle itself is checked for SL/TP — same as the live resolver

Because the walk is resolver-faithful, `--validate` replays the 128 already-
resolved signals and reports agreement with the logged outcome.  Treat the
market-fill numbers as trustworthy only to the extent that agreement is high.

XAUUSD (12 signals) is excluded from the replay: its only local candles are
Vantage MT5 CSVs stamped in broker-local time, and aligning 12 signals to an
unverified UTC offset would risk a silent error.  Gold is reported separately
from logged outcomes only.

Run:  python strategy-lab/smt_window_scan.py            (uses cached candles)
      python strategy-lab/smt_window_scan.py --refresh  (re-fetch from Binance)
      python strategy-lab/smt_window_scan.py --validate (replay-vs-log check)
"""
import csv, io, json, os, sys, time, urllib.request
from collections import defaultdict

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SIGNALS_LOG = r"D:/smart-money-trader/backend/signals_log.json"
HERE        = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR   = os.path.join(HERE, "data", "smt_candles")

# Resolver constants (live_signal_service.py)
MAX_PENDING_MS = 24 * 3600 * 1000   # unfilled limit order lifetime
MAX_FILLED_MS  = 48 * 3600 * 1000   # filled-trade safety net
RUNAWAY_MS     =  4 * 3600 * 1000   # min age before the run-away expiry applies
RUNAWAY_PCT    = 0.015              # price this far past entry = missed

# BTC/ETH come from Binance (the log's signals are Binance spot symbols, so the
# exchange feed is the authoritative one). XAUUSD has no Binance equivalent and
# is pulled from the MT5 terminal, converted from the broker's UTC+3 server
# clock — see fetch_mt5_candles.
REPLAY_SYMBOLS = ("BTCUSDT", "ETHUSDT", "XAUUSD")
MT5_SYMBOLS    = {"XAUUSD": "XAUUSD+"}
SESSIONS = [("Asia", 0, 7), ("London", 7, 12), ("NY-AM", 12, 16),
            ("NY-PM", 16, 21), ("Late", 21, 24)]

# The resolver's expiry rules were retuned on 2026-07-05 (see the comment in
# resolve_open_outcomes). Under the OLD rules a pending order died at 2h and a
# FILLED trade was zeroed to EXPIRED at 8h — so slow trades were written off as
# no-fills. Those verdicts are terminal in the log: nothing re-resolved them
# after the fix. The replay proves 83 of them actually filled and resolved, all
# of them before this date and none after. Every table therefore splits on it —
# pooling the two eras compares a broken ledger against a working one.
ERA_SPLIT = "2026-07-05"


def era_of(sig):
    return "pre-fix" if sig["sent_at"][:10] < ERA_SPLIT else "post-fix"


def session_of(hour):
    for name, lo, hi in SESSIONS:
        if lo <= hour < hi:
            return name
    return "?"


# ─────────────────────────── candle cache ────────────────────────────────
def fetch_klines(symbol, start_ms, end_ms):
    """Page Binance 1m klines. Returns [(open_ms, high, low, close)]."""
    out, cur = [], start_ms
    while cur < end_ms:
        url = ("https://api.binance.com/api/v3/klines?"
               f"symbol={symbol}&interval=1m&startTime={cur}&limit=1000")
        for attempt in range(5):
            try:
                rows = json.load(urllib.request.urlopen(url, timeout=30))
                break
            except Exception as e:
                if attempt == 4:
                    raise
                time.sleep(2 * (attempt + 1))
        if not rows:
            break
        for r in rows:
            if r[0] <= end_ms:
                out.append((int(r[0]), float(r[2]), float(r[3]), float(r[4])))
        cur = int(rows[-1][0]) + 60_000
        if len(rows) < 1000:
            break
        print(f"    {symbol}: {len(out):>6} candles…", end="\r", flush=True)
    return out


def mt5_server_offset_h(mt5):
    """Measure the broker's UTC offset instead of assuming it. Vantage runs
    UTC+3; verified independently by correlating MT5 BTCUSD against Binance
    BTCUSDT (minute-to-minute change corr 0.995 at +3h, ~0.03 at every other
    shift), so a wrong offset here would be loud rather than silent."""
    import time as _t
    for sym in ("BTCUSD", "ETHUSD", "EURUSD"):
        if not mt5.symbol_select(sym, True):
            continue
        tick = mt5.symbol_info_tick(sym)
        if tick and tick.time:
            return round((tick.time - _t.time()) / 3600)
    raise RuntimeError("could not measure MT5 server offset")


def fetch_mt5_candles(mt5_symbol, start_ms, end_ms):
    """1m bars from the MT5 terminal, returned on a UTC clock.

    Read-only. Uses whichever terminal MetaTrader5 attaches to — IntelliTrade's
    (D:\\MT5IntelliTrade) and SMT's (C:\\Program Files\\Vantage Markets MT5
    Terminal) are different accounts on the SAME server (VantageMarkets-Demo),
    so the quote history is identical and we deliberately avoid initialising
    SMT's terminal: a half-open terminal64 wedges both SMT and AlphaEdge.
    """
    import datetime as _dt
    import MetaTrader5 as mt5
    if not mt5.initialize():
        raise RuntimeError(f"MT5 initialize failed: {mt5.last_error()}")
    try:
        off = mt5_server_offset_h(mt5)
        if not mt5.symbol_select(mt5_symbol, True):
            raise RuntimeError(f"symbol {mt5_symbol} unavailable")
        # Pad generously: copy_rates_range's treatment of naive datetimes is
        # ambiguous, so over-fetch and filter precisely after converting.
        pad = 12 * 3600
        utc = _dt.timezone.utc
        f = _dt.datetime.fromtimestamp(start_ms / 1000 - pad + off * 3600, utc)
        t = _dt.datetime.fromtimestamp(end_ms   / 1000 + pad + off * 3600, utc)
        bars = mt5.copy_rates_range(mt5_symbol, mt5.TIMEFRAME_M1, f, t)
        print(f"  {mt5_symbol}: {len(bars) if bars is not None else 0} MT5 bars "
              f"(server UTC{off:+d})")
    finally:
        mt5.shutdown()
    if bars is None:
        return []
    out = []
    for b in bars:
        ts = (int(b["time"]) - off * 3600) * 1000     # server clock -> UTC ms
        if start_ms <= ts <= end_ms:
            out.append((ts, float(b["high"]), float(b["low"]), float(b["close"])))
    return sorted(out)


def load_candles(symbol, start_ms, end_ms, refresh=False):
    """Cached 1m candles, extended incrementally so a rerun costs one request."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, f"{symbol}_1m.csv")
    rows = []
    if os.path.exists(path) and not refresh:
        with open(path) as fh:
            rows = [(int(r[0]), float(r[1]), float(r[2]), float(r[3]))
                    for r in csv.reader(fh)]
    # Binance rounds the first candle up to the next minute boundary, so the
    # cache legitimately starts a little after start_ms — allow for that or the
    # coverage test never passes and every run refetches the whole history.
    # Gold closes nightly and at weekends, so its cache legitimately ends well
    # before end_ms — don't treat that as a gap worth refetching.
    stale_ok = 4 * 86_400_000 if symbol in MT5_SYMBOLS else 60_000
    if rows and rows[0][0] <= start_ms + 300_000:
        if rows[-1][0] >= end_ms - stale_ok:
            return rows                                   # already complete
        tail = fetch_klines(symbol, rows[-1][0] + 60_000, end_ms)
        if tail:
            rows += tail
            with open(path, "w", newline="") as fh:
                csv.writer(fh).writerows(rows)
            print(f"  {symbol}: +{len(tail)} new candles "
                  f"({len(rows)} total)                ")
        return rows
    if symbol in MT5_SYMBOLS:
        print(f"  fetching {symbol} 1m candles from the MT5 terminal…")
        rows = fetch_mt5_candles(MT5_SYMBOLS[symbol], start_ms, end_ms)
    else:
        print(f"  fetching {symbol} 1m candles from Binance…")
        rows = fetch_klines(symbol, start_ms, end_ms)
    with open(path, "w", newline="") as fh:
        csv.writer(fh).writerows(rows)
    print(f"  {symbol}: {len(rows)} candles cached                ")
    return rows


def slice_from(candles, ts_ms):
    """Index of the first candle strictly after ts_ms (binary search)."""
    lo, hi = 0, len(candles)
    while lo < hi:
        mid = (lo + hi) // 2
        if candles[mid][0] <= ts_ms:
            lo = mid + 1
        else:
            hi = mid
    return lo


# ──────────────────────────── the replay ─────────────────────────────────
def replay(sig, candles, mode):
    """Walk a signal forward. mode:
         limit       — resolver-faithful: entry is a limit, 24h to fill
         market_dist — fill at once, SL/TP keep their DISTANCE (R preserved)
         market_lvl  — fill at once, SL/TP keep their original price LEVELS
       Returns dict(outcome, R, mins, filled). outcome UNRESOLVED = ran out of
       candles before the cap elapsed (excluded from stats, counted separately).
    """
    ts    = int(sig["timestamp"])
    entry = float(sig["entry"])
    sl    = float(sig["sl"])
    tp    = float(sig["tp"])
    buy   = sig.get("signal", "BUY") == "BUY"
    i     = slice_from(candles, ts)
    if i >= len(candles):
        return {"outcome": "UNRESOLVED", "R": 0.0, "mins": 0, "filled": False}

    if mode != "limit":
        # Market fill at the open of the next candle. Binance klines carry no
        # open in our cache tuple, so use the prior close — the price the desk
        # would actually have paid at signal time.
        fill = candles[i - 1][3] if i > 0 else candles[i][3]
        if mode == "market_dist":
            sl = fill - (entry - sl)
            tp = fill + (tp - entry)
        entry_px, filled, fill_i = fill, True, i
    else:
        entry_px, filled, fill_i = entry, False, None

    risk = abs(entry_px - sl)
    if risk <= 0:
        return {"outcome": "UNRESOLVED", "R": 0.0, "mins": 0, "filled": False}

    for j in range(i, len(candles)):
        t, high, low, close = candles[j]
        age = t - ts

        if not filled:
            if age > MAX_PENDING_MS:
                return {"outcome": "EXPIRED", "R": 0.0,
                        "mins": age // 60000, "filled": False}
            # run-away expiry: never touched and price has left without us
            if age > RUNAWAY_MS:
                gone = (close > entry * (1 + RUNAWAY_PCT)) if buy else \
                       (close < entry * (1 - RUNAWAY_PCT))
                if gone:
                    return {"outcome": "EXPIRED", "R": 0.0,
                            "mins": age // 60000, "filled": False}
            if (low <= entry) if buy else (high >= entry):
                filled, fill_i = True, j
            else:
                continue
        elif t - candles[fill_i][0] > MAX_FILLED_MS:
            r = ((close - entry_px) if buy else (entry_px - close)) / risk
            return {"outcome": "TIMEOUT", "R": r,
                    "mins": age // 60000, "filled": True}

        # SL before TP inside the candle — mirrors the live resolver
        if buy:
            if low <= sl:
                return {"outcome": "LOSS", "R": (sl - entry_px) / risk,
                        "mins": age // 60000, "filled": True}
            if high >= tp:
                return {"outcome": "WIN", "R": (tp - entry_px) / risk,
                        "mins": age // 60000, "filled": True}
        else:
            if high >= sl:
                return {"outcome": "LOSS", "R": (entry_px - sl) / risk,
                        "mins": age // 60000, "filled": True}
            if low <= tp:
                return {"outcome": "WIN", "R": (entry_px - tp) / risk,
                        "mins": age // 60000, "filled": True}

    return {"outcome": "UNRESOLVED", "R": 0.0, "mins": 0, "filled": filled}


# ──────────────────────────── aggregation ────────────────────────────────
class Bucket:
    __slots__ = ("n", "r", "win", "loss", "exp", "unres", "to")

    def __init__(self):
        self.n = self.win = self.loss = self.exp = self.unres = self.to = 0
        self.r = 0.0

    def add(self, res):
        o = res["outcome"]
        if o == "UNRESOLVED":
            self.unres += 1
            return
        if o == "EXPIRED":
            self.exp += 1
            return                       # no fill, no P&L, not a trade
        self.n += 1
        self.r += res["R"]
        if o == "WIN":
            self.win += 1
        elif o == "LOSS":
            self.loss += 1
        else:
            self.to += 1

    @property
    def avg(self):
        return self.r / self.n if self.n else 0.0

    @property
    def winpct(self):
        return 100 * self.win / self.n if self.n else 0.0


def table(title, buckets, keys=None, show_exp=True):
    print(f"── {title} ──")
    hdr = f"{'bucket':>10} {'trades':>7} {'win%':>6} {'avgR':>7} {'totR':>8}"
    if show_exp:
        hdr += f" {'unfilled':>9} {'fill%':>6}"
    print(hdr)
    for k in (keys if keys is not None else sorted(buckets)):
        b = buckets[k]
        if not b.n and not b.exp:
            continue
        line = (f"{str(k):>10} {b.n:>7} {b.winpct:>5.1f}% {b.avg:>+6.2f}R "
                f"{b.r:>+7.1f}R")
        if show_exp:
            tot = b.n + b.exp
            line += f" {b.exp:>9} {100*b.n/tot if tot else 0:>5.1f}%"
        print(line)
    print()


def totals(buckets):
    t = Bucket()
    for b in buckets.values():
        t.n += b.n; t.r += b.r; t.win += b.win; t.loss += b.loss
        t.exp += b.exp; t.unres += b.unres; t.to += b.to
    return t


# ──────────────────────────────── main ───────────────────────────────────
def main():
    refresh  = "--refresh" in sys.argv
    validate = "--validate" in sys.argv

    log  = json.load(open(SIGNALS_LOG))
    sigs = [s for s in log if s.get("symbol") in REPLAY_SYMBOLS]
    skipped = [s for s in log if s.get("symbol") not in REPLAY_SYMBOLS]
    counts = defaultdict(int)
    for s in sigs:
        counts[s["symbol"]] += 1
    print(f"signals: {len(log)} total — {len(sigs)} replayable "
          f"({', '.join(f'{k} {v}' for k, v in sorted(counts.items()))})"
          + (f", {len(skipped)} skipped" if skipped else "") + "\n")

    # Per-symbol windows: gold's last signal is days older than BTC's, and a
    # shared end date would make its cache look permanently incomplete.
    candles, now_ms = {}, int(time.time() * 1000)
    for sym in REPLAY_SYMBOLS:
        ts = [int(s["timestamp"]) for s in sigs if s["symbol"] == sym]
        if not ts:
            continue
        candles[sym] = load_candles(sym, min(ts) - 3600_000,
                                    min(max(ts) + MAX_FILLED_MS, now_ms), refresh)
    print()

    # ── replay every signal under all three entry styles ──────────────────
    runs = {}
    for mode in ("limit", "market_dist", "market_lvl"):
        runs[mode] = [(s, replay(s, candles[s["symbol"]], mode)) for s in sigs]

    # ── Q0: the log's EXPIRED bucket is not what it claims ────────────────
    print("=" * 74)
    print("Q0  DATA INTEGRITY — read this before trusting any number below")
    print("=" * 74)
    conf, per_era = defaultdict(int), defaultdict(lambda: [0, 0])
    for s, r in runs["limit"]:
        logged = s.get("outcome")
        if logged not in ("WIN", "LOSS", "EXPIRED"):
            continue
        got = {"TIMEOUT": "EXPIRED"}.get(r["outcome"], r["outcome"])
        if got == "UNRESOLVED":
            continue
        conf[(logged, got)] += 1
        if logged == "EXPIRED":
            per_era[era_of(s)][0] += 1
            per_era[era_of(s)][1] += got in ("WIN", "LOSS")
    agree = sum(n for (a, b), n in conf.items() if a == b)
    tot   = sum(conf.values())
    if validate:
        print(f"{'logged':>9} -> {'replay':<9} {'n':>5}")
        for (a, b), n in sorted(conf.items(), key=lambda x: -x[1]):
            print(f"{a:>9} -> {b:<9} {n:>5}{'   <-- agree' if a == b else ''}")
        print()
    print(f"replay reproduces {agree}/{tot} = {100*agree/tot if tot else 0:.1f}% "
          f"of logged verdicts. The disagreements are not noise:\n")
    print(f"{'era':>10} {'logged EXPIRED':>15} {'actually filled':>16} {'bogus%':>8}")
    for e in ("pre-fix", "post-fix"):
        n, bad = per_era[e]
        print(f"{e:>10} {n:>15} {bad:>16} {100*bad/n if n else 0:>7.0f}%")
    print(f"""
The resolver's expiry rules were retuned on {ERA_SPLIT}. Before that a filled
trade was zeroed to EXPIRED at 8h, so anything slow was logged as a no-fill;
those verdicts were never revisited. Every misclassified signal sits before the
fix and none after, so the current resolver is sound — but the historical log
is not. The `EXPIRED` bucket is a mix of genuine non-fills and stale verdicts,
which is why the tables below split on era rather than pooling.
""")

    # ── Q1: which UTC sessions pay ───────────────────────────────────────
    print("=" * 74)
    print("Q1  WHICH UTC SESSIONS PAY")
    print("=" * 74)
    print("The log has no session field — only 13 signals name one in `confluences`,")
    print("so sessions are derived from `sent_at` (UTC). Shown under the MARKET")
    print("entry so every signal contributes: the limit entry resolves only the")
    print("~25% that filled, which is itself the biased draw Q3 is about.\n")
    for mode, label in (("market_dist", "MARKET entry (R-preserving)"),
                        ("limit", "LIMIT entry (as traded)")):
        by_hour, by_sess = defaultdict(Bucket), defaultdict(Bucket)
        for s, r in runs[mode]:
            h = int(s["sent_at"][11:13])
            by_hour[f"{h:02d}:00"].add(r)
            by_sess[session_of(h)].add(r)
        table(f"by UTC hour — {label}", by_hour)
        table(f"by session — {label}", by_sess,
              keys=[n for n, _, _ in SESSIONS])
        t = totals(by_sess)
        print(f"   ALL: {t.n} trades, {t.winpct:.1f}% win, {t.avg:+.2f}R avg, "
              f"{t.r:+.1f}R total, {t.exp} unfilled\n")
    # sessions within the clean era only
    for era in ("pre-fix", "post-fix"):
        b = defaultdict(Bucket)
        for s, r in runs["market_dist"]:
            if era_of(s) == era:
                b[session_of(int(s["sent_at"][11:13]))].add(r)
        table(f"by session — MARKET entry, {era} signals only", b,
              keys=[n for n, _, _ in SESSIONS], show_exp=False)

    # ── Q2: is ETH structurally unprofitable ─────────────────────────────
    print("=" * 74)
    print("Q2  IS ETH STRUCTURALLY UNPROFITABLE")
    print("=" * 74)
    for mode, label in (("limit", "LIMIT entry (as traded)"),
                        ("market_dist", "MARKET entry (R-preserving)")):
        by_sym = defaultdict(Bucket)
        for s, r in runs[mode]:
            by_sym[s["symbol"]].add(r)
        table(f"by asset — {label}", by_sym)
    # ETH sliced every way, market entry — is the loss broad or concentrated?
    for dim, fn in (("era",       era_of),
                    ("strategy",  lambda s: s.get("strategy_tag") or "NONE"),
                    ("direction", lambda s: s.get("signal")),
                    ("session",   lambda s: session_of(int(s["sent_at"][11:13])))):
        for sym in REPLAY_SYMBOLS:
            b = defaultdict(Bucket)
            for s, r in runs["market_dist"]:
                if s["symbol"] == sym:
                    b[fn(s)].add(r)
            table(f"{sym} by {dim} — MARKET entry", b, show_exp=False)
    # Is ETH bad, or is one strategy on ETH bad? Strip its worst tag and see.
    print("── ETH with its dominant strategy removed — MARKET entry ──")
    print(f"{'slice':>28} {'trades':>7} {'win%':>6} {'avgR':>7} {'totR':>8}")
    for label, keep in (("ETH, all", lambda s: True),
                        ("ETH, minus EMA20_Pullback",
                         lambda s: s.get("strategy_tag") != "EMA20_Pullback")):
        b = Bucket()
        for s, r in runs["market_dist"]:
            if s["symbol"] == "ETHUSDT" and keep(s):
                b.add(r)
        print(f"{label:>28} {b.n:>7} {b.winpct:>5.1f}% {b.avg:>+6.2f}R "
              f"{b.r:>+7.1f}R")
    print()
    # the direct question: ETH vs BTC on identical footing
    print("── ETH vs BTC, MARKET entry, post-fix era only ──")
    print(f"{'asset':>10} {'trades':>7} {'win%':>6} {'avgR':>7} {'totR':>8}")
    for sym in REPLAY_SYMBOLS:
        b = Bucket()
        for s, r in runs["market_dist"]:
            if s["symbol"] == sym and era_of(s) == "post-fix":
                b.add(r)
        print(f"{sym:>10} {b.n:>7} {b.winpct:>5.1f}% {b.avg:>+6.2f}R {b.r:>+7.1f}R")
    print()

    # ── Q3: limit vs market ──────────────────────────────────────────────
    print("=" * 74)
    print("Q3  DOES THE LIMIT ENTRY LOSE TO A MARKET ENTRY")
    print("=" * 74)
    by_mode = {}
    for mode in ("limit", "market_dist", "market_lvl"):
        b = defaultdict(Bucket)
        for s, r in runs[mode]:
            b["all"].add(r)
        by_mode[mode] = b["all"]
    print(f"{'entry style':>14} {'trades':>7} {'win%':>6} {'avgR':>7} "
          f"{'totR':>8} {'unfilled':>9}")
    for mode, label in (("limit", "limit"), ("market_dist", "market (dist)"),
                        ("market_lvl", "market (levels)")):
        b = by_mode[mode]
        print(f"{label:>14} {b.n:>7} {b.winpct:>5.1f}% {b.avg:>+6.2f}R "
              f"{b.r:>+7.1f}R {b.exp:>9}")
    print("""
Read `market (dist)` as the headline: it pays the worse entry price but keeps
the risk unit, so R stays comparable to the limit. `market (levels)` keeps the
original SL/TP prices, so entering late lands you nearer TP and further from
SL — its 66% win rate is that geometry, not skill, and its R is worth less.
Both assume a fill at the candle close on signal, i.e. no latency or spread.
""")
    # The adverse-selection question proper: how do the signals the limit never
    # filled behave when taken at market? Uses the REPLAY's fill verdict, not
    # the log's — 83 of the log's "expired" did fill (see Q0).
    lim = {id(s): r for s, r in runs["limit"]}
    never = defaultdict(Bucket)
    for s, r in runs["market_dist"]:
        k = ("limit filled" if lim[id(s)]["outcome"] not in ("EXPIRED", "UNRESOLVED")
             else "limit never filled")
        never[k].add(r)
    table("market-entry result, split by what the limit ACTUALLY did (replayed)",
          never, keys=["limit filled", "limit never filled"], show_exp=False)
    a, b = never["limit filled"], never["limit never filled"]
    if a.n and b.n:
        print(f"Adverse selection = {a.avg - b.avg:+.2f}R per trade: the setups the")
        print("limit caught performed this much better/worse than the ones it missed.")
        print("A negative gap means waiting for the retrace selected losers.\n")
    print("Genuine non-fill rate (replayed, not from the log):")
    for era in ("pre-fix", "post-fix"):
        n = sum(1 for s, r in runs["limit"]
                if era_of(s) == era and r["outcome"] != "UNRESOLVED")
        e = sum(1 for s, r in runs["limit"]
                if era_of(s) == era and r["outcome"] == "EXPIRED")
        print(f"  {era:>9}: {e}/{n} = {100*e/n if n else 0:.0f}% never filled "
              f"(log claims {sum(1 for s, _ in runs['limit'] if era_of(s) == era and s.get('outcome') == 'EXPIRED')})")
    print()

    # ── Q4: ATR_Trailing beyond n=10 ─────────────────────────────────────
    print("=" * 74)
    print("Q4  DOES ATR_TRAILING HOLD UP BEYOND n=10")
    print("=" * 74)
    print("Two caveats sink the naive read:")
    print("  1. No signal in the log carries a `trailing_sl` block, so the")
    print("     resolver's trail code never engaged — ATR_Trailing is a TAG,")
    print("     resolved as a plain SL/TP trade like everything else.")
    print(f"  2. All 16 ATR_Trailing signals are post-{ERA_SPLIT}; its rivals are")
    print("     mostly pre-fix. Comparing them pooled scores a strategy measured")
    print("     by the fixed resolver against ones measured by the broken one.\n")
    for mode, label in (("limit", "LIMIT entry (as traded)"),
                        ("market_dist", "MARKET entry (R-preserving)")):
        b = defaultdict(Bucket)
        for s, r in runs[mode]:
            b[s.get("strategy_tag") or "NONE"].add(r)
        table(f"by strategy — {label}", b,
              keys=sorted(b, key=lambda k: -(b[k].n + b[k].exp)))
    # the only fair comparison: same era, same entry style
    b = defaultdict(Bucket)
    for s, r in runs["market_dist"]:
        if era_of(s) == "post-fix":
            b[s.get("strategy_tag") or "NONE"].add(r)
    table("by strategy — MARKET entry, post-fix era ONLY (like for like)", b,
          keys=sorted(b, key=lambda k: -b[k].n), show_exp=False)
    # ATR_Trailing's own span — 16 signals over how many days?
    atr = [s for s, _ in runs["limit"] if s.get("strategy_tag") == "ATR_Trailing"]
    if atr:
        days = sorted({s["sent_at"][:10] for s in atr})
        print(f"ATR_Trailing spans {len(days)} distinct days "
              f"({days[0]} -> {days[-1]}) across {len(atr)} signals — a single")
        print("market regime, so treat any edge here as unproven rather than real.\n")

    unres = sum(1 for _, r in runs["market_dist"] if r["outcome"] == "UNRESOLVED")
    if unres:
        print(f"note: {unres} signals too recent to resolve within the candle "
              f"window — excluded from all tables above.")


if __name__ == "__main__":
    main()
