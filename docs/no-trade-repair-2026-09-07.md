# Paper scanner routing and evidence repair — 7 September 2026

## Findings

- Today's automated journal contains no entries or exits. Cumulative -Rs70,612.72 is historical, not today's P&L.
- Scanner NIFTY calls used the compatibility `dhanOptionScalp` flag, forcing SCALP instead of the existing regime-based style selector. Its 10:00–10:30 window intersects the 10:15 opening lockout for only 15 minutes.
- BANKNIFTY and FINNIFTY share the historical `score-v1` pause: ten losses, -1R average and 10R drawdown. They must not receive a fresh strategy ID to erase this evidence.
- Paused paths returned before scoring, hiding their current setup blockers. Idle health updates erased the last cycle's reasons.
- Historical replay passed observation timestamps but guardrails and session scoring still read wall-clock time. Style selection interpreted supplied timestamps in host local time rather than IST.

## Changes

- NIFTY scanner now uses `niftyOptionWorkflow`, preserving chart-first option confirmation while allowing the existing regime-based style selection. No window, threshold, loss limit, capital, sizing, or Zero-Hero rule was relaxed. Regime conditions can still select SCALP and remain blocked outside its window.
- Preserve strategy IDs and adaptive vetoes. Tag new score entries with `executionRevision: regime-routing-2026-09-07` for attribution.
- Score paused strategies only for diagnostics; their veto remains ahead of trade creation. This reuses already fetched inputs, without additional broker requests.
- Append completed regular scan diagnostics to `strategy-lab/paper/scan-decisions-YYYY-MM-DD.jsonl`. These are rejection records, not outcome labels or ML training evidence. Logging starts after deployment; it cannot reconstruct today's erased cycles. Zero-Hero's separate skip logs are not covered by this archive.
- Use observation time for guardrail lockout/cooldown/day calculations, style, index-context time and session quality. Today's cached holiday status is not applied to another replay date.
- Align current replay and stored-audit routing. Keep `--variant prior-routing` for forced-scalp comparison, using the corrected clock in both variants. Variant-specific result names prevent the comparison files overwriting one another.

## Validation and limitations

- Full JavaScript suite: 163 tests passed; production build passed; scanner syntax check passed.
- Offline, identity-bearing INDEX candles only; no new Dhan calls:
  `node scripts/replay.mjs --local-only --from 2026-09-01 --to 2026-09-07 --variant prior-routing`
  and the same command with `--variant current`.
- 16 index-day files: four indices on September 1, 2, 3 and 7. Both variants: zero trades. Scalp-window rejection occurrences: 327 prior, 265 current. Insufficient-history occurrences: 366 in each; volatility-compression occurrences: 379 in each. Counts overlap across gates, not independent opportunities.
- The earliest verified day has only 25 15-minute bars; score requires 50. Historical VIX and event context are absent. Current replay still lacks production portfolio/adaptive-state simulation and does not establish exact execution fills. This is a diagnostic comparison, not profitability or out-of-sample promotion evidence.
- Do not describe zero trades as 0% predictive accuracy. Win rate is undefined without resolved trades.
- Keep existing pauses. Reliable improvement requires adequate verified warm-up data, cost-aware execution outcomes and separate validation. No automatic retuning, live orders or resumed Codex monitoring was enabled.

## Deployment

At 18:03 IST, restarted only the verified idle scanner (old PID 17508, new PID 180), retaining `--zerohero-v2 --zerohero-divergence`. The new process completed its after-hours idle cycle, preserved all 61 historical records and zero open positions, and emitted no startup error. Bridge confirmed `ordersEnabled:false`. A market-hours scan and first valid fill remain unverified; scheduled Codex monitoring remains paused.
