import type {
  HrCostBaseline,
  LydiardBlockPlan,
  PhysiologyEstimate,
  PostRunEvaluation,
  PowerDurationPoint,
  RecentTrainingWeek,
  SessionStressAssessment,
} from '../analysis/coachEngine';
import type { RecoveryDaily, RecoverySummary } from '../analysis/recovery';

export type CoachPhase =
  | 'aerobic_conditioning'
  | 'hill_resistance'
  | 'anaerobic_development'
  | 'coordination'
  | 'recovery_regeneration';

export interface CoachProfileRecord {
  primaryGoal: string;
  secondaryGoal: string;
  goal5kSeconds: number;
  goal10kSeconds: number;
  currentPhase: CoachPhase;
  phaseStartedOn?: string;
  targetRaceDate?: string;
  sustainableWeeklyDurationMin?: number;
  targetWeeklyDurationMin?: number;
  longRunToleranceMin?: number;
  maxQualitySessions: number;
  strengthSessionsTarget: number;
  constraints: Record<string, unknown>;
  learnedResponse: Record<string, unknown>;
  policyVersion: string;
  nextDecisionAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredPlannedSession {
  id: string;
  plannedDate: string;
  sequence: number;
  title: string;
  sessionType: string;
  trainingPhase: string;
  priority: string;
  plannedDurationSec?: number;
  plannedDistanceKm?: number;
  plannedPowerStress?: number;
  targetCriticalPowerId?: string;
  targetPowerLowW?: number;
  targetPowerHighW?: number;
  targetPowerLowPctCp?: number;
  targetPowerHighPctCp?: number;
  targetHrLow?: number;
  targetHrHigh?: number;
  targetHrCeiling?: number;
  targetGapLowSecPerKm?: number;
  targetGapHighSecPerKm?: number;
  workoutStructure: Record<string, unknown>;
  purpose: string;
  fallbackPlan: string;
  coachReasoning: string;
  status: 'proposed' | 'accepted' | 'planned' | 'completed' | 'partial' | 'skipped' | 'cancelled' | 'superseded';
  source: string;
  sourcePlanDate?: string;
  coachDecisionId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CoachFeedbackRecord {
  activityId: string;
  plannedSessionId?: string;
  perceivedEffort?: number;
  perceivedCost?: string;
  sessionFeel?: 'easier' | 'as_expected' | 'harder';
  energy?: number;
  legCondition?: string;
  breathingCondition?: string;
  painDuring?: number;
  painAfter?: number;
  painLocation?: string;
  alteredGait: boolean;
  note: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CoachDecisionRecord {
  id: string;
  decisionType: string;
  asOf: string;
  triggerActivityId?: string;
  weekStart?: string;
  status: 'proposed' | 'applied' | 'rejected' | 'superseded';
  requestId?: string;
  stateVersionBefore?: number;
  stateVersionAfter?: number;
  policyVersion: string;
  modelVersion: string;
  summary: string;
  reasoning: string;
  evidence: Record<string, unknown>;
  planPatch: Record<string, unknown>;
  stateBefore: Record<string, unknown>;
  stateAfter: Record<string, unknown>;
  createdAt: string;
  appliedAt?: string;
  updatedAt: string;
}

export interface CoachRecentRun {
  id: string;
  name: string;
  startDate: string;
  startDateLocal?: string;
  distanceKm: number;
  movingTimeSec: number;
  averageHeartRate?: number;
  averageWatts?: number;
  assessment: SessionStressAssessment;
  feedback?: CoachFeedbackRecord;
  plannedSessionIds: string[];
  verdict?: string;
}

export interface CoachContextData {
  generatedAt: string;
  asOf: string;
  lookbackDays: number;
  policyVersion: string;
  goals: {
    firstMilestone: { distance: '5k'; targetSeconds: number; target: string };
    laterMilestone: { distance: '10k'; targetSeconds: number; target: string };
  };
  profile: CoachProfileRecord;
  physiology: PhysiologyEstimate;
  heartRateCostBaseline: HrCostBaseline;
  backgroundLoad: {
    sevenDayStress: number;
    fortyTwoDayStress: number;
    stressBalance: number;
    sevenToFortyTwoRatio: number | null;
    sevenDayHardStress: number;
    explanation: string;
  };
  observedState: {
    state: 'green' | 'amber' | 'red';
    reasons: string[];
    elevatedHeartRateCostRuns: number;
    deterioratingRuns: number;
    maxRecentPain: number;
    alteredGait: boolean;
    illnessSuspected: boolean;
    recoveryState: RecoverySummary['state'];
    recoverySuppressedDays: number;
    systemicIllnessSignal: boolean;
  };
  // Objective overnight recovery (Fitbit via Google Health). Optional so the UI
  // tolerates a coach payload from a Worker deployed before this shipped.
  recovery?: { summary: RecoverySummary; recent: RecoveryDaily[] };
  currentWeek: {
    weekStart: string;
    weekEnd: string;
    sessions: StoredPlannedSession[];
    activityLinks: Array<{ plannedSessionId: string; activityId: string }>;
    accepted: boolean;
    pendingProposal: boolean;
  };
  upcomingPlan: {
    from: string;
    to: string;
    sessions: StoredPlannedSession[];
    activityLinks: Array<{ plannedSessionId: string; activityId: string }>;
    proposedDecisionIds: string[];
    acceptedDecisionIds: string[];
  };
  recentWeeks: RecentTrainingWeek[];
  recentRuns: CoachRecentRun[];
  recentSessions: SessionStressAssessment[];
  powerDuration: PowerDurationPoint[];
  recentFeedback: CoachFeedbackRecord[];
  recentCheckins: Array<Record<string, unknown>>;
  recentDecisions: CoachDecisionRecord[];
  limitations: string[];
}

export interface CriticalPowerDraft {
  criticalPowerWatts: number;
  effectiveFrom: string;
  source?: 'stryd_auto' | 'stryd_test' | 'stryd_manual';
  device?: string;
  confidence?: number;
  notes?: string;
}

export interface CoachGoalDraft {
  distanceKm: number;
  timeSeconds: number;
  targetDate?: string;
}

export interface CoachFeedbackDraft {
  plannedSessionId?: string;
  energy: 'good' | 'okay' | 'poor';
  legCondition: 'fresh' | 'normal' | 'heavy' | 'dead';
  pain: 'none' | 'mild' | 'concerning';
  painLocation?: string;
  alteredGait?: boolean;
  sessionFeel: 'easier' | 'as_expected' | 'harder';
  note?: string;
}

export interface CoachBlockMutation {
  decision: CoachDecisionRecord;
  block?: LydiardBlockPlan;
  sessions: StoredPlannedSession[];
  idempotent?: boolean;
}

export interface CoachEvaluationMutation {
  decision: CoachDecisionRecord;
  evaluation: PostRunEvaluation;
  idempotent?: boolean;
}
