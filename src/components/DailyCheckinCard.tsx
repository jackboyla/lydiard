import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, MessageCircleHeart, Pencil, Plus, X } from 'lucide-react';
import type { DailyCheckin, DailyCheckinDraft } from '../types';
import { PushReminderControl } from './PushReminderControl';

const QUESTIONS = [
  {
    key: 'legFreshness',
    short: 'Legs',
    question: 'How do your legs feel?',
    hint: 'Think mechanical freshness, not cardio.',
    values: ['Cooked', 'Heavy', 'Okay', 'Good', 'Fresh'],
    start: 1,
  },
  {
    key: 'energy',
    short: 'Energy',
    question: 'How is your overall energy?',
    hint: 'Your whole-day energy, not just this moment.',
    values: ['Empty', 'Low', 'Okay', 'Good', 'High'],
    start: 1,
  },
  {
    key: 'painLevel',
    short: 'Niggles',
    question: 'Any pain or niggles?',
    hint: 'Count anything you would manage during a run.',
    values: ['None', 'Mild', 'Moderate', 'Significant'],
    start: 0,
  },
  {
    key: 'motivation',
    short: 'Drive',
    question: 'How keen are you to train?',
    hint: 'The honest answer is the useful one.',
    values: ['None', 'Low', 'Okay', 'Good', 'High'],
    start: 1,
  },
  {
    key: 'sleepQuality',
    short: 'Sleep',
    question: 'How did you sleep?',
    hint: 'Judge how restored you feel this morning.',
    values: ['Poor', 'Weak', 'Okay', 'Good', 'Great'],
    start: 1,
  },
] as const;

type PulseKey = typeof QUESTIONS[number]['key'];
type DraftValues = Record<PulseKey, number | undefined>;

