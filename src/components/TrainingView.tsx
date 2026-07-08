import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  BookOpen,
  CalendarDays,
  Dumbbell,
  Gauge,
  HeartPulse,
  ListFilter,
  Map as MapIcon,
  Mountain,
  ShieldAlert,
  Timer,
  TrendingUp,
  Zap,
} from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatPace } from '../analysis/fatigue';
import {
  buildTrainingLoadModel,
  type SessionLoad,
  type TrainingLoadModel,
  type WeekLoadSummary,
} from '../analysis/loadModel';
import { getActivity } from '../data/api';
import { activityPaceSecPerKm, decodePolyline, toWeekIdUtc } from '../data/mapRoutes';
import type { ActivityDetail, ActivitySummary, GymSession, WeeklyAnalysis } from '../types';
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

interface TrainingViewProps {
  activities: ActivitySummary[];
  analyses: WeeklyAnalysis[];
  gymSessions: GymSession[];
  usingSample: boolean;
}

// A week in the log is either a scored run week (with any gym that week attached)
// or a gym-only week. Gym never contributes to load — it rides alongside.
interface WeekEntry {
  weekId: string;
  week?: WeekLoadSummary;
  gym: GymSession[];
}

type RangeKey = '3m' | '6m' | '12m' | '10y' | 'all';

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string; months?: number }> = [
  { key: 'all', label: 'All' },
  { key: '3m', label: '3m', months: 3 },
  { key: '6m', label: '6m', months: 6 },
  { key: '12m', label: '12m', months: 12 },
  { key: '10y', label: '10y', months: 120 },
];

const INITIAL_WEEK_COUNT = 12;
const WEEK_CHUNK = 10;

