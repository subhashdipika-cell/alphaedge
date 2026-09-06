import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path
from market_archive import append_verified, INDEX_INSTRUMENTS
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'mt5-bridge'))
from audit_results import stored_audit

class ArchiveTests(unittest.TestCase):
    def test_identity_separation_session_date_and_dedupe(self):
        row = dict(time='2026-08-01 20:00:00', open=100, high=101, low=99, close=100, volume=0)
        with tempfile.TemporaryDirectory() as root:
            meta = INDEX_INSTRUMENTS['NIFTY50']
            self.assertEqual(append_verified(root, 'NIFTY50', 'M5', [row], meta), 1)
            self.assertEqual(append_verified(root, 'NIFTY50', 'M5', [row], meta), 0)
            future = dict(security_id='999', segment='NSE_FNO', instrument='FUTIDX', expiry='2026-08-25', lot=65)
            append_verified(root, 'NIFTY50', 'M5', [row], future)
            files = list(Path(root).rglob('*.csv'))
            self.assertEqual(len(files), 2)
            self.assertTrue(all(p.name.endswith('2026-08-02.csv') for p in files))
            for file in files:
                with file.open() as f:
                    data = next(csv.DictReader(f))
                self.assertEqual(data['source'], 'DHAN')
                self.assertEqual(data['timestamp_basis'], 'UTC_BAR_OPEN')
                self.assertTrue(data['collected_at'])
            self.assertFalse(list(Path(root).glob('*.csv')))

    def test_reject_path_injection_and_missing_identity(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                append_verified(root, '../bad', 'M5', [], INDEX_INSTRUMENTS['NIFTY50'])
            with self.assertRaises(ValueError):
                append_verified(root, 'NIFTY50', 'M5', [], dict(instrument='INDEX'))

    def test_unfinished_candle_not_archived(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(append_verified(root, 'NIFTY50', 'M5', [dict(time='2099-01-01 04:00:00')], INDEX_INSTRUMENTS['NIFTY50']), 0)

    def test_report_missing_corrupt_and_latest_valid(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertFalse(stored_audit(root)['ok'])
            p = Path(root)
            (p / 'stored-audit-corrupt.json').write_text('{')
            (p / 'stored-audit-null.json').write_text('null')
            for date in ('2026-08-01', '2026-09-01'):
                (p / f'stored-audit-{date}.json').write_text(json.dumps(dict(generatedAt=date,
                    assumptions=dict(mode='OFFLINE_RESEARCH_ONLY'), strategies={'current/NIFTY50': dict(summary=dict(completedLegs=0), trades=['private details'])})))
            result = stored_audit(root)
            self.assertTrue(result['ok'])
            self.assertEqual(result['generatedAt'], '2026-09-01')
            self.assertNotIn('trades', result['strategies']['current/NIFTY50'])

if __name__ == '__main__':
    unittest.main()
