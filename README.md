<div align="center">

# ⬡ AlphaEdge

### AI-powered ICT / SMC Trading Platform

Live TradingView charts · AI-generated signals · backtesting · risk tools · Telegram broadcast

![Version](https://img.shields.io/badge/version-3.0.0-3b82f6)
![React](https://img.shields.io/badge/React-18-149eca)
![Vite](https://img.shields.io/badge/Vite-5-646cff)
![License](https://img.shields.io/badge/license-MIT-22c55e)

</div>

---

> **Disclaimer:** AlphaEdge is for research and education only. It is **not financial
> advice**, and backtested results do not guarantee live performance. See
> [`SECURITY.md`](./SECURITY.md) before deploying it anywhere public.

---

## Quick Start

**Requirements:** [Node.js 18+](https://nodejs.org) and a modern browser (Chrome / Edge recommended).

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>.

<details>
<summary>One-click setup scripts</summary>

- **Windows:** double-click `setup.bat`
- **Mac / Linux:** `chmod +x setup.sh && ./setup.sh`

</details>

## Configuration

Copy the example environment file and add your keys (or enter them in the in-app
**Settings** page):

```bash
cp .env.example .env
```

See [`.env.example`](./.env.example) for the full list. Read [`SECURITY.md`](./SECURITY.md)
to understand how keys are handled — in short, keep this app **local** unless you
add a backend to hold your secrets.

## Supported Assets

| Asset    | Exchange | Type      |
| -------- | -------- | --------- |
| BTC/USD  | Binance  | Crypto    |
| XAU/USD  | OANDA    | Commodity |
| ETH/USD  | Binance  | Crypto    |
| Nifty 50 | NSE      | Index     |

## Features

| Page           | What it does                                              |
| -------------- | --------------------------------------------------------- |
| Dashboard      | TradingView live chart + custom ICT canvas chart          |
| AI Signal      | AI generates an ICT + SMC + macro signal → Telegram       |
| Backtest       | Vectorised backtest on live candle data with equity curve |
| Execution      | Paper / live order management with position tracking      |
| Portfolio      | Equity curve, allocation, performance metrics             |
| Alerts         | Signal, geo, price, and backtest notifications            |
| History        | 30-day signal history with outcome tracking (persistent)  |
| Risk Calc      | Position sizing, Kelly criterion, scenario matrix         |
| Calendar       | Economic calendar with India + global events (IST)        |
| MTF Confluence | Multi-timeframe ICT analysis across 7 timeframes          |
| Journal        | Trade journal with psychology & mistake tracking          |
| Analytics      | Strategy stats, correlation heatmap, hourly analysis      |
| Settings       | API keys, risk params, Telegram bot, broker mode          |

### ICT signals drawn on the chart

The custom canvas chart detects and draws Order Blocks, Fair Value Gaps,
Break of Structure (BOS) / Change of Character (CHoCH), liquidity zones (equal
highs / lows), market-structure labels (HH, HL, LH, LL), EMAs (20 / 50 / 200),
session breaks (Asian, NSE India, London, New York) in IST, plus an RSI panel
and volume bars.

## Project Structure

```
alphaedge/
├── index.html            # app shell + global styles
├── src/
│   ├── main.jsx          # entry point (App wrapped in an ErrorBoundary)
│   ├── ErrorBoundary.jsx # keeps one crash from blanking the whole app
│   └── App.jsx           # pages, detection engine, and app logic
├── public/assets/        # static images (logo)
├── vite.config.js        # build & dev configuration
├── eslint.config.js      # lint rules
├── .prettierrc.json      # formatting rules
└── dist/                 # production build output (generated)
```

## Scripts

| Command           | Description                          |
| ----------------- | ------------------------------------ |
| `npm run dev`     | Start the dev server (port 3000)     |
| `npm run build`   | Production build into `dist/`        |
| `npm run preview` | Preview the production build locally |
| `npm run lint`    | Run ESLint                           |
| `npm run format`  | Auto-format the codebase (Prettier)  |

## Build for Production

```bash
npm run build
npm run preview
```

The `dist/` folder contains the static build, ready to deploy.

## Tech Stack

| Layer    | Technology                          |
| -------- | ----------------------------------- |
| Frontend | React 18 + Vite 5                   |
| Charts   | TradingView Widget + Canvas API     |
| AI       | Claude / OpenRouter / Gemini / Groq |
| Storage  | Browser localStorage                |
| Telegram | Bot API                             |
| Fonts    | JetBrains Mono                      |
| Icons    | Tabler Icons                        |

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup, code style, and the
refactor roadmap.

## License

[MIT](./LICENSE) © Subhash
