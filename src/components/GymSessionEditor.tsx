import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Dumbbell, History, Plus, Trash2, X } from 'lucide-react';
import { getGymSessions, getGymSets, getStrengthSets, saveGymSets } from '../data/api';
import type { GymSession, StrengthSet } from '../types';
import { displayGymDate, exerciseKey, ExerciseHistory } from './StrengthProgress';
import './strength.css';

type ExerciseRow = { key: string; exercise: string; count: string; reps: string; weight: string; originals: StrengthSet[] };
function rowsFromSets(sets: StrengthSet[]): ExerciseRow[] {
  const rows: ExerciseRow[] = [];
  for (const set of sets) {
    const last = set.setNumber == null ? undefined : rows.find(row => {
      const previous = row.originals[0];
      return previous.setNumber != null && ['exercise', 'reps', 'weightKg', 'distanceM', 'durationSec', 'rir', 'note', 'rawText', 'source'].every(key => previous[key as keyof StrengthSet] === set[key as keyof StrengthSet]);
    });
    if (last) {
      last.originals.push(set); last.count = String(last.originals.length);
    } else rows.push({ key: set.id, exercise: set.exercise, count: set.setNumber == null ? '' : '1', reps: set.reps == null ? '' : String(set.reps), weight: set.weightKg == null ? '' : String(set.weightKg), originals: [set] });
  }
  return rows;
}
function blankRow(): ExerciseRow { return { key: crypto.randomUUID(), exercise: '', count: '', reps: '', weight: '', originals: [] }; }

