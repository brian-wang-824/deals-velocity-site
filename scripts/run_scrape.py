"""One-shot scrape script, run on a schedule by GitHub Actions.

Reads site/public/data/history.json (a rolling window of past snapshots),
scrapes the current Slickdeals frontpage, appends the new snapshot, trims the
window, and writes:
  - site/public/data/history.json  (rolling window, used to compute velocity)
  - site/public/data/deals.json    (latest enriched deals, served to the site)

The workflow then commits both files, which triggers a static-site rebuild.
"""

from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

# Allow `python scripts/run_scrape.py` to find the `scraper` package
# regardless of the caller's working directory.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scraper.scraper import fetch_frontpage_deals  # noqa: E402
from scraper.velocity import enrich_deals_with_velocity  # noqa: E402

DATA_DIR = REPO_ROOT / "site" / "public" / "data"
HISTORY_FILE = DATA_DIR / "history.json"
DEALS_FILE = DATA_DIR / "deals.json"
MAX_SNAPSHOTS = 48  # ~8 hours of history at a 10-minute cadence


def load_history() -> list[dict]:
    if not HISTORY_FILE.exists():
        return []
    try:
        return json.loads(HISTORY_FILE.read_text())
    except json.JSONDecodeError:
        print(f"WARNING: {HISTORY_FILE} was unreadable JSON, starting fresh.")
        return []


def deal_to_json_dict(deal) -> dict:
    d = asdict(deal)
    d["scraped_at"] = deal.scraped_at.isoformat().replace("+00:00", "Z")
    d["posted_time"] = deal.posted_time.isoformat() + "Z" if deal.posted_time else None
    return d


def _write_json_atomic(path: Path, data) -> None:
    """Write via a temp file + rename so a killed/cancelled job can't leave
    a half-written, corrupt JSON file behind."""
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(data, indent=None, separators=(",", ":")))
    tmp_path.replace(path)


async def run() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    history = load_history()

    print(f"Loaded {len(history)} historical snapshots.")

    deals = await fetch_frontpage_deals()
    if not deals:
        print("WARNING: scrape returned 0 deals; leaving existing data files untouched.")
        return

    scraped_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    snapshot = {
        "scraped_at": scraped_at,
        "deals": [deal_to_json_dict(d) for d in deals],
    }

    history.append(snapshot)
    history = history[-MAX_SNAPSHOTS:]

    enriched = enrich_deals_with_velocity(history)

    _write_json_atomic(HISTORY_FILE, history)
    _write_json_atomic(DEALS_FILE, {"scraped_at": scraped_at, "deals": enriched, "count": len(enriched)})

    missing_posted_count = sum(1 for d in deals if d.posted_time is None)
    print(f"Scraped {len(deals)} deals from the frontpage. Missing post times: {missing_posted_count}.")


if __name__ == "__main__":
    asyncio.run(run())
