"""Tests for frontpage-only post-time extraction.

The scraper intentionally avoids per-deal page fetches for latency. Every
emitted deal should still have a posted_time, using the frontpage card
timestamp where possible and the scrape instant for ambiguous card labels
such as "recently posted".
"""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import httpx

    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False

if HTTPX_AVAILABLE:
    from scraper.scraper import fetch_frontpage_deals


FRONTPAGE_HTML = """
<html><body>
  <div class="dealCard" data-threadid="2001" viewscount="10">
    <a class="dealCard__title" href="/f/2001-known-deal">Deal With Absolute Card Date</a>
    <span class="dealCard__storeLink">Walmart</span>
    <span class="dealCard__price">$10.00</span>
    <span class="dealCardSocialControls__voteCount">5</span>
    <span class="dealCardSocialControls__commentsCount">1</span>
    <span class="dealCard__timestamp" title="June 20, 2026 09:00 AM">2 days ago</span>
    <img class="dealCard__image" src="https://slickdeals.net/img/2001.jpg" />
  </div>
  <div class="dealCard" data-threadid="2002" viewscount="20">
    <a class="dealCard__title" href="/f/2002-recent-deal">Recently Posted Deal</a>
    <span class="dealCard__storeLink">Costco</span>
    <span class="dealCard__price">$20.00</span>
    <span class="dealCardSocialControls__voteCount">7</span>
    <span class="dealCardSocialControls__commentsCount">2</span>
    <span class="dealCard__timestamp">recently posted</span>
    <img class="dealCard__image" src="https://slickdeals.net/img/2002.jpg" />
  </div>
</body></html>
"""


@unittest.skipUnless(HTTPX_AVAILABLE, "httpx not installed in this environment")
class TestFrontpageOnlyDateFetch(unittest.IsolatedAsyncioTestCase):
    async def test_fetch_frontpage_deals_makes_only_frontpage_request(self):
        call_log = []

        def handler(request):
            call_log.append(request.url.path)
            if request.url.path == "/":
                return httpx.Response(200, text=FRONTPAGE_HTML)
            raise AssertionError(f"Unexpected fetch to {request.url}")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            deals = await fetch_frontpage_deals(client=client)

        self.assertEqual(call_log, ["/"])
        self.assertEqual([deal.thread_id for deal in deals], ["2001", "2002"])
        self.assertTrue(all(deal.posted_time is not None for deal in deals))
        self.assertTrue(all(deal.posted_time_source == "card" for deal in deals))


if __name__ == "__main__":
    unittest.main()