export function TrainingView({ activities, analyses, gymSessions, usingSample }: TrainingViewProps) {
  const [range, setRange] = useState<RangeKey>('all');
  const [showGuide, setShowGuide] = useState(false);
  const [visibleWeekCount, setVisibleWeekCount] = useState(INITIAL_WEEK_COUNT);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewDetail, setPreviewDetail] = useState<ActivityDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const detailCache = useRef(new Map<string, ActivityDetail>());
  const scrollerRef = useRef<HTMLElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadModel = useMemo(() => buildTrainingLoadModel(activities), [activities]);
  const scoped = useMemo(() => scopeLoadModel(loadModel, range, gymSessions), [loadModel, range, gymSessions]);
  const analysisByWeek = useMemo(
    () => new Map(analyses.map((analysis) => [analysis.week.weekStart, analysis])),
    [analyses],
  );
  const visibleWeeks = scoped.weekEntries.slice(0, visibleWeekCount);
  const latestDaily = scoped.daily[scoped.daily.length - 1];
  const latestSession = scoped.sessions[0];
  const previewSession = previewId ? loadModel.sessionsById.get(previewId) : undefined;
  const runCount = scoped.sessions.length;
  const gymCount = scoped.gymCount;
  const hrCount = scoped.sessions.filter((session) => session.activity.averageHeartRate).length;
  const powerCount = scoped.sessions.filter((session) => session.activity.averageWatts).length;
  const chartSpanDays = useMemo(() => {
    const rows = scoped.chartRows;
    return rows.length > 1 ? (rows[rows.length - 1].ts - rows[0].ts) / 86_400_000 : 0;
  }, [scoped.chartRows]);

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

  return (
    <main ref={scrollerRef} className="training-view training-log-view" aria-label="Training history">
      <section className="training-toolbar" aria-label="Training range">
        <div>
          <p className="eyebrow">
            <Activity size={15} aria-hidden="true" />
            Training log
          </p>
          <h2>All runs, scored by load</h2>
        </div>
        <div className="training-range-controls">
          <button
            type="button"
            className={`guide-toggle${showGuide ? ' active' : ''}`}
            aria-pressed={showGuide}
            aria-expanded={showGuide}
            onClick={() => setShowGuide((current) => !current)}
          >
            <BookOpen size={15} aria-hidden="true" />
            Metrics guide
          </button>
          <div className="segmented compact-segmented" role="group" aria-label="Training range">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={range === option.key ? 'active' : ''}
                aria-pressed={range === option.key}
                onClick={() => setRange(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {showGuide && <MetricsGuide metrics={GUIDE_METRICS} />}

      <section className="training-load-grid" aria-label="Fitness and fatigue">
        <article className="chart-card training-chart-card">
          <div className="chart-header">
            <div>
              <p>Fitness and fatigue</p>
              <h2>
                CTL / ATL load model
                <MetricInfo metric="chart" />
              </h2>
            </div>
            <span className="chart-pill">load points</span>
          </div>
          <div className="fitness-chart">
            <ResponsiveContainer
              width="100%"
              height="100%"
              minWidth={0}
              minHeight={0}
              initialDimension={{ width: 900, height: 320 }}
            >
              <LineChart data={scoped.chartRows} margin={{ top: 14, right: 20, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="#2c3440" vertical={false} />
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(value) => formatAxisTick(value as number, chartSpanDays)}
                  minTickGap={44}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: '#92a0b3', fontSize: 12 }}
                />
                <YAxis tickLine={false} axisLine={false} tick={{ fill: '#92a0b3', fontSize: 12 }} width={46} />
                <Tooltip
                  cursor={{ stroke: '#465365', strokeWidth: 1 }}
                  contentStyle={{
                    border: '1px solid #303946',
                    borderRadius: 8,
                    backgroundColor: '#171b21',
                    color: '#edf2f7',
                    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.32)',
                  }}
                  formatter={(value, name) => [`${Number(value).toFixed(1)}`, name]}
                  labelFormatter={(value) => formatFullDate(value as number)}
                />
                <Legend verticalAlign="top" align="right" iconType="line" wrapperStyle={{ color: '#99a6b8' }} />
                <ReferenceLine y={0} stroke="#465365" />
                <Line type="monotone" dataKey="fitness" name="Fitness CTL" stroke="#22b982" strokeWidth={3} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="fatigue" name="Fatigue ATL" stroke="#ff5a66" strokeWidth={3} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="freshness" name="Freshness" stroke="#f2c94c" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </article>

        <aside className="training-kpis" aria-label="Current training metrics">
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
          <TrainingKpi
            icon={<CalendarDays size={18} />}
            label="Runs"
            value={String(runCount)}
            detail={gymCount > 0 ? `${Math.round(scoped.distanceKm)} km · ${gymCount} gym` : `${Math.round(scoped.distanceKm)} km`}
          />
          <TrainingKpi
            icon={<HeartPulse size={18} />}
            label="HR / power"
            value={`${hrCount}/${runCount} · ${powerCount}/${runCount}`}
            detail="recorded coverage"
          />
        </aside>
      </section>

      <section className="training-log-shell" aria-label="Activity log">
        <aside className="training-jump-rail" aria-label="Jump to month">
          <div className="training-sticky-card">
            <p className="rail-label">
              <ListFilter size={14} aria-hidden="true" />
              Jump
            </p>
            <nav>
              {scoped.months.map((month) => (
                <a key={month.id} href={`#month-${month.id}`}>
                  <span>{month.label}</span>
                  <small>{month.count}</small>
                </a>
              ))}
            </nav>
          </div>
        </aside>

        <div className="training-week-list">
          {visibleWeeks.length > 0 ? (
            visibleWeeks.map((entry, index) => {
              const previous = visibleWeeks[index - 1];
              const currentMonth = monthIdFromEntry(entry);
              const showMonthAnchor = !previous || monthIdFromEntry(previous) !== currentMonth;
              return (
                <div key={entry.weekId} className="training-week-block-wrap">
                  {showMonthAnchor && <span id={`month-${currentMonth}`} className="month-anchor" />}
                  {entry.week ? (
                    <WeekBlock
                      week={entry.week}
                      gym={entry.gym}
                      analysis={analysisByWeek.get(entry.weekId)}
                      previewId={previewId}
                      onPreview={setPreviewId}
                    />
                  ) : (
                    <GymOnlyBlock weekId={entry.weekId} gym={entry.gym} />
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

        <aside className="training-preview-rail" aria-label="Activity preview">
          <div className="training-sticky-card">
            <HoverPreview detail={previewDetail} session={previewSession} loading={previewLoading} />
          </div>
        </aside>
      </section>
    </main>
  );
}

function WeekBlock({
  week,
  gym,
  analysis,
  previewId,
  onPreview,
}: {
  week: WeekLoadSummary;
  gym: GymSession[];
  analysis?: WeeklyAnalysis;
  previewId: string | null;
  onPreview: (id: string) => void;
}) {
  const projectedEasy = analysis?.week.easyPaceSecPerKm;
  return (
    <article className={`training-week-block ${week.severity}`}>
      <header className="training-week-head">
        <div>
          <p>{week.label}</p>
          <h3>{week.status}</h3>
        </div>
        <div className="week-load-summary">
          <Metric label="Load" value={week.load.toFixed(1)} />
          <Metric label="Fitness" value={week.fitness.toFixed(1)} />
          <Metric label="Fatigue" value={week.fatigue.toFixed(1)} />
          <Metric label="Freshness" value={week.freshness.toFixed(1)} />
          <Metric label="Ramp" value={week.acwr.toFixed(2)} />
        </div>
      </header>
      <div className="week-risk-row">
        <span>{week.activityCount} runs</span>
        <span>{week.distanceKm.toFixed(1)} km</span>
        <span>{week.durationHours.toFixed(1)} h</span>
        <span>{Math.round(week.hardShare * 100)}% hard load</span>
        <span>{Math.round(week.longRunShare * 100)}% long-run share</span>
        {projectedEasy && <span>easy {formatPace(projectedEasy)}</span>}
      </div>
      {week.flags.length > 0 && (
        <div className="week-flags">
          {week.flags.map((flag) => (
            <span key={flag}>{flag}</span>
          ))}
        </div>
      )}
      <GymStrip gym={gym} />
      <div className="run-log-table" role="table" aria-label={`${week.label} runs`}>
        <div className="run-log-header" role="row">
          <span>Run</span>
          <span>Time</span>
          <span>Pace</span>
          <span>Elev</span>
          <span>HR</span>
          <span>Power</span>
          <span>Load</span>
          <span>Split</span>
        </div>
        {[...week.sessions].reverse().map((session) => (
          <RunRow
            key={session.activity.id}
            session={session}
            projectedEasySecPerKm={projectedEasy}
            active={previewId === session.activity.id}
            onPreview={onPreview}
          />
        ))}
      </div>
    </article>
  );
}

// A week with gym but no runs still shows, so gym history is never hidden.
function GymOnlyBlock({ weekId, gym }: { weekId: string; gym: GymSession[] }) {
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
      <GymStrip gym={gym} />
    </article>
  );
}

// Non-scored strip: shows each gym session in the week so you can see when you
// trained in the gym. Purely informational — it feeds nothing.
function GymStrip({ gym }: { gym: GymSession[] }) {
  if (gym.length === 0) {
    return null;
  }
  const sorted = [...gym].sort((a, b) => a.startDate.localeCompare(b.startDate));
  return (
    <div className="week-gym-strip" aria-label={`${gym.length} gym ${gym.length === 1 ? 'session' : 'sessions'}`}>
      <span className="week-gym-strip-label">
        <Dumbbell size={14} aria-hidden="true" />
        Gym
      </span>
      <div className="gym-badges">
        {sorted.map((session) => (
          <span key={session.id} className="gym-badge" title={gymTitle(session)}>
            <strong>{formatGymDay(session.startDateLocal || session.startDate)}</strong>
            {session.durationSec > 0 && <span>{Math.round(session.durationSec / 60)}m</span>}
            {session.averageHeartRate && <span>{Math.round(session.averageHeartRate)} bpm</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

function RunRow({
  session,
  projectedEasySecPerKm,
  active,
  onPreview,
}: {
  session: SessionLoad;
  projectedEasySecPerKm?: number;
  active: boolean;
  onPreview: (id: string) => void;
}) {
  const activity = session.activity;
  return (
    <button
      type="button"
      className={`run-log-row ${active ? 'active' : ''}`}
      onMouseEnter={() => onPreview(activity.id)}
      onFocus={() => onPreview(activity.id)}
      onClick={() => onPreview(activity.id)}
    >
      <span className="run-log-main">
        <strong>{activity.name}</strong>
        <small>
          {formatRunDate(activity.startDateLocal || activity.startDate)}
          {projectedEasySecPerKm ? ` · easy ${formatPace(projectedEasySecPerKm)}` : ''}
        </small>
      </span>
      <RunCell icon={<Timer size={15} />} value={formatDuration(activity.movingTimeSec)} />
      <RunCell value={formatPace(activityPaceSecPerKm(activity))} />
      <RunCell icon={<Mountain size={15} />} value={`${Math.round(activity.elevationGainM)} m`} />
      <RunCell icon={<HeartPulse size={15} />} value={activity.averageHeartRate ? `${Math.round(activity.averageHeartRate)}` : '-'} detail="bpm" />
      <RunCell icon={<Zap size={15} />} value={activity.averageWatts ? `${Math.round(activity.averageWatts)}` : '-'} detail="W" />
      <RunCell value={session.load.toFixed(1)} detail={`IF ${session.externalIntensityFactor.toFixed(2)}`} />
      <RunCell value={formatDecoupling(activity.decouplingPct)} detail={session.reliability.replaceAll('-', ' + ')} />
    </button>
  );
}

function HoverPreview({
  detail,
  session,
  loading,
}: {
  detail: ActivityDetail | null;
  session?: SessionLoad;
  loading: boolean;
}) {
  if (!session) {
    return (
      <div className="training-hover-empty">
        <MapIcon size={24} aria-hidden="true" />
        <h3>Hover a run</h3>
        <p>Route and pace-over-time split preview appears here.</p>
      </div>
    );
  }

  const activity = detail ?? session.activity;
  const split = detail ? splitPaces(detail) : undefined;

  return (
    <div className="training-hover-preview">
      <div className="preview-head">
        <div>
          <p>{formatRunDate(activity.startDateLocal || activity.startDate)}</p>
          <h3>{activity.name}</h3>
        </div>
        {loading && <span>loading</span>}
      </div>
      <RoutePreview detail={detail ?? session.activity} />
      <SplitsPreview detail={detail} />
      <div className="preview-stat-grid">
        <Metric label="Load" value={session.load.toFixed(1)} />
        <Metric label="External" value={session.externalLoad.toFixed(1)} />
        <Metric label="HR" value={session.internalLoad?.toFixed(1) ?? '-'} />
        <Metric label="Power" value={session.powerLoad?.toFixed(1) ?? '-'} />
      </div>
      <div className="preview-stat-grid">
        <Metric label="IF" value={session.externalIntensityFactor.toFixed(2)} />
        <Metric label="HR cost" value={session.hiddenCostPct === undefined ? '-' : `${session.hiddenCostPct > 0 ? '+' : ''}${session.hiddenCostPct.toFixed(1)}%`} />
        <Metric label="W/bpm" value={session.powerHrRatio?.toFixed(2) ?? '-'} />
        <Metric label="Split" value={split ? `${formatPace(split.first)} / ${formatPace(split.second)}` : formatDecoupling(activity.decouplingPct)} />
      </div>
      {session.flags.length > 0 && (
        <div className="preview-flags">
          {session.flags.map((flag) => (
            <span key={flag}>{flag}</span>
          ))}
        </div>
      )}
    </div>
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
        <div className="split-placeholder">Hover data is loading or this run has no speed stream.</div>
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

function RunCell({ icon, value, detail }: { icon?: ReactNode; value: string; detail?: string }) {
  return (
    <span className="run-cell">
      <span>
        {icon}
        <strong>{value}</strong>
      </span>
      {detail && <small>{detail}</small>}
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
  const chartRows = daily.map((point) => ({
    ts: Date.parse(`${point.day}T00:00:00Z`),
    day: point.day,
    fitness: point.fitness,
    fatigue: point.fatigue,
    freshness: point.freshness,
  }));

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
    chartRows,
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

function subtractMonths(anchorMs: number, months: number): number {
  const date = new Date(anchorMs);
  date.setMonth(date.getMonth() - months);
  return date.getTime();
}

function formatRunDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
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

function formatAxisTick(ms: number, spanDays: number): string {
  const date = new Date(ms);
  if (spanDays > 400) {
    return new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(date);
}

function formatFullDate(ms: number): string {
  if (!Number.isFinite(ms)) {
    return '';
  }
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));
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
