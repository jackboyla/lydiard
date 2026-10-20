# Agent API — query your training from ChatGPT (or any agent)

Lydiard's Cloudflare Worker serves both the phone-accessible web app and a small,
**API-key-secured** REST surface designed for AI agents. It reads the same D1 store the map,
training log, and dashboard use, so an agent can analyze any time period, discuss a plan, and publish
an agreed 1–12 week training plan into the same Plan section used by the web app.

- **Base URL:** `https://lydiard.<your-subdomain>.workers.dev`
- **Auth:** every `/api/agent/*` call needs `Authorization: Bearer <AGENT_API_KEY>`
- **OpenAPI:** `GET /openapi.json` (no auth) — import this as a ChatGPT Custom GPT **Action**

## Endpoints

| Method + path | Purpose |
| --- | --- |
| `GET /api/agent/plan-context?from&to` | **Start here.** One bundle: latest-week risk, acute/chronic load status, a weekly trend, and planning instructions. |
| `GET /api/agent/coach-context?asOf&weekStart&lookbackDays&horizonWeeks` | **Authoritative coach state.** Goals/constraints, physiology and confidence, current/future sessions, recent training responses, and pending adaptations. `horizonWeeks` supports 1–12. |
| `GET /api/agent/expert-wisdom?source=all` | Read the version-controlled Scullion and Magness principle files. `source` may be `all`, `scullion`, or `magness`. |
| `GET /api/agent/planned-sessions?from&to` | Read full execution detail for one existing plan week. The inclusive range is capped at seven dates to stay within GPT Action response limits. |
| `GET /api/agent/risk?asOf` | Full fatigue analysis (risk score, severity, 6 indicators) for the latest week or the week at `asOf`. |
| `GET /api/agent/weeks?from&to` | Weekly training features for a date range. |
| `GET /api/agent/activities?from&to` | Per-activity metrics for a date range (no route geometry). |
| `GET /api/agent/activities/{id}` | One run plus compact source-device laps for detailed session/rep review. |
| `POST /api/agent/plans` | Publish a conversationally agreed, fully structured 1–12 week plan. This is explicitly consequential and writes accepted sessions into Plan. |
| `POST /api/agent/sync` | Legacy Strava sync trigger. Scheduled Garmin updates run from GitHub Actions. |

`from` / `to` / `asOf` accept `YYYY-MM-DD`. Ranges are inclusive.

## Use it in a Custom GPT

**Option A — Custom GPT Action (most native).** In a Custom GPT → *Actions* → *Import from URL*,
paste `https://lydiard.<your-subdomain>.workers.dev/openapi.json`. Set Authentication to
*API Key → Bearer* and paste your `AGENT_API_KEY`. Re-import the schema after deploying endpoint
changes. The publish operation is marked consequential, so ChatGPT asks for confirmation before it
writes.

Add instructions along these lines to the GPT:

> For planning, first call `getExpertWisdom` and `getCoachContext`, setting `horizonWeeks` to the
> number of weeks I requested. Ground recommendations in my saved goal and constraints, current
> physiology/confidence, recent weeks, recent run responses, feedback, and existing future plan.
> Apply Scullion and Magness as principles rather than copying elite or context-specific examples.
> Discuss the proposal with me and revise it conversationally. Do not call `publishTrainingPlan`
> until I explicitly agree to save the plan. Every run must have a date, duration, optional distance
> and evidence-supported targets, ordered warm-up/main-set/recovery/cool-down steps, intent, why it
> belongs now, fallback, and clear rules for adjusting it based on fatigue, pain, conditions, or the
> preceding training response. On publication, use the profile version and context timestamp from
> `getCoachContext` plus a new stable request ID. If publication returns a profile conflict, refresh
> context, explain what changed, and revise before asking to save again.

The GPT-facing coach context is compact by design so a production response stays below ChatGPT
Actions' 100,000-character payload limit. It preserves goals, profile version, physiology, recent
weeks/runs/responses, load, constraints, future-session summaries, and decision summaries. When a
conversation needs the exact steps of an already stored workout, call `getPlannedSessions` for that
single week rather than asking for the entire multi-week plan in one response.

