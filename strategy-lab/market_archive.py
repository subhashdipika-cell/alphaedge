"""Provenance-bearing candle archive. Legacy files are never relabelled."""
import csv
from datetime import datetime, timezone, timedelta
import re
from pathlib import Path

INDEX_INSTRUMENTS = {name: dict(security_id=sid, segment='IDX_I', instrument='INDEX')
                     for name, sid in [('NIFTY50', '13'), ('BANKNIFTY', '25'), ('SENSEX', '51'), ('FINNIFTY', '27')]}
FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume', 'source', 'instrument_kind',
          'security_id', 'exchange_segment', 'expiry', 'lot_size', 'collected_at', 'timestamp_basis']

def append_verified(root, symbol, tf, rows, meta):
    kind = meta['instrument']
    if kind not in ('INDEX', 'FUTIDX'):
        raise ValueError('Unsupported candle instrument')
    if not meta.get('security_id') or not meta.get('segment'):
        raise ValueError('Missing instrument identity')
    if not re.fullmatch(r'[A-Z0-9]+', symbol) or not re.fullmatch(r'\d+', str(meta['security_id'])) or tf not in ('M1', 'M5', 'M15', 'M25', 'H1', 'D1'):
        raise ValueError('Invalid archive key')
    if kind == 'INDEX' and (symbol not in INDEX_INSTRUMENTS or str(meta['security_id']) != INDEX_INSTRUMENTS[symbol]['security_id'] or meta['segment'] != 'IDX_I'):
        raise ValueError('Index identity does not match the requested symbol')
    if kind == 'FUTIDX' and (not meta.get('expiry') or not meta.get('lot')):
        raise ValueError('Futures require expiry and lot metadata')
    folder = Path(root) / 'verified' / kind / symbol / str(meta['security_id'])
    folder.mkdir(parents=True, exist_ok=True)
    groups = {}
    for row in rows:
        # Session date IST, not the date on which a history request happened.
        ts = datetime.strptime(row['time'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
        duration = {'M1': 1, 'M5': 5, 'M15': 15, 'M25': 25, 'H1': 60, 'D1': 1440}[tf]
        if ts + timedelta(minutes=duration) > datetime.now(timezone.utc):
            continue  # unfinished candles must not become immutable history
        session = (ts + timedelta(minutes=330)).strftime('%Y-%m-%d')
        groups.setdefault(session, []).append(row)
    count = 0
    for session, candles in groups.items():
        dest = folder / f'{symbol}_{tf}_{session}.csv'
        seen = set()
        if dest.exists():
            with dest.open(newline='', encoding='utf-8') as f:
                seen = {r['time'] for r in csv.DictReader(f)}
        header = not dest.exists()
        with dest.open('a', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=FIELDS)
            if header:
                writer.writeheader()
            for row in candles:
                if row['time'] in seen:
                    continue
                writer.writerow({**{k: row.get(k, '') for k in FIELDS[:6]}, 'source': 'DHAN',
                    'instrument_kind': kind, 'security_id': meta['security_id'], 'exchange_segment': meta['segment'],
                    'expiry': meta.get('expiry', ''), 'lot_size': meta.get('lot', ''),
                    'collected_at': datetime.now(timezone.utc).isoformat(), 'timestamp_basis': 'UTC_BAR_OPEN'})
                seen.add(row['time']); count += 1
    return count
