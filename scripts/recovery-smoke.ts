// Smoke test for the overnight-recovery analysis (src/analysis/recovery.ts).
// Focus: the multi-day guard (a single off-baseline night must not escalate,
// but persistence must), the systemic illness override, and the readiness
// cross-check. Run: npm run recovery:smoke
import { analyzeRecovery, summarizeRecovery } from '../src/analysis/recovery';
import { averageBefore, formatVersusAverage } from '../src/analysis/recoveryTrend';
import type { RecoveryObservation } from '../src/types';

const START = '2026-06-01';

function addDaysStr(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

// A steady, healthy night. Baselines are deliberately flat so spreads sit on the
// MAD floor: a night exactly at baseline reads as 0σ (normal), and the injected
// deviations below are unambiguously beyond it.
function normalNight(day: string, overrides: Partial<RecoveryObservation> = {}): RecoveryObservation {
  return {
    day,
    source: 'garmin',
    hrvRmssdMs: 60,
    restingHrBpm: 48,
    skinTempDeltaC: 0,
    respiratoryRate: 14,
    sleepDurationMin: 450,
    spo2Avg: 97,
    spo2Low: 94,
    sleepScore: 85,
    readinessScore: 72,
    ...overrides,
  };
}

function buildBaseline(count: number): RecoveryObservation[] {
  return Array.from({ length: count }, (_, i) => normalNight(addDaysStr(START, i)));
}

// Steady baseline reads as normal/recovered.
const steady = analyzeRecovery(buildBaseline(30));
const steadyState = steady[steady.length - 1].state;
assert(steadyState === 'normal' || steadyState === 'recovered', `steady baseline should be normal/recovered, got ${steadyState}`);

// Scenario A — ONE off-baseline night (HRV crash). The single-night guard must
// hold this at slightly_suppressed, never suppressed/high_stress.
const singleDip = analyzeRecovery([
  ...buildBaseline(28),
  normalNight(addDaysStr(START, 28), { hrvRmssdMs: 45, readinessScore: 35 }),
]);
const singleDipState = singleDip[singleDip.length - 1].state;
assert(singleDipState === 'slightly_suppressed', `single bad night should stay slightly_suppressed, got ${singleDipState}`);

// Scenario B — the SAME HRV signal for three consecutive nights. Only the
// persistence differs from Scenario A, and it must escalate.
const persistent = analyzeRecovery([
  ...buildBaseline(28),
  ...[0, 1, 2].map((k) => normalNight(addDaysStr(START, 28 + k), { hrvRmssdMs: 45, readinessScore: 35 })),
]);
const persistentSummary = summarizeRecovery(persistent);
assert(persistent[28].state === 'slightly_suppressed', `first night of the run should be slightly_suppressed, got ${persistent[28].state}`);
assert(
  persistentSummary.state === 'suppressed' || persistentSummary.state === 'high_stress',
  `three consecutive off-baseline nights should escalate, got ${persistentSummary.state}`,
);
assert(persistentSummary.suppressedStreak >= 2, `expected suppressedStreak >= 2, got ${persistentSummary.suppressedStreak}`);
// Low readiness agrees with a suppressed state.
assert(persistentSummary.readinessCrossCheck === 'agree', `low readiness should agree, got ${persistentSummary.readinessCrossCheck}`);

// Scenario C — a systemic illness pattern (skin-temp + respiration + RHR) is the
// one thing acted on immediately, even on the first night.
const illness = analyzeRecovery([
  ...buildBaseline(28),
  normalNight(addDaysStr(START, 28), { restingHrBpm: 54, skinTempDeltaC: 0.6, respiratoryRate: 16 }),
]);
const illnessSummary = summarizeRecovery(illness);
assert(illness[illness.length - 1].illnessPattern, 'illness pattern should be detected');
assert(illnessSummary.state === 'high_stress', `illness pattern should be high_stress on day 1, got ${illnessSummary.state}`);
assert(illnessSummary.systemicIllnessSignal, 'summary should flag systemicIllnessSignal');

// Scenario D — derived suppressed but the device readiness stays high: an
// interesting DISAGREEMENT the coach should notice.
const disagree = summarizeRecovery(
  analyzeRecovery([
    ...buildBaseline(28),
    ...[0, 1, 2].map((k) => normalNight(addDaysStr(START, 28 + k), { hrvRmssdMs: 45, readinessScore: 82 })),
  ]),
);
assert(disagree.readinessCrossCheck === 'disagree', `suppressed vs high readiness should disagree, got ${disagree.readinessCrossCheck}`);

// Empty input degrades gracefully.
const empty = summarizeRecovery(analyzeRecovery([]));
assert(empty.state === null && empty.asOf === null, 'empty series should summarize to a null state');

// The Log charts and run page compare a night with the seven before it, never itself.
const trendNights = new Map([
  ['2026-06-01', { day: '2026-06-01', sleepMin: 400, hrvMs: 50 }],
  ['2026-06-02', { day: '2026-06-02', sleepMin: 420 }],
  ['2026-06-03', { day: '2026-06-03', sleepMin: 440, hrvMs: 60 }],
  ['2026-06-08', { day: '2026-06-08', sleepMin: 300, hrvMs: 99 }],
]);
assert(averageBefore(trendNights, '2026-06-08', 'sleep') === 420, 'sleep average should cover the 7 nights before, excluding the night itself');
assert(averageBefore(trendNights, '2026-06-08', 'hrv') === undefined, 'two HRV nights are too few for an average');
assert(averageBefore(trendNights, '2026-06-10', 'sleep') === undefined, 'nights older than 7 days fall out of the average');
assert(formatVersusAverage(390, 420, 'sleep') === '−30 min vs 7-night avg', 'sleep difference reads in minutes');
assert(formatVersusAverage(55, 50, 'hrv') === '+10% vs 7-night avg', 'HRV difference reads in percent');

console.log(
  JSON.stringify(
    {
      ok: true,
      steadyState,
      singleDipState,
      persistent: { state: persistentSummary.state, suppressedStreak: persistentSummary.suppressedStreak, crossCheck: persistentSummary.readinessCrossCheck },
      illness: { state: illnessSummary.state, systemicIllnessSignal: illnessSummary.systemicIllnessSignal, interpretation: illnessSummary.interpretation },
      disagree: disagree.readinessCrossCheck,
    },
    null,
    2,
  ),
);

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Recovery smoke failed: ${message}`);
}
