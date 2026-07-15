import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarRange,
  Check,
  ChevronDown,
  Flag,
  Gauge,
  HeartPulse,
  Pencil,
  RefreshCw,
  Route,
  Save,
  ShieldCheck,
  Sparkles,
  Target,
  Timer,
  X,
  Zap,
} from 'lucide-react';
import type { PracticalZone } from '../analysis/coachEngine';
import { buildScullionPlanRead, scullionGoalFromProfile, type ScullionGoal, type ScullionPlanRead } from '../analysis/scullionPlan';
import type {
  CoachContextData,
  CoachDecisionRecord,
  CoachFeedbackDraft,
  CoachGoalDraft,
  CoachPhase,
  CriticalPowerDraft,
  StoredPlannedSession,
} from '../data/coachTypes';
import type { GymSession } from '../types';

export interface CoachPanelProps {
  context: CoachContextData | null;
  loading: boolean;
  error: string;
  onReload: (weekStart?: string) => Promise<void> | void;
  onUpdatePhase: (phase: CoachPhase, expectedVersion: number) => Promise<void>;
  onUpdateGoal: (goal: CoachGoalDraft, constraints: Record<string, unknown>, expectedVersion: number) => Promise<void>;
  onAddCriticalPower: (input: CriticalPowerDraft) => Promise<void>;
  onProposeBlock: (startWeek: string, weekCount: 1 | 2 | 3) => Promise<void>;
  onAcceptBlock: (decisionId: string, expectedVersion: number) => Promise<void>;
  onSubmitFeedback: (activityId: string, draft: CoachFeedbackDraft) => Promise<void>;
  onApplyDecision: (decisionId: string, expectedVersion: number) => Promise<void>;
  onRejectDecision: (decisionId: string) => Promise<void>;
  onOpenActivity: (activityId: string) => void;
  currentRead: { status: string; tone: string; summary: string };
  gymSessions: GymSession[];
  onUpdateSession: (
    id: string,
    patch: { plannedDate?: string; title?: string; plannedDurationMin?: number; purpose?: string },
    expectedRevision: number,
  ) => Promise<void>;
}

const PHASES: Array<{ value: CoachPhase; label: string }> = [
  { value: 'aerobic_conditioning', label: 'Aerobic conditioning & durability' },
  { value: 'hill_resistance', label: 'Hill resistance & strength' },
  { value: 'anaerobic_development', label: 'Anaerobic & race-specific' },
  { value: 'coordination', label: 'Coordination & sharpening' },
  { value: 'recovery_regeneration', label: 'Recovery & regeneration' },
];

