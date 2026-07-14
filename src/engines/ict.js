// ─── ICT / SMC SIGNAL DETECTION ENGINE ────────────────────────────────────────
// Pure candle-array detectors — no rendering, no fetching. Used by the canvas
// chart for drawing AND (from revamp Phase 6) headlessly by the Option Buying
// Score engine. Candle shape: { open, high, low, close, bull, vol, ts }.

export function detectSwings(candles, lb = 3) {
  const highs = [], lows = [];
  for (let i = lb; i < candles.length - lb; i++) {
    let isH = true, isL = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isH = false;
      if (candles[j].low  <= candles[i].low)  isL = false;
    }
    if (isH) highs.push({ i, price: candles[i].high });
    if (isL) lows.push({ i, price: candles[i].low });
  }
  return { highs, lows };
}

export function detectFVGs(candles) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    // Bullish FVG: C[i+1].low > C[i-1].high  → gap up
    if (candles[i + 1].low > candles[i - 1].high) {
      let filled = false, fillAt = -1;
      for (let j = i + 2; j < candles.length; j++) {
        if (candles[j].low <= candles[i + 1].low) { filled = true; fillAt = j; break; }
      }
      fvgs.push({ type: 'bull', i, top: candles[i + 1].low, bot: candles[i - 1].high, filled, fillAt });
    }
    // Bearish FVG: C[i+1].high < C[i-1].low  → gap down
    if (candles[i + 1].high < candles[i - 1].low) {
      let filled = false, fillAt = -1;
      for (let j = i + 2; j < candles.length; j++) {
        if (candles[j].high >= candles[i - 1].low) { filled = true; fillAt = j; break; }
      }
      fvgs.push({ type: 'bear', i, top: candles[i - 1].low, bot: candles[i + 1].high, filled, fillAt });
    }
  }
  return fvgs;
}

export function detectOrderBlocks(candles, swings) {
  const obs = [];
  const { highs, lows } = swings;
  // Bearish OB: last bullish candle at or before a swing high (before bearish impulse)
  highs.forEach(sh => {
    const nextLow = lows.find(l => l.i > sh.i);
    if (!nextLow || sh.price - nextLow.price < sh.price * 0.004) return;
    for (let i = sh.i; i >= Math.max(0, sh.i - 10); i--) {
      if (candles[i].bull) {
        const mitigated = candles.slice(i + 1).some(c => c.low <= candles[i].high && c.low >= candles[i].low);
        obs.push({ type: 'bear', i, top: candles[i].high, bot: candles[i].low, mitigated });
        break;
      }
    }
  });
  // Bullish OB: last bearish candle at or before a swing low (before bullish impulse)
  lows.forEach(sl => {
    const nextHigh = highs.find(h => h.i > sl.i);
    if (!nextHigh || nextHigh.price - sl.price < sl.price * 0.004) return;
    for (let i = sl.i; i >= Math.max(0, sl.i - 10); i--) {
      if (!candles[i].bull) {
        const mitigated = candles.slice(i + 1).some(c => c.high >= candles[i].low && c.high <= candles[i].high);
        obs.push({ type: 'bull', i, top: candles[i].high, bot: candles[i].low, mitigated });
        break;
      }
    }
  });
  return obs;
}

export function detectBOS(candles, swings) {
  const bos = [];
  const { highs, lows } = swings;
  for (let k = 1; k < highs.length; k++) {
    highs[k].price > highs[k - 1].price
      ? bos.push({ type: 'bull', i: highs[k].i, price: highs[k - 1].price, label: 'BOS' })
      : bos.push({ type: 'lh', i: highs[k].i, price: highs[k - 1].price, label: 'CHoCH' });
  }
  for (let k = 1; k < lows.length; k++) {
    lows[k].price < lows[k - 1].price
      ? bos.push({ type: 'bear', i: lows[k].i, price: lows[k - 1].price, label: 'BOS' })
      : bos.push({ type: 'hl', i: lows[k].i, price: lows[k - 1].price, label: 'CHoCH' });
  }
  return bos;
}

export function detectLiquidity(swings) {
  const lvls = [];
  const { highs, lows } = swings;
  const thr = 0.0025;
  for (let i = 0; i < highs.length - 1; i++) for (let j = i + 1; j < highs.length; j++) {
    if (Math.abs(highs[i].price - highs[j].price) / highs[i].price < thr)
      lvls.push({ type: 'eqh', price: (highs[i].price + highs[j].price) / 2, i1: highs[i].i, i2: highs[j].i });
  }
  for (let i = 0; i < lows.length - 1; i++) for (let j = i + 1; j < lows.length; j++) {
    if (Math.abs(lows[i].price - lows[j].price) / lows[i].price < thr)
      lvls.push({ type: 'eql', price: (lows[i].price + lows[j].price) / 2, i1: lows[i].i, i2: lows[j].i });
  }
  return lvls;
}

