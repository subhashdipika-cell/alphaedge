# AlphaEdge → MetaTrader 5 Bridge

A small program that lets AlphaEdge place trades in your MT5 terminal.
A browser can't talk to MT5 directly, so this bridge sits in between:

```
AlphaEdge (browser)  ──POST signal──▶  bridge.py  ──order_send──▶  MT5 terminal
```

## One-time setup

1. **Open MT5** and log into a working account (demo is perfect for testing).
2. In MT5: **Tools → Options → Expert Advisors → tick "Allow algorithmic trading"**.
3. Make sure you have **Python** installed (https://python.org).

## Start the bridge

Double-click **`run.bat`** (it installs the `MetaTrader5` package the first time,
then starts the bridge). You should see:

```
Connected to MT5: account 25600027 (VantageMarkets-Demo) ...
Mode: DRY-RUN (no real orders)
Listening on http://localhost:5000/signal
```

Leave that window open — closing it stops the bridge.

## Point AlphaEdge at it

In AlphaEdge → **Settings → MT5 Terminal**, set:

```
Bridge / API URL:   http://localhost:5000/signal
```

Click **Save Settings**. Now every signal AlphaEdge generates is sent to MT5.

## Going live (placing real orders)

The bridge **starts in DRY-RUN mode** — it only prints what it *would* trade, so you
can test safely. When you're happy:

1. Open `bridge.py`.
2. Change `DRY_RUN = True` to `DRY_RUN = False`.
3. Restart the bridge.

## Settings you can change (top of `bridge.py`)

| Setting        | Meaning                                                            |
| -------------- | ------------------------------------------------------------------ |
| `DRY_RUN`      | `True` = log only · `False` = place real orders                    |
| `DEFAULT_LOT`  | Lot size used per trade (default `0.01`)                           |
| `RISK_PERCENT` | `0` = always use DEFAULT_LOT · e.g. `1.0` = risk 1% of balance     |
| `MAX_LOT`      | Hard cap — never trade bigger than this                            |
| `SYMBOL_MAP`   | Maps AlphaEdge names (BTC/USD…) to your broker's symbols (BTCUSD…) |

The bridge auto-tries common broker suffixes (`XAUUSD`, `XAUUSD+`, `XAUUSD.m`, …),
so you usually don't need to touch `SYMBOL_MAP`.

## Troubleshooting

- **"MetaTrader5 package not installed"** → run `pip install MetaTrader5`.
- **Orders rejected / "AutoTrading disabled"** → enable *Allow algorithmic trading* in MT5 options.
- **"no MT5 symbol found for ..."** → add the correct broker symbol to `SYMBOL_MAP`.
- **Bridge can't connect** → make sure the MT5 terminal is open and logged in first.

> ⚠️ This places real orders when `DRY_RUN = False`. Test on a **demo** account first,
> keep lot sizes small, and never risk money you can't afford to lose.
