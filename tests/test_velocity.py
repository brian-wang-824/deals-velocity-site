"""Unit tests for scraper.velocity.enrich_deals_with_velocity."""

import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scraper.velocity import enrich_deals_with_velocity, compute_velocity, _velocity_label


def _deal(thread_id, votes, **overrides):
    base = {
        "thread_id": thread_id,
        "title": f"Deal {thread_id}",
        "url": f"https://slickdeals.net/f/{thread_id}",
        "store": "Amazon",
        "price": "$10.00",
        "original_price": "$20.00",
        "votes": votes,
        "comments": 1,
        "views": 100,
        "posted_label": None,
        "posted_time": None,
        "posted_time_source": None,
        "found_by": None,
        "is_new": False,
        "image_url": None,
    }
    base.update(overrides)
    return base


class TestEnrichDealsWithVelocity(unittest.TestCase):
    def test_empty_history_returns_empty_list(self):
        self.assertEqual(enrich_deals_with_velocity([]), [])

    def test_first_ever_snapshot_has_no_velocity_yet(self):
        history = [{"scraped_at": "2026-06-22T12:00:00Z", "deals": [_deal("1", 10)]}]
        enriched = enrich_deals_with_velocity(history)
        self.assertEqual(len(enriched), 1)
        self.assertIsNone(enriched[0]["recent_velocity"])
        self.assertIsNone(enriched[0]["lifetime_velocity"])
        self.assertEqual(enriched[0]["velocity_label"], "needs second scrape")

    def test_velocity_computed_between_two_snapshots(self):
        history = [
            {"scraped_at": "2026-06-22T12:00:00Z", "deals": [_deal("1", 10)]},
            {"scraped_at": "2026-06-22T13:00:00Z", "deals": [_deal("1", 22)]},  # +12 votes in 1hr
        ]
        enriched = enrich_deals_with_velocity(history)
        deal = enriched[0]
        self.assertEqual(deal["vote_delta"], 12)
        self.assertEqual(deal["recent_velocity"], 12.0)
        self.assertEqual(deal["lifetime_velocity"], 12.0)
        self.assertEqual(deal["velocity_label"], "surging")  # >= 12

    def test_new_deal_appearing_mid_history_only_compares_to_its_own_first_sighting(self):
        history = [
            {"scraped_at": "2026-06-22T12:00:00Z", "deals": [_deal("1", 10)]},
            {"scraped_at": "2026-06-22T13:00:00Z", "deals": [_deal("1", 16), _deal("2", 5)]},
        ]
        enriched = enrich_deals_with_velocity(history)
        deal_2 = next(d for d in enriched if d["thread_id"] == "2")
        self.assertIsNone(deal_2["recent_velocity"])
        self.assertEqual(deal_2["velocity_label"], "needs second scrape")

    def test_discount_percentage_calculated(self):
        history = [
            {
                "scraped_at": "2026-06-22T12:00:00Z",
                "deals": [_deal("1", 10, price="$25.00", original_price="$50.00")],
            }
        ]
        enriched = enrich_deals_with_velocity(history)
        self.assertEqual(enriched[0]["discount_percentage"], 50.0)

    def test_sorted_by_recent_velocity_descending(self):
        history = [
            {"scraped_at": "2026-06-22T12:00:00Z", "deals": [_deal("1", 10), _deal("2", 10)]},
            {"scraped_at": "2026-06-22T13:00:00Z", "deals": [_deal("1", 12), _deal("2", 40)]},
        ]
        enriched = enrich_deals_with_velocity(history)
        self.assertEqual([d["thread_id"] for d in enriched], ["2", "1"])


class TestComputeVelocityAndLabels(unittest.TestCase):
    def test_compute_velocity_handles_missing_previous(self):
        self.assertIsNone(compute_velocity(10, datetime(2026, 1, 1, 12), None, None))

    def test_velocity_label_thresholds(self):
        self.assertEqual(_velocity_label(15, None), "surging")
        self.assertEqual(_velocity_label(7, None), "hot")
        self.assertEqual(_velocity_label(2, None), "warming")
        self.assertEqual(_velocity_label(0.5, None), "slow")
        self.assertEqual(_velocity_label(0, None), "flat")
        self.assertEqual(_velocity_label(-1, None), "cooling")
        self.assertEqual(_velocity_label(None, None), "needs second scrape")


if __name__ == "__main__":
    unittest.main()
