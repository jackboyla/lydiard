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
      properties: {
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
      },
    },
    WeeksResponse: {
      type: 'object',
      properties: { weeks: { type: 'array', items: ref('WeeklyRunBlock') } },
    },
    ActivitiesResponse: {
      type: 'object',
      properties: { activities: { type: 'array', items: ref('Activity') } },
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
      version: '1.0.0',
      description:
        'Query a single runner\'s training history (activities, weekly features, and personalized ' +
        'fatigue/injury-risk analysis) over any time period. Designed for AI agents planning training.',
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
          parameters: [dateParam('from', 'Start date (inclusive).'), dateParam('to', 'End date (inclusive).')],
          responses: { '200': jsonResponse('Activities', 'ActivitiesResponse') },
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
