# Verified history coverage repair — 7 September 2026

## Root causes and changes

The verified INDEX archive had only five session files per index. Daily collection requested five calendar days. The collector also treated Dhan's 90-day per-request limit as total history retention and silently truncated longer requests.

Dhan's official historical-data documentation describes up to five years of intraday data for active instruments, with a maximum 90 days per request: https://dhanhq.co/docs/v2/historical-data/. This is not a promise of complete historical option-chain snapshots.

- Added inclusive `--from-date`/`--to-date`, bounded `--chunk-days` (default 30), and `--indices-only` (no futures lookup or requests).
- Intraday calls use explicit 09:15–15:30 date-time bounds. Longer requests are chunked rather than silently shortened. One-off backfill used existing credentials, no token refresh, no orders.
- Empty or failed intraday requests produce exit 2, rather than a misleading success. The daily parent now reports child failures.
- Daily default refresh is 21 calendar days, overlapping existing data. An additional refresh after options collection captures candles unavailable at morning startup. Existing scheduled processes load these changes on their next run; they were not restarted.
- Added offline `node scripts/check-history-coverage.mjs`, also invoked after successful daily history collection when Node is available. It uses only identity-bearing INDEX candles and counts completed bars before the first option snapshot on each stored index-day.
- Existing timestamp deduplication and INDEX/FUTIDX separation remain. Legacy files were not relabelled, and genuine new data stays local/ignored by Git.

## Actual collection and validation

Command executed successfully:

```powershell
D:\alphaedge\.chronos-venv\Scripts\python.exe D:\alphaedge\strategy-lab\dhan_collector.py --indices-only --from-date 2026-06-01 --to-date 2026-09-07
node D:\alphaedge\scripts\check-history-coverage.mjs
```

48 paced Dhan requests across four indices, three intervals (M1, M5, H1), four date chunks; collection exited 0. Initial sandbox-blocked network attempt was stopped before the authorized successful run.

M5 archive session-file counts after backfill: NIFTY 70, BANKNIFTY 70, FINNIFTY 70, SENSEX 71. These are returned archive session dates, not independently certified exchange trading days. Coverage inventory: all 200 stored option index-days have at least 50 completed M5, derived M15, and H1 candles before the first snapshot in the 14-calendar-day lookback.

Recent replay September 1–7 (16 index-day files) still produced zero trades. First-day BANKNIFTY input increased from 75 M5 / 25 M15 / 7 H1 bars to 825 / 275 / 77. Insufficient index history disappeared from the top rejection reasons; remaining reasons include time windows, regimes, spread, and selected-option premium history. No risk gate was relaxed.

## Limits

Count-ready is not complete-data certification. The inventory does not prove continuity, every intrabar touch, historical VIX/events, historical option-chain completeness, or live availability at the time. Genuine retrospective index backfill improves replay inputs; it cannot manufacture missing option snapshots. No live trading, automatic strategy promotion, or Codex monitoring was enabled.

Tests: three history-window unit tests, four archive tests, three existing collector-error tests passed; Python compilation passed. Full JavaScript suite is rerun as part of delivery.
