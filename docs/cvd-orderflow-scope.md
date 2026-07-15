# Scope — Order-Flow CVD (Cumulative Volume Delta) for scalp triggers

**Status:** scoped, not built. This is the next real build after the trailing-stop
(2026-07-15). Paper/decision-support only — no order execution.

## Goal
A tick-level **Cumulative Volume Delta** tracker: aggressive buy volume (trades
hitting the ask) minus aggressive sell volume (hitting the bid). A sudden, large
skew = an institutional sweep = an immediate SCALP entry trigger. Complements the
existing 5-min score (which is too slow to catch a sweep).

## The data problem (why this is a "real build")
Today AlphaEdge has **no tick data** — the collector polls the option chain over
REST every ~60s. CVD needs a live tick stream, so this is gated on wiring Dhan's
**market-feed websocket**.

- **Source:** DhanHQ-py `marketfeed` (websocket). Modes: Ticker (LTP), **Quote**
  (LTP, LTQ, volume, total buy/sell qty, OHLC), **Full** (Quote + 5-level depth +
  OI). CVD needs Quote (LTP + LTQ + volume) and ideally Full (best bid/ask).
- **Aggressor side is not labelled by Dhan** — approximate it (Lee-Ready / tick
  rule): trade at/above best ask → buyer-initiated (+LTQ); at/below best bid →
  seller-initiated (−LTQ); in-between → sign by up/down-tick vs prior print.
  Per-interval delta = Δvolume signed by trade direction.

## Architecture (fits the existing bridge = data service, no orders)
```
Dhan market-feed WS ─► bridge: persistent WS consumer (background thread)
                         ├ subscribe: index + ATM CE/PE per underlying (small set)
                         ├ per-instrument CVD state: cumulative delta + rolling-window delta
                         └ GET /cvd?underlying=NIFTY50 → { cvd, windowDelta, sweep{side,strength}, asOf }
src/engines/cvd.js  ─► sweep detection: window delta beyond N·σ of its own baseline
                         → { trigger, side, strength 0-1, reasons[] }  (pure, unit-tested)
scanner + Option Score ─► SCALP path consumes cvd.js as a fast trigger / factor
OI Pulse / Option Score ─► CVD tape + sweep badge (display)
```

## Deliverables (phased)
- **A — Feed + state (bridge):** WS consumer (auth from `dhan_config.json`,
  reconnect/backoff), per-instrument CVD accumulation, `GET /cvd`. Verify against
  live ticks in-session. *(largest piece — new persistent connection + threading
  alongside the stdlib http.server.)*
- **B — Engine:** `src/engines/cvd.js` sweep detection + `fetchCvd()` in
  `data/bridge.js`; vitest with synthetic tick series (known sweeps).
- **C — Wire + display:** SCALP-only trigger/factor in the score + scanner; CVD
  tape + sweep badge on OI Pulse / Option Score.
- **D — (optional) real-time:** sub-second loop or WS-to-browser passthrough for
  true tick scalping (vs polling `/cvd` every 2-3s).

## Risks / open questions
- Dhan WS **instrument-subscription limits** and rate limits — keep the set small
  (index + ATM±1 per underlying), re-subscribe as ATM drifts.
- Aggressor classification is an **approximation** — validate against a few known
  sweeps before trusting it as a trigger.
- Bridge is currently a simple `http.server`; a persistent WS thread + shared
  state needs care (locking, clean shutdown, reconnection).
- **Backtesting CVD is out of initial scope:** it needs captured tick history; the
  collector only stores 1-min snapshots. Live/forward-test first; a tick recorder
  is a separate effort if we want CVD in `replay.mjs`.

## Effort
Core (A+B+C) is a few focused sessions; A dominates. Ship A+B, validate the signal
on live data, then wire C. D only if polling proves too slow for the scalp edge.
