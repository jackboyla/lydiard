// OpenAPI 3.1 document describing the agent endpoints, so ChatGPT can import it
// as a Custom GPT Action (or a Scheduled Task can be pointed at it). Bearer-key
// secured. The server URL is derived from the incoming request origin.

export function buildOpenApiDocument(origin: string): unknown {
  const dateParam = (name: string, description: string) => ({
    name,
    in: 'query',
    required: false,
    schema: { type: 'string', format: 'date', example: '2026-05-01' },
    description,
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
          responses: { '200': { description: 'Plan context bundle', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/api/agent/risk': {
        get: {
          operationId: 'getRisk',
          summary: 'Fatigue/injury-risk analysis for a week',
          description: 'Returns the risk score, severity, and six indicators for the most recent week, or the week at `asOf`.',
          parameters: [dateParam('asOf', 'Return the latest analyzed week on or before this date. Defaults to the most recent week.')],
          responses: { '200': { description: 'Weekly analysis', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/api/agent/weeks': {
        get: {
          operationId: 'getWeeks',
          summary: 'Weekly training features for a date range',
          parameters: [dateParam('from', 'Start date (inclusive).'), dateParam('to', 'End date (inclusive).')],
          responses: { '200': { description: 'Weekly features', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/api/agent/activities': {
        get: {
          operationId: 'getActivities',
          summary: 'Per-activity metrics for a date range',
          parameters: [dateParam('from', 'Start date (inclusive).'), dateParam('to', 'End date (inclusive).')],
          responses: { '200': { description: 'Activities', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/api/agent/sync': {
        post: {
          operationId: 'triggerSync',
          summary: 'Trigger a background Strava sync',
          responses: { '202': { description: 'Sync started' } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Your Lydiard AGENT_API_KEY.' },
      },
    },
  };
}
