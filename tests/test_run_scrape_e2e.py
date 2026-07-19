"""End-to-end scraper orchestration tests with all network edges mocked."""

import json
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import run_scrape
from scraper.scraper import Deal


FIXED_NOW = datetime(2026, 7, 18, 13, 0, 0, tzinfo=timezone.utc)
PARENT_VERSION = "a" * 64


class _FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED_NOW if tz is not None else FIXED_NOW.replace(tzinfo=None)


class _Response:
    def __init__(self, status=200, body=b""):
        self.status = status
        self._body = body

    def read(self, amount=-1):
        return self._body if amount == -1 else self._body[:amount]

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _fake_deal(thread_id, votes):
    return Deal(
        thread_id=thread_id,
        title=f"Deal {thread_id}",
        url=f"https://slickdeals.net/f/{thread_id}",
        store="Amazon",
        price="$10.00",
        original_price="$20.00",
        votes=votes,
        comments=0,
        views=0,
        posted_label="July 18, 2026 12:00 PM",
        posted_time=datetime(2026, 7, 18, 12, 0, 0),
        posted_time_source="card",
        found_by=None,
        is_new=False,
        image_url="https://slickdeals.net/img/x.jpg",
        scraped_at=FIXED_NOW,
    )


def _publication(snapshot, published=True):
    return {
        "ok": True,
        "published": published,
        "version": "b" * 64,
        "snapshot_path": f"v1/2026/07/18/{'b' * 64}.json",
        "scraped_at": snapshot["scraped_at"],
    }


def _context(state=None, parent_version=PARENT_VERSION, state_version=PARENT_VERSION):
    return {
        "parent_version": parent_version,
        "state_version": state_version,
        "state": state or run_scrape._empty_state(),
    }


class TestRunScrapeEndToEnd(unittest.IsolatedAsyncioTestCase):
    async def test_first_run_publishes_baseline_then_dispatches_same_snapshot(self):
        calls = []
        published = {}

        def publish(snapshot, state, parent_version):
            calls.append("publish")
            published.update({"snapshot": snapshot, "state": state, "parent_version": parent_version})
            return _publication(snapshot)

        def notify(snapshot):
            calls.append("notify")
            self.assertIs(snapshot, published["snapshot"])
            return True

        with (
            patch.object(run_scrape, "datetime", _FixedDateTime),
            patch.object(run_scrape, "fetch_publication_context", return_value=run_scrape._empty_publication_context()),
            patch.object(run_scrape, "fetch_frontpage_deals", return_value=[_fake_deal("1", 10)]),
            patch.object(run_scrape, "publish_snapshot", side_effect=publish),
            patch.object(run_scrape, "dispatch_notifications", side_effect=notify),
        ):
            await run_scrape.run()

        self.assertEqual(calls, ["publish", "notify"])
        self.assertIsNone(published["parent_version"])
        self.assertEqual(published["snapshot"]["count"], 1)
        self.assertEqual(published["snapshot"]["deals"][0]["thread_id"], "1")
        self.assertIsNone(published["snapshot"]["deals"][0]["recent_velocity"])
        self.assertEqual(
            published["state"]["snapshots"][-1],
            {"scraped_at": "2026-07-18T13:00:00Z", "votes": {"1": 10}},
        )

    async def test_second_run_exposes_updated_velocity(self):
        initial = {
            "schema_version": 1,
            "snapshots": [{"scraped_at": "2026-07-18T12:50:00Z", "votes": {"1": 8}}],
        }
        captured = {}

        def publish(snapshot, state, parent_version):
            captured.update({"snapshot": snapshot, "state": state, "parent_version": parent_version})
            return _publication(snapshot)

        with (
            patch.object(run_scrape, "datetime", _FixedDateTime),
            patch.object(run_scrape, "fetch_publication_context", return_value=_context(initial)),
            patch.object(run_scrape, "fetch_frontpage_deals", return_value=[_fake_deal("1", 10)]),
            patch.object(run_scrape, "publish_snapshot", side_effect=publish),
            patch.object(run_scrape, "dispatch_notifications", return_value=True),
        ):
            await run_scrape.run()

        deal = captured["snapshot"]["deals"][0]
        self.assertEqual(deal["vote_delta"], 2)
        self.assertEqual(deal["recent_velocity"], 12.0)
        self.assertEqual(deal["velocity_label"], "hot")
        self.assertEqual(len(captured["state"]["snapshots"]), 2)
        self.assertEqual(captured["parent_version"], PARENT_VERSION)

    async def test_empty_scrape_leaves_current_publication_untouched(self):
        with (
            patch.object(run_scrape, "fetch_publication_context", return_value=run_scrape._empty_publication_context()),
            patch.object(run_scrape, "fetch_frontpage_deals", return_value=[]),
            patch.object(run_scrape, "publish_snapshot") as publish,
            patch.object(run_scrape, "dispatch_notifications") as notify,
        ):
            await run_scrape.run()
        publish.assert_not_called()
        notify.assert_not_called()

    async def test_publish_failure_is_fatal_and_blocks_notifications(self):
        with (
            patch.object(run_scrape, "datetime", _FixedDateTime),
            patch.object(run_scrape, "fetch_publication_context", return_value=run_scrape._empty_publication_context()),
            patch.object(run_scrape, "fetch_frontpage_deals", return_value=[_fake_deal("1", 10)]),
            patch.object(run_scrape, "publish_snapshot", side_effect=run_scrape.DealDataError("offline")),
            patch.object(run_scrape, "dispatch_notifications") as notify,
        ):
            with self.assertRaisesRegex(run_scrape.DealDataError, "offline"):
                await run_scrape.run()
        notify.assert_not_called()

    async def test_notification_failure_does_not_undo_successful_publish(self):
        with (
            patch.object(run_scrape, "datetime", _FixedDateTime),
            patch.object(run_scrape, "fetch_publication_context", return_value=run_scrape._empty_publication_context()),
            patch.object(run_scrape, "fetch_frontpage_deals", return_value=[_fake_deal("1", 10)]),
            patch.object(
                run_scrape,
                "publish_snapshot",
                side_effect=lambda snapshot, _state, _parent_version: _publication(snapshot),
            ),
            patch.object(run_scrape, "dispatch_notifications", return_value=False) as notify,
        ):
            await run_scrape.run()
        notify.assert_called_once()


