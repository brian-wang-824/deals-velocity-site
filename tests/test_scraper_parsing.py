"""Unit tests for scraper.scraper.parse_deals against fixture HTML."""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scraper.scraper import parse_deals

FIXTURE = (Path(__file__).parent / "fixtures" / "frontpage_sample.html").read_text()
SCRAPED_AT = datetime(2026, 6, 22, 16, 0, 0, tzinfo=timezone.utc)


class TestParseDeals(unittest.TestCase):
    def setUp(self):
        self.deals = parse_deals(FIXTURE, scraped_at=SCRAPED_AT)

    def test_parses_expected_number_of_cards(self):
        # 3 valid cards; the 4th card has no data-threadid and must be skipped.
        self.assertEqual(len(self.deals), 3)

    def test_cards_without_threadid_are_skipped(self):
        self.assertTrue(all(d.thread_id for d in self.deals))
        self.assertNotIn("No Thread ID", [d.title for d in self.deals])

    def test_fully_populated_card_fields(self):
        deal = next(d for d in self.deals if d.thread_id == "1001")
        self.assertEqual(deal.title, "Amazing Widget 50% Off")
        self.assertEqual(deal.url, "https://slickdeals.net/f/1001-widget-deal")
        self.assertEqual(deal.store, "Amazon")
        self.assertEqual(deal.price, "$24.99")
        self.assertEqual(deal.original_price, "$49.99")
        self.assertEqual(deal.votes, 128)
        self.assertEqual(deal.comments, 12)
        self.assertEqual(deal.views, 4532)  # comma stripped
        self.assertEqual(deal.found_by, "dealhunter22")
        self.assertFalse(deal.is_new)
        self.assertEqual(deal.image_url, "https://slickdeals.net/img/1001.jpg")

    def test_card_with_title_attribute_resolves_precise_date(self):
        """When the timestamp element carries a `title` attribute with an
        absolute date, no fallback page fetch should ever be needed."""
        deal = next(d for d in self.deals if d.thread_id == "1001")
        self.assertEqual(deal.posted_time, datetime(2026, 6, 22, 14, 0, 0))
        self.assertEqual(deal.posted_time_source, "card")

    def test_card_with_only_relative_text_still_parses(self):
        deal = next(d for d in self.deals if d.thread_id == "1002")
        # "30m ago" relative to 16:00 UTC -> 15:30 UTC
        self.assertEqual(deal.posted_time, datetime(2026, 6, 22, 15, 30, 0))
        self.assertEqual(deal.posted_time_source, "card")
        self.assertTrue(deal.is_new)

    def test_card_with_unparseable_timestamp_leaves_posted_time_none(self):
        """These are exactly the deals that should fall through to the
        per-page fetch fallback in fetch_frontpage_deals."""
        deal = next(d for d in self.deals if d.thread_id == "1003")
        self.assertIsNone(deal.posted_time)
        self.assertIsNone(deal.posted_time_source)


if __name__ == "__main__":
    unittest.main()
