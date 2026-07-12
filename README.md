# Lydiard

A private running diary with a coach behind it: a Strava-style training log with direct activity
notes, all-time and seasonal best efforts, clear weekly progression, and an editable 1–3 week plan.
The deeper physiology and load models remain available without dominating the daily workflow. Runs
free on Cloudflare with no always-on local machine.

## Architecture — "one synced store, three consumers"

```
Garmin Connect
        │  local 10-year bootstrap, then GitHub Actions hourly incremental updates
        │  garmin-health-data → garmin_data.db → audit → ingest
        ▼
   Cloudflare Worker (Hono + static assets) ──► Cloudflare D1 (SQLite) = single source of truth
        │                          activities(+route/power) · activity_streams · weekly_features
        ├─► MapLibre map + training log + dashboard  (same workers.dev site, phone-accessible)
        ├─► Public REST API           (/api/*)
        └─► Agent API + /openapi.json (/api/agent/*, Bearer key)  →  ChatGPT Scheduled Tasks
```

The pure weekly derivation (`src/data/deriveWeekly.ts`) and fatigue model (`src/analysis/fatigue.ts`)
run in **both** the Worker and the browser.

## Features

- **Phone-accessible web app:** the built React app is deployed as Cloudflare Worker static assets
  on the same `workers.dev` host as the API, so there is no separate frontend server to run.
- **Three clear destinations:** Log answers what you did and how it felt, Progress shows how training
  is moving, and Plan shows what to do next. The URL preserves the current destination and activity.
- **Training log with notes:** the default page is a week-grouped run log. Open any run to add an
  activity-specific note, see its ordinary facts and route, then expand splits, zones, and load
  diagnostics only when useful.
- **Progress and personal bests:** one 12-week time/distance view, one consistent current-load read,
  and explicit All time / Season best-effort scopes for 1K through marathon.
- **One visible future plan:** the deterministic coach proposes an approval-gated 1–3 week block in
  the same Plan surface where sessions can be reviewed and edited. Legacy RUNMASTER rows remain in a
  collapsed provenance/day-note editor rather than competing with the current plan.
- **Route explorer:** the all-routes MapLibre view remains available under settings as a secondary
  tool, with fatigue / pace / recency coloring and range controls.
- **Cloud sync:** an hourly GitHub Action runs `garmin-health-data`, verifies the SQLite DB,
  audits coverage, and imports Garmin runs with full GPS + HR/cadence/power streams.
- **Agent-native:** a Bearer-key REST API + OpenAPI schema for ChatGPT to assess injury risk and
  plan the next 1–3 weeks. See [docs/agent-api.md](docs/agent-api.md).
- **Personalized:** all signals compare each week to the runner's own rolling baselines.
- **Stateful Lydiard coach:** date-effective Stryd Critical Power, evidence-backed CS/CP and LT1/LT2
  bands, power-first load with separate HR cost, coherent future blocks, post-run feedback, and an
  audit trail live behind the simple recommendation and plan workflow.

## Run locally

```bash
npm install

# Terminal 1 — Worker + local D1 (http://localhost:8787)
npm run d1:migrate:local          # first time only
npm run worker:dev

# Terminal 2 — frontend (http://localhost:5173, proxies /api to the Worker)
npm run dev
```

Create a gitignored `.dev.vars` with `AGENT_API_KEY`, `STRAVA_CLIENT_SECRET`, and local OAuth
overrides (see [.env.example](.env.example)). For local Strava login, your Strava app's
Authorization Callback Domain must allow `localhost`, then visit
`http://localhost:5173/auth/strava/login` or click **Connect Strava** in the app.

To try the UI without Strava, seed fixture data. These rows are fake test runs and should be cleared
before validating your real training:

```bash
npx tsx scripts/seed-fixture.ts > /tmp/seed.sql
npx wrangler d1 execute lydiard --local --file=/tmp/seed.sql

# clear local fixture data
npx wrangler d1 execute lydiard --local --command "DELETE FROM activity_streams; DELETE FROM weekly_features; DELETE FROM activities; DELETE FROM athlete; UPDATE sync_state SET last_sync_at=NULL, last_activity_date=NULL, last_result=NULL, last_error=NULL, rate_limit=NULL WHERE id=1;"
```

## Deploy (free tier)

Full steps in [docs/agent-api.md](docs/agent-api.md): `wrangler d1 create lydiard`, set secrets +
`[vars]`, `npm run d1:migrate`, `npm run worker:deploy`, then configure the Garmin GitHub Actions
secrets and visit the `workers.dev` URL on desktop or phone.

## Verify

```bash
npm run build          # typecheck app + production bundle
npm run typecheck:worker
npm run coach:smoke    # deterministic physiology/load/plan/adaptation invariants
npm run product:smoke  # Log/notes/PBs/Plan mobile journey against the local Worker
```

## Strava app inactive

If the site shows `Application Status Inactive`, Cloudflare and the site password are working; Strava
is rejecting the API application. Check `https://www.strava.com/settings/api` while logged in as the
account that owns the app, confirm the developer tier/app status is active, and confirm the
Authorization Callback Domain matches the deployed Worker host (`lydiard.lydiard.workers.dev` for
this app). After reactivation, click sync again. If you changed the Strava app/client credentials,
use the header unlink button to clear the stored connection, then connect Strava again.