export function detectMSLabels(swings) {
  const pts = [];
  const { highs, lows } = swings;
  highs.forEach((h, k) => { pts.push({ i: h.i, price: h.price, label: k === 0 ? 'H' : highs[k].price > highs[k - 1].price ? 'HH' : 'LH', side: 'high' }); });
  lows.forEach((l, k) => { pts.push({ i: l.i, price: l.price, label: k === 0 ? 'L' : lows[k].price > lows[k - 1].price ? 'HL' : 'LL', side: 'low' }); });
  return pts;
}

export function detectPD(swings) {
  const { highs, lows } = swings;
  if (!highs.length || !lows.length) return null;
  const rh = highs[highs.length - 1].price, rl = lows[lows.length - 1].price;
  return { high: rh, low: rl, mid: (rh + rl) / 2 };
}

export function calcEMAs(candles) {
  const ema = (p) => {
    const k = 2 / (p + 1), r = [candles[0]?.close || 0];
    for (let i = 1; i < candles.length; i++) r.push(candles[i].close * k + r[i - 1] * (1 - k));
    return r;
  };
  return { e20: ema(20), e50: ema(50), e200: ema(200) };
}

export function calcRSI(candles, period = 14) {
  const rsi = [...Array(period).fill(50)];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    d > 0 ? gains += d : losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return rsi;
}

// True Range series (Wilder). candles: {high, low, close}. Returns TR[i>=1].
export function trueRange(candles) {
  const tr = [0];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return tr;
}

// Average True Range (Wilder-smoothed). Returns a series the length of candles.
export function calcATR(candles, period = 14) {
  if (candles.length <= period) return candles.map(() => 0);
  const tr = trueRange(candles);
  const out = new Array(candles.length).fill(0);
  let atr = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

// Rolling VWAP over the last `period` bars (anchored intraday proxy). Uses the
// typical price (H+L+C)/3 weighted by volume. Returns { vwap, slope } where
// `vwap` is the latest value and `slope` is its % change over ~6 bars. Falls back
// to a simple MA when volume is absent.
export function calcVWAP(candles, period = 75) {
  if (!candles || candles.length < 5) return { vwap: candles?.at(-1)?.close || 0, slope: 0, series: [] };
  const n = candles.length;
  const start = Math.max(0, n - period);
  const series = new Array(n).fill(0);
  let cumPV = 0, cumV = 0;
  for (let i = start; i < n; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    const v = (c.vol || 0) > 0 ? c.vol : 1;   // equal-weight when volume missing
    cumPV += tp * v; cumV += v;
    series[i] = cumV ? cumPV / cumV : c.close;
  }
  const vwap = series[n - 1];
  const prev = series[Math.max(start, n - 7)] || vwap;
  const slope = prev ? ((vwap - prev) / prev) * 100 : 0;
  return { vwap, slope, series };
}

// ADX / +DI / -DI (Wilder). Returns { adx, plusDI, minusDI } series.
export function calcADX(candles, period = 14) {
  const n = candles.length;
  const zeros = () => new Array(n).fill(0);
  const adx = zeros(), plusDI = zeros(), minusDI = zeros();
  if (n <= 2 * period) return { adx, plusDI, minusDI };
  const tr = trueRange(candles);
  const pDM = [0], mDM = [0];
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    pDM.push(up > down && up > 0 ? up : 0);
    mDM.push(down > up && down > 0 ? down : 0);
  }
  // Wilder-smoothed sums
  let atr = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let sp = pDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let sm = mDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  const dxArr = [];
  for (let i = period + 1; i < n; i++) {
    atr = atr - atr / period + tr[i];
    sp = sp - sp / period + pDM[i];
    sm = sm - sm / period + mDM[i];
    const pdi = atr ? (sp / atr) * 100 : 0;
    const mdi = atr ? (sm / atr) * 100 : 0;
    plusDI[i] = pdi; minusDI[i] = mdi;
    const dx = (pdi + mdi) ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0;
    dxArr.push({ i, dx });
  }
  // ADX = Wilder-smoothed DX, seeded by the first `period` DX values.
  if (dxArr.length >= period) {
    let a = dxArr.slice(0, period).reduce((s, d) => s + d.dx, 0) / period;
    adx[dxArr[period - 1].i] = a;
    for (let k = period; k < dxArr.length; k++) {
      a = (a * (period - 1) + dxArr[k].dx) / period;
      adx[dxArr[k].i] = a;
    }
  }
  return { adx, plusDI, minusDI };
}
