"""
backtester.py — Strategy backtester with Trailing Stop Loss
Tests multiple scalping and swing strategies on collected M1/M5/H1 data.

TSL Rules (XAUUSD scalping):
  At 1:1  → move SL to breakeven
  At 1:2  → move SL to +1.5R (lock in 1.5R profit)
  At 1:3  → move SL to +2.5R
  At 1:4  → move SL to +3.5R
  Unlimited upside trail beyond that.

Max drawdown guards:
  - Scalping: 500 pips hard stop (also tested at 1000 pips)
  - Swing:    configurable per strategy
"""

import csv
import io
import json
import math
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

DATA_DIR    = Path(__file__).parent / "data"
RESULTS_DIR = Path(__file__).parent / "results"
RESULTS_DIR.mkdir(exist_ok=True)

# ── Data loading ───────────────────────────────────────────────────────────────

def load_csv(path: Path) -> list[dict]:
    rows = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            rows.append({
                "time":   row["time"],
                "open":   float(row["open"]),
                "high":   float(row["high"]),
                "low":    float(row["low"]),
                "close":  float(row["close"]),
                "volume": float(row["tick_volume"]),
                "spread": float(row.get("spread") or 0),   # MT5 spread in points (CFD cost)
            })
    return rows


def load_symbol_tf(symbol: str, tf: str) -> list[dict]:
    """Load and merge all CSV files for a symbol+timeframe."""
    files = sorted(DATA_DIR.glob(f"{symbol}_{tf}_*.csv"))
    if not files:
        return []
    merged = []
    seen = set()
    for f in files:
        for row in load_csv(f):
            if row["time"] not in seen:
                merged.append(row)
                seen.add(row["time"])
    return sorted(merged, key=lambda r: r["time"])


# ── Indicator helpers ──────────────────────────────────────────────────────────

def ema(values: list[float], period: int) -> list[Optional[float]]:
    k = 2 / (period + 1)
    out = [None] * len(values)
    for i in range(len(values)):
        if i < period - 1:
            continue
        if i == period - 1:
            out[i] = sum(values[i - period + 1:i + 1]) / period
        else:
            out[i] = values[i] * k + out[i - 1] * (1 - k)
    return out


def sma(values: list[float], period: int) -> list[Optional[float]]:
    out = [None] * len(values)
    for i in range(period - 1, len(values)):
        out[i] = sum(values[i - period + 1:i + 1]) / period
    return out


def atr(candles: list[dict], period: int = 14) -> list[Optional[float]]:
    trs = [None]
    for i in range(1, len(candles)):
        tr = max(
            candles[i]["high"] - candles[i]["low"],
            abs(candles[i]["high"] - candles[i - 1]["close"]),
            abs(candles[i]["low"]  - candles[i - 1]["close"]),
        )
        trs.append(tr)
    out = [None] * len(candles)
    for i in range(period, len(candles)):
        out[i] = sum(t for t in trs[i - period + 1:i + 1] if t is not None) / period
    return out


def rsi(values: list[float], period: int = 14) -> list[Optional[float]]:
    out = [None] * len(values)
    gains, losses = [], []
    for i in range(1, len(values)):
        d = values[i] - values[i - 1]
        gains.append(max(d, 0))
        losses.append(max(-d, 0))
        if i >= period:
            ag = sum(gains[-period:]) / period
            al = sum(losses[-period:]) / period
            out[i] = 100 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def bollinger(values: list[float], period: int = 20, std_mult: float = 2.0):
    mid  = sma(values, period)
    upper, lower = [None]*len(values), [None]*len(values)
    for i in range(period - 1, len(values)):
        window = values[i - period + 1:i + 1]
        s = (sum((x - mid[i])**2 for x in window) / period) ** 0.5
        upper[i] = mid[i] + std_mult * s
        lower[i] = mid[i] - std_mult * s
    return mid, upper, lower


def pivot_high_low(candles: list[dict], lookback: int = 10):
    ph = [None] * len(candles)
    pl  = [None] * len(candles)
    for i in range(lookback, len(candles)):
        win = candles[i - lookback:i + 1]
        ph[i] = max(c["high"] for c in win)
        pl[i]  = min(c["low"]  for c in win)
    return ph, pl


# ── TSL engine ─────────────────────────────────────────────────────────────────

@dataclass
class TSLLevels:
    """Trailing stop rules: list of (trigger_R, lock_R) tuples."""
    levels: list[tuple[float, float]] = field(default_factory=lambda: [
        (1.0, 0.0),    # at 1R → move to breakeven
        (2.0, 1.5),    # at 2R → lock in 1.5R
        (3.0, 2.5),    # at 3R → lock in 2.5R
        (4.0, 3.5),    # at 4R → lock in 3.5R
    ])


def apply_tsl(
    candles: list[dict],
    entry_idx: int,
    entry: float,
    initial_sl: float,
    tp: float,
    is_buy: bool,
    tsl: TSLLevels,
    max_bars: int = 200,
) -> tuple[bool, float, float, int]:
    """
    Simulate trade with TSL. Returns (win, exit_price, max_adverse_excursion, bars_held).
    """
    risk = abs(entry - initial_sl)
    if risk <= 0:
        return False, entry, 0, 0

    current_sl = initial_sl
    locked_r   = -1.0  # tracks which TSL level is currently active

    for j in range(entry_idx + 1, min(entry_idx + max_bars, len(candles))):
        h, l = candles[j]["high"], candles[j]["low"]
        c    = candles[j]["close"]

        if is_buy:
            # Check if any TSL level triggers (use high of bar)
            current_r = (h - entry) / risk
            for trigger_r, lock_r in reversed(tsl.levels):
                if current_r >= trigger_r and lock_r > locked_r:
                    new_sl = entry + lock_r * risk
                    if new_sl > current_sl:
                        current_sl = new_sl
                        locked_r   = lock_r
                    break
            # Check SL hit (use low)
            if l <= current_sl:
                return False, current_sl, abs(entry - current_sl) / risk, j - entry_idx
            # Check TP hit (use high)
            if h >= tp:
                return True, tp, 0, j - entry_idx
        else:
            # SELL
            current_r = (entry - l) / risk
            for trigger_r, lock_r in reversed(tsl.levels):
                if current_r >= trigger_r and lock_r > locked_r:
                    new_sl = entry - lock_r * risk
                    if new_sl < current_sl:
                        current_sl = new_sl
                        locked_r   = lock_r
                    break
            if h >= current_sl:
                return False, current_sl, abs(entry - current_sl) / risk, j - entry_idx
            if l <= tp:
                return True, tp, 0, j - entry_idx

    # Time exit: close at last candle
    final_close = candles[min(entry_idx + max_bars, len(candles) - 1)]["close"]
    win = (final_close > entry) if is_buy else (final_close < entry)
    return win, final_close, 0, max_bars


# ── Strategy definitions ───────────────────────────────────────────────────────

class Strategy:
    name: str
    timeframe: str
    category: str   # "scalp" | "swing"
    rr_ratio: float = 2.0

    def signals(self, candles: list[dict]) -> list[dict]:
        """Return list of {idx, side, entry, sl, tp}."""
        raise NotImplementedError


class EMA_Crossover_RSI(Strategy):
    """EMA 8/21 crossover + RSI filter. Scalping on M1/M5."""
    name      = "EMA_8_21_RSI"
    timeframe = "M5"
    category  = "scalp"
    rr_ratio  = 2.0

    def __init__(self, fast=8, slow=21, rsi_p=14, rsi_os=40, rsi_ob=60, atr_mult=1.5):
        self.fast, self.slow = fast, slow
        self.rsi_p, self.rsi_os, self.rsi_ob = rsi_p, rsi_os, rsi_ob
        self.atr_mult = atr_mult

    def signals(self, candles):
        closes = [c["close"] for c in candles]
        fast_e = ema(closes, self.fast)
        slow_e = ema(closes, self.slow)
        rsi_v  = rsi(closes, self.rsi_p)
        atr_v  = atr(candles, 14)
        sigs   = []
        for i in range(self.slow + 2, len(candles) - 1):
            if any(v is None for v in [fast_e[i], slow_e[i], fast_e[i-1], slow_e[i-1], rsi_v[i], atr_v[i]]):
                continue
            a = atr_v[i]
            c = closes[i]
            crossed_up   = fast_e[i-1] <= slow_e[i-1] and fast_e[i] > slow_e[i]
            crossed_down = fast_e[i-1] >= slow_e[i-1] and fast_e[i] < slow_e[i]
            if crossed_up and rsi_v[i] > self.rsi_os:
                sl = c - a * self.atr_mult
                sigs.append({"idx": i, "side": "BUY",  "entry": c, "sl": sl, "tp": c + (c - sl) * self.rr_ratio})
            elif crossed_down and rsi_v[i] < self.rsi_ob:
                sl = c + a * self.atr_mult
                sigs.append({"idx": i, "side": "SELL", "entry": c, "sl": sl, "tp": c - (sl - c) * self.rr_ratio})
        return sigs


