import { lazy, Suspense, type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  CalendarDays,
  ClipboardList,
  Gauge,
  Link2,
  List,
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
import type { PhysiologyEstimate } from './analysis/coachEngine';
import {
  buildTrainingLoadModel,
  type CanonicalActivityMetric,
  type SessionLoad,
  type TrainingLoadModel,
  type WeekLoadSummary,
} from './analysis/loadModel';
import { CoachPanel } from './components/CoachPanel';
import { PlanView } from './components/PlanView';
import { TrainingView, type TrainingJumpApi } from './components/TrainingView';
import {
  getActivities,
  getActivity,
  getBestEfforts,
  getCoachContext,
  getGymSessions,
  getPlanDays,
  getSiteKey,
  getSyncStatus,
  getWeeks,
  disconnectStrava,
  setSiteKey,
  savePlanDay,
  saveActivityNote,
  saveCoachPhase,
  addCoachCriticalPower,
  proposeCoachBlock,
  acceptCoachBlock,
  saveCoachFeedback,
  evaluateCoachActivity,
  applyCoachDecision,
  rejectCoachDecision,
  updateCoachSession,
  SiteUnauthorizedError,
  stravaLoginUrl,
  triggerSync,
  triggerGarminSync,
} from './data/api';
import { parseActivityCsv } from './data/importActivities';
import { toWeekIdUtc, type ColorBy } from './data/mapRoutes';
import type {
  ActivityDetail,
  ActivitySummary,
  BestEffortDistance,
  BestEffortEntry,
  GymSession,
  Severity,
  SyncStatus,
  TrainingPlanDay,
  TrendMetricKey,
  WeeklyAnalysis,
  WeeklyRunBlock,
} from './types';
import type { CoachContextData, CoachFeedbackDraft, CoachPhase, CriticalPowerDraft } from './data/coachTypes';

type RangePreset = '4w' | '12w' | '6mo' | '1y' | 'all';
type ViewMode = 'log' | 'progress' | 'plan';
type LogMode = 'list' | 'map';
type BestEffortScope = 'all' | 'season';

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

const LazyMapView = lazy(() => import('./components/MapView').then((module) => ({ default: module.MapView })));
const LazyAdvancedAnalysis = lazy(() => import('./components/AdvancedAnalysis'));

export default function App() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [apiWeeks, setApiWeeks] = useState<WeeklyRunBlock[]>([]);
  const [localWeeks, setLocalWeeks] = useState<WeeklyRunBlock[] | null>(null);
  const [activities, setActivities] = useState<ActivitySummary[]>([]);
  const [allActivitiesLoaded, setAllActivitiesLoaded] = useState(false);
  const [gymSessions, setGymSessions] = useState<GymSession[]>([]);
  const [planDays, setPlanDays] = useState<TrainingPlanDay[]>([]);
  const [planLoading, setPlanLoading] = useState(true);
  const [planLoadError, setPlanLoadError] = useState('');
  const [planHasUnsavedChanges, setPlanHasUnsavedChanges] = useState(false);
  const [coachContext, setCoachContext] = useState<CoachContextData | null>(null);
  const [coachLoading, setCoachLoading] = useState(true);
  const [coachError, setCoachError] = useState('');
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [activityDetail, setActivityDetail] = useState<ActivityDetail | null>(null);
  const [activityFocus, setActivityFocus] = useState<{ id: string; request: number } | null>(() => {
    const id = new URLSearchParams(window.location.search).get('activity');
    return id ? { id, request: 1 } : null;
  });
  const activityFocusRequest = useRef(activityFocus ? 1 : 0);
  const coreLoadRequest = useRef(0);
  const planLoadRequest = useRef(0);
  const coachLoadRequest = useRef(0);
  const [bestEffortGroups, setBestEffortGroups] = useState<BestEffortDistance[]>([]);
  const [bestEffortsLoading, setBestEffortsLoading] = useState(false);
  const [bestEffortsError, setBestEffortsError] = useState('');
  const [banner, setBanner] = useState('');
  const [loadError, setLoadError] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  const [view, setView] = useState<ViewMode>(() => viewFromLocation());
  const [logMode, setLogMode] = useState<LogMode>(() => logModeFromLocation());
  const [menuOpen, setMenuOpen] = useState(false);
  const [bestEffortScope, setBestEffortScope] = useState<BestEffortScope>('all');
  const [trainingJump, setTrainingJump] = useState<TrainingJumpApi | null>(null);
  const confirmPlanNavigation = useCallback(
    (next: ViewMode): boolean => {
      if (next === view || view !== 'plan' || !planHasUnsavedChanges) {
        return true;
      }
      const discard = window.confirm('Discard unsaved Plan changes?');
      if (discard) {
        setPlanHasUnsavedChanges(false);
      }
      return discard;
    },
    [planHasUnsavedChanges, view],
  );
  const selectView = useCallback((next: ViewMode) => {
    if (!confirmPlanNavigation(next)) {
      return;
    }
    setView(next);
    setMenuOpen(false);
    window.history.pushState(null, '', appUrl(next));
  }, [confirmPlanNavigation]);
  const [range, setRange] = useState<RangePreset>('12w');
  const [colorBy, setColorBy] = useState<ColorBy>('severity');
  const [metric, setMetric] = useState<TrendMetricKey>('stride');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const weeks = localWeeks ?? apiWeeks;
  const usingSample = false;
  const analyses = useMemo(() => analyzeWeeks(weeks), [weeks]);
  // Log and Progress intentionally share one visible load model. The deeper
  // coach engine remains available in Plan without changing historical charts.
  const loadModel = useMemo(() => buildTrainingLoadModel(activities), [activities]);
  const currentRead = readForWeek(lastItem(loadModel.weeks));
  const dataKey = `${localWeeks ? 'local' : 'api'}:${weeks.length}`;

  const severityByWeek = useMemo(() => {
    const map = new Map<string, Severity>();
    for (const analysis of analyses) {
      map.set(analysis.week.weekStart, analysis.severity);
    }
    return map;
  }, [analyses]);

  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, analyses.length - 1));
  const selected = analyses[safeSelectedIndex];

  const filteredActivities = useMemo(
    () => filterActivitiesByRange(activities, range),
    [activities, range],
  );
  const seasonStart = useMemo(() => {
    const latest = lastItem(activities);
    if (!latest) {
      return undefined;
    }
    const year = new Date(latest.startDate).getUTCFullYear();
    return `${year}-01-01T00:00:00.000Z`;
  }, [activities]);
  const bestEffortFrom = bestEffortScope === 'season' ? seasonStart : undefined;
  const bestEffortWindowLabel = bestEffortScope === 'season' && seasonStart
    ? `${new Date(seasonStart).getUTCFullYear()} season`
    : 'All-time personal bests';
  const hasTrainingData = (status?.activityCount ?? 0) > 0;
  const isGarminSource = status?.source === 'garmin-health-data' || (!status?.connected && hasTrainingData);

  const loadAllActivities = useCallback(async () => {
    if (allActivitiesLoaded) return;
    const nextActivities = await getActivities();
    setActivities(nextActivities);
    setAllActivitiesLoaded(true);
  }, [allActivitiesLoaded]);

  const openActivityInLog = useCallback((activityId: string) => {
    if (!confirmPlanNavigation('log')) {
      return;
    }
    void (async () => {
      if (!activities.some((activity) => activity.id === activityId)) {
        await loadAllActivities();
      }
      activityFocusRequest.current += 1;
      setActivityFocus({ id: activityId, request: activityFocusRequest.current });
      setView('log');
      setLogMode('list');
      setMenuOpen(false);
      window.history.pushState(null, '', appUrl('log', { activity: activityId }));
    })();
  }, [activities, confirmPlanNavigation, loadAllActivities]);

  const openRouteExplorer = useCallback(() => {
    if (!confirmPlanNavigation('log')) return;
    setView('log');
    setLogMode('map');
    setMenuOpen(false);
    window.history.pushState(null, '', appUrl('log', { mode: 'map' }));
  }, [confirmPlanNavigation]);

  const handleSaveActivityNote = useCallback(async (activityId: string, note: string) => {
    const saved = await saveActivityNote(activityId, note);
    setActivities((current) => current.map((activity) => activity.id === activityId
      ? { ...activity, activityNote: saved.note || undefined }
      : activity));
    return saved.note;
  }, []);

  const loadData = useCallback(async () => {
    const request = ++coreLoadRequest.current;
    setLoadError('');
    try {
      const [nextStatus, nextWeeks, nextActivities, nextGym] = await Promise.all([
        getSyncStatus(),
        getWeeks(),
        getActivities({ from: recentHistoryFrom() }),
        getGymSessions().catch(() => [] as GymSession[]),
      ]);
      if (request !== coreLoadRequest.current) {
        return;
      }
      setStatus(nextStatus);
      setApiWeeks(nextWeeks);
      setActivities(nextActivities);
      setGymSessions(nextGym);
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
      if (request !== coreLoadRequest.current) {
        return;
      }
      if (error instanceof SiteUnauthorizedError) {
        setNeedsPassword(true);
        setPasswordError(getSiteKey() ? 'That password was not accepted. Try again.' : '');
      } else {
        setLoadError(error instanceof Error ? error.message : 'Could not reach the training API.');
      }
    }
  }, []);

  const loadPlanData = useCallback(async () => {
    const request = ++planLoadRequest.current;
    setPlanLoading(true);
    setPlanLoadError('');
    try {
      const nextPlanDays = await getPlanDays();
      if (request !== planLoadRequest.current) {
        return;
      }
      setPlanDays(nextPlanDays);
    } catch (error) {
      if (request !== planLoadRequest.current) {
        return;
      }
      if (error instanceof SiteUnauthorizedError) {
        setNeedsPassword(true);
        setPasswordError(getSiteKey() ? 'That password was not accepted. Try again.' : '');
      } else {
        setPlanLoadError(error instanceof Error ? error.message : 'Could not load the training plan.');
      }
    } finally {
      if (request === planLoadRequest.current) {
        setPlanLoading(false);
      }
    }
  }, []);

  const loadCoachData = useCallback(async (weekStart?: string) => {
    const request = ++coachLoadRequest.current;
    setCoachLoading(true);
    setCoachError('');
    try {
      const nextContext = await getCoachContext({ weekStart });
      if (request !== coachLoadRequest.current) {
        return;
      }
      setCoachContext(nextContext);
    } catch (error) {
      if (request !== coachLoadRequest.current) {
        return;
      }
      if (error instanceof SiteUnauthorizedError) {
        setNeedsPassword(true);
        setPasswordError(getSiteKey() ? 'That password was not accepted. Try again.' : '');
      } else {
        setCoachError(error instanceof Error ? error.message : 'Could not load the coaching context.');
      }
    } finally {
      if (request === coachLoadRequest.current) {
        setCoachLoading(false);
      }
    }
  }, []);

  const handleSavePlanDay = useCallback(
    async (
      date: string,
      patch: { plannedText?: string; notes?: string; expectedUpdatedAt: string | null },
    ) => {
      const saved = await savePlanDay(date, patch);
      setPlanDays((current) => {
        const withoutSaved = current.filter((day) => day.date !== saved.date);
        return [...withoutSaved, saved].sort((a, b) => a.date.localeCompare(b.date));
      });
      return saved;
    },
    [],
  );

  const handleReloadPlanDay = useCallback(async (date: string) => {
    const [fresh] = await getPlanDays({ from: date, to: date });
    setPlanDays((current) => {
      const withoutDate = current.filter((day) => day.date !== date);
      return fresh ? [...withoutDate, fresh].sort((a, b) => a.date.localeCompare(b.date)) : withoutDate;
    });
    return fresh;
  }, []);

  const handleCoachPhase = useCallback(async (phase: CoachPhase, expectedVersion: number) => {
    await saveCoachPhase(phase, expectedVersion);
    await loadCoachData();
  }, [loadCoachData]);

  const handleCoachCriticalPower = useCallback(async (input: CriticalPowerDraft) => {
    await addCoachCriticalPower(input);
    await loadCoachData();
  }, [loadCoachData]);

  const handleCoachBlockProposal = useCallback(async (startWeek: string, weekCount: 1 | 2 | 3) => {
    await proposeCoachBlock(startWeek, weekCount);
    await loadCoachData(startWeek);
  }, [loadCoachData]);

  const handleCoachBlockAcceptance = useCallback(async (decisionId: string, expectedVersion: number) => {
    await acceptCoachBlock(decisionId, expectedVersion);
    await loadCoachData();
  }, [loadCoachData]);

  const handleCoachSessionUpdate = useCallback(async (
    id: string,
    patch: { plannedDate?: string; title?: string; plannedDurationMin?: number; purpose?: string },
    expectedRevision: number,
  ) => {
    await updateCoachSession(id, patch, expectedRevision);
    await loadCoachData();
  }, [loadCoachData]);

  const handleCoachFeedback = useCallback(async (activityId: string, draft: CoachFeedbackDraft) => {
    await saveCoachFeedback(activityId, draft);
    await evaluateCoachActivity(activityId, draft.plannedSessionId);
    await loadCoachData();
  }, [loadCoachData]);

  const handleCoachDecisionApplication = useCallback(async (decisionId: string, expectedVersion: number) => {
    await applyCoachDecision(decisionId, expectedVersion);
    await loadCoachData();
  }, [loadCoachData]);

  const handleCoachDecisionRejection = useCallback(async (decisionId: string) => {
    await rejectCoachDecision(decisionId);
    await loadCoachData();
  }, [loadCoachData]);

  const submitPassword = useCallback(
    async (value: string) => {
      setSiteKey(value.trim());
      setNeedsPassword(false);
      await loadData();
      if (view === 'plan') {
        await Promise.all([loadPlanData(), loadCoachData()]);
      }
    },
    [loadCoachData, loadData, loadPlanData, view],
  );

  useEffect(() => {
    void loadData();
    if (!new URLSearchParams(window.location.search).has('view')) {
      window.history.replaceState(null, '', appUrl('log'));
    }
  }, [loadData]);

  useEffect(() => {
    if (view === 'plan') {
      void loadPlanData();
      void loadCoachData();
    }
  }, [view, loadCoachData, loadPlanData]);

  useEffect(() => {
    if (view === 'log' && activityFocus && activities.length > 0 && !activities.some((activity) => activity.id === activityFocus.id)) {
      void loadAllActivities();
    }
  }, [activities, activityFocus, loadAllActivities, view]);

  useEffect(() => {
    const onPopState = () => {
      const next = viewFromLocation();
      if (!confirmPlanNavigation(next)) {
        window.history.pushState(null, '', appUrl(view));
        return;
      }
      setView(next);
      setLogMode(logModeFromLocation());
      const activityId = new URLSearchParams(window.location.search).get('activity');
      if (activityId) {
        activityFocusRequest.current += 1;
        setActivityFocus({ id: activityId, request: activityFocusRequest.current });
      } else {
        setActivityFocus(null);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [confirmPlanNavigation, view]);

  useEffect(() => {
    if (view !== 'progress' || activities.length === 0) {
      setBestEffortGroups([]);
      setBestEffortsLoading(false);
      setBestEffortsError('');
      return;
    }
    let cancelled = false;
    setBestEffortsLoading(true);
    setBestEffortsError('');
    getBestEfforts(bestEffortFrom ? { from: bestEffortFrom } : undefined)
      .then((distances) => {
        if (!cancelled) {
          setBestEffortGroups(distances);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setBestEffortGroups([]);
          setBestEffortsError(error instanceof Error ? error.message : 'Could not calculate best efforts.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBestEffortsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activities.length, bestEffortFrom, view]);

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
    setLoadError('');
    setBanner(isGarminSource ? 'Queueing Garmin sync…' : 'Sync started — pulling new activities and streams.');
    try {
      if (isGarminSource) {
        const result = await triggerGarminSync();
        setBanner(`${result.message} New activities normally appear here within 3–6 minutes.`);
        window.setTimeout(() => void loadData(), 90_000);
        window.setTimeout(() => void loadData(), 300_000);
      } else {
        await triggerSync();
        window.setTimeout(() => void loadData(), 5000);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Sync failed.');
    } finally {
      setIsSyncing(false);
    }
  }, [isGarminSource, loadData]);

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
    if (!confirmPlanNavigation('progress')) {
      return;
    }
    try {
      const csvText = await file.text();
      const imported = parseActivityCsv(csvText, file.name);
      setLocalWeeks(imported.weeks);
      setBanner(`Loaded ${imported.weekCount} weeks from ${file.name} (analysis only - CSV has no routes).`);
      setView('progress');
      window.history.pushState(null, '', appUrl('progress'));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'The file could not be imported.');
    }
  };

  const athleteName = status?.athlete
    ? [status.athlete.firstname, status.athlete.lastname].filter(Boolean).join(' ')
    : '';
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

        <div className="view-toggle product-view-toggle desktop-primary-nav" role="tablist" aria-label="Primary">
          <button role="tab" aria-selected={view === 'log'} className={view === 'log' ? 'active' : ''} type="button" onClick={() => { setLogMode('list'); selectView('log'); }}><List size={16} aria-hidden="true" /> Log</button>
          <button role="tab" aria-selected={view === 'progress'} className={view === 'progress' ? 'active' : ''} type="button" onClick={() => selectView('progress')}><TrendingUp size={16} aria-hidden="true" /> Progress</button>
          <button role="tab" aria-selected={view === 'plan'} className={view === 'plan' ? 'active' : ''} type="button" onClick={() => selectView('plan')}><ClipboardList size={16} aria-hidden="true" /> Plan</button>
        </div>

        <button
          className="topbar-menu-toggle"
          type="button"
          aria-label={menuOpen ? 'Close settings' : 'Open settings'}
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

          {view === 'log' && logMode === 'map' && (
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
                onChange={(next) => {
                  const nextRange = next as RangePreset;
                  setRange(nextRange);
                  if (nextRange === 'all') void loadAllActivities();
                }}
              />
            </>
          )}

          {view === 'log' && logMode === 'list' && trainingJump && trainingJump.months.length > 0 && (
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

          <button className="utility-menu-button" type="button" onClick={openRouteExplorer}>
            <MapIcon size={16} aria-hidden="true" /> Explore routes
          </button>

          <button
            className="icon-button"
            type="button"
            aria-label="Sync now"
            title={isGarminSource ? 'Queue Garmin sync now' : 'Sync now'}
            disabled={isSyncing || (!isGarminSource && !status?.connected)}
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

      {view === 'plan' ? (
        <PlanView
          coachPanel={(
            <CoachPanel
              context={coachContext}
              loading={coachLoading}
              error={coachError}
              onReload={loadCoachData}
              onUpdatePhase={handleCoachPhase}
              onAddCriticalPower={handleCoachCriticalPower}
              onProposeBlock={handleCoachBlockProposal}
              onAcceptBlock={handleCoachBlockAcceptance}
              onSubmitFeedback={handleCoachFeedback}
              onApplyDecision={handleCoachDecisionApplication}
              onRejectDecision={handleCoachDecisionRejection}
              onOpenActivity={openActivityInLog}
              currentRead={currentRead}
              onUpdateSession={handleCoachSessionUpdate}
            />
          )}
          planDays={planDays}
          activities={activities}
          gymSessions={gymSessions}
          loading={planLoading}
          loadError={planLoadError}
          onRetry={loadPlanData}
          onSave={handleSavePlanDay}
          onReloadDay={handleReloadPlanDay}
          onOpenActivity={openActivityInLog}
          onDirtyStateChange={setPlanHasUnsavedChanges}
        />
      ) : view === 'progress' ? (
        <ProgressView
          loadModel={loadModel}
          analyses={usingSample ? [] : analyses}
          currentRead={currentRead}
          bestEffortGroups={bestEffortGroups}
          bestEffortsLoading={bestEffortsLoading}
          bestEffortsError={bestEffortsError}
          bestEffortWindowLabel={bestEffortWindowLabel}
          bestEffortScope={bestEffortScope}
          onBestEffortScopeChange={setBestEffortScope}
          onOpenActivity={openActivityInLog}
          metric={metric}
          selectedIndex={safeSelectedIndex}
          onMetricChange={setMetric}
          onWeekSelect={setSelectedIndex}
        />
      ) : logMode === 'map' ? (
        <main className="map-stage">
          <button
            className="map-back-to-log"
            type="button"
            onClick={() => {
              setLogMode('list');
              window.history.pushState(null, '', appUrl('log'));
            }}
          >
            <List size={16} aria-hidden="true" /> Back to Log
          </button>
          <Suspense fallback={<div className="surface-loading">Loading route explorer…</div>}>
            <LazyMapView
              activities={filteredActivities}
              severityByWeek={severityByWeek}
              colorBy={colorBy}
              selectedId={selectedActivityId}
              onSelect={setSelectedActivityId}
            />
          </Suspense>

          {filteredActivities.length === 0 && (
            <div className="map-empty">
              <MapIcon size={28} aria-hidden="true" />
              <h2>{hasTrainingData ? 'No routes in this range' : 'Import Garmin data to see your routes'}</h2>
              <p>
                {hasTrainingData
                  ? 'Widen the date range or wait for the next scheduled Garmin sync. Routes with GPS appear here automatically.'
                  : 'The hourly Garmin import fills this map with every run. No local machine needed.'}
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
            ) : selected ? (
              <WeekSnapshot
                analysis={selected}
                colorBy={colorBy}
                routeCount={filteredActivities.filter((activity) => activity.summaryPolyline).length}
                usingSample={usingSample}
              />
            ) : (
              <div className="map-empty-context"><strong>No training week yet</strong><p>Sync a run to build route and weekly context.</p></div>
            )}
          </aside>
        </main>
      ) : (
        <TrainingView
          activities={activities}
          analyses={usingSample ? [] : analyses}
          gymSessions={gymSessions}
          planDays={planDays}
          usingSample={usingSample}
          onJumpApi={setTrainingJump}
          activityFocus={activityFocus}
          onSaveActivityNote={handleSaveActivityNote}
          onRequestFullHistory={loadAllActivities}
        />
      )}

      <MobileBottomNav active={view} onSelect={(next) => {
        if (next === 'log') setLogMode('list');
        selectView(next);
      }} />
    </div>
  );
}

interface CurrentTrainingRead {
  status: string;
  tone: 'easy' | 'moderate' | 'hard' | 'danger' | 'muted';
  summary: string;
}

function viewFromLocation(): ViewMode {
  const queryView = new URLSearchParams(window.location.search).get('view');
  if (queryView === 'progress' || queryView === 'plan' || queryView === 'log') return queryView;
  const segment = window.location.pathname.split('/').filter(Boolean)[0];
  return segment === 'progress' || segment === 'plan' ? segment : 'log';
}

function appUrl(view: ViewMode, extras: Record<string, string> = {}): string {
  const params = new URLSearchParams({ view, ...extras });
  return `/?${params.toString()}`;
}

function logModeFromLocation(): LogMode {
  return new URLSearchParams(window.location.search).get('mode') === 'map' ? 'map' : 'list';
}

function recentHistoryFrom(): string {
  return new Date(Date.now() - 400 * 86_400_000).toISOString();
}

function readForWeek(week?: WeekLoadSummary): CurrentTrainingRead {
  if (!week) {
    return { status: 'Building history', tone: 'muted', summary: 'Sync a few runs to establish your current training pattern.' };
  }
  if (week.status === 'Back off') {
    return { status: 'Back off', tone: 'danger', summary: 'Recent load rose sharply. Keep the next work easy and reassess after recovery.' };
  }
  if (week.status === 'Caution') {
    return { status: 'Caution', tone: 'hard', summary: 'Recent load is elevated against your training background. Hold intensity steady.' };
  }
  if (week.status === 'Fresh') {
    return { status: 'Fresh', tone: 'easy', summary: 'Recent load has eased below your longer-term background. Readiness still depends on how you feel.' };
  }
  if (week.status === 'Productive overload') {
    return { status: 'Productive overload', tone: 'moderate', summary: 'You are carrying a deliberate training load. Protect recovery before adding another step.' };
  }
  return { status: 'Steady', tone: 'easy', summary: 'Training load is broadly matched to your recent background.' };
}

function ProgressView({
  loadModel,
  analyses,
  currentRead,
  bestEffortGroups,
  bestEffortsLoading,
  bestEffortsError,
  bestEffortWindowLabel,
  bestEffortScope,
  onBestEffortScopeChange,
  onOpenActivity,
  metric,
  selectedIndex,
  onMetricChange,
  onWeekSelect,
}: {
  loadModel: TrainingLoadModel;
  analyses: WeeklyAnalysis[];
  currentRead: CurrentTrainingRead;
  bestEffortGroups: BestEffortDistance[];
  bestEffortsLoading: boolean;
  bestEffortsError: string;
  bestEffortWindowLabel: string;
  bestEffortScope: BestEffortScope;
  onBestEffortScopeChange: (scope: BestEffortScope) => void;
  onOpenActivity: (activityId: string) => void;
  metric: TrendMetricKey;
  selectedIndex: number;
  onMetricChange: (metric: TrendMetricKey) => void;
  onWeekSelect: (index: number) => void;
}) {
  const [loadMetric, setLoadMetric] = useState<'time' | 'distance'>('time');
  const [activeWeekId, setActiveWeekId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const latestWeek = lastItem(loadModel.weeks);
  const recentWeeks = loadModel.weeks.slice(-12);
  const maxValue = Math.max(1, ...recentWeeks.map((week) => homeLoadMetricValue(week, loadMetric)));
  const activeWeek = recentWeeks.find((week) => week.weekId === activeWeekId) ?? latestWeek;

  return (
    <main className="product-page progress-view">
      <section className="product-page-head progress-page-head">
        <p className="eyebrow"><TrendingUp size={15} aria-hidden="true" /> Progress</p>
        <h2>How your training is moving</h2>
        <p>Weekly progression, personal bests, and one consistent read of your current load.</p>
      </section>

      <section className="progress-summary-grid">
        <article className={`product-card progress-read-card tone-${currentRead.tone}`}>
          <span>Current training read</span>
          <h3>{currentRead.status}</h3>
          <p>{currentRead.summary}</p>
        </article>
        <article className="product-card progress-week-card">
          <span>This week</span>
          <h3>{latestWeek ? `${latestWeek.distanceKm.toFixed(1)} km` : 'No runs yet'}</h3>
          <div>
            <Stat label="Runs" value={latestWeek ? String(latestWeek.activityCount) : '-'} />
            <Stat label="Time" value={latestWeek ? formatHours(latestWeek.durationHours) : '-'} />
            <Stat label="Load" value={latestWeek ? latestWeek.load.toFixed(1) : '-'} />
          </div>
        </article>
      </section>

      <section className="product-card load-preview-panel progress-load-panel">
        <header>
          <span>Last 12 weeks</span>
          <div className="load-panel-controls">
            <strong>{activeWeek ? formatHomeLoadMetric(activeWeek, loadMetric) : '-'}</strong>
            <div className="mini-toggle" role="group" aria-label="Weekly progression metric">
              <button type="button" className={loadMetric === 'time' ? 'active' : ''} onClick={() => setLoadMetric('time')}>Time</button>
              <button type="button" className={loadMetric === 'distance' ? 'active' : ''} onClick={() => setLoadMetric('distance')}>km</button>
            </div>
          </div>
        </header>
        <div className="mini-load-bars" aria-label="Last 12 weeks of training">
          {recentWeeks.map((week) => (
            <button
              key={week.weekId}
              type="button"
              className={activeWeek?.weekId === week.weekId ? 'active' : ''}
              onMouseEnter={() => setActiveWeekId(week.weekId)}
              onFocus={() => setActiveWeekId(week.weekId)}
              onClick={() => setActiveWeekId(week.weekId)}
              title={`${week.label}: ${formatHomeLoadMetric(week, loadMetric)}`}
            >
              <span style={{ height: `${Math.max(8, (homeLoadMetricValue(week, loadMetric) / maxValue) * 100)}%` }} />
            </button>
          ))}
        </div>
        {activeWeek && <p>{activeWeek.label} · {activeWeek.activityCount} runs · {activeWeek.distanceKm.toFixed(1)} km</p>}
      </section>

      <section className="product-card performance-profile-panel progress-bests-panel">
        <header>
          <div><span>Personal bests</span><small>{bestEffortWindowLabel}</small></div>
          <div className="mini-toggle" role="group" aria-label="Personal best scope">
            <button type="button" className={bestEffortScope === 'all' ? 'active' : ''} onClick={() => onBestEffortScopeChange('all')}>All time</button>
            <button type="button" className={bestEffortScope === 'season' ? 'active' : ''} onClick={() => onBestEffortScopeChange('season')}>Season</button>
          </div>
        </header>
        <BestEffortsPanel
          groups={bestEffortGroups}
          loading={bestEffortsLoading}
          error={bestEffortsError}
          onOpenActivity={onOpenActivity}
        />
      </section>

      <details className="progress-advanced-analysis" onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary>Advanced analysis</summary>
        {advancedOpen && (
          <Suspense fallback={<div className="surface-loading">Loading advanced charts…</div>}>
            <LazyAdvancedAnalysis
              loadModel={loadModel}
              analyses={analyses}
              metric={metric}
              selectedIndex={selectedIndex}
              onMetricChange={onMetricChange}
              onWeekSelect={onWeekSelect}
            />
          </Suspense>
        )}
      </details>
    </main>
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

function MobileBottomNav({ active, onSelect }: { active: ViewMode; onSelect: (next: ViewMode) => void }) {
  const items: Array<{ key: ViewMode; label: string; icon: ReactNode }> = [
    { key: 'log', label: 'Log', icon: <List size={24} aria-hidden="true" /> },
    { key: 'progress', label: 'Progress', icon: <TrendingUp size={24} aria-hidden="true" /> },
    { key: 'plan', label: 'Plan', icon: <ClipboardList size={24} aria-hidden="true" /> },
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
  bestEffortGroups,
  bestEffortsLoading,
  bestEffortsError,
  bestEffortWindowLabel,
  onOpenActivity,
}: {
  loadModel: TrainingLoadModel;
  gymSessions: GymSession[];
  status: SyncStatus | null;
  isLoading: boolean;
  bestEffortGroups: BestEffortDistance[];
  bestEffortsLoading: boolean;
  bestEffortsError: string;
  bestEffortWindowLabel: string;
  onOpenActivity: (activityId: string) => void;
}) {
  const [loadMetric, setLoadMetric] = useState<'time' | 'distance'>('time');
  const [activeLoadWeekId, setActiveLoadWeekId] = useState<string | null>(null);
  const latestSession = lastItem(loadModel.sessions);
  const latestWeek = lastItem(loadModel.weeks);
  const latestDaily = lastItem(loadModel.daily);
  const recentSessions = [...loadModel.sessions].reverse().slice(0, 4);
  const read = isLoading && !latestSession
    ? { status: 'Loading', tone: 'muted', summary: 'Loading your Garmin training history.' }
    : trainingRead(latestWeek, latestSession);
  const recentWeeks = loadModel.weeks.slice(-12);
  const maxWeekMetric = Math.max(1, ...recentWeeks.map((week) => homeLoadMetricValue(week, loadMetric)));
  const activeLoadWeek = recentWeeks.find((week) => week.weekId === activeLoadWeekId) ?? lastItem(recentWeeks);
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
          <div className="load-panel-controls">
            <strong>{latestWeek ? formatHomeLoadMetric(latestWeek, loadMetric) : '-'}</strong>
            <div className="mini-toggle" role="group" aria-label="Training load metric">
              <button type="button" className={loadMetric === 'time' ? 'active' : ''} onClick={() => setLoadMetric('time')}>
                Time
              </button>
              <button type="button" className={loadMetric === 'distance' ? 'active' : ''} onClick={() => setLoadMetric('distance')}>
                km
              </button>
            </div>
          </div>
        </header>
        <div className="mini-load-bars" aria-label="Last 12 weeks of load">
          {recentWeeks.map((week) => (
            <button
              key={week.weekId}
              type="button"
              className={activeLoadWeek?.weekId === week.weekId ? 'active' : ''}
              title={`${week.label}: ${formatHomeLoadMetric(week, loadMetric)}, ${week.distanceKm.toFixed(1)} km, load ${week.load.toFixed(1)}`}
              onMouseEnter={() => setActiveLoadWeekId(week.weekId)}
              onFocus={() => setActiveLoadWeekId(week.weekId)}
              onClick={() => setActiveLoadWeekId(week.weekId)}
            >
              <span style={{ height: `${Math.max(8, (homeLoadMetricValue(week, loadMetric) / maxWeekMetric) * 100)}%` }} />
            </button>
          ))}
        </div>
        {activeLoadWeek && (
          <div className="load-hover-readout">
            <span>{activeLoadWeek.label}</span>
            <strong>{formatHomeLoadMetric(activeLoadWeek, loadMetric)}</strong>
            <small>
              {activeLoadWeek.distanceKm.toFixed(1)} km · {activeLoadWeek.activityCount} runs · load {activeLoadWeek.load.toFixed(1)}
            </small>
          </div>
        )}
        <p>{latestDaily ? `Freshness ${latestDaily.freshness.toFixed(1)} · fatigue ${latestDaily.fatigue.toFixed(1)} · fitness ${latestDaily.fitness.toFixed(1)}.` : 'Load builds after runs are synced.'}</p>
      </section>

      <section className="product-card performance-profile-panel">
        <header>
          <span>Current performance profile</span>
          <small>{bestEffortWindowLabel} · stream-backed top 5</small>
        </header>
        <BestEffortsPanel
          groups={bestEffortGroups}
          loading={bestEffortsLoading}
          error={bestEffortsError}
          onOpenActivity={onOpenActivity}
        />
      </section>

      {gymSessions.length > 0 && (
        <p className="product-footnote">{gymSessions.length} gym sessions tracked separately from run load.</p>
      )}
    </main>
  );
}

function BestEffortsPanel({
  groups,
  loading,
  error,
  onOpenActivity,
}: {
  groups: BestEffortDistance[];
  loading: boolean;
  error: string;
  onOpenActivity: (activityId: string) => void;
}) {
  if (loading && groups.length === 0) {
    return <p className="product-empty-note">Calculating fastest stream-backed segments...</p>;
  }
  if (error && groups.length === 0) {
    return <p className="product-empty-note">{error}</p>;
  }
  if (groups.length === 0) {
    return <p className="product-empty-note">No stream-backed best efforts are available for this window.</p>;
  }
  return (
    <div className="best-effort-groups">
      {groups.map((group) => (
        <article key={group.label} className="best-effort-group">
          <header>
            <span>{group.label}</span>
            <strong>{group.efforts[0] ? formatRaceTime(group.efforts[0].seconds) : 'No proof'}</strong>
          </header>
          {group.efforts.length > 0 ? (
            <ol>
              {group.efforts.slice(0, 3).map((effort) => (
                <li key={`${group.label}-${effort.activityId}`}>
                  <BestEffortButton effort={effort} onOpenActivity={onOpenActivity} />
                </li>
              ))}
            </ol>
          ) : (
            <p>No qualifying run.</p>
          )}
        </article>
      ))}
    </div>
  );
}

function BestEffortButton({
  effort,
  onOpenActivity,
}: {
  effort: BestEffortEntry;
  onOpenActivity: (activityId: string) => void;
}) {
  return (
    <button type="button" onClick={() => onOpenActivity(effort.activityId)}>
      <span>{effort.rank}</span>
      <strong>{formatRaceTime(effort.seconds)}</strong>
      <small>
        {formatPace(effort.paceSecPerKm)} · {formatActivityDate(effort.startDateLocal || effort.startDate)}
        {effort.source === 'stream' ? ' · observed segment' : ' · estimated from whole run'}
      </small>
      <em>{effort.activityName}</em>
    </button>
  );
}

function FitnessView({
  loadModel,
  analyses,
  status,
  physiology,
  bestEffortGroups,
  bestEffortWindowLabel,
  onOpenActivity,
}: {
  loadModel: TrainingLoadModel;
  analyses: WeeklyAnalysis[];
  status: SyncStatus | null;
  physiology?: PhysiologyEstimate;
  bestEffortGroups: BestEffortDistance[];
  bestEffortWindowLabel: string;
  onOpenActivity: (activityId: string) => void;
}) {
  const cards = buildFitnessCards(loadModel, analyses);
  const zones = buildFitnessZones(physiology, loadModel.thresholds);
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
            <small>{physiology?.zones.length ? `Physiology · effective ${formatActivityDate(physiology.asOf)}` : 'Low-confidence fallback'}</small>
          </header>
          <h3>Zones now</h3>
          <div className="zone-list">
            {zones.map((zone) => (
              <div key={zone.name} className={`zone-list-row tone-${zone.tone}`}>
                <span>{zone.name}</span>
                <strong>{zone.pace}</strong>
                <small>{zone.hr}{zone.power ? ` · ${zone.power}` : ''}</small>
              </div>
            ))}
          </div>
        </article>

        <article className="product-card current-bests-card">
          <header>
            <span>{bestEffortWindowLabel}</span>
            <small>Current bests</small>
          </header>
          <div className="best-list">
            {bestEffortGroups.map((group) => {
              const best = group.efforts[0];
              return (
                <button key={group.label} type="button" disabled={!best} onClick={() => best && onOpenActivity(best.activityId)}>
                  <span>{group.label}</span>
                  <strong>{best ? formatRaceTime(best.seconds) : 'No proof yet'}</strong>
                  <small>{best ? `${formatPace(best.paceSecPerKm)} · ${formatActivityDate(best.startDateLocal || best.startDate)}` : 'No stream-backed effort'}</small>
                </button>
              );
            })}
          </div>
        </article>
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

function homeLoadMetricValue(week: WeekLoadSummary, metric: 'time' | 'distance'): number {
  return metric === 'time' ? week.durationHours : week.distanceKm;
}

function formatHomeLoadMetric(week: WeekLoadSummary, metric: 'time' | 'distance'): string {
  return metric === 'time' ? formatHours(week.durationHours) : `${week.distanceKm.toFixed(1)} km`;
}

function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) {
    return '0m';
  }
  const minutes = Math.round(hours * 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
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

function buildFitnessZones(
  physiology: PhysiologyEstimate | undefined,
  thresholds: TrainingLoadModel['thresholds'],
) {
  if (!physiology?.zones.length) {
    return buildProductZones(thresholds).map((zone) => ({ ...zone, power: '' }));
  }
  const tones = ['easy', 'easy', 'moderate', 'hard', 'danger'];
  return physiology.zones.map((zone, index) => ({
    name: zone.label,
    tone: tones[index] ?? 'moderate',
    pace: zone.pace
      ? `${zone.pace.fastSecPerKm ? formatPace(zone.pace.fastSecPerKm).replace('/km', '') : ''}${zone.pace.fastSecPerKm && zone.pace.slowSecPerKm ? '–' : ''}${zone.pace.slowSecPerKm ? formatPace(zone.pace.slowSecPerKm) : ''}`
      : 'Pace withheld',
    hr: zone.heartRateBpm
      ? formatNumericRange(zone.heartRateBpm.low, zone.heartRateBpm.high, 'bpm')
      : 'HR boundary withheld',
    power: zone.powerWatts
      ? formatNumericRange(zone.powerWatts.low, zone.powerWatts.high, 'W')
      : '',
  }));
}

function formatNumericRange(low: number | undefined, high: number | undefined, unit: string): string {
  if (low !== undefined && high !== undefined) return `${Math.round(low)}–${Math.round(high)} ${unit}`;
  if (high !== undefined) return `< ${Math.round(high)} ${unit}`;
  if (low !== undefined) return `> ${Math.round(low)} ${unit}`;
  return `${unit} withheld`;
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
