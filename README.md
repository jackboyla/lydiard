# Lydiard

A personal running companion: a **single-map training log** (Strava-style) plus a personalized
fatigue/injury-risk model, architected so **AI agents can natively query your training over any
period**. Runs free on Cloudflare with no always-on local machine.

## Architecture — "one synced store, three consumers"

```
Strava API (summary + polyline, then per-activity streams)
        │  Cron Trigger (every ~4h — cloud, no local machine)
        ▼
   Cloudflare Worker (Hono)  ──►  Cloudflare D1 (SQLite) = single source of truth
        │                          athlete · activities(+route) · activity_streams · weekly_features
        ├─► MapLibre map + dashboard  (Cloudflare Pages)
        ├─► Public REST API           (/api/*)
        └─► Agent API + /openapi.json (/api/agent/*, Bearer key)  →  ChatGPT Scheduled Tasks
```

The pure weekly derivation (`src/data/deriveWeekly.ts`) and fatigue model (`src/analysis/fatigue.ts`)
run in **both** the Worker and the browser.

## Features

- **Map-first UX:** every run's route on one MapLibre map (free dark tiles, no API key). Date-range
  presets, color routes by weekly fatigue / pace / recency, click a route for its detail card and
  the fatigue context of its week. A Dashboard toggle shows the full indicator/trend view.
- **Cloud sync:** a Cron Worker pulls Strava summary activities (with route polylines), then
  backfills full GPS + HR/cadence **streams** (rate-limit aware) and computes true first/second-half
  HR-pace decoupling.
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

Create a gitignored `.dev.vars` with `AGENT_API_KEY` and `STRAVA_CLIENT_SECRET` (see
[.env.example](.env.example)). To try it without Strava, seed fixture data:

```bash
npx tsx scripts/seed-fixture.ts > /tmp/seed.sql
npx wrangler d1 execute lydiard --local --file=/tmp/seed.sql
```

## Deploy (free tier)

Full steps in [docs/agent-api.md](docs/agent-api.md): `wrangler d1 create lydiard`, set secrets +
`[vars]`, `npm run worker:deploy`, deploy the frontend to Cloudflare Pages with `VITE_API_BASE`, and
visit `/auth/strava/login` once to connect.

## Verify

```bash
npm run build          # typecheck app + production bundle
npm run typecheck:worker
```

## Data direction

Strava OAuth is the primary source (quick official single-athlete path, and it returns route
polylines + streams). Garmin health/recovery import (HRV, sleep, stress) remains a later connector.
CSV import (`activities.csv` / Garmin CSV) is kept as a dashboard-only fallback (no routes) — see
[docs/real-data-import.md](docs/real-data-import.md).
