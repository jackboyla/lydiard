import { useEffect, useState } from 'react';
import { BAKKEN_SOURCE, type RecentEffortsResponse } from '../analysis/bakken';
import { fetchRecentBestEfforts } from '../data/api';

function duration(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor(total / 60) % 60;
  return hours ? `${hours}:${String(mins).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}` : `${mins}:${String(total % 60).padStart(2, '0')}`;
}

export function RecentBestEfforts({ onOpenActivity, refreshKey }: {
  onOpenActivity: (id: string) => void;
  refreshKey?: string | number;
}) {
  const [data, setData] = useState<RecentEffortsResponse | null>(null);
  const [days, setDays] = useState(30);
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
  const selectedWindow = data?.windows.find((item) => item.days === days);
  const zone = selectedWindow?.goldenZone;
  return <section className="recent-best-efforts" aria-labelledby="recent-efforts-heading">
    <header className="recent-efforts-header">
      <div><h3 id="recent-efforts-heading">Recent best efforts</h3><p>Fastest measured distance segments from your training, updated as runs arrive.</p></div>
      <div className="recent-efforts-tabs" role="group" aria-label="Best-effort lookback">
        {[30, 60, 90].map((value) => <button key={value} type="button" aria-pressed={days === value} onClick={() => setDays(value)}>{value} days</button>)}
      </div>
    </header>
    {error && <p role="alert">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></p>}
    {!data && !error && <p role="status">Loading recent best efforts…</p>}
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
      <section className="bakken-zone" aria-labelledby="bakken-heading">
        <h3 id="bakken-heading">Bakken Golden Zone</h3>
        {zone ? <>
          <p><strong>{duration(zone.thresholdPaceSecPerKm)}/km threshold</strong> · VDOT {zone.vdot.toFixed(1)} · Provisional training estimate</p>
          <p>Based on the highest VDOT among your measured 5K, 10K, half marathon and marathon efforts in these {days} days: <button type="button" className="bakken-source" onClick={() => onOpenActivity(zone.effort.activityId)}>{zone.distanceLabel} in {duration(zone.effort.seconds)} · {zone.effort.startDateLocal.slice(0, 10) || zone.effort.startDate.slice(0, 10)}</button>.</p>
          <div className="bakken-intervals">{zone.intervals.map((interval) => <article key={interval.label}><span>{interval.label} repetitions</span><strong>{duration(interval.fastPaceSecPerKm)}–{duration(interval.slowPaceSecPerKm)}/km</strong></article>)}</div>
          <p className="recent-efforts-note">Training segments may fall short of race effort. GPS errors, hills and conditions can also distort the estimate. Bakken’s calculator uses race times; these paces do not establish your measured lactate threshold.</p>
        </> : <p>A measured 5K, 10K, half marathon or marathon segment in this window is needed to infer paces.</p>}
        <a href={BAKKEN_SOURCE} target="_blank" rel="noreferrer">Marius Bakken’s method and calculator</a>
      </section>
    </>}
  </section>;
}
