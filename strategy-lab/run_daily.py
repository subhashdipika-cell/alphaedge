"""
run_daily.py — Daily pipeline orchestrator (Indian indices only)
Pulls Dhan candles, runs the options-chain collector through the NSE session,
then runs the backtester, saves results, and appends a summary to the
Obsidian Trading Mind wiki.

Usage:
  python run_daily.py              # collect 8h then analyse
  python run_daily.py --analyse-only   # skip collection, just backtest
  python run_daily.py --max-dd 1000    # test with 1000-pip DD limit
"""

import argparse
import ctypes
import os
import subprocess
import sys
import time
import json
from datetime import datetime, timezone
from pathlib import Path

# ── Keep the laptop awake during the 9h collection ───────────────────────────
# The 2026-07-08 run died at 06:40 because the machine entered Modern Standby
# and the power source flipped. SetThreadExecutionState holds the system in the
# working state so the collectors aren't suspended. (Task-level "stop on
# battery" is fixed separately in install_scheduler.bat.)
_ES_CONTINUOUS       = 0x80000000
_ES_SYSTEM_REQUIRED  = 0x00000001
_ES_AWAYMODE_REQUIRED = 0x00000040   # keep working state even under Modern Standby


def keep_awake():
    try:
        ctypes.windll.kernel32.SetThreadExecutionState(
            _ES_CONTINUOUS | _ES_SYSTEM_REQUIRED | _ES_AWAYMODE_REQUIRED)
    except Exception:
        pass


def release_awake():
    try:
        ctypes.windll.kernel32.SetThreadExecutionState(_ES_CONTINUOUS)
    except Exception:
        pass

# Smart App Control blocks the base Python 3.14 native wheels (pandas/MT5); the
# 3.12 venv's wheels are trusted. If launched with any other interpreter (e.g. the
# scheduled task still points at 3.14), re-exec under the venv. Subprocesses then
# inherit sys.executable = the venv python.
_VENV_PY = r"D:\alphaedge\.venv\Scripts\python.exe"
_DHAN_PY = r"D:\alphaedge\.chronos-venv\Scripts\python.exe"
if os.path.exists(_VENV_PY) and os.path.normcase(sys.executable) != os.path.normcase(_VENV_PY):
    raise SystemExit(subprocess.call([_VENV_PY, os.path.abspath(__file__), *sys.argv[1:]]))

ROOT       = Path(__file__).parent
WIKI_ROOT  = Path(r"E:\Obsidian\Trading_Mind\wiki")
LOG_FILE   = ROOT / "daily_runner.log"


def dhan_python() -> str:
    """Use the shared Dhan-capable runtime for every market-data subprocess."""
    if os.path.exists(_DHAN_PY):
        return _DHAN_PY
    return sys.executable


def log(msg):
    ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def start_options_collector():
    """Launch the Dhan options-chain collector in parallel (self-gates on market
    hours). Returns the process, or None if Dhan isn't configured."""
    if not (ROOT / "dhan_config.json").exists():
        return None
    log("Starting Dhan options-chain collector (parallel)...")
    return subprocess.Popen(
        [dhan_python(), str(ROOT / "dhan_options_collector.py")],
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, text=True,
    )


def stop_options_collector(proc):
    if proc is None:
        return
    try:
        proc.terminate(); proc.wait(timeout=10)
    except Exception:
        try: proc.kill()
        except Exception: pass
    log("Options collector stopped (see dhan_options.log).")


def wait_for_options_collector(proc, hours: float):
    """Hold the pipeline (and keep-awake) while the options collector runs.
    The collector self-gates on market hours and exits after the close; the
    hours cap is a safety net so the pipeline can't hang forever."""
    if proc is None:
        log("No options collector running — nothing to wait for.")
        return
    deadline = time.time() + hours * 3600
    log(f"Waiting for options collector (cap {hours}h)...")
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        time.sleep(30)
    log("Options collection window over.")


def refresh_dhan_token():
    """Auto-refresh the 24h Dhan access token via PIN+TOTP, if configured."""
    try:
        proc = subprocess.run(
            [dhan_python(), str(ROOT / "dhan_token_refresh.py")],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60,
        )
        out = (proc.stdout or "").strip()
        if "Saved fresh" in out:
            log("Dhan token: auto-refreshed for today.")
        else:
            # Not configured or failed — collector will still try the existing token.
            log(f"Dhan token: not refreshed ({out.splitlines()[-1] if out else 'no output'}).")
    except Exception as e:
        log(f"Dhan token refresh error: {e}")


