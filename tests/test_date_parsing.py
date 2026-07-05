"""Unit tests for scraper.scraper._parse_time_to_datetime and friends."""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scraper.scraper import _parse_time_to_datetime, _parse_int, _parse_price_to_float


class TestParseTimeToDatetime(unittest.TestCase):
    def setUp(self):
        self.scraped_at = datetime(2026, 6, 22, 12, 0, 0, tzinfo=timezone.utc)

    def test_today_pm(self):
        result = _parse_time_to_datetime("Today 11:17 PM", self.scraped_at)
        self.assertEqual(result, datetime(2026, 6, 22, 23, 17, 0))

    def test_today_am(self):
        result = _parse_time_to_datetime("Today 08:32 AM", self.scraped_at)
        self.assertEqual(result, datetime(2026, 6, 22, 8, 32, 0))

    def test_absolute_date_pm(self):
        result = _parse_time_to_datetime("June 22, 2026 02:00 PM", self.scraped_at)
        self.assertEqual(result, datetime(2026, 6, 22, 14, 0, 0))

    def test_absolute_date_abbreviated_month(self):
        result = _parse_time_to_datetime("May 03, 2026 09:15 AM", self.scraped_at)
        self.assertEqual(result, datetime(2026, 5, 3, 9, 15, 0))

    def test_yesterday(self):
        result = _parse_time_to_datetime("Yesterday 07:27 PM", self.scraped_at)
        self.assertEqual(result, datetime(2026, 6, 21, 19, 27, 0))

    def test_hours_ago(self):
        result = _parse_time_to_datetime("2h ago", self.scraped_at)
        self.assertEqual(result, datetime(2026, 6, 22, 10, 0, 0))

    def test_minutes_ago(self):
        result = _parse_time_to_datetime("45m ago", self.scraped_at)
        self.assertEqual(result, datetime(2026, 6, 22, 11, 15, 0))

    def test_unparseable_returns_none(self):
        self.assertIsNone(_parse_time_to_datetime("", self.scraped_at))
        self.assertIsNone(_parse_time_to_datetime("gibberish", self.scraped_at))

    def test_utc_storage_format(self):
        result = _parse_time_to_datetime("Today 11:17 PM", self.scraped_at)
        self.assertIsNone(result.tzinfo)
        self.assertEqual(result.isoformat() + "Z", "2026-06-22T23:17:00Z")


class TestParseHelpers(unittest.TestCase):
    def test_parse_int_strips_non_digits(self):
        self.assertEqual(_parse_int("1,234 votes"), 1234)
        self.assertEqual(_parse_int(None), 0)
        self.assertEqual(_parse_int(""), 0)
        self.assertEqual(_parse_int("no digits here"), 0)

    def test_parse_price_to_float(self):
        self.assertEqual(_parse_price_to_float("$149.99"), 149.99)
        self.assertEqual(_parse_price_to_float("$1,299"), 1299.0)
        self.assertIsNone(_parse_price_to_float(None))
        self.assertIsNone(_parse_price_to_float("Free"))


if __name__ == "__main__":
    unittest.main()
