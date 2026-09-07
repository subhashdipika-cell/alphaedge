# Live monitoring and collector recovery — September 7, 2026

Initial checks at 09:19–09:26 IST found the scanner alive and processing its
first market cycle, but a long-running scheduled option collector failing on
every index. Its startup was 06:30; the credentials file was refreshed at 09:14.
A direct paced request and the exact SDK path with freshly loaded credentials
both succeeded (HTTP 200; 227 NIFTY strike nodes). Retained credentials are the
strongly supported explanation, not a confirmed broker rate-limit incident.

Changed the collector to rebuild its authenticated client from configured
credentials once per collection cycle, without rotating credentials. Empty SDK
error fields no longer count as proof of throttling. Three focused regression
tests passed and Python compilation passed.

Restarted only the verified AlphaEdge-StrategyLab scheduled task. It refreshed
data and launched the repaired collector; all four indices recorded fresh
option snapshots at 09:26. Other trading apps and risk policies were unchanged.

At 12:56 IST, the bridge still reported ordersEnabled:false, scanner PID 17508
matched scripts/scanner.mjs, and its latest completed cycle was 12:54:43 IST.
Collector snapshots for all four indices were fresh through 12:56:22 IST.
The journal remained 61 resolved historic trades, zero open and zero new trades.
This is not proof that a permitted entry/fill/exit works end to end.

Latest rejection evidence:
- NIFTY: outside 10:00–10:30 scalp window; 1.8 ATR chasing rejection.
- SENSEX: outside selected scalp window; 2.2 ATR chasing rejection.
- BANKNIFTY and FINNIFTY: shared score-v1 adaptive pause (ten losses in its sample).

The 10:15 opening lockout plus 10:30 scalp cutoff leaves only a fifteen-minute
effective scalp-entry window. Do not expand it or reset loss pauses without a
separately validated policy revision. Adaptive loss gating is not proof of an
autonomously improving model; immutable signal-time features, reconciled labels
and out-of-sample validation remain necessary.

Created the five-minute thread heartbeat monitor-alphaedge-paper-trading after
resolving a duplicate-check rejection. It performs session-scoped read-only
checks and notifies meaningful changes; it does not authorize live orders,
forced trades, risk increases or automatic model promotion. A scheduled trigger
is not evidence that every intermediate interval was actually inspected.
