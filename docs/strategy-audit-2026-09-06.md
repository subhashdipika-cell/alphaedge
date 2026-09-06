# AlphaEdge strategy audit, 6 September 2026

Observed stored paper ledger: 61 resolved legs, 12 wins, 49 losses,
net INR -70,612.72. These are historical results, not a backtest of this patch.
Multiple legs from the same signal are correlated observations.

## Confirmed faults repaired

- Session loss stop counted all previous days: now uses IST resolution day.
- Adaptive and promotion attribution inferred current strategy versions from
  unversioned legacy records: now leaves these records unassigned.
- Adaptive filter rejected asymmetric positive-expectancy strategies on win
  rate alone: now relies on expectancy and drawdown. Missing realized R is
  excluded from adaptive evidence. This remains a heuristic circuit breaker,
  not a trained model or proof of profitability.
- Expiry rollover used front-expiry premiums for next-expiry analysis: the OI
  endpoint now accepts an explicit expiry and scoring requests matching history.
- Selected-option checks accepted zero bids/crossed markets: now rejected.
- Divergence required both indices to expire together: only the target needs
  expiry; both index feeds must be available. Reference and signal candles are
  restricted to that expiry session. An incomplete 14:00 candle cannot replace
  a missing closed 13:55 candle.
- Health records overwrote current ownership metadata with old values.
- Scanner cycles could overlap; concurrent interval callbacks are now skipped.
- Bridge/collector chain requests had independent throttles: shared OS locking
  and pacing now coordinate them; new collector processes enforce one owner.

## Current eligibility and remaining limitations

NIFTY/SENSEX workflows have zero explicitly versioned resolved records and
return to warm-up. Legacy score-v1 has ten tagged losses and remains paused.
Zero-Hero v2 has only two records; divergence has none. Warm-up/ACTIVE means
eligible for PAPER evaluation, not profitable or approved for LIVE.

The main scanner forces NIFTY SCALP (10:00–10:30); the opening risk lock lasts
until 10:15, leaving only 15 minutes for qualifying entries. This was retained
pending validation of a wider window. Poor score-v1 results were not reset.

Premium levels still derive from sampled LTP history, not complete traded OHLC
bars; intrabucket touches and executable fills cannot be reconstructed exactly.
The five-minute divergence signal ends at 14:00 and uses a reference ending
before that bar. It is not the originally requested one-minute formulation.

The browser Strategy Lab's index backtests are not automatically autonomous
option strategies. Adding each to the scanner requires its own contract,
premium execution path and versioned evidence.

No claim of improved P&L is made. Next validation requires chronological
train/validation/test days, matched contract history, bid/ask costs, recorded
skips, MAE/MFE, and a held-out forward paper sample for each strategy version.
Do not reset history or relabel versions solely to bypass suspension.

Restart bridge, collector and scanner to load these changes. Old processes do
not acquire the new lock retroactively. Account traffic from other applications
remains outside AlphaEdge's pacing mechanism.
