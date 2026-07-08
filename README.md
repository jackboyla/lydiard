# Lydiard

A personal running companion: a **single-map training log** (Strava-style), a one-view training
history, plus a personalized fatigue/injury-risk model, architected so **AI agents can natively
query your training over any period**. Runs free on Cloudflare with no always-on local machine.

## Architecture — "one synced store, three consumers"

```
Garmin Connect
        │  GitHub Actions twice daily: garmin-health-data → garmin_data.db → audit → ingest
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
- **Map-first UX:** every run's route on one MapLibre map (free dark tiles, no API key). Date-range
  presets, color routes by weekly fatigue / pace / recency, click a route for its detail card and
  the fatigue context of its week. A Dashboard toggle shows the full indicator/trend view.
- **Training view:** last-N-month fitness/fatigue chart plus per-run HR, power when recorded, and
  projected easy pace.
- **Cloud sync:** a twice-daily GitHub Action runs `garmin-health-data`, verifies the SQLite DB,
  audits coverage, and imports Garmin runs with full GPS + HR/cadence/power streams.
- **Agent-native:** a Bearer-key REST API + OpenAPI schema for ChatGPT to assess injury risk and
  plan the next 1–3 weeks. See [docs/agent-api.md](docs/agent-api.md).
- **Personalized:** all signals compare each week to the runner's own rolling baselines.

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

```bash
pip install garmin-health-data
garmin auth
garmin extract
npm run garmin:audit
LYDIARD_INGEST_KEY='...' \
LYDIARD_BASE_URL=https://lydiard.lydiard.workers.dev \
npm run garmin:import-db
```

The repository includes `.github/workflows/garmin-sync.yml` to run this twice daily. The workflow
restores/caches `~/.garminconnect`, `garmin_data.db`, and `garmin_files` so `garmin extract` can
resume instead of repeatedly re-authenticating and redownloading the whole range. Required GitHub
secrets:

- `GARMIN_USERNAME`
- `GARMIN_PASSWORD`
- `LYDIARD_INGEST_KEY`

The ingest key is already configured as the Cloudflare Worker secret `INGEST_API_KEY` and as the
GitHub secret `LYDIARD_INGEST_KEY` for this repo. The generated Garmin DB/files are ignored by git
because they contain private health and route data. The GitHub Actions cache will still hold those
artifacts for scheduled automation.

## Data direction

Garmin health-data is now the primary source for the training log. Strava OAuth remains in the code as
a fallback/manual connector, but scheduled updates come from the Garmin SQLite import. Garmin
health/recovery tables are audited; if Garmin returns empty sleep, HRV, stress, body battery, VO2 max,
or readiness tables, Lydiard does not pretend those recovery signals exist.
CSV import (`activities.csv` / Garmin CSV) is kept as a dashboard-only fallback (no routes) — see
[docs/real-data-import.md](docs/real-data-import.md).