class BB_RSI_Reversal(Strategy):
    """Bollinger Band outer touch + RSI divergence. Scalp on M5."""
    name      = "BB_RSI_Reversal"
    timeframe = "M5"
    category  = "scalp"
    rr_ratio  = 1.8

    def signals(self, candles):
        closes = [c["close"] for c in candles]
        mid, upper, lower = bollinger(closes, 20, 2.0)
        rsi_v = rsi(closes, 14)
        atr_v = atr(candles, 14)
        sigs  = []
        for i in range(22, len(candles) - 1):
            if any(v is None for v in [upper[i], lower[i], rsi_v[i], atr_v[i]]):
                continue
            a = atr_v[i]
            c = closes[i]
            if closes[i-1] <= lower[i-1] and c > lower[i] and rsi_v[i] < 35:
                sl = c - a * 1.2
                sigs.append({"idx": i, "side": "BUY",  "entry": c, "sl": sl, "tp": c + (c-sl)*self.rr_ratio})
            elif closes[i-1] >= upper[i-1] and c < upper[i] and rsi_v[i] > 65:
                sl = c + a * 1.2
                sigs.append({"idx": i, "side": "SELL", "entry": c, "sl": sl, "tp": c - (sl-c)*self.rr_ratio})
        return sigs


class SR_Bounce_Scalp(Strategy):
    """Support/Resistance bounce with momentum confirmation. Scalp M1/M5."""
    name      = "SR_Bounce_Scalp"
    timeframe = "M5"
    category  = "scalp"
    rr_ratio  = 2.0

    def __init__(self, lookback=20, zone_pct=0.001, atr_mult=1.2):
        self.lookback  = lookback
        self.zone_pct  = zone_pct
        self.atr_mult  = atr_mult

    def signals(self, candles):
        closes = [c["close"] for c in candles]
        ph, pl = pivot_high_low(candles, self.lookback)
        rsi_v  = rsi(closes, 9)
        ema_f  = ema(closes, 9)
        ema_s  = ema(closes, 21)
        atr_v  = atr(candles, 14)
        sigs   = []
        last_sup = last_res = None
        for i in range(self.lookback + 2, len(candles) - 1):
            if any(v is None for v in [ph[i], pl[i], rsi_v[i], ema_f[i], ema_s[i], atr_v[i]]):
                continue
            a = atr_v[i]; c = closes[i]
            # BUY near support
            if c <= pl[i] * (1 + self.zone_pct) and rsi_v[i] < 45 and ema_f[i] > ema_s[i]:
                if last_sup is None or abs(pl[i] - last_sup) / last_sup > 0.002:
                    sl = pl[i] - a * self.atr_mult
                    sigs.append({"idx": i, "side": "BUY",  "entry": c, "sl": sl, "tp": c+(c-sl)*self.rr_ratio})
                    last_sup = pl[i]
            # SELL near resistance
            elif c >= ph[i] * (1 - self.zone_pct) and rsi_v[i] > 55 and ema_f[i] < ema_s[i]:
                if last_res is None or abs(ph[i] - last_res) / last_res > 0.002:
                    sl = ph[i] + a * self.atr_mult
                    sigs.append({"idx": i, "side": "SELL", "entry": c, "sl": sl, "tp": c-(sl-c)*self.rr_ratio})
                    last_res = ph[i]
        return sigs


class EMA_Pullback_Swing(Strategy):
    """EMA 50/200 trend + H1 pullback entry. Swing trading."""
    name      = "EMA_Pullback_Swing"
    timeframe = "H1"
    category  = "swing"
    rr_ratio  = 3.0

    def signals(self, candles):
        closes = [c["close"] for c in candles]
        ema50  = ema(closes, 50)
        ema200 = ema(closes, 200)
        ema21  = ema(closes, 21)
        atr_v  = atr(candles, 14)
        rsi_v  = rsi(closes, 14)
        sigs   = []
        for i in range(205, len(candles) - 1):
            if any(v is None for v in [ema50[i], ema200[i], ema21[i], atr_v[i], rsi_v[i]]):
                continue
            a = atr_v[i]; c = closes[i]
            bull_trend = ema50[i] > ema200[i]
            bear_trend = ema50[i] < ema200[i]
            # Pull back to 21 EMA in bull trend
            if bull_trend and c <= ema21[i] * 1.002 and c >= ema21[i] * 0.998 and rsi_v[i] < 55:
                sl = c - a * 2.0
                sigs.append({"idx": i, "side": "BUY",  "entry": c, "sl": sl, "tp": c+(c-sl)*self.rr_ratio})
            elif bear_trend and c >= ema21[i] * 0.998 and c <= ema21[i] * 1.002 and rsi_v[i] > 45:
                sl = c + a * 2.0
                sigs.append({"idx": i, "side": "SELL", "entry": c, "sl": sl, "tp": c-(sl-c)*self.rr_ratio})
        return sigs


class RSI_Divergence_Swing(Strategy):
    """RSI divergence on H1 for swing entries."""
    name      = "RSI_Divergence_Swing"
    timeframe = "H1"
    category  = "swing"
    rr_ratio  = 3.5

    def signals(self, candles):
        closes = [c["close"] for c in candles]
        rsi_v  = rsi(closes, 14)
        atr_v  = atr(candles, 14)
        ema200 = ema(closes, 200)
        sigs   = []
        lb = 10
        for i in range(200 + lb, len(candles) - 1):
            if any(v is None for v in [rsi_v[i], atr_v[i], ema200[i]]):
                continue
            a = atr_v[i]; c = closes[i]
            # Bullish divergence: price makes lower low, RSI makes higher low
            price_ll = c < min(candles[j]["close"] for j in range(i-lb, i))
            rsi_hl   = rsi_v[i] > min(rsi_v[j] for j in range(i-lb, i) if rsi_v[j] is not None)
            above_200 = c > ema200[i] * 0.99  # near or above long-term trend
            if price_ll and rsi_hl and rsi_v[i] < 40 and above_200:
                sl = c - a * 2.5
                sigs.append({"idx": i, "side": "BUY",  "entry": c, "sl": sl, "tp": c+(c-sl)*self.rr_ratio})
            # Bearish divergence
            price_hh = c > max(candles[j]["close"] for j in range(i-lb, i))
            rsi_lh   = rsi_v[i] < max(r for r in [rsi_v[j] for j in range(i-lb, i)] if r is not None)
            below_200 = c < ema200[i] * 1.01
            if price_hh and rsi_lh and rsi_v[i] > 60 and below_200:
                sl = c + a * 2.5
                sigs.append({"idx": i, "side": "SELL", "entry": c, "sl": sl, "tp": c-(sl-c)*self.rr_ratio})
        return sigs


