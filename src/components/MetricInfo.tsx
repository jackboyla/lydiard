import { BookOpen, Info } from 'lucide-react';

export type MetricKey =
  | 'load'
  | 'ctl'
  | 'atl'
  | 'freshness'
  | 'acwr'
  | 'chart'
  | 'intensityFactor'
  | 'hrCost'
  | 'decoupling'
  | 'paceZones'
  | 'hrZones'
  | 'hardShare'
  | 'longRunShare'
  | 'monotony'
  | 'weekStatus';

type Tone = 'good' | 'watch' | 'bad' | 'muted';

interface Level {
  tone: Tone;
  label: string;
  text: string;
}

interface MetricDef {
  title: string;
  what: string;
  how: string;
  levels: Level[];
}

// Content is written to match the actual implementation in src/analysis/loadModel.ts,
// so the "how it's calculated" and thresholds are real, not generic textbook values.
export const METRIC_INFO: Record<MetricKey, MetricDef> = {
  load: {
    title: 'Session load',
    what: 'The external training stress assigned to one run. Its source is explicit; heart rate describes the response to that work and is never blended into this number.',
    how: 'A canonical stream-derived Lydiard Power Stress is used exactly when available. Otherwise, power is primary only when the Critical Power effective on that activity date was supplied. With neither, duration × pace/elevation intensity² × 100 is used as a labelled fallback.',
    levels: [
      { tone: 'muted', label: '≈100', text: '= one hour at threshold effort for formula-based sources.' },
      { tone: 'good', label: 'Canonical', text: 'stream stress passes through without pace/HR blending.' },
      { tone: 'watch', label: 'Fallback', text: 'trusted CP plus power, or labelled pace/elevation stress.' },
    ],
  },
  ctl: {
    title: 'Fitness (CTL)',
    what: 'Your long-term training-load background. It describes accumulated external work, not complete physiological or race fitness.',
    how: 'A 42-day exponentially-weighted average of daily load. Each day it moves 1/42 of the way toward that day’s load, so it climbs and fades slowly.',
    levels: [
      { tone: 'good', label: 'Rising steadily', text: 'long-term load background is building.' },
      { tone: 'watch', label: 'Rising fast', text: 'check the short-term load and observed run response.' },
      { tone: 'bad', label: 'Long decline', text: 'the long-term load background is falling.' },
    ],
  },
  atl: {
    title: 'Fatigue (ATL)',
    what: 'Your recent external-load background. It estimates modelled fatigue pressure, which must be checked against HR response, symptoms and feedback.',
    how: 'A 7-day exponentially-weighted average of daily load. Each day it moves 1/7 of the way toward that day’s load, so it reacts quickly.',
    levels: [
      { tone: 'muted', label: 'Read vs Fitness', text: 'fatigue alone is neither good nor bad.' },
      { tone: 'watch', label: 'Above Fitness', text: 'recent external load exceeds the long-term background.' },
      { tone: 'good', label: 'Falling', text: 'recent external load is reducing.' },
    ],
  },
  freshness: {
    title: 'Freshness',
    what: 'The modelled balance between long-term and recent external load. It is not, by itself, proof that you are recovered or ready.',
    how: 'Fitness (CTL) − Fatigue (ATL).',
    levels: [
      { tone: 'good', label: '> +8', text: 'recent load is below the long-term background; verify readiness separately.' },
      { tone: 'muted', label: '−10 to +8', text: 'normal training range.' },
      { tone: 'bad', label: '< −10', text: 'recent load is well above the long-term background; inspect response evidence.' },
    ],
  },
  acwr: {
    title: 'Ramp (ACWR)',
    what: 'Acute:chronic workload ratio — background context for how quickly external load is changing. It is not an injury prediction or a standalone coaching decision.',
    how: 'Fatigue (7-day) ÷ Fitness (42-day).',
    levels: [
      { tone: 'good', label: '0.8 – 1.3', text: 'load is broadly matched to the recent training background.' },
      { tone: 'watch', label: '1.3 – 1.5', text: 'load is rising; check run response and recovery evidence.' },
      { tone: 'bad', label: '> 1.5', text: 'large modelled spike; investigate rather than treating the ratio as a verdict.' },
    ],
  },
  chart: {
    title: 'Fitness, Fatigue & Freshness',
    what: 'The external-load model over time. Fitness (CTL) is the slow load background, Fatigue (ATL) the fast background, and Freshness their difference.',
    how: 'Daily load is smoothed into a 42-day average (Fitness) and a 7-day average (Fatigue). Freshness = Fitness − Fatigue.',
    levels: [
      { tone: 'good', label: 'Fitness up, Freshness ~0', text: 'healthy build.' },
      { tone: 'watch', label: 'Fatigue above Fitness', text: 'hard block — recover soon.' },
      { tone: 'good', label: 'Freshness positive', text: 'resting / tapering.' },
    ],
  },
  intensityFactor: {
    title: 'Pace/elevation intensity factor',
    what: 'How hard the summary pace/elevation fallback looks relative to the current pace threshold. It is supporting evidence when canonical power stress exists.',
    how: 'Elevation-adjusted summary speed ÷ threshold speed, clamped to 0.35–1.35. It controls load only when canonical stream stress and trusted date-effective CP are unavailable.',
    levels: [
      { tone: 'good', label: '< 0.8', text: 'easy aerobic running.' },
      { tone: 'watch', label: '0.8 – 0.9', text: 'steady / moderate.' },
      { tone: 'bad', label: '≥ 0.9', text: 'quality — threshold effort and above (≈1.0 = threshold).' },
    ],
  },
  hrCost: {
    title: 'HR cost',
    what: 'Whether your heart rate was higher or lower than expected for the external power output. It is response evidence, not extra training load.',
    how: 'Observed HR − expected HR in bpm, supplied by the personal HR–power response model. It is kept separate from Lydiard Power Stress, CTL and ATL.',
    levels: [
      { tone: 'good', label: '< +5 bpm', text: 'HR broadly in line with the expected power response.' },
      { tone: 'watch', label: '+5 to +8 bpm', text: 'elevated cardiovascular cost; check context and repeatability.' },
      { tone: 'bad', label: '≥ +8 bpm', text: 'high HR cost versus the personal power-response model.' },
    ],
  },
  decoupling: {
    title: 'Decoupling (HR drift)',
    what: 'Aerobic durability — whether your pace-per-heartbeat faded across the run.',
    how: 'Compares the heart-rate-to-pace ratio in the first half of the run with the second half.',
    levels: [
      { tone: 'good', label: '< 5%', text: 'strong aerobic control.' },
      { tone: 'watch', label: '5 – 8%', text: 'mild drift.' },
      { tone: 'bad', label: '> 8%', text: 'HR drift flagged — fatigue or under-fuelling on longer efforts.' },
    ],
  },
  paceZones: {
    title: 'Pace zones',
    what: 'Suggested current training paces for easy, steady, threshold and faster running, based on your own recent and historical run performances.',
    how: 'The app estimates your threshold pace from the fastest ~18% of eligible runs, then expresses zones as fractions of that threshold speed. Z1 is slower than 68% of threshold speed, Z4 is around threshold, and Z5 is faster than threshold.',
    levels: [
      { tone: 'good', label: 'Z1-Z2', text: 'recovery and easy aerobic volume.' },
      { tone: 'watch', label: 'Z3', text: 'steady work that can accumulate fatigue.' },
      { tone: 'bad', label: 'Z4-Z5', text: 'sessions: threshold, VO2 or faster running.' },
    ],
  },
  hrZones: {
    title: 'Heart-rate zones',
    what: 'Suggested current HR targets inferred from your recorded training heart rates, not a manually entered max-HR formula.',
    how: 'The app infers max HR from your recorded max/average HR distribution, estimates threshold HR as roughly 90% of that max, then builds five zones around threshold HR. Activity zone time uses the heart-rate stream sample-by-sample.',
    levels: [
      { tone: 'good', label: 'Z1-Z2', text: 'recovery and easy aerobic running.' },
      { tone: 'watch', label: 'Z3', text: 'moderate / steady aerobic stress.' },
      { tone: 'bad', label: 'Z4-Z5', text: 'threshold and above.' },
    ],
  },
  hardShare: {
    title: 'Intensity density',
    what: 'How much of a week’s load came from hard running rather than easy volume.',
    how: 'Canonical hard-running stress ÷ total weekly stress when supplied. Trusted-CP and pace/elevation fallbacks estimate hard stress from their primary intensity; HR never makes a run hard by adding load.',
    levels: [
      { tone: 'good', label: '≤ 25%', text: 'healthy easy/hard balance.' },
      { tone: 'bad', label: '> 25%', text: 'high intensity density flagged — a lot of the week was hard.' },
    ],
  },
  longRunShare: {
    title: 'Long-run share',
    what: 'How much of the week leaned on a single long run.',
    how: 'Load of the biggest run ÷ total weekly load.',
    levels: [
      { tone: 'good', label: '≤ 35%', text: 'volume is spread across the week.' },
      { tone: 'bad', label: '> 35%', text: 'long-run dominance flagged — one session carries the week.' },
    ],
  },
  monotony: {
    title: 'Monotony & strain',
    what: 'How similar every day’s load is. Grinding the same load daily with no easy/hard variation tracks with overtraining.',
    how: 'Mean daily load ÷ its standard deviation across the week. Strain = weekly load × monotony.',
    levels: [
      { tone: 'good', label: '< 2.0', text: 'good day-to-day variation.' },
      { tone: 'bad', label: '> 2.0', text: 'high monotony flagged — add rest days and easy/hard contrast.' },
    ],
  },
  weekStatus: {
    title: 'Week status',
    what: 'The week’s load-only headline. It is background context, not a complete readiness, injury-risk or coaching verdict.',
    how: 'Derived from Ramp, Freshness and weekly load-structure flags. HR-cost residuals, symptoms and athlete feedback must be assessed separately.',
    levels: [
      { tone: 'bad', label: 'Back off', text: 'load-spike flag (Ramp > 1.5); confirm against response evidence.' },
      { tone: 'watch', label: 'Caution', text: 'one or more risk flags raised.' },
      { tone: 'good', label: 'Fresh', text: 'well rested (Freshness > 8).' },
      { tone: 'muted', label: 'Productive overload', text: 'training hard (Freshness < −10).' },
    ],
  },
};

