# AlphaEdge runtime validation — 2026-09-07, approximately 02:04–02:10 IST

- No AlphaEdge service was running at the initial process/port check. Started
  the existing start-alphaedge.bat using its hidden-window mode; did not stop
  other trading applications or create a second dashboard tab.
- Bridge responds on port 5000 with `ordersEnabled: false`; UI listens on 5001.
- Scanner started as PID 10140 and completed its first pre-open idle cycle with
  zero open positions. Historical journal totals remained 61 resolved trades.
- Option collector authenticated and resolved front expiries for NIFTY50,
  BANKNIFTY, SENSEX and FINNIFTY, then correctly slept outside market hours.
- Historical collector completed successfully using existing Dhan credentials:
  four INDEX instruments each wrote 1,500 M1, 300 M5 and 28 H1 bars for four
  September sessions. Three available futures instruments each wrote 1,540 M1,
  308 M5 and 28 H1 bars into separate FUTIDX directories.
- Strict offline reader now finds 300 identity-bearing M5 candles for each of
  the four indices. Credentials were not copied into reports or commits.
- Inspected the actual launcher-opened Chrome tab. Strategy Lab displayed the
  196-file saved report, completed/unresolved legs, rejection reasons and the
  LEGACY_UNVERIFIED warning. Backfilling new data does not certify old results.
- Fixed an observed hard-coded MARKETS OPEN header. The browser now shows
  MARKET CLOSED; the price-source label also distinguishes last-close data.

This is startup, UI and historical-data-access validation, not a market-session
scan, options-fill test, profitability proof, or Chronos inference validation.
No broker orders were placed. Services were left running in paper mode.