export function GymSessionEditor({ session, onClose }: { session: GymSession; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const listId = useId();
  const [rows, setRows] = useState<ExerciseRow[]>([]);
  const [baseline, setBaseline] = useState('[]');
  const [version, setVersion] = useState<string | null>(null);
  const [allSets, setAllSets] = useState<StrengthSet[]>([]);
  const [sessions, setSessions] = useState<GymSession[]>([session]);
  const [loadError, setLoadError] = useState('');
  const [historyError, setHistoryError] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [history, setHistory] = useState<string | null>(null);
  const dirty = JSON.stringify(rows) !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = () => { if (!saving && (!dirty || window.confirm('Discard your unsaved gym session changes?'))) onClose(); };
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    const handleCancel = (event: Event) => { event.preventDefault(); if (!savingRef.current && (!dirtyRef.current || window.confirm('Discard your unsaved gym session changes?'))) closeRef.current(); };
    element.addEventListener('cancel', handleCancel);
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { element.removeEventListener('cancel', handleCancel); element.close(); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);
  useEffect(() => {
    let active = true;
    setLoadError(''); setVersion(null);
    getGymSets(session.id).then(data => {
      if (!active) return;
      const initial = rowsFromSets(data.sets);
      setRows(initial); setBaseline(JSON.stringify(initial)); setVersion(data.version);
    }).catch(error => { if (active) setLoadError(error instanceof Error ? error.message : 'Couldn’t load this session.'); });
    Promise.all([getStrengthSets(), getGymSessions()]).then(([sets, gym]) => { if (active) { setAllSets(sets); setSessions(gym.some(item => item.id === session.id) ? gym : [...gym, session]); setHistoryError(false); } }).catch(() => { if (active) setHistoryError(true); });
    return () => { active = false; };
  }, [session.id, attempt]);
  const names = useMemo(() => [...new Map(allSets.map(set => [exerciseKey(set.exercise), set.exercise])).values()].sort((a, b) => a.localeCompare(b)), [allSets]);
  const update = (key: string, patch: Partial<ExerciseRow>) => setRows(current => current.map(row => row.key === key ? { ...row, ...patch } : row));
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (version === null || saving) return;
    setSaving(true); setSaveError('');
    const now = new Date().toISOString();
    const sets: StrengthSet[] = [];
    for (const row of rows) {
      for (let index = 0; index < (row.count === '' ? 1 : Number(row.count)); index += 1) {
        const original = row.originals[index];
        const template = original ?? row.originals[0];
        sets.push({ ...(template ?? { rawText: '', note: '', source: 'manual', createdAt: now, updatedAt: now }), id: original?.id ?? crypto.randomUUID(), gymSessionId: session.id, exercise: names.find(name => exerciseKey(name) === exerciseKey(row.exercise)) ?? row.exercise.trim(), reps: row.reps === '' ? undefined : Number(row.reps), weightKg: row.weight === '' ? undefined : Number(row.weight), setNumber: row.count === '' ? undefined : sets.length + 1 });
      }
    }
    try { await saveGymSets(session.id, sets, version); onClose(); }
    catch (error) { setSaveError(error instanceof Error ? error.message : 'Couldn’t save this session. Your changes are still here.'); }
    finally { setSaving(false); }
  }
  return <dialog className="gym-dialog" ref={dialog} aria-labelledby={`${listId}-title`}>
    <header className="gym-dialog-header"><div className="gym-dialog-icon"><Dumbbell size={23} /></div><div><span className="strength-eyebrow">GYM SESSION</span><h2 id={`${listId}-title`}>{session.name || 'Strength session'}</h2><p>{displayGymDate(session.startDateLocal || session.startDate)}{session.durationSec > 0 && ` · ${Math.round(session.durationSec / 60)} min`}</p></div><button type="button" className="strength-icon-button" aria-label="Close gym session" onClick={close} disabled={saving}><X size={22} /></button></header>
    {history ? <div className="gym-dialog-body"><ExerciseHistory exercise={history} sets={allSets} gymSessions={sessions} backLabel="Back to session" onBack={() => setHistory(null)} /></div> : <form onSubmit={save}>
      <div className="gym-dialog-body">
        {loadError ? <div className="strength-empty" role="alert"><p>{loadError}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button></div> : version === null ? <p className="strength-empty" role="status">Loading your session…</p> : <>
          <div className="gym-editor-intro"><h3>What did you lift?</h3><p>Only the exercise name is required. Group matching sets, or leave the details blank.</p></div>
          <datalist id={listId}>{names.map(name => <option key={name} value={name} />)}</datalist>
          <fieldset className="gym-editor-fields" disabled={saving}>
            {rows.map((row, index) => <article className="gym-exercise-card" key={row.key}>
              <div className="gym-exercise-top"><span className="gym-exercise-number">{String(index + 1).padStart(2, '0')}</span><span>Exercise</span><button type="button" className="strength-icon-button" aria-label={`Remove ${row.exercise || `exercise ${index + 1}`}`} onClick={() => setRows(current => current.filter(item => item.key !== row.key))}><Trash2 size={17} /></button></div>
              <input aria-label={`Exercise ${index + 1}`} required maxLength={120} list={listId} placeholder="Choose or type an exercise" value={row.exercise} onChange={event => update(row.key, { exercise: event.target.value })} />
              <div className="gym-set-fields"><label>Sets<input type="number" inputMode="numeric" placeholder="Unknown" min="1" max="100" step="1" value={row.count} onChange={event => update(row.key, { count: event.target.value })} /></label><label>Reps<input type="number" inputMode="numeric" min={row.originals[0]?.reps === 0 ? 0 : 1} max="1000" step="1" placeholder="—" value={row.reps} onChange={event => update(row.key, { reps: event.target.value })} /></label><label>Weight <small>kg</small><input type="number" inputMode="decimal" min="0" max="2000" step="any" placeholder="Optional" value={row.weight} onChange={event => update(row.key, { weight: event.target.value })} /></label></div>
              {row.originals[0]?.rawText && <p className="gym-original-note">{row.originals[0].rawText}</p>}
              {row.originals[0]?.note && <p className="gym-original-note">{row.originals[0].note}</p>}
              {row.originals[0] && (row.originals[0].distanceM != null || row.originals[0].durationSec != null) && <p className="gym-original-note">{[row.originals[0].distanceM != null ? `${row.originals[0].distanceM} m` : '', row.originals[0].durationSec != null ? `${row.originals[0].durationSec}s` : ''].filter(Boolean).join(' · ')}</p>}
              {!historyError && allSets.some(set => exerciseKey(set.exercise) === exerciseKey(row.exercise)) && <button type="button" className="gym-history-link" onClick={() => setHistory(names.find(name => exerciseKey(name) === exerciseKey(row.exercise)) ?? row.exercise)}><History size={15} /> View exercise history</button>}
            </article>)}
            {!rows.length && <div className="strength-empty"><p>Add your first exercise.</p><small>Your previous exercises will be ready to select next time.</small></div>}
            <button type="button" className="gym-add-exercise" onClick={() => setRows(current => [...current, blankRow()])}><Plus size={18} /> Add exercise</button>
            {names.length > 0 && <div className="gym-quick-select"><span>Quick add</span><div>{names.slice(0, 10).map(name => <button type="button" key={name} onClick={() => setRows(current => [...current, { ...blankRow(), exercise: name }])}>{name}<Plus size={12} /></button>)}</div></div>}
          </fieldset>
          {historyError && <p className="strength-error" role="status">Exercise suggestions and history couldn’t load. You can still save this session.</p>}
        </>}
        {saveError && <p className="strength-error" role="alert">{saveError}</p>}
      </div>
      <footer className="gym-dialog-footer"><span>{rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0)} known sets · {new Set(rows.map(row => exerciseKey(row.exercise)).filter(Boolean)).size} exercises</span><button type="submit" className="gym-save" disabled={version === null || saving || !dirty}>{saving ? 'Saving…' : <><Check size={18} /> Save session</>}</button></footer>
    </form>}
  </dialog>;
}