export function CoachPanel(props: CoachPanelProps) {
  const { context } = props;
  const [working, setWorking] = useState('');
  const [actionError, setActionError] = useState('');
  const [horizon, setHorizon] = useState<1 | 2 | 3>(3);
  const [startWeek, setStartWeek] = useState(() => nextMonday(new Date()));
  const [cpWatts, setCpWatts] = useState('');
  const [cpEffective, setCpEffective] = useState(() => new Date().toISOString().slice(0, 10));
  const initialGoal = context ? scullionGoalFromProfile(context.profile) : { distanceKm: 5, timeSeconds: 20 * 60 };
  const [goalDistance, setGoalDistance] = useState(String(initialGoal.distanceKm));
  const [goalTime, setGoalTime] = useState(formatGoalInput(initialGoal.timeSeconds));
  const [goalDate, setGoalDate] = useState(initialGoal.targetDate ?? '');
  const [goalError, setGoalError] = useState('');

  useEffect(() => {
    if (!context) return;
    const next = scullionGoalFromProfile(context.profile);
    setGoalDistance(String(next.distanceKm));
    setGoalTime(formatGoalInput(next.timeSeconds));
    setGoalDate(next.targetDate ?? '');
  }, [context?.profile.version]);

  const act = async (name: string, action: () => Promise<void>) => {
    setWorking(name);
    setActionError('');
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Coach action failed.');
    } finally {
      setWorking('');
    }
  };

  if (props.loading && !context) {
    return (
      <section className="product-card coach-loading" aria-live="polite">
        <RefreshCw className="spin" size={19} aria-hidden="true" />
        <div><strong>Building your coaching context</strong><p>Reading recent streams, physiology evidence, plans, and responses.</p></div>
      </section>
    );
  }
  if (!context) {
    return (
      <section className="product-card coach-error" role="alert">
        <AlertTriangle size={20} aria-hidden="true" />
        <div><strong>Coach context is unavailable</strong><p>{props.error || 'Apply the stateful-coach migration, then retry.'}</p></div>
        <button type="button" onClick={() => void props.onReload()}>Retry</button>
      </section>
    );
  }

  const proposal = latestDecision(context.recentDecisions, ['training_block', 'weekly_plan'], 'proposed');
  const pendingAdaptations = context.recentDecisions.filter(
    (decision) => decision.decisionType === 'post_run_evaluation' && decision.status === 'proposed',
  );
  const canonicalCp = context.physiology.canonicalCriticalPower;
  const goal = scullionGoalFromProfile(context.profile);
  const scullion = buildScullionPlanRead(context, props.gymSessions, goal);
  const nextKeySession = findNextKeySession(context.upcomingPlan.sessions);

  const submitGoal = () => {
    const distanceKm = Number(goalDistance);
    const timeSeconds = parseGoalTime(goalTime);
    if (!Number.isFinite(distanceKm) || distanceKm < 1 || distanceKm > 100) {
      setGoalError('Goal distance must be between 1 and 100 km.');
      return;
    }
    if (!timeSeconds || timeSeconds < 120 || timeSeconds > 24 * 60 * 60) {
      setGoalError('Enter goal time as MM:SS or H:MM:SS.');
      return;
    }
    if (goalDate && !/^\d{4}-\d{2}-\d{2}$/.test(goalDate)) {
      setGoalError('Choose a valid goal date or leave it open.');
      return;
    }
    setGoalError('');
    const nextGoal: ScullionGoal = { distanceKm, timeSeconds, targetDate: goalDate || undefined };
    void act('goal', () => props.onUpdateGoal(nextGoal, context.profile.constraints, context.profile.version));
  };

  return (
    <section className="coach-shell coach-shell-simple" aria-label="Training plan and coach">
      <GoalHeader
        read={scullion}
        distance={goalDistance}
        time={goalTime}
        date={goalDate}
        working={working === 'goal'}
        error={goalError}
        phase={context.profile.currentPhase}
        onDistance={setGoalDistance}
        onTime={setGoalTime}
        onDate={setGoalDate}
        onSubmit={submitGoal}
      />

      <section className="coach-mission-grid" aria-label="Goal-based training read">
        <div className="coach-mission-column">
      <header className={`coach-hero coach-mission-card coach-read-${props.currentRead.tone}`}>
        <div>
          <p className="eyebrow"><Sparkles size={15} aria-hidden="true" /> This week's mission</p>
          <span className="coach-mission-confidence">{scullion.missionConfidence} confidence</span>
          <h2>{scullion.mission}</h2>
          <p>{props.currentRead.status} · {props.currentRead.summary}</p>
        </div>
        <div className="coach-hero-actions">
          <button type="button" onClick={() => void props.onReload(context.currentWeek.weekStart)} disabled={Boolean(working)}>
            <RefreshCw size={15} aria-hidden="true" /> Refresh
          </button>
        </div>
      </header>

          <NextKeySession session={nextKeySession} />
        </div>
        <div className="coach-read-column">
          <WeekProgress read={scullion} context={context} />
          <SystemBuckets read={scullion} />
        </div>
      </section>

      {(props.error || actionError) && <p className="coach-action-error" role="alert">{actionError || props.error}</p>}

      <section className="product-card coach-block-planner">
        <header>
          <div><span>Future plan</span><h3>Build the next 1–3 weeks</h3></div>
          <small>Review the draft before accepting it.</small>
        </header>
        <div className="coach-block-controls">
          <label><span>First Monday</span><input type="date" value={startWeek} onChange={(e) => setStartWeek(e.target.value)} /></label>
          <label><span>Horizon</span><select value={horizon} onChange={(e) => setHorizon(Number(e.target.value) as 1 | 2 | 3)}>
            <option value={1}>1 week</option><option value={2}>2 weeks</option><option value={3}>3 weeks</option>
          </select></label>
          <button
            type="button"
            className="primary-button"
            disabled={Boolean(working) || !isMonday(startWeek)}
            onClick={() => void act('propose', () => props.onProposeBlock(startWeek, horizon))}
          ><CalendarRange size={16} /> Propose block</button>
          {proposal && (
            <button
              type="button"
              className="coach-accept-button"
              disabled={Boolean(working)}
              onClick={() => void act('accept', () => props.onAcceptBlock(proposal.id, context.profile.version))}
            ><Check size={16} /> Accept proposal</button>
          )}
        </div>
        <p className="coach-block-rule">Later weeks stay provisional. A post-run change only adjusts the future sessions it affects.</p>
      </section>

      <UpcomingPlan sessions={context.upcomingPlan.sessions} context={context} onUpdateSession={props.onUpdateSession} />

      {pendingAdaptations.length > 0 && (
        <section className="coach-adaptations" aria-label="Pending plan adaptations">
          <header><AlertTriangle size={18} /><div><span>Decision required</span><h3>Pending future-session patches</h3></div></header>
          {pendingAdaptations.map((decision) => (
            <DecisionCard
              key={decision.id}
              decision={decision}
              busy={Boolean(working)}
              onApply={() => void act(`apply-${decision.id}`, () => props.onApplyDecision(decision.id, context.profile.version))}
              onReject={() => void act(`reject-${decision.id}`, () => props.onRejectDecision(decision.id))}
            />
          ))}
        </section>
      )}

      <details className="product-card coach-post-run-disclosure">
        <summary>Post-run feedback and plan adjustments</summary>
        <RecentResponsePanel {...props} working={working} act={act} />
      </details>

      <details className="product-card coach-advanced-settings">
        <summary>Advanced coaching settings and evidence</summary>
        <div className="coach-roadmap" aria-label="Goal roadmap">
          <RoadmapStep index="1" title="Durable healthy training" detail="Continuity, knees/Achilles, strength, and absorbed aerobic density." active />
          <ArrowRight size={18} aria-hidden="true" />
          <RoadmapStep index="2" title={`Sub-${context.goals.firstMilestone.target} 5K`} detail="First performance milestone · 3:00/km." />
          <ArrowRight size={18} aria-hidden="true" />
          <RoadmapStep index="3" title="~31:00 10K" detail="Bridge the threshold-duration gap." />
          <ArrowRight size={18} aria-hidden="true" />
          <RoadmapStep index="4" title={`Sub-${context.goals.laterMilestone.target} 10K`} detail="Later, materially harder milestone." />
        </div>
        <div className="coach-overview-grid">
          <article className="product-card coach-phase-card">
            <header><span>Current phase</span><small>Version {context.profile.version}</small></header>
            <label><span>Lydiard phase</span><select value={context.profile.currentPhase} disabled={Boolean(working)} onChange={(event) => void act('phase', () => props.onUpdatePhase(event.target.value as CoachPhase, context.profile.version))}>{PHASES.map((phase) => <option key={phase.value} value={phase.value}>{phase.label}</option>)}</select></label>
            <p>{phaseDescription(context.profile.currentPhase)}</p>
          </article>
          <article className="product-card coach-load-card">
            <header><span>Background load</span><small>Power-first where dated CP exists</small></header>
            <div className="coach-stat-row"><CoachStat label="7-day" value={context.backgroundLoad.sevenDayStress.toFixed(1)} /><CoachStat label="42-day" value={context.backgroundLoad.fortyTwoDayStress.toFixed(1)} /><CoachStat label="Balance" value={signed(context.backgroundLoad.stressBalance)} /></div>
            <p>{context.backgroundLoad.explanation}</p>
          </article>
          <article className="product-card coach-cp-card">
            <header><span>Critical Power</span><small>Date-effective history</small></header>
            {canonicalCp ? <div className="coach-cp-current"><strong>{Math.round(canonicalCp.watts)} W</strong><span>{confidenceLabel(canonicalCp.confidence)} · {canonicalCp.source.replaceAll('_', ' ')}</span><small>Effective {formatDate(canonicalCp.effectiveFrom)}</small></div> : <p className="coach-missing">No canonical dated CP is stored.</p>}
            <form className="coach-cp-form" onSubmit={(event) => { event.preventDefault(); const watts = Number(cpWatts); if (!Number.isFinite(watts) || watts <= 0) return; void act('cp', async () => { await props.onAddCriticalPower({ criticalPowerWatts: watts, effectiveFrom: `${cpEffective}T00:00:00.000Z`, source: 'stryd_manual', device: 'Stryd', confidence: 0.9 }); setCpWatts(''); }); }}>
              <label><span>Current CP (W)</span><input inputMode="numeric" value={cpWatts} onChange={(e) => setCpWatts(e.target.value)} placeholder="e.g. 320" /></label>
              <label><span>Effective from</span><input type="date" value={cpEffective} onChange={(e) => setCpEffective(e.target.value)} /></label>
              <button type="submit" disabled={working === 'cp' || !cpWatts}><Save size={14} /> Save CP</button>
            </form>
          </article>
        </div>
        <PhysiologyPanel context={context} />
        {context.limitations.length > 0 && <div className="coach-limitations"><strong>Limitations</strong><ul>{context.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      </details>
    </section>
  );
}

function GoalHeader({
  read,
  distance,
  time,
  date,
  phase,
  working,
  error,
  onDistance,
  onTime,
  onDate,
  onSubmit,
}: {
  read: ScullionPlanRead;
  distance: string;
  time: string;
  date: string;
  phase: CoachPhase;
  working: boolean;
  error: string;
  onDistance: (value: string) => void;
  onTime: (value: string) => void;
  onDate: (value: string) => void;
  onSubmit: () => void;
}) {
  const status = read.overallStatus === 'on_track' ? 'On track' : read.overallStatus === 'protect_recovery' ? 'Protect recovery' : 'Work to do';
  return (
    <section className="coach-goal-header" aria-labelledby="goal-heading">
      <div className="coach-goal-facts">
        <div className="coach-goal-primary">
          <span>Goal</span>
          <h2 id="goal-heading">{read.goalLabel}</h2>
          <p>{formatRaceDuration(read.goal.timeSeconds)} · {formatPace(read.goalPaceSecPerKm)}</p>
        </div>
        <div>
          <span>Race date</span>
          <strong>{read.goal.targetDate ? formatDate(read.goal.targetDate) : 'Open horizon'}</strong>
          <small>{read.daysToGoal === undefined ? 'No artificial deadline' : read.daysToGoal >= 0 ? `${read.daysToGoal} days out` : 'Date has passed'}</small>
        </div>
        <div>
          <span>Current block</span>
          <strong>{phaseLabel(phase)}</strong>
          <small>{read.absorbedWeeks}/4 recent weeks absorbed</small>
        </div>
        <div>
          <span>Current evidence</span>
          <strong>{read.currentEquivalentSeconds ? formatRaceDuration(read.currentEquivalentSeconds) : 'Withheld'}</strong>
          <small>{read.currentEquivalentSeconds ? `${read.currentEquivalentConfidence} confidence · ${signedSeconds(read.paceGapSecPerKm)} /km gap` : 'More race-quality evidence needed'}</small>
        </div>
        <div className={`coach-goal-status status-${read.overallStatus}`}>
          <span><i aria-hidden="true" /> {status}</span>
          <small>Evidence-informed block read</small>
        </div>
      </div>
      <form className="coach-goal-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <div>
          <Target size={17} aria-hidden="true" />
          <span>Set the target</span>
        </div>
        <label><span>Distance (km)</span><input type="number" inputMode="decimal" min="1" max="100" step="0.0001" list="goal-distances" value={distance} disabled={working} onChange={(event) => onDistance(event.target.value)} /></label>
        <datalist id="goal-distances"><option value="5" /><option value="10" /><option value="21.0975" /><option value="42.195" /></datalist>
        <label><span>Goal time</span><input inputMode="numeric" value={time} disabled={working} placeholder="1:25:00" aria-describedby="goal-time-help" onChange={(event) => onTime(event.target.value)} /><small id="goal-time-help">MM:SS or H:MM:SS</small></label>
        <label><span>Goal date <em>optional</em></span><input type="date" value={date} disabled={working} onChange={(event) => onDate(event.target.value)} /></label>
        <button type="submit" className="primary-button" disabled={working}><Flag size={15} aria-hidden="true" /> {working ? 'Saving…' : 'Save goal'}</button>
        {error && <p role="alert">{error}</p>}
      </form>
      {read.currentEquivalentCaveat && <p className="coach-goal-caveat"><Gauge size={14} aria-hidden="true" /> {read.currentEquivalentCaveat}</p>}
    </section>
  );
}

function WeekProgress({ read, context }: { read: ScullionPlanRead; context: CoachContextData }) {
  const today = localDateKey();
  const actualDays = new Set(context.recentRuns.map((run) => (run.startDateLocal ?? run.startDate).slice(0, 10)));
  const plannedDays = new Set(context.currentWeek.sessions
    .filter((session) => !['rest', 'strength', 'cancelled', 'superseded'].includes(session.sessionType))
    .map((session) => session.plannedDate));
  const days = Array.from({ length: 7 }, (_, index) => addDays(context.currentWeek.weekStart, index));
  const progress = Math.min(1, read.currentWeekKm / Math.max(1, read.weeklyTargetKm));
  return (
    <section className="coach-week-progress">
      <header><div><span>Week progress</span><strong>{read.currentWeekSessions} sessions</strong></div><em className={`status-${read.overallStatus}`}>{read.overallStatus.replaceAll('_', ' ')}</em></header>
      <div className="coach-week-days" aria-label="Current week session progress">
        {days.map((day) => <span key={day} className={`${actualDays.has(day) ? 'done' : plannedDays.has(day) ? 'planned' : ''}${day === today ? ' today' : ''}`}><i aria-hidden="true" />{weekday(day).slice(0, 1)}</span>)}
      </div>
      <div className="coach-volume-read"><span>Volume</span><strong>{read.currentWeekKm.toFixed(1)} <small>/ {read.weeklyTargetKm.toFixed(1)} km</small></strong></div>
      <div className="coach-progress-track" aria-label={`${Math.round(progress * 100)}% of current safe weekly volume`}><span style={{ width: `${progress * 100}%` }} /></div>
      <p>{Math.max(0, read.weeklyTargetKm - read.currentWeekKm).toFixed(1)} km remaining · the target is capped by recently absorbed training.</p>
    </section>
  );
}

function SystemBuckets({ read }: { read: ScullionPlanRead }) {
  return (
    <section className="coach-system-buckets">
      <header><span>Systems / buckets</span><small>Last 28 days vs current-block need</small></header>
      <div>
        {read.buckets.map((bucket) => (
          <details key={bucket.key} className={`coach-bucket status-${bucket.status}`}>
            <summary>
              <span>{bucket.label}</span>
              <div><strong>{bucket.actual.toFixed(bucket.unit === 'km' ? 1 : 0)}{bucket.target > 0 ? ` / ${bucket.target.toFixed(bucket.unit === 'km' ? 1 : 0)}` : ''} {bucket.unit}</strong><i><b style={{ width: `${bucket.progress * 100}%` }} /></i></div>
              <em>{bucketStatusLabel(bucket.status)}</em>
              <ChevronDown size={15} aria-hidden="true" />
            </summary>
            <div><p>{bucket.evidence}</p><strong>Next decision</strong><p>{bucket.nextStep}</p></div>
          </details>
        ))}
      </div>
    </section>
  );
}

function NextKeySession({ session }: { session?: StoredPlannedSession }) {
  if (!session) {
    return <section className="coach-next-key empty"><div><span>Next key session</span><h3>Not scheduled</h3></div><p>Generate a block when the goal and current evidence look right. Nothing is added automatically.</p></section>;
  }
  return (
    <section className="coach-next-key">
      <div><span>Next key session · {weekday(session.plannedDate)}</span><h3>{session.title}</h3><p>{session.purpose}</p></div>
      <div className="coach-next-key-targets">
        {session.plannedDurationSec !== undefined && <span><Timer size={14} /> {Math.round(session.plannedDurationSec / 60)} min</span>}
        {session.plannedDistanceKm !== undefined && <span>{session.plannedDistanceKm.toFixed(1)} km</span>}
        {paceTarget(session) && <span>{paceTarget(session)}</span>}
      </div>
    </section>
  );
}

function PhysiologyPanel({ context }: { context: CoachContextData }) {
  const p = context.physiology;
  return (
    <section className="product-card coach-physiology">
      <header><div><span>Physiology engine</span><h3>Boundaries with ranges, evidence, and confidence</h3></div><small>Effective {formatDate(p.asOf)}</small></header>
      <div className="coach-physiology-grid">
        <EstimateCard icon={<Route size={18} />} title="Critical speed" value={p.criticalSpeed ? formatPace(1000 / p.criticalSpeed.estimate) : 'Withheld'} range={p.criticalSpeed ? `${formatPace(1000 / p.criticalSpeed.high)}–${formatPace(1000 / p.criticalSpeed.low)}` : 'Needs 3–40 min evidence'} confidence={p.criticalSpeed?.confidence} evidence={p.criticalSpeed?.evidence.length} />
        <EstimateCard icon={<Zap size={18} />} title="Critical Power" value={p.canonicalCriticalPower ? `${Math.round(p.canonicalCriticalPower.watts)} W${p.canonicalCriticalPower.source === 'platform_estimate' ? ' model' : ''}` : p.platformCriticalPower ? `${Math.round(p.platformCriticalPower.estimate)} W model` : 'Withheld'} range={p.platformCriticalPower ? `${Math.round(p.platformCriticalPower.low)}–${Math.round(p.platformCriticalPower.high)} W` : 'No supported range'} confidence={p.canonicalCriticalPower?.confidence ?? p.platformCriticalPower?.confidence} evidence={p.platformCriticalPower?.evidence.length} />
        <EstimateCard icon={<HeartPulse size={18} />} title="LT1 HR band" value={p.lt1HeartRate ? `${Math.round(p.lt1HeartRate.low)}–${Math.round(p.lt1HeartRate.high)} bpm` : 'Withheld'} range="Aerobic boundary" confidence={p.lt1HeartRate?.confidence} evidence={p.lt1HeartRate?.evidence.length} />
        <EstimateCard icon={<Gauge size={18} />} title="LT2 HR band" value={p.lt2HeartRate ? `${Math.round(p.lt2HeartRate.low)}–${Math.round(p.lt2HeartRate.high)} bpm` : 'Withheld'} range="Upper sustainable boundary" confidence={p.lt2HeartRate?.confidence} evidence={p.lt2HeartRate?.evidence.length} />
      </div>
      <div className="coach-zone-grid">{p.zones.map((zone) => <ZoneCard key={zone.name} zone={zone} />)}</div>
    </section>
  );
}

function UpcomingPlan({
  sessions,
  context,
  onUpdateSession,
}: {
  sessions: StoredPlannedSession[];
  context: CoachContextData;
  onUpdateSession: CoachPanelProps['onUpdateSession'];
}) {
  const weeks = useMemo(() => groupSessionsByWeek(sessions), [sessions]);
  if (sessions.length === 0) return <section className="product-card coach-empty-plan"><CalendarRange size={22} /><div><strong>No future block yet</strong><p>Generate a draft above. Nothing changes until you accept it.</p></div></section>;
  return (
    <section className="coach-future-weeks coach-day-by-day" aria-label="Upcoming structured training plan">
      {[...weeks.entries()].map(([weekStart, weekSessions], index) => {
        const running = weekSessions.filter((session) => !['rest', 'strength'].includes(session.sessionType));
        const minutes = running.reduce((total, session) => total + (session.plannedDurationSec ?? 0) / 60, 0);
        const distance = running.reduce((total, session) => total + (session.plannedDistanceKm ?? 0), 0);
        const accepted = weekSessions.some((session) => session.status === 'accepted' || session.status === 'planned');
        return (
          <article key={weekStart} className="product-card coach-future-week">
            <header><div><span>This week, day by day</span><h3>Week {index + 1} · {formatDateRange(weekStart, addDays(weekStart, 6))}</h3></div><small>{distance > 0 ? `${distance.toFixed(1)} km` : `${Math.round(minutes)} min`} if every session is completed · {accepted ? 'accepted' : 'proposed'}{index > 0 ? ' · contingent' : ''}</small></header>
            <div className="coach-session-list">{weekSessions.map((session) => <SessionCard key={session.id} session={session} context={context} onUpdateSession={onUpdateSession} />)}</div>
          </article>
        );
      })}
    </section>
  );
}

function SessionCard({
  session,
  context,
  onUpdateSession,
}: {
  session: StoredPlannedSession;
  context: CoachContextData;
  onUpdateSession: CoachPanelProps['onUpdateSession'];
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [date, setDate] = useState(session.plannedDate);
  const [minutes, setMinutes] = useState(String(Math.round((session.plannedDurationSec ?? 0) / 60)));
  const [purpose, setPurpose] = useState(session.purpose);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const today = localDateKey();
  const [expanded, setExpanded] = useState(session.plannedDate === today && session.priority === 'key');
  const links = context.upcomingPlan.activityLinks.filter((link) => link.plannedSessionId === session.id);
  const actual = links.map((link) => context.recentRuns.find((run) => run.id === link.activityId)).filter(Boolean);
  const editable = ['proposed', 'accepted', 'planned'].includes(session.status);
  const components = workoutComponents(session);
  const keySession = session.priority === 'key';
  const save = async () => {
    const duration = Number(minutes);
    if (!title.trim() || !Number.isFinite(duration) || duration < 0) return;
    setSaving(true);
    setError('');
    try {
      await onUpdateSession(session.id, {
        plannedDate: date,
        title: title.trim(),
        plannedDurationMin: Math.round(duration),
        purpose,
      }, session.revision);
      setEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not update this session.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <details
      className={`coach-session-card status-${session.status} type-${session.sessionType}${keySession ? ' is-key' : ''}${session.plannedDate === today ? ' is-today' : ''}`}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <div className="coach-session-date"><strong>{new Date(`${session.plannedDate}T12:00:00Z`).getUTCDate()}</strong><span>{weekday(session.plannedDate)}</span></div>
        <i className="coach-session-dot" aria-hidden="true" />
        <div className="coach-session-summary-main"><strong>{session.title}</strong><small>{session.plannedDistanceKm ? `${session.plannedDistanceKm.toFixed(1)} km` : session.plannedDurationSec ? `${Math.round(session.plannedDurationSec / 60)} min` : session.purpose}</small></div>
        <div className="coach-session-summary-target">{session.targetHrLow && session.targetHrHigh ? `${Math.round(session.targetHrLow)}–${Math.round(session.targetHrHigh)} bpm` : paceTarget(session) || session.priority}</div>
        <span className="coach-session-state">{session.plannedDate === today ? 'Today' : actual.length > 0 ? 'Done' : session.status}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <div className="coach-session-expanded">
        <div className="coach-session-main">
        <header><div><span>{session.sessionType.replaceAll('_', ' ')}</span><strong>{session.title}</strong></div><small>{keySession ? 'Key session' : 'Supporting work'} · {session.trainingPhase.replaceAll('_', ' ')}</small></header>
        <p className="coach-session-purpose-read">{session.purpose}</p>
        <div className="coach-targets">
          <span>{session.plannedDurationSec ? `${Math.round(session.plannedDurationSec / 60)} min` : 'No running'}</span>
          {session.plannedDistanceKm !== undefined && <span>{session.plannedDistanceKm.toFixed(1)} km</span>}
          {rangeLabel(session.targetPowerLowPctCp, session.targetPowerHighPctCp, '% CP', 100)}
          {rangeLabel(session.targetPowerLowW, session.targetPowerHighW, 'W')}
          {session.targetHrCeiling && <span>HR ceiling {Math.round(session.targetHrCeiling)}</span>}
          {paceTarget(session) && <span>{paceTarget(session)}</span>}
        </div>
        {components.length > 0 && (
          <section className="coach-execution-guide" aria-label={`How to execute ${session.title}`}>
            <span>How to execute</span>
            <div>{components.map((component, index) => <article key={`${component.kind}-${index}`}><i>{index + 1}</i><div><strong>{componentLabel(component)}</strong><p>{componentDetail(component)}</p></div></article>)}</div>
          </section>
        )}
        {session.fallbackPlan && <p className="coach-fallback"><strong>Fallback:</strong> {session.fallbackPlan}</p>}
        {session.coachReasoning && <p className="coach-session-reason"><strong>Why now:</strong> {session.coachReasoning}</p>}
        {actual.length > 0 && <p className="coach-actual"><Check size={13} /> Actual linked · {actual.map((run) => run?.name).join(', ')}</p>}
        {editable && !editing && <button type="button" className="coach-session-edit" onClick={() => setEditing(true)}><Pencil size={13} /> Edit session</button>}
        {editing && (
          <form className="coach-session-edit-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label><span>Date</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
            <label><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label><span>Minutes</span><input type="number" min="0" max="600" value={minutes} onChange={(event) => setMinutes(event.target.value)} /></label>
            <label className="coach-session-purpose"><span>Purpose / note</span><textarea rows={2} value={purpose} onChange={(event) => setPurpose(event.target.value)} /></label>
            <div><button type="submit" disabled={saving || !title.trim()}><Save size={13} /> {saving ? 'Saving…' : 'Save'}</button><button type="button" disabled={saving} onClick={() => setEditing(false)}>Cancel</button></div>
            {error && <p role="alert">{error}</p>}
          </form>
        )}
      </div>
      </div>
    </details>
  );
}

function RecentResponsePanel(props: CoachPanelProps & { working: string; act: (name: string, fn: () => Promise<void>) => Promise<void> }) {
  const runs = props.context?.recentRuns.slice(-5).reverse() ?? [];
  if (runs.length === 0) return null;
  return (
    <section className="product-card coach-responses">
      <header><div><span>Post-run loop</span><h3>How did the run actually cost you?</h3></div><small>Four taps + optional note</small></header>
      <div className="coach-response-list">
        {runs.map((run) => (
          <RunFeedbackCard
            key={run.id}
            run={run}
            sessions={props.context?.upcomingPlan.sessions ?? []}
            busy={Boolean(props.working)}
            onOpen={() => props.onOpenActivity(run.id)}
            onSubmit={(draft) => props.act(`feedback-${run.id}`, () => props.onSubmitFeedback(run.id, draft))}
          />
        ))}
      </div>
    </section>
  );
}

function RunFeedbackCard({ run, sessions, busy, onOpen, onSubmit }: { run: NonNullable<CoachContextData['recentRuns'][number]>; sessions: StoredPlannedSession[]; busy: boolean; onOpen: () => void; onSubmit: (draft: CoachFeedbackDraft) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [energy, setEnergy] = useState<CoachFeedbackDraft['energy']>('okay');
  const [legs, setLegs] = useState<CoachFeedbackDraft['legCondition']>('normal');
  const [pain, setPain] = useState<CoachFeedbackDraft['pain']>('none');
  const [feel, setFeel] = useState<CoachFeedbackDraft['sessionFeel']>('as_expected');
  const [note, setNote] = useState(run.feedback?.note ?? '');
  const sameDaySessions = sessions.filter((session) =>
    session.plannedDate === (run.startDateLocal ?? run.startDate).slice(0, 10) &&
    ['accepted', 'planned', 'completed', 'partial'].includes(session.status),
  );
  const plannedSessionId = run.plannedSessionIds[0]
    ?? sameDaySessions.find((session) => !['rest', 'strength'].includes(session.sessionType))?.id
    ?? sameDaySessions.find((session) => session.sessionType === 'rest')?.id;
  const hasCoachResponse = Boolean(
    run.feedback && (
      run.feedback.sessionFeel ||
      run.feedback.energy !== undefined ||
      run.feedback.legCondition ||
      run.feedback.painDuring !== undefined ||
      run.feedback.painAfter !== undefined
    ),
  );
  return (
    <article className="coach-run-response">
      <button type="button" className="coach-run-summary" onClick={onOpen}>
        <Activity size={16} /><span><strong>{run.name}</strong><small>{formatDate(run.startDateLocal ?? run.startDate)} · {run.distanceKm.toFixed(1)} km · {Math.round(run.movingTimeSec / 60)} min</small></span>
      </button>
      <div className="coach-run-cost"><span>{run.assessment.externalStress.source}</span><strong>{run.assessment.externalStress.totalStress?.toFixed(1) ?? '-'}</strong><small>stress</small></div>
      {hasCoachResponse ? (
        <div className="coach-feedback-saved"><ShieldCheck size={15} /><span>{run.verdict?.replaceAll('_', ' ') || run.feedback?.sessionFeel?.replaceAll('_', ' ') || 'Response saved'}</span><button type="button" onClick={() => setOpen((value) => !value)}>Edit</button></div>
      ) : <button type="button" className="coach-feedback-open" onClick={() => setOpen((value) => !value)}>Add response</button>}
      {open && (
        <form className="coach-feedback-form" onSubmit={(event) => { event.preventDefault(); void onSubmit({ plannedSessionId, energy, legCondition: legs, pain, sessionFeel: feel, note }); }}>
          <ChoiceRow label="Energy" value={energy} options={['good', 'okay', 'poor']} onChange={(value) => setEnergy(value as typeof energy)} />
          <ChoiceRow label="Legs" value={legs} options={['fresh', 'normal', 'heavy', 'dead']} onChange={(value) => setLegs(value as typeof legs)} />
          <ChoiceRow label="Pain" value={pain} options={['none', 'mild', 'concerning']} onChange={(value) => setPain(value as typeof pain)} />
          <ChoiceRow label="Feel" value={feel} options={['easier', 'as_expected', 'harder']} onChange={(value) => setFeel(value as typeof feel)} />
          <label><span>Optional note</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Heat, knee, Achilles, sleep, life stress…" /></label>
          <button type="submit" disabled={busy || !plannedSessionId}><Save size={14} /> Save & evaluate</button>
          {!plannedSessionId && <small>No accepted structured session is linked to this run yet.</small>}
        </form>
      )}
    </article>
  );
}

function DecisionCard({ decision, busy, onApply, onReject }: { decision: CoachDecisionRecord; busy: boolean; onApply: () => void; onReject: () => void }) {
  const patches = Array.isArray(decision.planPatch.patches) ? decision.planPatch.patches as Array<Record<string, unknown>> : [];
  return <article className="product-card coach-decision"><div><strong>{decision.summary}</strong><p>{decision.reasoning}</p><small>{patches.length} future session patch{patches.length === 1 ? '' : 'es'} · nothing changed yet</small></div><div><button type="button" className="coach-accept-button" disabled={busy} onClick={onApply}><Check size={14} /> Apply</button><button type="button" disabled={busy} onClick={onReject}><X size={14} /> Reject</button></div></article>;
}

function EstimateCard({ icon, title, value, range, confidence, evidence }: { icon: ReactNode; title: string; value: string; range: string; confidence?: string; evidence?: number }) {
  return <article className="coach-estimate-card">{icon}<span>{title}</span><strong>{value}</strong><small>{range}</small><em className={`confidence-${confidence ?? 'low'}`}>{confidence ?? 'low'} confidence · {evidence ?? 0} evidence</em></article>;
}

function ZoneCard({ zone }: { zone: PracticalZone }) {
  return <article className={`coach-zone zone-${zone.name}`}><header><strong>{zone.label}</strong><span>{zone.domain}</span></header><p>{zone.control}</p><div>{zone.powerWatts && <span>{numericRange(zone.powerWatts.low, zone.powerWatts.high, 'W')}</span>}{zone.heartRateBpm && <span>{numericRange(zone.heartRateBpm.low, zone.heartRateBpm.high, 'bpm')}</span>}{zone.pace && <span>{paceRange(zone)}</span>}</div></article>;
}

function RoadmapStep({ index, title, detail, active = false }: { index: string; title: string; detail: string; active?: boolean }) { return <article className={`coach-roadmap-step${active ? ' active' : ''}`}><span>{index}</span><div><strong>{title}</strong><small>{detail}</small></div></article>; }
function CoachStat({ label, value }: { label: string; value: string }) { return <span><small>{label}</small><strong>{value}</strong></span>; }
function ChoiceRow({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) { return <fieldset><legend>{label}</legend><div>{options.map((option) => <button key={option} type="button" className={value === option ? 'active' : ''} aria-pressed={value === option} onClick={() => onChange(option)}>{option.replaceAll('_', ' ')}</button>)}</div></fieldset>; }

function latestDecision(decisions: CoachDecisionRecord[], types: string[], status: CoachDecisionRecord['status']) { return decisions.find((decision) => types.includes(decision.decisionType) && decision.status === status); }
function stateHeadline(state: 'green' | 'amber' | 'red') { return state === 'red' ? 'Recovery overrides performance today.' : state === 'amber' ? 'Train, but protect the next decision.' : 'Build what you can repeatedly absorb.'; }
function stateExplanation(context: CoachContextData) { return context.observedState.reasons.length ? context.observedState.reasons.join(' · ') : 'No red or amber response signal is present. Only one training dimension progresses at a time.'; }
function phaseDescription(phase: CoachPhase) { return ({ aerobic_conditioning: 'Build sustainable aerobic density, long-run tolerance, strength, and relaxed speed before substantial glycolytic work.', hill_resistance: 'Maintain the aerobic base while adding conservative running-specific force, elasticity, and hills.', anaerobic_development: 'Layer limited threshold, 5K/10K-specific, and VO2 work onto the completed foundation.', coordination: 'Reduce background load, rehearse current race-specific output, and sharpen with full recovery.', recovery_regeneration: 'Deliberately reduce load until energy, mechanics, symptoms, and motivation normalize.' })[phase]; }
function confidenceLabel(value: string) { return `${value} confidence`; }
function signed(value: number) { return `${value > 0 ? '+' : ''}${value.toFixed(1)}`; }
function formatPace(sec: number) { if (!Number.isFinite(sec) || sec <= 0) return '-'; const total = Math.round(sec); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}/km`; }
function formatDate(value: string) { const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date) : value; }
function formatShortDate(value: string) { return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00Z`)); }
function weekday(value: string) { return new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(new Date(`${value}T12:00:00Z`)); }
function formatDateRange(from: string, to: string) { return `${formatShortDate(from)}–${formatShortDate(to)}`; }
function nextMonday(value: Date) { const date = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())); const offset = ((8 - date.getUTCDay()) % 7) || 7; date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); }
function isMonday(value: string) { const date = new Date(`${value}T12:00:00Z`); return Number.isFinite(date.getTime()) && date.getUTCDay() === 1; }
function addDays(value: string, days: number) { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function mondayOf(value: string) { const date = new Date(`${value}T12:00:00Z`); const offset = (date.getUTCDay() + 6) % 7; date.setUTCDate(date.getUTCDate() - offset); return date.toISOString().slice(0, 10); }
function groupSessionsByWeek(sessions: StoredPlannedSession[]) { const map = new Map<string, StoredPlannedSession[]>(); for (const session of sessions.filter((item) => item.status !== 'superseded')) { const week = mondayOf(session.plannedDate); const bucket = map.get(week) ?? []; bucket.push(session); map.set(week, bucket); } return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, items]) => [week, items.sort((a, b) => a.plannedDate.localeCompare(b.plannedDate) || a.sequence - b.sequence)])); }
function rangeLabel(low: number | undefined, high: number | undefined, unit: string, scale = 1) { if (low === undefined && high === undefined) return null; return <span>{numericRange(low === undefined ? undefined : low * scale, high === undefined ? undefined : high * scale, unit)}</span>; }
function numericRange(low: number | undefined, high: number | undefined, unit: string) { if (low !== undefined && high !== undefined) return `${Math.round(low)}–${Math.round(high)} ${unit}`; if (high !== undefined) return `<${Math.round(high)} ${unit}`; if (low !== undefined) return `>${Math.round(low)} ${unit}`; return '-'; }
function paceTarget(session: StoredPlannedSession) { if (session.targetGapLowSecPerKm === undefined && session.targetGapHighSecPerKm === undefined) return ''; return `${session.targetGapLowSecPerKm ? formatPace(session.targetGapLowSecPerKm) : ''}${session.targetGapLowSecPerKm && session.targetGapHighSecPerKm ? '–' : ''}${session.targetGapHighSecPerKm ? formatPace(session.targetGapHighSecPerKm) : ''}`; }
function paceRange(zone: PracticalZone) { const pace = zone.pace; if (!pace) return '-'; return `${pace.fastSecPerKm ? formatPace(pace.fastSecPerKm) : ''}${pace.fastSecPerKm && pace.slowSecPerKm ? '–' : ''}${pace.slowSecPerKm ? formatPace(pace.slowSecPerKm) : ''}`; }

