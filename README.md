# Deals Velocity

A static Slickdeals dashboard that ranks current frontpage deals by thumbs-up velocity. A scheduled Python scraper maintains a rolling snapshot history; a dependency-light browser app provides search, posted-time filters, sorting, and pagination.

## How it works

1. `scripts/run_scrape.py` fetches and parses the Slickdeals frontpage.
2. `site/public/data/history.json` retains the latest 48 snapshots (about eight hours at the scheduled cadence).
3. `scraper/velocity.py` calculates vote deltas, recent and lifetime velocity, discounts, and velocity labels.
4. `site/public/data/deals.json` stores the enriched current snapshot consumed by the frontend.
5. Render builds and serves the static files from `site/dist/`.

## Project structure

```text
scraper/                 Parsing and velocity calculations
scripts/run_scrape.py    One-shot scraper entry point
site/public/app.js       Browser application and exported test helpers
site/public/data/        Committed scraper output
site/src/                HTML shell and Tailwind source CSS
site/scripts/            Static build asset copying
site/tests/              Frontend helper tests
tests/                   Python unit and scraper workflow tests
```

## Setup

Requirements: Python 3.12+ and Node.js with npm.

```powershell
python -m pip install -r requirements-scraper.txt
cd site
npm ci
```

## Development

Watch and rebuild CSS in `site/public/style.css`:

```powershell
cd site
npm run dev
```

Serve `site/public/` with any local static server. The generated CSS, dependencies, and `site/dist/` are intentionally ignored.

Run one scrape from the repository root:

```powershell
python scripts/run_scrape.py
```

The scraper leaves existing data untouched if no deals are returned and writes successful updates atomically.

## Test and build

```powershell
python -m unittest discover -v
cd site
npm test
npm run build
```

The production build writes minified CSS and required static assets to `site/dist/`. It removes stale build assets and fails if a required source asset is missing.

## Automation and deployment

`.github/workflows/scrape.yml` runs every ten minutes and commits updated `history.json` and `deals.json` files. `render.yaml` configures the Render static site to run `npm install && npm run build`, publish `site/dist`, and disable caching for JSON data.