## Garmin health-data automation

The Garmin path now uses [`garmin-health-data`](https://github.com/diegoscarabelli/garmin-health-data)
as the local extractor. That CLI downloads Garmin Connect data into `garmin_data.db` plus
`garmin_files/storage/`; Lydiard reads that SQLite database, audits it, and imports running activities
with route, HR, cadence, speed, distance, altitude, and power streams into the Worker ingest endpoint.

Do the initial long historical bootstrap locally. A 10-year Garmin extract can exceed GitHub Actions'
60-minute job limit, and a short GitHub cache should not be allowed to replace the full D1 history.

```bash
pip install garmin-health-data
garmin auth

START_DATE="$(python3 -c 'from datetime import date; d=date.today(); print(d.replace(year=d.year-10) if not (d.month == 2 and d.day == 29) else d.replace(year=d.year-10, day=28))')"
END_DATE="$(python3 -c 'from datetime import date, timedelta; print(date.today() + timedelta(days=1))')"
garmin extract --start-date "$START_DATE" --end-date "$END_DATE" \
  --data-types ACTIVITIES_LIST --data-types ACTIVITY
npm run garmin:audit
LYDIARD_INGEST_KEY='...' \
LYDIARD_BASE_URL=https://lydiard.lydiard.workers.dev \
npm run garmin:import-db -- --no-replace --batch-size 20
```

The importer uses Node's built-in SQLite support, batches uploads (`--batch-size`, default 25), and
asks the Worker to recompute weekly features only on the final batch. For an already-live site, use
`--no-replace` for the historical
bootstrap so a failed midway upload cannot wipe the recent production rows. Omitting `--no-replace`
is only appropriate when you intentionally want the first batch to clear all existing training data.

The repository includes `.github/workflows/garmin-sync.yml` to run hourly at minute 17 after the
bootstrap. Normal hourly polls ask Garmin for the last 7 days of activity data (`ACTIVITIES_LIST` +
`ACTIVITY` FIT files); the 06:17 UTC run reconciles the last 45 days. Both import with
`--no-replace`, so they can upsert new/recent activities without wiping older history. Set repository
variable `GARMIN_INCREMENTAL_DAYS` to override both rolling windows, set
`GARMIN_EXTRACT_START` and/or `GARMIN_EXTRACT_END` to override the exact range for a one-off run, and
set `GARMIN_DATA_TYPES` to change the comma-separated `garmin-health-data` data types. The workflow
restores/caches `~/.garminconnect`, `garmin_data.db`, and `garmin_files` so `garmin extract` can
resume instead of repeatedly re-authenticating and redownloading recent data. After each successful
run it removes superseded Garmin caches, keeping the newest resumable snapshot. Required GitHub secrets:

- `GARMIN_USERNAME`
- `GARMIN_PASSWORD`
- `LYDIARD_INGEST_KEY`

The ingest key is already configured as the Cloudflare Worker secret `INGEST_API_KEY` and as the
GitHub secret `LYDIARD_INGEST_KEY` for this repo. The generated Garmin DB/files are ignored by git
because they contain private health and route data. The GitHub Actions cache will still hold those
artifacts for scheduled automation.

The website's refresh button can also dispatch this workflow immediately. Configure a fine-grained
GitHub token restricted to this repository with **Actions: read and write**, then store it only as a
Worker secret:

```bash
npx wrangler secret put GITHUB_SYNC_TOKEN
```

`GITHUB_SYNC_REPOSITORY`, `GITHUB_SYNC_WORKFLOW`, and `GITHUB_SYNC_REF` are non-secret Worker vars in
`wrangler.toml`. The endpoint remains behind `SITE_PASSWORD`; it refuses to dispatch if that password
is not configured.

## Data direction

Garmin health-data is now the primary source for the training log. Strava OAuth remains in the code as
a fallback/manual connector, but scheduled updates come from the Garmin SQLite import. Garmin
health/recovery tables are audited; if Garmin returns empty sleep, HRV, stress, body battery, VO2 max,
or readiness tables, Lydiard does not pretend those recovery signals exist.
CSV import (`activities.csv` / Garmin CSV) is kept as a dashboard-only fallback (no routes) — see
[docs/real-data-import.md](docs/real-data-import.md).

## Import a legacy RUNMASTER plan

Place private Google Sheet CSV exports in the gitignored `tmp/` directory, then preflight and import:

```bash
npm run plan:import -- --dry-run
LYDIARD_INGEST_KEY='...' npm run plan:import -- --validate
LYDIARD_INGEST_KEY='...' npm run plan:import
```

The deployed Worker is the default destination; set `LYDIARD_BASE_URL=http://localhost:8787` for
local D1. The importer preserves Planned/Notes cell text, ignores spreadsheet total rows, and refuses
to write when a legacy Actual duration cannot be matched to same-local-date Garmin runs. See
[docs/real-data-import.md](docs/real-data-import.md#manual-training-plan-csv).