function findNextKeySession(sessions: StoredPlannedSession[]): StoredPlannedSession | undefined {
  const today = localDateKey();
  const active = sessions
    .filter((session) => session.plannedDate >= today && !['rest', 'strength'].includes(session.sessionType) && !['cancelled', 'superseded', 'skipped'].includes(session.status))
    .sort((a, b) => a.plannedDate.localeCompare(b.plannedDate) || a.sequence - b.sequence);
  return active.find((session) => session.priority === 'key') ?? active[0];
}

function localDateKey(value = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatGoalInput(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function parseGoalTime(value: string): number | undefined {
  const parts = value.trim().split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return undefined;
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return seconds < 60 ? Math.round(minutes * 60 + seconds) : undefined;
  }
  const [hours, minutes, seconds] = parts;
  return minutes < 60 && seconds < 60 ? Math.round(hours * 3600 + minutes * 60 + seconds) : undefined;
}

function formatRaceDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function signedSeconds(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '-';
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}s`;
}

function phaseLabel(phase: CoachPhase): string {
  return ({
    aerobic_conditioning: 'Aerobic foundation',
    hill_resistance: 'Hill resistance',
    anaerobic_development: 'Capacity & specificity',
    coordination: 'Coordination & taper',
    recovery_regeneration: 'Recovery',
  })[phase];
}

function bucketStatusLabel(status: ScullionPlanRead['buckets'][number]['status']): string {
  return ({
    covered: 'Enough this block',
    building: 'In progress',
    needs_attention: 'Needs attention',
    planned_later: 'Planned later',
  })[status];
}

interface StoredWorkoutComponent {
  kind: string;
  durationMin?: number;
  count?: number;
  repetitionDurationSec?: number;
  recoveryDurationSec?: number;
  distanceM?: number;
  note?: string;
}

function workoutComponents(session: StoredPlannedSession): StoredWorkoutComponent[] {
  const value = session.workoutStructure.components;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is StoredWorkoutComponent => Boolean(item) && typeof item === 'object' && 'kind' in item && typeof item.kind === 'string');
}

function componentLabel(component: StoredWorkoutComponent): string {
  const kind = component.kind.replaceAll('_', ' ');
  if (component.count && component.repetitionDurationSec) return `${component.count} × ${formatComponentDuration(component.repetitionDurationSec)}`;
  if (component.count && component.distanceM) return `${component.count} × ${component.distanceM >= 1000 ? `${component.distanceM / 1000} km` : `${component.distanceM} m`}`;
  if (component.durationMin) return `${Math.round(component.durationMin)} min ${kind}`;
  return kind;
}

function componentDetail(component: StoredWorkoutComponent): string {
  const parts: string[] = [];
  if (component.recoveryDurationSec) parts.push(`${formatComponentDuration(component.recoveryDurationSec)} recovery`);
  if (component.note) parts.push(component.note);
  return parts.join(' · ') || 'Keep the prescribed purpose and finish with control.';
}

function formatComponentDuration(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
}