class VWAP_Reversion_Scalp(Strategy):
    """Intraday VWAP mean reversion. M1 scalping."""
    name      = "VWAP_Reversion"
    timeframe = "M1"
    category  = "scalp"
    rr_ratio  = 1.5

    def signals(self, candles):
        # Approximate VWAP as cumulative (price * volume) / cumulative volume, reset daily
        closes  = [c["close"] for c in candles]
        atr_v   = atr(candles, 14)
        rsi_v   = rsi(closes, 9)
        vwap    = [None] * len(candles)
        cum_pv = cum_v = 0
        prev_date = ""
        for i, c in enumerate(candles):
            date = c["time"][:10]
            if date != prev_date:
                cum_pv = cum_v = 0
                prev_date = date
            typical = (c["high"] + c["low"] + c["close"]) / 3
            cum_pv += typical * c["volume"]
            cum_v  += c["volume"]
            vwap[i] = cum_pv / cum_v if cum_v > 0 else None

        sigs = []
        for i in range(20, len(candles) - 1):
            if any(v is None for v in [vwap[i], atr_v[i], rsi_v[i]]):
                continue
            a  = atr_v[i]; cl = closes[i]; vw = vwap[i]
            # Price pulls back to VWAP from above (bullish)
            if cl <= vw * 1.001 and cl >= vw * 0.998 and rsi_v[i] < 50:
                sl = cl - a * 1.0
                sigs.append({"idx": i, "side": "BUY",  "entry": cl, "sl": sl, "tp": cl+(cl-sl)*self.rr_ratio})
            # Price pulls back to VWAP from below (bearish)
            elif cl >= vw * 0.999 and cl <= vw * 1.002 and rsi_v[i] > 50:
                sl = cl + a * 1.0
                sigs.append({"idx": i, "side": "SELL", "entry": cl, "sl": sl, "tp": cl-(sl-cl)*self.rr_ratio})
        return sigs


class Book_Pressure_Scalp(Strategy):
    """
    OHLCV approximation of Wu (2024) Q-Trading order book pressure signal.

    Core signal: candle close ratio bp = (close-low)/(high-low) proxies
    intrabar bid/ask imbalance. High bp (>0.65) = buyers dominated the bar.
    Low bp (<0.35) = sellers dominated. Requires persistence (2 consecutive
    bars) + EMA trend filter + volume confirmation to reduce noise.

    Inventory penalty principle from Q-Trading preserved:
    - Tight RR 1.5 (quick profit taking)
    - TSL moves to breakeven at 1R (never let winner turn loser)
    """
    name      = "Book_Pressure_Scalp"
    timeframe = "M1"
    category  = "scalp"
    rr_ratio  = 1.5

    def __init__(self, bp_high=0.65, bp_low=0.35, ema_p=21,
                 rsi_p=9, vol_lookback=20, vol_ratio=0.8,
                 atr_mult=1.0, min_range_atr=0.5):
        self.bp_high       = bp_high
        self.bp_low        = bp_low
        self.ema_p         = ema_p
        self.rsi_p         = rsi_p
        self.vol_lookback  = vol_lookback
        self.vol_ratio     = vol_ratio
        self.atr_mult      = atr_mult
        self.min_range_atr = min_range_atr

    def signals(self, candles):
        closes  = [c["close"] for c in candles]
        highs   = [c["high"]  for c in candles]
        lows    = [c["low"]   for c in candles]
        volumes = [c["volume"] for c in candles]

        ema_v = ema(closes, self.ema_p)
        rsi_v = rsi(closes, self.rsi_p)
        atr_v = atr(candles, 14)

        # Book pressure proxy: where did the candle close within its range?
        bp = []
        for i in range(len(candles)):
            rng = highs[i] - lows[i]
            bp.append((closes[i] - lows[i]) / rng if rng > 0 else 0.5)

        # Volume moving average
        vol_ma = sma(volumes, self.vol_lookback)

        sigs = []
        start = max(self.ema_p + 1, self.rsi_p + 1, self.vol_lookback + 1, 15)

        for i in range(start, len(candles) - 1):
            if any(v is None for v in [ema_v[i], rsi_v[i], atr_v[i], vol_ma[i]]):
                continue

            a   = atr_v[i]
            c   = closes[i]
            rng = highs[i] - lows[i]

            # Skip indecisive micro-candles (range too small vs ATR)
            if rng < self.min_range_atr * a:
                continue

            vol_ok = volumes[i] >= self.vol_ratio * vol_ma[i]

            # BUY: high pressure on 2 consecutive bars + uptrend + not overbought
            if (bp[i] > self.bp_high and bp[i-1] > self.bp_high
                    and c > ema_v[i] and rsi_v[i] < 70 and vol_ok):
                sl = c - a * self.atr_mult
                risk = c - sl
                if risk > 0:
                    sigs.append({"idx": i, "side": "BUY",
                                 "entry": c, "sl": sl,
                                 "tp": c + risk * self.rr_ratio})

            # SELL: low pressure on 2 consecutive bars + downtrend + not oversold
            elif (bp[i] < self.bp_low and bp[i-1] < self.bp_low
                    and c < ema_v[i] and rsi_v[i] > 30 and vol_ok):
                sl = c + a * self.atr_mult
                risk = sl - c
                if risk > 0:
                    sigs.append({"idx": i, "side": "SELL",
                                 "entry": c, "sl": sl,
                                 "tp": c - risk * self.rr_ratio})

        return sigs


class Book_Pressure_Scalp_M5(Book_Pressure_Scalp):
    """Same logic on M5 — slightly wider zone to account for candle aggregation."""
    name      = "Book_Pressure_Scalp_M5"
    timeframe = "M5"
    category  = "scalp"
    rr_ratio  = 1.8

    def __init__(self):
        super().__init__(bp_high=0.68, bp_low=0.32, ema_p=21,
                         rsi_p=9, vol_lookback=20, vol_ratio=0.75,
                         atr_mult=1.2, min_range_atr=0.4)


class Retest_Breakout(Strategy):
    """
    Breakout-Retest strategy — scalp and swing variant.

    Logic:
      1. Detect a structural breakout: close breaks above a swing high (bullish)
         or below a swing low (bearish) with momentum (volume or ATR expansion).
      2. Mark the broken level as the retest zone.
      3. Wait for price to pull back INTO that level (former resistance now support,
         or former support now resistance).
      4. Enter on the first bar that closes BACK on the correct side of the level
         with RSI confirmation (not overbought on BUY, not oversold on SELL).
      5. SL: below/above the retest zone by 1 ATR.
      6. TP: RR × risk.

    One-signal-per-level gate (MIN_GAP = 0.2%) prevents firing on the same zone twice.
    """
    name      = "Retest_Breakout"
    timeframe = "M5"
    category  = "scalp"
    rr_ratio  = 2.5

    def __init__(self, lookback=20, zone_pct=0.0015, atr_mult=1.0,
                 min_gap=0.002, rsi_period=14):
        self.lookback   = lookback
        self.zone_pct   = zone_pct   # how close price must be to the level for retest
        self.atr_mult   = atr_mult
        self.min_gap    = min_gap
        self.rsi_period = rsi_period

    def signals(self, candles):
        closes  = [c["close"] for c in candles]
        highs   = [c["high"]  for c in candles]
        lows    = [c["low"]   for c in candles]
        atr_v   = atr(candles, 14)
        rsi_v   = rsi(closes, self.rsi_period)
        lb      = self.lookback

        sigs          = []
        broken_levels = []   # list of {level, side, bar_broken}
        last_bull_lvl = None
        last_bear_lvl = None

        for i in range(lb + 2, len(candles) - 1):
            if atr_v[i] is None or rsi_v[i] is None:
                continue
            a  = atr_v[i]
            c  = closes[i]
            cp = closes[i - 1]

            # ── Detect new breakouts ──────────────────────────────────────────
            # Swing high of last `lb` bars (excluding current)
            swing_high = max(highs[i - lb:i])
            swing_low  = min(lows[i  - lb:i])

            # Bullish breakout: close crosses above swing high
            if cp <= swing_high and c > swing_high * 1.001:
                if last_bull_lvl is None or abs(swing_high - last_bull_lvl) / last_bull_lvl > self.min_gap:
                    broken_levels.append({"level": swing_high, "side": "BUY", "bar": i})
                    last_bull_lvl = swing_high

            # Bearish breakout: close crosses below swing low
            if cp >= swing_low and c < swing_low * 0.999:
                if last_bear_lvl is None or abs(swing_low - last_bear_lvl) / last_bear_lvl > self.min_gap:
                    broken_levels.append({"level": swing_low, "side": "SELL", "bar": i})
                    last_bear_lvl = swing_low

            # ── Check if current bar is a retest of any marked level ──────────
            active = [lv for lv in broken_levels if i - lv["bar"] >= 2]  # at least 2 bars after break
            for lv in active:
                lvl  = lv["level"]
                side = lv["side"]

                if side == "BUY":
                    # Retest: price pulls back to the broken resistance (now support)
                    in_zone  = lvl * (1 - self.zone_pct) <= c <= lvl * (1 + self.zone_pct)
                    confirm  = c > lvl and rsi_v[i] < 65   # close above level, not overbought
                    if in_zone and confirm:
                        sl = lvl - a * self.atr_mult
                        risk = c - sl
                        if risk > 0:
                            sigs.append({
                                "idx":  i,
                                "side": "BUY",
                                "entry": c,
                                "sl":   sl,
                                "tp":   c + risk * self.rr_ratio,
                            })
                        broken_levels.remove(lv)  # one signal per level
                        break

                else:  # SELL
                    # Retest: price pulls back to the broken support (now resistance)
                    in_zone = lvl * (1 - self.zone_pct) <= c <= lvl * (1 + self.zone_pct)
                    confirm = c < lvl and rsi_v[i] > 35   # close below level, not oversold
                    if in_zone and confirm:
                        sl = lvl + a * self.atr_mult
                        risk = sl - c
                        if risk > 0:
                            sigs.append({
                                "idx":  i,
                                "side": "SELL",
                                "entry": c,
                                "sl":   sl,
                                "tp":   c - risk * self.rr_ratio,
                            })
                        broken_levels.remove(lv)
                        break

            # Expire stale levels (older than 100 bars with no retest)
            broken_levels = [lv for lv in broken_levels if i - lv["bar"] < 100]

        return sigs


