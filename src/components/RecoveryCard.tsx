import { Activity } from 'lucide-react';
import type { RecoveryDaily, SignalStatus } from '../analysis/recovery';
import type { RecoveryState } from '../types';
import type { CoachContextData } from '../data/coachTypes';

type Recovery = NonNullable<CoachContextData['recovery']>;
type Tone = 'good' | 'watch' | 'bad' | 'muted';

const STATE_LABEL: Record<RecoveryState, string> = {
  recovered: 'Recovered',
  normal: 'Normal',
  slightly_suppressed: 'Slightly suppressed',
  suppressed: 'Suppressed',
  high_stress: 'High stress',
};

/**
 * Objective overnight recovery (Fitbit via Google Health), normalized to the
 * runner's own rolling baseline. Sits alongside training load and the observed
 * state so the coach read shows how the whole organism absorbed the work — not
 * just what was imposed.
 */
export function RecoveryCard({ recovery }: { recovery?: Recovery }) {
  const latest = recovery && recovery.recent.length > 0 ? recovery.recent[recovery.recent.length - 1] : null;
  const summary = recovery?.summary;

  if (!recovery || !latest || !summary || !summary.state) {
    return (
      <article className="product-card recovery-card recovery-card-empty">
        <header className="recovery-head">
          <span className="recovery-eyebrow"><Activity size={15} aria-hidden="true" /> Overnight recovery</span>
        </header>
        <p className="recovery-empty-note">
          No overnight recovery data yet. Once Fitbit sleep, HRV and resting-HR sync, this shows how your body is
          absorbing training against your own baseline.
        </p>
      </article>
    );
  }

  const tone = stateTone(summary.state);
  const metrics = buildMetrics(latest);

  return (
    <article className={`product-card recovery-card recovery-state-${tone}`}>
      <header className="recovery-head">
        <span className="recovery-eyebrow"><Activity size={15} aria-hidden="true" /> Overnight recovery</span>
        <small>{summary.confidence ?? 'low'} confidence · {formatDay(summary.asOf)}</small>
      </header>

      <div className="recovery-state-row">
        <span className={`coach-state-pill ${tone}`}>{summary.state ? STATE_LABEL[summary.state] : 'Unknown'}</span>
        {summary.suppressedStreak >= 2 && (
          <span className="recovery-streak">{summary.suppressedStreak} nights suppressed</span>
        )}
        {summary.readinessCrossCheck !== 'unknown' && (
          <span className={`recovery-readiness ${summary.readinessCrossCheck === 'disagree' ? 'flag' : ''}`}>
            Fitbit readiness {summary.readinessCrossCheck === 'agree' ? 'agrees' : 'disagrees'}
          </span>
        )}
      </div>

      {summary.systemicIllnessSignal && (
        <p className="recovery-illness">Possible illness pattern — skin-temp, respiration and autonomic markers up together.</p>
      )}

      <p className="recovery-interpretation">{summary.interpretation}</p>

      <ul className="recovery-metrics">
        {metrics.map((metric) => (
          <li key={metric.label} className={`recovery-metric tone-${metric.tone}`}>
            <span className="recovery-metric-label">{metric.label}</span>
            <strong className="recovery-metric-value">{metric.value}</strong>
            <em className="recovery-metric-delta">{metric.delta}</em>
          </li>
        ))}
      </ul>

      {recovery.recent.length > 1 && (
        <div className="recovery-trend" aria-label="Recent recovery trend">
          {recovery.recent.map((day) => (
            <span
              key={day.day}
              className={`recovery-dot recovery-dot-${stateTone(day.state)}`}
              title={`${formatDay(day.day)}: ${STATE_LABEL[day.state]}`}
            />
          ))}
        </div>
      )}

      {summary.reasons.length > 0 && (
        <ul className="recovery-reasons">
          {summary.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

interface MetricRow {
  label: string;
  value: string;
  delta: string;
  tone: Tone;
}

function buildMetrics(day: RecoveryDaily): MetricRow[] {
  const o = day.observation;
  const d = day.deviations;
  const s = day.signals;
  const rows: MetricRow[] = [];
  if (o.hrvRmssdMs !== undefined) {
    rows.push({ label: 'HRV', value: `${Math.round(o.hrvRmssdMs)} ms`, delta: pctDelta(d.hrvVsBaselinePct), tone: signalTone(s.hrv) });
  }
  if (o.restingHrBpm !== undefined) {
    rows.push({ label: 'Resting HR', value: `${Math.round(o.restingHrBpm)} bpm`, delta: bpmDelta(d.rhrVsBaselineBpm), tone: signalTone(s.restingHr) });
  }
  if (o.sleepDurationMin !== undefined) {
    rows.push({ label: 'Sleep', value: formatDuration(o.sleepDurationMin), delta: s.sleep === 'normal' || s.sleep === 'unknown' ? 'Normal' : 'Below usual', tone: signalTone(s.sleep) });
  }
  if (d.sleepDebt7dMin !== undefined && d.sleepDebt7dMin > 0) {
    rows.push({ label: 'Sleep debt', value: `${d.sleepDebt7dMin} min`, delta: '7-night', tone: d.sleepDebt7dMin >= 60 ? 'watch' : 'muted' });
  }
  if (o.skinTempDeltaC !== undefined) {
    rows.push({ label: 'Skin temp', value: `${signed(o.skinTempDeltaC)}°C`, delta: zDelta(d.skinTempZscore), tone: signalTone(s.skinTemp) });
  }
  if (o.respiratoryRate !== undefined) {
    rows.push({ label: 'Respiration', value: `${o.respiratoryRate.toFixed(1)} /min`, delta: zDelta(d.respRateZscore), tone: signalTone(s.respiration) });
  }
  if (o.spo2Avg !== undefined) {
    rows.push({ label: 'SpO₂', value: `${Math.round(o.spo2Avg)}%`, delta: s.spo2 === 'normal' || s.spo2 === 'unknown' ? 'Normal' : 'Low', tone: signalTone(s.spo2) });
  }
  return rows;
}

function stateTone(state: RecoveryState | null): 'good' | 'watch' | 'bad' {
  if (state === 'suppressed' || state === 'high_stress') return 'bad';
  if (state === 'slightly_suppressed') return 'watch';
  return 'good';
}

function signalTone(status: SignalStatus): Tone {
  if (status === 'strong') return 'bad';
  if (status === 'mild') return 'watch';
  if (status === 'normal') return 'good';
  return 'muted';
}

function pctDelta(pct: number | undefined): string {
  if (pct === undefined) return '—';
  if (Math.abs(pct) < 1) return 'at baseline';
  return `${pct < 0 ? '↓' : '↑'} ${Math.abs(pct).toFixed(0)}% vs baseline`;
}

function bpmDelta(bpm: number | undefined): string {
  if (bpm === undefined) return '—';
  if (Math.abs(bpm) < 1) return 'at baseline';
  return `${bpm > 0 ? '+' : ''}${bpm.toFixed(0)} bpm`;
}

function zDelta(z: number | undefined): string {
  if (z === undefined) return '—';
  if (Math.abs(z) < 1) return 'Normal';
  return `${z > 0 ? '+' : ''}${z.toFixed(1)}σ`;
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function formatDay(day: string | null): string {
  if (!day) return '—';
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    : day;
}
