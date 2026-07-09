import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  CalendarDays,
  Gauge,
  Link2,
  Map as MapIcon,
  Menu,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  Unlink,
  X,
} from 'lucide-react';
import { analyzeWeeks, formatPace } from './analysis/fatigue';
import { IndicatorList } from './components/IndicatorList';
import { LoadStory } from './components/LoadStory';
import { MapView } from './components/MapView';
import { TrainingView, type TrainingJumpApi } from './components/TrainingView';
import { TrendPanel } from './components/TrendPanel';
import {
  getActivities,
  getActivity,
  getGymSessions,
  getSiteKey,
  getSyncStatus,
  getWeeks,
  disconnectStrava,
  setSiteKey,
  SiteUnauthorizedError,
  stravaLoginUrl,
  triggerSync,
} from './data/api';
import { parseActivityCsv } from './data/importActivities';
import { toWeekIdUtc, type ColorBy } from './data/mapRoutes';
import { sampleWeeks } from './data/sampleWeeks';
import type {
  ActivityDetail,
  ActivitySummary,
  GymSession,
  Severity,
  SyncStatus,
  TrendMetricKey,
  WeeklyRunBlock,
} from './types';

type RangePreset = '4w' | '12w' | '6mo' | '1y' | 'all';
type ViewMode = 'map' | 'training' | 'dashboard';

const RANGE_DAYS: Record<RangePreset, number> = {
  '4w': 28,
  '12w': 84,
  '6mo': 183,
  '1y': 365,
  all: Number.POSITIVE_INFINITY,
};

const RANGE_LABELS: Record<RangePreset, string> = {
  '4w': '4w',
  '12w': '12w',
  '6mo': '6mo',
  '1y': '1y',
  all: 'All',
};

const COLOR_OPTIONS: Array<{ key: ColorBy; label: string }> = [
  { key: 'severity', label: 'Fatigue' },
  { key: 'pace', label: 'Pace' },
  { key: 'recency', label: 'Recency' },
];

