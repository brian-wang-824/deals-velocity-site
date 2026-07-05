"""Unit tests for scripts/run_scrape.py helpers (no network, no real scrape)."""

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(SCRIPTS_DIR))

from run_scrape import build_known_dates, MAX_SNAPSHOTS


class TestBuildKnownDates(unittest.TestCase):
    def test_only_uses_confident_sources(self):
        history = [
            {
                "scraped_at": "2026-06-22T12:00:00Z",
                "deals": [
                    {"thread_id": "1", "posted_time": "2026-06-20T09:00:00Z", "posted_time_source": "post"},
                    {"thread_id": "2", "posted_time": "2026-06-22T11:30:00Z", "posted_time_source": "card"},
                    {"thread_id": "3", "posted_time": None, "posted_time_source": None},
                ],
            }
        ]
        known = build_known_dates(history)
        self.assertEqual(set(known.keys()), {"1"})  # "card" source deals don't need to be cached
        self.assertEqual(known["1"][1], "post")

    def test_keeps_earliest_resolution_per_thread(self):
        history = [
            {
                "scraped_at": "2026-06-22T12:00:00Z",
                "deals": [{"thread_id": "1", "posted_time": "2026-06-20T09:00:00Z", "posted_time_source": "post"}],
            },
            {
                "scraped_at": "2026-06-22T13:00:00Z",
                "deals": [{"thread_id": "1", "posted_time": "2026-06-20T09:00:00Z", "posted_time_source": "post"}],
            },
        ]
        known = build_known_dates(history)
        self.assertEqual(len(known), 1)
        self.assertEqual(known["1"][0].isoformat(), "2026-06-20T09:00:00")

    def test_empty_history(self):
        self.assertEqual(build_known_dates([]), {})


class TestMaxSnapshotsBound(unittest.TestCase):
    def test_max_snapshots_is_a_sane_bound(self):
        # Sanity guard so nobody accidentally sets this to something that
        # lets history.json grow unbounded.
        self.assertTrue(1 <= MAX_SNAPSHOTS <= 500)


if __name__ == "__main__":
    unittest.main()
