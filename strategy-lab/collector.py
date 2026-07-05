"""
collector.py — MT5 candle data collector
Pulls M1 and M5 candles for XAUUSD and BTCUSD and appends to daily CSV files.
Run this script while MT5 terminal is open and logged in.
"""

import csv
import io
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Force UTF-8 output on Windows consoles
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

try:
    import MetaTrader5 as mt5
except ImportError:
    print("ERROR: MetaTrader5 package not installed. Run: pip install MetaTrader5")
    sys.exit(1)

# ── Config ─────────────────────────────────────────────────────────────────────
SYMBOLS     = ["XAUUSD+", "BTCUSD", "ETHUSD"]
TIMEFRAMES  = {
    "M1":  mt5.TIMEFRAME_M1,
    "M5":  mt5.TIMEFRAME_M5,
    "H1":  mt5.TIMEFRAME_H1,
}
BARS_PER_PULL = 500          # candles to fetch per pull
POLL_SECONDS  = 60           # pull M1 every 60s (one new candle)
DATA_DIR      = Path(__file__).parent / "data"
LOG_FILE      = Path(__file__).parent / "collector.log"

DATA_DIR.mkdir(exist_ok=True)

# ── Helpers ────────────────────────────────────────────────────────────────────

def log(msg: str):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def csv_path(symbol: str, tf: str) -> Path:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return DATA_DIR / f"{symbol}_{tf}_{today}.csv"


def load_existing_times(path: Path) -> set:
    """Return set of timestamps already written to the CSV."""
    if not path.exists():
        return set()
    times = set()
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            times.add(row["time"])
    return times


def pull_and_append(symbol: str, tf_name: str, tf_code: int):
    rates = mt5.copy_rates_from_pos(symbol, tf_code, 0, BARS_PER_PULL)
    if rates is None or len(rates) == 0:
        log(f"  WARNING: no data for {symbol} {tf_name} — {mt5.last_error()}")
        return 0

    path = csv_path(symbol, tf_name)
    existing = load_existing_times(path)
    write_header = not path.exists()

    new_rows = 0
    with open(path, "a", newline="") as f:
        writer = csv.writer(f)
        if write_header:
            writer.writerow(["time", "open", "high", "low", "close", "tick_volume", "spread", "real_volume"])
        for r in rates:
            ts = datetime.fromtimestamp(r["time"], timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            if ts not in existing:
                writer.writerow([ts, r["open"], r["high"], r["low"], r["close"],
                                 r["tick_volume"], r["spread"], r["real_volume"]])
                existing.add(ts)
                new_rows += 1
    return new_rows


# ── Main loop ──────────────────────────────────────────────────────────────────

def main():
    log("=== Collector starting ===")
    if not mt5.initialize():
        log(f"ERROR: MT5 initialize() failed — {mt5.last_error()}")
        log("Make sure MT5 terminal is open and logged in.")
        sys.exit(1)

    info = mt5.terminal_info()
    log(f"MT5 connected: build {info.build}, connected={info.connected}")

    # Verify symbols
    for sym in SYMBOLS:
        info_sym = mt5.symbol_info(sym)
        if info_sym is None:
            log(f"WARNING: symbol {sym} not found in MT5 — skipping")
        else:
            if not info_sym.visible:
                mt5.symbol_select(sym, True)
            log(f"  {sym}: digits={info_sym.digits}, point={info_sym.point}")

    log(f"Polling every {POLL_SECONDS}s. Press Ctrl+C to stop.")
    try:
        while True:
            for sym in SYMBOLS:
                for tf_name, tf_code in TIMEFRAMES.items():
                    n = pull_and_append(sym, tf_name, tf_code)
                    if n > 0:
                        log(f"  {sym} {tf_name}: +{n} new bars -> {csv_path(sym, tf_name).name}")
            time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        log("Collector stopped by user.")
    finally:
        mt5.shutdown()
        log("MT5 connection closed.")


if __name__ == "__main__":
    main()
