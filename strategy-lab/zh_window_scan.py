"""Zero-Hero window scan: for each expiry-day CSV, every ~5 min sample every
option priced Rs 3-5 (ask), then simulate the ZH rules on the LATER bid path:
  unit A: exit at 2x entry if touched, else at the last bid <= 15:15
  unit B: trailing runner - arms at 2x, trails one entry-premium behind peak
Aggregates by 30-min entry window."""
import csv, glob, os
from collections import defaultdict

BAND = (3.0, 5.0)
CUTOFF = 15 * 60 + 15          # 15:15 IST square-off
LAST_ENTRY = 14 * 60 + 55
IST = 330

def ist_min(utc):
    h, m, s = utc[11:13], utc[14:16], utc[17:19]
    t = int(h) * 60 + int(m) + IST
    return t % (24 * 60)

def num(x):
    try: return float(x)
    except Exception: return 0.0

files = []
for f in sorted(glob.glob('strategy-lab/data/options/*_OPT_*.csv')):
    date = os.path.basename(f).split('_OPT_')[1][:10]
    with open(f) as fh:
        row = next(csv.DictReader(fh), None)
    if row and row.get('expiry') == date:
        files.append((os.path.basename(f).split('_OPT_')[0], date, f))

agg = defaultdict(lambda: {'n':0,'hit2':0,'hit5':0,'hit10':0,'zh':0.0,'zhwin':0,'maxm':[]})
per_u = defaultdict(lambda: defaultdict(lambda: {'n':0,'hit2':0,'zh':0.0}))

for under, date, path in files:
    rows = [r for r in csv.DictReader(open(path)) if r.get('expiry') == date]
    # per-leg chronological series: (istMin, ltp, bid, ask)
    legs = defaultdict(list)
    snaps = defaultdict(dict)
    for r in rows:
        t = ist_min(r['time'])
        key = (r['strike'], r['type'])
        rec = (t, num(r['ltp']), num(r['bid']), num(r['ask']))
        legs[key].append(rec)
        snaps[t][key] = rec
    times = sorted(snaps)
    last_entry_t = -10
    for t in times:
        if t < 9 * 60 + 30 or t > LAST_ENTRY or t - last_entry_t < 5:
            continue
        last_entry_t = t
        for key, rec in snaps[t].items():
            _, ltp, bid, ask = rec
            entry = ask if ask > 0 else ltp
            if not (BAND[0] <= entry <= BAND[1]):
                continue
            later = [(x[0], (x[2] if x[2] > 0 else x[1])) for x in legs[key] if t < x[0] <= CUTOFF]
            if len(later) < 5:
                continue
            bids = [b for _, b in later]
            maxb = max(bids)
            maxm = maxb / entry
            # unit A
            exitA = 2 * entry if maxb >= 2 * entry else bids[-1]
            # unit B (trailing runner per resolver semantics)
            armed, peak, stop, exitB = False, entry, None, None
            for b in bids:
                peak = max(peak, b)
                if not armed and b >= 2 * entry:
                    armed = True
                if armed:
                    stop = max(stop if stop is not None else -1e9, peak - entry)
                    if b <= stop:
                        exitB = stop
                        break
            if exitB is None:
                exitB = bids[-1]
            zh = ((exitA - entry) + (exitB - entry)) / (2 * entry)
            w = f"{(t // 30) * 30 // 60:02d}:{(t // 30) * 30 % 60:02d}"
            a = agg[w]
            a['n'] += 1; a['zh'] += zh; a['maxm'].append(maxm)
            a['hit2'] += maxm >= 2; a['hit5'] += maxm >= 5; a['hit10'] += maxm >= 10
            a['zhwin'] += zh > 0
            pu = per_u[under][w]
            pu['n'] += 1; pu['hit2'] += maxm >= 2; pu['zh'] += zh

print(f"{'window':>6} {'n':>5} {'2x%':>6} {'5x%':>6} {'10x%':>6} {'medMax':>7} {'ZH EV':>7} {'ZHwin%':>7}")
for w in sorted(agg):
    a = agg[w]
    mm = sorted(a['maxm'])[len(a['maxm']) // 2]
    print(f"{w:>6} {a['n']:>5} {100*a['hit2']/a['n']:>5.1f}% {100*a['hit5']/a['n']:>5.1f}% "
          f"{100*a['hit10']/a['n']:>5.1f}% {mm:>6.2f}x {a['zh']/a['n']:>+6.2f}x {100*a['zhwin']/a['n']:>6.1f}%")

print("\nper-underlying 2x-rate by window (n>=20):")
for u in sorted(per_u):
    parts = []
    for w in sorted(per_u[u]):
        p = per_u[u][w]
        if p['n'] >= 20:
            parts.append(f"{w}:{100*p['hit2']/p['n']:.0f}%({p['n']})")
    print(f"  {u}: " + "  ".join(parts))
