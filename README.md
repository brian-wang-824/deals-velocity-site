# Deals Velocity

An independent, experimental dashboard that calculates activity trends for deals appearing on the Slickdeals frontpage. A scheduled collector keeps a limited rolling history in Supabase, while a dependency-light browser app provides search, posted-time filters, sorting, pagination, and Web Push notifications.

## Data source and independence

Deal information and community-vote counts originate from [Slickdeals](https://slickdeals.net/) and are transformed here into independently calculated velocity metrics. This project is not affiliated with, endorsed by, sponsored by, or operated by Slickdeals, LLC. "Slickdeals" and related marks belong to their respective owner.

Displayed deal information is time-sensitive, may be incomplete or inaccurate, and should be verified on the linked source and retailer pages before use. This repository does not grant permission to access, reproduce, or redistribute third-party content. Anyone operating or deploying the project is responsible for obtaining any required authorization and complying with applicable website terms, robots instructions, intellectual-property rights, and law.

## How it works

1. An external cron scheduler dispatches `.github/workflows/scrape.yml` every ten minutes. The workflow can also be run manually.
2. `scripts/run_scrape.py` retrieves the private rolling state through the Supabase `deal-data` Edge Function, then fetches and parses the Slickdeals frontpage.
3. `scraper/velocity.py` compares the current observation with the rolling history and calculates vote deltas, velocity, discounts, and heat labels.
4. The scraper sends the enriched snapshot, updated state, and the parent publication version to the authenticated `deal-data` publisher. Supabase uses that parent as a compare-and-swap token, stores the bounded state privately, writes the snapshot as an immutable public object, and appends its public `deal_data_publications` metadata only after both objects are available. The newest metadata row is the publication pointer.
5. The browser polls the small publication pointer. It downloads a snapshot from the public `deal-snapshots` bucket only when the published version changes.
6. Render builds and serves the static application from `site/dist/`. Scrape runs do not commit generated JSON and do not trigger Render builds.

The rolling state retains the latest 48 observations, or about eight hours at the ten-minute cadence. It is operational state, not source code, and is intentionally absent from Git.

Publication lineage prevents overlapping or manually duplicated collectors from silently overwriting one another's observation. If the newest private state object is missing or fails its integrity check, the publisher can recover from the newest valid retained state and repair the lineage on the next successful scrape. Bounded retention runs in the Edge Function background after a publication is already durable, so cleanup cannot delay the scraper's success response.

### Clean start behavior

An empty deployment has no prior observation to compare with. The first successful scrape seeds the private state and publishes a usable current snapshot, but vote deltas, calculated velocity, and heat labels that require a comparison are intentionally unavailable. The next successful scrape, approximately ten minutes later, supplies the first comparison interval. A deal first seen on any later run similarly needs another observation before it has comparison-based velocity.

## Project structure

```text
scraper/                 Parsing and velocity calculations
scripts/run_scrape.py    One-shot state, scrape, publish, and notification flow
site/public/app.js       Browser application and exported test helpers
site/src/                HTML shell and Tailwind source CSS
site/scripts/            Static build asset copying and runtime config generation
site/tests/              Frontend helper tests
supabase/functions/      Authenticated data publishing and notification functions
supabase/migrations/     Publication, storage, and notification schema
tests/                   Python unit and scraper workflow tests
```

Generated deal data is not a build input. Local `site/public/data/*.json` files, `site/dist/`, generated CSS, and installed dependencies are ignored.

## Local setup

Requirements: Python 3.12+ and Node.js with npm.

```powershell
python -m pip install -r requirements-scraper.txt
cd site
npm ci
```

Watch and rebuild CSS in `site/public/style.css`:

```powershell
cd site
npm run dev
```

Build and serve `site/dist/` with any local static server. To run a real scrape, provide a configured non-production Supabase publisher unless you intentionally want to update production data:

```powershell
$env:SUPABASE_DEAL_DATA_FUNCTION_URL = "https://PROJECT_REF.supabase.co/functions/v1/deal-data"
$env:DEAL_DATA_PUBLISH_SECRET = "replace-with-a-long-random-secret"
python scripts/run_scrape.py
```

Notification environment variables are optional for local scraping. The scraper leaves published data untouched if the source returns no deals.

## Test and build

```powershell
python -m unittest discover -v
cd site
npm test
npm run build
```

The production build writes minified CSS, static assets, and browser-safe runtime configuration to `site/dist/`. It removes stale build assets and fails if a required source asset is missing.

## Supabase data publication

Apply the migrations, create one strong random publisher secret, store it in Supabase, and deploy the Edge Function without platform JWT verification. The function authenticates its state and publish routes with the separate `X-Deal-Data-Secret` header.

```powershell
supabase db push
supabase secrets set DEAL_DATA_PUBLISH_SECRET="replace-with-a-long-random-secret"
supabase functions deploy deal-data --no-verify-jwt
```

The data migration is `supabase/migrations/202607180001_deal_data_publications.sql`. It provisions:

- the public `deal_data_publications` index, whose newest row is the current publication pointer;
- the public `deal-snapshots` bucket, containing immutable objects under `v1/YYYY/MM/DD/<sha256>.json`;
- the private `deal-state` bucket, containing the compressed rolling state.

The Edge Function base URL is:

```text
https://PROJECT_REF.supabase.co/functions/v1/deal-data
```

The scraper uses authenticated `GET /state` and `POST /publish` routes beneath that URL. An initialized state response includes the current `parent_version`, the `state_version` actually recovered, and the compact state; publication supplies the parent version back for atomic lineage validation. Keep `DEAL_DATA_PUBLISH_SECRET` server-side; never put it in Render's browser configuration.

## GitHub Actions secrets

Set these required repository secrets for data publication:

- `SUPABASE_DEAL_DATA_FUNCTION_URL=https://PROJECT_REF.supabase.co/functions/v1/deal-data`
- `DEAL_DATA_PUBLISH_SECRET` to exactly the same random value stored in Supabase.

The workflow has read-only repository contents permission. It publishes to Supabase directly and never commits or pushes generated snapshots.

For notifications, also set:

- `SUPABASE_NOTIFICATION_PROCESS_URL=https://PROJECT_REF.supabase.co/functions/v1/notifications/process`
- `SCRAPE_DISPATCH_SECRET` to the same value stored in the notification function.

If notification configuration is absent or delivery is unavailable, data publication can still complete; notification delivery is best effort.

## Render environment

Set these browser-safe build environment variables on the Render static site:

- `SUPABASE_DATA_PUBLICATION_URL=https://PROJECT_REF.supabase.co/rest/v1/deal_data_publications?select=version%2Csnapshot_path%2Cscraped_at%2Cdeal_count&order=scraped_at.desc&limit=1`;
- `SUPABASE_DATA_SNAPSHOT_BASE_URL=https://PROJECT_REF.supabase.co/storage/v1/object/public/deal-snapshots/`;
- `SUPABASE_PUBLISHABLE_KEY` to the project's browser-safe publishable key.

Render sets `RENDER=true` during builds. Production builds intentionally fail before static assets are copied if any of these three required values is missing or blank, preventing a successful-looking deployment with no data source. Local builds remain available with empty data configuration for tests and offline layout work.

For Web Push, also set:

- `SUPABASE_NOTIFICATION_FUNCTION_URL=https://PROJECT_REF.supabase.co/functions/v1/notifications`;
- `VAPID_PUBLIC_KEY` to the public half of the VAPID key pair.

`render.yaml` ignores the legacy `site/public/data/**` paths as a defense against accidental data-driven builds. Normal source changes still build with `npm install && npm run build` and publish `site/dist/`.

## Push notifications

The site supports anonymous, per-device Web Push subscriptions for the six heat levels. Supabase stores subscriptions and sends notifications after each successful scrape.

Deal alerts use high Web Push urgency because they always produce a time-sensitive, user-visible notification.
They request a 24-hour retention window so an alert delayed by an overnight Android Doze interval remains eligible for delivery, while preventing deals from arriving more than a day stale.

Apply the notification migrations, configure secrets, and deploy the function:

```powershell
supabase db push
supabase secrets set VAPID_PUBLIC_KEY="..." VAPID_PRIVATE_KEY="..." VAPID_SUBJECT="mailto:you@example.com" SCRAPE_DISPATCH_SECRET="..." SITE_ORIGIN="https://your-site.example"
supabase functions deploy notifications --no-verify-jwt
```

On iPhone and iPad, Web Push requires installing the site to the Home Screen.

## Deployment order

Use this order for a clean cutover without exposing a frontend that cannot retrieve data:

1. Pause the external ten-minute dispatcher.
2. Apply all Supabase migrations, including `202607180001_deal_data_publications.sql`.
3. Set `DEAL_DATA_PUBLISH_SECRET` in Supabase and deploy the `deal-data` function with JWT verification disabled. Deploy or update the notification function if needed.
4. Add the matching data-publication and notification secrets to GitHub Actions.
5. Add the public publication URL, snapshot base URL, publishable key, and notification values to Render.
6. Merge and deploy the clean-cutover code. This removes committed JSON, stops generated-data pushes, and switches the browser to pointer polling.
7. Manually dispatch the scrape workflow once. Confirm that private state exists, the pointer references a public immutable snapshot, and the frontend displays that snapshot. The first run has the clean-start velocity behavior described above.
8. Resume the external dispatcher at the ten-minute cadence and monitor the next run to confirm comparison-based velocity appears.

After the cutover, Render deploys only when application or configuration source changes. The scrape and data-publication cadence remains every ten minutes without consuming Render pipeline minutes.