class Retest_Breakout_Swing(Retest_Breakout):
    """Same logic on H1 for swing trades with wider zones and higher RR."""
    name      = "Retest_Breakout_Swing"
    timeframe = "H1"
    category  = "swing"
    rr_ratio  = 3.0

    def __init__(self):
        super().__init__(lookback=20, zone_pct=0.003, atr_mult=1.5,
                         min_gap=0.003, rsi_period=14)


class ORB_Session_Breakout(Strategy):
    """2-hour opening-range breakout, held overnight (STBT).

    Source: face-to-face interview with a systematic NSE options seller
    (Jul 2026). His positional leg: mark the 09:15-11:15 range; a break above
    the high is bullish (he sells an ITM put), a break below is bearish (sells
    an ITM call); SL 0.5% ON THE UNDERLYING; exit next morning ~09:35. The
    options wrapper is TradingBrain's job (TB009) - here we test the
    directional core on futures/CFD data: BUY the first close above the range
    high / SELL the first close below the low, SL 0.5% of entry, no profit
    target (tp parked 10R away) so the exit is the 0.5% stop or the engine's
    time exit. One trade per day, first breakout only (his once-only re-entry
    is deliberately dropped - it doubles the day's risk for an unproven add).

    For 24h symbols (gold/crypto) the "session open" is the data day's first
    bar, so the range is the first 2 hours after midnight server time - a
    weaker anchor than a cash-market open; judge those results accordingly.
    """
    name      = "ORB_2H_Breakout"
    timeframe = "M5"
    category  = "swing"
    rr_ratio  = 1.0   # unused: no profit target, exit = stop or time exit

    def __init__(self, range_bars=24, sl_pct=0.005):
        self.range_bars = range_bars   # 24 x M5 = the 2-hour opening range
        self.sl_pct     = sl_pct

    def signals(self, candles):
        # Day boundaries from the timestamp's date part.
        starts, cur_day = [], None
        for i, c in enumerate(candles):
            d = c["time"][:10]
            if d != cur_day:
                starts.append(i)
                cur_day = d
        starts.append(len(candles))

        sigs = []
        for k in range(len(starts) - 1):
            s, e = starts[k], starts[k + 1]
            if e - s <= self.range_bars + 1:
                continue  # short/holiday session: no room to trade the range
            hi = max(c["high"] for c in candles[s:s + self.range_bars])
            lo = min(c["low"] for c in candles[s:s + self.range_bars])
            for j in range(s + self.range_bars, e):
                c = candles[j]["close"]
                if c > hi:
                    sl = c * (1 - self.sl_pct)
                    sigs.append({"idx": j, "side": "BUY", "entry": c,
                                 "sl": sl, "tp": c + (c - sl) * 10})
                    break
                if c < lo:
                    sl = c * (1 + self.sl_pct)
                    sigs.append({"idx": j, "side": "SELL", "entry": c,
                                 "sl": sl, "tp": c - (sl - c) * 10})
                    break
        return sigs


# ── ML Trader (kernel-regression MLMA confluence) ───────────────────────────────
# Python port of the tradable core of the "[Quadapt] Machine Learning Trader"
# TradingView indicator. The full indicator is a discretionary context aggregator;
# here we keep only the parts that emit a BUY/SELL with a stop and a target:
#
#   1. MLMA  — a kernel-regression moving average + volatility band ("cloud").
#              In the source Pine this is a FIXED linear FIR filter: the kernel
#              weights are solved ONCE from the Gram matrix over integer bar
#              positions, then applied as a dot product on the trailing price
#              window. That ports exactly (np.linalg.solve on K + reg·I). The
#              cloud gives the directional context (trend = 1 bull / 0 bear).
#   2. Dual-length signal engine — the "range-contraction ended" breakout trigger
#              on a synthetic-distance envelope, at a primary and (optional)
#              secondary length, combined Independent / Consensus / Primary.
#   3. Signal Quality Engine — every raw signal is scored 0-100 across MLMA
#              context, multi-timeframe slope alignment, momentum, volatility and
#              volume, then rejected below a threshold or in a no-trade regime.
#   4. SL (swing / ATR) and adaptive Fibonacci-extension TP. The indicator draws
#              several TP ladders; AlphaEdge trades one bracket + trailing SL, so
#              we surface the primary Fib target as `tp` and let apply_tsl() trail.
#   5. Adaptive clustering prevention — drop signals bunched in time and price.

_ML_KERNEL_PARAMS = {
    "rbf_ls": 1.0, "poly_gamma": 1.0, "poly_coef0": 1.0, "poly_degree": 3,
    "sig_gamma": 0.01, "sig_coef0": 0.0, "lap_gamma": 1.0, "mat_ls": 1.0,
    "per_ls": 1.0, "per_period": 1.0,
}


def _ml_kernel(x1: float, x2: float, window: int, ktype: str, p: dict) -> float:
    """Kernel over integer bar POSITIONS in [0, window), distances normalised by
    the window size — matching the source indicator exactly."""
    if ktype == "Linear":
        return (x1 * x2) / (window * window)
    if ktype == "Polynomial":
        base = p["poly_gamma"] * (x1 / window) * (x2 / window) + p["poly_coef0"]
        return max(0.001, base) ** p["poly_degree"]
    if ktype == "Sigmoid":
        v = p["sig_gamma"] * (x1 / window) * (x2 / window) + p["sig_coef0"]
        return math.tanh(max(-10.0, min(10.0, v)))
    if ktype == "Laplacian":
        return math.exp(-p["lap_gamma"] * abs(x1 - x2) / window)
    if ktype == "Matern":  # nu = 1.5
        r = abs(x1 - x2) / (p["mat_ls"] * window)
        return (1 + math.sqrt(3) * r) * math.exp(-math.sqrt(3) * r)
    if ktype == "Periodic":
        nd = abs(x1 - x2) / window
        s = math.sin(math.pi * nd * window / p["per_period"])
        return math.exp(-(p["per_ls"] ** 2 / 2.0) * s * s)
    # RBF (and default)
    d = (x1 - x2) / window
    return math.exp(-(d * d) / (2.0 * p["rbf_ls"] ** 2))


def _ml_solve_weights(window: int, forecast: int, ktype: str, reg: float, p: dict):
    """Solve the fixed kernel-ridge weight vector applied to the price window."""
    n = window
    K = np.empty((n, n), dtype=float)
    for i in range(n):
        for j in range(i, n):
            v = _ml_kernel(i, j, window, ktype, p)
            K[i, j] = v
            K[j, i] = v
    target = n - 1 + forecast
    kstar = np.array([_ml_kernel(i, target, window, ktype, p) for i in range(n)])
    A = K + reg * np.eye(n)
    try:
        return np.linalg.solve(A, kstar)
    except np.linalg.LinAlgError:
        return np.linalg.pinv(A) @ kstar


