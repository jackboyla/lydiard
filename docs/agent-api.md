# Agent API — query your training from ChatGPT (or any agent)

Lydiard's Cloudflare Worker serves both the phone-accessible web app and a small,
**API-key-secured** REST surface designed for AI agents. It reads the same D1 store the map,
training log, and dashboard use, so an agent can analyze any time period and produce injury-risk
assessments and 1–3 week training plans.

- **Base URL:** `https://lydiard.<your-subdomain>.workers.dev`
- **Auth:** every `/api/agent/*` call needs `Authorization: Bearer <AGENT_API_KEY>`
- **OpenAPI:** `GET /openapi.json` (no auth) — import this as a ChatGPT Custom GPT **Action**

## Endpoints

| Method + path | Purpose |
| --- | --- |
| `GET /api/agent/plan-context?from&to` | **Start here.** One bundle: latest-week risk, acute/chronic load status, a weekly trend, and planning instructions. |
| `GET /api/agent/risk?asOf` | Full fatigue analysis (risk score, severity, 6 indicators) for the latest week or the week at `asOf`. |
| `GET /api/agent/weeks?from&to` | Weekly training features for a date range. |
| `GET /api/agent/activities?from&to` | Per-activity metrics for a date range (no route geometry). |
| `POST /api/agent/sync` | Legacy Strava sync trigger. Scheduled Garmin updates run from GitHub Actions. |

`from` / `to` / `asOf` accept `YYYY-MM-DD`. Ranges are inclusive.

## Use it in ChatGPT (Scheduled Tasks)

**Option A — Custom GPT Action (most native).** In a Custom GPT → *Actions* → *Import from URL*,
paste `https://lydiard.<your-subdomain>.workers.dev/openapi.json`. Set Authentication to
*API Key → Bearer* and paste your `AGENT_API_KEY`. Then schedule a task with a prompt like:

> Every Monday at 7am, call `getPlanContext` for the last 12 weeks. Assess my injury risk from the
> current-week risk score, the acute/chronic ratio, and any stride-length / easy-pace / decoupling
> drift versus my own baselines. Then give me a specific plan for the next 1–3 weeks: target weekly
> km, number of quality sessions, long-run distance, and recovery guidance. Be conservative if
> severity is "watch" or "high".

**Option B — raw fetch in the task prompt.** If you'd rather not add an Action, tell the task:

> Fetch `https://lydiard.<your-subdomain>.workers.dev/api/agent/plan-context?from=2026-04-01`
> with header `Authorization: Bearer <YOUR_KEY>`. Using the returned JSON (current risk, load
> status, weekly trend), assess my injury risk and propose the next 1–3 weeks of training.

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

# 6. Configure GitHub Actions secrets for the twice-daily Garmin import:
#    GARMIN_USERNAME, GARMIN_PASSWORD, LYDIARD_INGEST_KEY
#    Optional repo vars: GARMIN_EXTRACT_START, GARMIN_EXTRACT_END, GARMIN_DATA_TYPES
```

The same `workers.dev` URL serves the app on desktop and phone. The cron keeps the store fresh with
no machine running at home; the GitHub workflow extracts Garmin data into SQLite, audits it, then
posts normalized runs and streams to the Worker. The default Garmin extraction window is the last 10
years of activity data (`ACTIVITIES_LIST` + `ACTIVITY`), with `GARMIN_EXTRACT_START` /
`GARMIN_EXTRACT_END` / `GARMIN_DATA_TYPES` available for override.

## Script ingest

External sync jobs can post normalized activities to `POST /api/ingest/activities` with
`Authorization: Bearer <INGEST_API_KEY>`. The Garmin workflow uses this route after
`garmin-health-data` downloads/processes Garmin Connect data into `garmin_data.db`. The route can
replace existing training rows, stores streams, recomputes weekly features, and updates sync status.

## Security notes

- Training data is private: `/api/agent/*` returns `401` without a valid Bearer key.
- Garmin credentials live in GitHub Secrets. The workflow cache stores `~/.garminconnect`,
  `garmin_data.db`, and `garmin_files` so scheduled runs can resume.
- Rotate the key any time with `npx wrangler secret put AGENT_API_KEY`.
