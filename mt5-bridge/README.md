# AlphaEdge → Dhan (India) Data Bridge

A small local service that gives the AlphaEdge browser app access to Dhan
market data. A browser can't call `api.dhan.co` directly (CORS), so this
bridge sits in between:

```
AlphaEdge (browser)  ──GET/POST──▶  bridge.py  ──HTTPS──▶  Dhan API
```

**This bridge places NO broker orders.** AlphaEdge is decision-support +
paper trading only (the MT5 execution path was removed in the 2026-07
Indian-options revamp).

## Start the bridge

Double-click **`run.bat`** (it installs the `dhanhq` package the first time,
then starts the bridge on `http://127.0.0.1:5000`). Leave the window open —
closing it stops the bridge.

Dhan credentials are read from `../strategy-lab/dhan_config.json` and the
access token auto-refreshes daily via PIN + TOTP (`dhan_token_refresh.py`).

## Endpoints

| Route                  | Method | What it returns                                                          |
| ---------------------- | ------ | ------------------------------------------------------------------------ |
| `/price`               | GET    | Live Dhan quotes: NIFTY50, BANKNIFTY, SENSEX, FINNIFTY + INDIAVIX         |
| `/dhan/vix`            | GET    | India VIX (`source:"dhan"`), or a collected-ATM-IV percentile proxy      |
| `/dhan/optionchain`    | POST   | ATM±range chain with greeks/IV + `ivPercentile`; CSV-snapshot fallback off-hours |
| `/dhan/historical`     | POST   | Index-futures candles (1m/5m/15m/1H/1D), auto-rolled contract            |
| `/dhan/lotsizes`       | GET    | Current F&O index lot sizes from the Dhan scrip master                   |
| `/dhan/profile`        | POST   | Dhan account/funds check (token validation)                              |
| `/market/holiday`      | GET    | NSE trading-day flag + holiday calendar (refreshed daily from dhan.co)   |
| `/wiki/*`              | GET    | Obsidian trader-wiki pages/context                                       |
| `/obsidian/monthly`    | POST   | Writes the app's monthly trade rollup markdown into the Obsidian vault   |

Anything else returns `404` — there is no order endpoint.

## Data files it reads

- `../strategy-lab/data/options/{UNDERLYING}_OPT_{date}.csv` — minute-level
  option-chain snapshots written by `dhan_options_collector.py`. Used for the
  off-hours chain fallback, IV percentile, and (from revamp Phase 4) the
  Trending-OI and premium-series endpoints.
- `nse_holidays.json` — cached holiday calendar.

## Troubleshooting

- **"dhanhq not installed"** → run `pip install dhanhq` in the repo venv.
- **Invalid/expired token** → regenerate on Dhan or run
  `python ../strategy-lab/dhan_token_refresh.py`; after a cold boot make sure
  Windows time sync ran (TOTP is time-sensitive).
- **Empty quotes off-hours** → normal; Dhan serves last-close OHLC, and the
  chain endpoint falls back to the last collected CSV snapshot.

## Chronos-2 paper-shadow timing

The bridge can optionally run the Chronos-2 timing layer for the already
selected option premium. It remains advisory only: AlphaEdge's deterministic
score and risk veto stay authoritative, and the bridge places no orders.

The launcher uses `D:\alphaedge\.chronos-venv`. Recreate/install it with:

```powershell
& "C:\Program Files\PostgreSQL\18\pgAdmin 4\python\python.exe" -m pip install virtualenv
& "C:\Program Files\PostgreSQL\18\pgAdmin 4\python\python.exe" -m virtualenv --python="C:\Program Files\PostgreSQL\18\pgAdmin 4\python\python.exe" D:\alphaedge\.chronos-venv
& D:\alphaedge\.chronos-venv\Scripts\python.exe -m pip install -r D:\alphaedge\mt5-bridge\requirements-chronos.txt
```

The first inference downloads the public `amazon/chronos-2` weights. CPU
inference is supported; keep the bridge process running so the model remains
warm. If Chronos is unavailable, `/ai/timing` returns `ok: false` and the
normal AlphaEdge paper workflow continues unchanged.
