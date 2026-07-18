"""
buy_window_scan.py — which intraday entry windows favour option BUYING?

Simulates the standard AlphaEdge trade at every 15-min entry slot of every
collected NON-expiry day (expiry days belong to the roll / Zero Hero domain):

  side   : the trend side (underlying above its snapshot-EMA -> CE, else PE),
           counter-trend tracked separately for comparison
  strike : the side's leg with |delta| closest to 0.55 (the style ideal)
  entry  : ask (fallback ltp)
  SL     : 30% of premium (the baseline rule)   target: 2R
  trail  : arms at +1R, trails 1R behind the peak bid (resolver semantics)
  exit   : SL-first, then trail, then target, else 15:15 square-off

Reports per 30-min window: n, win%, avg R, SL-hit%, target%, trail-exit%.
Run:  python strategy-lab/buy_window_scan.py
"""
import csv, glob, io, os, sys
from collections import defaultdict

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SL_PCT = 0.30
RR = 2.0
CUTOFF = 15 * 60 + 15
LAST_ENTRY = 14 * 60 + 45
FIRST_ENTRY = 9 * 60 + 30
STEP = 15
IST = 330
IDEAL_DELTA = 0.55

def ist_min(u): return (int(u[11:13]) * 60 + int(u[14:16]) + IST) % 1440

def num(x):
    try: return float(x)
    except Exception: return 0.0

def simulate(entry, sl_pts, later_bids):
    """Resolver-faithful walk. Returns (exitPremium, reason)."""
    sl = entry - sl_pts
    tgt = entry + RR * sl_pts
    armed, peak, trail = False, entry, None
    for b in later_bids:
        if b > peak: peak = b
        if not armed and b >= entry + sl_pts: armed = True
        if armed: trail = max(trail if trail is not None else -1e9, peak - sl_pts)
        stop = max(sl, trail) if armed and trail is not None else sl
        if b <= stop:
            return (stop, "trail" if armed and stop > sl else "sl")
        if b >= tgt:
            return (tgt, "target")
    return (later_bids[-1], "squareoff")

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    files = []
    for f in sorted(glob.glob(os.path.join(here, "data", "options", "*_OPT_*.csv"))):
        date = os.path.basename(f).split("_OPT_")[1][:10]
        with open(f) as fh:
            row = next(csv.DictReader(fh), None)
        if row:
            files.append((os.path.basename(f).split("_OPT_")[0], date, f, row.get("expiry") == date))

    n_expiry = sum(1 for x in files if x[3])
    agg = defaultdict(lambda: defaultdict(lambda: {"n": 0, "r": 0.0, "win": 0, "sl": 0, "tgt": 0, "trail": 0, "sq": 0}))
    per_u = defaultdict(lambda: defaultdict(lambda: {"n": 0, "r": 0.0}))

    for under, date, path, is_exp in files:
        if is_exp:
            continue                       # non-expiry days only
        rows = list(csv.DictReader(open(path)))
        # front expiry only (expiry-day dual files can't appear here, but be safe)
        exps = sorted({r.get("expiry", "") for r in rows if r.get("expiry")})
        if len(exps) > 1:
            rows = [r for r in rows if r.get("expiry") == exps[0]]
        legs = defaultdict(list)
        snaps = defaultdict(dict)
        under_ltp = {}
        for r in rows:
            t = ist_min(r["time"])
            key = (r["strike"], r["type"])
            rec = (t, num(r["ltp"]), num(r["bid"]), num(r["ask"]), num(r["delta"]))
            legs[key].append(rec)
            snaps[t][key] = rec
            under_ltp[t] = num(r["under_ltp"])
        times = sorted(snaps)
        if len(times) < 60:
            continue
        # EMA of the underlying across snapshots (~100-min horizon, like 5m EMA20)
        ema_at, ema, k = {}, None, 2 / 101
        for t in times:
            v = under_ltp[t]
            ema = v if ema is None else v * k + ema * (1 - k)
            ema_at[t] = ema
        last_e = -999
        for t in times:
            if t < FIRST_ENTRY or t > LAST_ENTRY or t - last_e < STEP:
                continue
            last_e = t
            trend_side = "CE" if under_ltp[t] >= ema_at[t] else "PE"
            for side_tag, side in (("trend", trend_side), ("counter", "PE" if trend_side == "CE" else "CE")):
                best = None
                for key, rec in snaps[t].items():
                    if key[1] != side:
                        continue
                    d = abs(rec[4])
                    if d <= 0:
                        continue
                    if best is None or abs(d - IDEAL_DELTA) < abs(abs(best[1][4]) - IDEAL_DELTA):
                        best = (key, rec)
                if best is None:
                    continue
                key, rec = best
                entry = rec[3] if rec[3] > 0 else rec[1]
                if entry < 40:                     # engine's premium floor
                    continue
                sl_pts = round(entry * SL_PCT)
                later = [(x[2] if x[2] > 0 else x[1]) for x in legs[key] if t < x[0] <= CUTOFF]
                if len(later) < 10:
                    continue
                exit_p, why = simulate(entry, sl_pts, later)
                r_mult = (exit_p - entry) / sl_pts
                w = f"{(t // 30) * 30 // 60:02d}:{(t // 30) * 30 % 60:02d}"
                a = agg[side_tag][w]
                a["n"] += 1; a["r"] += r_mult; a["win"] += r_mult > 0
                a[{"sl": "sl", "target": "tgt", "trail": "trail", "squareoff": "sq"}[why]] += 1
                if side_tag == "trend":
                    pu = per_u[under][w]; pu["n"] += 1; pu["r"] += r_mult

    print(f"days used: {len(files) - n_expiry} non-expiry (excluded {n_expiry} expiry days)\n")
    for tag in ("trend", "counter"):
        print(f"── {tag.upper()}-SIDE ATM buy (Δ≈0.55, SL 30%, 2R tgt, 1R trail) ──")
        print(f"{'window':>6} {'n':>4} {'win%':>6} {'avgR':>7} {'SL%':>5} {'tgt%':>5} {'trail%':>6} {'sq%':>5}")
        for w in sorted(agg[tag]):
            a = agg[tag][w]
            if not a["n"]: continue
            print(f"{w:>6} {a['n']:>4} {100*a['win']/a['n']:>5.1f}% {a['r']/a['n']:>+6.2f}R "
                  f"{100*a['sl']/a['n']:>4.0f}% {100*a['tgt']/a['n']:>4.0f}% {100*a['trail']/a['n']:>5.0f}% {100*a['sq']/a['n']:>4.0f}%")
        print()
    print("trend-side avg R by window per underlying (n>=15):")
    for u in sorted(per_u):
        parts = [f"{w}:{per_u[u][w]['r']/per_u[u][w]['n']:+.2f}R({per_u[u][w]['n']})"
                 for w in sorted(per_u[u]) if per_u[u][w]["n"] >= 15]
        print(f"  {u}: " + "  ".join(parts))

if __name__ == "__main__":
    main()