This keeps the conversation in ChatGPT while the API provides fresh evidence, source material, strict
validation, idempotency, an audit record, and the final write into Plan. A publication supersedes only
overlapping active future sessions; completed, skipped, cancelled, and historical records are retained.

**Option B — raw fetch in the task prompt.** If you'd rather not add an Action, tell the task:

> Fetch `https://lydiard.<your-subdomain>.workers.dev/api/agent/plan-context?from=2026-04-01`
> with header `Authorization: Bearer <YOUR_KEY>`. Using the returned JSON (current risk, load
> status, weekly trend), assess my injury risk and propose the next few weeks of training.

## One-time setup

```bash
# 1. Create the D1 database and paste its id into wrangler.toml
npx wrangler d1 create lydiard

# 2. Apply the schema
npm run d1:migrate            # remote (production)

# 3. Set secrets
npx wrangler secret put AGENT_API_KEY        # generate a long random string
npx wrangler secret put SITE_PASSWORD        # password for the phone/desktop web app
npx wrangler secret put INGEST_API_KEY       # used by the Garmin GitHub Action

# 4. Fill wrangler.toml [vars]: APP_ORIGIN

# 5. Deploy the Worker (includes the web app, API, and ingest endpoint)
npm run worker:deploy

# 6. Configure GitHub Actions secrets for the hourly Garmin import:
#    GARMIN_USERNAME, GARMIN_PASSWORD, LYDIARD_INGEST_KEY
#    Optional repo vars: GARMIN_INCREMENTAL_DAYS, GARMIN_EXTRACT_START,
#    GARMIN_EXTRACT_END, GARMIN_DATA_TYPES

# 7. Optional but required for the website's "Sync now" button:
#    Create a fine-grained GitHub token scoped only to this repository with
#    Actions: read/write, then store it as a Worker secret.
npx wrangler secret put GITHUB_SYNC_TOKEN
```

The same `workers.dev` URL serves the app on desktop and phone. The cron keeps the store fresh with
no machine running at home; the GitHub workflow extracts Garmin data into SQLite, audits it, then
posts normalized runs and streams to the Worker. Do the first 10-year Garmin bootstrap locally, then
let GitHub Actions run incremental updates. Normal hourly polls use a 7-day activity window and the
06:17 UTC poll performs a 45-day reconciliation (`ACTIVITIES_LIST` + `ACTIVITY`); all imports use
`--no-replace`. The website can dispatch the same workflow on demand when `GITHUB_SYNC_TOKEN` is set,
with
`GARMIN_INCREMENTAL_DAYS` / `GARMIN_EXTRACT_START` / `GARMIN_EXTRACT_END` / `GARMIN_DATA_TYPES`
available for override.

For coaching questions, prefer `coach-context` over reconstructing zones or a plan from raw activities.
The deterministic in-app generator still creates conservative one-to-three-week proposals. The Custom
GPT can discuss and publish up to twelve weeks, and the Plan UI requests that full horizon. Later weeks
should remain contingent on earlier training being absorbed; detailed per-session adaptation guidance
is displayed alongside the workout steps, intent, fallback, and reasoning.

## Script ingest

External sync jobs can post normalized activities to `POST /api/ingest/activities` with
`Authorization: Bearer <INGEST_API_KEY>`. The Garmin workflow uses this route after
`garmin-health-data` downloads/processes Garmin Connect data into `garmin_data.db`. The route can
replace existing training rows for a full local bootstrap, or upsert without replacement for
scheduled incremental updates. It stores streams, recomputes weekly features, and updates sync
status. The Garmin importer sends one activity per request to stay within the free Worker CPU limit.
Use `npm run garmin:import-db -- --no-replace` for incremental or historical imports; intermediate
requests skip weekly recomputation and the final request refreshes the derived weekly features.
Larger `--batch-size` values require enough Worker CPU budget.

## Security notes

- Training data is private: `/api/agent/*` returns `401` without a valid Bearer key.
- Garmin credentials live in GitHub Secrets. The workflow cache stores `~/.garminconnect`,
  `garmin_data.db`, and `garmin_files` so scheduled runs can resume.
- Rotate the key any time with `npx wrangler secret put AGENT_API_KEY`.
