import type { D1Database } from '@cloudflare/workers-types';

export interface Env {
  lydiard: D1Database;

  // Strava app credentials + OAuth
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string; // secret
  STRAVA_REDIRECT_URI?: string;

  // Agent access
  AGENT_API_KEY: string; // secret — bearer token for /api/agent/*

  // Human-facing map/dashboard gate. When set, the public /api/* read endpoints
  // require this password (sent by the frontend). Unset => endpoints stay open.
  SITE_PASSWORD?: string; // secret

  // CORS / config
  APP_ORIGIN?: string;
  STRAVA_FETCH_YEARS?: string;
  STREAMS_PER_RUN?: string;
}

export function fetchYears(env: Env): number {
  const value = Number(env.STRAVA_FETCH_YEARS ?? '3');
  return Number.isFinite(value) && value > 0 ? value : 3;
}

export function streamsPerRun(env: Env): number {
  const value = Number(env.STREAMS_PER_RUN ?? '40');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 40;
}
