# Stored-data audit and Zero-Hero repair — 2026-09-06

## Conclusion

Zero-Hero has NOT been demonstrated profitable. Execution/risk defects were repaired;
no strategy was disabled and no loss veto was reset. No live orders were submitted.
The changes need a scanner/bridge restart to affect already-running processes.

## What was actually tested

196 local option day-files, June 23 through September 3, 2026:

| Index | Day-files | Files containing front-expiry day |
|---|---:|---:|
| NIFTY50 | 53 | 11 |
| BANKNIFTY | 53 | 3 |
| SENSEX | 53 | 11 |
| FINNIFTY | 37 | 2 |

These counts do not guarantee complete sessions. The offline runner evaluated the
current and legacy score workflows on all four indices, Zero-Hero v1/v2 on all
four (v2 outside NIFTY is research-only; the scanner runs v2 on NIFTY), and the
deployed NIFTY-to-BANKNIFTY divergence strategy. No Dhan history was downloaded.

The Python Strategy Lab separately executed all 41 registered strategy/index/
timeframe combinations with fixed and trailing exits: 82 simulations. Those are
legacy underlying/futures tests, NOT option-buying backtests. Fourteen simulations
had positive reported net returns, but none met the lab's combined qualification
criteria. This was not a full audit of that older simulator's accounting.

The 14 dashboard strategy entries in App.jsx cannot all be genuinely backtested:
its runBacktest function uses random signals/outcomes, including random resolution
inside EMA, Golden Setup and Adaptive S/R branches. Its strategy registry contains
hard-coded historic win rates/trade counts. These were inspected and excluded as
invalid evidence, not reported as completed market-data backtests. Chronos shadow
inference also lacks a reproducible historical decision-state replay in this run.

## Option strategy results before Zero-Hero execution changes

Figures below are gross premium R AFTER 0.5% entry/exit slippage, BEFORE charges.
R is actual entry-to-stop risk. No historical lot sizes were invented. The runner
stores one-unit charge calculations for diagnostics only; these are not lot-sized
portfolio returns. Split target/runner legs are correlated, not independent trades.

| Family / index | Completed legs | Unresolved legs | Average gross R |
|---|---:|---:|---:|
| Current / NIFTY | 1 | 0 | -0.154 |
| Current / BANKNIFTY | 1 | 0 | -1.118 |
| Current / SENSEX | 3 | 0 | -0.733 |
| Current / FINNIFTY | 0 | 0 | unavailable |
| Legacy / NIFTY | 13 | 0 | -0.221 |
| Legacy / BANKNIFTY | 3 | 1 | -0.528 |
| Legacy / SENSEX | 15 | 1 | +0.001 |
| Legacy / FINNIFTY | 0 | 0 | unavailable |
| Zero-Hero v1 / NIFTY | 16 | 0 | +0.033 |
| Zero-Hero v1 / BANKNIFTY | 4 | 2 | -0.931 |
| Zero-Hero v1 / SENSEX | 10 | 2 | -0.548 |
| Zero-Hero v2 / NIFTY | 4 | 0 | -0.716 |

Other Zero-Hero/index combinations and divergence had no qualifying entries.
FINNIFTY's score calls all rejected insufficient candle history (2,351 evaluations).
NIFTY's main score frequently rejected the narrow 10:00–10:30 scalp window.
Missing 14:00 candles also prevented divergence evaluations on eligible snapshots.
Fewer trades do not by themselves prove better quality.

After quote repairs, v1 NIFTY remained 16 completed legs at +0.034R, BANKNIFTY
4 at -0.960R, and SENSEX 10 at -0.548R. V2 NIFTY remained 4 at -0.716R.
This is NOT a profitable revised strategy. The risk-package and daily guardrail
changes were unit-tested but their full scanner portfolio effect was NOT replayed.
The local replay does not reproduce historical adaptive gating or concurrency.

## Repairs delivered

- Bridge square-off metadata changed from 15:15 to 15:12; retained 15:05 entry block.
- Launcher text now explains scanner versus tighter strategy entry windows.
- Existing replay slices completed candles only, sorts snapshots, and no longer
  resolves using future quotes before advancing its observation clock.
- New offline auditor uses exact expiry/strike/type, observed bid exits (including
  gaps), no entry-snapshot exits, and explicitly counts missing exits as unresolved.
- V1 requires positive bid, non-crossed ask, volume/OI and bounded spread. Its
  premium band and entry/target calculation use ask, not an assumed LTP fill.
- V2 rejects missing/crossed quotes and the scanner fetches its premium history
  for the selected front expiry, not the ordinary workflow's rolled expiry.
- All three Zero-Hero scanner branches consult normal session/cooldown/loss/trade
  count guardrails. Their intentional 0-DTE/cheap-premium strategy exemption stays;
  these exceptions do not waive risk controls.
- New package checks reject overlapping index positions, unaffordable full-debit
  loss (including estimated costs), targets that cannot cover costs, breached daily
  loss limits, and insufficient daily risk capacity after other pending debits.
- Existing adaptive strategy IDs remain unchanged to preserve loss-based pauses;
  revised v1 execution records carry an executionRevision field.

## Why these are diagnostic, not promotion evidence

The legacy candle collector identifies its instruments as monthly futures. CSV
filenames lack per-row security IDs/provenance, so those candles must not silently
be treated as verified spot-index history. Option chain snapshots are sparse and
can miss intrabar stops/targets. Historical VIX/events, lot schedules, cost schedules
and learned gate states are incomplete. Ordinary replay uses front expiry, while
live ordinary workflows can roll. Divergence tests the deployed five-minute
implementation rather than the original requested one-minute specification.
Unresolved legs are excluded from reported means, a potential survivorship bias.
Earlier window selection used some of this same history: this is NOT out-of-sample.

## Next engineering priorities

1. Replace the random dashboard simulator and hard-coded performance with audited
   result artifacts, clearly separating unavailable/illustrative data.
2. Collect timestamped spot-index candles separately from futures, immutable
   contract IDs/expiries/lot sizes, and selected-contract bid/ask premium paths.
3. Use a single deterministic event-clock runner for scanner and backtest, including
   risk/adaptive gates and conservative cost/slippage exits; reconcile its labels
   with the production resolver (which still assumes stop-level fills).
4. Then test an explicitly versioned option breakout/retest entry against the
   existing fade approach on later unseen expiry sessions, paper-shadow only.
   Do not optimize and certify on the same 11 NIFTY expiry files.

## Reproduction and artifacts

```powershell
node scripts/audit-stored-strategies.mjs strategy-lab/reports/new-stored-audit.json
.\.chronos-venv\Scripts\python.exe strategy-lab/audit_stored_lab.py strategy-lab/reports/new-lab-audit
npm.cmd test
npm.cmd run build
```

Original local results: `strategy-lab/reports/stored-audit-2026-09-06.json`.
Repaired signal rerun: `strategy-lab/reports/stored-audit-2026-09-06-repaired.json`.
Lab results/coverage: `strategy-lab/reports/lab-audit-2026-09-06/`.
Reports remain local; this document and runners are committed, not private market
archives or journals. Validation: 157 tests passed; production build passed;
scanner syntax and bridge/audit Python compilation passed. No runtime restart or
live-market acceptance was performed in this task.
