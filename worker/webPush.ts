import { buildPushPayload, type PushSubscription } from '@block65/webcrypto-web-push';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from './env';

export interface StoredPushSubscription extends PushSubscription {
  endpointHash: string;
}

interface SubscriptionRow {
  endpoint_hash: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function webPushConfigured(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

export function parsePushSubscription(input: unknown): PushSubscription | Error {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return new Error('subscription must be an object.');
  const value = input as Record<string, unknown>;
  const keys = value.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return new Error('subscription keys are required.');
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint : '';
  const p256dh = typeof (keys as Record<string, unknown>).p256dh === 'string' ? (keys as Record<string, string>).p256dh : '';
  const auth = typeof (keys as Record<string, unknown>).auth === 'string' ? (keys as Record<string, string>).auth : '';
  if (!endpoint.startsWith('https://') || endpoint.length > 4096) return new Error('subscription endpoint must be HTTPS.');
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{12,100}$/.test(auth)) {
    return new Error('subscription keys are invalid.');
  }
  return {
    endpoint,
    expirationTime: typeof value.expirationTime === 'number' ? value.expirationTime : null,
    keys: { p256dh, auth },
  };
}

export async function savePushSubscription(
  db: D1Database,
  subscription: PushSubscription,
  userAgent: string,
): Promise<string> {
  const endpointHash = await sha256(subscription.endpoint);
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO web_push_subscriptions (
       endpoint_hash, endpoint, p256dh, auth, user_agent, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(endpoint_hash) DO UPDATE SET
       endpoint=excluded.endpoint, p256dh=excluded.p256dh, auth=excluded.auth,
       user_agent=excluded.user_agent, last_error=NULL, updated_at=excluded.updated_at`,
  ).bind(endpointHash, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent.slice(0, 500), now).run();
  return endpointHash;
}

export async function removePushSubscription(db: D1Database, endpoint: string): Promise<void> {
  await db.prepare('DELETE FROM web_push_subscriptions WHERE endpoint_hash=?1').bind(await sha256(endpoint)).run();
}

export async function hasPushSubscription(db: D1Database, endpoint: string): Promise<boolean> {
  return Boolean(await db.prepare('SELECT 1 FROM web_push_subscriptions WHERE endpoint_hash=?1')
    .bind(await sha256(endpoint)).first());
}

export async function getPushSubscriptions(db: D1Database): Promise<StoredPushSubscription[]> {
  const result = await db.prepare('SELECT endpoint_hash, endpoint, p256dh, auth FROM web_push_subscriptions').all<SubscriptionRow>();
  return (result.results ?? []).map((row) => ({
    endpointHash: row.endpoint_hash,
    endpoint: row.endpoint,
    expirationTime: null,
    keys: { p256dh: row.p256dh, auth: row.auth },
  }));
}

export async function sendCheckinPush(
  env: Env,
  subscription: StoredPushSubscription,
  checkinUrl: string,
): Promise<boolean> {
  return sendPushNotification(env, subscription, {
    title: 'Lydiard daily pulse',
    body: 'How are your legs, energy, niggles, motivation and sleep? Rest days count too.',
    url: checkinUrl,
    tag: 'lydiard-daily-checkin',
  }, 'daily-checkin');
}

export async function sendPushNotification(
  env: Env,
  subscription: StoredPushSubscription,
  data: { title: string; body: string; url: string; tag: string },
  topic: string,
): Promise<boolean> {
  const message = {
    data: {
      ...data,
    },
    options: { ttl: 21_600, urgency: 'normal' as const, topic },
  };
  try {
    const request = await buildPushPayload(message, subscription, {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    });
    const response = await fetch(subscription.endpoint, request);
    if (response.status === 404 || response.status === 410) {
      await env.lydiard.prepare('DELETE FROM web_push_subscriptions WHERE endpoint_hash=?1').bind(subscription.endpointHash).run();
      return false;
    }
    if (!response.ok) throw new Error(`Push service returned HTTP ${response.status}.`);
    await env.lydiard.prepare(
      'UPDATE web_push_subscriptions SET last_success_at=?2, last_error=NULL, updated_at=?2 WHERE endpoint_hash=?1',
    ).bind(subscription.endpointHash, new Date().toISOString()).run();
    return true;
  } catch (error) {
    await env.lydiard.prepare(
      'UPDATE web_push_subscriptions SET last_error=?2, updated_at=?3 WHERE endpoint_hash=?1',
    ).bind(subscription.endpointHash, error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000), new Date().toISOString()).run();
    return false;
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
