"""Scrape frontpage deals from slickdeals.net.

Performance notes (see project audit for full context):
  - Individual deal-page fetches (`_fetch_deal_post_date`) are the single
    most expensive part of a scrape. They are now only used as a fallback
    for deals whose posted time can't be parsed directly off the frontpage
    card, or that we haven't already resolved in a previous run
    (see `known_dates`). This typically reduces per-run page fetches from
    "every deal on the frontpage" to "the handful of genuinely new deals".
  - Image downloading has been removed entirely. The static site hotlinks
    thumbnails directly from Slickdeals' CDN instead of mirroring them,
    which removes ~150-300 extra requests per run and avoids relying on
    any persistent local disk (there isn't one in a CI runner or a free
    web dyno).
  - Regexes are precompiled at module scope instead of being recompiled
    (implicitly, via re's internal cache) on every call.
  - lxml is used instead of the pure-Python html.parser for faster parsing
    of the (fairly large) frontpage HTML document.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup

try:
    import httpx
except ImportError:  # pragma: no cover - only hit in envs without httpx installed
    # Pure parsing/date/caching logic below doesn't need httpx at all, so we
    # don't want an import error here to block unit-testing that logic.
    # Anything that actually performs network I/O raises a clear error below
    # if httpx wasn't importable.
    httpx = None

BASE_URL = "https://slickdeals.net/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
HTTP_TIMEOUT = 30.0
DEAL_PAGE_TIMEOUT = 15.0
OVERALL_SCRAPE_TIMEOUT = 45.0  # watchdog for the whole date-resolution phase

# Precompiled regexes (was re.search(literal, ...) on every call).
_ABS_DATE_RE = re.compile(
    r"([A-Z][a-z]+) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2})\s*(AM|PM)", re.IGNORECASE
)
_YESTERDAY_RE = re.compile(r"Yesterday\s+(\d{1,2}):(\d{2})\s*(AM|PM)", re.IGNORECASE)
_TODAY_RE = re.compile(r"Today\s+(\d{1,2}):(\d{2})\s*(AM|PM)", re.IGNORECASE)
_HOURS_AGO_RE = re.compile(r"(\d+)\s*h\s*ago", re.IGNORECASE)
_MINUTES_AGO_RE = re.compile(r"(\d+)\s*m\s*ago", re.IGNORECASE)

_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


@dataclass
class Deal:
    thread_id: str
    title: str
    url: str
    store: str
    price: Optional[str]
    original_price: Optional[str]
    votes: int
    comments: int
    views: int
    posted_label: Optional[str]
    posted_time: Optional[datetime]
    posted_time_source: Optional[str]  # 'card', 'post', or 'comment'
    found_by: Optional[str]
    is_new: bool
    image_url: Optional[str]
    scraped_at: datetime


def _parse_int(value: Optional[str], default: int = 0) -> int:
    if not value:
        return default
    digits = re.sub(r"[^\d]", "", value)
    return int(digits) if digits else default


def _parse_price_to_float(price_str: Optional[str]) -> Optional[float]:
    """Convert price string like '$149' or '$279' to float."""
    if not price_str:
        return None
    cleaned = re.sub(r"[^\d.]", "", price_str)
    try:
        return float(cleaned) if cleaned else None
    except ValueError:
        return None


def _parse_time_to_datetime(time_str: str, reference_date: datetime) -> Optional[datetime]:
    """Parse any Slickdeals time format to a naive UTC datetime.

    Handles absolute dates ("Jun 18, 2026 03:17 AM"), relative dates
    ("Yesterday 07:27 PM", "Today 04:18 AM"), and relative times
    ("2h ago", "30m ago"). Slickdeals times are already UTC.
    """
    if not time_str:
        return None

    time_str = time_str.strip()

    abs_match = _ABS_DATE_RE.search(time_str)
    if abs_match:
        month_str, day, year, hour, minute, ampm = abs_match.groups()
        month = _MONTHS.get(month_str.lower())
        if month:
            hour = int(hour)
            if ampm.upper() == "PM" and hour != 12:
                hour += 12
            elif ampm.upper() == "AM" and hour == 12:
                hour = 0
            try:
                return datetime(int(year), month, int(day), hour, int(minute), 0)
            except ValueError:
                pass

    yesterday_match = _YESTERDAY_RE.search(time_str)
    if yesterday_match:
        hour, minute, ampm = yesterday_match.groups()
        hour = int(hour)
        if ampm.upper() == "PM" and hour != 12:
            hour += 12
        elif ampm.upper() == "AM" and hour == 12:
            hour = 0
        yesterday = reference_date - timedelta(days=1)
        try:
            return datetime(yesterday.year, yesterday.month, yesterday.day, hour, int(minute), 0)
        except ValueError:
            pass

    today_match = _TODAY_RE.search(time_str)
    if today_match:
        hour, minute, ampm = today_match.groups()
        hour = int(hour)
        if ampm.upper() == "PM" and hour != 12:
            hour += 12
        elif ampm.upper() == "AM" and hour == 12:
            hour = 0
        try:
            return reference_date.replace(tzinfo=None, hour=hour, minute=int(minute), second=0, microsecond=0)
        except ValueError:
            pass

    hours_match = _HOURS_AGO_RE.search(time_str)
    minutes_match = _MINUTES_AGO_RE.search(time_str)
    if hours_match or minutes_match:
        hours = int(hours_match.group(1)) if hours_match else 0
        minutes = int(minutes_match.group(1)) if minutes_match else 0
        return (reference_date - timedelta(hours=hours, minutes=minutes)).replace(tzinfo=None)

    return None


def _parse_posted_time(timestamp_el, scraped_at: datetime) -> Optional[datetime]:
    if not timestamp_el:
        return None
    time_str = timestamp_el.get("title") or timestamp_el.get_text(strip=True)
    if not time_str:
        return None
    return _parse_time_to_datetime(time_str, scraped_at)


def parse_deals(html: str, scraped_at: Optional[datetime] = None) -> list[Deal]:
    """Parse deal cards from Slickdeals frontpage HTML."""
    scraped_at = scraped_at or datetime.now(timezone.utc)
    soup = BeautifulSoup(html, "lxml")
    deals: list[Deal] = []

    for card in soup.select("div.dealCard[data-threadid]"):
        thread_id = card.get("data-threadid")
        if not thread_id:
            continue

        title_el = card.select_one("a.dealCard__title")
        title = title_el.get_text(strip=True) if title_el else "Untitled deal"
        href = title_el.get("href") if title_el else None
        url = urljoin(BASE_URL, href) if href else BASE_URL

        store_el = card.select_one(".dealCard__storeLink")
        store = store_el.get_text(strip=True) if store_el else ""

        price_el = card.select_one(".dealCard__price")
        original_el = card.select_one(".dealCard__originalPrice")
        price = price_el.get_text(strip=True) if price_el else None
        original_price = original_el.get_text(strip=True) if original_el else None

        vote_el = card.select_one(".dealCardSocialControls__voteCount")
        comment_el = card.select_one(".dealCardSocialControls__commentsCount")
        votes = _parse_int(vote_el.get_text(strip=True) if vote_el else None)
        comments = _parse_int(comment_el.get_text(strip=True) if comment_el else None)
        views = _parse_int(card.get("viewscount"))

        timestamp_el = card.select_one(".dealCard__timestamp")
        posted_label = None
        posted_time = None
        posted_time_source = None
        if timestamp_el:
            posted_label = timestamp_el.get("title") or timestamp_el.get_text(strip=True)
            posted_time = _parse_posted_time(timestamp_el, scraped_at)
            if posted_time is not None:
                posted_time_source = "card"

        user_info = card.select_one(".dealCard__userInfo")
        found_by = user_info.get("title") if user_info else None
        if found_by and found_by.lower().startswith("found by "):
            found_by = found_by[9:]

        is_new = card.select_one(".dealCard__badge--new") is not None

        image_el = card.select_one(".dealCard__image")
        image_url = image_el.get("src") if image_el else None

        deals.append(
            Deal(
                thread_id=str(thread_id),
                title=title,
                url=url,
                store=store,
                price=price,
                original_price=original_price,
                votes=votes,
                comments=comments,
                views=views,
                posted_label=posted_label,
                posted_time=posted_time,
                posted_time_source=posted_time_source,
                found_by=found_by,
                is_new=is_new,
                image_url=image_url,
                scraped_at=scraped_at,
            )
        )

    return deals


def _apply_known_dates(deals: list[Deal], known_dates: dict[str, tuple[datetime, str]]) -> list[Deal]:
    """Fill in posted_time/posted_time_source from previously-resolved data
    wherever a deal's own card didn't yield a parseable date.

    Returns the subset of deals that still have no date at all -- these are
    the only ones that need an individual-page network fetch. This is a
    pure function (no I/O), which is deliberate: it's the core of the "don't
    re-fetch what we already know" optimization, and keeping it side-effect
    free means it can be fully unit tested without a network client of any
    kind.
    """
    needs_fetch: list[Deal] = []
    for deal in deals:
        if deal.posted_time is None and deal.thread_id in known_dates:
            resolved_time, source = known_dates[deal.thread_id]
            deal.posted_time = resolved_time
            deal.posted_time_source = source
            deal.posted_label = resolved_time.strftime("%B %d, %Y %I:%M %p")
        if deal.posted_time is None:
            needs_fetch.append(deal)
    return needs_fetch


async def _fetch_deal_post_date(url: str, client: "httpx.AsyncClient") -> tuple[Optional[datetime], Optional[str]]:
    """Fetch the actual post date from a deal page (fallback path only).

    Returns a tuple of (datetime, source) where source is 'post' or 'comment'.
    """
    if httpx is None:
        raise RuntimeError("httpx is required for network operations. Install it via requirements-scraper.txt.")

    max_retries = 2
    for attempt in range(max_retries):
        try:
            if attempt > 0:
                await asyncio.sleep(0.5)

            response = await client.get(url, headers={"User-Agent": USER_AGENT}, timeout=DEAL_PAGE_TIMEOUT)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, "lxml")
            scraped_at = datetime.now(timezone.utc)

            posted_info = soup.select_one(".dealDetailsMainBlock__postedInfo")
            if posted_info:
                timestamp_el = posted_info.select_one(".slickdealsTimestamp")
                if timestamp_el:
                    time_str = timestamp_el.get("title") or timestamp_el.get_text(strip=True)
                    if time_str:
                        absolute_time = _parse_time_to_datetime(time_str, scraped_at)
                        if absolute_time:
                            return absolute_time, "post"

            comment_selectors = [
                ".commentItem .slickdealsTimestamp",
                ".comments .slickdealsTimestamp",
                ".forumPost .slickdealsTimestamp",
                ".post .slickdealsTimestamp",
            ]
            for selector in comment_selectors:
                for ts in soup.select(selector):
                    time_str = ts.get("title") or ts.get_text(strip=True)
                    if time_str:
                        absolute_time = _parse_time_to_datetime(time_str, scraped_at)
                        if absolute_time:
                            return absolute_time, "comment"
        except Exception as e:
            if attempt == max_retries - 1:
                print(f"Failed to fetch post date for {url}: {e}")

    return None, None


async def fetch_frontpage_deals(
    client: Optional[httpx.AsyncClient] = None,
    known_dates: Optional[dict[str, tuple[datetime, str]]] = None,
    limit: Optional[int] = None,
) -> list[Deal]:
    """Fetch and parse current frontpage deals.

    Args:
        client: Optional httpx client to reuse.
        known_dates: Map of thread_id -> (posted_time, posted_time_source)
            already resolved in a previous run. Deals matching an entry here
            skip the network fetch entirely.
        limit: Optional cap on number of deals returned (mainly for tests).
    """
    if httpx is None:
        raise RuntimeError("httpx is required for network operations. Install it via requirements-scraper.txt.")

    known_dates = known_dates or {}
    owns_client = client is None
    if owns_client:
        limits = httpx.Limits(max_keepalive_connections=20, max_connections=30)
        client = httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True, limits=limits)

    try:
        response = await client.get(BASE_URL, headers={"User-Agent": USER_AGENT})
        response.raise_for_status()
        scraped_at = datetime.now(timezone.utc)
        deals = parse_deals(response.text, scraped_at=scraped_at)

        if limit is not None:
            deals = deals[:limit]

        # Reuse dates resolved in a previous run, and find out which deals
        # still need an individual-page fetch (pure logic, fully unit tested
        # in isolation -- see tests/test_known_dates_reuse.py).
        needs_fetch = _apply_known_dates(deals, known_dates)

        if needs_fetch:
            date_semaphore = asyncio.Semaphore(10)

            async def fetch_with_semaphore(deal: Deal):
                async with date_semaphore:
                    return await _fetch_deal_post_date(deal.url, client)

            resolved_dates = await asyncio.wait_for(
                asyncio.gather(*[fetch_with_semaphore(d) for d in needs_fetch]),
                timeout=OVERALL_SCRAPE_TIMEOUT,
            )
            for deal, (post_date, source) in zip(needs_fetch, resolved_dates):
                if post_date:
                    deal.posted_time = post_date
                    deal.posted_label = post_date.strftime("%B %d, %Y %I:%M %p")
                    deal.posted_time_source = source

        return deals
    finally:
        if owns_client:
            await client.aclose()