def run_dhan_collector(days: int):
    """One-shot pull of Dhan (Indian market) historical data, if configured."""
    cfg = ROOT / "dhan_config.json"
    if not cfg.exists():
        log("Dhan: no dhan_config.json found — skipping Indian-market data.")
        return
    refresh_dhan_token()
    log(f"Pulling Dhan intraday data (last {days} days)...")
    try:
        proc = subprocess.run(
            [dhan_python(), str(ROOT / "dhan_collector.py"), "--days", str(days)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600,
        )
        for line in (proc.stdout or "").splitlines():
            print("  [dhan]", line)
    except Exception as e:
        log(f"Dhan collector error: {e}")
    log("Dhan collection done.")


def run_zerohero_index_collector(days: int):
    """Refresh spot-index candles used by Zero-Hero divergence.

    This intentionally does not start the option collector: the single
    collector below owns the Dhan option-chain rate limit for the whole daily
    pipeline. Option-chain history remains forward-only because Dhan does not
    expose historical option-chain snapshots.
    """
    if not (ROOT / "dhan_config.json").exists():
        log("Zero-Hero index refresh: no dhan_config.json found — skipping.")
        return
    log(f"Refreshing Zero-Hero spot index candles (last {days} days)...")
    try:
        proc = subprocess.run(
            [dhan_python(), str(ROOT / "collect_zerohero_history.py"),
             "--days", str(days), "--intervals", "1,5"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600,
        )
        for line in (proc.stdout or "").splitlines():
            print("  [zerohero-index]", line)
        if proc.returncode:
            log(f"Zero-Hero index refresh failed with exit code {proc.returncode}.")
    except Exception as e:
        log(f"Zero-Hero index refresh error: {e}")


def run_analysis(max_dd: float) -> list[dict]:
    log(f"Running backtester (max DD = {max_dd}% of equity)...")
    from backtester import run_daily_analysis
    results = run_daily_analysis(max_dd_pct=max_dd)
    log("Backtester done.")
    return results


def save_wiki_summary(results: list[dict], max_dd: float):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    # Indian (Dhan) instruments are judged on NET profit factor (after the
    # ~Rs 55/round-trip brokerage the backtester now deducts).
    _DHAN = {"NIFTY50", "BANKNIFTY", "SENSEX"}
    def _pf(r):
        return r.get("net_profit_factor", r.get("profit_factor", 0)) \
            if r.get("symbol") in _DHAN else r.get("profit_factor", 0)
    profitable = [r for r in results
                  if r.get("win_rate", 0) >= 55
                  and _pf(r) >= 1.5
                  and not r.get("max_dd_breached", True)
                  and r.get("total_trades", 0) >= 10]

    # ── Update/append to wiki/strategies/scalp-lab.md ─────────────────────────
    scalp_path = WIKI_ROOT / "strategies" / "scalp-lab.md"
    scalp_path.parent.mkdir(parents=True, exist_ok=True)

    if not scalp_path.exists():
        scalp_path.write_text(f"""---
tags: [strategy, scalp, nifty, banknifty]
sources: []
last_updated: {today}
---

# Scalp Lab — Adaptive Strategy Discovery

Daily backtest results from Dhan M1/M5/H1 index-futures data (NIFTY/BANKNIFTY/SENSEX).
TSL rules: 1R→breakeven, 2R→lock 1.5R, 3R→lock 2.5R, 4R→lock 3.5R.
Max DD guards: 500 pips (also tested 1000 pips).

## Best strategies found
<!-- updated daily -->

## Daily run log

""", encoding="utf-8")

    entry_lines = [f"\n### {today} (max DD = {max_dd}% equity)\n"]
    if profitable:
        entry_lines.append("**Profitable strategies** (Indian = net of brokerage):\n")
        for r in sorted(profitable, key=_pf, reverse=True):
            cost_note = f", cost ₹{r.get('total_costs',0):.0f}" if r.get("symbol") in _DHAN else ""
            entry_lines.append(
                f"- **{r['symbol']} | {r['strategy']}** [{r['timeframe']}] "
                f"TSL={'on' if r['use_tsl'] else 'off'} — "
                f"WR {r['win_rate']}%, PF {_pf(r)}, "
                f"Ret {r['total_return_pct']}%, DD {r['max_drawdown_pct']}%, "
                f"{r['total_trades']} trades{cost_note}\n"
            )
    else:
        entry_lines.append("No strategy met criteria (WR≥55%, PF≥1.5, ≥10 trades). "
                           "Data accumulating.\n")

    # Add all results table. Net% is after brokerage; Gross% is pre-cost;
    # Cost₹ is total round-trip brokerage (0 for non-Indian instruments).
    entry_lines.append("\n<details><summary>All results</summary>\n\n")
    entry_lines.append("| Symbol | Strategy | TF | TSL | Trades | WR | PF | Net% | Gross% | Cost₹ | DD% |\n")
    entry_lines.append("|--------|----------|----|-----|--------|----|----|------|--------|-------|-----|\n")
    for r in results:
        if "error" not in r:
            entry_lines.append(
                f"| {r['symbol']} | {r['strategy']} | {r['timeframe']} | "
                f"{'✓' if r['use_tsl'] else '✗'} | {r['total_trades']} | "
                f"{r['win_rate']}% | {_pf(r)} | "
                f"{r['total_return_pct']}% | {r.get('gross_return_pct', r['total_return_pct'])}% | "
                f"{r.get('total_costs', 0):.0f} | {r['max_drawdown_pct']}% |\n"
            )
    entry_lines.append("\n</details>\n")

    # Prepend entry under "## Daily run log"
    content = scalp_path.read_text(encoding="utf-8")
    insert_at = content.find("## Daily run log\n") + len("## Daily run log\n")
    new_content = content[:insert_at] + "".join(entry_lines) + content[insert_at:]
    scalp_path.write_text(new_content, encoding="utf-8")
    log(f"Wiki updated → {scalp_path}")

    # ── Append to wiki/log.md ──────────────────────────────────────────────────
    log_path = WIKI_ROOT / "log.md"
    if log_path.exists():
        existing = log_path.read_text(encoding="utf-8")
        n_prof = len(profitable)
        entry  = (f"\n## [{today}] strategy-lab | scalp+swing discovery\n"
                  f"{len(results)} backtests run. {n_prof} strategies profitable. "
                  f"Max DD tested: {max_dd}% of equity.\n")
        # Insert below the "---" header separator (newest-first), not above the title.
        marker = "\n---\n"
        idx = existing.find(marker)
        if idx != -1:
            pos = idx + len(marker)
            new_log = existing[:pos] + entry + existing[pos:]
        else:
            new_log = entry + existing
        log_path.write_text(new_log, encoding="utf-8")
        log(f"Log updated → {log_path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--collect-hours", type=float, default=8.0,
                        help="Hours to collect before analysing (default 8)")
    parser.add_argument("--analyse-only", action="store_true",
                        help="Skip collection, run analysis on existing data")
    parser.add_argument("--max-dd", type=float, default=20.0,
                        help="Max drawdown as %% of equity (default 20%%)")
    parser.add_argument("--dhan-days", type=int, default=5,
                        help="Days of Dhan intraday history to pull (default 5)")
    parser.add_argument("--zerohero-index-days", type=int, default=5,
                        help="Days of NIFTY/BANKNIFTY spot candles to refresh (default 5)")
    args = parser.parse_args()

    log("=== Daily pipeline starting ===")

    if not args.analyse_only:
        keep_awake()                                 # hold the machine awake for the collect
        log("Keep-awake ON — system held in working state during collection.")
        try:
            run_dhan_collector(days=args.dhan_days)
            run_zerohero_index_collector(days=args.zerohero_index_days)
            opt_proc = start_options_collector()     # options-chain capture (self-gates on market hours)
            try:
                wait_for_options_collector(opt_proc, hours=args.collect_hours)
            finally:
                stop_options_collector(opt_proc)
        finally:
            release_awake()
            log("Keep-awake released.")

    results = run_analysis(max_dd=args.max_dd)
    save_wiki_summary(results, max_dd=args.max_dd)

    log("=== Daily pipeline complete ===")


if __name__ == "__main__":
    main()
