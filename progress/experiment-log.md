# Experiment log

## 2026-07-10—garmin-live-sync-diagnosis

### Intent

Determine the configured twice-daily Garmin schedule, verify the live workflow's health, and identify why the user's latest activity is absent.

### Environment

- Machine: `radiance-ws`
- GPUs used: none
- CUDA_VISIBLE_DEVICES: not applicable
- Git commit: `52e14ae1e9b51502a6d31c7e7a5b44b68c9a2ea2`
- Branch: `main`
- Python environment: not applicable
- Docker image, if applicable: not applicable

### Resource check before launch

Not applicable: this was a read-only GitHub Actions and Cloudflare D1 diagnosis, not a compute run.

### Commands

#### Diagnostics

```bash
date -u '+%Y-%m-%d %H:%M:%S UTC'
git remote -v
git log -1 --format='%H %cI %s'
gh auth status
gh workflow view garmin-sync.yml --yaml
gh run list --workflow garmin-sync.yml --limit 12 --json databaseId,status,conclusion,event,createdAt,startedAt,updatedAt,headSha,url,displayTitle
gh run view 29119507884 --json name,workflowName,conclusion,status,url,event,createdAt,startedAt,updatedAt,headSha,jobs
gh run view 29119507884 --log
gh variable list
git log -p --date=iso-strict -- .github/workflows/garmin-sync.yml
npx wrangler d1 execute lydiard --remote --command "SELECT COUNT(*) AS activities, MAX(start_date) AS latest_start FROM activities; SELECT last_sync_at, last_activity_date, last_result, last_error FROM sync_state WHERE id=1; SELECT id,name,start_date,start_date_local,distance_km,moving_time_s,updated_at FROM activities ORDER BY start_date DESC LIMIT 8;"
```

### Artifacts

- Logs: GitHub Actions run `29119507884`
- Checkpoints: not applicable
- Predictions: not applicable
- Metrics: 3,029 production runs; newest activity `2026-07-09T18:50:49.000Z`
- Eval summary: latest scheduled workflow completed successfully; production sync state advanced with no error
- GPU metrics: not applicable

### Result

Base: Current workflow cron is `20 6,18 * * *`.

Candidate: Live scheduled run `29119507884` started `2026-07-10T19:53:11Z` and completed `2026-07-10T19:57:30Z`.

Delta:

- Wins / losses: extraction, audit, run import, gym import, and cache save all succeeded; missing July 10 activity was absent from Garmin's activity-list response.
- Failure modes: GitHub scheduled dispatch was substantially later than the nominal cron; Garmin returned no activity-list file for July 10.
- GPU utilization: not applicable
- Memory usage: not applicable
- Runtime: 4 minutes 19 seconds

### Decision

Keep the current workflow unchanged. If immediate freshness is required, manually dispatch after confirming the activity is visible in Garmin Connect; otherwise wait for the next scheduled extraction.

### Notes

- Repeated-output diagnostics? No.
- GPU utilization or memory issue? No.
- Data issue? Upstream Garmin response did not include the missing activity.
- Code issue? No current evidence of one.
- Anything to change next? Consider monitoring schedule-delay/freshness separately if timely same-day updates are a requirement.

## 2026-07-10—analysis-chart-date-axis

### Intent

Verify that moving the CTL/ATL graph to Analysis and replacing categorical week labels with timestamp axes prevents same-month labels from different years being confused during horizontal hover.

### Environment

- Machine: `radiance-ws`
- GPUs used: none
- CUDA_VISIBLE_DEVICES: not applicable
- Git commit: `52e14ae1e9b51502a6d31c7e7a5b44b68c9a2ea2` plus working-tree candidate
- Branch: `main`
- Python environment: not applicable
- Docker image, if applicable: not applicable

### Resource check before launch

Not applicable: this was a browser UI evaluation, not a compute run.

### Commands

#### Diagnostics

```bash
npm run build
npx tsc --noEmit
git diff --check
node --input-type=module -e '<Playwright desktop/mobile chart ordering, hover, click, and overflow checks>'
```

### Artifacts

- Logs: terminal build and Playwright JSON output
- Checkpoints: not applicable
- Predictions: not applicable
- Metrics: 3 Analysis charts first; 0 Calendar CTL charts; 4 Calendar KPIs; 0 px desktop/mobile overflow
- Eval summary: horizontal samples resolved to distinct full dates in 2017, 2019, 2022, and 2025; historical click selected January 2018
- GPU metrics: not applicable

### Result

Base: Weekly charts used labels such as `1 Jun` as categorical x-axis values over 388 weeks, making the same month across years appear repeated and ambiguous.

Candidate: All Analysis charts use numeric UTC timestamps, year-qualified ticks, and full-date tooltips; CTL/ATL is first on Analysis and absent from Calendar.

Delta:

- Wins / losses: ambiguous historical month labels removed; chart order and click selection verified; no responsive overflow regression.
- Failure modes: expected initial 401 probes occur before the saved local site key is applied; authenticated data loads normally.
- GPU utilization: not applicable
- Memory usage: not measured
- Runtime: under 30 seconds per browser pass

### Decision

Keep the candidate.

### Notes

- Repeated-output diagnostics? Trend tooltip initially showed the same series twice because both Area and Line contributed; the Area tooltip was disabled and the final tooltip contains one value.
- GPU utilization or memory issue? No.
- Data issue? No.
- Code issue? Categorical display labels were not unique across years.
- Anything to change next? None for this request.
