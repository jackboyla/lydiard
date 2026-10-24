import { useEffect, useRef, useState } from 'react';
import { Activity, Heart } from 'lucide-react';
import type { HeartRateDurationPoint, HeartRateDurationProfile, HeartRatePeriod } from '../analysis/heartRateDuration';

const periods: HeartRatePeriod[] = [90, 60, 30];
const freshness = (period: HeartRatePeriod) => period === 30 ? 'recent' : period === 60 ? 'building' : 'historic';
const duration = (seconds: number) => seconds === 1 ? 'Sample' : seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${seconds / 60}m` : '1h';
const key = (point: HeartRateDurationPoint) => `${point.periodDays}:${point.durationSec}`;

export function HeartRateDurationChart({ profile, zoneReferenceBpm, loading, error, onRetry, onOpenActivity }: {
  profile?: HeartRateDurationProfile;
  zoneReferenceBpm?: number;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onOpenActivity: (activityId: string) => void;
}) {
  const [selection, setSelection] = useState<string>();
  const [periodFilter, setPeriodFilter] = useState<HeartRatePeriod | 'all'>('all');
  const shellRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(300, Math.round(entry.contentRect.width))));
    observer.observe(shell);
    return () => observer.disconnect();
  }, [loading, profile?.points.length]);
  const points = (profile?.points ?? []).filter((p) => periodFilter === 'all' || p.periodDays === periodFilter);
  const selected = points.find((point) => key(point) === selection);
  const peak = profile?.maxObserved;
  const yMin = Math.max(0, Math.floor((Math.min(100, ...points.map((p) => p.bpm)) - 10) / 20) * 20);
  const yMax = Math.ceil(Math.max(160, ...points.map((p) => p.bpm)) / 20) * 20;
  const x = (seconds: number) => 52 + Math.log(seconds) / Math.log(3600) * (width - 72);
  const y = (bpm: number) => 280 - (bpm - yMin) / (yMax - yMin) * 250;
  return (
    <section className="product-card power-duration-card heart-rate-duration-card" aria-labelledby="hr-duration-title">
      <header>
        <div>
          <span><Heart size={14} aria-hidden="true" /> Heart rate profile</span>
          <h2 id="hr-duration-title">Heart rate duration curve</h2>
          <p>Highest supported sample and best rolling heart rate over the last 30, 60 and 90 days. Each period includes the shorter periods.</p>
        </div>
        <div className="power-duration-cp">
          <small>Highest supported HR · 90 days</small>
          <strong>{peak ? `${peak.bpm} bpm` : '—'}</strong>
        </div>
      </header>
      {loading && !profile ? <div className="power-duration-state" role="status">Reading heart rate streams…</div>
        : error && !profile ? <div className="power-duration-state power-duration-error" role="alert"><p>{error}</p><button type="button" onClick={onRetry}>Try again</button></div>
          : profile?.points.length ? <>
            <div className="power-duration-legend" role="group" aria-label="Select heart rate period">
              {(['all', 30, 60, 90] as const).map((period) => <button key={period} type="button" aria-pressed={periodFilter === period} onClick={() => { setPeriodFilter(period); setSelection(undefined); }}>{period === 'all' ? 'All periods' : `Last ${period} days`}</button>)}
            </div>
            <div ref={shellRef} className="power-duration-chart-shell">
              <svg className="power-duration-chart" viewBox={`0 0 ${width} 330`} role="img" aria-label="Highest supported sample and best rolling heart rate by duration for the last 30, 60 and 90 days">
                <desc>Select any point to inspect the source run. High heart rate alone does not show better fitness.</desc>
                {Array.from({ length: (yMax - yMin) / 20 + 1 }, (_, i) => yMin + i * 20).map((bpm) => <g className="power-duration-grid" key={bpm}><line x1={52} y1={y(bpm)} x2={width - 20} y2={y(bpm)} /><text x={42} y={y(bpm) + 4} textAnchor="end">{bpm}</text></g>)}
                <text className="power-duration-y-unit" x={52} y={15}>bpm</text>
                {[1, 5, 30, 300, 3600].map((sec) => <g className="power-duration-x-tick" key={sec}><line x1={x(sec)} y1={30} x2={x(sec)} y2={280} /><text x={x(sec)} y={308} textAnchor="middle">{duration(sec)}</text></g>)}
                {periods.map((period) => <path key={period} className={`power-duration-segment freshness-${freshness(period)}`} d={points.filter((p) => p.periodDays === period).map((p, i) => `${i ? 'L' : 'M'} ${x(p.durationSec)} ${y(p.bpm)}`).join(' ')} />)}
                {periods.flatMap((period) => points.filter((p) => p.periodDays === period)).map((p) => <g key={key(p)} className={`power-duration-point freshness-${freshness(p.periodDays)}${selection === key(p) ? ' selected' : ''}`} role="button" tabIndex={0} aria-label={`Last ${p.periodDays} days, ${duration(p.durationSec)} at ${p.bpm} bpm, ${p.activityName}`} onFocus={() => setSelection(key(p))} onMouseEnter={() => setSelection(key(p))} onClick={() => setSelection(key(p))} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelection(key(p)); } }}><circle className="power-duration-hit" cx={x(p.durationSec)} cy={y(p.bpm)} r={14} /><circle className="power-duration-dot" cx={x(p.durationSec)} cy={y(p.bpm)} r={5} /><title>{`${duration(p.durationSec)} · ${p.bpm} bpm · ${p.activityDate.slice(0, 10)}`}</title></g>)}
              </svg>
            </div>
            <div className="power-duration-legend" aria-label="Heart rate duration periods">{[30, 60, 90].map((period) => <span key={period}><i className={`freshness-${freshness(period as HeartRatePeriod)}`} />Last {period} days</span>)}</div>
            <div className="power-duration-detail" aria-live="polite">{selected ? <><div><small>Last {selected.periodDays} days · {selected.activityDate.slice(0, 10)}</small><strong>{duration(selected.durationSec)} at {selected.bpm} bpm</strong><span>{selected.activityName} · {Math.floor(selected.startSec / 60)}:{String(Math.floor(selected.startSec % 60)).padStart(2, '0')} into run</span></div><button type="button" onClick={() => onOpenActivity(selected.activityId)}><Activity size={15} aria-hidden="true" /> View run</button></> : <p>Select a point to inspect its run.</p>}</div>
            <div className="power-duration-state">
              {peak ? <><strong>{peak.bpm} bpm · highest supported sample · {peak.confidence === 'repeated' ? 'supported by multiple runs' : 'one run; needs repeat evidence'}</strong>{peak.supportingRuns.map((run) => <button key={run.activityId} type="button" onClick={() => onOpenActivity(run.activityId)}>{run.activityDate.slice(0, 10)} · {run.bpm} bpm · View run</button>)}</> : <p>No HR sample has enough nearby readings to support a recent maximum.</p>}
              <details className="power-duration-method">
                <summary>How this is measured</summary>
                {zoneReferenceBpm && <p className="hr-zone-reference">Longer-term observed HR used for zones: <strong>{zoneReferenceBpm} bpm</strong>. This uses supported peak readings over the physiology lookback, normally 365 days. A lower recent peak does not mean your true maximum has fallen.</p>}
                {peak && <p>{profile?.explanation}</p>}
                <p>{profile?.excludedSamples ?? 0} invalid or brief high readings excluded. {profile?.rawMaxBpm ? `Highest raw sample: ${profile.rawMaxBpm} bpm (unverified).` : ''}</p>
              </details>
            </div>
          </> : <div className="power-duration-state"><strong>No heart rate curve yet</strong><p>Runs need a supported HR sample or at least 5 seconds of valid readings in the last 90 days.</p></div>}
    </section>
  );
}
