// ─── PURE MATH / SERIES HELPERS ───────────────────────────────────────────────

// Exponential moving average series.
export function emaSeries(vals, period) {
  if (!vals.length) return [];
  const k = 2 / (period + 1);
  let prev = vals[0];
  const out = [prev];
  for (let i = 1; i < vals.length; i++) { prev = vals[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}

// Merge fine candles into coarser buckets (4H from 1H, 1W from 1D).
export function aggregateCandles(rows, groupSize) {
  const out = [];
  for (let i = 0; i < rows.length; i += groupSize) {
    const grp = rows.slice(i, i + groupSize);
    if (!grp.length) break;
    const open = grp[0].open, close = grp[grp.length - 1].close;
    out.push({
      ts:    grp[0].ts,
      open, close,
      high:  Math.max(...grp.map(c => c.high)),
      low:   Math.min(...grp.map(c => c.low)),
      vol:   grp.reduce((a, c) => a + (c.vol || 0), 0),
      bull:  close >= open,
    });
  }
  return out;
}
