import { useEffect, useState } from 'react';
import { BAKKEN_SOURCE, type RecentEffortsResponse } from '../analysis/bakken';
import { fetchRecentBestEfforts } from '../data/api';

function duration(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor(total / 60) % 60;
  return hours ? `${hours}:${String(mins).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}` : `${mins}:${String(total % 60).padStart(2, '0')}`;
}

/** Loads the rolling 30/60/90-day efforts, reloading when runs sync or the UTC day changes. */
function useRecentEfforts(refreshKey?: string | number) {
  const [data, setData] = useState<RecentEffortsResponse | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10));
  useEffect(() => {
    const tick = window.setInterval(() => setToday(new Date().toISOString().slice(0, 10)), 60_000);
    return () => window.clearInterval(tick);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    void fetchRecentBestEfforts().then((value) => { if (!cancelled) setData(value); }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load recent efforts.');
    });
    return () => { cancelled = true; };
  }, [refreshKey, retry, today]);
  return { data, error, retry: () => setRetry((value) => value + 1) };
}

function LookbackToggle({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return <div className="recent-efforts-tabs" role="group" aria-label="Best-effort lookback">
    {[30, 60, 90].map((value) => <button key={value} type="button" aria-pressed={days === value} onClick={() => onChange(value)}>{value} days</button>)}
  </div>;
}

function LoadState({ loading, error, onRetry, label }: { loading: boolean; error: string; onRetry: () => void; label: string }) {
  if (error) return <p role="alert">{error} <button type="button" onClick={onRetry}>Retry</button></p>;
  return loading ? <p role="status">Loading {label}…</p> : null;
}

export function RecentBestEfforts({ onOpenActivity, refreshKey }: {
  onOpenActivity: (id: string) => void;
  refreshKey?: string | number;
}) {
  const { data, error, retry } = useRecentEfforts(refreshKey);
  const [days, setDays] = useState(30);
  const selectedWindow = data?.windows.find((item) => item.days === days);
  return <section className="recent-best-efforts" aria-labelledby="recent-efforts-heading">
    <header className="recent-efforts-header">
      <div><h3 id="recent-efforts-heading">Recent best efforts</h3><p>Fastest measured distance segments from your training, updated as runs arrive.</p></div>
      <LookbackToggle days={days} onChange={setDays} />
    </header>
    <LoadState loading={!data} error={error} onRetry={retry} label="recent best efforts" />
    {selectedWindow && <>
      <p className="recent-efforts-note">{selectedWindow.from} – {selectedWindow.to} · Calendar dates in UTC; window ends today. Elapsed times include stops. Rejected results stay excluded.</p>
      <div className="recent-efforts-grid">{selectedWindow.distances.map((distance) => {
        const effort = distance.efforts[0];
        return <article key={distance.label} className="recent-effort-card">
          <h4>{distance.label}</h4>
          {effort ? <button type="button" onClick={() => onOpenActivity(effort.activityId)} aria-label={`Open ${distance.label} best effort: ${effort.activityName}`}>
            <strong>{duration(effort.seconds)}</strong><span>{duration(effort.paceSecPerKm)}/km</span>
            <small>{effort.startDateLocal.slice(0, 10) || effort.startDate.slice(0, 10)} · {effort.activityName}</small>
          </button> : <p>No measured effort</p>}
        </article>;
      })}</div>
    </>}
  </section>;
}

/** Bakken interval paces inferred from the best recent race-distance effort. */
export function BakkenZone({ onOpenActivity, refreshKey }: {
  onOpenActivity: (id: string) => void;
  refreshKey?: string | number;
}) {
  const { data, error, retry } = useRecentEfforts(refreshKey);
  const [days, setDays] = useState(30);
  const zone = data?.windows.find((item) => item.days === days)?.goldenZone;
  return <section className="recent-best-efforts bakken-zone" aria-labelledby="bakken-heading">
    <header className="recent-efforts-header">
      <div><h3 id="bakken-heading">Bakken Golden Zone</h3><p>Interval paces inferred from your best recent race-distance effort.</p></div>
      <LookbackToggle days={days} onChange={setDays} />
    </header>
    <LoadState loading={!data} error={error} onRetry={retry} label="Bakken paces" />
    {data && (zone ? <>
      <p><strong>{duration(zone.thresholdPaceSecPerKm)}/km threshold</strong> · VDOT {zone.vdot.toFixed(1)} · Provisional training estimate</p>
      <p>Based on the highest VDOT among your measured 5K, 10K, half marathon and marathon efforts in these {days} days: <button type="button" className="bakken-source" onClick={() => onOpenActivity(zone.effort.activityId)}>{zone.distanceLabel} in {duration(zone.effort.seconds)} · {zone.effort.startDateLocal.slice(0, 10) || zone.effort.startDate.slice(0, 10)}</button>.</p>
      <div className="bakken-intervals">{zone.intervals.map((interval) => <article key={interval.label}><span>{interval.label} repetitions</span><strong>{duration(interval.fastPaceSecPerKm)}–{duration(interval.slowPaceSecPerKm)}/km</strong></article>)}</div>
      <p className="recent-efforts-note">Training segments may fall short of race effort. GPS errors, hills and conditions can also distort the estimate. Bakken’s calculator uses race times; these paces do not establish your measured lactate threshold.</p>
    </> : <p>A measured 5K, 10K, half marathon or marathon segment in this window is needed to infer paces.</p>)}
    <a href={BAKKEN_SOURCE} target="_blank" rel="noreferrer">Marius Bakken’s method and calculator</a>
  </section>;
}
