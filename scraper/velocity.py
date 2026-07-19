"""Compute thumbs-up velocity from a compact rolling observation window.

Only the latest deal payload needs every display field. Historical snapshots
store a timestamp plus ``thread_id -> votes`` pairs, which keeps the private
state small enough to fetch on every ten-minute scrape without meaningful
bandwidth or storage growth.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from .scraper import _parse_price_to_float


def _parse_iso(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _hours_between(start: datetime, end: datetime) -> float:
    return max((end - start).total_seconds() / 3600.0, 1 / 60)


def _calculate_discount_percentage(price: Optional[str], original_price: Optional[str]) -> Optional[float]:
    price_float = _parse_price_to_float(price)
    original_float = _parse_price_to_float(original_price)
    if price_float is None or original_float is None or original_float == 0:
        return None
    discount = ((original_float - price_float) / original_float) * 100
    return round(discount, 1)


def compute_velocity(
    current_votes: int,
    current_time: datetime,
    previous_votes: Optional[int],
    previous_time: Optional[datetime],
) -> Optional[float]:
    if previous_votes is None or previous_time is None:
        return None
    delta_votes = current_votes - previous_votes
    delta_hours = _hours_between(previous_time, current_time)
    return round(delta_votes / delta_hours, 2)


def _velocity_label(recent: Optional[float], lifetime: Optional[float]) -> Optional[str]:
    velocity = recent if recent is not None else lifetime
    if velocity is None:
        return None
    if velocity >= 36:
        return "inferno"
    if velocity >= 30:
        return "on fire"
    if velocity >= 24:
        return "blazing"
    if velocity >= 18:
        return "surging"
    if velocity >= 12:
        return "hot"
    if velocity >= 6:
        return "warming"
    return None


def enrich_deals_with_velocity(
    current_deals: list[dict],
    current_scraped_at: str,
    snapshots: list[dict],
) -> list[dict]:
    """Enrich the current full deals from compact vote observations.

    ``snapshots`` must be chronological and include the current observation as
    its final entry. Each snapshot has the form
    ``{"scraped_at": <ISO string>, "votes": {<thread id>: <integer>}}``.
    The caller validates that contract before invoking this function.
    """
    if not current_deals:
        return []

    current_time = _parse_iso(current_scraped_at)
    thread_history: dict[str, list[tuple[datetime, int]]] = {}
    for snapshot in snapshots:
        snapshot_time = _parse_iso(snapshot["scraped_at"])
        for thread_id, votes in snapshot["votes"].items():
            thread_history.setdefault(thread_id, []).append((snapshot_time, votes))

    enriched: list[dict] = []
    for deal in current_deals:
        thread_id = deal["thread_id"]
        current_votes = deal["votes"]
        observations = thread_history.get(thread_id, [(current_time, current_votes)])

        prior = [observation for observation in observations if observation[0] < current_time]
        previous_time, previous_votes = prior[-1] if prior else (None, None)
        first_time, first_votes = observations[0]

        recent_velocity = compute_velocity(current_votes, current_time, previous_votes, previous_time)
        lifetime_velocity = (
            compute_velocity(current_votes, current_time, first_votes, first_time)
            if first_time < current_time
            else None
        )
        vote_delta = current_votes - previous_votes if previous_votes is not None else None
        discount_percentage = _calculate_discount_percentage(deal.get("price"), deal.get("original_price"))

        enriched.append(
            {
                "thread_id": deal["thread_id"],
                "title": deal["title"],
                "url": deal["url"],
                "store": deal["store"],
                "price": deal["price"],
                "original_price": deal["original_price"],
                "discount_percentage": discount_percentage,
                "votes": current_votes,
                "comments": deal["comments"],
                "views": deal["views"],
                "posted_label": deal.get("posted_label"),
                "posted_time": deal.get("posted_time"),
                "posted_time_source": deal.get("posted_time_source"),
                "found_by": deal.get("found_by"),
                "is_new": bool(deal.get("is_new")),
                "image_url": deal.get("image_url"),
                "recent_velocity": recent_velocity,
                "lifetime_velocity": lifetime_velocity,
                "vote_delta": vote_delta,
                "velocity_label": _velocity_label(recent_velocity, lifetime_velocity),
            }
        )

    enriched.sort(
        key=lambda deal: (
            deal["recent_velocity"] is not None,
            deal["recent_velocity"] or 0,
            deal["votes"],
        ),
        reverse=True,
    )
    return enriched
