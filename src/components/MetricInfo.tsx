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
    what: 'How much training stress a single run added, blending pace, heart rate and power into one score relative to your own thresholds.',
    how: 'Duration (hours) × intensity² × 100. Intensity is grade-adjusted speed ÷ your threshold pace. When a run has HR and/or power, an HR-based and power-based load are computed the same way and blended 50% pace / 30% HR / 20% power.',
    levels: [
      { tone: 'muted', label: '≈100', text: '= one hour at threshold effort.' },
      { tone: 'good', label: 'Easy runs', text: 'usually land ~20–50.' },
      { tone: 'watch', label: 'Long / hard', text: 'sessions reach ~70–150+.' },
    ],
  },
  ctl: {
    title: 'Fitness (CTL)',
    what: 'Your durable fitness base — the training load your body has absorbed over the last several weeks.',
    how: 'A 42-day exponentially-weighted average of daily load. Each day it moves 1/42 of the way toward that day’s load, so it climbs and fades slowly.',
    levels: [
      { tone: 'good', label: 'Rising steadily', text: 'fitness is building sustainably.' },
      { tone: 'watch', label: 'Rising fast', text: 'often shows up as high Fatigue and Ramp — watch recovery.' },
      { tone: 'bad', label: 'Long decline', text: 'detraining / extended time off.' },
    ],
  },
  atl: {
    title: 'Fatigue (ATL)',
    what: 'Your recent, short-term fatigue. It spikes after hard days and settles within about a week of easier training.',
    how: 'A 7-day exponentially-weighted average of daily load. Each day it moves 1/7 of the way toward that day’s load, so it reacts quickly.',
    levels: [
      { tone: 'muted', label: 'Read vs Fitness', text: 'fatigue alone is neither good nor bad.' },
      { tone: 'watch', label: 'Above Fitness', text: 'you are loading harder than your base — see Ramp.' },
      { tone: 'good', label: 'Falling', text: 'you are recovering / freshening up.' },
    ],
  },
  freshness: {
    title: 'Freshness',
    what: 'How rested you are right now — the balance between long-term fitness and short-term fatigue (like Strava’s Form).',
    how: 'Fitness (CTL) − Fatigue (ATL).',
    levels: [
      { tone: 'good', label: '> +8', text: 'fresh / tapered — good to race, or undertrained if it lasts.' },
      { tone: 'muted', label: '−10 to +8', text: 'normal training range.' },
      { tone: 'bad', label: '< −10', text: 'productive overload — fine briefly, risky if sustained.' },
    ],
  },
  acwr: {
    title: 'Ramp (ACWR)',
    what: 'Acute:chronic workload ratio — how fast you are loading compared with what you are used to. The clearest injury-risk gauge here.',
    how: 'Fatigue (7-day) ÷ Fitness (42-day).',
    levels: [
      { tone: 'good', label: '0.8 – 1.3', text: 'sweet spot — sustainable progression.' },
      { tone: 'watch', label: '1.3 – 1.5', text: 'high ramp — protect recovery.' },
      { tone: 'bad', label: '> 1.5', text: 'acute spike — elevated injury risk, back off.' },
    ],
  },
  chart: {
    title: 'Fitness, Fatigue & Freshness',
    what: 'The load model over time. Fitness (CTL) is your slow base, Fatigue (ATL) your fast recent load, and Freshness the gap between them.',
    how: 'Daily load is smoothed into a 42-day average (Fitness) and a 7-day average (Fatigue). Freshness = Fitness − Fatigue.',
    levels: [
      { tone: 'good', label: 'Fitness up, Freshness ~0', text: 'healthy build.' },
      { tone: 'watch', label: 'Fatigue above Fitness', text: 'hard block — recover soon.' },
      { tone: 'good', label: 'Freshness positive', text: 'resting / tapering.' },
    ],
  },
  intensityFactor: {
    title: 'Intensity factor (IF)',
    what: 'How hard a run was relative to your own threshold pace.',
    how: 'Grade-adjusted speed ÷ your threshold speed. Threshold is estimated from the fastest ~18% of your run paces (≈ tempo/threshold). Clamped to 0.35–1.35.',
    levels: [
      { tone: 'good', label: '< 0.8', text: 'easy aerobic running.' },
      { tone: 'watch', label: '0.8 – 0.9', text: 'steady / moderate.' },
      { tone: 'bad', label: '≥ 0.9', text: 'quality — threshold effort and above (≈1.0 = threshold).' },
    ],
  },
  hrCost: {
    title: 'HR cost',
    what: 'Whether your heart worked harder than the pace alone suggests — a fingerprint of heat, fatigue or dehydration.',
    how: '(HR-based load − pace-based load) ÷ pace-based load, for runs with heart rate.',
    levels: [
      { tone: 'good', label: '≤ +18%', text: 'HR in line with the pace.' },
      { tone: 'bad', label: '> +18%', text: 'high HR cost flagged — the run taxed you more than the pace implies.' },
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
    how: 'Hard-session load ÷ total weekly load. A run counts as hard at IF ≥ 0.85 (or the HR/power equivalent).',
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
    what: 'The week’s headline read on your training state.',
    how: 'Derived from Ramp, Freshness and the risk flags on the week.',
    levels: [
      { tone: 'bad', label: 'Back off', text: 'acute spike (Ramp > 1.5).' },
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
