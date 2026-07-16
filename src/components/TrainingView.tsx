import { lazy, startTransition, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowLeft,
  BookOpen,
  CalendarDays,
  Dumbbell,
  Gauge,
  MessageSquareText,
  Mountain,
  Save,
  ShieldAlert,
  Timer,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { formatPace } from '../analysis/fatigue';
import { streamBestEffortsForActivity } from '../analysis/bestEfforts';
import {
  buildTrainingLoadModel,
  type CanonicalActivityMetric,
  type SessionLoad,
  type TrainingLoadModel,
  type WeekLoadSummary,
} from '../analysis/loadModel';
import type { PhysiologyEstimate, PracticalZone } from '../analysis/coachEngine';
import { getActivity } from '../data/api';
import { buildActivityLaps, buildDerivedKilometreLaps, type ActivityLapView } from '../data/activityLaps';
import { localWeekId, millisecondsUntilNextLocalWeek } from '../data/calendar';
import { activityPaceSecPerKm, toWeekIdUtc } from '../data/mapRoutes';
import type { ActivityDetail, ActivitySummary, GymSession, TrainingPlanDay, WeeklyAnalysis } from '../types';
import { MetricInfo, MetricsGuide, type MetricKey } from './MetricInfo';

const LazyActivityRouteMap = lazy(() => import('./ActivityRouteMap'));
const LazyActivityRunCharts = lazy(() => import('./ActivityRunCharts').then((module) => ({ default: module.ActivityRunCharts })));

const GUIDE_METRICS: MetricKey[] = [
  'load',
  'ctl',
  'atl',
  'freshness',
  'acwr',
  'intensityFactor',
  'hrCost',
  'decoupling',
  'hardShare',
  'longRunShare',
  'monotony',
  'weekStatus',
];

export interface MonthNav {
  id: string;
  label: string;
  count: number;
}

// Lets a parent (the top-bar menu) drive the month/year jump without re-implementing
// the lazy-render + scroll logic that lives here.
export interface TrainingJumpApi {
  months: MonthNav[];
  jumpTo: (monthId: string) => void;
}

interface TrainingViewProps {
  activities: ActivitySummary[];
  analyses: WeeklyAnalysis[];
  gymSessions: GymSession[];
  planDays: TrainingPlanDay[];
  usingSample: boolean;
  canonicalMetrics?: readonly CanonicalActivityMetric[];
  physiology?: PhysiologyEstimate;
  onJumpApi?: (api: TrainingJumpApi | null) => void;
  activityFocus?: { id: string; request: number } | null;
  onSaveActivityNote: (activityId: string, note: string) => Promise<string>;
  onSaveDayNote: (date: string, note: string, expectedUpdatedAt: string | null) => Promise<TrainingPlanDay>;
  onRequestFullHistory: () => Promise<void>;
  allHistoryLoaded?: boolean;
}

// A week in the log is either a scored run week (with any gym that week attached)
// or a gym-only week. Gym never contributes to load — it rides alongside.
interface WeekEntry {
  weekId: string;
  week?: WeekLoadSummary;
  gym: GymSession[];
}

interface CalendarDay {
  dayId: string;
  weekday: string;
  dateLabel: string;
  sessions: SessionLoad[];
  gym: GymSession[];
  distanceKm: number;
  load: number;
  tone: MetricTone;
  planDay?: TrainingPlanDay;
}

type MetricTone = 'easy' | 'moderate' | 'hard' | 'danger' | 'muted';
type RunKind = 'easy' | 'steady' | 'long' | 'session';

interface RunClassification {
  key: RunKind;
  label: string;
  tone: MetricTone;
  reasons: string[];
}

interface TrainingZone {
  key: string;
  label: string;
  name: string;
  tone: MetricTone;
  paceRange: string;
  hrRange: string;
  powerRange: string;
  hrMin?: number;
  hrMax?: number;
  domain?: PracticalZone['domain'];
  control?: string;
}

interface TrainingZoneModel {
  zones: TrainingZone[];
  title: string;
  context: string;
  physiologyBacked: boolean;
}

interface HrZoneTotal {
  zone: TrainingZone;
  seconds: number;
}

interface ZoneTemplate {
  key: string;
  label: string;
  name: string;
  tone: MetricTone;
  ifMin?: number;
  ifMax?: number;
  hrMinRatio?: number;
  hrMaxRatio?: number;
}

const INITIAL_WEEK_COUNT = 12;
const WEEK_CHUNK = 6;
// Weeks rendered below a jump target so the scroller can bring it to the top.
const JUMP_BUFFER_WEEKS = 10;
const DAY_MS = 86_400_000;
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ZONE_TEMPLATES: ZoneTemplate[] = [
  { key: 'z1', label: 'Z1', name: 'Recovery', tone: 'easy' as MetricTone, ifMax: 0.68, hrMaxRatio: 0.82 },
  { key: 'z2', label: 'Z2', name: 'Easy', tone: 'easy' as MetricTone, ifMin: 0.68, ifMax: 0.78, hrMinRatio: 0.82, hrMaxRatio: 0.89 },
  { key: 'z3', label: 'Z3', name: 'Steady', tone: 'moderate' as MetricTone, ifMin: 0.78, ifMax: 0.88, hrMinRatio: 0.89, hrMaxRatio: 0.95 },
  { key: 'z4', label: 'Z4', name: 'Threshold', tone: 'hard' as MetricTone, ifMin: 0.88, ifMax: 1.02, hrMinRatio: 0.95, hrMaxRatio: 1.02 },
  { key: 'z5', label: 'Z5', name: 'VO2 / faster', tone: 'danger' as MetricTone, ifMin: 1.02, hrMinRatio: 1.02 },
];

export function TrainingView({
  activities,
  analyses,
  gymSessions,
  planDays,
  usingSample,
  canonicalMetrics,
  physiology,
  onJumpApi,
  activityFocus,
  onSaveActivityNote,
  onSaveDayNote,
  onRequestFullHistory,
  allHistoryLoaded = false,
}: TrainingViewProps) {
  const [visibleWeekCount, setVisibleWeekCount] = useState(INITIAL_WEEK_COUNT);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewDetail, setPreviewDetail] = useState<ActivityDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const [currentWeekId, setCurrentWeekId] = useState(() => localWeekId());
  const detailCache = useRef(new Map<string, ActivityDetail>());
  const scrollerRef = useRef<HTMLElement | null>(null);
  const weekListRef = useRef<HTMLDivElement | null>(null);
  const historyExpansionPending = useRef(false);
  const logScrollTop = useRef(0);
  const logScrollLeft = useRef(0);
  const logAnchorId = useRef<string | null>(null);
  const logAnchorOffset = useRef<number | null>(null);
  const restoreLogScroll = useRef(false);

  const loadModel = useMemo(
    () => buildTrainingLoadModel(activities, canonicalMetrics),
    [activities, canonicalMetrics],
  );
  const scoped = useMemo(
    () => scopeLoadModel(loadModel, gymSessions, currentWeekId),
    [currentWeekId, gymSessions, loadModel],
  );
  const trainingZoneModel = useMemo(
    () => buildTrainingZoneModel(physiology, loadModel.thresholds),
    [physiology, loadModel.thresholds],
  );
  const planByDate = useMemo(() => new Map(planDays.map((day) => [day.date, day])), [planDays]);
  const analysisByWeek = useMemo(
    () => new Map(analyses.map((analysis) => [analysis.week.weekStart, analysis])),
    [analyses],
  );
  const visibleWeeks = scoped.weekEntries.slice(0, visibleWeekCount);
  const latestDaily = scoped.daily[scoped.daily.length - 1];
  const latestSession = scoped.sessions[0];
  const previewSession = previewId ? loadModel.sessionsById.get(previewId) : undefined;
  const previewPlanDay = previewSession
    ? planByDate.get((previewSession.activity.startDateLocal || previewSession.activity.startDate).slice(0, 10))
    : undefined;
  const runCount = scoped.sessions.length;
  const gymCount = scoped.gymCount;
  const hrCount = scoped.sessions.filter((session) => session.activity.averageHeartRate).length;
  const powerCount = scoped.sessions.filter((session) => session.activity.averageWatts).length;

  useEffect(() => {
    if (activities.length > 0 && !allHistoryLoaded) void onRequestFullHistory();
  }, [activities.length, allHistoryLoaded, onRequestFullHistory]);

  useEffect(() => {
    let timer = 0;
    const refreshCurrentWeek = () => {
      setCurrentWeekId((current) => {
        const next = localWeekId();
        return current === next ? current : next;
      });
      window.clearTimeout(timer);
      timer = window.setTimeout(refreshCurrentWeek, millisecondsUntilNextLocalWeek());
    };
    const refreshAfterResume = () => {
      if (document.visibilityState === 'visible') refreshCurrentWeek();
    };
    refreshCurrentWeek();
    window.addEventListener('focus', refreshCurrentWeek);
    document.addEventListener('visibilitychange', refreshAfterResume);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', refreshCurrentWeek);
      document.removeEventListener('visibilitychange', refreshAfterResume);
    };
  }, []);
  const loadDetail = useCallback((activityId: string) => {
    const cached = detailCache.current.get(activityId);
    if (cached) return Promise.resolve(cached);
    return getActivity(activityId).then((detail) => {
      detailCache.current.set(activityId, detail);
      return detail;
    });
  }, []);
  const prefetchDetail = useCallback((activityId: string) => {
    void loadDetail(activityId).catch(() => undefined);
  }, [loadDetail]);
  const openPreview = useCallback((activityId: string) => {
    const root = scrollerRef.current;
    logScrollTop.current = root?.scrollTop ?? 0;
    logScrollLeft.current = weekListRef.current?.scrollLeft ?? 0;
    const anchor = root?.querySelector<HTMLElement>(`[data-activity-id="${CSS.escape(activityId)}"]`);
    logAnchorId.current = activityId;
    logAnchorOffset.current = root && anchor
      ? anchor.getBoundingClientRect().top - root.getBoundingClientRect().top
      : null;
    setPreviewId(activityId);
    if (new URLSearchParams(window.location.search).get('view') === 'log') {
      const currentState = {
        ...(window.history.state ?? {}),
        logScrollTop: logScrollTop.current,
        logScrollLeft: logScrollLeft.current,
        logAnchorId: logAnchorId.current,
        logAnchorOffset: logAnchorOffset.current,
      };
      window.history.replaceState(currentState, '', window.location.href);
      window.history.pushState({
        activityPage: true,
        logScrollTop: logScrollTop.current,
        logScrollLeft: logScrollLeft.current,
        logAnchorId: logAnchorId.current,
        logAnchorOffset: logAnchorOffset.current,
      }, '', `/?view=log&activity=${encodeURIComponent(activityId)}`);
    }
  }, []);

  useLayoutEffect(() => {
    if (!previewId || !scrollerRef.current) return;
    const root = scrollerRef.current;
    const behavior = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    root.scrollTop = 0;
    root.scrollLeft = 0;
    root.style.scrollBehavior = behavior;
  }, [previewId]);

  const closeActivityPage = useCallback(() => {
    if (window.history.state?.activityPage) {
      window.history.back();
      return;
    }
    restoreLogScroll.current = true;
    setPreviewId(null);
    window.history.replaceState({
      ...(window.history.state ?? {}),
      logScrollTop: logScrollTop.current,
      logScrollLeft: logScrollLeft.current,
      logAnchorId: logAnchorId.current,
      logAnchorOffset: logAnchorOffset.current,
    }, '', '/?view=log');
  }, []);

  const revealActivityWeek = useCallback((activityId: string) => {
    const session = loadModel.sessionsById.get(activityId);
    if (!session) return;
    const index = scoped.weekEntries.findIndex((entry) => entry.weekId === session.weekId);
    if (index >= 0) {
      setVisibleWeekCount((current) => Math.max(current, index + 1 + JUMP_BUFFER_WEEKS));
    }
  }, [loadModel.sessionsById, scoped.weekEntries]);

  // Month/year jump. Week blocks are lazily rendered, so a naive #anchor link
  // does nothing when the target month isn't in the DOM yet. Instead we render
  // enough weeks to include the target, then scroll it into the scroller.
  const jumpToMonth = useCallback(
    (monthId: string) => {
      const index = scoped.weekEntries.findIndex((entry) => monthIdFromEntry(entry) <= monthId);
      if (index < 0) {
        return;
      }
      // Render a buffer of weeks BELOW the target so the scroller has enough
      // content to bring the target to the top (otherwise scrollTop clamps and
      // the jump lands short, showing a newer month).
      setVisibleWeekCount((current) => Math.max(current, index + 1 + JUMP_BUFFER_WEEKS));
      setPendingJump(scoped.weekEntries[index].weekId);
    },
    [scoped.weekEntries],
  );

  // Publish the jump control to the parent (top-bar menu) so months can be
  // reached without scrolling back up to the in-log rail.
  useEffect(() => {
    if (!onJumpApi) {
      return;
    }
    onJumpApi({ months: scoped.months, jumpTo: jumpToMonth });
    return () => onJumpApi(null);
  }, [scoped.months, jumpToMonth, onJumpApi]);

  useEffect(() => {
    if (!pendingJump) {
      return;
    }
    // Jumping can render many heavy week blocks at once; the browser may take
    // several frames to lay them all out, and the measured target position keeps
    // shifting until it does. Scrolling too early lands short. So poll each frame
    // until the target position is both reachable and STABLE across two frames,
    // then scroll.
    let cancelled = false;
    let frame = 0;
    let prevDesired = Number.NaN;
    const attempt = () => {
      if (cancelled) {
        return;
      }
      const root = scrollerRef.current;
      const target = root?.querySelector<HTMLElement>(`[data-week="${pendingJump}"]`);
      if (root && target) {
        const desired = root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 10;
        const reachable = root.scrollHeight - root.clientHeight >= desired - 1;
        const stable = Math.abs(desired - prevDesired) < 1;
        if ((reachable && stable) || frame > 90) {
          root.scrollTop = desired;
          setPendingJump(null);
          return;
        }
        prevDesired = desired;
      } else if (frame > 90) {
        setPendingJump(null);
        return;
      }
      frame += 1;
      requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
    };
  }, [pendingJump]);

  useEffect(() => {
    if (!activityFocus) {
      return;
    }
    const session = loadModel.sessionsById.get(activityFocus.id);
    setPreviewId(activityFocus.id);
    if (!session) {
      return;
    }
    revealActivityWeek(activityFocus.id);
    setPendingJump(session.weekId);
  }, [activityFocus?.id, activityFocus?.request, loadModel.sessionsById, revealActivityWeek]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const activityId = new URLSearchParams(window.location.search).get('activity');
      if (!activityId) {
        const savedScroll = event.state?.logScrollTop;
        const savedHorizontalScroll = event.state?.logScrollLeft;
        const savedAnchorId = event.state?.logAnchorId;
        const savedAnchorOffset = event.state?.logAnchorOffset;
        if (typeof savedScroll === 'number') logScrollTop.current = savedScroll;
        if (typeof savedHorizontalScroll === 'number') logScrollLeft.current = savedHorizontalScroll;
        if (typeof savedAnchorId === 'string') logAnchorId.current = savedAnchorId;
        if (typeof savedAnchorOffset === 'number') logAnchorOffset.current = savedAnchorOffset;
        if (typeof savedAnchorId === 'string') revealActivityWeek(savedAnchorId);
        restoreLogScroll.current = true;
      }
      setPreviewId(activityId);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [revealActivityWeek]);

  useLayoutEffect(() => {
    if (previewId || !restoreLogScroll.current) return;
    restoreLogScroll.current = false;
    let frame = 0;
    let cancelled = false;
    const targetTop = logScrollTop.current;
    const targetLeft = logScrollLeft.current;
    const anchorId = logAnchorId.current;
    const anchorOffset = logAnchorOffset.current;
    const root = scrollerRef.current;
    if (!root) return;
    const behavior = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    const restore = () => {
      if (cancelled) return;
      if (frame === 0) root.scrollTop = targetTop;
      if (weekListRef.current) weekListRef.current.scrollLeft = targetLeft;
      if (anchorId && anchorOffset !== null) {
        const anchor = root.querySelector<HTMLElement>(`[data-activity-id="${CSS.escape(anchorId)}"]`);
        if (anchor) {
          const currentOffset = anchor.getBoundingClientRect().top - root.getBoundingClientRect().top;
          root.scrollTop += currentOffset - anchorOffset;
        }
      }
      frame += 1;
      // Hold the position while content-visibility, fonts, focus restoration,
      // and mobile browser history anchoring finish settling the diary layout.
      if (frame < 18) {
        requestAnimationFrame(restore);
      } else {
        root.style.scrollBehavior = behavior;
      }
    };
    restore();
    return () => {
      cancelled = true;
      root.style.scrollBehavior = behavior;
    };
  }, [previewId]);

  useEffect(() => {
    setVisibleWeekCount(INITIAL_WEEK_COUNT);
  }, [loadModel.sessions.length]);

  const revealHistoryAhead = useCallback((root: HTMLElement) => {
    if (historyExpansionPending.current || visibleWeekCount >= scoped.weekEntries.length) return;
    const remainingPx = root.scrollHeight - root.scrollTop - root.clientHeight;
    // Keep several phone screens already rendered below the viewport. This is
    // driven by the actual scroll position, so nested horizontal overflow can
    // never strand the diary at an arbitrary month as an observer sentinel can.
    if (remainingPx > 4_800) return;
    historyExpansionPending.current = true;
    startTransition(() => {
      setVisibleWeekCount((current) => Math.min(scoped.weekEntries.length, current + WEEK_CHUNK));
    });
  }, [scoped.weekEntries.length, visibleWeekCount]);

  useEffect(() => {
    historyExpansionPending.current = false;
    const root = scrollerRef.current;
    if (!root) return;
    const frame = requestAnimationFrame(() => revealHistoryAhead(root));
    return () => cancelAnimationFrame(frame);
  }, [revealHistoryAhead, visibleWeekCount]);

  useEffect(() => {
    if (!previewId) {
      setPreviewDetail(null);
      setPreviewLoading(false);
      return;
    }
    const cached = detailCache.current.get(previewId);
    if (cached) {
      setPreviewDetail(cached);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewDetail(null);
    setPreviewLoading(true);
    loadDetail(previewId)
      .then((detail) => {
        detailCache.current.set(previewId, detail);
        if (!cancelled) {
          setPreviewDetail(detail);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewDetail(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadDetail, previewId]);

  const savePreviewNote = useCallback(async (activityId: string, note: string) => {
    const savedNote = await onSaveActivityNote(activityId, note);
    const cached = detailCache.current.get(activityId);
    if (cached) {
      detailCache.current.set(activityId, { ...cached, activityNote: savedNote || undefined });
    }
    setPreviewDetail((current) => current?.id === activityId
      ? { ...current, activityNote: savedNote || undefined }
      : current);
    return savedNote;
  }, [onSaveActivityNote]);

  return (
    <main
      ref={scrollerRef}
      className={`training-view training-log-view${previewId ? ' activity-page-open' : ''}`}
      aria-label={previewId ? 'Activity detail' : 'Training history'}
      onScroll={(event) => {
        if (!previewId) {
          logScrollTop.current = event.currentTarget.scrollTop;
          revealHistoryAhead(event.currentTarget);
        }
      }}
    >
      {previewId ? (
        previewSession ? (
          <ActivityDetailPage
            detail={previewDetail}
            session={previewSession}
            loading={previewLoading}
            zones={trainingZoneModel.zones}
            thresholdPaceSecPerKm={loadModel.thresholds.thresholdPaceSecPerKm}
            planDay={previewPlanDay}
            onBack={closeActivityPage}
            onSaveNote={savePreviewNote}
          />
        ) : (
          <section className="activity-detail-page activity-detail-loading">
            <button type="button" className="activity-page-back" onClick={closeActivityPage}>
              <ArrowLeft size={17} aria-hidden="true" /> Back
            </button>
            <div className="surface-loading">Loading this run…</div>
          </section>
        )
      ) : (
        <>
      <section className="training-toolbar log-history-hero" aria-label="All training history">
        <div className="log-history-intro">
          <p className="eyebrow">
            <CalendarDays size={15} aria-hidden="true" />
            Training almanac
          </p>
          <h2>The running year</h2>
          <p className="log-history-deck">Every run, rest day and field note—laid out in the rhythm you trained it.</p>
          <small>{allHistoryLoaded ? `${scoped.months.length} months on record` : 'Opening your full history…'}</small>
        </div>
        <div className="log-history-totals" aria-label="All-time totals">
          <div className="log-history-total distance">
            <span>Distance</span>
            <strong>{Math.round(scoped.distanceKm).toLocaleString()}<small> km</small></strong>
          </div>
          <div className="log-history-total time">
            <span>Time</span>
            <strong>{formatLifetimeDuration(scoped.durationSec)}</strong>
          </div>
          <div className="log-history-total runs">
            <span>Runs</span>
            <strong>{runCount.toLocaleString()}</strong>
          </div>
          <div className="calendar-tone-key" aria-label="Calendar effort key">
            <span><i className="tone-easy" aria-hidden="true" /> Easy</span>
            <span><i className="tone-moderate" aria-hidden="true" /> Steady</span>
            <span><i className="tone-hard" aria-hidden="true" /> Hard</span>
            <span><i className="tone-danger" aria-hidden="true" /> High load</span>
          </div>
        </div>
      </section>

      {scoped.months.length > 0 && (
        <label className="training-inline-jump log-history-jump">
          <span><CalendarDays size={14} aria-hidden="true" /> Jump to</span>
          <select aria-label="Jump to month" value="" onChange={(event) => event.target.value && jumpToMonth(event.target.value)}>
            <option value="">Month…</option>
            {scoped.months.map((month) => <option key={month.id} value={month.id}>{month.label} ({month.count})</option>)}
          </select>
        </label>
      )}

      <section className="training-log-shell" aria-label="Activity log">
        <div
          ref={weekListRef}
          className="training-week-list"
          onScroll={(event) => { logScrollLeft.current = event.currentTarget.scrollLeft; }}
        >
          {visibleWeeks.length > 0 ? (
            visibleWeeks.map((entry, index) => {
              const previous = visibleWeeks[index - 1];
              const currentMonth = monthIdFromEntry(entry);
              const showMonthAnchor = !previous || monthIdFromEntry(previous) !== currentMonth;
              return (
                <div key={entry.weekId} className="training-week-block-wrap" data-week={entry.weekId}>
                  {showMonthAnchor && (
                    <div id={`month-${currentMonth}`} className="training-month-divider">
                      <span>{formatMonthLabel(`${currentMonth}-01`)}</span>
                      <small>{scoped.months.find((month) => month.id === currentMonth)?.count ?? 0} runs</small>
                    </div>
                  )}
                  {entry.week ? (
                    <WeekBlock
                      week={entry.week}
                      gym={entry.gym}
                      analysis={analysisByWeek.get(entry.weekId)}
                      planByDate={planByDate}
                      previewId={previewId}
                      onPreview={openPreview}
                      onPrefetch={prefetchDetail}
                      onSaveDayNote={onSaveDayNote}
                      currentWeek={entry.weekId === currentWeekId}
                    />
                  ) : (
                    <NoRunWeekBlock
                      weekId={entry.weekId}
                      gym={entry.gym}
                      planByDate={planByDate}
                      onSaveDayNote={onSaveDayNote}
                      currentWeek={entry.weekId === currentWeekId}
                    />
                  )}
                </div>
              );
            })
          ) : (
            <div className="training-empty">
              <Activity size={28} aria-hidden="true" />
              <h3>{usingSample ? 'Bring your training year into view' : 'Your calendar is ready'}</h3>
              <p>{usingSample ? 'Import Garmin activities and each week will assemble here automatically.' : 'Your next run, rest-day note or gym session will appear in this week.'}</p>
            </div>
          )}
          {visibleWeekCount < scoped.weekEntries.length && <div className="training-scroll-sentinel" aria-hidden="true" />}
        </div>

      </section>
        </>
      )}
    </main>
  );
}

function WeekBlock({
  week,
  gym,
  analysis,
  planByDate,
  previewId,
  onPreview,
  onPrefetch,
  onSaveDayNote,
  currentWeek,
}: {
  week: WeekLoadSummary;
  gym: GymSession[];
  analysis?: WeeklyAnalysis;
  planByDate: Map<string, TrainingPlanDay>;
  previewId: string | null;
  onPreview: (id: string) => void;
  onPrefetch: (id: string) => void;
  onSaveDayNote: TrainingViewProps['onSaveDayNote'];
  currentWeek: boolean;
}) {
  const days = buildWeekCalendarDays(week.weekId, week.sessions, gym, planByDate);
  return (
    <article className={`training-week-block ${week.severity}${currentWeek ? ' current-week' : ''}`}>
      <header className="training-week-head">
        <div className="training-week-heading-content">
          <div className="training-week-title-group">
            <p>{week.label}</p>
            {currentWeek && <span className="current-week-marker">This week</span>}
            <h3>{week.status}</h3>
          </div>
          <WeekTotalReadout
            label={week.label}
            distanceKm={week.distanceKm}
            durationHours={week.durationHours}
            runCount={week.activityCount}
          />
        </div>
      </header>
      <WeekCalendar
        days={days}
        previewId={previewId}
        onPreview={onPreview}
        onPrefetch={onPrefetch}
        onSaveDayNote={onSaveDayNote}
        ariaLabel={`${week.label} training calendar`}
      />
      <details className="week-analysis-disclosure">
        <summary>Week analysis</summary>
        <div className="week-load-summary">
          <Metric label="Load" value={week.load.toFixed(1)} />
          <Metric label="Fitness" value={week.fitness.toFixed(1)} />
          <Metric label="Fatigue" value={week.fatigue.toFixed(1)} />
          <Metric label="Freshness" value={week.freshness.toFixed(1)} />
          <Metric label="Ramp" value={week.acwr.toFixed(2)} />
        </div>
        <div className="week-risk-row">
          <span>{Math.round(week.hardShare * 100)}% hard load</span>
          <span>{Math.round(week.longRunShare * 100)}% long-run share</span>
        </div>
        {week.flags.length > 0 && (
          <div className="week-flags">
            {week.flags.map((flag) => <span key={flag}>{flag}</span>)}
          </div>
        )}
      </details>
    </article>
  );
}

export function TrainingZoneSummary({
  loadModel,
  physiology,
}: {
  loadModel: TrainingLoadModel;
  physiology?: PhysiologyEstimate;
}) {
  const model = useMemo(
    () => buildTrainingZoneModel(physiology, loadModel.thresholds),
    [loadModel.thresholds, physiology],
  );
  return <ZoneSummary model={model} />;
}

function ZoneSummary({ model }: { model: TrainingZoneModel }) {
  return (
    <section
      className="training-zone-panel"
      aria-label="Current training zones"
      data-zone-source={model.physiologyBacked ? 'physiology' : 'low-confidence-fallback'}
    >
      <header>
        <div>
          <p>Current zones</p>
          <h3>{model.title}</h3>
          <small>{model.context}</small>
        </div>
        <div className="zone-info-row">
          <span>
            {model.physiologyBacked ? 'Pace · CS' : 'Pace'}
            {!model.physiologyBacked && <MetricInfo metric="paceZones" align="right" />}
          </span>
          <span>
            {model.physiologyBacked ? 'HR · LT1/LT2' : 'HR'}
            {!model.physiologyBacked && <MetricInfo metric="hrZones" align="right" />}
          </span>
          <span>{model.physiologyBacked ? 'Power · CP' : 'Power'}</span>
        </div>
      </header>
      <div className="zone-card-grid">
        {model.zones.map((zone) => (
          <article key={zone.key} className={`zone-card tone-${zone.tone}`}>
            <div>
              <strong>{zone.label}</strong>
              <span>{zone.name}{zone.domain ? ` · ${zone.domain}` : ''}</span>
            </div>
            <dl>
              <div>
                <dt>Pace</dt>
                <dd>{zone.paceRange}</dd>
              </div>
              <div>
                <dt>HR</dt>
                <dd>{zone.hrRange}</dd>
              </div>
              <div>
                <dt>Power</dt>
                <dd>{zone.powerRange}</dd>
              </div>
            </dl>
            {zone.control && <small>{zone.control}</small>}
          </article>
        ))}
      </div>
    </section>
  );
}

function WeekTotalReadout({
  label,
  distanceKm,
  durationHours,
  runCount,
}: {
  label: string;
  distanceKm: number;
  durationHours: number;
  runCount: number;
}) {
  return (
    <div className="week-total-readout" aria-label={`${label} totals`}>
      <div><span>Distance</span><strong>{distanceKm.toFixed(1)} km</strong></div>
      <div><span>Time</span><strong>{formatHoursMinutes(durationHours)}</strong></div>
      <small>{runCount} {runCount === 1 ? 'run' : 'runs'}</small>
    </div>
  );
}

// The diary is a continuous calendar. Gym-only and fully empty weeks retain
// the same seven weekday columns so weekday-to-weekday comparison never jumps.
function NoRunWeekBlock({
  weekId,
  gym,
  planByDate,
  onSaveDayNote,
  currentWeek,
}: {
  weekId: string;
  gym: GymSession[];
  planByDate: Map<string, TrainingPlanDay>;
  onSaveDayNote: TrainingViewProps['onSaveDayNote'];
  currentWeek: boolean;
}) {
  const days = buildWeekCalendarDays(weekId, [], gym, planByDate);
  const label = `Week of ${formatWeekIdLabel(weekId)}`;
  return (
    <article className={`training-week-block ${gym.length > 0 ? 'gym-only' : 'empty-week'}${currentWeek ? ' current-week' : ''}`}>
      <header className="training-week-head">
        <div className="training-week-heading-content">
          <div className="training-week-title-group">
            <p>{label}</p>
            {currentWeek && <span className="current-week-marker">This week</span>}
            <h3>{gym.length > 0 ? 'Gym week' : 'No runs'}</h3>
          </div>
          <WeekTotalReadout label={label} distanceKm={0} durationHours={0} runCount={0} />
          {gym.length > 0 && (
            <div className="week-gym-count">
              <Dumbbell size={16} aria-hidden="true" />
              <strong>{gym.length}</strong>
              <small>gym {gym.length === 1 ? 'session' : 'sessions'}</small>
            </div>
          )}
        </div>
      </header>
      <WeekCalendar days={days} onSaveDayNote={onSaveDayNote} ariaLabel={`${label} calendar`} />
    </article>
  );
}

function WeekCalendar({
  days,
  previewId,
  onPreview,
  onPrefetch,
  onSaveDayNote,
  ariaLabel,
}: {
  days: CalendarDay[];
  previewId?: string | null;
  onPreview?: (id: string) => void;
  onPrefetch?: (id: string) => void;
  onSaveDayNote: TrainingViewProps['onSaveDayNote'];
  ariaLabel: string;
}) {
  return (
    <div className="week-calendar-grid" role="list" aria-label={ariaLabel}>
      {days.map((day) => (
        <CalendarDayColumn
          key={day.dayId}
          day={day}
          previewId={previewId ?? null}
          onPreview={onPreview}
          onPrefetch={onPrefetch}
          onSaveDayNote={onSaveDayNote}
        />
      ))}
    </div>
  );
}

function CalendarDayColumn({
  day,
  previewId,
  onPreview,
  onPrefetch,
  onSaveDayNote,
}: {
  day: CalendarDay;
  previewId: string | null;
  onPreview?: (id: string) => void;
  onPrefetch?: (id: string) => void;
  onSaveDayNote: TrainingViewProps['onSaveDayNote'];
}) {
  const hasRun = day.sessions.length > 0;
  const hasGym = day.gym.length > 0;
  const note = day.planDay?.notes;
  const hasNote = Boolean(note && note.length > 0);
  const today = new Date();
  const todayId = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const isToday = day.dayId === todayId;
  return (
    <section
      className={`week-day-cell tone-${day.tone}${hasRun ? ' has-run' : ''}${hasGym ? ' has-gym' : ''}${hasNote ? ' has-note' : ''}${isToday ? ' is-today' : ''}`}
      aria-label={`${day.weekday} ${day.dateLabel}`}
      aria-current={isToday ? 'date' : undefined}
    >
      <header className="week-day-head">
        <span>{day.weekday}</span>
        <strong>{day.dateLabel}</strong>
        {isToday && <em>Today</em>}
        <small>
          {hasRun
            ? day.sessions.length > 1
              ? `${day.sessions.length} runs · L${Math.round(day.load)}`
              : `${day.distanceKm.toFixed(1)} km · L${Math.round(day.load)}`
            : hasGym
              ? `${day.gym.length} gym`
              : 'Rest'}
        </small>
      </header>
      <div className="week-day-stack">
        {day.sessions.map((session) => (
          <CalendarRunCard
            key={session.activity.id}
            session={session}
            active={previewId === session.activity.id}
            onPreview={onPreview}
            onPrefetch={onPrefetch}
          />
        ))}
        {day.gym.map((session) => (
          <GymSessionPill key={session.id} session={session} />
        ))}
        {!hasRun && !hasGym && !hasNote && <span className="week-rest-label">Rest</span>}
        <DayNoteEditor dayId={day.dayId} planDay={day.planDay} onSave={onSaveDayNote} />
      </div>
    </section>
  );
}

function CalendarRunCard({
  session,
  active,
  onPreview,
  onPrefetch,
}: {
  session: SessionLoad;
  active: boolean;
  onPreview?: (id: string) => void;
  onPrefetch?: (id: string) => void;
}) {
  const activity = session.activity;
  const effortTone = toneForEffort(session.externalIntensityFactor);
  const runKind = classifyRun(session);
  const openPreview = () => onPreview?.(activity.id);
  return (
    <button
      type="button"
      data-activity-id={activity.id}
      className={`calendar-run-card tone-${effortTone} run-${runKind.key}${active ? ' active' : ''}${session.hardLoad > 0 ? ' hard' : ''}`}
      onPointerEnter={() => onPrefetch?.(activity.id)}
      onFocus={() => onPrefetch?.(activity.id)}
      onClick={openPreview}
    >
      <span className="calendar-run-title-row">
        <span className="calendar-run-title">
          <strong>{activity.name}</strong>
          <small>{formatRunTime(activity.startDateLocal || activity.startDate)}</small>
        </span>
        <span className={`calendar-run-type tone-${runKind.tone}`} title={runKind.reasons.join('\n')}>
          {runKind.label}
        </span>
      </span>
      <span className={`calendar-run-reason tone-${runKind.tone}`} title={runKind.reasons.join(' ')}>
        {calendarRunSummary(runKind.key)}
      </span>
      {activity.activityNote && (
        <span className="calendar-run-note">
          <MessageSquareText size={12} aria-hidden="true" />
          {notePreview(activity.activityNote)}
        </span>
      )}
      {!activity.activityNote && (
        <span className="calendar-run-note calendar-run-note-empty">
          <MessageSquareText size={12} aria-hidden="true" /> Add note
        </span>
      )}
      <span className="calendar-run-primary">
        <strong>{activity.distanceKm.toFixed(1)} km</strong>
        <span>{formatCompactPace(activityPaceSecPerKm(activity))} pace</span>
      </span>
      <span className="calendar-run-metrics">
        <RunMetric label="Time" value={formatDuration(activity.movingTimeSec)} tone="muted" />
        <RunMetric label="Elev" value={`${Math.round(activity.elevationGainM)} m`} tone={toneForElevation(activity.elevationGainM)} />
        <RunMetric label="HR" value={activity.averageHeartRate ? `${Math.round(activity.averageHeartRate)}` : '-'} tone={toneForHeartRate(session)} />
        <RunMetric label="W" value={activity.averageWatts ? `${Math.round(activity.averageWatts)}` : '-'} tone={activity.averageWatts ? 'moderate' : 'muted'} />
        <RunMetric label="Load" value={session.load.toFixed(1)} tone={toneForLoad(session.load)} />
      </span>
    </button>
  );
}

function DayNoteEditor({
  dayId,
  planDay,
  onSave,
}: {
  dayId: string;
  planDay?: TrainingPlanDay;
  onSave: TrainingViewProps['onSaveDayNote'];
}) {
  const note = planDay?.notes ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const [saved, setSaved] = useState(note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(note);
    setSaved(note);
    setError('');
  }, [dayId, note]);

  const save = async () => {
    if (saving || draft === saved) return;
    setSaving(true);
    setError('');
    try {
      const next = await onSave(dayId, draft, planDay?.updatedAt ?? null);
      setSaved(next.notes);
      setDraft(next.notes);
      setEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this day note.');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className={`calendar-day-note-trigger${saved ? ' has-note' : ''}`}
        onClick={() => setEditing(true)}
        aria-label={`${saved ? 'Edit' : 'Add'} note for ${dayId}`}
      >
        <MessageSquareText size={12} aria-hidden="true" />
        <span>{saved ? notePreview(saved) : 'Add day note'}</span>
      </button>
    );
  }

  return (
    <section className="calendar-day-note-editor" aria-label={`Note for ${dayId}`}>
      <textarea
        rows={3}
        value={draft}
        disabled={saving}
        autoFocus
        placeholder="How did today feel?"
        onChange={(event) => setDraft(event.target.value)}
      />
      <div>
        <button type="button" disabled={saving || draft === saved} onClick={() => void save()}>
          <Save size={12} aria-hidden="true" /> {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" disabled={saving} onClick={() => { setDraft(saved); setEditing(false); setError(''); }}>
          Cancel
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function GymSessionPill({ session }: { session: GymSession }) {
  return (
    <div className="calendar-gym-pill" title={gymTitle(session)}>
      <span>
        <Dumbbell size={13} aria-hidden="true" />
        <strong>Gym</strong>
      </span>
      <small>
        {formatRunTime(session.startDateLocal || session.startDate)}
        {session.durationSec > 0 ? ` / ${Math.round(session.durationSec / 60)}m` : ''}
        {session.averageHeartRate ? ` / ${Math.round(session.averageHeartRate)} bpm` : ''}
      </small>
    </div>
  );
}

function ActivityDetailPage({
  detail,
  session,
  loading,
  zones,
  thresholdPaceSecPerKm,
  planDay,
  onBack,
  onSaveNote,
}: {
  detail: ActivityDetail | null;
  session: SessionLoad;
  loading: boolean;
  zones: TrainingZone[];
  thresholdPaceSecPerKm: number;
  planDay?: TrainingPlanDay;
  onBack: () => void;
  onSaveNote: (activityId: string, note: string) => Promise<string>;
}) {
  const activity = detail ?? session.activity;
  const split = detail ? splitPaces(detail) : undefined;
  const lapSplits = detail ? buildActivityLaps(detail, thresholdPaceSecPerKm) : [];
  const recordedLapSplits = lapSplits.filter((lap) => lap.source === 'recorded');
  const kilometreSplits = detail ? buildDerivedKilometreLaps(detail, thresholdPaceSecPerKm) : [];
  const hrZoneTotals = detail ? buildHrZoneTotals(detail, zones) : undefined;
  const bestEfforts = detail ? streamBestEffortsForActivity({
    id: detail.id,
    name: detail.name,
    startDate: detail.startDate,
    startDateLocal: detail.startDateLocal,
    distanceKm: detail.distanceKm,
    movingTimeSec: detail.movingTimeSec,
    timeSec: detail.streams?.timeSec,
    distanceM: detail.streams?.distanceM,
  }) : [];
  const runKind = classifyRun(session);
  const plannedText = planDay?.plannedText.trim() || planDay?.legacyPlannedText.trim();

  return (
    <section className="activity-detail-page">
      <button type="button" className="activity-page-back" onClick={onBack}>
        <ArrowLeft size={17} aria-hidden="true" /> Back to your log
      </button>
      <article className="activity-detail-card">
        <header className="activity-detail-heading">
          <div>
            <p>
              {formatRunDate(activity.startDateLocal || activity.startDate)}
              <span aria-hidden="true">·</span>
              {formatRunTime(activity.startDateLocal || activity.startDate)}
              <span aria-hidden="true">·</span>
              {activity.sportType.replaceAll('_', ' ')}
            </p>
            <h2>{activity.name}</h2>
          </div>
          <span className={`activity-kind-pill tone-${runKind.tone}`}>{runKind.label}</span>
          {loading && <small>Loading stream data…</small>}
        </header>

        <div className="activity-detail-layout">
          <div className="activity-detail-main">
            <section className="activity-route-panel" aria-label="Activity route">
              <Suspense fallback={<div className="activity-route-map-empty">Loading route map…</div>}>
                <LazyActivityRouteMap activity={detail ?? session.activity} />
              </Suspense>
            </section>
            <div className="activity-mobile-overview" aria-label="Run overview">
              <RunRead classification={runKind} session={session} />
              <PrimaryRunMetrics activity={activity} session={session} />
            </div>
            <ActivityEffortStrip totals={hrZoneTotals} loading={loading} />
            <ActivityBestEfforts groups={bestEfforts} loading={loading} />
            <section className="activity-analysis-panel" aria-labelledby="activity-analysis-heading">
              <header className="activity-analysis-heading">
                <div><span>Run data</span><h2 id="activity-analysis-heading">Splits and load analysis</h2></div>
                <small>Stream and model detail</small>
              </header>
              <Suspense fallback={<div className="surface-loading">Loading run charts…</div>}>
                <LazyActivityRunCharts detail={detail} loading={loading} laps={lapSplits} />
              </Suspense>
              {recordedLapSplits.length > 0 && (
                <LapSplitsTable
                  splits={recordedLapSplits}
                  loading={loading}
                  title="Device-recorded laps"
                  sourceLabel="Garmin lap button / auto lap"
                  showStrideDefinition
                />
              )}
              <LapSplitsTable
                splits={kilometreSplits}
                loading={loading}
                title="Kilometre splits"
                sourceLabel="Derived from continuous distance"
              />
              <div className="preview-stat-grid">
                <Metric label="Session stress" value={session.load.toFixed(1)} />
                <Metric label="External fallback" value={session.paceFallbackLoad.toFixed(1)} />
                <Metric label="HR response" value={formatHrCostResidual(session.hrCostResidualBpm)} />
                <Metric label="LPS" value={formatLydiardPowerStress(session)} />
              </div>
              <div className="preview-stat-grid">
                <Metric label="Pace IF" value={session.externalIntensityFactor.toFixed(2)} />
                <Metric label="Load source" value={formatLoadSource(session.loadSource)} />
                <Metric label="W/bpm" value={session.powerHrRatio?.toFixed(2) ?? '-'} />
                <Metric label="Split" value={split ? `${formatPace(split.first)} / ${formatPace(split.second)}` : formatDecoupling(activity.decouplingPct)} />
              </div>
              {session.flags.length > 0 && <div className="preview-flags">{session.flags.map((flag) => <span key={flag}>{flag}</span>)}</div>}
            </section>
          </div>

          <aside className="activity-detail-sidebar">
            {plannedText && (
              <section className="activity-plan-match" aria-label="Planned and completed session">
                <div>
                  <small>Planned</small>
                  <strong>{plannedText}</strong>
                </div>
                <span aria-hidden="true">→</span>
                <div>
                  <small>Completed</small>
                  <strong>{runKind.label} run</strong>
                </div>
              </section>
            )}
            <RunRead classification={runKind} session={session} />
            <PrimaryRunMetrics activity={activity} session={session} />
            {planDay?.notes && planDay.notes.length > 0 && (
              <section className="preview-plan-note" aria-label="Day note">
                <header>
                  <span>Day note</span>
                  <small>{planDay.source === 'legacy-google-sheet' ? 'Imported from RUNMASTER' : 'Plan'}</small>
                </header>
                <p>{planDay.notes}</p>
              </section>
            )}
            <ActivityNoteEditor activityId={activity.id} note={activity.activityNote ?? ''} onSave={onSaveNote} />
          </aside>
        </div>
      </article>
    </section>
  );
}

function ActivityBestEfforts({ groups, loading }: { groups: ReturnType<typeof streamBestEffortsForActivity>; loading: boolean }) {
  if (loading && groups.length === 0) {
    return <section className="activity-best-efforts"><p>Calculating best efforts from the distance stream…</p></section>;
  }
  if (groups.length === 0) {
    return null;
  }
  return (
    <section className="activity-best-efforts" aria-labelledby="activity-best-efforts-heading">
      <header>
        <div>
          <span>Best efforts in this run</span>
          <h3 id="activity-best-efforts-heading">Fastest distance segments</h3>
        </div>
        <small>Measured from the continuous distance stream</small>
      </header>
      <div>
        {groups.map((group) => {
          const effort = group.efforts[0];
          return (
            <article key={group.label}>
              <span>{group.label}</span>
              <strong>{formatDuration(effort.seconds)}</strong>
              <small>{formatPace(effort.paceSecPerKm)}</small>
              {effort.segmentStartSec !== undefined && effort.segmentEndSec !== undefined && (
                <em>{formatDuration(effort.segmentStartSec)}–{formatDuration(effort.segmentEndSec)} into run</em>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function RunRead({ classification, session }: { classification: RunClassification; session: SessionLoad }) {
  const tags = [classification.label, formatLoadSource(session.loadSource), ...session.flags].slice(0, 3);
  return (
    <section className={`activity-run-read tone-${classification.tone}`} aria-label="Run classification">
      <header>
        <span>Run read</span>
        <strong>{runReadHeadline(classification.key)}</strong>
      </header>
      <p>{runReadCopy(classification.key, session)}</p>
      <div>{tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
    </section>
  );
}

function PrimaryRunMetrics({ activity, session }: { activity: ActivitySummary; session: SessionLoad }) {
  return (
    <div className="preview-stat-grid preview-primary-stats" aria-label="General run metrics">
      <Metric label="Distance" value={`${activity.distanceKm.toFixed(1)} km`} />
      <Metric label="Moving time" value={formatDuration(activity.movingTimeSec)} />
      <Metric label="Avg pace" value={formatPace(activityPaceSecPerKm(activity))} />
      <Metric label="Avg HR" value={activity.averageHeartRate ? `${Math.round(activity.averageHeartRate)} bpm` : '-'} />
      <Metric label="Elevation" value={`${Math.round(activity.elevationGainM)} m`} />
      <Metric label="Load" value={session.load.toFixed(1)} />
    </div>
  );
}

function runReadHeadline(kind: RunKind): string {
  switch (kind) {
    case 'session': return 'Quality session';
    case 'long': return 'Long aerobic load';
    case 'steady': return 'Controlled aerobic';
    case 'easy': return 'Easy aerobic';
  }
}

function runReadCopy(kind: RunKind, session: SessionLoad): string {
  const pacePct = Math.round(session.externalIntensityFactor * 100);
  const hrRead = session.heartRateIntensityFactor
    ? ` Average heart rate sat at ${Math.round(session.heartRateIntensityFactor * 100)}% of estimated threshold.`
    : '';
  switch (kind) {
    case 'session':
      return `This registered as quality work, with pace at ${pacePct}% of estimated threshold speed.${hrRead} The load model recorded ${session.load.toFixed(1)} stress from the available run evidence.`;
    case 'long':
      return `This registered as a long aerobic run: load reached ${session.load.toFixed(1)} without crossing a quality-work intensity threshold. Pace averaged ${pacePct}% of estimated threshold speed.${hrRead}`;
    case 'steady':
      return `This was controlled aerobic work. Pace averaged ${pacePct}% of estimated threshold speed and the session load was ${session.load.toFixed(1)}.${hrRead}`;
    case 'easy':
      return `This stayed in the easy aerobic range. Pace averaged ${pacePct}% of estimated threshold speed and the session load was ${session.load.toFixed(1)}.${hrRead}`;
  }
}

function ActivityEffortStrip({ totals, loading }: { totals?: HrZoneTotal[]; loading: boolean }) {
  const totalSeconds = totals?.reduce((total, item) => total + item.seconds, 0) ?? 0;
  const activeTotals = totals?.filter((item) => item.seconds > 0) ?? [];
  return (
    <section className="activity-effort-strip" aria-label="Heart rate zone distribution">
      <header>
        <span>Where your effort landed</span>
        <small>{totalSeconds > 0 ? formatDuration(totalSeconds) : loading ? 'Loading HR…' : 'No HR stream'}</small>
      </header>
      {totalSeconds > 0 ? (
        <>
          <div className="activity-effort-bar" aria-hidden="true">
            {activeTotals.map((item) => (
              <i
                key={item.zone.key}
                className={`tone-${item.zone.tone}`}
                style={{ width: `${(item.seconds / totalSeconds) * 100}%` }}
              />
            ))}
          </div>
          <div className="activity-effort-legend">
            {activeTotals.map((item) => (
              <span key={item.zone.key} className={`tone-${item.zone.tone}`}>
                <i aria-hidden="true" />
                {item.zone.name} <strong>{Math.round((item.seconds / totalSeconds) * 100)}%</strong>
              </span>
            ))}
          </div>
        </>
      ) : (
        <p>{loading ? 'Loading heart-rate stream.' : 'Heart-rate distribution is unavailable for this run.'}</p>
      )}
    </section>
  );
}

function ActivityNoteEditor({
  activityId,
  note,
  onSave,
}: {
  activityId: string;
  note: string;
  onSave: (activityId: string, note: string) => Promise<string>;
}) {
  const [draft, setDraft] = useState(note);
  const [saved, setSaved] = useState(note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(note);
    setSaved(note);
    setError('');
  }, [activityId, note]);

  const changed = draft !== saved;
  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    setError('');
    try {
      const next = await onSave(activityId, draft);
      setSaved(next);
      setDraft(next);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the note.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="activity-note-editor" aria-label="Training note">
      <header>
        <span><MessageSquareText size={15} aria-hidden="true" /> Training note</span>
        <small>{changed ? 'Unsaved' : saved ? 'Saved' : 'Add how it felt'}</small>
      </header>
      <textarea
        rows={3}
        value={draft}
        disabled={saving}
        placeholder="How did it feel? Add session, recovery, pain, weather or life context…"
        onChange={(event) => setDraft(event.target.value)}
      />
      <div>
        <button type="button" disabled={!changed || saving} onClick={() => void save()}>
          <Save size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save note'}
        </button>
        {changed && <button type="button" disabled={saving} onClick={() => setDraft(saved)}>Cancel</button>}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function LapSplitsTable({
  splits,
  loading,
  title,
  sourceLabel,
  showStrideDefinition = false,
}: {
  splits: ActivityLapView[];
  loading: boolean;
  title: string;
  sourceLabel: string;
  showStrideDefinition?: boolean;
}) {
  return (
    <section className="preview-lap-splits" aria-label={title}>
      <header>
        <span>{title}</span>
        <small>{splits.length > 0 ? sourceLabel : loading ? 'loading' : 'data unavailable'}</small>
      </header>
      {splits.length > 0 ? (
        <div className="lap-split-table-wrap">
          <table className="lap-split-table">
            <thead>
              <tr>
                <th>Lap</th>
                <th>Dist</th>
                <th title="Net elevation change">Elev Δ</th>
                <th>Time</th>
                <th>Pace</th>
                <th>HR avg</th>
                <th>HR max</th>
                <th>Zone</th>
                <th>W</th>
              </tr>
            </thead>
            <tbody>
              {splits.map((split) => (
                <tr key={split.label}>
                  <td>{split.label}</td>
                  <td>{split.distanceKm.toFixed(split.distanceKm >= 0.95 ? 1 : 2)}</td>
                  <td>{formatElevationChange(split.elevationChangeM)}</td>
                  <td>{formatDuration(split.durationSec)}</td>
                  <td>{formatCompactPace(split.paceSecPerKm)}</td>
                  <td>{split.averageHeartRate ? Math.round(split.averageHeartRate) : '-'}</td>
                  <td>{split.maxHeartRate ? Math.round(split.maxHeartRate) : '-'}</td>
                  <td><span className={`lap-zone zone-${split.zone.key}`}>{split.zone.label}</span></td>
                  <td>{split.averagePower ? Math.round(split.averagePower) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="split-placeholder compact">{loading ? `Loading ${title.toLowerCase()}.` : `${title} are unavailable for this run.`}</div>
      )}
      {showStrideDefinition && splits.length > 0 && <p className="lap-zone-definition">Strides are recorded laps under 200 m at a distinctly faster pace than the run average.</p>}
    </section>
  );
}

function formatElevationChange(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  if (rounded > 0) return `+${rounded} m`;
  if (rounded < 0) return `−${Math.abs(rounded)} m`;
  return '0 m';
}

function TrainingKpi({
  icon,
  label,
  value,
  detail,
  info,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  info?: MetricKey;
}) {
  return (
    <article className="training-kpi">
      <span aria-hidden="true">{icon}</span>
      <div>
        <p>
          {label}
          {info && <MetricInfo metric={info} align="right" />}
        </p>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function RunMetric({ icon, label, value, tone }: { icon?: ReactNode; label: string; value: string; tone: MetricTone }) {
  return (
    <span className={`calendar-run-metric tone-${tone}`}>
      {icon}
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="compact-metric">
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

function scopeLoadModel(model: TrainingLoadModel, gymSessions: GymSession[], currentWeekId: string) {
  const sessionsAsc = model.sessions;
  const sessions = [...sessionsAsc].reverse();
  const weekIds = new Set(sessionsAsc.map((session) => session.weekId));
  const weeks = model.weeks.filter((week) => weekIds.has(week.weekId)).reverse();
  const daily = model.daily;
  // Gym rides alongside runs: grouped by the same ISO week but never scored.
  const gymInRange = gymSessions;
  const gymByWeek = new Map<string, GymSession[]>();
  for (const session of gymInRange) {
    const weekId = toWeekIdUtc(session.startDate);
    const bucket = gymByWeek.get(weekId);
    if (bucket) {
      bucket.push(session);
    } else {
      gymByWeek.set(weekId, [session]);
    }
  }

  const entriesById = new Map<string, WeekEntry>();
  for (const week of weeks) {
    entriesById.set(week.weekId, { weekId: week.weekId, week, gym: gymByWeek.get(week.weekId) ?? [] });
  }
  for (const [weekId, gym] of gymByWeek) {
    if (!entriesById.has(weekId)) {
      entriesById.set(weekId, { weekId, gym });
    }
  }
  if (!entriesById.has(currentWeekId)) {
    entriesById.set(currentWeekId, { weekId: currentWeekId, gym: [] });
  }
  const occupiedWeekIds = [...entriesById.keys()].sort();
  if (occupiedWeekIds.length > 0) {
    const oldestWeekMs = new Date(`${occupiedWeekIds[0]}T00:00:00Z`).getTime();
    const newestWeekMs = new Date(`${occupiedWeekIds[occupiedWeekIds.length - 1]}T00:00:00Z`).getTime();
    for (let weekMs = oldestWeekMs; weekMs <= newestWeekMs; weekMs += 7 * DAY_MS) {
      const weekId = new Date(weekMs).toISOString().slice(0, 10);
      if (!entriesById.has(weekId)) entriesById.set(weekId, { weekId, gym: [] });
    }
  }
  const weekEntries = [...entriesById.values()].sort((a, b) => b.weekId.localeCompare(a.weekId));

  return {
    sessions,
    weeks,
    weekEntries,
    daily,
    months: buildMonthNav(sessions, weekEntries),
    distanceKm: sessions.reduce((total, session) => total + session.activity.distanceKm, 0),
    durationSec: sessions.reduce((total, session) => total + session.activity.movingTimeSec, 0),
    gymCount: gymInRange.length,
  };
}

function buildMonthNav(sessions: SessionLoad[], weekEntries: WeekEntry[]) {
  const runCountByMonth = new Map<string, number>();
  for (const session of sessions) {
    const id = session.day.slice(0, 7);
    runCountByMonth.set(id, (runCountByMonth.get(id) ?? 0) + 1);
  }
  const monthIds = new Set(weekEntries.map((entry) => monthIdFromEntry(entry)));
  return [...monthIds].map((id) => ({
    id,
    label: formatMonthLabel(`${id}-01`),
    count: runCountByMonth.get(id) ?? 0,
  }));
}

function monthIdFromEntry(entry: WeekEntry): string {
  if (entry.week) {
    const latestSession = entry.week.sessions[entry.week.sessions.length - 1];
    return (latestSession?.day ?? entry.weekId).slice(0, 7);
  }
  return entry.weekId.slice(0, 7);
}

function buildTrainingZoneModel(
  physiology: PhysiologyEstimate | undefined,
  thresholds: TrainingLoadModel['thresholds'],
): TrainingZoneModel {
  if (physiology?.zones.length) {
    return {
      zones: physiology.zones.map((zone, index) => physiologyTrainingZone(zone, index)),
      title: 'Physiology pace, HR and power',
      context: physiologyEvidenceContext(physiology),
      physiologyBacked: true,
    };
  }
  return {
    zones: buildFallbackTrainingZones(thresholds),
    title: 'Suggested pace, HR and power · low confidence',
    context: 'Low-confidence fallback: summary pace percentiles and inferred HR threshold. No effective physiology estimate was supplied.',
    physiologyBacked: false,
  };
}

function physiologyTrainingZone(zone: PracticalZone, index: number): TrainingZone {
  const hrMin = finiteZoneBoundary(zone.heartRateBpm?.low);
  const hrMax = finiteZoneBoundary(zone.heartRateBpm?.high);
  return {
    key: zone.name,
    label: `Z${index + 1}`,
    name: zone.label,
    tone: toneForPhysiologyZone(zone.name),
    paceRange: formatPhysiologyPaceRange(zone.pace),
    hrRange: formatPhysiologyNumericRange(zone.heartRateBpm, 'bpm'),
    powerRange: formatPhysiologyPowerRange(zone),
    hrMin,
    hrMax,
    domain: zone.domain,
    control: zone.control,
  };
}

function buildFallbackTrainingZones(thresholds: TrainingLoadModel['thresholds']): TrainingZone[] {
  return ZONE_TEMPLATES.map((template) => {
    const hrMin = thresholds.thresholdHeartRate && template.hrMinRatio
      ? Math.round(thresholds.thresholdHeartRate * template.hrMinRatio)
      : undefined;
    const hrMax = thresholds.thresholdHeartRate && template.hrMaxRatio
      ? Math.round(thresholds.thresholdHeartRate * template.hrMaxRatio)
      : undefined;
    return {
      key: template.key,
      label: template.label,
      name: template.name,
      tone: template.tone,
      paceRange: formatZonePaceRange(thresholds.thresholdPaceSecPerKm, template.ifMin, template.ifMax),
      hrRange: formatHrZoneRange(hrMin, hrMax),
      powerRange: formatZonePowerRange(thresholds.thresholdPower, template.ifMin, template.ifMax),
      hrMin,
      hrMax,
    };
  });
}

function physiologyEvidenceContext(physiology: PhysiologyEstimate): string {
  const parts = [`Effective ${formatEvidenceDate(physiology.asOf)}`];
  if (physiology.criticalSpeed) {
    parts.push(
      `critical speed ${physiology.criticalSpeed.confidence} confidence · ${physiology.criticalSpeed.evidence.length} evidence ${physiology.criticalSpeed.evidence.length === 1 ? 'effort' : 'efforts'}`,
    );
  } else {
    parts.push('critical speed withheld');
  }
  if (physiology.canonicalCriticalPower) {
    const cp = physiology.canonicalCriticalPower;
    parts.push(
      `CP ${Math.round(cp.watts)} W (${cp.confidence}, ${cp.source.replaceAll('_', ' ')}, effective ${formatEvidenceDate(cp.effectiveFrom)})`,
    );
  } else {
    parts.push('CP withheld');
  }
  const lt1 = physiology.lt1HeartRate;
  const lt2 = physiology.lt2HeartRate;
  if (lt1 || lt2) {
    parts.push(
      `HR evidence LT1 ${lt1 ? `${lt1.confidence}/${lt1.evidence.length}` : 'withheld'} · LT2 ${lt2 ? `${lt2.confidence}/${lt2.evidence.length}` : 'withheld'}`,
    );
  } else {
    parts.push('HR boundaries withheld');
  }
  return parts.join(' · ');
}

function formatEvidenceDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
    : value;
}

function toneForPhysiologyZone(name: PracticalZone['name']): MetricTone {
  if (name === 'vo2_anaerobic') {
    return 'danger';
  }
  if (name === 'threshold') {
    return 'hard';
  }
  if (name === 'steady') {
    return 'moderate';
  }
  return 'easy';
}

function finiteZoneBoundary(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? Math.round(value) : undefined;
}

function isFinitePositiveValue(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function formatPhysiologyPaceRange(pace: PracticalZone['pace']): string {
  const fast = pace?.fastSecPerKm;
  const slow = pace?.slowSecPerKm;
  if (isFinitePositiveValue(fast) && isFinitePositiveValue(slow)) {
    return `${formatCompactPace(fast)}-${formatCompactPace(slow)}`;
  }
  if (isFinitePositiveValue(fast)) {
    return `>${formatCompactPace(fast)}`;
  }
  if (isFinitePositiveValue(slow)) {
    return `<${formatCompactPace(slow)}`;
  }
  return '-';
}

function formatPhysiologyNumericRange(
  range: { low?: number; high?: number } | undefined,
  unit: string,
): string {
  const low = finiteZoneBoundary(range?.low);
  const high = finiteZoneBoundary(range?.high);
  if (low !== undefined && high !== undefined) {
    return `${low}-${high} ${unit}`;
  }
  if (high !== undefined) {
    return `<${high} ${unit}`;
  }
  if (low !== undefined) {
    return `>${low} ${unit}`;
  }
  return '-';
}

function formatPhysiologyPowerRange(zone: PracticalZone): string {
  const watts = formatPhysiologyNumericRange(zone.powerWatts, 'W');
  const percent = formatPhysiologyPercentRange(zone.powerPctCp);
  return watts === '-' ? percent : percent === '-' ? watts : `${watts} · ${percent}`;
}

function formatPhysiologyPercentRange(range: { low?: number; high?: number } | undefined): string {
  const low = range?.low !== undefined && Number.isFinite(range.low) ? Math.round(range.low * 100) : undefined;
  const high = range?.high !== undefined && Number.isFinite(range.high) ? Math.round(range.high * 100) : undefined;
  if (low !== undefined && high !== undefined) {
    return `${low}-${high}% CP`;
  }
  if (high !== undefined) {
    return `<${high}% CP`;
  }
  if (low !== undefined) {
    return `>${low}% CP`;
  }
  return '-';
}

function formatZonePaceRange(thresholdPaceSecPerKm: number, ifMin?: number, ifMax?: number): string {
  if (!thresholdPaceSecPerKm || !Number.isFinite(thresholdPaceSecPerKm)) {
    return '-';
  }
  if (ifMax && !ifMin) {
    return `>${formatCompactPace(thresholdPaceSecPerKm / ifMax)}`;
  }
  if (ifMin && !ifMax) {
    return `<${formatCompactPace(thresholdPaceSecPerKm / ifMin)}`;
  }
  if (ifMin && ifMax) {
    const fast = thresholdPaceSecPerKm / ifMax;
    const slow = thresholdPaceSecPerKm / ifMin;
    return `${formatCompactPace(fast)}-${formatCompactPace(slow)}`;
  }
  return '-';
}

function formatZonePowerRange(thresholdPower: number | undefined, ifMin?: number, ifMax?: number): string {
  if (!thresholdPower || !Number.isFinite(thresholdPower)) {
    return '-';
  }
  const low = ifMin ? Math.round(thresholdPower * ifMin) : undefined;
  const high = ifMax ? Math.round(thresholdPower * ifMax) : undefined;
  if (low !== undefined && high !== undefined) {
    return `${low}-${high} W`;
  }
  if (high !== undefined) {
    return `<${high} W`;
  }
  if (low !== undefined) {
    return `>${low} W`;
  }
  return '-';
}

function formatHrZoneRange(min?: number, max?: number): string {
  if (max && !min) {
    return `<${max}`;
  }
  if (min && !max) {
    return `>${min}`;
  }
  if (min && max) {
    return `${min}-${max}`;
  }
  return '-';
}

function buildWeekCalendarDays(
  weekId: string,
  sessions: SessionLoad[],
  gym: GymSession[],
  planByDate: Map<string, TrainingPlanDay>,
): CalendarDay[] {
  const weekStart = new Date(`${weekId}T00:00:00Z`).getTime();
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(weekStart + index * DAY_MS);
    const dayId = day.toISOString().slice(0, 10);
    const daySessions = sessions
      .filter((session) => session.day === dayId)
      .sort((a, b) => new Date(a.activity.startDate).getTime() - new Date(b.activity.startDate).getTime());
    const dayGym = gym
      .filter((session) => (session.startDateLocal || session.startDate).slice(0, 10) === dayId)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    return {
      dayId,
      weekday: WEEKDAY_LABELS[index],
      dateLabel: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(day),
      sessions: daySessions,
      gym: dayGym,
      distanceKm: daySessions.reduce((total, session) => total + session.activity.distanceKm, 0),
      load: daySessions.reduce((total, session) => total + session.load, 0),
      tone: toneForDay(daySessions),
      planDay: planByDate.get(dayId),
    };
  });
}

function toneForDay(sessions: SessionLoad[]): MetricTone {
  if (sessions.length === 0) {
    return 'muted';
  }
  const load = sessions.reduce((total, session) => total + session.load, 0);
  const hardest = Math.max(...sessions.map((session) => session.externalIntensityFactor));
  if (load >= 120 || hardest >= 0.96) {
    return 'danger';
  }
  if (load >= 75 || hardest >= 0.88) {
    return 'hard';
  }
  if (load >= 35 || hardest >= 0.76) {
    return 'moderate';
  }
  return 'easy';
}

function toneForLoad(load: number): MetricTone {
  if (load >= 100) {
    return 'danger';
  }
  if (load >= 70) {
    return 'hard';
  }
  if (load >= 35) {
    return 'moderate';
  }
  return 'easy';
}

function toneForEffort(intensityFactor: number): MetricTone {
  if (intensityFactor >= 0.96) {
    return 'danger';
  }
  if (intensityFactor >= 0.88) {
    return 'hard';
  }
  if (intensityFactor >= 0.76) {
    return 'moderate';
  }
  return 'easy';
}

function toneForHeartRate(session: SessionLoad): MetricTone {
  if (!session.activity.averageHeartRate) {
    return 'muted';
  }
  if ((session.hrCostResidualBpm ?? 0) >= 8) {
    return 'danger';
  }
  if ((session.hrCostResidualBpm ?? 0) >= 5) {
    return 'hard';
  }
  return 'easy';
}

function toneForDecoupling(value?: number): MetricTone {
  if (value === undefined) {
    return 'muted';
  }
  if (value >= 8) {
    return 'danger';
  }
  if (value >= 5) {
    return 'hard';
  }
  if (value >= 3) {
    return 'moderate';
  }
  return 'easy';
}

function toneForElevation(elevationGainM: number): MetricTone {
  if (elevationGainM >= 300) {
    return 'hard';
  }
  if (elevationGainM >= 120) {
    return 'moderate';
  }
  return 'muted';
}

function classifyRun(session: SessionLoad): RunClassification {
  const paceIf = session.externalIntensityFactor;
  const hrIf = session.heartRateIntensityFactor;
  const powerIf = session.powerIntensityFactor;
  const sessionReasons: string[] = [];

  if (paceIf >= 0.85) {
    sessionReasons.push(`Pace IF ${paceIf.toFixed(2)} is >= 0.85, the session threshold for quality pace work.`);
  }
  if ((hrIf ?? 0) >= 0.92) {
    sessionReasons.push(`HR IF ${formatOptionalIf(hrIf)} is >= 0.92, so the heart-rate cost looks session-like.`);
  }
  if ((powerIf ?? 0) >= 0.88) {
    sessionReasons.push(`Power IF ${formatOptionalIf(powerIf)} is >= 0.88, so the power cost looks session-like.`);
  }
  if (session.flags.includes('quality load')) {
    sessionReasons.push('The load model flagged this run as quality load from its combined stress signals.');
  }

  if (sessionReasons.length > 0) {
    return { key: 'session', label: 'Session', tone: 'danger', reasons: sessionReasons };
  }

  if (session.load >= 70) {
    return {
      key: 'long',
      label: 'Long easy',
      tone: 'hard',
      reasons: [
        `Session load ${session.load.toFixed(1)} is >= 70, which marks a long aerobic stress day.`,
        `No session threshold was crossed: pace IF ${paceIf.toFixed(2)}, HR IF ${formatOptionalIf(hrIf)}, power IF ${formatOptionalIf(powerIf)}.`,
      ],
    };
  }

  if (session.externalIntensityFactor >= 0.76) {
    return {
      key: 'steady',
      label: 'Steady',
      tone: 'moderate',
      reasons: [
        `Pace IF ${paceIf.toFixed(2)} is between 0.76 and 0.84, the steady training band.`,
        `Session load ${session.load.toFixed(1)} is below 70, so this is not labelled as a long run.`,
      ],
    };
  }

  return {
    key: 'easy',
    label: 'Easy',
    tone: 'easy',
    reasons: [
      `Pace IF ${paceIf.toFixed(2)} is below 0.76, the steady threshold.`,
      `No HR, power, or combined-load flag crossed the session thresholds.`,
    ],
  };
}

function calendarRunSummary(kind: RunKind): string {
  switch (kind) {
    case 'session':
      return 'Quality work';
    case 'long':
      return 'Long aerobic load';
    case 'steady':
      return 'Controlled aerobic';
    case 'easy':
      return 'Low stress';
  }
}

function formatOptionalIf(value?: number): string {
  return value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(2);
}

function formatHrCostResidual(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return '-';
  }
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} bpm`;
}

function formatLydiardPowerStress(session: SessionLoad): string {
  const canonicalPower =
    session.reliability === 'canonical-stream' &&
    /lydiard|power|stryd|rss/i.test(session.loadSource);
  return canonicalPower && session.powerLoad !== undefined ? session.powerLoad.toFixed(1) : '-';
}

function formatLoadSource(source: string): string {
  return source.replaceAll('_', ' ').replaceAll('-', ' ');
}

function splitPaces(detail: ActivityDetail): { first: number; second: number } | undefined {
  const time = detail.streams?.timeSec;
  const distance = detail.streams?.distanceM;
  if (!time || !distance) {
    return undefined;
  }
  const n = Math.min(time.length, distance.length);
  if (n < 6) {
    return undefined;
  }
  const midTime = time[0] + (time[n - 1] - time[0]) / 2;
  let mid = 1;
  while (mid < n - 1 && time[mid] < midTime) {
    mid += 1;
  }
  const firstTime = time[mid] - time[0];
  const secondTime = time[n - 1] - time[mid];
  const firstDistanceKm = (distance[mid] - distance[0]) / 1000;
  const secondDistanceKm = (distance[n - 1] - distance[mid]) / 1000;
  if (firstTime <= 0 || secondTime <= 0 || firstDistanceKm <= 0 || secondDistanceKm <= 0) {
    return undefined;
  }
  return {
    first: firstTime / firstDistanceKm,
    second: secondTime / secondDistanceKm,
  };
}

function buildHrZoneTotals(detail: ActivityDetail, zones: TrainingZone[]): HrZoneTotal[] | undefined {
  const time = detail.streams?.timeSec;
  const heartRate = detail.streams?.heartrate;
  if (!time || !heartRate || !zones.some((zone) => zone.hrMin || zone.hrMax)) {
    return undefined;
  }
  const n = Math.min(time.length, heartRate.length);
  if (n < 2) {
    return undefined;
  }
  const totals = zones.map((zone) => ({ zone, seconds: 0 }));
  for (let index = 1; index < n; index += 1) {
    const start = time[index - 1];
    const end = time[index];
    const dt = end - start;
    const bpm = heartRate[index - 1];
    if (!Number.isFinite(dt) || dt <= 0 || dt > 300 || !isUsefulPreviewHeartRate(bpm)) {
      continue;
    }
    const bucket = totals.find((item) => isHeartRateInZone(bpm, item.zone));
    if (bucket) {
      bucket.seconds += dt;
    }
  }
  return totals.map((item) => ({ ...item, seconds: Math.round(item.seconds) }));
}

function isHeartRateInZone(value: number, zone: TrainingZone): boolean {
  const aboveMin = zone.hrMin === undefined || value >= zone.hrMin;
  const belowMax = zone.hrMax === undefined || value < zone.hrMax;
  return aboveMin && belowMax;
}

function isUsefulPreviewHeartRate(value: number): boolean {
  return Number.isFinite(value) && value >= 80 && value <= 220;
}

function subtractMonths(anchorMs: number, months: number): number {
  const date = new Date(anchorMs);
  date.setMonth(date.getMonth() - months);
  return date.getTime();
}

function formatRunDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

function formatRunTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function notePreview(note: string): string {
  return note.length > 100 ? `${note.slice(0, 100)}…` : note;
}

function formatCompactPace(totalSeconds: number): string {
  return formatPace(totalSeconds).replace('/km', '');
}

function formatMonthLabel(day: string): string {
  return new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' }).format(new Date(`${day}T00:00:00Z`));
}

function formatWeekIdLabel(weekId: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(`${weekId}T00:00:00Z`),
  );
}

function formatGymDay(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
}

function gymTitle(session: GymSession): string {
  const parts = [session.name, formatGymDay(session.startDateLocal || session.startDate)];
  if (session.durationSec > 0) {
    parts.push(`${Math.round(session.durationSec / 60)} min`);
  }
  if (session.calories) {
    parts.push(`${Math.round(session.calories)} kcal`);
  }
  return parts.join(' · ');
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

function formatLifetimeDuration(totalSeconds: number): string {
  const totalHours = Math.round(totalSeconds / 3600);
  if (totalHours < 1000) return `${totalHours.toLocaleString()}h`;
  return `${(totalHours / 1000).toFixed(totalHours >= 10_000 ? 0 : 1)}k h`;
}

function formatHoursMinutes(hours: number): string {
  const minutes = Math.round(hours * 60);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function formatDecoupling(value?: number): string {
  if (value === undefined) {
    return '-';
  }
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function percentile(values: number[], ratio: number): number | undefined {
  const clean = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (clean.length === 0) {
    return undefined;
  }
  const index = Math.min(clean.length - 1, Math.max(0, Math.round((clean.length - 1) * ratio)));
  return clean[index];
}
