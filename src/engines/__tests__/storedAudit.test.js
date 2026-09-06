import { describe, it, expect } from 'vitest';
import { sliceTo, snapshots } from '../../../scripts/replay.mjs';
import { settle } from '../../../scripts/audit-stored-strategies.mjs';
describe('offline replay integrity', () => {
  it('only includes completed candles', () => {
    expect(sliceTo([{ ts: 0 }, { ts: 300000 }], 300000, 5)).toEqual([{ ts: 0 }]);
  });
  it('orders snapshots chronologically', () => {
    expect(snapshots([{ time: '2026-09-01 04:00:00' }, { time: '2026-09-01 03:55:00' }])[0].hhmm).toBe('09:25');
  });
  it('does not resolve from entry quote or another expiry; gaps use observed bid', () => {
    const trade = { entryTs: Date.parse('2026-09-01T04:00:00Z'), optionPremium: 100, slPremium: 80,
      tgtPremium: 150, strike: 24000, direction: 'CE', assetId: 'NIFTY50' };
    const q = (time, expiry, bid) => ({ time, hhmm: '09:35', legs: [{ strike: 24000, type: 'CE', expiry, bid, ask: bid + 1 }] });
    const rows = [q('2026-09-01 04:00:00', '2026-09-08', 10), q('2026-09-01 04:05:00', '2026-09-15', 20)];
    expect(settle(trade, rows, 0, '2026-09-08')).toBeNull();
    rows.push(q('2026-09-01 04:10:00', '2026-09-08', 60));
    expect(settle(trade, rows, 0, '2026-09-08').exit).toBeCloseTo(59.7);
  });
});
