"""Tests for the core performance fix: only deals with no resolvable date
(neither from their own card nor from a previous run's cache) should ever
need a per-page network fetch.

The pure logic lives in scraper.scraper._apply_known_dates and is tested
directly here with zero network dependency. A full end-to-end test against
fetch_frontpage_deals (using httpx.MockTransport) is included below and
runs automatically in any environment that has httpx installed (e.g. CI,
where requirements-scraper.txt is installed); it's skipped gracefully if
httpx isn't available.
"""

import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scraper.scraper import Deal, _apply_known_dates

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False

if HTTPX_AVAILABLE:
    from scraper.scraper import fetch_frontpage_deals


def _make_deal(thread_id, posted_time=None, posted_time_source=None):
    return Deal(
        thread_id=thread_id,
        title=f"Deal {thread_id}",
        url=f"https://slickdeals.net/f/{thread_id}",
        store="Amazon",
        price="$10.00",
        original_price=None,
        votes=1,
        comments=0,
        views=0,
        posted_label=None,
        posted_time=posted_time,
        posted_time_source=posted_time_source,
        found_by=None,
        is_new=False,
        image_url=None,
        scraped_at=datetime(2026, 6, 22, 12, 0, 0),
    )


class TestApplyKnownDates(unittest.TestCase):
    def test_deal_already_resolved_by_card_is_never_flagged_for_fetch(self):
        deal = _make_deal("1", posted_time=datetime(2026, 6, 22, 10, 0, 0), posted_time_source="card")
        needs_fetch = _apply_known_dates([deal], known_dates={})
        self.assertEqual(needs_fetch, [])

    def test_deal_with_known_date_is_filled_in_and_skipped(self):
        deal = _make_deal("2")  # no card date
        known_dates = {"2": (datetime(2026, 6, 20, 9, 0, 0), "post")}
        needs_fetch = _apply_known_dates([deal], known_dates)

        self.assertEqual(needs_fetch, [])  # nothing left to fetch
        self.assertEqual(deal.posted_time, datetime(2026, 6, 20, 9, 0, 0))
        self.assertEqual(deal.posted_time_source, "post")
        self.assertIsNotNone(deal.posted_label)

    def test_deal_with_no_card_date_and_no_known_date_needs_fetch(self):
        deal = _make_deal("3")
        needs_fetch = _apply_known_dates([deal], known_dates={})
        self.assertEqual(needs_fetch, [deal])

    def test_mixed_batch_only_flags_the_genuinely_unresolved_ones(self):
        resolved_by_card = _make_deal("1", posted_time=datetime(2026, 6, 22, 10, 0, 0), posted_time_source="card")
        resolved_by_cache = _make_deal("2")
        unresolved = _make_deal("3")
        known_dates = {"2": (datetime(2026, 6, 20, 9, 0, 0), "post")}

        needs_fetch = _apply_known_dates([resolved_by_card, resolved_by_cache, unresolved], known_dates)

        self.assertEqual(needs_fetch, [unresolved])
        self.assertEqual(resolved_by_cache.posted_time_source, "post")

    def test_unknown_thread_id_in_cache_is_ignored(self):
        deal = _make_deal("999")
        known_dates = {"other-thread": (datetime(2026, 6, 20, 9, 0, 0), "post")}
        needs_fetch = _apply_known_dates([deal], known_dates)
        self.assertEqual(needs_fetch, [deal])


FRONTPAGE_HTML = """
<html><body>
  <div class="dealCard" data-threadid="2001" viewscount="10">
    <a class="dealCard__title" href="/f/2001-known-deal">Deal With Known Date</a>
    <span class="dealCard__storeLink">Walmart</span>
    <span class="dealCard__price">$10.00</span>
    <span class="dealCardSocialControls__voteCount">5</span>
    <span class="dealCardSocialControls__commentsCount">1</span>
    <span class="dealCard__timestamp">recently posted</span>
    <img class="dealCard__image" src="https://slickdeals.net/img/2001.jpg" />
  </div>
  <div class="dealCard" data-threadid="2002" viewscount="20">
    <a class="dealCard__title" href="/f/2002-unknown-deal">Deal Needing A Fetch</a>
    <span class="dealCard__storeLink">Costco</span>
    <span class="dealCard__price">$20.00</span>
    <span class="dealCardSocialControls__voteCount">7</span>
    <span class="dealCardSocialControls__commentsCount">2</span>
    <span class="dealCard__timestamp">recently posted</span>
    <img class="dealCard__image" src="https://slickdeals.net/img/2002.jpg" />
  </div>
</body></html>
"""

DEAL_PAGE_HTML = """
<html><body>
  <div class="dealDetailsMainBlock__postedInfo">
    <span class="slickdealsTimestamp" title="June 20, 2026 09:00 AM">2 days ago</span>
  </div>
</body></html>
"""


@unittest.skipUnless(HTTPX_AVAILABLE, "httpx not installed in this environment")
class TestFetchFrontpageDealsIntegration(unittest.IsolatedAsyncioTestCase):
    def _make_client(self, call_log):
        def handler(request):
            call_log.append(request.url.path)
            if request.url.path == "/":
                return httpx.Response(200, text=FRONTPAGE_HTML)
            if request.url.path == "/f/2002-unknown-deal":
                return httpx.Response(200, text=DEAL_PAGE_HTML)
            raise AssertionError(f"Unexpected fetch to {request.url}")

        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    async def test_known_date_deal_skips_page_fetch(self):
        call_log = []
        known_dates = {"2001": (datetime(2026, 6, 19, 12, 0, 0), "post")}

        async with self._make_client(call_log) as client:
            deals = await fetch_frontpage_deals(client=client, known_dates=known_dates)

        deal_2001 = next(d for d in deals if d.thread_id == "2001")
        self.assertEqual(deal_2001.posted_time, datetime(2026, 6, 19, 12, 0, 0))
        self.assertNotIn("/f/2001-known-deal", call_log)

    async def test_unresolved_deal_falls_back_to_page_fetch(self):
        call_log = []
        async with self._make_client(call_log) as client:
            deals = await fetch_frontpage_deals(client=client, known_dates={})

        deal_2002 = next(d for d in deals if d.thread_id == "2002")
        self.assertEqual(deal_2002.posted_time, datetime(2026, 6, 20, 9, 0, 0))
        self.assertIn("/f/2002-unknown-deal", call_log)


if __name__ == "__main__":
    unittest.main()
