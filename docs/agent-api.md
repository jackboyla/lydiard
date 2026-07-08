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
| `POST /api/agent/sync` | Trigger a background Strava sync. |

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
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put AGENT_API_KEY        # generate a long random string
npx wrangler secret put SITE_PASSWORD        # password for the phone/desktop web app

# 4. Fill wrangler.toml [vars]: STRAVA_CLIENT_ID, STRAVA_REDIRECT_URI, APP_ORIGIN

# 5. Deploy the Worker (includes the web app, API, and every-4-hours cron sync)
npm run worker:deploy

# 6. Connect Strava once (stores the refresh token in D1, kicks off the first sync)
open https://lydiard.<your-subdomain>.workers.dev/auth/strava/login
```

In your Strava API app settings, set the **Authorization Callback Domain** to your Worker's host
(e.g. `lydiard.<your-subdomain>.workers.dev`).

The same `workers.dev` URL serves the app on desktop and phone. The cron keeps the store fresh with
no machine running at home; streams (full GPS + HR, and true HR-pace decoupling) backfill a batch
each cycle to stay within Strava's rate limits.

If sync returns `403 Application Status Inactive`, the Worker has reached Strava but Strava is
rejecting the API app. Check the API app owner account at `https://www.strava.com/settings/api`,
make sure the app's developer tier/status is active, and verify the callback domain. Once active,
sync again; if you changed client credentials, clear the stored Strava connection in the site header
and reconnect.

## Script ingest

External sync jobs can post normalized activities to `POST /api/ingest/activities` with
`Authorization: Bearer <INGEST_API_KEY>`. The experimental Garmin workflow uses this route after it
downloads and parses FIT files. The route upserts activities, stores streams, recomputes weekly
features, and updates sync status.

## Security notes

- Training data is private: `/api/agent/*` returns `401` without a valid Bearer key.
- Your Strava client secret and refresh token live only as Worker secrets / in D1 — never in the
  frontend bundle or in any agent-visible response.
- Rotate the key any time with `npx wrangler secret put AGENT_API_KEY`.
