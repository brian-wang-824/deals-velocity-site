"""Unit tests for velocity enrichment from compact vote observations."""

import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scraper.velocity import enrich_deals_with_velocity, compute_velocity, _velocity_label


def _deal(thread_id, votes, **overrides):
    value = {
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
    value.update(overrides)
    return value


def _snapshot(scraped_at, **votes):
    return {"scraped_at": scraped_at, "votes": votes}


class TestEnrichDealsWithVelocity(unittest.TestCase):
    def test_empty_current_deals_returns_empty_list(self):
        self.assertEqual(enrich_deals_with_velocity([], "2026-06-22T12:00:00Z", []), [])

    def test_first_ever_snapshot_has_no_velocity_yet(self):
        scraped_at = "2026-06-22T12:00:00Z"
        enriched = enrich_deals_with_velocity(
            [_deal("1", 10)], scraped_at, [_snapshot(scraped_at, **{"1": 10})]
        )
        self.assertEqual(len(enriched), 1)
        self.assertIsNone(enriched[0]["recent_velocity"])
        self.assertIsNone(enriched[0]["lifetime_velocity"])
        self.assertIsNone(enriched[0]["vote_delta"])
        self.assertIsNone(enriched[0]["velocity_label"])

    def test_velocity_computed_between_two_snapshots(self):
        scraped_at = "2026-06-22T13:00:00Z"
        snapshots = [
            _snapshot("2026-06-22T12:00:00Z", **{"1": 10}),
            _snapshot(scraped_at, **{"1": 22}),
        ]
        deal = enrich_deals_with_velocity([_deal("1", 22)], scraped_at, snapshots)[0]
        self.assertEqual(deal["vote_delta"], 12)
        self.assertEqual(deal["recent_velocity"], 12.0)
        self.assertEqual(deal["lifetime_velocity"], 12.0)
        self.assertEqual(deal["velocity_label"], "hot")

    def test_new_deal_mid_window_has_no_false_zero_velocity(self):
        scraped_at = "2026-06-22T13:00:00Z"
        snapshots = [
            _snapshot("2026-06-22T12:00:00Z", **{"1": 10}),
            _snapshot(scraped_at, **{"1": 16, "2": 5}),
        ]
        enriched = enrich_deals_with_velocity(
            [_deal("1", 16), _deal("2", 5)], scraped_at, snapshots
        )
        deal_2 = next(deal for deal in enriched if deal["thread_id"] == "2")
        self.assertIsNone(deal_2["recent_velocity"])
        self.assertIsNone(deal_2["lifetime_velocity"])
        self.assertIsNone(deal_2["velocity_label"])

    def test_reappearing_deal_uses_last_actual_observation(self):
        scraped_at = "2026-06-22T12:30:00Z"
        snapshots = [
            _snapshot("2026-06-22T12:00:00Z", **{"1": 10}),
            _snapshot("2026-06-22T12:10:00Z", **{"2": 4}),
            _snapshot(scraped_at, **{"1": 16}),
        ]
        deal = enrich_deals_with_velocity([_deal("1", 16)], scraped_at, snapshots)[0]
        self.assertEqual(deal["vote_delta"], 6)
        self.assertEqual(deal["recent_velocity"], 12.0)
        self.assertEqual(deal["lifetime_velocity"], 12.0)

    def test_recent_and_lifetime_use_different_observation_points(self):
        scraped_at = "2026-06-22T14:00:00Z"
        snapshots = [
            _snapshot("2026-06-22T12:00:00Z", **{"1": 10}),
            _snapshot("2026-06-22T13:30:00Z", **{"1": 20}),
            _snapshot(scraped_at, **{"1": 30}),
        ]
        deal = enrich_deals_with_velocity([_deal("1", 30)], scraped_at, snapshots)[0]
        self.assertEqual(deal["recent_velocity"], 20.0)
        self.assertEqual(deal["lifetime_velocity"], 10.0)
        self.assertEqual(deal["velocity_label"], "surging")

    def test_discount_percentage_calculated(self):
        scraped_at = "2026-06-22T12:00:00Z"
        deal = enrich_deals_with_velocity(
            [_deal("1", 10, price="$25.00", original_price="$50.00")],
            scraped_at,
            [_snapshot(scraped_at, **{"1": 10})],
        )[0]
        self.assertEqual(deal["discount_percentage"], 50.0)

    def test_multi_buy_discount_uses_offer_amount(self):
        scraped_at = "2026-06-22T12:00:00Z"
        deal = enrich_deals_with_velocity(
            [_deal("1", 10, price="2 for $0.40", original_price="$13")],
            scraped_at,
            [_snapshot(scraped_at, **{"1": 10})],
        )[0]
        self.assertEqual(deal["discount_percentage"], 96.9)

    def test_sorted_by_recent_velocity_descending(self):
        scraped_at = "2026-06-22T13:00:00Z"
        snapshots = [
            _snapshot("2026-06-22T12:00:00Z", **{"1": 10, "2": 10}),
            _snapshot(scraped_at, **{"1": 12, "2": 40}),
        ]
        enriched = enrich_deals_with_velocity(
            [_deal("1", 12), _deal("2", 40)], scraped_at, snapshots
        )
        self.assertEqual([deal["thread_id"] for deal in enriched], ["2", "1"])


class TestComputeVelocityAndLabels(unittest.TestCase):
    def test_compute_velocity_handles_missing_previous(self):
        self.assertIsNone(compute_velocity(10, datetime(2026, 1, 1, 12), None, None))

    def test_velocity_label_thresholds(self):
        self.assertEqual(_velocity_label(36, None), "inferno")
        self.assertEqual(_velocity_label(30, None), "on fire")
        self.assertEqual(_velocity_label(24, None), "blazing")
        self.assertEqual(_velocity_label(18, None), "surging")
        self.assertEqual(_velocity_label(12, None), "hot")
        self.assertEqual(_velocity_label(6, None), "warming")
        self.assertIsNone(_velocity_label(0.5, None))
        self.assertIsNone(_velocity_label(0, None))
        self.assertIsNone(_velocity_label(-1, None))
        self.assertIsNone(_velocity_label(None, None))

    def test_irregular_scrape_interval_uses_hourly_velocity(self):
        scraped_at = "2026-06-22T12:15:00Z"
        snapshots = [
            _snapshot("2026-06-22T12:00:00Z", **{"1": 10}),
            _snapshot(scraped_at, **{"1": 13}),
        ]
        deal = enrich_deals_with_velocity([_deal("1", 13)], scraped_at, snapshots)[0]
        self.assertEqual(deal["vote_delta"], 3)
        self.assertEqual(deal["recent_velocity"], 12.0)
        self.assertEqual(deal["velocity_label"], "hot")


if __name__ == "__main__":
    unittest.main()
