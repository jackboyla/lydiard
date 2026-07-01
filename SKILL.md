# Skill: Analyze Jack's running training

Use the **Lydiard Training API** to analyze a single runner's training history and produce
injury-risk assessments and short-term training plans. The API reads a live store synced from
Strava (activities, per-week features, and a personalized fatigue model).

## Auth

Every `/api/agent/*` endpoint requires the API key. Two ways to send it:

- **In the URL (works in a normal chat):** append `?key=<AGENT_API_KEY>`.
- **As a header (Custom GPT Action / scripts):** `Authorization: Bearer <AGENT_API_KEY>`.

Replace `<AGENT_API_KEY>` with the key the user gives you. **Never print the key back to the user
or include it in your visible answer.**

Base URL: `https://lydiard.lydiard.workers.dev`

## Primary call — one request for the whole picture

```
GET https://lydiard.lydiard.workers.dev/api/agent/plan-context?key=<AGENT_API_KEY>
```

Optional `from` / `to` (`YYYY-MM-DD`) change the trend window; with no params it returns the last
12 weeks. The JSON contains:

- `current` — latest week's `riskScore` (0–100), `severity` (`steady`/`watch`/`high`), and
  `topIndicators` (each with `label`, `deltaLabel`, `score`, `severity`, `detail`).
- `loadStatus` — `acuteLoad`, `chronicLoad`, `acRatio`, and an `interpretation`.
- `summary` — totals for the window (distance, duration, avg weekly km, longest run).
- `weeklyTrend[]` — per week: distance, duration, trainingLoad, acRatio, easyPaceSecPerKm,
  thresholdPaceSecPerKm, hrPaceDecouplingPct, strideLengthCm, cadenceSpm, hrvMs, sleepHours,
  riskScore, severity, `streamsBacked`.
- `indicatorGuide` + `instructions` — how to read each signal.

## How to analyze (what the user wants)

1. **Injury risk.** Combine `current.riskScore`/`severity` with `loadStatus.acRatio`
   (≳1.4 = spike, classic risk) and any drift in `weeklyTrend`: falling `strideLengthCm`, rising
   `hrPaceDecouplingPct`, or slower `easyPaceSecPerKm` vs earlier weeks are the key warning signs.
   Everything is judged against the runner's OWN rolling baseline, not population norms.
2. **Plan the next 1–3 weeks.** Recommend target weekly volume (km), number of quality sessions,
   long-run distance, and recovery guidance. Progress conservatively when severity is `watch`/`high`
   and keep the acute/chronic ratio in a safe band (~0.8–1.3).

## Other endpoints (same `?key=` / Bearer auth)

- `GET /api/agent/risk?key=<KEY>[&asOf=YYYY-MM-DD]` — full fatigue analysis for one week.
- `GET /api/agent/weeks?key=<KEY>[&from=&to=]` — weekly feature rows.
- `GET /api/agent/activities?key=<KEY>[&from=&to=]` — per-activity metrics.

## Example task

> Fetch `https://lydiard.lydiard.workers.dev/api/agent/plan-context?key=<AGENT_API_KEY>`, assess my
> injury risk from the current-week risk score, the acute/chronic ratio, and stride/pace/decoupling
> drift, then give me a specific plan for the next 1–3 weeks (weekly km, quality sessions, long run,
> recovery).
