import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
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
  X,
  Zap,
} from 'lucide-react';
import { formatPace } from '../analysis/fatigue';
import {
  buildTrainingLoadModel,
  type CanonicalActivityMetric,
  type SessionLoad,
  type TrainingLoadModel,
  type WeekLoadSummary,
} from '../analysis/loadModel';
import type { PhysiologyEstimate, PracticalZone } from '../analysis/coachEngine';
import { getActivity } from '../data/api';
import { activityPaceSecPerKm, decodePolyline, toWeekIdUtc } from '../data/mapRoutes';
import type { ActivityDetail, ActivitySummary, GymSession, TrainingPlanDay, WeeklyAnalysis } from '../types';
import { MetricInfo, MetricsGuide, type MetricKey } from './MetricInfo';

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
  onRequestFullHistory: () => Promise<void>;
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

type RangeKey = '3m' | '6m' | '12m' | '10y' | 'all';
type MetricTone = 'easy' | 'moderate' | 'hard' | 'danger' | 'muted';
type RunKind = 'easy' | 'steady' | 'long' | 'session';

interface RunClassification {
  key: RunKind;
  label: string;
  tone: MetricTone;
  summary: string;
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

interface LapSplit {
  label: string;
  distanceKm: number;
  durationSec: number;
  paceSecPerKm: number;
  averageHeartRate?: number;
  averagePower?: number;
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

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string; months?: number }> = [
  { key: '3m', label: '3m', months: 3 },
  { key: '12m', label: '12m', months: 12 },
  { key: 'all', label: 'All' },
];

const INITIAL_WEEK_COUNT = 12;
const WEEK_CHUNK = 10;
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
  onRequestFullHistory,
}: TrainingViewProps) {
  const [range, setRange] = useState<RangeKey>('3m');
  const [showGuide, setShowGuide] = useState(false);
  const [visibleWeekCount, setVisibleWeekCount] = useState(INITIAL_WEEK_COUNT);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewDetail, setPreviewDetail] = useState<ActivityDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const detailCache = useRef(new Map<string, ActivityDetail>());
  const scrollerRef = useRef<HTMLElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadModel = useMemo(
    () => buildTrainingLoadModel(activities, canonicalMetrics),
    [activities, canonicalMetrics],
  );
  const scoped = useMemo(() => scopeLoadModel(loadModel, range, gymSessions), [loadModel, range, gymSessions]);
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
  const openPreview = useCallback((activityId: string) => {
    setPreviewId(activityId);
    if (new URLSearchParams(window.location.search).get('view') === 'log') {
      window.history.pushState(null, '', `/?view=log&activity=${encodeURIComponent(activityId)}`);
    }
  }, []);

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
    const index = scoped.weekEntries.findIndex((entry) => entry.weekId === session.weekId);
    if (index >= 0) {
      setVisibleWeekCount((current) => Math.max(current, index + 1 + JUMP_BUFFER_WEEKS));
      setPendingJump(session.weekId);
    }
  }, [activityFocus?.id, activityFocus?.request, loadModel.sessionsById, scoped.weekEntries]);

  useEffect(() => {
    const onPopState = () => {
      const activityId = new URLSearchParams(window.location.search).get('activity');
      setPreviewId(activityId);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    setVisibleWeekCount(INITIAL_WEEK_COUNT);
  }, [range, loadModel.sessions.length]);

  useEffect(() => {
    const root = scrollerRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || visibleWeekCount >= scoped.weekEntries.length) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleWeekCount((current) => Math.min(scoped.weekEntries.length, current + WEEK_CHUNK));
        }
      },
      { root, rootMargin: '420px 0px 420px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scoped.weekEntries.length, visibleWeekCount]);

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
    getActivity(previewId)
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
  }, [previewId]);

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
    <main ref={scrollerRef} className="training-view training-log-view" aria-label="Training history">
      <section className="training-toolbar" aria-label="Training range">
        <div>
          <p className="eyebrow">
            <Activity size={15} aria-hidden="true" />
            Training log
          </p>
          <h2>Your runs and notes</h2>
        </div>
        <div className="training-range-controls">
          <div className="segmented compact-segmented" role="group" aria-label="Training range">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={range === option.key ? 'active' : ''}
                aria-pressed={range === option.key}
                onClick={() => {
                  setRange(option.key);
                  if (option.key === 'all') void onRequestFullHistory();
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          {scoped.months.length > 0 && (
            <label className="training-inline-jump">
              <span>
                <CalendarDays size={14} aria-hidden="true" />
                Jump
              </span>
              <select
                aria-label="Jump to month"
                value=""
                onChange={(event) => {
                  const monthId = event.target.value;
                  if (monthId) {
                    jumpToMonth(monthId);
                  }
                }}
              >
                <option value="">Month...</option>
                {scoped.months.map((month) => (
                  <option key={month.id} value={month.id}>
                    {month.label} ({month.count})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </section>

      <details className="training-advanced-summary">
        <summary>Training zones and load model</summary>
        <button
          type="button"
          className={`guide-toggle${showGuide ? ' active' : ''}`}
          aria-pressed={showGuide}
          aria-expanded={showGuide}
          onClick={() => setShowGuide((current) => !current)}
        >
          <BookOpen size={15} aria-hidden="true" /> Metrics guide
        </button>
        {showGuide && <MetricsGuide metrics={GUIDE_METRICS} />}
        <ZoneSummary model={trainingZoneModel} />

        <aside className="training-kpis training-kpis-wide" aria-label="Current training metrics">
          <TrainingKpi
            icon={<Timer size={18} />}
            label="Latest load"
            info="load"
            value={latestSession ? latestSession.load.toFixed(1) : '-'}
            detail={latestSession ? formatRunDate(latestSession.activity.startDateLocal || latestSession.activity.startDate) : 'no runs'}
          />
          <TrainingKpi
            icon={<ShieldAlert size={18} />}
            label="7-day fatigue"
            info="atl"
            value={latestDaily ? latestDaily.fatigue.toFixed(1) : '-'}
            detail="ATL"
          />
          <TrainingKpi
            icon={<TrendingUp size={18} />}
            label="42-day fitness"
            info="ctl"
            value={latestDaily ? latestDaily.fitness.toFixed(1) : '-'}
            detail="CTL"
          />
          <TrainingKpi
            icon={<Gauge size={18} />}
            label="Ramp"
            info="acwr"
            value={latestDaily ? latestDaily.acwr.toFixed(2) : '-'}
            detail="ATL / CTL"
          />
        </aside>

        <div className="training-additional-info-grid">
          <Metric label="Runs" value={String(runCount)} />
          <Metric label="Distance" value={`${Math.round(scoped.distanceKm)} km`} />
          <Metric label="Gym" value={String(gymCount)} />
          <Metric label="HR coverage" value={`${hrCount}/${runCount}`} />
          <Metric label="Power coverage" value={`${powerCount}/${runCount}`} />
        </div>
      </details>

      <section className="training-log-shell" aria-label="Activity log">
        <div className="training-week-list">
          {visibleWeeks.length > 0 ? (
            visibleWeeks.map((entry, index) => {
              const previous = visibleWeeks[index - 1];
              const currentMonth = monthIdFromEntry(entry);
              const showMonthAnchor = !previous || monthIdFromEntry(previous) !== currentMonth;
              return (
                <div key={entry.weekId} className="training-week-block-wrap" data-week={entry.weekId}>
                  {showMonthAnchor && <span id={`month-${currentMonth}`} className="month-anchor" />}
                  {entry.week ? (
                    <WeekBlock
                      week={entry.week}
                      gym={entry.gym}
                      analysis={analysisByWeek.get(entry.weekId)}
                      planByDate={planByDate}
                      previewId={previewId}
                      onPreview={openPreview}
                    />
                  ) : (
                    <GymOnlyBlock weekId={entry.weekId} gym={entry.gym} planByDate={planByDate} />
                  )}
                </div>
              );
            })
          ) : (
            <div className="training-empty">
              <Activity size={28} aria-hidden="true" />
              <h3>{usingSample ? 'Import Garmin data for run rows' : 'No runs in this range'}</h3>
            </div>
          )}
          {visibleWeekCount < scoped.weekEntries.length && <div ref={sentinelRef} className="training-scroll-sentinel" />}
        </div>

        {previewSession && (
          <div className="training-floating-preview" aria-label="Activity preview">
            <button
              type="button"
              className="floating-preview-close"
              aria-label="Close activity preview"
              onClick={() => {
                setPreviewId(null);
                if (new URLSearchParams(window.location.search).get('view') === 'log') window.history.replaceState(null, '', '/?view=log');
              }}
            >
              <X size={16} aria-hidden="true" />
            </button>
            <ActivityPreview
              detail={previewDetail}
              session={previewSession}
              loading={previewLoading}
              zones={trainingZoneModel.zones}
              planDay={previewPlanDay}
              onSaveNote={savePreviewNote}
            />
          </div>
        )}
      </section>
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
}: {
  week: WeekLoadSummary;
  gym: GymSession[];
  analysis?: WeeklyAnalysis;
  planByDate: Map<string, TrainingPlanDay>;
  previewId: string | null;
  onPreview: (id: string) => void;
}) {
  const days = buildWeekCalendarDays(week.weekId, week.sessions, gym, planByDate);
  return (
    <article className={`training-week-block ${week.severity}`}>
      <header className="training-week-head">
        <div>
          <p>{week.label}</p>
          <h3>{week.status}</h3>
        </div>
      </header>
      <div className="week-at-a-glance">
        <span>{week.activityCount} runs</span>
        <span>{week.distanceKm.toFixed(1)} km</span>
        <span>{week.durationHours.toFixed(1)} h</span>
      </div>
      <WeekCalendar
        days={days}
        previewId={previewId}
        onPreview={onPreview}
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

// A week with gym but no runs still shows, so gym history is never hidden.
function GymOnlyBlock({
  weekId,
  gym,
  planByDate,
}: {
  weekId: string;
  gym: GymSession[];
  planByDate: Map<string, TrainingPlanDay>;
}) {
  const days = buildWeekCalendarDays(weekId, [], gym, planByDate);
  return (
    <article className="training-week-block gym-only">
      <header className="training-week-head">
        <div>
          <p>Week of {formatWeekIdLabel(weekId)}</p>
          <h3>Gym week</h3>
        </div>
        <div className="week-gym-count">
          <Dumbbell size={16} aria-hidden="true" />
          <strong>{gym.length}</strong>
          <small>gym {gym.length === 1 ? 'session' : 'sessions'}</small>
        </div>
      </header>
      <WeekCalendar days={days} ariaLabel={`Week of ${formatWeekIdLabel(weekId)} gym calendar`} />
    </article>
  );
}

function WeekCalendar({
  days,
  previewId,
  onPreview,
  ariaLabel,
}: {
  days: CalendarDay[];
  previewId?: string | null;
  onPreview?: (id: string) => void;
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
        />
      ))}
    </div>
  );
}

function CalendarDayColumn({
  day,
  previewId,
  onPreview,
}: {
  day: CalendarDay;
  previewId: string | null;
  onPreview?: (id: string) => void;
}) {
  const hasRun = day.sessions.length > 0;
  const hasGym = day.gym.length > 0;
  const note = day.planDay?.notes;
  const hasNote = Boolean(note && note.length > 0);
  return (
    <section
      className={`week-day-cell tone-${day.tone}${hasRun ? ' has-run' : ''}${hasGym ? ' has-gym' : ''}${hasNote ? ' has-note' : ''}`}
      aria-label={`${day.weekday} ${day.dateLabel}`}
    >
      <header className="week-day-head">
        <span>{day.weekday}</span>
        <strong>{day.dateLabel}</strong>
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
            note={note}
          />
        ))}
        {day.gym.map((session) => (
          <GymSessionPill key={session.id} session={session} />
        ))}
        {hasNote && !hasRun && <CalendarDayNote note={note as string} />}
        {!hasRun && !hasGym && !hasNote && <span className="week-rest-label">Rest</span>}
      </div>
    </section>
  );
}

function CalendarRunCard({
  session,
  active,
  onPreview,
  note,
}: {
  session: SessionLoad;
  active: boolean;
  onPreview?: (id: string) => void;
  note?: string;
}) {
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const activity = session.activity;
  const effortTone = toneForEffort(session.externalIntensityFactor);
  const runKind = classifyRun(session);
  const openPreview = () => onPreview?.(activity.id);
  return (
    <button
      type="button"
      className={`calendar-run-card tone-${effortTone} run-${runKind.key}${active ? ' active' : ''}${session.hardLoad > 0 ? ' hard' : ''}`}
      onPointerDown={(event) => {
        event.stopPropagation();
        pointerStart.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        const start = pointerStart.current;
        pointerStart.current = null;
        if (!start) {
          return;
        }
        const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (moved <= 8) {
          openPreview();
        }
      }}
      onPointerCancel={() => {
        pointerStart.current = null;
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPreview();
        }
      }}
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
      {(activity.activityNote || note) && (
        <span className="calendar-run-note" title={note}>
          <MessageSquareText size={12} aria-hidden="true" />
          {activity.activityNote || note}
        </span>
      )}
      {!activity.activityNote && !note && (
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

function CalendarDayNote({ note }: { note: string }) {
  return (
    <details className="calendar-day-note">
      <summary>Day note</summary>
      <p>{note}</p>
    </details>
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

function ActivityPreview({
  detail,
  session,
  loading,
  zones,
  planDay,
  onSaveNote,
}: {
  detail: ActivityDetail | null;
  session: SessionLoad;
  loading: boolean;
  zones: TrainingZone[];
  planDay?: TrainingPlanDay;
  onSaveNote: (activityId: string, note: string) => Promise<string>;
}) {
  const activity = detail ?? session.activity;
  const split = detail ? splitPaces(detail) : undefined;
  const lapSplits = detail ? buildLapSplits(detail) : [];
  const hrZoneTotals = detail ? buildHrZoneTotals(detail, zones) : undefined;
  const runKind = classifyRun(session);

  return (
    <div className="training-hover-preview">
      <div className="preview-head">
        <div>
          <p>{formatRunDate(activity.startDateLocal || activity.startDate)}</p>
          <h3>{activity.name}</h3>
        </div>
        {loading && <span>loading</span>}
      </div>
      <ActivityNoteEditor activityId={activity.id} note={activity.activityNote ?? ''} onSave={onSaveNote} />
      <div className="preview-stat-grid preview-primary-stats">
        <Metric label="Distance" value={`${activity.distanceKm.toFixed(1)} km`} />
        <Metric label="Time" value={formatDuration(activity.movingTimeSec)} />
        <Metric label="Pace" value={formatPace(activityPaceSecPerKm(activity))} />
        <Metric label="Heart rate" value={activity.averageHeartRate ? `${Math.round(activity.averageHeartRate)} bpm` : '-'} />
      </div>
      {planDay?.notes && planDay.notes.length > 0 && (
        <section className="preview-plan-note" aria-label="Day note">
          <header>
            <span>Day note</span>
            <small>{planDay.source === 'legacy-google-sheet' ? 'Imported from RUNMASTER' : 'Plan'}</small>
          </header>
          <p>{planDay.notes}</p>
        </section>
      )}
      <RoutePreview detail={detail ?? session.activity} />
      <details className="preview-advanced-detail">
        <summary>Splits, zones and load analysis</summary>
        <RunKindExplanation classification={runKind} />
        <SplitsPreview detail={detail} />
        <HrZoneBreakdown totals={hrZoneTotals} loading={loading} />
        <LapSplitsTable splits={lapSplits} loading={loading} />
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
      </details>
    </div>
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

function RunKindExplanation({ classification }: { classification: RunClassification }) {
  return (
    <section className={`preview-label-reasons tone-${classification.tone}`} aria-label={`Why this run is labelled ${classification.label}`}>
      <header>
        <span>{classification.label}</span>
        <strong>{classification.summary}</strong>
      </header>
      <ul>
        {classification.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </section>
  );
}

function HrZoneBreakdown({ totals, loading }: { totals?: HrZoneTotal[]; loading: boolean }) {
  const totalSeconds = totals?.reduce((total, item) => total + item.seconds, 0) ?? 0;
  return (
    <section className="preview-zone-breakdown" aria-label="Heart rate zone time">
      <header>
        <span>HR zones</span>
        <small>{totalSeconds > 0 ? formatDuration(totalSeconds) : loading ? 'loading' : 'no HR stream'}</small>
      </header>
      {totalSeconds > 0 && totals ? (
        <div className="preview-zone-bars">
          {totals.map((item) => {
            const pct = totalSeconds > 0 ? (item.seconds / totalSeconds) * 100 : 0;
            return (
              <div key={item.zone.key} className={`preview-zone-row tone-${item.zone.tone}`}>
                <span>{item.zone.label}</span>
                <div className="zone-bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(2, pct)}%` }} />
                </div>
                <strong>{formatDuration(item.seconds)}</strong>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="split-placeholder compact">{loading ? 'Loading heart-rate stream.' : 'No heart-rate stream for this run.'}</div>
      )}
    </section>
  );
}

function LapSplitsTable({ splits, loading }: { splits: LapSplit[]; loading: boolean }) {
  return (
    <section className="preview-lap-splits" aria-label="Lap splits">
      <header>
        <span>Splits</span>
        <small>{splits.length > 0 ? '1 km laps' : loading ? 'loading' : 'distance stream unavailable'}</small>
      </header>
      {splits.length > 0 ? (
        <div className="lap-split-table-wrap">
          <table className="lap-split-table">
            <thead>
              <tr>
                <th>Lap</th>
                <th>Dist</th>
                <th>Time</th>
                <th>Pace</th>
                <th>HR</th>
                <th>W</th>
              </tr>
            </thead>
            <tbody>
              {splits.map((split) => (
                <tr key={split.label}>
                  <td>{split.label}</td>
                  <td>{split.distanceKm.toFixed(split.distanceKm >= 0.95 ? 1 : 2)}</td>
                  <td>{formatDuration(split.durationSec)}</td>
                  <td>{formatCompactPace(split.paceSecPerKm)}</td>
                  <td>{split.averageHeartRate ? Math.round(split.averageHeartRate) : '-'}</td>
                  <td>{split.averagePower ? Math.round(split.averagePower) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="split-placeholder compact">{loading ? 'Loading distance stream.' : 'No distance stream for lap splits.'}</div>
      )}
    </section>
  );
}

function RoutePreview({ detail }: { detail: ActivityDetail | ActivitySummary }) {
  const points = routePoints(detail);
  const path = pointsToPath(points, 320, 154);
  return (
    <div className="route-preview" aria-hidden="true">
      {path ? (
        <svg viewBox="0 0 320 154" role="img">
          <path d={path} />
        </svg>
      ) : (
        <span>No route stream</span>
      )}
    </div>
  );
}

function SplitsPreview({ detail }: { detail: ActivityDetail | null }) {
  const path = paceStreamPath(detail, 320, 116);
  const split = detail ? splitPaces(detail) : undefined;
  return (
    <div className="splits-preview" aria-label="Pace over time">
      <div className="splits-head">
        <span>Pace over time</span>
        <small>{split ? `${formatPace(split.first)} / ${formatPace(split.second)}` : 'stream pending'}</small>
      </div>
      {path ? (
        <svg viewBox="0 0 320 116" role="img">
          <line x1="0" y1="58" x2="320" y2="58" />
          <path d={path} />
        </svg>
      ) : (
        <div className="split-placeholder">Click detail is loading or this run has no speed stream.</div>
      )}
    </div>
  );
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

function scopeLoadModel(model: TrainingLoadModel, range: RangeKey, gymSessions: GymSession[]) {
  const option = RANGE_OPTIONS.find((item) => item.key === range);
  const latestMs = model.sessions[model.sessions.length - 1]
    ? new Date(model.sessions[model.sessions.length - 1].activity.startDate).getTime()
    : Date.now();
  const fromMs = option?.months ? subtractMonths(latestMs, option.months) : -Infinity;
  const sessionsAsc = model.sessions.filter((session) => new Date(session.activity.startDate).getTime() >= fromMs);
  const sessions = [...sessionsAsc].reverse();
  const weekIds = new Set(sessionsAsc.map((session) => session.weekId));
  const weeks = model.weeks.filter((week) => weekIds.has(week.weekId)).reverse();
  const days = new Set(sessionsAsc.map((session) => session.day));
  const daily = model.daily.filter((point) => new Date(`${point.day}T00:00:00Z`).getTime() >= fromMs || days.has(point.day));
  // Gym rides alongside runs: grouped by the same ISO week but never scored.
  const gymInRange = gymSessions.filter((session) => new Date(session.startDate).getTime() >= fromMs);
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
  const weekEntries = [...entriesById.values()].sort((a, b) => b.weekId.localeCompare(a.weekId));

  return {
    sessions,
    weeks,
    weekEntries,
    daily,
    months: buildMonthNav(sessions),
    distanceKm: sessions.reduce((total, session) => total + session.activity.distanceKm, 0),
    gymCount: gymInRange.length,
  };
}

function buildMonthNav(sessions: SessionLoad[]) {
  const months = new Map<string, { id: string; label: string; count: number }>();
  for (const session of sessions) {
    const id = session.day.slice(0, 7);
    const existing = months.get(id);
    if (existing) {
      existing.count += 1;
    } else {
      months.set(id, { id, label: formatMonthLabel(session.day), count: 1 });
    }
  }
  return [...months.values()];
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
    const summary =
      paceIf >= 0.85
        ? `Pace IF ${paceIf.toFixed(2)} >= 0.85`
        : (hrIf ?? 0) >= 0.92
          ? `HR IF ${formatOptionalIf(hrIf)} >= 0.92`
          : (powerIf ?? 0) >= 0.88
            ? `Power IF ${formatOptionalIf(powerIf)} >= 0.88`
            : 'Quality-load flag';
    return { key: 'session', label: 'Session', tone: 'danger', summary, reasons: sessionReasons };
  }

  if (session.load >= 70) {
    return {
      key: 'long',
      label: 'Long easy',
      tone: 'hard',
      summary: `Load ${session.load.toFixed(1)} >= 70`,
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
      summary: `Pace IF ${paceIf.toFixed(2)} in steady band`,
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
    summary: `Pace IF ${paceIf.toFixed(2)} < 0.76`,
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

function routePoints(detail: ActivityDetail | ActivitySummary): Array<[number, number]> {
  if ('streams' in detail && detail.streams?.latlng?.length) {
    return detail.streams.latlng;
  }
  if (detail.summaryPolyline) {
    return decodePolyline(detail.summaryPolyline).map(([lng, lat]) => [lat, lng]);
  }
  return [];
}

function pointsToPath(points: Array<[number, number]>, width: number, height: number): string {
  if (points.length < 2) {
    return '';
  }
  const latitudes = points.map(([lat]) => lat);
  const longitudes = points.map(([, lng]) => lng);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const pad = 14;
  const usableWidth = width - pad * 2;
  const usableHeight = height - pad * 2;
  return points
    .map(([lat, lng], index) => {
      const x = pad + ((lng - minLng) / Math.max(maxLng - minLng, 0.000001)) * usableWidth;
      const y = pad + ((maxLat - lat) / Math.max(maxLat - minLat, 0.000001)) * usableHeight;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function paceStreamPath(detail: ActivityDetail | null, width: number, height: number): string {
  const time = detail?.streams?.timeSec;
  const velocity = detail?.streams?.velocity;
  if (!time || !velocity) {
    return '';
  }
  const n = Math.min(time.length, velocity.length);
  const points: Array<[number, number]> = [];
  for (let index = 0; index < n; index += 1) {
    const pace = velocity[index] > 0 ? 1000 / velocity[index] : 0;
    if (Number.isFinite(pace) && pace >= 140 && pace <= 720) {
      points.push([time[index], pace]);
    }
  }
  if (points.length < 2) {
    return '';
  }
  const stride = Math.max(1, Math.ceil(points.length / 180));
  const sampled = points.filter((_, index) => index % stride === 0 || index === points.length - 1);
  const minTime = sampled[0][0];
  const maxTime = sampled[sampled.length - 1][0];
  const paces = sampled.map(([, pace]) => pace);
  const fast = percentile(paces, 0.08) ?? Math.min(...paces);
  const slow = percentile(paces, 0.92) ?? Math.max(...paces);
  const pad = 10;
  const usableWidth = width - pad * 2;
  const usableHeight = height - pad * 2;
  return sampled
    .map(([seconds, pace], index) => {
      const x = pad + ((seconds - minTime) / Math.max(maxTime - minTime, 1)) * usableWidth;
      const y = pad + ((pace - fast) / Math.max(slow - fast, 1)) * usableHeight;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
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

function buildLapSplits(detail: ActivityDetail): LapSplit[] {
  const time = detail.streams?.timeSec;
  const distance = detail.streams?.distanceM;
  if (!time || !distance) {
    return [];
  }
  const n = Math.min(time.length, distance.length);
  if (n < 3) {
    return [];
  }
  const startDistance = firstFinite(distance);
  const endDistance = lastFinite(distance);
  if (startDistance === undefined || endDistance === undefined || endDistance <= startDistance) {
    return [];
  }
  const streamDistanceM = endDistance - startDistance;
  const totalDistanceM = streamDistanceM;
  if (totalDistanceM < 200) {
    return [];
  }

  const boundaries = [0];
  for (let marker = 1000; marker < totalDistanceM - 50; marker += 1000) {
    boundaries.push(marker);
  }
  boundaries.push(totalDistanceM);

  const splits: LapSplit[] = [];
  for (let index = 1; index < boundaries.length; index += 1) {
    const startM = boundaries[index - 1];
    const endM = boundaries[index];
    const startTime = timeAtDistance(time, distance, startDistance + startM);
    const endTime = timeAtDistance(time, distance, startDistance + endM);
    if (startTime === undefined || endTime === undefined || endTime <= startTime) {
      continue;
    }
    const distanceKm = (endM - startM) / 1000;
    const durationSec = endTime - startTime;
    if (distanceKm <= 0 || durationSec <= 0) {
      continue;
    }
    splits.push({
      label: String(index),
      distanceKm,
      durationSec,
      paceSecPerKm: durationSec / distanceKm,
      averageHeartRate: weightedAverageStream(time, detail.streams?.heartrate, startTime, endTime, isUsefulPreviewHeartRate),
      averagePower: weightedAverageStream(time, detail.streams?.power, startTime, endTime, isUsefulPower),
    });
  }
  return splits;
}

function timeAtDistance(time: number[], distance: number[], targetM: number): number | undefined {
  const n = Math.min(time.length, distance.length);
  if (n === 0) {
    return undefined;
  }
  if (targetM <= distance[0]) {
    return time[0];
  }
  for (let index = 1; index < n; index += 1) {
    const prevDistance = distance[index - 1];
    const nextDistance = distance[index];
    const prevTime = time[index - 1];
    const nextTime = time[index];
    if (
      !Number.isFinite(prevDistance) ||
      !Number.isFinite(nextDistance) ||
      !Number.isFinite(prevTime) ||
      !Number.isFinite(nextTime)
    ) {
      continue;
    }
    if (nextDistance >= targetM) {
      const ratio = nextDistance === prevDistance ? 0 : (targetM - prevDistance) / (nextDistance - prevDistance);
      return prevTime + (nextTime - prevTime) * Math.min(1, Math.max(0, ratio));
    }
  }
  return time[n - 1];
}

function weightedAverageStream(
  time: number[],
  values: number[] | undefined,
  startTime: number,
  endTime: number,
  isUseful: (value: number) => boolean,
): number | undefined {
  if (!values) {
    return undefined;
  }
  const n = Math.min(time.length, values.length);
  let weighted = 0;
  let duration = 0;
  for (let index = 1; index < n; index += 1) {
    const segmentStart = Math.max(startTime, time[index - 1]);
    const segmentEnd = Math.min(endTime, time[index]);
    const dt = segmentEnd - segmentStart;
    const value = values[index - 1];
    if (!Number.isFinite(dt) || dt <= 0 || !isUseful(value)) {
      continue;
    }
    weighted += value * dt;
    duration += dt;
  }
  return duration > 0 ? weighted / duration : undefined;
}

function firstFinite(values: number[]): number | undefined {
  return values.find((value) => Number.isFinite(value));
}

function lastFinite(values: number[]): number | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(values[index])) {
      return values[index];
    }
  }
  return undefined;
}

function isUsefulPreviewHeartRate(value: number): boolean {
  return Number.isFinite(value) && value >= 80 && value <= 220;
}

function isUsefulPower(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 1200;
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
