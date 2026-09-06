# Stored evidence dashboard and candle provenance

## Changes

Strategy Lab now reads `/rd/stored-audit`, a read-only bridge endpoint selecting
the latest readable `strategy-lab/reports/stored-audit-*.json` research artifact.
The old random `runBacktest` implementation and hard-coded strategy win-rate
registry were removed. The page does not use chart simulation data or assign
profitability to strategies without a valid report. It shows gross premium R,
completed/unresolved legs, rejections, generation time, and research limitations.
It does not claim net portfolio returns, independent samples, or live readiness.
An absent/unreachable report is an error/empty state, not fabricated performance.

Both historical candle collectors now write identity-bearing archives:

`strategy-lab/data/verified/{INDEX|FUTIDX}/{symbol}/{security_id}/{symbol}_{tf}_{session-date}.csv`

Rows record Dhan source, instrument kind, security ID, segment, expiry/lot where
applicable, collection timestamp, and UTC bar-open convention. The session filename
uses IST trade date, not download date. Unfinished candles are not persisted.
Existing files are never moved, overwritten or retroactively claimed verified.
Futures collection is preserved but cannot contaminate the new INDEX directory.
The Zero-Hero history collector uses the same writer (60-minute candles use H1).

Offline score replay and the audit runner require recorded INDEX identity by
default. Missing verified history stays missing. An explicit `--allow-unverified`
research flag permits the legacy archive and labels new audit reports accordingly.
Old reports without provenance metadata display `LEGACY_UNVERIFIED` in the UI.
The older Python futures lab and dedicated legacy proxy runners are not converted
into certified option backtests by this change; do not use them for promotion.

## Running

Restart AlphaEdge's bridge and refresh the browser to load the new endpoint/UI.
The new endpoint does not appear in an already-running old bridge process.
The daily pipeline already invokes the updated historical collectors. To request
a manual authenticated backfill instead (this does use Dhan data quota):

```powershell
.\.chronos-venv\Scripts\python.exe strategy-lab/dhan_collector.py --days 5 --only NIFTY50,BANKNIFTY,SENSEX,FINNIFTY
node scripts/audit-stored-strategies.mjs strategy-lab/reports/stored-audit-new.json
```

For a labelled diagnostic reproduction on old data only:

```powershell
node scripts/audit-stored-strategies.mjs strategy-lab/reports/stored-audit-legacy.json --allow-unverified
```

The standalone desktop launcher starts the forward option-chain collector; it
does not itself run this historical backfill. The existing daily pipeline does.
This task did not modify Windows scheduled tasks, run authenticated collection,
restart trading processes, or train/deploy a new Zero-Hero model.

## Validation

- 158 JavaScript tests pass, including an SSR empty-state regression.
- Four offline Python archive/report tests pass (temporary fixture data only).
- Production frontend build and Python syntax checks pass.
- Read-only archive check found zero verified NIFTY candles; strict replay did not
  substitute 16,994 legacy rows. That raw legacy count includes duplicate timestamps
  and is not a unique bar/session count.
- Report adapter reads the existing 196-file audit; these older results remain
  explicitly unverified research evidence, not newly certified performance.
- User-visible browser rendering and authenticated collector success require
  runtime verification after restart; neither is asserted here.
