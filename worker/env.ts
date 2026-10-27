import type { D1Database } from '@cloudflare/workers-types';

export interface Env {
  lydiard: D1Database;

  // Strava app credentials + OAuth
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string; // secret
  STRAVA_REDIRECT_URI?: string;

  // Agent access
  AGENT_API_KEY: string; // secret — bearer token for /api/agent/*
  INGEST_API_KEY?: string; // optional separate bearer token for external Garmin/file ingest

  // Human-facing map/dashboard gate. When set, the public /api/* read endpoints
  // require this password (sent by the frontend). Unset => endpoints stay open.
  SITE_PASSWORD?: string; // secret

  // Owner-triggered Garmin workflow dispatch. Use a fine-grained GitHub token
  // restricted to this repository with Actions read/write permission.
  GITHUB_SYNC_TOKEN?: string; // secret
  GITHUB_SYNC_REPOSITORY?: string; // owner/repository
  GITHUB_SYNC_WORKFLOW?: string; // workflow file name or numeric id
  GITHUB_SYNC_REF?: string; // branch/tag containing the workflow
  FITBIT_SYNC_WORKFLOW?: string; // Fitbit recovery workflow queued each hour; unset to skip

  // Active daily subjective check-in (Meta WhatsApp Cloud API).
  WHATSAPP_ACCESS_TOKEN?: string; // secret
  WHATSAPP_APP_SECRET?: string; // secret — validates inbound webhook signatures
  WHATSAPP_VERIFY_TOKEN?: string; // secret — Meta webhook setup challenge
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_RECIPIENT?: string; // E.164 digits, e.g. 447700900123
  WHATSAPP_TEMPLATE_NAME?: string;
  WHATSAPP_TEMPLATE_LANGUAGE?: string;
  WHATSAPP_GRAPH_VERSION?: string;
  CHECKIN_BASE_URL?: string;
  CHECKIN_TIME_ZONE?: string;
  CHECKIN_HOUR?: string;

  // Free first-party Web Push. Public key and subject may be vars; private key
  // must be a Worker secret.
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string; // secret
  VAPID_SUBJECT?: string;

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