class TestDealDataHttp(unittest.TestCase):
    def test_missing_required_config_fails_closed(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(run_scrape.DealDataError, "Missing required"):
                run_scrape.fetch_publication_context()

    def test_http_204_bootstraps_empty_state(self):
        with (
            patch.dict(
                os.environ,
                {
                    "SUPABASE_DEAL_DATA_FUNCTION_URL": "https://project.test/functions/v1/deal-data/",
                    "DEAL_DATA_PUBLISH_SECRET": "secret",
                },
                clear=True,
            ),
            patch.object(run_scrape.urllib.request, "urlopen", return_value=_Response(status=204)) as urlopen,
        ):
            self.assertEqual(run_scrape.fetch_publication_context(), run_scrape._empty_publication_context())
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://project.test/functions/v1/deal-data/state")
        self.assertEqual(request.get_header("X-deal-data-secret"), "secret")

    def test_corrupt_remote_state_is_fatal_not_a_silent_reset(self):
        response = _Response(body=b'{"parent_version":"bad","state_version":"bad","state":{}}')
        with (
            patch.dict(
                os.environ,
                {
                    "SUPABASE_DEAL_DATA_FUNCTION_URL": "https://project.test/functions/v1/deal-data",
                    "DEAL_DATA_PUBLISH_SECRET": "secret",
                },
                clear=True,
            ),
            patch.object(run_scrape.urllib.request, "urlopen", return_value=response),
        ):
            with self.assertRaisesRegex(run_scrape.DealDataError, "invalid"):
                run_scrape.fetch_publication_context()

    def test_state_response_preserves_parent_and_recovery_versions(self):
        state = {
            "schema_version": 1,
            "snapshots": [{"scraped_at": "2026-07-18T12:50:00Z", "votes": {"1": 8}}],
        }
        context = _context(state, parent_version="a" * 64, state_version="c" * 64)
        with (
            patch.dict(
                os.environ,
                {
                    "SUPABASE_DEAL_DATA_FUNCTION_URL": "https://project.test/functions/v1/deal-data",
                    "DEAL_DATA_PUBLISH_SECRET": "secret",
                },
                clear=True,
            ),
            patch.object(
                run_scrape.urllib.request,
                "urlopen",
                return_value=_Response(body=json.dumps(context).encode()),
            ),
        ):
            self.assertEqual(run_scrape.fetch_publication_context(), context)

    def test_publish_sends_snapshot_and_state_contract(self):
        state = {
            "schema_version": 1,
            "snapshots": [{"scraped_at": "2026-07-18T13:00:00Z", "votes": {"1": 10}}],
        }
        snapshot = {
            "scraped_at": "2026-07-18T13:00:00Z",
            "count": 1,
            "deals": [{"thread_id": "1", "votes": 10}],
        }
        result = _publication(snapshot)
        with (
            patch.dict(
                os.environ,
                {
                    "SUPABASE_DEAL_DATA_FUNCTION_URL": "https://project.test/functions/v1/deal-data",
                    "DEAL_DATA_PUBLISH_SECRET": "secret",
                },
                clear=True,
            ),
            patch.object(
                run_scrape.urllib.request,
                "urlopen",
                return_value=_Response(body=json.dumps(result).encode()),
            ) as urlopen,
        ):
            self.assertEqual(run_scrape.publish_snapshot(snapshot, state, PARENT_VERSION), result)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://project.test/functions/v1/deal-data/publish")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("X-deal-data-secret"), "secret")
        self.assertEqual(
            json.loads(request.data),
            {"parent_version": PARENT_VERSION, "snapshot": snapshot, "state": state},
        )


class TestNotificationDispatch(unittest.TestCase):
    def test_skips_when_not_configured(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(run_scrape.dispatch_notifications({"scraped_at": "now", "deals": []}))

    def test_posts_snapshot_with_shared_secret(self):
        response = MagicMock()
        response.status = 200
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        snapshot = {"scraped_at": "2026-07-11T00:00:00Z", "deals": [{"thread_id": "1"}], "count": 1}
        with (
            patch.dict(
                os.environ,
                {
                    "SUPABASE_NOTIFICATION_PROCESS_URL": "https://example.test/process",
                    "SCRAPE_DISPATCH_SECRET": "secret",
                },
                clear=True,
            ),
            patch.object(run_scrape.urllib.request, "urlopen", return_value=response) as urlopen,
        ):
            self.assertTrue(run_scrape.dispatch_notifications(snapshot))

        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://example.test/process")
        self.assertEqual(request.get_header("X-scrape-secret"), "secret")
        self.assertEqual(json.loads(request.data), snapshot)


if __name__ == "__main__":
    unittest.main()
