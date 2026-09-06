"""Offline regression checks: no credentials or broker calls required."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "mt5-bridge"))
import oi_metrics
import dhan_pacing


class PipelineIntegrity(unittest.TestCase):
    def test_missing_expiry_never_falls_back_to_front(self):
        rows = [{"expiry": "2026-09-08"}]
        with patch.object(oi_metrics, "_latest_file", return_value=("dummy", "2026-09-01", True)), \
             patch.object(oi_metrics, "_read_rows", return_value=rows):
            result = oi_metrics.build_oitrend("NIFTY50", expiry="2026-09-15")
        self.assertFalse(result["ok"])
        self.assertEqual(result["expiry"], "2026-09-15")

    def test_owner_lock_excludes_second_collector_and_releases(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(dhan_pacing, "ROOT", Path(folder)):
            with dhan_pacing.process_lock("test", timeout=0):
                with self.assertRaises(TimeoutError):
                    with dhan_pacing.process_lock("test", timeout=0):
                        self.fail("duplicate owner admitted")
            with dhan_pacing.process_lock("test", timeout=0):
                pass

    def test_failure_still_reserves_pacing_interval(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(dhan_pacing, "ROOT", Path(folder)), \
             patch.object(dhan_pacing.time, "sleep") as sleep:
            def fail():
                raise ValueError("simulated broker failure")
            with self.assertRaises(ValueError):
                dhan_pacing.paced_call(fail)
            self.assertEqual(dhan_pacing.paced_call(lambda: 7), 7)
            self.assertTrue(sleep.called)


if __name__ == "__main__":
    unittest.main()
