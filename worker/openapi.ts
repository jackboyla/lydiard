// OpenAPI 3.1 document describing the agent endpoints, so ChatGPT can import it
// as a Custom GPT Action (or a Scheduled Task can be pointed at it). Bearer-key
// secured. The server URL is derived from the incoming request origin.
//
// Response schemas are fully specified (every object has `properties`) because
// the ChatGPT Action importer rejects bare `type: object` schemas.

export function buildOpenApiDocument(origin: string): unknown {
  const str = { type: 'string' };
  const num = { type: 'number' };
  const int = { type: 'integer' };
  const bool = { type: 'boolean' };

  const dateParam = (name: string, description: string) => ({
    name,
    in: 'query',
    required: false,
    schema: { type: 'string', format: 'date', example: '2026-05-01' },
    description,
  });

  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

  const activityProperties = {
    id: str,
    name: str,
    sportType: str,
    startDate: str,
    startDateLocal: str,
    distanceKm: num,
    movingTimeSec: num,
    elapsedTimeSec: num,
    averageHeartRate: num,
    maxHeartRate: num,
    averageCadenceSpm: num,
    elevationGainM: num,
    relativeEffort: num,
    averageWatts: num,
    averageSpeed: num,
    hasStreams: bool,
    decouplingPct: num,
    activityNote: str,
  };

  const schemas = {
    PlanContext: {
      type: 'object',
      description: 'One-call bundle for injury-risk assessment and 1–3 week planning.',
      properties: {
        generatedAt: str,
        athlete: { type: 'object', properties: { name: str } },
        range: { type: 'object', properties: { from: str, to: str, weeks: int } },
        current: {
          type: 'object',
          description: 'Latest analyzed week (null if no data yet).',
          properties: {
            weekStart: str,
            label: str,
            riskScore: num,
            severity: str,
            stateLabel: str,
            summary: str,
            recommendation: str,
            topIndicators: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: str,
                  label: str,
                  valueLabel: str,
                  baselineLabel: str,
                  deltaLabel: str,
                  score: num,
                  severity: str,
                  detail: str,
                },
              },
            },
          },
        },
        loadStatus: {
          type: 'object',
          properties: { acuteLoad: num, chronicLoad: num, acRatio: num, interpretation: str },
        },
        summary: {
          type: 'object',
          properties: {
            totalDistanceKm: num,
            totalDurationHours: num,
            weeks: int,
            avgWeeklyKm: num,
            longestRunKm: num,
            avgTrainingLoad: num,
          },
        },
        weeklyTrend: { type: 'array', items: ref('WeekTrend') },
        indicatorGuide: {
          type: 'object',
          properties: { stride: str, decoupling: str, easyPace: str, threshold: str, load: str, recovery: str },
        },
        instructions: str,
      },
    },
    WeekTrend: {
      type: 'object',
      properties: {
        weekStart: str,
        label: str,
        distanceKm: num,
        durationHours: num,
        trainingLoad: num,
        acRatio: num,
        easyPaceSecPerKm: num,
        thresholdPaceSecPerKm: num,
        hrPaceDecouplingPct: num,
        strideLengthCm: num,
        cadenceSpm: num,
        hrvMs: num,
        sleepHours: num,
        qualitySessions: num,
        longRunKm: num,
        riskScore: num,
        severity: str,
        streamsBacked: bool,
      },
    },
    WeeklyRunBlock: {
      type: 'object',
      properties: {
        weekStart: str,
        label: str,
        year: int,
        distanceKm: num,
        durationHours: num,
        trainingLoad: num,
        chronicLoad: num,
        acuteLoad: num,
        acRatio: num,
        easyPaceSecPerKm: num,
        easyHeartRate: num,
        thresholdPaceSecPerKm: num,
        strideLengthCm: num,
        cadenceSpm: num,
        hrPaceDecouplingPct: num,
        hrvMs: num,
        sleepHours: num,
        elevationGainM: num,
        qualitySessions: num,
        longRunKm: num,
      },
    },
    Indicator: {
      type: 'object',
      properties: {
        id: str,
        label: str,
        unit: str,
        current: num,
        baseline: num,
        deltaPct: num,
        score: num,
        severity: str,
        valueLabel: str,
        baselineLabel: str,
        deltaLabel: str,
        detail: str,
      },
    },
    WeeklyAnalysis: {
      type: 'object',
      properties: {
        week: ref('WeeklyRunBlock'),
        riskScore: num,
        severity: str,
        stateLabel: str,
        summary: str,
        recommendation: str,
        indicators: { type: 'array', items: ref('Indicator') },
      },
    },
    Activity: {
      type: 'object',
      properties: activityProperties,
    },
    ActivityLap: {
      type: 'object',
      description: 'One device-recorded lap. Distance and duration preserve the original lap boundary; optional metrics are omitted when the device did not provide them.',
      properties: {
        index: int,
        distanceM: num,
        durationSec: num,
        elapsedSec: num,
        averageHeartRate: num,
        maxHeartRate: num,
        averagePower: num,
        maxPower: num,
        averageSpeedMps: num,
      },
    },
    ActivityDetail: {
      type: 'object',
      description: 'One activity plus compact device-recorded lap summaries. This response never invents or derives interval boundaries.',
      properties: {
        ...activityProperties,
        lapDataStatus: {
          type: 'string',
          enum: ['recorded', 'unavailable'],
          description: '`recorded` means laps came from the source device; `unavailable` means no recorded lap data is stored.',
        },
        laps: {
          type: 'array',
          description: 'Device-recorded laps in source order. Empty when lapDataStatus is unavailable.',
          items: ref('ActivityLap'),
        },
      },
    },
    ErrorResponse: {
      type: 'object',
      properties: { error: str },
    },
    WeeksResponse: {
      type: 'object',
      properties: { weeks: { type: 'array', items: ref('WeeklyRunBlock') } },
    },
    ActivitiesResponse: {
      type: 'object',
      properties: { activities: { type: 'array', items: ref('Activity') } },
    },
    ExpertWisdomSource: {
      type: 'object',
      properties: {
        id: { type: 'string', enum: ['scullion', 'magness'] },
        title: str,
        filename: str,
        content: str,
        characters: int,
      },
      required: ['id', 'title', 'filename', 'content', 'characters'],
    },
    ExpertWisdomResponse: {
      type: 'object',
      description: 'The version-controlled coaching-wisdom files available to the planning GPT.',
      properties: {
        generatedAt: str,
        sources: { type: 'array', items: ref('ExpertWisdomSource') },
        instructions: str,
      },
      required: ['generatedAt', 'sources', 'instructions'],
    },
    NumericRange: {
      type: 'object',
      properties: { low: num, high: num },
      required: ['low', 'high'],
    },
    PaceRange: {
      type: 'object',
      description: 'Fast and slow pace boundaries in seconds per kilometre; fast must be no greater than slow.',
      properties: { fastSecPerKm: num, slowSecPerKm: num },
      required: ['fastSecPerKm', 'slowSecPerKm'],
    },
    AgentPlanTargets: {
      type: 'object',
      description: 'Use only evidence-supported controls. Leave unsupported ranges absent rather than inventing precision.',
      properties: {
        powerWatts: ref('NumericRange'),
        powerPctCriticalPower: ref('NumericRange'),
        heartRateBpm: ref('NumericRange'),
        heartRateCeiling: num,
        paceSecPerKm: ref('PaceRange'),
      },
    },
    AgentWorkoutStep: {
      type: 'object',
      description: 'One ordered execution step. The note should include effort cues, recoveries, terrain, and stop rules relevant to the step.',
      properties: {
        kind: { type: 'string', enum: ['warmup', 'continuous', 'repetitions', 'recovery', 'strides', 'cooldown'] },
        durationMin: { type: 'number', minimum: 0, maximum: 600 },
        count: { type: 'integer', minimum: 1, maximum: 100 },
        repetitionDurationSec: { type: 'number', minimum: 1, maximum: 21600 },
        recoveryDurationSec: { type: 'number', minimum: 0, maximum: 3600 },
        distanceM: { type: 'number', minimum: 1, maximum: 100000 },
        note: { type: 'string', maxLength: 1200 },
      },
      required: ['kind', 'note'],
    },
    AgentPlanSessionInput: {
      type: 'object',
      description: 'A detailed dated session to render in Plan, including execution, intent, fallback, evidence, and adaptation rules.',
      properties: {
        plannedDate: { type: 'string', format: 'date' },
        title: { type: 'string', maxLength: 160 },
        sessionType: {
          type: 'string',
          enum: ['rest', 'strength', 'recovery', 'aerobic', 'medium_long', 'long_aerobic', 'steady', 'strides', 'hill_sprints', 'hill_circuit', 'threshold', 'vo2', 'race_specific', 'coordination'],
        },
        trainingPhase: {
          type: 'string',
          enum: ['aerobic_conditioning', 'hill_resistance', 'anaerobic_development', 'coordination', 'recovery_regeneration'],
        },
        priority: { type: 'string', enum: ['key', 'supporting', 'optional'] },
        plannedDurationMin: { type: 'number', minimum: 0, maximum: 600 },
        plannedDistanceKm: { type: 'number', minimum: 0, maximum: 200 },
        targets: ref('AgentPlanTargets'),
        workoutSteps: { type: 'array', maxItems: 20, items: ref('AgentWorkoutStep') },
        purpose: { type: 'string', maxLength: 2000 },
        fallbackPlan: { type: 'string', maxLength: 2000 },
        coachReasoning: { type: 'string', maxLength: 3000 },
        adaptationGuidance: { type: 'string', maxLength: 2000 },
      },
      required: [
        'plannedDate', 'title', 'sessionType', 'trainingPhase', 'priority', 'plannedDurationMin', 'targets',
        'workoutSteps', 'purpose', 'fallbackPlan', 'coachReasoning', 'adaptationGuidance',
      ],
    },
    AgentPlanPublishRequest: {
      type: 'object',
      description: 'The complete plan agreed in conversation. Publishing replaces only overlapping active future sessions.',
      properties: {
        requestId: { type: 'string', maxLength: 200 },
        expectedProfileVersion: { type: 'integer', minimum: 1 },
        contextGeneratedAt: { type: 'string', format: 'date-time' },
        title: { type: 'string', maxLength: 160 },
        goal: { type: 'string', maxLength: 1000 },
        summary: { type: 'string', maxLength: 3000 },
        startDate: { type: 'string', format: 'date' },
        numberOfWeeks: { type: 'integer', minimum: 1, maximum: 12 },
        expertSources: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', enum: ['scullion', 'magness'] },
        },
        sessions: { type: 'array', minItems: 1, maxItems: 168, items: ref('AgentPlanSessionInput') },
      },
      required: [
        'requestId', 'expectedProfileVersion', 'title', 'goal', 'summary', 'startDate', 'numberOfWeeks',
        'expertSources', 'sessions',
      ],
    },
    PlannedSession: {
      type: 'object',
      properties: {
        id: str,
        plannedDate: str,
        sequence: int,
        title: str,
        sessionType: str,
        trainingPhase: str,
        priority: str,
        plannedDurationSec: num,
        plannedDistanceKm: num,
        targetPowerLowW: num,
        targetPowerHighW: num,
        targetPowerLowPctCp: num,
        targetPowerHighPctCp: num,
        targetHrLow: num,
        targetHrHigh: num,
        targetHrCeiling: num,
        targetGapLowSecPerKm: num,
        targetGapHighSecPerKm: num,
        workoutStructure: {
          type: 'object',
          properties: {
            components: { type: 'array', items: ref('AgentWorkoutStep') },
            adaptationGuidance: str,
          },
        },
        purpose: str,
        fallbackPlan: str,
        coachReasoning: str,
        status: str,
        source: str,
        coachDecisionId: str,
        revision: int,
      },
    },
    CompactPlannedSession: {
      type: 'object',
      description: 'A compact future-session summary. Use getPlannedSessions for exact workout steps in a specific week.',
      properties: {
        id: str,
        plannedDate: str,
        sequence: int,
        title: str,
        sessionType: str,
        trainingPhase: str,
        priority: str,
        plannedDurationSec: num,
        plannedDistanceKm: num,
        targetPowerLowW: num,
        targetPowerHighW: num,
        targetPowerLowPctCp: num,
        targetPowerHighPctCp: num,
        targetHrLow: num,
        targetHrHigh: num,
        targetHrCeiling: num,
        targetGapLowSecPerKm: num,
        targetGapHighSecPerKm: num,
        purpose: str,
        fallbackPlan: str,
        coachReasoning: str,
        status: str,
        source: str,
        revision: int,
      },
    },
    PlannedSessionsResponse: {
      type: 'object',
      properties: {
        from: str,
        to: str,
        sessions: { type: 'array', items: ref('PlannedSession') },
      },
      required: ['from', 'to', 'sessions'],
    },
    PublishedPlanSession: {
      type: 'object',
      properties: { id: str, plannedDate: str, title: str, status: str, revision: int },
      required: ['id', 'plannedDate', 'title', 'status', 'revision'],
    },
    AgentPlanPublishResponse: {
      type: 'object',
      properties: {
        planId: str,
        status: str,
        startDate: str,
        endDate: str,
        numberOfWeeks: int,
        sessions: { type: 'array', items: ref('PublishedPlanSession') },
        supersededSessionIds: { type: 'array', items: str },
        idempotent: bool,
      },
      required: ['planId', 'status', 'startDate', 'endDate', 'numberOfWeeks', 'sessions', 'supersededSessionIds', 'idempotent'],
    },
    CoachContext: {
      type: 'object',
      description: 'Deterministic stateful-coach context, including physiology, future sessions, recent responses, and pending decisions.',
      properties: {
        generatedAt: str,
        asOf: str,
        policyVersion: str,
        goals: {
          type: 'object',
          properties: {
            firstMilestone: { type: 'object', properties: { distance: str, targetSeconds: int, target: str } },
            laterMilestone: { type: 'object', properties: { distance: str, targetSeconds: int, target: str } },
          },
        },
        profile: {
          type: 'object',
          properties: {
            primaryGoal: str,
            secondaryGoal: str,
            currentPhase: str,
            goal5kSeconds: int,
            goal10kSeconds: int,
            targetRaceDate: str,
            sustainableWeeklyDurationMin: int,
            targetWeeklyDurationMin: int,
            longRunToleranceMin: int,
            maxQualitySessions: int,
            strengthSessionsTarget: int,
            constraints: {
              type: 'object',
              properties: {
                runningDaysPerWeek: int,
                kneeHistory: bool,
                achillesHistory: bool,
                allowControlledSteadyInBase: bool,
                scullionGoal: {
                  type: 'object',
                  properties: { distanceKm: num, timeSeconds: int, targetDate: str },
                },
              },
            },
            version: int,
            policyVersion: str,
          },
        },
        physiology: {
          type: 'object',
          properties: {
            asOf: str,
            criticalSpeed: { type: 'object', properties: { estimate: num, low: num, high: num, confidence: str } },
            platformCriticalPower: { type: 'object', properties: { estimate: num, low: num, high: num, confidence: str } },
            canonicalCriticalPower: { type: 'object', properties: { watts: num, effectiveFrom: str, source: str, confidence: str } },
            lt1HeartRate: { type: 'object', properties: { low: num, high: num, confidence: str } },
            lt2HeartRate: { type: 'object', properties: { low: num, high: num, confidence: str } },
            zones: { type: 'array', items: { type: 'object', properties: { name: str, label: str, domain: str, control: str } } },
            calibration: {
              type: 'object',
              properties: {
                policyVersion: str,
                status: str,
                reviewedAt: str,
                nextReviewAt: str,
                trigger: str,
                newActivityCount: int,
                minimumActivitiesForScheduledReview: int,
                changes: { type: 'array', items: str },
                explanation: str,
              },
            },
            raceEquivalents: {
              type: 'array',
              items: { type: 'object', properties: { label: str, distanceM: num, predictedSec: num, paceSecPerKm: num, confidence: str, caveat: str } },
            },
            limitations: { type: 'array', items: str },
          },
        },
        backgroundLoad: {
          type: 'object',
          properties: { sevenDayStress: num, fortyTwoDayStress: num, stressBalance: num, sevenDayHardStress: num, explanation: str },
        },
        observedState: {
          type: 'object',
          properties: { state: str, reasons: { type: 'array', items: str }, maxRecentPain: num, alteredGait: bool },
        },
        currentWeek: {
          type: 'object',
          properties: { weekStart: str, weekEnd: str, accepted: bool, pendingProposal: bool },
        },
        upcomingPlan: {
          type: 'object',
          properties: {
            from: str,
            to: str,
            sessions: { type: 'array', items: ref('CompactPlannedSession') },
            proposedDecisionIds: { type: 'array', items: str },
            acceptedDecisionIds: { type: 'array', items: str },
          },
        },
        recentWeeks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              weekStart: str,
              runningMinutes: num,
              distanceKm: num,
              stress: num,
              hardStress: num,
              longRunMinutes: num,
              absorbed: bool,
              emergencyReduction: bool,
            },
          },
        },
        recentRuns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: str,
              name: str,
              startDate: str,
              startDateLocal: str,
              distanceKm: num,
              movingTimeSec: num,
              averageHeartRate: num,
              averageWatts: num,
              verdict: str,
              response: {
                type: 'object',
                properties: {
                  externalStress: {
                    type: 'object',
                    properties: { source: str, totalStress: num, hardStress: num, intensityFactor: num, reliability: str, explanation: str },
                  },
                  heartRateCost: {
                    type: 'object',
                    properties: { observedHeartRate: num, expectedHeartRate: num, residualBpm: num, status: str, confidence: str, explanation: str },
                  },
                  warnings: { type: 'array', items: str },
                },
              },
            },
          },
        },
        powerDuration: {
          type: 'array',
          items: {
            type: 'object',
            properties: { durationSec: int, watts: num, activityId: str, activityDate: str, ageDays: num, freshness: str },
          },
        },
        recentDecisions: { type: 'array', items: { type: 'object', properties: { id: str, decisionType: str, status: str, summary: str, reasoning: str } } },
        limitations: { type: 'array', items: str },
        instructions: str,
      },
    },
    SyncAccepted: {
      type: 'object',
      properties: { ok: bool, message: str },
    },
  };

  const jsonResponse = (description: string, schemaName: string) => ({
    description,
    content: { 'application/json': { schema: ref(schemaName) } },
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'Lydiard Training API',
      version: '3.0.0',
      description:
        'Query a single runner\'s training history, coaching context, and expert-wisdom corpus; publish a detailed ' +
        'conversationally agreed plan into the runner\'s canonical Plan section.',
    },
    servers: [{ url: origin }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/agent/plan-context': {
        get: {
          operationId: 'getPlanContext',
          summary: 'One-call bundle for injury-risk assessment and 1–3 week planning',
          description:
            'Returns the latest-week risk snapshot, acute/chronic load status, a weekly trend, and ' +
            'instructions. Best starting point for planning the next 1–3 weeks.',
          parameters: [
            dateParam('from', 'Start of the trend window (inclusive). Defaults to the last 12 weeks.'),
            dateParam('to', 'End of the trend window (inclusive).'),
          ],
          responses: { '200': jsonResponse('Plan context bundle', 'PlanContext') },
        },
      },
      '/api/agent/coach-context': {
        get: {
          operationId: 'getCoachContext',
          summary: 'Get the authoritative stateful-coach context',
          description:
            'Start here for zones, current Lydiard phase, the accepted/proposed future block, recent run responses, ' +
            'and pending adaptation decisions. Later planned weeks are contingent on earlier-week absorption.',
          parameters: [
            dateParam('asOf', 'Evaluate evidence available on or before this date.'),
            dateParam('weekStart', 'Monday that starts the requested planning horizon.'),
            { name: 'lookbackDays', in: 'query', required: false, schema: { type: 'integer', minimum: 30, maximum: 365 } },
            { name: 'horizonWeeks', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 12 }, description: 'Number of future plan weeks to return. Match the requested planning horizon.' },
          ],
          responses: { '200': jsonResponse('Stateful coach context', 'CoachContext') },
        },
      },
      '/api/agent/expert-wisdom': {
        get: {
          operationId: 'getExpertWisdom',
          summary: 'Read the Scullion and Magness coaching-wisdom files',
          description:
            'Read before designing a plan. Apply principles to current athlete evidence; do not copy context-specific or elite example volumes literally.',
          parameters: [{
            name: 'source',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['all', 'scullion', 'magness'], default: 'all' },
            description: 'Return both files by default or one named source.',
          }],
          responses: {
            '200': jsonResponse('Expert-wisdom sources', 'ExpertWisdomResponse'),
            '400': jsonResponse('Invalid source', 'ErrorResponse'),
          },
        },
      },
      '/api/agent/planned-sessions': {
        get: {
          operationId: 'getPlannedSessions',
          summary: 'Read exact stored workout steps for one plan week',
          description:
            'Use when discussing or revising an existing plan. Returns full execution steps, intent, fallback, reasoning, and adaptation guidance for at most seven inclusive dates.',
          parameters: [
            { ...dateParam('from', 'First date of the plan week.'), required: true },
            { ...dateParam('to', 'Last date, no more than six days after from.'), required: true },
          ],
          responses: {
            '200': jsonResponse('Detailed planned sessions', 'PlannedSessionsResponse'),
            '400': jsonResponse('Invalid or overlong range', 'ErrorResponse'),
          },
        },
      },
      '/api/agent/plans': {
        post: {
          operationId: 'publishTrainingPlan',
          summary: 'Publish the agreed detailed plan into the Plan section',
          description:
            'Use only after discussion and explicit agreement. Requires the profile version used for planning, accepts 1–12 weeks, and supersedes only overlapping active future sessions.',
          'x-openai-isConsequential': true,
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('AgentPlanPublishRequest') } },
          },
          responses: {
            '200': jsonResponse('Previously published idempotent plan', 'AgentPlanPublishResponse'),
            '201': jsonResponse('Published plan', 'AgentPlanPublishResponse'),
            '400': jsonResponse('Invalid plan', 'ErrorResponse'),
            '409': jsonResponse('Profile or plan conflict; refresh context and revise', 'ErrorResponse'),
          },
        },
      },
      '/api/agent/risk': {
        get: {
          operationId: 'getRisk',
          summary: 'Fatigue/injury-risk analysis for a week',
          description: 'Returns the risk score, severity, and six indicators for the most recent week, or the week at `asOf`.',
          parameters: [dateParam('asOf', 'Return the latest analyzed week on or before this date. Defaults to the most recent week.')],
          responses: { '200': jsonResponse('Weekly analysis', 'WeeklyAnalysis') },
        },
      },
      '/api/agent/weeks': {
        get: {
          operationId: 'getWeeks',
          summary: 'Weekly training features for a date range',
          parameters: [dateParam('from', 'Start date (inclusive).'), dateParam('to', 'End date (inclusive).')],
          responses: { '200': jsonResponse('Weekly features', 'WeeksResponse') },
        },
      },
      '/api/agent/activities': {
        get: {
          operationId: 'getActivities',
          summary: 'Per-activity metrics for a date range',
          description:
            'Use this summary feed to locate an activity id. For a review of a particular session, laps, or reps, ' +
            'follow this call with getActivityDetail; whole-run averages cannot verify individual targets.',
          parameters: [dateParam('from', 'Start date (inclusive).'), dateParam('to', 'End date (inclusive).')],
          responses: { '200': jsonResponse('Activities', 'ActivitiesResponse') },
        },
      },
      '/api/agent/activities/{id}': {
        get: {
          operationId: 'getActivityDetail',
          summary: 'Get one activity with recorded lap and rep metrics',
          description:
            'Use after getActivities when reviewing a particular session or checking whether work reps met pace, power, or heart-rate targets. ' +
            'Returns compact source-device lap summaries, not second-by-second streams or inferred interval boundaries.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Activity id returned by getActivities.',
            },
          ],
          responses: {
            '200': jsonResponse('Activity and recorded laps', 'ActivityDetail'),
            '404': jsonResponse('Activity not found', 'ErrorResponse'),
          },
        },
      },
      '/api/agent/sync': {
        post: {
          operationId: 'triggerSync',
          summary: 'Trigger the legacy background Strava sync',
          responses: { '202': jsonResponse('Sync started', 'SyncAccepted') },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Your Lydiard AGENT_API_KEY.' },
      },
      schemas,
    },
  };
}