export default function App() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [apiWeeks, setApiWeeks] = useState<WeeklyRunBlock[]>([]);
  const [localWeeks, setLocalWeeks] = useState<WeeklyRunBlock[] | null>(null);
  const [activities, setActivities] = useState<ActivitySummary[]>([]);
  const [gymSessions, setGymSessions] = useState<GymSession[]>([]);
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [activityDetail, setActivityDetail] = useState<ActivityDetail | null>(null);
  const [banner, setBanner] = useState('');
  const [loadError, setLoadError] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  const [view, setView] = useState<ViewMode>('training');
  const [menuOpen, setMenuOpen] = useState(false);
  const [trainingJump, setTrainingJump] = useState<TrainingJumpApi | null>(null);
  const selectView = useCallback((next: ViewMode) => {
    setView(next);
    setMenuOpen(false);
  }, []);
  const [range, setRange] = useState<RangePreset>('12w');
  const [colorBy, setColorBy] = useState<ColorBy>('severity');
  const [metric, setMetric] = useState<TrendMetricKey>('stride');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const weeks = localWeeks ?? (apiWeeks.length >= 4 ? apiWeeks : sampleWeeks);
  const usingSample = !localWeeks && apiWeeks.length < 4;
  const analyses = useMemo(() => analyzeWeeks(weeks), [weeks]);
  const dataKey = `${localWeeks ? 'local' : 'api'}:${weeks.length}`;

  const severityByWeek = useMemo(() => {
    const map = new Map<string, Severity>();
    for (const analysis of analyses) {
      map.set(analysis.week.weekStart, analysis.severity);
    }
    return map;
  }, [analyses]);

  const safeSelectedIndex = Math.min(selectedIndex, analyses.length - 1);
  const selected = analyses[safeSelectedIndex];
  const selectedWeek = selected.week;
  const topIndicators = [...selected.indicators].sort((a, b) => b.score - a.score).slice(0, 3);
  const hasImportedHeartRate = selectedWeek.dataCompleteness?.heartRate ?? true;

  const filteredActivities = useMemo(
    () => filterActivitiesByRange(activities, range),
    [activities, range],
  );

  const loadData = useCallback(async () => {
    setLoadError('');
    try {
      const [nextStatus, nextWeeks, nextActivities, nextGym] = await Promise.all([
        getSyncStatus(),
        getWeeks(),
        getActivities(),
        getGymSessions().catch(() => [] as GymSession[]),
      ]);
      setStatus(nextStatus);
      setApiWeeks(nextWeeks);
      setActivities(nextActivities);
      setGymSessions(nextGym);
      setNeedsPassword(false);
      // Garmin data syncs via GitHub Actions; a stale "Strava is not connected"
      // error is irrelevant noise for a Garmin-sourced store, so don't surface it.
      const garminSourced =
        nextStatus.source === 'garmin-health-data' ||
        (!nextStatus.connected && (nextStatus.activityCount ?? 0) > 0);
      const stravaNoise = garminSourced && /strava/i.test(nextStatus.lastError ?? '');
      if (nextStatus.lastError && !stravaNoise) {
        setLoadError(formatSyncError(nextStatus.lastError));
      } else {
        setLoadError('');
      }
    } catch (error) {
      if (error instanceof SiteUnauthorizedError) {
        setNeedsPassword(true);
        setPasswordError(getSiteKey() ? 'That password was not accepted. Try again.' : '');
      } else {
        setLoadError(error instanceof Error ? error.message : 'Could not reach the training API.');
      }
    }
  }, []);

  const submitPassword = useCallback(
    async (value: string) => {
      setSiteKey(value.trim());
      setNeedsPassword(false);
      await loadData();
    },
    [loadData],
  );

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    setSelectedIndex(Math.max(0, analyses.length - 1));
  }, [dataKey, analyses.length]);

  // Fetch full detail (streams) for the selected activity.
  useEffect(() => {
    if (!selectedActivityId) {
      setActivityDetail(null);
      return;
    }
    let cancelled = false;
    getActivity(selectedActivityId)
      .then((detail) => {
        if (!cancelled) {
          setActivityDetail(detail);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setActivityDetail(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedActivityId]);

  // Handle the Strava OAuth return.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('strava') === 'connected') {
      window.history.replaceState(null, '', window.location.pathname);
      setBanner('Strava connected — your first sync is running. Data will appear shortly.');
      const timer = setTimeout(() => void loadData(), 4000);
      return () => clearTimeout(timer);
    }
    const stravaError = params.get('strava_error');
    if (stravaError) {
      window.history.replaceState(null, '', window.location.pathname);
      setLoadError(`Strava login failed: ${stravaError}`);
    }
  }, [loadData]);

  const handleSyncNow = useCallback(async () => {
    setIsSyncing(true);
    setBanner('Sync started — pulling new activities and streams.');
    try {
      await triggerSync();
      setTimeout(() => void loadData(), 5000);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Sync failed.');
    } finally {
      setIsSyncing(false);
    }
  }, [loadData]);

  const handleDisconnectStrava = useCallback(async () => {
    const confirmed = window.confirm(
      'Clear the stored Strava connection? Existing synced training rows will stay, but new syncs will require reconnecting Strava.',
    );
    if (!confirmed) {
      return;
    }
    try {
      await disconnectStrava();
      setBanner('Strava connection cleared. Reconnect after the Strava API app is active.');
      setLoadError('');
      await loadData();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not clear the Strava connection.');
    }
  }, [loadData]);

  const handleFileImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    try {
      const csvText = await file.text();
      const imported = parseActivityCsv(csvText, file.name);
      setLocalWeeks(imported.weeks);
      setBanner(`Loaded ${imported.weekCount} weeks from ${file.name} (dashboard only — CSV has no routes).`);
      setView('dashboard');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'The file could not be imported.');
    }
  };

  const athleteName = status?.athlete
    ? [status.athlete.firstname, status.athlete.lastname].filter(Boolean).join(' ')
    : '';
  const hasTrainingData = (status?.activityCount ?? 0) > 0;
  const isGarminSource = status?.source === 'garmin-health-data' || (!status?.connected && hasTrainingData);

  if (needsPassword) {
    return <PasswordGate error={passwordError} onSubmit={submitPassword} />;
  }

  return (
    <div className="app-shell map-first">
      <header className="topbar">
        <div className="brand">
          <span className="eyebrow">
            <Activity size={15} aria-hidden="true" />
            Running companion
          </span>
          <h1>Lydiard</h1>
        </div>

        <button
          className="topbar-menu-toggle"
          type="button"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls="topbar-controls"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
        </button>

        <div className={`topbar-controls${menuOpen ? ' open' : ''}`} id="topbar-controls">
          <div className="connection-chip" data-connected={status?.connected || isGarminSource ? 'true' : 'false'}>
            <Link2 size={15} aria-hidden="true" />
            {isGarminSource ? (
              <span>
                Garmin Health · {status?.activityCount ?? 0} runs · {status?.streamedCount ?? 0} streamed
                <small>{formatRelative(status?.lastSyncAt ?? null)}</small>
              </span>
            ) : status?.connected ? (
              <span>
                {athleteName || 'Strava'} · {status.activityCount} runs · {status.streamedCount} streamed
                <small>{formatRelative(status.lastSyncAt)}</small>
              </span>
            ) : (
              <a className="connect-link" href={stravaLoginUrl()}>
                Connect Strava
              </a>
            )}
          </div>

          {view === 'map' && (
            <>
              <Segmented
                ariaLabel="Route color"
                options={COLOR_OPTIONS.map((option) => ({ key: option.key, label: option.label }))}
                value={colorBy}
                onChange={(next) => setColorBy(next as ColorBy)}
              />

              <Segmented
                ariaLabel="Date range"
                options={(Object.keys(RANGE_DAYS) as RangePreset[]).map((key) => ({ key, label: RANGE_LABELS[key] }))}
                value={range}
                onChange={(next) => setRange(next as RangePreset)}
              />
            </>
          )}

          <div className="view-toggle" role="tablist" aria-label="View">
            <button
              role="tab"
              aria-selected={view === 'training'}
              className={view === 'training' ? 'active' : ''}
              type="button"
              onClick={() => selectView('training')}
            >
              <Activity size={16} aria-hidden="true" /> Training
            </button>
            <button role="tab" aria-selected={view === 'map'} className={view === 'map' ? 'active' : ''} type="button" onClick={() => selectView('map')}>
              <MapIcon size={16} aria-hidden="true" /> Map
            </button>
            <button role="tab" aria-selected={view === 'dashboard'} className={view === 'dashboard' ? 'active' : ''} type="button" onClick={() => selectView('dashboard')}>
              <Gauge size={16} aria-hidden="true" /> Dashboard
            </button>
          </div>

          {view === 'training' && trainingJump && trainingJump.months.length > 0 && (
            <label className="menu-jump">
              <span>
                <CalendarDays size={15} aria-hidden="true" />
                Jump to
              </span>
              <select
                aria-label="Jump to month"
                value=""
                onChange={(event) => {
                  const monthId = event.target.value;
                  if (monthId) {
                    trainingJump.jumpTo(monthId);
                    setMenuOpen(false);
                  }
                }}
              >
                <option value="">Month…</option>
                {groupMonthsByYear(trainingJump.months).map(([year, months]) => (
                  <optgroup key={year} label={year}>
                    {months.map((month) => (
                      <option key={month.id} value={month.id}>
                        {month.label} ({month.count})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          )}

          <button
            className="icon-button"
            type="button"
            aria-label="Sync now"
            title={isGarminSource ? 'Garmin sync runs twice daily from GitHub Actions' : 'Sync now'}
            disabled={isSyncing || !status?.connected}
            onClick={handleSyncNow}
          >
            <RefreshCw size={17} aria-hidden="true" className={isSyncing ? 'spin' : ''} />
          </button>
          {status?.connected && (
            <button
              className="icon-button"
              type="button"
              aria-label="Clear Strava connection"
              title="Clear Strava connection"
              onClick={handleDisconnectStrava}
            >
              <Unlink size={17} aria-hidden="true" />
            </button>
          )}
          <button className="icon-button" type="button" aria-label="Import CSV" title="Import activity CSV" onClick={() => fileInputRef.current?.click()}>
            <ArrowDownToLine size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      <input ref={fileInputRef} className="sr-only" type="file" accept=".csv,text/csv" onChange={handleFileImport} />

      {(banner || loadError) && (
        <div className={`app-banner ${loadError ? 'error' : ''}`} role="status">
          {loadError || banner}
        </div>
      )}

      {view === 'map' ? (
        <main className="map-stage">
          <MapView
            activities={filteredActivities}
            severityByWeek={severityByWeek}
            colorBy={colorBy}
            selectedId={selectedActivityId}
            onSelect={setSelectedActivityId}
          />

          {filteredActivities.length === 0 && (
            <div className="map-empty">
              <MapIcon size={28} aria-hidden="true" />
              <h2>{hasTrainingData ? 'No routes in this range' : 'Import Garmin data to see your routes'}</h2>
              <p>
                {hasTrainingData
                  ? 'Widen the date range or wait for the next scheduled Garmin sync. Routes with GPS appear here automatically.'
                  : 'The twice-daily Garmin import fills this map with every run. No local machine needed.'}
              </p>
              {!status?.connected && !hasTrainingData && (
                <a className="primary-button" href={stravaLoginUrl()}>
                  Connect Strava
                </a>
              )}
            </div>
          )}

          <aside className="side-rail">
            {activityDetail ? (
              <ActivityCard detail={activityDetail} severityByWeek={severityByWeek} onClose={() => setSelectedActivityId(null)} />
            ) : (
              <WeekSnapshot
                analysis={selected}
                colorBy={colorBy}
                routeCount={filteredActivities.filter((activity) => activity.summaryPolyline).length}
                usingSample={usingSample}
              />
            )}
          </aside>
        </main>
      ) : view === 'training' ? (
        <TrainingView
          activities={activities}
          analyses={usingSample ? [] : analyses}
          gymSessions={gymSessions}
          usingSample={usingSample}
          onJumpApi={setTrainingJump}
        />
      ) : (
        <main className="dashboard">
          <section className="overview-grid" aria-label="Current analysis">
            <article className={`risk-panel ${selected.severity}`}>
              <div className="risk-header">
                <div>
                  <p>Current week</p>
                  <h2>{selected.stateLabel}</h2>
                </div>
                <span>{selected.riskScore}</span>
              </div>
              <div className="risk-meter" aria-hidden="true">
                <span style={{ width: `${selected.riskScore}%` }} />
              </div>
              <p>{selected.summary}</p>
              <strong>{selected.recommendation}</strong>
            </article>

            <article className="baseline-panel">
              <div className="panel-title">
                <TrendingUp size={18} aria-hidden="true" />
                <span>Personal model</span>
              </div>
              <dl>
                <div>
                  <dt>Baseline</dt>
                  <dd>{selected.baselineWeeks.length} prior weeks</dd>
                </div>
                <div>
                  <dt>Week</dt>
                  <dd>{selectedWeek.label}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>
                    {usingSample
                      ? 'Sample history'
                      : isGarminSource
                        ? 'Garmin Health · D1'
                        : status?.connected
                          ? 'Strava · D1'
                          : 'CSV import'}
                  </dd>
                </div>
              </dl>
              <p>
                Scores compare this week against your own rolling distribution for stride, fixed-HR pace, threshold,
                decoupling, load, and recovery.
              </p>
            </article>

            <article className="fitness-panel">
              <div className="panel-title">
                <CalendarDays size={18} aria-hidden="true" />
                <span>Store coverage</span>
              </div>
              <div className="race-grid coverage-grid">
                <div className="race-tile">
                  <span>Activities</span>
                  <strong>{status?.activityCount ?? 0}</strong>
                  <small>{status?.streamedCount ?? 0} streamed</small>
                </div>
                <div className="race-tile">
                  <span>Weeks</span>
                  <strong>{status?.weekCount ?? weeks.length}</strong>
                  <small>rolling baseline</small>
                </div>
                <div className="race-tile">
                  <span>Latest</span>
                  <strong>{selectedWeek.label}</strong>
                  <small>{selectedWeek.year}</small>
                </div>
              </div>
              <p>{formatDateRange(status?.dateRange) || 'Run the Garmin import to populate the store.'}</p>
            </article>
          </section>

          <section className="metric-strip" aria-label="Selected week metrics">
            <MetricTile icon={<CalendarDays size={18} />} label="Volume" value={`${selectedWeek.distanceKm} km`} detail={`${selectedWeek.durationHours.toFixed(1)} h`} />
            <MetricTile icon={<Sparkles size={18} />} label="Easy pace" value={formatPace(selectedWeek.easyPaceSecPerKm)} detail={hasImportedHeartRate ? `${selectedWeek.easyHeartRate} bpm` : 'pace proxy'} />
            <MetricTile icon={<TrendingUp size={18} />} label="LT2 estimate" value={formatPace(selectedWeek.thresholdPaceSecPerKm)} detail="personal model" />
            <MetricTile icon={<ShieldAlert size={18} />} label="Top signal" value={topIndicators[0]?.label ?? 'None'} detail={topIndicators[0]?.deltaLabel ?? 'near baseline'} />
          </section>

          <IndicatorList indicators={selected.indicators} />

          <TrendPanel
            analyses={analyses}
            metric={metric}
            selectedIndex={safeSelectedIndex}
            onMetricChange={setMetric}
            onWeekSelect={setSelectedIndex}
          />

          <LoadStory analyses={analyses} />
        </main>
      )}
    </div>
  );
}

function filterActivitiesByRange(activities: ActivitySummary[], range: RangePreset): ActivitySummary[] {
  const days = RANGE_DAYS[range];
  if (!Number.isFinite(days) || activities.length === 0) {
    return activities;
  }
  const anchor = Math.max(...activities.map((activity) => new Date(activity.startDate).getTime()));
  const fromMs = anchor - days * 86400000;
  return activities.filter((activity) => new Date(activity.startDate).getTime() >= fromMs);
}

function formatRelative(iso: string | null): string {
  if (!iso) {
    return 'not synced yet';
  }
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.round(diff / 3600000);
  if (hours < 1) {
    return 'synced just now';
  }
  if (hours < 24) {
    return `synced ${hours}h ago`;
  }
  return `synced ${Math.round(hours / 24)}d ago`;
}

function formatDateRange(range?: { first: string | null; last: string | null }): string {
  if (!range?.first || !range.last) {
    return '';
  }
  const format = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  return `${format(range.first)} – ${format(range.last)}`;
}

function formatSyncError(error: string): string {
  if (/Application.*Status.*Inactive|Status.*Inactive|Application Status Inactive/i.test(error)) {
    return (
      'Last Strava sync failed because the Strava API app is inactive. Reactivate the app in Strava API settings ' +
      '(Standard Tier now requires active developer access/subscription), then reconnect Strava or sync again.'
    );
  }
  const message = error.length > 180 ? `${error.slice(0, 177)}...` : error;
  return `Last Strava sync failed: ${message}`;
}

function Segmented({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ key: string; label: string }>;
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className={value === option.key ? 'active' : ''}
          aria-pressed={value === option.key}
          onClick={() => onChange(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function WeekSnapshot({
  analysis,
  colorBy,
  routeCount,
  usingSample,
}: {
  analysis: ReturnType<typeof analyzeWeeks>[number];
  colorBy: ColorBy;
  routeCount: number;
  usingSample: boolean;
}) {
  const top = [...analysis.indicators].sort((a, b) => b.score - a.score)[0];
  return (
    <div className="snapshot-card">
      <div className="section-heading compact">
        <p>Latest week</p>
        <span>{analysis.week.label}</span>
      </div>
      <div className={`risk-badge ${analysis.severity}`}>
        <strong>{analysis.riskScore}</strong>
        <span>{analysis.stateLabel}</span>
      </div>
      <p className="snapshot-summary">{analysis.summary}</p>
      {top && (
        <div className="snapshot-signal">
          <span>Top signal</span>
          <strong>{top.label}</strong>
          <small>{top.deltaLabel}</small>
        </div>
      )}
      <div className="legend">
        <p>Routes colored by {colorBy === 'severity' ? 'weekly fatigue' : colorBy === 'pace' ? 'pace' : 'recency'}</p>
        {colorBy === 'severity' ? (
          <ul>
            <li><i style={{ background: '#22b982' }} /> Steady</li>
            <li><i style={{ background: '#f2c94c' }} /> Watch</li>
            <li><i style={{ background: '#ff5a66' }} /> High</li>
          </ul>
        ) : colorBy === 'pace' ? (
          <ul>
            <li><i style={{ background: '#38d996' }} /> Faster</li>
            <li><i style={{ background: '#ff5a66' }} /> Slower</li>
          </ul>
        ) : (
          <ul>
            <li><i style={{ background: '#3b4a5a' }} /> Older</li>
            <li><i style={{ background: '#38d996' }} /> Recent</li>
          </ul>
        )}
      </div>
      <p className="snapshot-foot">
        {routeCount} route{routeCount === 1 ? '' : 's'} on the map{usingSample ? ' · sample dashboard data' : ''}. Click a
        route for detail.
      </p>
    </div>
  );
}

function ActivityCard({
  detail,
  severityByWeek,
  onClose,
}: {
  detail: ActivityDetail;
  severityByWeek: Map<string, Severity>;
  onClose: () => void;
}) {
  const pace = detail.distanceKm > 0 ? detail.movingTimeSec / detail.distanceKm : 0;
  const severity = severityByWeek.get(toWeekIdUtc(detail.startDate));
  return (
    <div className="activity-card">
      <div className="activity-card-head">
        <div>
          <p>{formatActivityDate(detail.startDateLocal || detail.startDate)}</p>
          <h2>{detail.name}</h2>
        </div>
        <button className="icon-button ghost" type="button" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="activity-stats">
        <Stat label="Distance" value={`${detail.distanceKm.toFixed(1)} km`} />
        <Stat label="Time" value={formatDuration(detail.movingTimeSec)} />
        <Stat label="Pace" value={pace ? formatPace(pace) : '—'} />
        <Stat label="Avg HR" value={detail.averageHeartRate ? `${Math.round(detail.averageHeartRate)} bpm` : '—'} />
        <Stat label="Power" value={detail.averageWatts ? `${Math.round(detail.averageWatts)} W` : '—'} />
        <Stat label="Elev gain" value={`${Math.round(detail.elevationGainM)} m`} />
        <Stat label="Cadence" value={detail.averageCadenceSpm ? `${Math.round(detail.averageCadenceSpm)} spm` : '—'} />
        <Stat
          label="Decoupling"
          value={detail.decouplingPct !== undefined ? `${detail.decouplingPct.toFixed(1)}%` : detail.hasStreams ? '—' : 'pending'}
        />
        <Stat label="Sport" value={detail.sportType} />
      </div>
      {severity && (
        <p className={`activity-week-tag ${severity}`}>
          Part of a <strong>{severity}</strong> fatigue week
        </p>
      )}
      {!detail.hasStreams && <p className="activity-foot">Full GPS + HR streams backfill on the next cloud sync.</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PasswordGate({ error, onSubmit }: { error: string; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="password-gate">
      <form
        className="password-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) {
            onSubmit(value);
          }
        }}
      >
        <span className="eyebrow">
          <Activity size={15} aria-hidden="true" />
          Running companion
        </span>
        <h1>Lydiard</h1>
        <p>This training log is private. Enter the site password to continue.</p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Site password"
          aria-label="Site password"
        />
        {error && <p className="password-error">{error}</p>}
        <button type="submit" className="primary-button">
          Unlock
        </button>
      </form>
    </div>
  );
}

function MetricTile({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <article className="metric-tile">
      <span aria-hidden="true">{icon}</span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function formatActivityDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

// Group the (newest-first) month list into <optgroup> buckets by year, preserving order.
function groupMonthsByYear(months: TrainingJumpApi['months']): Array<[string, TrainingJumpApi['months']]> {
  const order: Array<[string, TrainingJumpApi['months']]> = [];
  const byYear = new Map<string, TrainingJumpApi['months']>();
  for (const month of months) {
    const year = month.id.slice(0, 4);
    let bucket = byYear.get(year);
    if (!bucket) {
      bucket = [];
      byYear.set(year, bucket);
      order.push([year, bucket]);
    }
    bucket.push(month);
  }
  return order;
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
