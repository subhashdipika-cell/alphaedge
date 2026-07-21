# AlphaEdge — frozen MT5 demo export (pre-v4.0.0)

These two monthly rollups were moved here from
`E:\Obsidian\Trading_Mind\raw\trades\alphaedge\` on 2026-07-22.

**Why they were removed from the vault:** they are a *different app*. They record
the pre-revamp MT5 demo fleet — XAU/USD, BTC/USD, ETH/USD and Nifty-50 **spot
signals denominated in USD**, last written 2026-07-08. The v4.0.0 revamp
(2026-07-14) made AlphaEdge an Indian index-**options** platform priced in ₹ with
MT5 stripped out entirely.

Left in the vault, they polluted analysis two ways:

- Obsidian Dataview indexes them by their `app: alphaedge` + `trades` frontmatter
  tags, so any fleet query mixed USD spot results into the ₹ options record.
- AppVault read them as AlphaEdge's track record, reporting 107 USD trades
  instead of the real 16 ₹ option trades.

**Nothing regenerates them.** `buildMonthlyMarkdown` in `src/App.jsx` now emits
`net_inr` and ₹; a fresh "Export to Obsidian" writes options data for these same
months, which is what should live in the vault going forward.

Kept for reference only — the MT5 demo track record is frozen, not deleted.
Do not feed these numbers into options analysis.

| File | Month | Trades | Win rate | Net (USD, MT5-realized) |
|---|---|---|---|---|
| `2026-06.md` | June 2026 | 40 (22 resolved) | 68.2% | +$62.22 |
| `2026-07.md` | July 2026 (to 07-08) | 67 (40 resolved) | 22.5% | −$143.40 |