def _rising_at(s, i, period) -> bool:
    if i - period < 0:
        return False
    for k in range(period):
        a, b = s[i - k], s[i - k - 1]
        if a is None or b is None or not (a > b):
            return False
    return True


def _falling_at(s, i, period) -> bool:
    if i - period < 0:
        return False
    for k in range(period):
        a, b = s[i - k], s[i - k - 1]
        if a is None or b is None or not (a < b):
            return False
    return True


# Regressor type → ridge regularisation on the kernel Gram matrix. GPR uses the
# noise variance σ², KRR the λ, SVR the 1/C soft-margin term, etc. — all reduce
# to a ridge solve once the weights are precomputed on bar positions.
_ML_REG_BY_REGRESSOR = {
    "GPR": 0.01 ** 2, "KRR": 0.01, "KPCR": 0.001, "SVR": 1.0 / 1.0,
    "Kernel Smoothing": 0.05, "Adaptive RQ": 0.05,
}


class ML_Trader_Confluence(Strategy):
    """Kernel-regression MLMA + dual-length breakout, quality-gated. Swing on M5."""
    name      = "ML_Trader_Confluence"
    timeframe = "M5"
    category  = "swing"
    rr_ratio  = 2.0

    def __init__(self, window=120, len1=60, len2=30, kernel="RBF",
                 regressor="KRR", forecast=0, band_mult=2.0,
                 signal_mode="Independent", dual=True,
                 fib_method="Swing-Based", fib_primary=1.618, fib_lookback=50,
                 sl_method="Swing-based", sl_atr_mult=2.0, sl_swing_buffer=0.5,
                 min_quality=70.0, strict_no_trade=True,
                 cluster_bars=20, cluster_atr=0.5, atr_period=14):
        self.window        = window
        self.len1          = len1
        self.len2          = len2
        self.kernel        = kernel
        self.reg           = _ML_REG_BY_REGRESSOR.get(regressor, 0.05)
        self.forecast      = forecast
        self.band_mult     = band_mult
        self.signal_mode   = signal_mode
        self.dual          = dual
        self.fib_method    = fib_method
        self.fib_primary   = fib_primary
        self.fib_lookback  = fib_lookback
        self.sl_method     = sl_method
        self.sl_atr_mult   = sl_atr_mult
        self.sl_buffer     = sl_swing_buffer
        self.min_quality   = min_quality
        self.strict        = strict_no_trade
        self.cluster_bars  = cluster_bars
        self.cluster_atr   = cluster_atr
        self.atr_period    = atr_period

    # ── MLMA (kernel-regression MA + cloud + trend state) ────────────────────
    def _mlma(self, closes):
        n = len(closes)
        w = min(self.window, max(10, n // 3))            # adapt to short data
        weights = _ml_solve_weights(w, self.forecast, self.kernel,
                                    self.reg, _ML_KERNEL_PARAMS)
        mlma = [None] * n
        for b in range(w - 1, n):
            win = np.asarray(closes[b - w + 1:b + 1])
            m = float(win.mean())
            mlma[b] = float(np.dot(weights, win - m)) + m
        # Mean-absolute-error band → cloud width.
        abs_err = [abs(closes[i] - mlma[i]) if mlma[i] is not None else None
                   for i in range(n)]
        band = [None] * n
        for i in range(w - 1, n):
            seg = [e for e in abs_err[i - w + 1:i + 1] if e is not None]
            band[i] = (sum(seg) / len(seg)) * self.band_mult if seg else None
        upper = [mlma[i] + band[i] if band[i] is not None else None for i in range(n)]
        lower = [mlma[i] - band[i] if band[i] is not None else None for i in range(n)]
        trend = [0] * n
        os = 0
        for i in range(n):
            if mlma[i] is not None and mlma[i - 1] is not None:
                if closes[i] > upper[i] and mlma[i] > mlma[i - 1]:
                    os = 1
                elif closes[i] < lower[i] and mlma[i] < mlma[i - 1]:
                    os = 0
            trend[i] = os
        return mlma, upper, lower, trend

    # ── Dual-length synthetic-distance envelope (the raw signal engine) ──────
    def _envelope(self, closes, rsi_v, L):
        n = len(closes)
        ec = ema(closes, L)
        b = [None] * n
        for i in range(n):
            if ec[i] is None:
                continue
            ref = max(abs(ec[i]), 1e-9)
            nb = abs(closes[i] - ec[i]) / ref
            t = 0.68 * nb * nb + 0.79 * nb + nb
            synth = math.sin(t) * math.cos(t)
            b[i] = abs(synth) * ref
        d = ema([x if x is not None else 0.0 for x in b], L)
        upper = [ec[i] + d[i] if ec[i] is not None and d[i] is not None else None for i in range(n)]
        lower = [ec[i] - d[i] if ec[i] is not None and d[i] is not None else None for i in range(n)]
        max_val = [max(upper[i], closes[i]) if upper[i] is not None else None for i in range(n)]
        min_val = [min(closes[i], lower[i]) if lower[i] is not None else None for i in range(n)]
        smooth1  = ema([x if x is not None else 0.0 for x in max_val], L)
        smooth21 = ema([x if x is not None else 0.0 for x in min_val], L)
        rp = max(1, L // 5)
        rng = [smooth1[i] - smooth21[i] if smooth1[i] is not None and smooth21[i] is not None else None
               for i in range(n)]
        buy = [False] * n
        sell = [False] * n
        sbuy = [False] * n
        ssell = [False] * n
        for i in range(L + rp + 2, n):
            if None in (ec[i], smooth1[i], smooth21[i], rsi_v[i]):
                continue
            wedge = _rising_at(smooth21, i, rp) and _falling_at(smooth1, i, rp)
            fr_now  = _falling_at(rng, i, L)
            fr_prev = _falling_at(rng, i - 1, L)
            falling_ended = fr_prev and not fr_now
            if falling_ended and not wedge:
                if closes[i] > smooth21[i]:
                    buy[i] = True
                    sbuy[i] = closes[i] > ec[i] and rsi_v[i] < 70
                if closes[i] < smooth1[i]:
                    sell[i] = True
                    ssell[i] = closes[i] < ec[i] and rsi_v[i] > 30
        return buy, sell, sbuy, ssell, ec

    # ── Signal Quality Engine ────────────────────────────────────────────────
    def _quality(self, direction, i, closes, opens, mlma, atr_v, avg_atr,
                 rsi_v, sma_slope, vol, vol_ma, e1, e2, e4, trend):
        def slope_dir(e):
            return 1 if (e[i] is not None and e[i - 3] is not None and e[i] > e[i - 3]) else -1
        # Context: MLMA trend, slope, price side.
        trend_ok = (trend[i] == 1) if direction == 1 else (trend[i] == 0)
        slope_ok = (mlma[i] > mlma[i - 1]) if direction == 1 else (mlma[i] < mlma[i - 1])
        price_ok = (closes[i] > mlma[i]) if direction == 1 else (closes[i] < mlma[i])
        context = (55.0 if trend_ok else 0.0) + (25.0 if slope_ok else 0.0) + (20.0 if price_ok else 0.0)
        # Multi-timeframe alignment: agreement of trend + EMA slopes at L, 2L, 4L.
        aligned = sum(1 for x in (trend_ok, slope_dir(e1) == direction,
                                  slope_dir(e2) == direction, slope_dir(e4) == direction) if x)
        mtf = (aligned / 4.0) * 100.0
        # Momentum.
        rng = max(1e-9, closes[i] - opens[i]) if direction == 1 else max(1e-9, opens[i] - closes[i])
        body = abs(closes[i] - opens[i]) / max(1e-9, abs(closes[i] - opens[i]) + 1e-9)
        rsi_ok = (50 < rsi_v[i] < 72) if direction == 1 else (28 < rsi_v[i] < 50)
        candle_ok = (closes[i] > opens[i]) if direction == 1 else (closes[i] < opens[i])
        mom_slope_ok = (sma_slope[i] > 0) if direction == 1 else (sma_slope[i] < 0)
        momentum = ((35.0 if rsi_ok else 10.0) + (25.0 if candle_ok else 5.0) +
                    (25.0 if mom_slope_ok else 5.0) + (15.0 if rng > 0 else 5.0))
        # Volatility regime.
        vr = (atr_v[i] / avg_atr[i]) if (atr_v[i] and avg_atr[i]) else 1.0
        volat = 25.0 if vr < 0.55 else 60.0 if vr < 0.8 else 90.0 if vr <= 2.2 else 55.0
        # Volume.
        volr = (vol[i] / vol_ma[i]) if vol_ma[i] else 1.0
        volume = 100.0 if volr >= 1.5 else 85.0 if volr >= 1.1 else 60.0 if volr >= 0.8 else 35.0
        raw = (context * 0.30 + mtf * 0.22 + momentum * 0.20 +
               volat * 0.16 + volume * 0.12)
        return max(0.0, min(100.0, raw))

    def _no_trade_regime(self, direction, i, closes, mlma, upper, lower, atr_v, avg_atr, trend):
        if not self.strict:
            return False
        base = max(1e-9, atr_v[i] or 1e-9)
        cloud_atr = abs((upper[i] or 0) - (lower[i] or 0)) / base
        slope_atr = abs(mlma[i] - mlma[i - 3]) / base if mlma[i - 3] is not None else 1.0
        vr = (atr_v[i] / avg_atr[i]) if (atr_v[i] and avg_atr[i]) else 1.0
        trend_ok = (trend[i] == 1) if direction == 1 else (trend[i] == 0)
        too_compressed = vr < 0.55
        trend_conflict = not trend_ok
        trapped = cloud_atr < 0.8 and lower[i] < closes[i] < upper[i]
        too_flat = slope_atr < 0.12
        return too_compressed or trend_conflict or trapped or too_flat

    def _stop(self, entry, is_buy, swing_ref, a):
        if self.sl_method == "Swing-based" and swing_ref is not None:
            buf = a * self.sl_buffer
            return swing_ref - buf if is_buy else swing_ref + buf
        dist = a * self.sl_atr_mult
        return entry - dist if is_buy else entry + dist

    def _target(self, entry, is_buy, swing_ref, a):
        if self.fib_method == "Dynamic ATR":
            base = a * 2.0
        elif self.fib_method == "Adaptive Swing":
            base = max(a * 1.5, abs(entry - (swing_ref if swing_ref is not None else entry)) * 0.8)
        else:  # Swing-Based
            base = abs(entry - swing_ref) if swing_ref is not None else a * 2.0
        base = max(base, a)                      # never a degenerate target
        dist = base * self.fib_primary
        return entry + dist if is_buy else entry - dist

    def signals(self, candles):
        n = len(candles)
        need = max(self.window, self.len1) + max(self.len1, self.len2) + 10
        if n < need:
            return []
        closes = [c["close"] for c in candles]
        opens  = [c["open"]  for c in candles]
        highs  = [c["high"]  for c in candles]
        lows   = [c["low"]   for c in candles]
        vol    = [c["volume"] for c in candles]

        atr_v = atr(candles, self.atr_period)
        rsi_v = rsi(closes, 14)
        sma10 = sma(closes, 10)
        sma_slope = [None] * n
        for i in range(5, n):
            if sma10[i] is not None and sma10[i - 5] is not None:
                sma_slope[i] = sma10[i] - sma10[i - 5]
        avg_atr = [None] * n
        vol_ma  = [None] * n
        for i in range(n):
            aseg = [x for x in atr_v[max(0, i - 19):i + 1] if x is not None]
            avg_atr[i] = sum(aseg) / len(aseg) if aseg else None
            vseg = vol[max(0, i - 19):i + 1]
            vol_ma[i] = sum(vseg) / len(vseg) if vseg else None
        e1 = ema(closes, self.len1)
        e2 = ema(closes, self.len1 * 2)
        e4 = ema(closes, self.len1 * 4)

        mlma, upper, lower, trend = self._mlma(closes)
        b1, s1, sb1, ss1, _ = self._envelope(closes, rsi_v, self.len1)
        if self.dual:
            b2, s2, sb2, ss2, _ = self._envelope(closes, rsi_v, self.len2)
        else:
            b2 = s2 = sb2 = ss2 = [False] * n

        sigs = []
        last_sig_idx = -10 ** 9
        last_sig_px = None
        for i in range(need, n - 1):
            if None in (mlma[i], mlma[i - 1], atr_v[i], rsi_v[i], sma_slope[i]):
                continue
            # Combine dual-length signals per mode.
            if self.signal_mode == "Consensus" and self.dual:
                buy  = (b1[i] or sb1[i]) and (b2[i] or sb2[i])
                sell = (s1[i] or ss1[i]) and (s2[i] or ss2[i])
            elif self.signal_mode == "Primary Priority":
                buy, sell = (b1[i] or sb1[i]), (s1[i] or ss1[i])
            else:  # Independent
                buy  = b1[i] or sb1[i] or (self.dual and (b2[i] or sb2[i]))
                sell = s1[i] or ss1[i] or (self.dual and (s2[i] or ss2[i]))
            if not (buy or sell) or (buy and sell):
                continue
            direction = 1 if buy else -1

            if self._no_trade_regime(direction, i, closes, mlma, upper, lower, atr_v, avg_atr, trend):
                continue
            q = self._quality(direction, i, closes, opens, mlma, atr_v, avg_atr,
                              rsi_v, sma_slope, vol, vol_ma, e1, e2, e4, trend)
            if q < self.min_quality:
                continue

            a = atr_v[i]
            # Adaptive clustering prevention.
            if (i - last_sig_idx) <= self.cluster_bars and last_sig_px is not None \
                    and abs(closes[i] - last_sig_px) <= self.cluster_atr * a:
                continue

            entry = closes[i]
            if direction == 1:
                swing_ref = min(lows[max(0, i - self.fib_lookback):i]) if i > 0 else None
            else:
                swing_ref = max(highs[max(0, i - self.fib_lookback):i]) if i > 0 else None
            sl = self._stop(entry, direction == 1, swing_ref, a)
            tp = self._target(entry, direction == 1, swing_ref, a)
            if abs(entry - sl) <= 0 or (direction == 1 and tp <= entry) or (direction == -1 and tp >= entry):
                continue

            sigs.append({"idx": i, "side": "BUY" if direction == 1 else "SELL",
                         "entry": entry, "sl": sl, "tp": tp, "quality": round(q, 1)})
            last_sig_idx, last_sig_px = i, entry
        return sigs


class ML_Trader_Confluence_Swing(ML_Trader_Confluence):
    """Same engine on H1 for swing trades: longer memory, wider Fib target."""
    name      = "ML_Trader_Confluence_Swing"
    timeframe = "H1"
    category  = "swing"
    rr_ratio  = 3.0

    def __init__(self, kernel="RBF", regressor="KRR"):
        super().__init__(window=100, len1=50, len2=25, fib_primary=2.0,
                         sl_atr_mult=2.5, fib_lookback=40, min_quality=72.0,
                         kernel=kernel, regressor=regressor)


# ── Backtest engine ────────────────────────────────────────────────────────────

def run_backtest(
    symbol:          str,
    strategy:        Strategy,
    candles:         list[dict],
    use_tsl:         bool         = True,
    tsl:             TSLLevels    = None,
    initial_equity:  float        = 10_000,
    risk_pct:        float        = 0.01,
    max_dd_pct:      float        = 20.0,   # stop if equity drops >20% from peak
    max_bars_in_trade: int        = 200,
    cost_per_trade:  float        = 0.0,    # flat round-trip cost (options); used if cost_fn is None
    cost_fn               = None,           # cost_fn(entry_px, exit_px, size) -> Rs (futures: turnover-based)
    cfd_cfg               = None,           # {point_value, commission_pct, min_spread_pts} for CFD spread cost
) -> dict:
    if tsl is None:
        tsl = TSLLevels()

    signals = strategy.signals(candles)
    if not signals:
        return {"error": "no signals", "symbol": symbol, "strategy": strategy.name}

    equity   = initial_equity
    peak_eq  = initial_equity
    max_dd   = 0.0
    wins = losses = 0
    total_pnl = 0.0
    trades   = []
    gross_win = gross_loss = 0.0      # raw strategy edge (pre-cost)
    net_win = net_loss = 0.0          # after brokerage, by net sign
    costs_acc = 0.0                   # accumulated transaction charges (may vary per trade)
    max_dd_breached = False

    for sig in signals:
        idx    = sig["idx"]
        entry  = sig["entry"]
        sl     = sig["sl"]
        tp     = sig["tp"]
        is_buy = sig["side"] == "BUY"
        risk   = abs(entry - sl)
        if risk <= 0:
            continue

        size = equity * risk_pct / risk  # units

        if use_tsl:
            win, exit_price, mae_r, bars = apply_tsl(candles, idx, entry, sl, tp, is_buy, tsl, max_bars_in_trade)
        else:
            win, exit_price, mae_r, bars = apply_tsl(candles, idx, entry, sl, tp, is_buy, TSLLevels(levels=[]), max_bars_in_trade)

        pnl = (exit_price - entry) * size if is_buy else (entry - exit_price) * size
        # Cost models: futures = turnover charges; CFD = real bid/ask spread (from
        # MT5 data) crossed once per round trip + commission; else flat per-trade.
        if cost_fn:
            trade_cost = cost_fn(entry, exit_price, size)
        elif cfd_cfg:
            sp_pts   = max(candles[idx].get("spread", 0), cfd_cfg.get("min_spread_pts", 0))
            sp_price = sp_pts * cfd_cfg["point_value"]
            lots     = size / cfd_cfg.get("contract_size", 1)
            trade_cost = sp_price * size + cfd_cfg.get("commission_lot_rt", 0) * lots
        else:
            trade_cost = cost_per_trade
        costs_acc += trade_cost
        net = pnl - trade_cost            # one round trip = one buy + one sell
        equity += net                     # equity (and thus DD/returns) is net of costs
        total_pnl += net
        if win:
            wins += 1; gross_win += pnl
        else:
            losses += 1; gross_loss += abs(pnl)
        if net >= 0:
            net_win += net
        else:
            net_loss += -net

        peak_eq = max(peak_eq, equity)
        dd      = (peak_eq - equity) / peak_eq * 100
        max_dd  = max(max_dd, dd)

        # Equity drawdown guard — stop if peak-to-trough exceeds max_dd_pct
        if dd > max_dd_pct:
            max_dd_breached = True
            break

        trades.append({
            "time":       candles[idx]["time"],
            "side":       sig["side"],
            "entry":      round(entry, 5),
            "exit":       round(exit_price, 5),
            "sl":         round(sl, 5),
            "tp":         round(tp, 5),
            "win":        win,
            "pnl":        round(pnl, 2),
            "cost":       round(trade_cost, 2),
            "net_pnl":    round(net, 2),
            "equity":     round(equity, 2),
            "bars_held":  bars,
        })

    total = wins + losses
    total_costs = costs_acc
    gross_equity = equity + total_costs   # what equity would be with zero brokerage
    return {
        "symbol":          symbol,
        "strategy":        strategy.name,
        "category":        strategy.category,
        "timeframe":       strategy.timeframe,
        "use_tsl":         use_tsl,
        "total_trades":    total,
        "wins":            wins,
        "losses":          losses,
        "win_rate":        round(wins / total * 100, 1) if total else 0,
        "profit_factor":   round(gross_win / (gross_loss or 1), 2),          # pre-cost
        "net_profit_factor": round(net_win / (net_loss or 1), 2),            # after brokerage
        "total_return_pct":round((equity - initial_equity) / initial_equity * 100, 2),       # NET
        "gross_return_pct":round((gross_equity - initial_equity) / initial_equity * 100, 2), # pre-cost
        "cost_per_trade":  round(cost_per_trade, 2),
        "total_costs":     round(total_costs, 2),
        "final_equity":    round(equity, 2),
        "max_drawdown_pct":round(max_dd, 2),
        "avg_win":         round(gross_win / wins, 2) if wins else 0,
        "avg_loss":        round(gross_loss / losses, 2) if losses else 0,
        "expectancy":      round((wins/total * gross_win/max(wins,1) - losses/total * gross_loss/max(losses,1)), 2) if total else 0,
        "max_dd_breached": max_dd_breached,
        "trades":          trades,
    }


# ── Daily analysis runner ──────────────────────────────────────────────────────

SYMBOL_STRATEGIES = {
    "XAUUSD+": [
        (EMA_Crossover_RSI(),         "M5"),
        (BB_RSI_Reversal(),           "M5"),
        (SR_Bounce_Scalp(),           "M5"),
        (Retest_Breakout(),           "M5"),
        (Book_Pressure_Scalp_M5(),    "M5"),
        (VWAP_Reversion_Scalp(),      "M1"),
        (Book_Pressure_Scalp(),       "M1"),
        (EMA_Pullback_Swing(),        "H1"),
        (RSI_Divergence_Swing(),      "H1"),
        (Retest_Breakout_Swing(),     "H1"),
        (ORB_Session_Breakout(),      "M5"),
        (ML_Trader_Confluence(kernel="Matern", regressor="GPR"),       "M5"),  # XAUUSD+
        (ML_Trader_Confluence_Swing(kernel="Matern", regressor="GPR"), "H1"),
    ],
    "BTCUSD": [
        (EMA_Crossover_RSI(fast=9, slow=26, rsi_os=38, rsi_ob=62), "M5"),
        (BB_RSI_Reversal(),           "M5"),
        (SR_Bounce_Scalp(lookback=15, zone_pct=0.002), "M5"),
        (Retest_Breakout(lookback=15, zone_pct=0.003, min_gap=0.003), "M5"),
        (Book_Pressure_Scalp_M5(),    "M5"),
        (VWAP_Reversion_Scalp(),      "M1"),
        (Book_Pressure_Scalp(),       "M1"),
        (EMA_Pullback_Swing(),        "H1"),
        (RSI_Divergence_Swing(),      "H1"),
        (Retest_Breakout_Swing(),     "H1"),
        (ORB_Session_Breakout(),      "M5"),
        (ML_Trader_Confluence(kernel="Laplacian", regressor="SVR"),       "M5"),  # BTCUSD
        (ML_Trader_Confluence_Swing(kernel="Laplacian", regressor="SVR"), "H1"),
    ],
    "ETHUSD": [
        (EMA_Crossover_RSI(fast=9, slow=26, rsi_os=38, rsi_ob=62), "M5"),
        (BB_RSI_Reversal(),           "M5"),
        (SR_Bounce_Scalp(lookback=15, zone_pct=0.002), "M5"),
        (Retest_Breakout(lookback=15, zone_pct=0.003, min_gap=0.003), "M5"),
        (Book_Pressure_Scalp_M5(),    "M5"),
        (VWAP_Reversion_Scalp(),      "M1"),
        (Book_Pressure_Scalp(),       "M1"),
        (EMA_Pullback_Swing(),        "H1"),
        (RSI_Divergence_Swing(),      "H1"),
        (Retest_Breakout_Swing(),     "H1"),
        (ORB_Session_Breakout(),      "M5"),
        (ML_Trader_Confluence(kernel="Laplacian", regressor="SVR"),       "M5"),  # ETHUSD
        (ML_Trader_Confluence_Swing(kernel="Laplacian", regressor="SVR"), "H1"),
    ],
    # ── Dhan (Indian market) instruments — data via dhan_collector.py ──────────
    # Only backtested if matching CSVs exist in data/; skipped otherwise.
    "NIFTY50": [
        (EMA_Crossover_RSI(),         "M5"),
        (BB_RSI_Reversal(),           "M5"),
        (SR_Bounce_Scalp(),           "M5"),
        (Retest_Breakout(),           "M5"),
        (Book_Pressure_Scalp_M5(),    "M5"),
        (VWAP_Reversion_Scalp(),      "M1"),
        (Book_Pressure_Scalp(),       "M1"),
        (EMA_Pullback_Swing(),        "H1"),
        (RSI_Divergence_Swing(),      "H1"),
        (Retest_Breakout_Swing(),     "H1"),
        (ORB_Session_Breakout(),      "M5"),
        (ML_Trader_Confluence(kernel="RBF", regressor="KRR"),       "M5"),  # NIFTY50
        (ML_Trader_Confluence_Swing(kernel="RBF", regressor="KRR"), "H1"),
    ],
    "BANKNIFTY": [
        (EMA_Crossover_RSI(),         "M5"),
        (BB_RSI_Reversal(),           "M5"),
        (SR_Bounce_Scalp(),           "M5"),
        (Retest_Breakout(),           "M5"),
        (Book_Pressure_Scalp_M5(),    "M5"),
        (VWAP_Reversion_Scalp(),      "M1"),
        (Book_Pressure_Scalp(),       "M1"),
        (EMA_Pullback_Swing(),        "H1"),
        (RSI_Divergence_Swing(),      "H1"),
        (Retest_Breakout_Swing(),     "H1"),
        (ORB_Session_Breakout(),      "M5"),
        (ML_Trader_Confluence(kernel="RBF", regressor="KRR"),       "M5"),  # BANKNIFTY
        (ML_Trader_Confluence_Swing(kernel="RBF", regressor="KRR"), "H1"),
    ],
    "SENSEX": [
        (EMA_Crossover_RSI(),         "M5"),
        (BB_RSI_Reversal(),           "M5"),
        (SR_Bounce_Scalp(),           "M5"),
        (Retest_Breakout(),           "M5"),
        (Book_Pressure_Scalp_M5(),    "M5"),
        (VWAP_Reversion_Scalp(),      "M1"),
        (Book_Pressure_Scalp(),       "M1"),
        (EMA_Pullback_Swing(),        "H1"),
        (RSI_Divergence_Swing(),      "H1"),
        (Retest_Breakout_Swing(),     "H1"),
        (ORB_Session_Breakout(),      "M5"),
        (ML_Trader_Confluence(kernel="RBF", regressor="KRR"),       "M5"),  # SENSEX
        (ML_Trader_Confluence_Swing(kernel="RBF", regressor="KRR"), "H1"),
    ],
}

TSL_ON  = TSLLevels(levels=[(1.0,0.0),(2.0,1.5),(3.0,2.5),(4.0,3.5)])
TSL_OFF = TSLLevels(levels=[])

# Indian indices are now traded as the tradable MONTHLY INDEX FUTURES (FUTIDX),
# not the untradable spot. Futures charges are TURNOVER-based: STT 0.02% on the
# full notional (price x lot) dominates (~Rs 300+/lot on Nifty), unlike options
# where the flat Rs 20 brokerage dominated. So we use a per-trade cost FUNCTION
# (dhan_futures.futures_round_trip_cost on notional), not a flat figure.
DHAN_SYMBOLS = {"NIFTY50", "BANKNIFTY", "SENSEX"}
DHAN_ACCOUNT_SIZE = 200_000.0     # Rs — realistic for ~1 index-futures lot (margin ~Rs1.75L)
try:
    from dhan_futures import futures_round_trip_cost as _fut_cost
    def DHAN_FUT_COST_FN(entry_px, exit_px, size):
        return _fut_cost(size * entry_px, size * exit_px)
except Exception:
    DHAN_FUT_COST_FN = None

# Vantage RAW ECN CFD costs (gold/BTC/ETH on MT5). Two components:
#  1) SPREAD — real bid/ask from the MT5 `spread` column (points) x point_value,
#     crossed once per round trip. Raw ECN spreads are tight; data already reflects them.
#  2) COMMISSION — Raw ECN charges ~$3/side/lot = $6 round-trip per lot. Converted
#     to per-unit via the MT5 contract size (gold 100 oz/lot, BTC & ETH 1 coin/lot).
# point_value = price per MT5 point (all three: digits=2 -> 0.01).
CFD_COSTS = {
    "XAUUSD+": {"point_value": 0.01, "contract_size": 100, "commission_lot_rt": 6.0, "min_spread_pts": 10},
    "BTCUSD":  {"point_value": 0.01, "contract_size": 1,   "commission_lot_rt": 6.0, "min_spread_pts": 500},
    "ETHUSD":  {"point_value": 0.01, "contract_size": 1,   "commission_lot_rt": 6.0, "min_spread_pts": 100},
}


def run_daily_analysis(max_dd_pct: float = 20.0):
    today    = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out_path = RESULTS_DIR / f"results_{today}.json"
    all_results = []

    print(f"\n{'='*60}")
    print(f"  Strategy Lab - Daily Analysis - {today}")
    print(f"  Max DD: {max_dd_pct:.0f}% of equity")
    print(f"{'='*60}\n")

    for symbol, strat_list in SYMBOL_STRATEGIES.items():
        is_indian = symbol in DHAN_SYMBOLS
        cfd_cfg   = CFD_COSTS.get(symbol)              # gold/BTC spread+commission
        has_cost  = is_indian or cfd_cfg is not None
        equity0   = DHAN_ACCOUNT_SIZE if is_indian else 10_000.0
        cost_fn   = DHAN_FUT_COST_FN  if is_indian else None   # futures turnover charges
        tag       = (" (index FUTURES, net of NSE/BSE charges)" if is_indian
                     else " (net of spread + commission)" if cfd_cfg else "")
        print(f"-- {symbol}{tag} ----------------------------------")
        for strat, tf in strat_list:
            candles = load_symbol_tf(symbol, tf)
            if len(candles) < 100:
                print(f"  {strat.name:<28} [{tf}]  - not enough data ({len(candles)} bars)")
                continue

            for use_tsl, label in [(True, "TSL"), (False, "Fixed")]:
                r = run_backtest(
                    symbol         = symbol,
                    strategy       = strat,
                    candles        = candles,
                    use_tsl        = use_tsl,
                    tsl            = TSL_ON if use_tsl else TSL_OFF,
                    max_dd_pct     = max_dd_pct,
                    initial_equity = equity0,
                    cost_fn        = cost_fn,
                    cfd_cfg        = cfd_cfg,
                )
                if "error" in r:
                    print(f"  {strat.name:<28} [{tf}] {label:<5} — {r['error']}")
                    continue

                # Judge cost-bearing instruments on NET profit factor.
                pf_judge = r["net_profit_factor"] if has_cost else r["profit_factor"]
                flag = "✅ PROFITABLE" if r["win_rate"] >= 50 and pf_judge >= 1.2 and not r["max_dd_breached"] else ""
                cost_unit = "Rs" if is_indian else "$"
                cost_str = f" | Cost:{cost_unit}{r['total_costs']:>7.0f}" if has_cost else ""
                ret_str = (f"NetRet:{r['total_return_pct']:>6.1f}%(gross {r['gross_return_pct']:>5.1f}%)"
                           if has_cost else f"Ret:{r['total_return_pct']:>6.1f}%")
                print(
                    f"  {strat.name:<28} [{tf}] {label:<5} | "
                    f"Trades:{r['total_trades']:>4} | WR:{r['win_rate']:>5.1f}% | "
                    f"PF:{pf_judge:>4.2f} | {ret_str}{cost_str} | "
                    f"DD:{r['max_drawdown_pct']:>5.1f}%  {flag}"
                )
                all_results.append(r)

    # Save full results JSON
    with open(out_path, "w") as f:
        json.dump(all_results, f, indent=2)
    print(f"\nFull results saved → {out_path}")

    # Champions judged on NET profit factor for any cost-bearing instrument
    # (Indian futures + gold/BTC CFDs).
    _cost_syms = DHAN_SYMBOLS | set(CFD_COSTS)
    def _pf(r):
        return r.get("net_profit_factor", r.get("profit_factor", 0)) \
            if r.get("symbol") in _cost_syms else r.get("profit_factor", 0)
    profitable = [r for r in all_results
                  if r.get("win_rate",0) >= 55
                  and _pf(r) >= 1.5
                  and not r.get("max_dd_breached", True)
                  and r.get("total_trades",0) >= 10]
    if profitable:
        best = sorted(profitable, key=lambda r: r["profit_factor"], reverse=True)
        print(f"\n🏆  TOP STRATEGIES (WR≥55%, PF≥1.5, ≥10 trades):")
        for r in best[:5]:
            print(f"   {r['symbol']} | {r['strategy']} [{r['timeframe']}] "
                  f"TSL={r['use_tsl']} | WR={r['win_rate']}% PF={r['profit_factor']} "
                  f"Ret={r['total_return_pct']}%")
    else:
        print("\n⚠️  No strategy met profit criteria today. Continuing data collection...")

    return all_results


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-dd", type=float, default=20.0, help="Max drawdown as %% of equity (default 20%%)")
    args = parser.parse_args()
    run_daily_analysis(max_dd_pct=args.max_dd)
