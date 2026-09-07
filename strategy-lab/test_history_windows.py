import unittest
from dhan_collector import request_windows


class HistoryWindowsTests(unittest.TestCase):
    def test_long_range_is_not_silently_truncated(self):
        windows = list(request_windows('2026-06-01', '2026-09-07'))
        self.assertEqual(len(windows), 4)
        self.assertEqual(windows[0][0], '2026-06-01 09:15:00')
        self.assertEqual(windows[-1][1], '2026-09-07 15:30:00')
        self.assertEqual(windows[0][1], '2026-06-30 15:30:00')
        self.assertEqual(windows[1][0], '2026-07-01 09:15:00')

    def test_single_day_has_full_session(self):
        self.assertEqual(list(request_windows('2026-09-07', '2026-09-07')),
                         [('2026-09-07 09:15:00', '2026-09-07 15:30:00')])

    def test_invalid_range_or_chunk_rejected(self):
        for start, end, chunk in [('2026-09-07', '2026-09-01', 30),
                                  ('2026-09-01', '2026-09-07', 91),
                                  ('2026-09-01', '2026-09-07', 0)]:
            with self.assertRaises(ValueError):
                list(request_windows(start, end, chunk))


if __name__ == '__main__':
    unittest.main()
