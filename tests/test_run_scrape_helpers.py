"""Unit tests for scripts/run_scrape.py helpers (no network, no real scrape)."""

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(SCRIPTS_DIR))

from run_scrape import MAX_SNAPSHOTS


class TestMaxSnapshotsBound(unittest.TestCase):
    def test_max_snapshots_is_a_sane_bound(self):
        # Sanity guard so nobody accidentally sets this to something that
        # lets history.json grow unbounded.
        self.assertTrue(1 <= MAX_SNAPSHOTS <= 500)


if __name__ == "__main__":
    unittest.main()
