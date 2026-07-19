"""Tests for the compact, versioned scraper state contract."""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from run_scrape import (
    MAX_SNAPSHOTS,
    STATE_SCHEMA_VERSION,
    append_compact_snapshot,
    build_compact_snapshot,
    validate_compact_state,
    validate_publication_context,
)


def _timestamp(index):
    value = datetime(2026, 7, 18, tzinfo=timezone.utc) + timedelta(minutes=10 * index)
    return value.isoformat().replace("+00:00", "Z")


class TestCompactState(unittest.TestCase):
    def test_max_snapshots_matches_eight_hour_window(self):
        self.assertEqual(MAX_SNAPSHOTS, 48)

    def test_append_trims_oldest_observation(self):
        state = {
            "schema_version": STATE_SCHEMA_VERSION,
            "snapshots": [
                {"scraped_at": _timestamp(index), "votes": {"1": index}}
                for index in range(MAX_SNAPSHOTS)
            ],
        }
        current = {"scraped_at": _timestamp(MAX_SNAPSHOTS), "votes": {"1": 999}}
        next_state = append_compact_snapshot(state, current)
        self.assertEqual(len(next_state["snapshots"]), MAX_SNAPSHOTS)
        self.assertEqual(next_state["snapshots"][0]["scraped_at"], _timestamp(1))
        self.assertEqual(next_state["snapshots"][-1], current)

    def test_state_rejects_unknown_schema_instead_of_resetting(self):
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            validate_compact_state({"schema_version": 2, "snapshots": []})

    def test_state_rejects_non_chronological_snapshots(self):
        state = {
            "schema_version": STATE_SCHEMA_VERSION,
            "snapshots": [
                {"scraped_at": _timestamp(1), "votes": {}},
                {"scraped_at": _timestamp(0), "votes": {}},
            ],
        }
        with self.assertRaisesRegex(ValueError, "strictly chronological"):
            validate_compact_state(state)

    def test_state_rejects_more_than_bound(self):
        state = {
            "schema_version": STATE_SCHEMA_VERSION,
            "snapshots": [
                {"scraped_at": _timestamp(index), "votes": {}}
                for index in range(MAX_SNAPSHOTS + 1)
            ],
        }
        with self.assertRaisesRegex(ValueError, "exceeds"):
            validate_compact_state(state)

    def test_build_compact_snapshot_keeps_only_votes(self):
        snapshot = build_compact_snapshot(
            _timestamp(0),
            [
                {"thread_id": "123", "votes": 7, "title": "Large display payload"},
                {"thread_id": "456", "votes": -1, "image_url": "https://example.test/image"},
            ],
        )
        self.assertEqual(snapshot, {"scraped_at": _timestamp(0), "votes": {"123": 7, "456": -1}})

    def test_duplicate_thread_ids_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            build_compact_snapshot(
                _timestamp(0),
                [{"thread_id": "123", "votes": 1}, {"thread_id": "123", "votes": 2}],
            )

    def test_current_time_must_follow_remote_state(self):
        state = {
            "schema_version": STATE_SCHEMA_VERSION,
            "snapshots": [{"scraped_at": _timestamp(1), "votes": {}}],
        }
        with self.assertRaisesRegex(ValueError, "newer"):
            append_compact_snapshot(state, {"scraped_at": _timestamp(1), "votes": {}})

    def test_publication_context_allows_recovery_state_from_an_older_version(self):
        context = {
            "parent_version": "a" * 64,
            "state_version": "b" * 64,
            "state": {
                "schema_version": STATE_SCHEMA_VERSION,
                "snapshots": [{"scraped_at": _timestamp(0), "votes": {"1": 1}}],
            },
        }
        self.assertIs(validate_publication_context(context), context)

    def test_publication_context_rejects_invalid_cas_version(self):
        context = {
            "parent_version": "not-a-hash",
            "state_version": "b" * 64,
            "state": {
                "schema_version": STATE_SCHEMA_VERSION,
                "snapshots": [{"scraped_at": _timestamp(0), "votes": {}}],
            },
        }
        with self.assertRaisesRegex(ValueError, "parent version"):
            validate_publication_context(context)


if __name__ == "__main__":
    unittest.main()