export function DailyCheckinCard({
  checkins,
  loading,
  onSave,
}: {
  checkins: DailyCheckin[];
  loading: boolean;
  onSave: (draft: DailyCheckinDraft) => Promise<void>;
}) {
  const today = localDay();
  const saved = checkins.find((item) => item.day === today);
  const [editing, setEditing] = useState(!saved);
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<DraftValues>(() => valuesFrom(saved));
  const [note, setNote] = useState(saved?.note ?? '');
  const [noteOpen, setNoteOpen] = useState(Boolean(saved?.note));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const advanceTimer = useRef<number | null>(null);
  const recent = useMemo(() => [...checkins].sort((a, b) => a.day.localeCompare(b.day)).slice(-7), [checkins]);

  useEffect(() => {
    setValues(valuesFrom(saved));
    setNote(saved?.note ?? '');
    setNoteOpen(Boolean(saved?.note));
    setEditing(!saved);
    setStep(0);
  }, [saved?.updatedAt, today]);

  useEffect(() => () => {
    if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
  }, []);

  const current = QUESTIONS[step];
  const completed = QUESTIONS.filter((question) => values[question.key] !== undefined).length;

  const submit = async (nextValues: DraftValues) => {
    if (!QUESTIONS.every((question) => nextValues[question.key] !== undefined)) return;
    setWorking(true);
    setError('');
    try {
      await onSave({
        day: today,
        legFreshness: nextValues.legFreshness!,
        energy: nextValues.energy!,
        painLevel: nextValues.painLevel!,
        motivation: nextValues.motivation!,
        sleepQuality: nextValues.sleepQuality!,
        note: note.trim(),
      });
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save today’s check-in.');
    } finally {
      setWorking(false);
    }
  };

  const choose = (key: PulseKey, value: number) => {
    const nextValues = { ...values, [key]: value };
    setValues(nextValues);
    setError('');
    if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
    if (step < QUESTIONS.length - 1) {
      advanceTimer.current = window.setTimeout(() => setStep((currentStep) => Math.min(currentStep + 1, QUESTIONS.length - 1)), 140);
    } else {
      void submit(nextValues);
    }
  };

  const startEditing = (targetStep = 0, openNote = Boolean(saved?.note)) => {
    setValues(valuesFrom(saved));
    setNote(saved?.note ?? '');
    setNoteOpen(openNote);
    setStep(targetStep);
    setError('');
    setEditing(true);
  };

  if (loading) {
    return (
      <section className="daily-pulse daily-pulse-loading" aria-label="Daily check-in">
        <span className="daily-pulse-mark"><MessageCircleHeart size={18} /></span>
        <div><p>Daily pulse</p><strong>Getting today ready…</strong></div>
      </section>
    );
  }

  if (saved && !editing) {
    return (
      <section className="daily-pulse daily-pulse-saved" aria-label="Daily check-in recorded">
        <div className="daily-pulse-saved-lead">
          <span className="daily-pulse-mark is-complete"><Check size={18} /></span>
          <div>
            <p>Daily pulse</p>
            <strong>Today is recorded</strong>
          </div>
        </div>
        <div className="daily-pulse-readings">
          {QUESTIONS.map((question, index) => (
            <button type="button" key={question.key} onClick={() => startEditing(index)} aria-label={`Edit ${question.short}`}>
              <span>{question.short}</span>
              <strong>{displayValue(question.key, saved)}</strong>
            </button>
          ))}
        </div>
        <div className="daily-pulse-saved-tail">
          <div className="daily-pulse-trend" aria-label={`${recent.length} recent check-ins`}>
            {recent.map((item) => (
              <span key={item.day} className={freshnessTone(item.legFreshness)} title={`${item.day}: legs ${item.legFreshness ?? '—'}/5`} />
            ))}
          </div>
          <button className="daily-pulse-edit" type="button" onClick={() => startEditing()}><Pencil size={14} /> Edit</button>
        </div>
        {saved.note && <button className="daily-pulse-note-preview" type="button" onClick={() => startEditing(4, true)}>“{saved.note}”</button>}
        <PushReminderControl />
      </section>
    );
  }

  return (
    <section className="daily-pulse daily-pulse-flow" aria-label="Daily check-in">
      <div className="daily-pulse-topline">
        <div className="daily-pulse-brand">
          <span className="daily-pulse-mark"><MessageCircleHeart size={18} /></span>
          <div><p>Daily pulse</p><strong>{saved ? 'Update today' : 'Five taps. Ten seconds.'}</strong></div>
        </div>
        <div className="daily-pulse-step-count"><strong>{step + 1}</strong><span>/ {QUESTIONS.length}</span></div>
      </div>

      <div className="daily-pulse-progress" aria-hidden="true">
        {QUESTIONS.map((question, index) => (
          <span
            key={question.key}
            className={`${index === step ? 'current' : ''}${values[question.key] !== undefined ? ' complete' : ''}`}
          />
        ))}
      </div>

      <div className="daily-pulse-question" key={current.key}>
        <div>
          <span>{current.short}</span>
          <h2>{current.question}</h2>
          <p>{current.hint}</p>
        </div>
        <div className={`daily-pulse-choices choices-${current.values.length}`} role="radiogroup" aria-label={current.question}>
          {current.values.map((label, index) => {
            const value = current.start + index;
            const selected = values[current.key] === value;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                className={selected ? 'selected' : ''}
                key={value}
                disabled={working}
                onClick={() => choose(current.key, value)}
              >
                <span>{value}</span>
                <strong>{label}</strong>
              </button>
            );
          })}
        </div>
      </div>

      <div className="daily-pulse-footer">
        <button
          className="daily-pulse-back"
          type="button"
          disabled={step === 0 || working}
          onClick={() => setStep((currentStep) => Math.max(0, currentStep - 1))}
        ><ChevronLeft size={15} /> Back</button>
        <button className="daily-pulse-add-note" type="button" onClick={() => setNoteOpen((open) => !open)}>
          {noteOpen ? <X size={14} /> : <Plus size={14} />} {noteOpen ? 'Close note' : note ? 'Edit note' : 'Add a note'}
        </button>
        <span>{working ? 'Saving today…' : `${completed} of ${QUESTIONS.length} answered`}</span>
        {saved && <button className="daily-pulse-cancel" type="button" onClick={() => setEditing(false)}>Cancel</button>}
      </div>

      {noteOpen && (
        <label className="daily-pulse-note">
          <span>Optional note</span>
          <input value={note} maxLength={1000} autoFocus placeholder="One line is enough" onChange={(event) => setNote(event.target.value)} />
        </label>
      )}
      {error && <p className="daily-pulse-error" role="alert">{error} Tap your last answer to try again.</p>}
    </section>
  );
}

function valuesFrom(checkin: DailyCheckin | undefined): DraftValues {
  return {
    legFreshness: checkin?.legFreshness,
    energy: checkin?.energy,
    painLevel: checkin?.painLevel,
    motivation: checkin?.motivation,
    sleepQuality: checkin?.sleepQuality,
  };
}

function localDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function displayValue(key: PulseKey, checkin: DailyCheckin): string {
  const question = QUESTIONS.find((item) => item.key === key)!;
  const raw = checkin[key];
  if (raw === undefined) return '—';
  return question.values[raw - question.start] ?? String(raw);
}

function freshnessTone(value: number | undefined): string {
  return value === undefined ? 'muted' : value <= 2 ? 'low' : value === 3 ? 'middle' : 'good';
}
