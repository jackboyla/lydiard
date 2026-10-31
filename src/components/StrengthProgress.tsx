import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, Dumbbell } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getStrengthSets } from '../data/api';
import type { GymSession, StrengthSet } from '../types';
import './strength.css';

export const exerciseKey = (name: string) => name.trim().toLocaleLowerCase();
export function displayGymDate(date: string) {
  return new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function setSummary(sets: StrengthSet[]) {
  const groups: { label: string; count: number; known: boolean }[] = [];
  for (const set of sets) {
    const detail = [set.reps != null ? `${set.reps} reps` : '', set.weightKg != null ? `${set.weightKg} kg` : '', set.distanceM != null ? `${set.distanceM} m` : '', set.durationSec != null ? `${set.durationSec}s` : ''].filter(Boolean).join(' · ') || set.note || 'Details not recorded';
    const previous = groups.at(-1);
    if (previous?.label === detail && previous.known && set.setNumber != null) previous.count += 1;
    else groups.push({ label: detail, count: 1, known: set.setNumber != null });
  }
  return groups;
}

export function ExerciseHistory({ exercise, sets, gymSessions, onBack, backLabel = 'All exercises' }: { exercise: string; sets: StrengthSet[]; gymSessions: GymSession[]; onBack: () => void; backLabel?: string }) {
  const [metric, setMetric] = useState<'weight' | 'reps'>(() => sets.some(set => exerciseKey(set.exercise) === exerciseKey(exercise) && (set.weightKg ?? 0) > 0) ? 'weight' : 'reps');
  const entries = useMemo(() => {
    const dates = new Map(gymSessions.map(session => [session.id, session.startDateLocal || session.startDate]));
    const bySession = new Map<string, StrengthSet[]>();
    for (const set of sets.filter(set => exerciseKey(set.exercise) === exerciseKey(exercise))) {
      const group = bySession.get(set.gymSessionId) ?? [];
      group.push(set);
      bySession.set(set.gymSessionId, group);
    }
    return [...bySession].map(([id, sessionSets]) => ({ id, date: dates.get(id)?.slice(0, 10), sets: sessionSets })).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  }, [exercise, sets, gymSessions]);
  const chart = entries.filter(entry => entry.date).map(entry => ({ date: entry.date!, weight: Math.max(...entry.sets.flatMap(set => set.weightKg != null ? [set.weightKg] : []), 0), reps: Math.max(...entry.sets.map(set => set.reps ?? 0), 0) })).filter(point => point[metric] > 0);
  const heaviest = Math.max(0, ...entries.flatMap(entry => entry.sets.map(set => set.weightKg ?? 0)));
  const knownSets = entries.reduce((total, entry) => total + entry.sets.filter(set => set.setNumber != null).length, 0);
  return <section className="strength-history">
    <button type="button" className="strength-back" onClick={onBack}><ArrowLeft size={16} /> {backLabel}</button>
    <div className="strength-heading"><div><span className="strength-eyebrow">EXERCISE HISTORY</span><h2>{exercise}</h2></div><Dumbbell size={26} /></div>
    <div className="strength-stats"><div><strong>{entries.length}</strong><span>sessions</span></div><div><strong>{knownSets}</strong><span>known sets</span></div><div><strong>{heaviest > 0 ? `${heaviest} kg` : '—'}</strong><span>heaviest set</span></div></div>
    <label className="strength-chart-metric">Track <select aria-label="Progress metric" value={metric} onChange={event => setMetric(event.target.value as 'weight' | 'reps')}><option value="weight">Heaviest set (kg)</option><option value="reps">Most reps in a set</option></select></label>
    {chart.length > 1 && <div className="strength-chart"><p>{metric === 'weight' ? 'Heaviest recorded set · kg' : 'Most recorded reps in a set'}</p><ResponsiveContainer width="100%" height={180}><LineChart data={chart} margin={{ left: -20, right: 12, top: 10, bottom: 8 }}><CartesianGrid stroke="var(--border-soft)" vertical={false} /><XAxis dataKey="date" tickFormatter={value => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} tick={{ fill: 'var(--muted)', fontSize: 11 }} minTickGap={35} /><YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} /><Tooltip labelFormatter={value => displayGymDate(String(value))} contentStyle={{ background: 'var(--surface)', borderColor: 'var(--border)', borderRadius: 10 }} formatter={value => [`${value}${metric === 'weight' ? ' kg' : ' reps'}`, metric === 'weight' ? 'Heaviest set' : 'Most reps']} /><Line type="linear" dataKey={metric} stroke="var(--green)" strokeWidth={3} dot={{ r: 4, fill: 'var(--green)' }} /></LineChart></ResponsiveContainer></div>}
    <div className="strength-timeline">{[...entries].reverse().map(entry => <article key={entry.id}><div className="strength-history-date">{entry.date ? displayGymDate(entry.date) : 'Session date unavailable'}<span>{entry.sets.some(set => set.setNumber == null) ? (entry.sets.every(set => set.setNumber == null) ? 'Sets not recorded' : 'Some sets not recorded') : `${entry.sets.length} ${entry.sets.length === 1 ? 'set' : 'sets'}`}</span></div><div>{setSummary(entry.sets).map((group, index) => <p key={index}>{group.known ? <strong>{group.count} × </strong> : <strong>Sets not recorded · </strong>}{group.label}</p>)}{[...new Set(entry.sets.flatMap(set => [set.rawText, set.note]).filter(Boolean))].map(note => <small key={note}>{note}</small>)}</div></article>)}</div>
    {!entries.length && <p className="strength-empty">Your first recorded session will appear here.</p>}
  </section>;
}

