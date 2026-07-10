import { type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  CalendarDays,
  ClipboardList,
  Gauge,
  Home,
  Link2,
  Map as MapIcon,
  Menu,
  MoreHorizontal,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  Unlink,
  UserRound,
  X,
} from 'lucide-react';
import { analyzeWeeks, formatPace } from './analysis/fatigue';
import {
  buildTrainingLoadModel,
  type SessionLoad,
  type TrainingLoadModel,
  type WeekLoadSummary,
} from './analysis/loadModel';
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
  WeeklyAnalysis,
  WeeklyRunBlock,
} from './types';

type RangePreset = '4w' | '12w' | '6mo' | '1y' | 'all';
type ViewMode = 'home' | 'fitness' | 'plan' | 'analysis' | 'calendar' | 'map';
type MobileNavKey = 'home' | 'fitness' | 'plan' | 'analysis' | 'calendar' | 'more';

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

  const [view, setView] = useState<ViewMode>('home');
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState<MobileNavKey>('home');
  const [trainingJump, setTrainingJump] = useState<TrainingJumpApi | null>(null);
  const selectView = useCallback((next: ViewMode) => {
    setView(next);
    setMenuOpen(false);
    setMobileNav(next === 'map' ? 'more' : next);
  }, []);
  const selectMobileNav = useCallback((next: MobileNavKey) => {
    if (next === 'more') {
      setMobileNav('more');
      setMenuOpen((open) => !open);
      return;
    }
    setMobileNav(next);
    setMenuOpen(false);
    setView(next);
  }, []);
  const [range, setRange] = useState<RangePreset>('12w');
  const [colorBy, setColorBy] = useState<ColorBy>('severity');
  const [metric, setMetric] = useState<TrendMetricKey>('stride');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const weeks = localWeeks ?? (apiWeeks.length >= 4 ? apiWeeks : sampleWeeks);
  const usingSample = !localWeeks && apiWeeks.length < 4;
  const analyses = useMemo(() => analyzeWeeks(weeks), [weeks]);
  const loadModel = useMemo(() => buildTrainingLoadModel(activities), [activities]);
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
      setBanner(`Loaded ${imported.weekCount} weeks from ${file.name} (analysis only - CSV has no routes).`);
      setView('analysis');
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

          <button className="mobile-more-map" type="button" onClick={() => selectView('map')}>
            <MapIcon size={16} aria-hidden="true" />
            Open map
          </button>

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

          <div className="view-toggle product-view-toggle" role="tablist" aria-label="View">
            <button
              role="tab"
              aria-selected={view === 'home'}
              className={view === 'home' ? 'active' : ''}
              type="button"
              onClick={() => selectView('home')}
            >
              <Home size={16} aria-hidden="true" /> Home
            </button>
            <button role="tab" aria-selected={view === 'fitness'} className={view === 'fitness' ? 'active' : ''} type="button" onClick={() => selectView('fitness')}>
              <UserRound size={16} aria-hidden="true" /> Fitness
            </button>
            <button role="tab" aria-selected={view === 'plan'} className={view === 'plan' ? 'active' : ''} type="button" onClick={() => selectView('plan')}>
              <ClipboardList size={16} aria-hidden="true" /> Plan
            </button>
            <button role="tab" aria-selected={view === 'analysis'} className={view === 'analysis' ? 'active' : ''} type="button" onClick={() => selectView('analysis')}>
              <TrendingUp size={16} aria-hidden="true" /> Analysis
            </button>
            <button role="tab" aria-selected={view === 'calendar'} className={view === 'calendar' ? 'active' : ''} type="button" onClick={() => selectView('calendar')}>
              <CalendarDays size={16} aria-hidden="true" /> Calendar
            </button>
            <button role="tab" aria-selected={view === 'map'} className={view === 'map' ? 'active' : ''} type="button" onClick={() => selectView('map')}>
              <MapIcon size={16} aria-hidden="true" /> Map
            </button>
          </div>

          {view === 'calendar' && trainingJump && trainingJump.months.length > 0 && (
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

      {view === 'home' ? (
        <HomeView loadModel={loadModel} gymSessions={gymSessions} status={status} isLoading={!status && activities.length === 0} />
      ) : view === 'fitness' ? (
        <FitnessView loadModel={loadModel} analyses={usingSample ? [] : analyses} status={status} />
      ) : view === 'plan' ? (
        <PlanView loadModel={loadModel} />
      ) : view === 'map' ? (
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
      ) : view === 'calendar' ? (
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

      <MobileBottomNav active={menuOpen ? 'more' : mobileNav} onSelect={selectMobileNav} />
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

function MobileBottomNav({ active, onSelect }: { active: MobileNavKey; onSelect: (next: MobileNavKey) => void }) {
  const items: Array<{ key: MobileNavKey; label: string; icon: ReactNode }> = [
    { key: 'home', label: 'Home', icon: <Home size={24} aria-hidden="true" /> },
    { key: 'fitness', label: 'Fitness', icon: <UserRound size={24} aria-hidden="true" /> },
    { key: 'plan', label: 'Plan', icon: <ClipboardList size={24} aria-hidden="true" /> },
    { key: 'analysis', label: 'Analysis', icon: <TrendingUp size={24} aria-hidden="true" /> },
    { key: 'calendar', label: 'Calendar', icon: <CalendarDays size={24} aria-hidden="true" /> },
    { key: 'more', label: 'More', icon: <MoreHorizontal size={24} aria-hidden="true" /> },
  ];

  return (
    <nav className="mobile-bottom-nav" aria-label="Primary">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={active === item.key ? 'active' : ''}
          aria-current={active === item.key ? 'page' : undefined}
          onClick={() => onSelect(item.key)}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function HomeView({
  loadModel,
  gymSessions,
  status,
  isLoading,
}: {
  loadModel: TrainingLoadModel;
  gymSessions: GymSession[];
  status: SyncStatus | null;
  isLoading: boolean;
}) {
  const latestSession = lastItem(loadModel.sessions);
  const latestWeek = lastItem(loadModel.weeks);
  const latestDaily = lastItem(loadModel.daily);
  const recentSessions = [...loadModel.sessions].reverse().slice(0, 4);
  const read = isLoading && !latestSession
    ? { status: 'Loading', tone: 'muted', summary: 'Loading your Garmin training history.' }
    : trainingRead(latestWeek, latestSession);
  const recentWeeks = loadModel.weeks.slice(-12);
  const maxWeekLoad = Math.max(1, ...recentWeeks.map((week) => week.load));
  const latestEmptyLabel = isLoading ? 'Loading runs' : 'No run yet';

  return (
    <main className="product-page home-view">
      <section className="product-hero">
        <p className="eyebrow">Training dashboard</p>
        <h2>What your training is building.</h2>
        <p>Based on your recent training, current proof, and the next best step.</p>
        <span className={`product-pill tone-${read.tone}`}>{read.status}</span>
      </section>

      <section className="home-grid">
        <article className="product-card dark-card latest-activity-card">
          <header>
            <span>Latest activity</span>
            <small>{latestSession ? formatActivityDate(latestSession.activity.startDateLocal || latestSession.activity.startDate) : latestEmptyLabel}</small>
          </header>
          <h3>{latestSession ? classifyProductSession(latestSession).label : isLoading ? 'Loading training' : 'No run yet'}</h3>
          {latestSession ? (
            <>
              <div className="product-stat-row">
                <Stat label="Distance" value={`${latestSession.activity.distanceKm.toFixed(1)} km`} />
                <Stat label="Time" value={formatDuration(latestSession.activity.movingTimeSec)} />
                <Stat label="Avg pace" value={formatPace(latestSession.paceSecPerKm)} />
                <Stat label="Avg HR" value={latestSession.activity.averageHeartRate ? `${Math.round(latestSession.activity.averageHeartRate)} bpm` : '-'} />
              </div>
              <div className="coach-read">
                <span>Coach read</span>
                <p>{classifyProductSession(latestSession).coach}</p>
              </div>
            </>
          ) : (
            <p>{isLoading ? 'Fetching your synced run rows.' : 'No Garmin run rows are available yet.'}</p>
          )}
        </article>

        <article className="product-card week-status-card">
          <header>
            <span>This week</span>
            <small>{latestWeek?.label ?? 'No week'}</small>
          </header>
          <h3>{latestWeek ? `${latestWeek.distanceKm.toFixed(1)} km` : '-'}</h3>
          <div className="product-stat-row compact">
            <Stat label="Runs" value={latestWeek ? String(latestWeek.activityCount) : '-'} />
            <Stat label="Avg pace" value={latestWeek ? formatWeekPace(latestWeek) : '-'} />
            <Stat label="Avg HR" value={formatWeekHr(latestWeek)} />
            <Stat label="Load" value={read.status} />
          </div>
          <p className="runzones-read">
            <strong>Lydiard read</strong> {read.summary}
          </p>
        </article>
      </section>

      <section className="product-card latest-sessions-panel">
        <header>
          <span>Recent · latest sessions</span>
          <small>{status?.activityCount ?? loadModel.sessions.length} runs stored</small>
        </header>
        <div className="session-card-row">
          {recentSessions.length > 0 ? (
            recentSessions.map((session) => (
              <SessionMiniCard key={session.activity.id} session={session} />
            ))
          ) : (
            <p className="product-empty-note">{isLoading ? 'Loading recent sessions...' : 'No recent sessions yet.'}</p>
          )}
        </div>
      </section>

      <section className="product-card load-preview-panel">
        <header>
          <span>Training load · 12 week context</span>
          <strong>{latestWeek ? `${latestWeek.load.toFixed(1)} load` : '-'}</strong>
        </header>
        <div className="mini-load-bars" aria-label="Last 12 weeks of load">
          {recentWeeks.map((week) => (
            <span key={week.weekId} title={`${week.label}: ${week.load.toFixed(1)}`} style={{ height: `${Math.max(8, (week.load / maxWeekLoad) * 100)}%` }} />
          ))}
        </div>
        <p>{latestDaily ? `Freshness ${latestDaily.freshness.toFixed(1)} · fatigue ${latestDaily.fatigue.toFixed(1)} · fitness ${latestDaily.fitness.toFixed(1)}.` : 'Load builds after runs are synced.'}</p>
      </section>

      <section className="product-card performance-profile-panel">
        <header>
          <span>Current performance profile</span>
          <small>Best recent proof from your data</small>
        </header>
        <div className="proof-grid">
          {bestEfforts(loadModel.sessions).map((effort) => (
            <article key={effort.label} className={effort.time ? 'proof-card ready' : 'proof-card'}>
              <span>{effort.label}</span>
              <strong>{effort.time ?? 'No proof'}</strong>
              <small>{effort.detail}</small>
            </article>
          ))}
        </div>
      </section>

      {gymSessions.length > 0 && (
        <p className="product-footnote">{gymSessions.length} gym sessions tracked separately from run load.</p>
      )}
    </main>
  );
}

function FitnessView({
  loadModel,
  analyses,
  status,
}: {
  loadModel: TrainingLoadModel;
  analyses: WeeklyAnalysis[];
  status: SyncStatus | null;
}) {
  const cards = buildFitnessCards(loadModel, analyses);
  const zones = buildProductZones(loadModel.thresholds);
  return (
    <main className="product-page fitness-control-view">
      <section className="product-page-head">
        <p className="eyebrow">Fitness</p>
        <h2>Fitness Control Room</h2>
        <p>Track strengths, gaps, freshness, and what to do next from the training you log.</p>
      </section>

      <section className="fitness-direction-card">
        <p>Fitness direction</p>
        <h3>{cards.direction}</h3>
        <span>{cards.directionDetail}</span>
      </section>

      <section className="control-card-grid">
        {cards.items.map((card) => (
          <article key={card.title} className="control-card">
            <span>{card.kicker}</span>
            <h3>{card.title}</h3>
            <p>{card.body}</p>
            <small className={`product-pill tone-${card.tone}`}>{card.badge}</small>
          </article>
        ))}
      </section>

      <section className="fitness-lower-grid">
        <article className="product-card zones-now-card">
          <header>
            <span>Current fitness</span>
            <small>{status?.streamedCount ?? 0} streamed runs</small>
          </header>
          <h3>Zones now</h3>
          <div className="zone-list">
            {zones.map((zone) => (
              <div key={zone.name} className={`zone-list-row tone-${zone.tone}`}>
                <span>{zone.name}</span>
                <strong>{zone.pace}</strong>
                <small>{zone.hr}</small>
              </div>
            ))}
          </div>
        </article>

        <article className="product-card current-bests-card">
          <header>
            <span>Last 180 days</span>
            <small>Current bests</small>
          </header>
          <div className="best-list">
            {bestEfforts(loadModel.sessions).map((effort) => (
              <div key={effort.label}>
                <span>{effort.label}</span>
                <strong>{effort.time ?? 'No proof yet'}</strong>
                <small>{effort.detail}</small>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}

function PlanView({ loadModel }: { loadModel: TrainingLoadModel }) {
  const latestWeek = lastItem(loadModel.weeks);
  const plan = buildSuggestedPlan(loadModel);
  return (
    <main className="product-page plan-view">
      <section className="product-page-head">
        <p className="eyebrow">Plan</p>
        <h2>Your training plan</h2>
        <p>A goal-specific week built around your zones, current load, and what your recent training is missing.</p>
      </section>

      <section className="product-card plan-week-card">
        <header>
          <div>
            <span>Suggested week</span>
            <strong>{plan.focus}</strong>
          </div>
          <small>{latestWeek ? `Current load ${latestWeek.load.toFixed(1)}` : 'Build after sync'}</small>
        </header>
        <div className="plan-day-list">
          {plan.days.map((day) => (
            <article key={day.day} className={`plan-day-row tone-${day.tone}`}>
              <span>{day.day}</span>
              <div>
                <h3>{day.title}</h3>
                <p>{day.prescription}</p>
                <small>{day.reason}</small>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function SessionMiniCard({ session }: { session: SessionLoad }) {
  const kind = classifyProductSession(session);
  return (
    <article className={`session-mini-card tone-${kind.tone}`}>
      <span>{formatActivityDate(session.activity.startDateLocal || session.activity.startDate)}</span>
      <strong>{session.activity.distanceKm.toFixed(1)} km</strong>
      <small>{kind.label} · {formatPace(session.paceSecPerKm)} · {session.activity.averageHeartRate ? `${Math.round(session.activity.averageHeartRate)} bpm` : 'no HR'}</small>
    </article>
  );
}

function lastItem<T>(items: T[]): T | undefined {
  return items.length > 0 ? items[items.length - 1] : undefined;
}

function classifyProductSession(session: SessionLoad): { label: string; tone: string; coach: string } {
  if (
    session.externalIntensityFactor >= 0.85 ||
    (session.heartRateIntensityFactor ?? 0) >= 0.92 ||
    (session.powerIntensityFactor ?? 0) >= 0.88 ||
    session.flags.includes('quality load')
  ) {
    return {
      label: 'Session',
      tone: 'danger',
      coach: 'Quality load. Useful stimulus, but protect the following easy day and watch HR cost.',
    };
  }
  if (session.load >= 70) {
    return {
      label: 'Long easy',
      tone: 'hard',
      coach: 'Long aerobic stress. This builds durability without needing extra intensity.',
    };
  }
  if (session.externalIntensityFactor >= 0.76) {
    return {
      label: 'Steady',
      tone: 'moderate',
      coach: 'Controlled aerobic pressure. Useful LT1/steady work if it stays repeatable.',
    };
  }
  return {
    label: 'Easy',
    tone: 'easy',
    coach: 'Low-stress aerobic work. This supports consistency without adding much fatigue.',
  };
}

function trainingRead(week?: WeekLoadSummary, session?: SessionLoad): { status: string; tone: string; summary: string } {
  if (!week) {
    return { status: 'Building', tone: 'muted', summary: 'Sync runs to build a current training read.' };
  }
  if (week.severity === 'high') {
    return {
      status: 'Caution',
      tone: 'danger',
      summary: 'Fatigue and hard-load signals are elevated. Keep the next work controlled.',
    };
  }
  if (week.hardShare >= 0.45) {
    return {
      status: 'Building',
      tone: 'hard',
      summary: 'A strong volume week, with quality kept controlled. Solid building load.',
    };
  }
  if ((session?.externalIntensityFactor ?? 0) < 0.76 && week.freshness < -10) {
    return {
      status: 'Absorbing',
      tone: 'moderate',
      summary: 'Recent load is still being absorbed. Easy aerobic work is the right bias.',
    };
  }
  return {
    status: 'Building',
    tone: 'easy',
    summary: 'Aerobic volume is consistent; threshold work is the next level if freshness allows.',
  };
}

function formatWeekPace(week?: WeekLoadSummary): string {
  if (!week || week.distanceKm <= 0) {
    return '-';
  }
  return formatPace((week.durationHours * 3600) / week.distanceKm);
}

function formatWeekHr(week?: WeekLoadSummary): string {
  if (!week) {
    return '-';
  }
  const hrs = week.sessions.map((session) => session.activity.averageHeartRate).filter((value): value is number => Boolean(value));
  if (hrs.length === 0) {
    return '-';
  }
  return `${Math.round(hrs.reduce((total, value) => total + value, 0) / hrs.length)} bpm`;
}

function bestEfforts(sessions: SessionLoad[]) {
  const latest = lastItem(sessions);
  const cutoff = latest ? new Date(latest.activity.startDate).getTime() - 180 * 86400000 : -Infinity;
  const recent = sessions.filter((session) => new Date(session.activity.startDate).getTime() >= cutoff);
  const targets = [
    { label: '5K', km: 5 },
    { label: '10K', km: 10 },
    { label: '15K', km: 15 },
    { label: 'Half', km: 21.0975 },
    { label: 'Marathon', km: 42.195 },
  ];
  return targets.map((target) => {
    const candidates = recent
      .filter((session) => session.activity.distanceKm >= target.km * 0.98)
      .map((session) => ({ session, seconds: session.paceSecPerKm * target.km }))
      .sort((a, b) => a.seconds - b.seconds);
    const best = candidates[0];
    return {
      label: target.label,
      time: best ? formatRaceTime(best.seconds) : undefined,
      detail: best
        ? `${formatPace(best.session.paceSecPerKm)} · ${formatActivityDate(best.session.activity.startDateLocal || best.session.activity.startDate)}`
        : `No recent ${target.label.toLowerCase()} proof`,
    };
  });
}

function buildFitnessCards(loadModel: TrainingLoadModel, analyses: WeeklyAnalysis[]) {
  const latestWeek = lastItem(loadModel.weeks);
  const latest = lastItem(loadModel.sessions);
  const anchor = latest ? new Date(latest.activity.startDate).getTime() : Date.now();
  const recent = loadModel.sessions.filter((session) => anchor - new Date(session.activity.startDate).getTime() <= 28 * 86400000);
  const lastQuality = [...loadModel.sessions].reverse().find((session) => classifyProductSession(session).label === 'Session');
  const lastSteady = [...loadModel.sessions].reverse().find((session) => classifyProductSession(session).label === 'Steady');
  const longestRecent = recent.reduce<SessionLoad | undefined>((best, session) => (!best || session.activity.distanceKm > best.activity.distanceKm ? session : best), undefined);
  const decouplingValues = recent.map((session) => session.activity.decouplingPct).filter((value): value is number => value !== undefined);
  const avgDecoupling = decouplingValues.length
    ? decouplingValues.reduce((total, value) => total + value, 0) / decouplingValues.length
    : undefined;
  const proof = analyses[analyses.length - 1];
  const qualityDays = lastQuality ? daysBetween(anchor, new Date(lastQuality.activity.startDate).getTime()) : undefined;
  const steadyDays = lastSteady ? daysBetween(anchor, new Date(lastSteady.activity.startDate).getTime()) : undefined;

  return {
    direction: latestWeek?.status ?? 'Building',
    directionDetail: trainingRead(latestWeek, latest).summary,
    items: [
      {
        kicker: 'Training gaps',
        title: qualityDays === undefined || qualityDays > 14 ? 'LT2 · Long run' : 'No urgent gap',
        body: qualityDays === undefined || qualityDays > 14
          ? 'Threshold freshness has slipped; long-run durability is due a top-up.'
          : 'Recent quality work is present. Keep the next hard effort controlled.',
        badge: qualityDays === undefined || qualityDays > 14 ? 'needs touch' : 'maintained',
        tone: qualityDays === undefined || qualityDays > 14 ? 'hard' : 'easy',
      },
      {
        kicker: 'LT1 / steady',
        title: steadyDays === undefined ? 'Needs touch' : steadyDays <= 14 ? 'Maintained' : 'Stale',
        body: steadyDays === undefined ? 'No recent steady run was detected.' : `Last steady session was ${formatDaysAgo(steadyDays)}.`,
        badge: steadyDays !== undefined && steadyDays <= 14 ? 'current' : 'example',
        tone: steadyDays !== undefined && steadyDays <= 14 ? 'easy' : 'moderate',
      },
      {
        kicker: 'LT2 / threshold',
        title: qualityDays === undefined ? 'Needs touch' : qualityDays <= 14 ? 'Fresh' : 'Needs touch',
        body: qualityDays === undefined ? 'No recent threshold-quality work in the last month.' : `Last session-quality run was ${formatDaysAgo(qualityDays)}.`,
        badge: qualityDays !== undefined && qualityDays <= 14 ? 'fresh' : 'next',
        tone: qualityDays !== undefined && qualityDays <= 14 ? 'easy' : 'hard',
      },
      {
        kicker: 'Long run freshness',
        title: longestRecent && longestRecent.activity.distanceKm >= 12 ? 'Fresh' : 'Stale',
        body: longestRecent ? `Longest recent run was ${longestRecent.activity.distanceKm.toFixed(1)} km.` : 'No recent long run detected.',
        badge: longestRecent && longestRecent.activity.distanceKm >= 12 ? 'current' : 'due',
        tone: longestRecent && longestRecent.activity.distanceKm >= 12 ? 'easy' : 'hard',
      },
      {
        kicker: 'Efficiency trend',
        title: avgDecoupling === undefined ? 'Unknown' : avgDecoupling <= 5 ? 'Stable' : 'Drifting',
        body: avgDecoupling === undefined ? 'Need stream decoupling to judge aerobic efficiency.' : `Recent HR-pace drift averages ${avgDecoupling.toFixed(1)}%.`,
        badge: avgDecoupling === undefined ? 'pending' : avgDecoupling <= 5 ? 'stable' : 'watch',
        tone: avgDecoupling === undefined ? 'muted' : avgDecoupling <= 5 ? 'easy' : 'moderate',
      },
      {
        kicker: 'Proof / confidence',
        title: proof ? proof.stateLabel : 'Moderate',
        body: proof ? proof.summary : 'Training rows exist, but analysis proof is still building.',
        badge: loadModel.sessions.length > 20 ? 'high' : 'moderate',
        tone: loadModel.sessions.length > 20 ? 'easy' : 'moderate',
      },
    ],
  };
}

function buildProductZones(thresholds: TrainingLoadModel['thresholds']) {
  const zoneDefs = [
    { name: 'Recovery', tone: 'easy', ifMin: undefined, ifMax: 0.68, hrMin: undefined, hrMax: 0.82 },
    { name: 'Easy', tone: 'easy', ifMin: 0.68, ifMax: 0.78, hrMin: 0.82, hrMax: 0.89 },
    { name: 'Steady', tone: 'moderate', ifMin: 0.78, ifMax: 0.88, hrMin: 0.89, hrMax: 0.95 },
    { name: 'Threshold', tone: 'hard', ifMin: 0.88, ifMax: 1.02, hrMin: 0.95, hrMax: 1.02 },
    { name: 'High intensity', tone: 'danger', ifMin: 1.02, ifMax: undefined, hrMin: 1.02, hrMax: undefined },
  ];
  return zoneDefs.map((zone) => ({
    ...zone,
    pace: formatIfPaceRange(thresholds.thresholdPaceSecPerKm, zone.ifMin, zone.ifMax),
    hr: formatHrRange(thresholds.thresholdHeartRate, zone.hrMin, zone.hrMax),
  }));
}

function buildSuggestedPlan(loadModel: TrainingLoadModel) {
  const latest = lastItem(loadModel.sessions);
  const anchor = latest ? new Date(latest.activity.startDate).getTime() : Date.now();
  const lastQuality = [...loadModel.sessions].reverse().find((session) => classifyProductSession(session).label === 'Session');
  const qualityDays = lastQuality ? daysBetween(anchor, new Date(lastQuality.activity.startDate).getTime()) : 99;
  const focus = qualityDays > 14 ? 'Threshold + long run' : 'Maintain aerobic rhythm';
  const threshold = formatPace(loadModel.thresholds.thresholdPaceSecPerKm);
  const easy = formatIfPaceRange(loadModel.thresholds.thresholdPaceSecPerKm, 0.68, 0.78);
  return {
    focus,
    days: [
      { day: 'Mon', title: 'Easy Zone 2', prescription: `35-50 min · ${easy}`, reason: 'Aerobic base without adding much fatigue.', tone: 'easy' },
      { day: 'Tue', title: 'Rest or mobility', prescription: 'Walk, mobility, sleep.', reason: 'Protect freshness before quality.', tone: 'muted' },
      {
        day: 'Wed',
        title: qualityDays > 14 ? 'LT2 touch' : 'Steady aerobic',
        prescription: qualityDays > 14 ? `3-4 x 8 min near ${threshold}` : `45-60 min controlled · ${easy}`,
        reason: qualityDays > 14 ? 'Threshold-quality work is the clearest current gap.' : 'Keep pressure controlled while recent quality is fresh.',
        tone: qualityDays > 14 ? 'hard' : 'moderate',
      },
      { day: 'Thu', title: 'Recovery jog', prescription: '25-40 min very easy', reason: 'Flush the legs after the quality day.', tone: 'easy' },
      { day: 'Fri', title: 'Rest', prescription: 'No run unless you feel unusually fresh.', reason: 'Leave room for the weekend long run.', tone: 'muted' },
      { day: 'Sat', title: 'Long easy', prescription: '75-95 min relaxed', reason: 'Durability and aerobic volume are the main builder.', tone: 'hard' },
      { day: 'Sun', title: 'Easy + strides', prescription: '35-45 min easy + 4 relaxed strides', reason: 'Keep mechanics alive without turning it into a session.', tone: 'moderate' },
    ],
  };
}

function formatRaceTime(totalSeconds: number): string {
  const rounded = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatIfPaceRange(thresholdPace: number, ifMin?: number, ifMax?: number): string {
  if (!Number.isFinite(thresholdPace) || thresholdPace <= 0) {
    return '-';
  }
  if (ifMin && ifMax) {
    return `${formatPace(thresholdPace / ifMax).replace('/km', '')}-${formatPace(thresholdPace / ifMin)}`;
  }
  if (ifMax) {
    return `slower than ${formatPace(thresholdPace / ifMax)}`;
  }
  if (ifMin) {
    return `faster than ${formatPace(thresholdPace / ifMin)}`;
  }
  return formatPace(thresholdPace);
}

function formatHrRange(thresholdHr?: number, minRatio?: number, maxRatio?: number): string {
  if (!thresholdHr) {
    return 'HR pending';
  }
  if (minRatio && maxRatio) {
    return `${Math.round(thresholdHr * minRatio)}-${Math.round(thresholdHr * maxRatio)} bpm`;
  }
  if (maxRatio) {
    return `< ${Math.round(thresholdHr * maxRatio)} bpm`;
  }
  if (minRatio) {
    return `> ${Math.round(thresholdHr * minRatio)} bpm`;
  }
  return `${Math.round(thresholdHr)} bpm`;
}

function daysBetween(anchorMs: number, earlierMs: number): number {
  return Math.max(0, Math.round((anchorMs - earlierMs) / 86400000));
}

function formatDaysAgo(days: number): string {
  if (days === 0) {
    return 'today';
  }
  if (days === 1) {
    return '1 day ago';
  }
  return `${days} days ago`;
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
  const roundedSeconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.round(totalSeconds)) : 0;
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const seconds = roundedSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
