<div align="center">

# ⬡ AlphaEdge

### Indian Index-Options Buying — Decision-Support & R&D Platform

Trending-OI intelligence · a 0–100 Option Buying Score · trade-style engine ·
premium-tracked paper trading (net of real F&O costs) · a self-learning R&D loop

![Version](https://img.shields.io/badge/version-4.0.0-3b82f6)
![React](https://img.shields.io/badge/React-18-149eca)
![Vite](https://img.shields.io/badge/Vite-5-646cff)
![License](https://img.shields.io/badge/license-MIT-22c55e)

</div>

---

> **Disclaimer:** AlphaEdge is a research / decision-support tool for education only.
> It is **not** financial advice, it places **no** broker orders (paper trading only),
> and backtested/replayed results do not guarantee live performance. You place any real
> trades yourself, in your own broker app.

---

## What it does

AlphaEdge scores Indian index-option **buying** opportunities (NIFTY, BANKNIFTY,
SENSEX, FINNIFTY) by passing every candidate through independent engines and
combining them into an explainable **decision report** — then tracks the
recommendation as a paper trade against the real option-premium path and feeds the
outcome back into a self-learning R&D loop.

It is **decision-support + paper only**. There is no live order execution.

## The engines (`src/engines/`)

| Engine | File | What it does |
| ------ | ---- | ------------ |
| **Market Regime** | `regime.js` | Day-type (trend / breakout / range / vol-compression / expiry / event) + confidence, from VIX, ADX, ATR, IV percentile, PCR, OI. Vetoes buyer-hostile regimes. |
| **Trending OI** | `oi.js` | OI as a time series: velocity, acceleration, writing/unwinding strength, centroids/migration, walls, OI spurts, OI flip, Max Pain, Black-Scholes gamma wall, smart-money composite. |
| **ICT / SMC** | `ict.js` | Order Blocks, FVGs, BOS/CHoCH, liquidity, market structure, PD arrays, EMAs, RSI, ATR, ADX, VWAP. |
| **Option Buying Score** | `score.js` | 8 weighted factors → 0–100 with per-check reasons, hard gates, coverage renormalization, direction (CE/PE), and the decision report. |
| **Trade Style** | `style.js` | Strategy Selector: scalp / intraday / swing, each with its own weight profile, strike-delta band, and hold/time-stop. |
| **Strike / Plan** | `strike.js` | Expected move (ATM straddle), delta-band strike selection, position sizing. |
| **Guardrails** | `guardrails.js` | Discipline rules from the −₹3.4L audit (0-DTE block, min premium, cooldowns, loss-streak, session lockout). |
| **Costs + Resolve** | `costs.js`, `resolve.js` | Realistic Dhan F&O round-trip cost model; premium-series walker (SL-first, theta time-stop, 15:15 square-off) — outcomes net of costs. |
| **R&D / Meta-learning** | `rnd.js` | Per-style + per-regime expectancy, per-factor attribution, and a weight tuner (opt-in, never auto-applied). |

Engines are pure ES modules, unit-tested with **vitest** (`npm test`).

## The pages (`src/pages/`)

- **Dashboard** — indices, India VIX, discipline status, recent recommendations.
- **Option Score** — the decision engine: score, regime, style, strike, plan, decision report, "Paper trade this".
- **OI Pulse** — the Trending-OI dashboard (heat table, walls, spurts, smart-money).
- **Paper Trades** — premium-tracked blotter with cost-netted P&L and per-style stats.
- **R&D** — meta-learning over the paper-trade / replay record (attribution + weight tuner).
- Plus MTF Confluence, History, Calendar, Journal, Money Mgt., Settings, and an optional AI second-opinion.

## Architecture

```
Dhan API ─► mt5-bridge/bridge.py (:5000, pure Dhan DATA service — NO orders)
              /price /dhan/optionchain /dhan/historical /dhan/oitrend
              /dhan/premium /dhan/vix /dhan/lotsizes /market/holiday /rd/replay
              ▲ reads: strategy-lab/data/options/*.csv (1-min chain snapshots)
Vite + React app: src/{lib,data,engines,state,components,pages}
strategy-lab/dhan_options_collector.py ─► the OI/premium history the engines learn from
scripts/replay.mjs ─► backtests the SAME engines over the collected CSVs (out-of-sample)
```

The browser can't call `api.dhan.co` directly (CORS), so all Dhan data routes
through the local Python bridge. **The bridge places no orders** — the MT5
execution path was removed in the 4.0 revamp.

## Quick start

**Requirements:** [Node.js 18+](https://nodejs.org), Python 3, a Dhan account.

```bash
npm install
npm run dev            # app on http://localhost:5001
```

In another terminal, start the data bridge (installs `dhanhq` on first run):

```bash
mt5-bridge/run.bat     # Windows — serves Dhan data on http://127.0.0.1:5000
```

Dhan credentials live in `strategy-lab/dhan_config.json` (TOTP auto-refresh). The
app's **Settings → Local Data Bridge** defaults to `http://127.0.0.1:5000`.

To collect the OI/premium history the engines learn from, run the collector during
market hours (it self-gates on the NSE session):

```bash
python strategy-lab/dhan_options_collector.py
```

To backtest the score over the collected history (bridge must be running):

```bash
node scripts/replay.mjs                 # writes strategy-lab/results/replay_*.json
```

## Scripts

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Dev server (port 5001) |
| `npm run build` | Production build → `dist/` |
| `npm test` | Run the engine unit tests (vitest) |
| `npm run lint` | ESLint |
| `node scripts/replay.mjs` | Options-premium score replay for R&D |

## Tech stack

| Layer | Technology |
| ----- | ---------- |
| Frontend | React 18 + Vite 5 |
| Charts | TradingView widget + Lightweight-Charts + Canvas |
| Data bridge | Python stdlib `http.server` + `dhanhq` |
| Tests | vitest (engine modules) |
| Storage | Browser localStorage (+ collected CSVs server-side) |
| Alerts | Telegram Bot API (optional) |

## What's deliberately NOT here (backlog)

Live order execution, auto-hedging / multi-leg spreads, FII/DII + participant OI,
market breadth, global cues, news NLP, and tick-level order flow (CVD / market
depth) — these need a live tick feed or are gated behind forward-test evidence
before any live execution is considered.

## License

[MIT](./LICENSE) © Subhash