export function MetricInfo({ metric, align = 'left' }: { metric: MetricKey; align?: 'left' | 'right' }) {
  const def = METRIC_INFO[metric];
  if (!def) {
    return null;
  }
  return (
    <details className="metric-info" name="metric-info">
      <summary className="metric-info-toggle" aria-label={`About ${def.title}`} title={`About ${def.title}`}>
        <Info size={13} aria-hidden="true" />
      </summary>
      <div className={`metric-info-pop${align === 'right' ? ' align-right' : ''}`} role="note">
        <MetricInfoBody def={def} />
      </div>
    </details>
  );
}

export function MetricsGuide({ metrics }: { metrics: MetricKey[] }) {
  return (
    <section className="metrics-guide" aria-label="Metrics guide">
      <header className="metrics-guide-head">
        <BookOpen size={16} aria-hidden="true" />
        <div>
          <h3>Metrics guide</h3>
          <p>What each number means, how it’s calculated from your own history, and when to pay attention.</p>
        </div>
      </header>
      <div className="metrics-guide-grid">
        {metrics.map((metric) => (
          <article key={metric} className="metrics-guide-card">
            <MetricInfoBody def={METRIC_INFO[metric]} />
          </article>
        ))}
      </div>
    </section>
  );
}

function MetricInfoBody({ def }: { def: MetricDef }) {
  return (
    <>
      <p className="metric-info-title">{def.title}</p>
      <p className="metric-info-what">{def.what}</p>
      <div className="metric-info-section">
        <span className="metric-info-h">How it’s calculated</span>
        <p>{def.how}</p>
      </div>
      <div className="metric-info-section">
        <span className="metric-info-h">Warning levels</span>
        <ul className="metric-info-levels">
          {def.levels.map((level) => (
            <li key={level.label} className={`lvl lvl-${level.tone}`}>
              <span className="lvl-dot" aria-hidden="true" />
              <span>
                <strong>{level.label}</strong> {level.text}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
