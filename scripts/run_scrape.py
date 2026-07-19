"""Run one Slickdeals scrape and publish it without rebuilding the website.

The rolling velocity state and immutable public snapshots live in Supabase.
GitHub Actions invokes this script every ten minutes; Render only rebuilds
when application code changes.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

# Allow ``python scripts/run_scrape.py`` to find the scraper package regardless
# of the caller's working directory.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scraper.scraper import fetch_frontpage_deals  # noqa: E402
from scraper.velocity import enrich_deals_with_velocity  # noqa: E402

MAX_SNAPSHOTS = 48  # ~8 hours at a 10-minute cadence
MAX_DEALS = 1000
MAX_SAFE_INTEGER = (2**53) - 1  # Match JavaScript/Edge Function validation.
STATE_SCHEMA_VERSION = 1
DATA_FUNCTION_URL_ENV = "SUPABASE_DEAL_DATA_FUNCTION_URL"
DATA_FUNCTION_SECRET_ENV = "DEAL_DATA_PUBLISH_SECRET"
DEAL_DATA_SECRET_HEADER = "X-Deal-Data-Secret"
PUBLICATION_VERSION_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class DealDataError(RuntimeError):
    """Raised when the required publication service cannot be used safely."""


def _empty_state() -> dict:
    return {"schema_version": STATE_SCHEMA_VERSION, "snapshots": []}


def _empty_publication_context() -> dict:
    return {"parent_version": None, "state_version": None, "state": _empty_state()}


def _parse_timestamp(value: object, label: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty ISO-8601 string.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{label} is not valid ISO-8601.") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone.")
    return parsed.astimezone(timezone.utc)


def _utc_iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _is_safe_integer(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, int)
        and -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER
    )


def validate_compact_state(state: object) -> dict:
    """Validate the versioned private velocity-state contract.

    Validation is deliberately strict: an unknown schema or malformed remote
    object must fail the run instead of silently resetting velocity history.
    """
    if not isinstance(state, dict):
        raise ValueError("Velocity state must be a JSON object.")
    if set(state) != {"schema_version", "snapshots"}:
        raise ValueError("Velocity state has unexpected or missing fields.")
    if state["schema_version"] != STATE_SCHEMA_VERSION:
        raise ValueError(f"Unsupported velocity-state schema: {state['schema_version']!r}.")

    snapshots = state["snapshots"]
    if not isinstance(snapshots, list):
        raise ValueError("Velocity-state snapshots must be an array.")
    if len(snapshots) > MAX_SNAPSHOTS:
        raise ValueError(f"Velocity state exceeds the {MAX_SNAPSHOTS}-snapshot limit.")

    previous_time = None
    for index, snapshot in enumerate(snapshots):
        if not isinstance(snapshot, dict) or set(snapshot) != {"scraped_at", "votes"}:
            raise ValueError(f"Velocity snapshot {index} has an invalid shape.")
        snapshot_time = _parse_timestamp(snapshot["scraped_at"], f"snapshots[{index}].scraped_at")
        if previous_time is not None and snapshot_time <= previous_time:
            raise ValueError("Velocity snapshots must be strictly chronological.")
        previous_time = snapshot_time

        votes = snapshot["votes"]
        if not isinstance(votes, dict):
            raise ValueError(f"snapshots[{index}].votes must be an object.")
        if len(votes) > MAX_DEALS:
            raise ValueError(f"snapshots[{index}].votes exceeds the {MAX_DEALS}-deal limit.")
        for thread_id, vote_count in votes.items():
            if not isinstance(thread_id, str) or not 1 <= len(thread_id) <= 128:
                raise ValueError(f"snapshots[{index}] contains an invalid thread id.")
            if not _is_safe_integer(vote_count):
                raise ValueError(f"snapshots[{index}].votes[{thread_id!r}] must be a safe integer.")

    return state


def validate_publication_context(context: object) -> dict:
    if not isinstance(context, dict) or set(context) != {"parent_version", "state_version", "state"}:
        raise ValueError("Deal-data state context has an invalid shape.")
    parent_version = context["parent_version"]
    state_version = context["state_version"]
    if not isinstance(parent_version, str) or not PUBLICATION_VERSION_PATTERN.fullmatch(parent_version):
        raise ValueError("Deal-data state context has an invalid parent version.")
    if not isinstance(state_version, str) or not PUBLICATION_VERSION_PATTERN.fullmatch(state_version):
        raise ValueError("Deal-data state context has an invalid state version.")
    validate_compact_state(context["state"])
    if not context["state"]["snapshots"]:
        raise ValueError("An initialized deal-data state context cannot be empty.")
    return context


def deal_to_json_dict(deal) -> dict:
    value = asdict(deal)
    value["scraped_at"] = _utc_iso(deal.scraped_at)
    value["posted_time"] = _utc_iso(deal.posted_time) if deal.posted_time else None
    return value


def build_compact_snapshot(scraped_at: str, deals: list[dict]) -> dict:
    _parse_timestamp(scraped_at, "scraped_at")
    if len(deals) > MAX_DEALS:
        raise ValueError(f"Scrape returned more than the {MAX_DEALS}-deal publication limit.")
    votes: dict[str, int] = {}
    for deal in deals:
        thread_id = deal.get("thread_id")
        vote_count = deal.get("votes")
        if not isinstance(thread_id, str) or not 1 <= len(thread_id) <= 128:
            raise ValueError("Every scraped deal must have a non-empty string thread_id.")
        if thread_id in votes:
            raise ValueError(f"Scrape returned duplicate thread_id {thread_id!r}.")
        if not _is_safe_integer(vote_count):
            raise ValueError(f"Deal {thread_id!r} has a vote count outside the safe-integer range.")
        votes[thread_id] = vote_count
    return {"scraped_at": scraped_at, "votes": votes}


def append_compact_snapshot(state: dict, snapshot: dict) -> dict:
    validate_compact_state(state)
    validate_compact_state({"schema_version": STATE_SCHEMA_VERSION, "snapshots": [snapshot]})
    if state["snapshots"]:
        latest = _parse_timestamp(state["snapshots"][-1]["scraped_at"], "latest scraped_at")
        current = _parse_timestamp(snapshot["scraped_at"], "current scraped_at")
        if current <= latest:
            raise ValueError("Current scrape time must be newer than the published velocity state.")
    snapshots = [*state["snapshots"], snapshot][-MAX_SNAPSHOTS:]
    next_state = {"schema_version": STATE_SCHEMA_VERSION, "snapshots": snapshots}
    validate_compact_state(next_state)
    return next_state


def _deal_data_settings() -> tuple[str, str]:
    base_url = os.environ.get(DATA_FUNCTION_URL_ENV, "").strip().rstrip("/")
    secret = os.environ.get(DATA_FUNCTION_SECRET_ENV, "").strip()
    missing = [
        name
        for name, value in ((DATA_FUNCTION_URL_ENV, base_url), (DATA_FUNCTION_SECRET_ENV, secret))
        if not value
    ]
    if missing:
        raise DealDataError(f"Missing required deal-data configuration: {', '.join(missing)}.")
    return base_url, secret


def _error_detail(error: urllib.error.HTTPError) -> str:
    try:
        detail = error.read(1000).decode("utf-8", errors="replace").strip()
    except (OSError, AttributeError):
        detail = ""
    return f": {detail}" if detail else ""


def fetch_publication_context() -> dict:
    """Fetch private state plus the latest-version compare-and-swap token."""
    base_url, secret = _deal_data_settings()
    request = urllib.request.Request(
        f"{base_url}/state",
        headers={"Accept": "application/json", DEAL_DATA_SECRET_HEADER: secret},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status == 204:
                return _empty_publication_context()
            if not 200 <= response.status < 300:
                raise DealDataError(f"Deal-data state request returned HTTP {response.status}.")
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raise DealDataError(f"Deal-data state request returned HTTP {exc.code}{_error_detail(exc)}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise DealDataError(f"Deal-data state request failed: {exc}") from exc

    try:
        context = json.loads(raw)
        return validate_publication_context(context)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise DealDataError(f"Deal-data state response was invalid: {exc}") from exc


def publish_snapshot(snapshot: dict, state: dict, parent_version: str | None) -> dict:
    """Publish data atomically through the authenticated Supabase function."""
    validate_compact_state(state)
    if parent_version is not None and not PUBLICATION_VERSION_PATTERN.fullmatch(parent_version):
        raise ValueError("parent_version must be null or a lowercase SHA-256 value.")
    base_url, secret = _deal_data_settings()
    body = json.dumps(
        {"parent_version": parent_version, "snapshot": snapshot, "state": state},
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/publish",
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            DEAL_DATA_SECRET_HEADER: secret,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if not 200 <= response.status < 300:
                raise DealDataError(f"Deal-data publish returned HTTP {response.status}.")
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raise DealDataError(f"Deal-data publish returned HTTP {exc.code}{_error_detail(exc)}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise DealDataError(f"Deal-data publish failed: {exc}") from exc

    try:
        result = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise DealDataError("Deal-data publish returned invalid JSON.") from exc
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise DealDataError("Deal-data publish did not confirm success.")
    if not isinstance(result.get("published"), bool):
        raise DealDataError("Deal-data publish response omitted its publication status.")
    version = result.get("version")
    if not isinstance(version, str) or not PUBLICATION_VERSION_PATTERN.fullmatch(version):
        raise DealDataError("Deal-data publish response omitted its version.")
    if result.get("scraped_at") != snapshot.get("scraped_at"):
        raise DealDataError("Deal-data publish confirmed a different scrape timestamp.")
    snapshot_path = result.get("snapshot_path")
    path_match = (
        re.fullmatch(r"v1/\d{4}/\d{2}/\d{2}/([0-9a-f]{64})\.json", snapshot_path)
        if isinstance(snapshot_path, str)
        else None
    )
    if path_match is None or path_match.group(1) != version:
        raise DealDataError("Deal-data publish response omitted its snapshot path.")
    return result


def dispatch_notifications(snapshot: dict) -> bool:
    """Best-effort dispatch after publication; it never invalidates the data."""
    url = os.environ.get("SUPABASE_NOTIFICATION_PROCESS_URL", "").strip()
    secret = os.environ.get("SCRAPE_DISPATCH_SECRET", "").strip()
    if not url or not secret:
        print("Notification dispatch not configured; skipping.")
        return False

    request = urllib.request.Request(
        url,
        data=json.dumps(snapshot, separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Scrape-Secret": secret},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if not 200 <= response.status < 300:
                print(f"WARNING: notification dispatch returned HTTP {response.status}.")
                return False
        print("Notification snapshot dispatched.")
        return True
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        print(f"WARNING: notification dispatch failed: {exc}")
        return False


async def run() -> None:
    context = fetch_publication_context()
    state = context["state"]
    print(f"Loaded {len(state['snapshots'])} compact velocity snapshots.")
    if context["state_version"] != context["parent_version"]:
        print(
            "WARNING: recovered velocity state from an earlier publication; "
            "the next publish will repair the current lineage."
        )

    deals = await fetch_frontpage_deals()
    if not deals:
        print("WARNING: scrape returned 0 deals; leaving the current publication untouched.")
        return

    scraped_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    current_deals = [deal_to_json_dict(deal) for deal in deals]
    compact_snapshot = build_compact_snapshot(scraped_at, current_deals)
    next_state = append_compact_snapshot(state, compact_snapshot)
    enriched = enrich_deals_with_velocity(current_deals, scraped_at, next_state["snapshots"])
    public_snapshot = {"scraped_at": scraped_at, "deals": enriched, "count": len(enriched)}

    publication = publish_snapshot(public_snapshot, next_state, context["parent_version"])
    action = "Published" if publication["published"] else "Confirmed existing"
    print(f"{action} immutable snapshot {publication['version']}.")

    # Notifications intentionally happen only after the snapshot and its state
    # are durably registered. A notification failure remains best effort.
    dispatch_notifications(public_snapshot)

    missing_posted_count = sum(1 for deal in deals if deal.posted_time is None)
    print(f"Scraped {len(deals)} deals from the frontpage. Missing post times: {missing_posted_count}.")


if __name__ == "__main__":
    asyncio.run(run())
