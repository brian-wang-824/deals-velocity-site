"""Compute thumbs-up velocity metrics from a rolling window of JSON snapshots.

Previously this queried Postgres/SQLite per-thread for "previous" and
"first" observations. There is no database anymore -- `history` is a small
in-memory list of recent snapshot dicts (as written to history.json by
scripts/run_scrape.py), so we build the same "previous / first observation
per thread_id" lookup with a single pass over that list instead of any
network or disk round trips.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from .scraper import _parse_price_to_float


def _parse_iso(value: str) -> datetime:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return datetime.now(timezone.utc)


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


def _velocity_label(recent: Optional[float], lifetime: Optional[float]) -> str:
    velocity = recent if recent is not None else lifetime
    if velocity is None:
        return "needs second scrape"
    if velocity >= 12:
        return "surging"
    if velocity >= 6:
        return "hot"
    if velocity >= 1:
        return "warming"
    if velocity > 0:
        return "slow"
    if velocity == 0:
        return "flat"
    return "cooling"


def enrich_deals_with_velocity(history: list[dict]) -> list[dict]:
    """Compute velocity metrics for the most recent snapshot in `history`.

    `history` is a list of {"scraped_at": iso_str, "deals": [deal_dict, ...]}
    ordered oldest-to-newest, exactly as persisted in history.json.
    """
    if not history:
        return []

    latest = history[-1]
    current_time = _parse_iso(latest["scraped_at"])
    current_deals = latest["deals"]

    # One pass over history to build, per thread_id, the full list of
    # (snapshot_time, deal_dict) observations in chronological order.
    thread_history: dict[str, list[tuple[datetime, dict]]] = {}
    for snapshot in history:
        snap_time = _parse_iso(snapshot["scraped_at"])
        for deal in snapshot["deals"]:
            thread_history.setdefault(deal["thread_id"], []).append((snap_time, deal))

    enriched: list[dict] = []
    for deal in current_deals:
        thread_id = deal["thread_id"]
        observations = thread_history.get(thread_id, [(current_time, deal)])

        prior = [obs for obs in observations if obs[0] < current_time]
        prev_time, prev_deal = prior[-1] if prior else (None, None)
        first_time, first_deal = observations[0]

        prev_votes = prev_deal["votes"] if prev_deal else None
        first_votes = first_deal["votes"] if first_deal else deal["votes"]

        recent_velocity = compute_velocity(deal["votes"], current_time, prev_votes, prev_time)
        # BUGFIX: if this thread's only observation *is* the current one
        # (first_time == current_time), there's no real earlier data point
        # to compare against. Without this guard, compute_velocity divides
        # by the 1-minute floor and reports a false 0.0 ("flat") for deals
        # that have genuinely never been scraped before -- they should show
        # "needs second scrape" instead, same as recent_velocity already does.
        if first_time < current_time:
            lifetime_velocity = compute_velocity(deal["votes"], current_time, first_votes, first_time)
        else:
            lifetime_velocity = None
        vote_delta = deal["votes"] - prev_votes if prev_votes is not None else None
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
                "votes": deal["votes"],
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
        key=lambda d: (
            d["recent_velocity"] is not None,
            d["recent_velocity"] or 0,
            d["votes"],
        ),
        reverse=True,
    )
    return enriched
