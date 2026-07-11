import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Dumbbell,
  RotateCcw,
  Save,
} from 'lucide-react';
import { formatPace } from '../analysis/fatigue';
import { PlanSaveConflictError } from '../data/api';
import { matchPlanActualDurations, type PlanDurationMatch } from '../data/planMatching';
import type { ActivitySummary, GymSession, TrainingPlanDay } from '../types';

interface PlanViewProps {
  planDays: TrainingPlanDay[];
  activities: ActivitySummary[];
  gymSessions: GymSession[];
  loading: boolean;
  loadError: string;
  onRetry: () => Promise<void> | void;
  onSave: (
    date: string,
    patch: { plannedText?: string; notes?: string; expectedUpdatedAt: string | null },
  ) => Promise<TrainingPlanDay | void>;
  onReloadDay: (date: string) => Promise<TrainingPlanDay | undefined>;
  onOpenActivity: (id: string) => void;
  onDirtyStateChange: (dirty: boolean) => void;
}

interface DayDraft {
  plannedText: string;
  notes: string;
}

export function PlanView({
  planDays,
  activities,
  gymSessions,
  loading,
  loadError,
  onRetry,
  onSave,
  onReloadDay,
  onOpenActivity,
  onDirtyStateChange,
}: PlanViewProps) {
  const [weekStart, setWeekStart] = useState(() => dayId(startOfWeek(new Date())));
  const [dirtyDates, setDirtyDates] = useState<Set<string>>(() => new Set());

  const planByDate = useMemo(() => new Map(planDays.map((day) => [day.date, day])), [planDays]);
  const activitiesByDate = useMemo(() => groupByLocalDate(activities), [activities]);
  const gymByDate = useMemo(() => groupByLocalDate(gymSessions), [gymSessions]);
  const dates = useMemo(() => weekDateIds(weekStart), [weekStart]);

  const handleDirtyChange = useCallback((date: string, dirty: boolean) => {
    setDirtyDates((current) => {
      const next = new Set(current);
      if (dirty) {
        next.add(date);
      } else {
        next.delete(date);
      }
      return next;
    });
  }, []);

  const moveWeek = useCallback(
    (offsetWeeks: number) => {
      if (dirtyDates.size > 0 && !window.confirm('Discard unsaved changes in this week?')) {
        return;
      }
      setDirtyDates(new Set());
      setWeekStart((current) => addDays(current, offsetWeeks * 7));
    },
    [dirtyDates.size],
  );

  const goToCurrentWeek = useCallback(() => {
    const currentWeek = dayId(startOfWeek(new Date()));
    if (currentWeek === weekStart) {
      return;
    }
    if (dirtyDates.size > 0 && !window.confirm('Discard unsaved changes in this week?')) {
      return;
    }
    setDirtyDates(new Set());
    setWeekStart(currentWeek);
  }, [dirtyDates.size, weekStart]);

  useEffect(() => {
    onDirtyStateChange(dirtyDates.size > 0);
  }, [dirtyDates.size, onDirtyStateChange]);

  useEffect(() => {
    if (dirtyDates.size === 0) {
      return;
    }
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [dirtyDates.size]);

  if (loading || loadError) {
    return (
      <main className="product-page plan-view plan-editor-view">
        <PlanPageIntro />
        <section className={`product-card plan-editor-status${loadError ? ' error' : ''}`} role={loadError ? 'alert' : 'status'}>
          {loadError ? (
            <>
              <AlertCircle size={20} aria-hidden="true" />
              <div>
                <strong>Could not load the Plan</strong>
                <p>{loadError}</p>
              </div>
              <button type="button" onClick={() => void onRetry()}>
                Try again
              </button>
            </>
          ) : (
            <>
              <Clock3 size={20} aria-hidden="true" />
              <div>
                <strong>Loading your training plan</strong>
                <p>Fetching planned sessions and notes before editing is enabled.</p>
              </div>
            </>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="product-page plan-view plan-editor-view">
      <PlanPageIntro />

      <section className="product-card plan-editor-card" aria-label={`Training plan ${formatWeekRange(weekStart)}`}>
        <header className="plan-editor-toolbar">
          <div>
            <span>Training week</span>
            <strong>{formatWeekRange(weekStart)}</strong>
          </div>
          <nav className="plan-week-nav" aria-label="Choose plan week">
            <button type="button" aria-label="Previous week" title="Previous week" onClick={() => moveWeek(-1)}>
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            <button type="button" className="plan-today-button" onClick={goToCurrentWeek}>
              Today
            </button>
            <button type="button" aria-label="Next week" title="Next week" onClick={() => moveWeek(1)}>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </nav>
        </header>

        <div className="plan-editor-column-head" aria-hidden="true">
          <span>Date</span>
          <span>Planned</span>
          <span>Actual from Garmin</span>
          <span>Notes</span>
          <span>Actions</span>
        </div>

        <div className="plan-editor-days">
          {dates.map((date) => (
            <PlanDayRow
              key={date}
              date={date}
              planDay={planByDate.get(date)}
              activities={activitiesByDate.get(date) ?? []}
              gymSessions={gymByDate.get(date) ?? []}
              onSave={onSave}
              onReloadDay={onReloadDay}
              onOpenActivity={onOpenActivity}
              onDirtyChange={handleDirtyChange}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function PlanDayRow({
  date,
  planDay,
  activities,
  gymSessions,
  onSave,
  onReloadDay,
  onOpenActivity,
  onDirtyChange,
}: {
  date: string;
  planDay?: TrainingPlanDay;
  activities: ActivitySummary[];
  gymSessions: GymSession[];
  onSave: PlanViewProps['onSave'];
  onReloadDay: PlanViewProps['onReloadDay'];
  onOpenActivity: PlanViewProps['onOpenActivity'];
  onDirtyChange: (date: string, dirty: boolean) => void;
}) {
  const incoming = draftFromPlanDay(planDay);
  const [baseline, setBaseline] = useState<DayDraft>(incoming);
  const [baselineUpdatedAt, setBaselineUpdatedAt] = useState(planDay?.updatedAt);
  const [draft, setDraft] = useState<DayDraft>(incoming);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const plannedChanged = draft.plannedText !== baseline.plannedText;
  const notesChanged = draft.notes !== baseline.notes;
  const dirty = plannedChanged || notesChanged;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (dirtyRef.current) {
      return;
    }
    const next = draftFromPlanDay(planDay);
    setBaseline(next);
    setDraft(next);
    setBaselineUpdatedAt(planDay?.updatedAt);
    setConflict(false);
    setError('');
  }, [planDay?.plannedText, planDay?.legacyPlannedText, planDay?.notes, planDay?.updatedAt]);

  useEffect(() => {
    onDirtyChange(date, dirty);
    return () => onDirtyChange(date, false);
  }, [date, dirty, onDirtyChange]);

  const save = async () => {
    if (!dirty || saving) {
      return;
    }
    setSaving(true);
    setError('');
    setConflict(false);
    try {
      const patch: { plannedText?: string; notes?: string; expectedUpdatedAt: string | null } = {
        expectedUpdatedAt: baselineUpdatedAt ?? null,
      };
      if (plannedChanged) {
        patch.plannedText = draft.plannedText;
      }
      if (notesChanged) {
        patch.notes = draft.notes;
      }
      const saved = await onSave(date, patch);
      const next = saved ? draftFromPlanDay(saved) : { ...draft };
      setBaseline(next);
      setDraft(next);
      setBaselineUpdatedAt(saved?.updatedAt ?? baselineUpdatedAt);
    } catch (saveError) {
      setConflict(saveError instanceof PlanSaveConflictError);
      setError(saveError instanceof Error ? saveError.message : 'Could not save this plan day.');
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraft({ ...baseline });
    setError('');
    setConflict(false);
  };

  const reloadSavedVersion = async () => {
    setSaving(true);
    try {
      const fresh = await onReloadDay(date);
      const next = draftFromPlanDay(fresh);
      setBaseline(next);
      setDraft(next);
      setBaselineUpdatedAt(fresh?.updatedAt);
      setError('');
      setConflict(false);
    } catch (reloadError) {
      setError(reloadError instanceof Error ? reloadError.message : 'Could not reload this plan day.');
    } finally {
      setSaving(false);
    }
  };

  const legacyActual = planDay?.legacyActualText ?? '';
  const hasGarminActual = activities.length > 0 || gymSessions.length > 0;
  const legacyMatch = legacyActual ? matchPlanActualDurations(legacyActual, activities) : undefined;
  const matchedCandidateIndexes = new Set(legacyMatch?.pairs.map((pair) => pair.candidateIndex) ?? []);

  return (
    <article
      className={`plan-editor-day${isToday(date) ? ' is-today' : ''}${dirty ? ' is-dirty' : ''}`}
      data-plan-date={date}
    >
      <div className="plan-editor-date">
        <span>{formatWeekday(date)}</span>
        <strong>{formatDayDate(date)}</strong>
        {isToday(date) && <small>Today</small>}
        {planDay?.source === 'legacy-google-sheet' && <small className="plan-legacy-chip">Imported</small>}
      </div>

      <label className="plan-editor-field plan-editor-planned">
        <span>Planned</span>
        <textarea
          rows={3}
          value={draft.plannedText}
          placeholder="Add the planned session..."
          aria-label={`Planned training for ${formatAccessibleDate(date)}`}
          disabled={saving}
          onChange={(event) => setDraft((current) => ({ ...current, plannedText: event.target.value }))}
        />
        {planDay?.legacyPlannedText && planDay.plannedText !== planDay.legacyPlannedText && (
          <details className="plan-legacy-audit">
            <summary>Original sheet plan</summary>
            <p>{planDay.legacyPlannedText}</p>
          </details>
        )}
      </label>

      <section className="plan-editor-actual" aria-label={`Actual training for ${formatAccessibleDate(date)}`}>
        <span className="plan-editor-mobile-label">Actual from Garmin</span>
        {activities.length > 0 && (
          <div className="plan-actual-runs">
            {activities.map((activity, index) => (
              <button
                key={activity.id}
                type="button"
                className={`plan-actual-run${legacyActual ? matchedCandidateIndexes.has(index) ? ' matched' : ' unmatched' : ''}`}
                onClick={() => onOpenActivity(activity.id)}
              >
                <Activity size={15} aria-hidden="true" />
                <span>
                  <strong>{activity.name}</strong>
                  <small>
                    {formatDuration(activity.movingTimeSec)} · {activity.distanceKm.toFixed(1)} km ·{' '}
                    {formatPace(activity.movingTimeSec / activity.distanceKm)}
                  </small>
                  {legacyActual && (
                    <em className="plan-actual-match-state">
                      {matchedCandidateIndexes.has(index) ? 'Matched to sheet Actual' : 'Not matched to sheet Actual'}
                    </em>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}

        {gymSessions.length > 0 && (
          <div className="plan-actual-gyms">
            {gymSessions.map((session) => (
              <span key={session.id} className="plan-actual-gym">
                <Dumbbell size={14} aria-hidden="true" />
                <strong>{session.name || 'Gym'}</strong>
                <small>{formatDuration(session.durationSec)}</small>
              </span>
            ))}
          </div>
        )}

        {!hasGarminActual && !legacyActual && (
          <div className="plan-no-actual">
            <Clock3 size={15} aria-hidden="true" />
            <span>Nothing synced</span>
          </div>
        )}

        {legacyActual && (
          <LegacyActualAudit text={legacyActual} match={legacyMatch} />
        )}
      </section>

      <label className="plan-editor-field plan-editor-notes">
        <span>Notes</span>
        <textarea
          rows={3}
          value={draft.notes}
          placeholder="Add session, gym, or recovery notes..."
          aria-label={`Notes for ${formatAccessibleDate(date)}`}
          disabled={saving}
          onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
        />
      </label>

      <div className="plan-editor-actions">
        <button
          type="button"
          className="plan-save-button"
          aria-label={`Save changes for ${formatAccessibleDate(date)}`}
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          <Save size={15} aria-hidden="true" />
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          className="plan-cancel-button"
          aria-label={`Discard unsaved changes for ${formatAccessibleDate(date)}`}
          disabled={!dirty || saving}
          onClick={cancel}
        >
          <RotateCcw size={14} aria-hidden="true" />
          Cancel
        </button>
        <small className={`plan-save-state${dirty ? ' dirty' : ''}`} aria-live="polite">
          {saving ? 'Saving changes' : dirty ? 'Unsaved changes' : 'Saved'}
        </small>
        {error && (
          <p className="plan-save-error" role="alert">
            <AlertCircle size={14} aria-hidden="true" />
            {error}
          </p>
        )}
        {conflict && (
          <button type="button" className="plan-conflict-reload" disabled={saving} onClick={() => void reloadSavedVersion()}>
            Load saved version
          </button>
        )}
      </div>
    </article>
  );
}

function PlanPageIntro() {
  return (
    <section className="product-page-head plan-editor-page-head">
      <div>
        <p className="eyebrow">
          <CalendarDays size={15} aria-hidden="true" />
          Plan
        </p>
        <h2>Planned and actual training</h2>
        <p>Edit each day's plan and notes. Garmin fills the actual column automatically after sync.</p>
      </div>
    </section>
  );
}

function LegacyActualAudit({ text, match }: { text: string; match?: PlanDurationMatch }) {
  if (!match?.matched) {
    return (
      <div className="plan-legacy-actual fallback">
        <span>
          Sheet actual · {match && match.pairs.length > 0 ? 'partial duration match' : 'Garmin match pending'}
        </span>
        <p>{text}</p>
      </div>
    );
  }
  return (
    <details className="plan-legacy-actual matched">
      <summary>
        Sheet actual · {match.pairs.length} Garmin {match.pairs.length === 1 ? 'run' : 'runs'} matched
      </summary>
      <p>{text}</p>
    </details>
  );
}

function draftFromPlanDay(planDay?: TrainingPlanDay): DayDraft {
  return {
    plannedText: planDay?.plannedText ?? planDay?.legacyPlannedText ?? '',
    notes: planDay?.notes ?? '',
  };
}

function groupByLocalDate<T extends ActivitySummary | GymSession>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const date = (item.startDateLocal || item.startDate).slice(0, 10);
    const bucket = grouped.get(date);
    if (bucket) {
      bucket.push(item);
    } else {
      grouped.set(date, [item]);
    }
  }
  for (const bucket of grouped.values()) {
    bucket.sort((a, b) => (a.startDateLocal || a.startDate).localeCompare(b.startDateLocal || b.startDate));
  }
  return grouped;
}

function startOfWeek(value: Date): Date {
  const date = new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12);
  const mondayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - mondayOffset);
  return date;
}

function weekDateIds(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

function addDays(date: string, amount: number): string {
  const value = parseDay(date);
  value.setDate(value.getDate() + amount);
  return dayId(value);
}

function parseDay(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

function dayId(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isToday(date: string): boolean {
  return date === dayId(new Date());
}

function formatWeekRange(weekStart: string): string {
  const start = parseDay(weekStart);
  const end = parseDay(addDays(weekStart, 6));
  const startLabel = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(start);
  const endLabel = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(end);
  return `${startLabel} - ${endLabel}`;
}

function formatWeekday(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(parseDay(date));
}

function formatDayDate(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(parseDay(date));
}

function formatAccessibleDate(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
    parseDay(date),
  );
}

function formatDuration(seconds: number): string {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}
