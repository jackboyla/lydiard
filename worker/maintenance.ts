import type { D1Database } from '@cloudflare/workers-types';
import { buildCoachContext } from './coachContext';

/**
 * Run cheap daily maintenance and persist an adaptive-zone review when it is
 * due. The coach context already owns the review gates and append-only write,
 * so scheduled work and ordinary reads cannot adopt different zone states.
 */
export async function refreshAdaptiveZones(db: D1Database): Promise<void> {
  await buildCoachContext(db);
}