export function StrengthProgress({ gymSessions }: { gymSessions: GymSession[] }) {
  const [sets, setSets] = useState<StrengthSet[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let active = true;
    setState('loading');
    getStrengthSets().then(data => { if (active) { setSets(data); setState('ready'); } }).catch(() => { if (active) setState('error'); });
    return () => { active = false; };
  }, [attempt]);
  const exercises = useMemo(() => {
    const groups = new Map<string, { name: string; sessions: Set<string>; sets: number; last: string }>();
    const dates = new Map(gymSessions.map(session => [session.id, (session.startDateLocal || session.startDate).slice(0, 10)]));
    for (const set of sets) {
      const key = exerciseKey(set.exercise);
      const item = groups.get(key) ?? { name: set.exercise, sessions: new Set<string>(), sets: 0, last: '' };
      item.sessions.add(set.gymSessionId); item.sets += set.setNumber == null ? 0 : 1; item.last = [item.last, dates.get(set.gymSessionId) ?? ''].sort().at(-1)!;
      groups.set(key, item);
    }
    return [...groups.values()].sort((a, b) => b.last.localeCompare(a.last) || a.name.localeCompare(b.name));
  }, [sets, gymSessions]);
  if (state === 'loading') return <p className="strength-empty" role="status">Loading your gym history…</p>;
  if (state === 'error') return <div className="strength-empty" role="alert"><p>Couldn’t load your gym history.</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button></div>;
  if (selected) return <ExerciseHistory exercise={selected} sets={sets} gymSessions={gymSessions} onBack={() => setSelected(null)} />;
  return <section className="strength-progress"><div className="strength-heading"><div><span className="strength-eyebrow">STRENGTH, OVER TIME</span><h2>Your exercises</h2><p>Every set. Every session. All in one place.</p></div><Dumbbell size={28} /></div>
    {exercises.length > 0 && <input className="strength-search" aria-label="Find an exercise" placeholder="Find an exercise…" value={query} onChange={event => setQuery(event.target.value)} />}
    <div className="strength-exercise-list">{exercises.filter(item => exerciseKey(item.name).includes(exerciseKey(query))).map(item => <button type="button" key={exerciseKey(item.name)} onClick={() => setSelected(item.name)}><span><strong>{item.name}</strong><small>{item.sessions.size} {item.sessions.size === 1 ? 'session' : 'sessions'} · {item.sets} known sets{item.last && ` · Last ${displayGymDate(item.last)}`}</small></span><ChevronRight size={20} /></button>)}</div>
    {!exercises.length && <div className="strength-empty"><Dumbbell size={32} /><p>Your strength story starts in Log.</p><small>Tap a gym session and add your exercises to track them here.</small></div>}
    {exercises.length > 0 && !exercises.some(item => exerciseKey(item.name).includes(exerciseKey(query))) && <p className="strength-empty">No exercises match “{query}”.</p>}
  </section>;
}
