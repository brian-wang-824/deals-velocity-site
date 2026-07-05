"""End-to-end test of scripts/run_scrape.run(): mocks the one network call
(fetch_frontpage_deals) and exercises everything else for real -- loading
history, trimming the rolling window, computing velocity, and writing both
JSON files atomically to a temp directory.
"""

import asyncio
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import run_scrape
from scraper.scraper import Deal


def _fake_deal(thread_id, votes):
    return Deal(
        thread_id=thread_id,
        title=f"Deal {thread_id}",
        url=f"https://slickdeals.net/f/{thread_id}",
        store="Amazon",
        price="$10.00",
        original_price="$20.00",
        votes=votes,
        comments=0,
        views=0,
        posted_label="June 22, 2026 12:00 PM",
        posted_time=datetime(2026, 6, 22, 12, 0, 0),
        posted_time_source="card",
        found_by=None,
        is_new=False,
        image_url="https://slickdeals.net/img/x.jpg",
        scraped_at=datetime(2026, 6, 22, 14, 0, 0, tzinfo=timezone.utc),
    )


class TestRunScrapeEndToEnd(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        import tempfile

        self._tmpdir = tempfile.TemporaryDirectory()
        tmp_path = Path(self._tmpdir.name)

        self._patches = [
            patch.object(run_scrape, "DATA_DIR", tmp_path),
            patch.object(run_scrape, "HISTORY_FILE", tmp_path / "history.json"),
            patch.object(run_scrape, "DEALS_FILE", tmp_path / "deals.json"),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmpdir.cleanup()

    async def test_writes_history_and_deals_files_on_first_run(self):
        with patch.object(run_scrape, "fetch_frontpage_deals", return_value=[_fake_deal("1", 10)]):
            await run_scrape.run()

        self.assertTrue(run_scrape.HISTORY_FILE.exists())
        self.assertTrue(run_scrape.DEALS_FILE.exists())

        history = json.loads(run_scrape.HISTORY_FILE.read_text())
        deals_out = json.loads(run_scrape.DEALS_FILE.read_text())

        self.assertEqual(len(history), 1)
        self.assertEqual(deals_out["count"], 1)
        self.assertEqual(deals_out["deals"][0]["thread_id"], "1")
        # First-ever scrape: no velocity data yet.
        self.assertEqual(deals_out["deals"][0]["velocity_label"], "needs second scrape")

    async def test_no_leftover_tmp_files_after_write(self):
        with patch.object(run_scrape, "fetch_frontpage_deals", return_value=[_fake_deal("1", 10)]):
            await run_scrape.run()

        leftover_tmp_files = list(Path(run_scrape.DATA_DIR).glob("*.tmp"))
        self.assertEqual(leftover_tmp_files, [])

    async def test_rolling_window_is_trimmed_to_max_snapshots(self):
        # Pre-seed history right at the limit.
        old_history = [
            {"scraped_at": f"2026-06-22T{h:02d}:00:00Z", "deals": [_asdict_deal(_fake_deal("1", 10 + h))]}
            for h in range(run_scrape.MAX_SNAPSHOTS)
        ]
        run_scrape.DATA_DIR.mkdir(parents=True, exist_ok=True)
        run_scrape.HISTORY_FILE.write_text(json.dumps(old_history))

        with patch.object(run_scrape, "fetch_frontpage_deals", return_value=[_fake_deal("1", 999)]):
            await run_scrape.run()

        history = json.loads(run_scrape.HISTORY_FILE.read_text())
        self.assertEqual(len(history), run_scrape.MAX_SNAPSHOTS)  # oldest entry dropped
        self.assertEqual(history[-1]["deals"][0]["votes"], 999)

    async def test_empty_scrape_result_does_not_clobber_existing_data(self):
        run_scrape.DATA_DIR.mkdir(parents=True, exist_ok=True)
        existing_history = [{"scraped_at": "2026-06-22T12:00:00Z", "deals": [_asdict_deal(_fake_deal("1", 10))]}]
        run_scrape.HISTORY_FILE.write_text(json.dumps(existing_history))

        with patch.object(run_scrape, "fetch_frontpage_deals", return_value=[]):
            await run_scrape.run()

        # A failed/empty scrape (e.g. Slickdeals briefly changed markup)
        # should not wipe out perfectly good existing data.
        history = json.loads(run_scrape.HISTORY_FILE.read_text())
        self.assertEqual(len(history), 1)


def _asdict_deal(deal):
    return run_scrape.deal_to_json_dict(deal)


if __name__ == "__main__":
    unittest.main()
