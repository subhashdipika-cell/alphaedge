"""Run every registered lab strategy without replacing dashboard results.

These are legacy underlying/futures simulations, NOT option buying backtests.
"""
import json
import sys
from pathlib import Path
import backtester as bt

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
bt.RESULTS_DIR = out
results = bt.run_daily_analysis()
coverage = []
for symbol, strategies in bt.SYMBOL_STRATEGIES.items():
    for strategy, tf in strategies:
        bars = bt.load_symbol_tf(symbol, tf)
        coverage.append(dict(symbol=symbol, strategy=strategy.name, timeframe=tf,
                             bars=len(bars), first=bars[0]['time'] if bars else None,
                             last=bars[-1]['time'] if bars else None))
(out / 'coverage.json').write_text(json.dumps(coverage, indent=2), encoding='utf-8')
print('RESEARCH ONLY: legacy futures simulations; not option-premium or out-of-sample evidence.')
