"""Scrape frontpage deals from slickdeals.net.

Performance notes (see project audit for full context):
  - Post times come only from the Slickdeals frontpage card markup. This keeps
    each scrape to a single frontpage request and avoids per-deal network
    latency.
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
    posted_time_source: Optional[str]  # 'card'
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
    if time_str.lower() in {"recently posted", "just posted"}:
        return reference_date.replace(tzinfo=None, second=0, microsecond=0)

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


def _scraped_at_fallback(scraped_at: datetime) -> datetime:
    return scraped_at.replace(tzinfo=None, second=0, microsecond=0)


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
        posted_time = _scraped_at_fallback(scraped_at)
        posted_time_source = "card"
        if timestamp_el:
            posted_label = timestamp_el.get("title") or timestamp_el.get_text(strip=True)
            posted_time = _parse_posted_time(timestamp_el, scraped_at) or _scraped_at_fallback(scraped_at)
        else:
            posted_label = "frontpage timestamp unavailable"

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


async def fetch_frontpage_deals(
    client: Optional[httpx.AsyncClient] = None,
    limit: Optional[int] = None,
) -> list[Deal]:
    """Fetch and parse current frontpage deals.

    Args:
        client: Optional httpx client to reuse.
        limit: Optional cap on number of deals returned (mainly for tests).
    """
    if httpx is None:
        raise RuntimeError("httpx is required for network operations. Install it via requirements-scraper.txt.")

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

        return deals
    finally:
        if owns_client:
            await client.aclose()
