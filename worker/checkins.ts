import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import { getDailyCheckin, upsertDailyCheckin, type DailyCheckin, type DailyCheckinInput } from './db';
import type { Env } from './env';
import { getPushSubscriptions, sendCheckinPush, webPushConfigured } from './webPush';

const DAY_MS = 86_400_000;
const DEFAULT_TIME_ZONE = 'Europe/London';
const DEFAULT_HOUR = 19;

interface PromptRow {
  day: string;
  token_hash: string;
  channel: string;
  status: 'pending' | 'sent' | 'completed' | 'failed';
  expires_at: string;
}

interface CheckinPulse {
  legFreshness: number;
  energy: number;
  painLevel: number;
  motivation: number;
  sleepQuality: number;
  note: string;
}

export function checkinPageRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/:token', async (c) => {
    const prompt = await promptForToken(c.env.lydiard, c.req.param('token'));
    if (!prompt || Date.parse(prompt.expires_at) < Date.now()) {
      return c.html(expiredPage(), 410, securityHeaders());
    }
    const saved = await getDailyCheckin(c.env.lydiard, prompt.day);
    return c.html(checkinPage(prompt.day, c.req.param('token'), saved, '', prompt.channel.includes('whatsapp')), 200, securityHeaders());
  });

  app.post('/:token', async (c) => {
    const token = c.req.param('token');
    const prompt = await promptForToken(c.env.lydiard, token);
    if (!prompt || Date.parse(prompt.expires_at) < Date.now()) {
      return c.html(expiredPage(), 410, securityHeaders());
    }
    const form = await c.req.formData();
    const pulse = parsePulse(Object.fromEntries(form.entries()));
    if (pulse instanceof Error) {
      return c.html(checkinPage(prompt.day, token, await getDailyCheckin(c.env.lydiard, prompt.day), pulse.message, prompt.channel.includes('whatsapp')), 400, securityHeaders());
    }
    const saved = await savePulse(c.env.lydiard, prompt.day, pulse, 'prompt_link');
    await completePrompt(c.env.lydiard, prompt.day);
    return c.html(thanksPage(saved), 200, securityHeaders());
  });

  return app;
}

export function whatsappWebhookRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    if (mode === 'subscribe' && token && token === c.env.WHATSAPP_VERIFY_TOKEN && challenge) {
      return c.text(challenge);
    }
    return c.text('Webhook verification failed.', 403);
  });

  app.post('/', async (c) => {
    const raw = await c.req.text();
    if (!(await validMetaSignature(raw, c.req.header('X-Hub-Signature-256'), c.env.WHATSAPP_APP_SECRET))) {
      return c.text('Invalid signature.', 401);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.text('Invalid JSON.', 400);
    }
    c.executionCtx.waitUntil(handleWhatsAppPayload(c.env, payload));
    return c.text('EVENT_RECEIVED');
  });

  return app;
}

/**
 * Called by the hourly cron. Local-time gating plus the prompt row make it safe
 * to run more than once and let daylight-saving changes follow the runner.
 */
export async function sendDailyCheckinIfDue(env: Env, now = new Date()): Promise<'disabled' | 'not_due' | 'already_done' | 'sent' | 'failed'> {
  if (!env.CHECKIN_BASE_URL) return 'disabled';
  const timeZone = env.CHECKIN_TIME_ZONE || DEFAULT_TIME_ZONE;
  const hour = boundedInteger(env.CHECKIN_HOUR, 0, 23) ?? DEFAULT_HOUR;
  const local = localParts(now, timeZone);
  if (local.hour !== hour) return 'not_due';

  const day = local.day;
  if (await getDailyCheckin(env.lydiard, day)) return 'already_done';
  const existing = await env.lydiard.prepare('SELECT * FROM daily_checkin_prompts WHERE day=?1').bind(day).first<PromptRow>();
  if (existing && (existing.status === 'sent' || existing.status === 'completed')) return 'already_done';

  const subscriptions = webPushConfigured(env) ? await getPushSubscriptions(env.lydiard) : [];
  const useWhatsApp = subscriptions.length === 0 && whatsappConfigured(env);
  if (subscriptions.length === 0 && !useWhatsApp) return 'disabled';
  const channel = subscriptions.length > 0 ? 'web_push' : 'whatsapp';

  const token = randomToken();
  const tokenHash = await sha256(token);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 2 * DAY_MS).toISOString();
  await env.lydiard.prepare(
    `INSERT INTO daily_checkin_prompts (day, token_hash, channel, status, expires_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?5)
     ON CONFLICT(day) DO UPDATE SET
       token_hash=excluded.token_hash, channel=excluded.channel, status='pending', expires_at=excluded.expires_at,
       last_error=NULL, updated_at=excluded.updated_at`,
  ).bind(day, tokenHash, channel, expiresAt, createdAt).run();

  const base = env.CHECKIN_BASE_URL.replace(/\/$/, '');
  const url = `${base}/check-in/${encodeURIComponent(token)}`;
  try {
    const pushResults = subscriptions.length > 0
      ? await Promise.all(subscriptions.map((subscription) => sendCheckinPush(env, subscription, url)))
      : [];
    const pushSuccesses = pushResults.filter(Boolean).length;
    const messageId = pushSuccesses > 0
      ? `${pushSuccesses} web push notification(s)`
      : useWhatsApp
        ? await sendWhatsAppTemplate(env, url)
        : '';
    if (!messageId) throw new Error('No active device accepted the daily push.');
    await env.lydiard.prepare(
      `UPDATE daily_checkin_prompts
       SET status='sent', message_id=?2, sent_at=?3, last_error=NULL, updated_at=?3
       WHERE day=?1`,
    ).bind(day, messageId, new Date().toISOString()).run();
    return 'sent';
  } catch (error) {
    await env.lydiard.prepare(
      `UPDATE daily_checkin_prompts SET status='failed', last_error=?2, updated_at=?3 WHERE day=?1`,
    ).bind(day, error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000), new Date().toISOString()).run();
    return 'failed';
  }
}

export function parsePulse(input: Record<string, unknown>): CheckinPulse | Error {
  const legFreshness = pulseInteger(input.legFreshness, 1, 5);
  const energy = pulseInteger(input.energy, 1, 5);
  const painLevel = pulseInteger(input.painLevel, 0, 3);
  const motivation = pulseInteger(input.motivation, 1, 5);
  const sleepQuality = pulseInteger(input.sleepQuality, 1, 5);
  if ([legFreshness, energy, painLevel, motivation, sleepQuality].some((value) => value === undefined)) {
    return new Error('Choose one answer for each of the five checks.');
  }
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 1000) return new Error('Keep the note to 1,000 characters or fewer.');
  return { legFreshness: legFreshness!, energy: energy!, painLevel: painLevel!, motivation: motivation!, sleepQuality: sleepQuality!, note };
}

export async function savePulse(db: D1Database, day: string, pulse: CheckinPulse, source: string): Promise<DailyCheckin> {
  const current = await getDailyCheckin(db, day);
  const input: DailyCheckinInput = {
    day,
    energy: pulse.energy,
    legFreshness: pulse.legFreshness,
    motivation: pulse.motivation,
    painLevel: pulse.painLevel,
    generalFatigue: current?.generalFatigue,
    lifeStress: current?.lifeStress,
    leftKneePain: current?.leftKneePain,
    rightKneePain: current?.rightKneePain,
    leftAchillesPain: current?.leftAchillesPain,
    rightAchillesPain: current?.rightAchillesPain,
    painAlteredGait: current?.painAlteredGait ?? false,
    illnessSuspected: current?.illnessSuspected ?? false,
    sleepQuality: pulse.sleepQuality,
    bodyweightKg: current?.bodyweightKg,
    note: pulse.note,
    source,
  };
  return upsertDailyCheckin(db, input);
}

function parseCompactReply(text: string): CheckinPulse | Error {
  const match = text.trim().match(/^([1-5])\s*[,/]?\s*([1-5])\s*[,/]?\s*([0-3])\s*[,/]?\s*([1-5])\s*[,/]?\s*([1-5])(?:\s+([\s\S]*))?$/);
  if (!match) return new Error('Reply with five numbers: legs 1–5, energy 1–5, niggles 0–3, motivation 1–5, sleep 1–5. Example: 4 4 0 4 5');
  return {
    legFreshness: Number(match[1]),
    energy: Number(match[2]),
    painLevel: Number(match[3]),
    motivation: Number(match[4]),
    sleepQuality: Number(match[5]),
    note: (match[6] ?? '').trim().slice(0, 1000),
  };
}

async function handleWhatsAppPayload(env: Env, payload: unknown): Promise<void> {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) return;
  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      const value = isRecord(change) && isRecord(change.value) ? change.value : null;
      if (!value || !Array.isArray(value.messages)) continue;
      for (const message of value.messages) {
        if (!isRecord(message) || message.type !== 'text' || !isRecord(message.text)) continue;
        const from = typeof message.from === 'string' ? digits(message.from) : '';
        if (!from || from !== digits(env.WHATSAPP_RECIPIENT ?? '')) continue;
        const text = typeof message.text.body === 'string' ? message.text.body : '';
        const pulse = parseCompactReply(text);
        if (pulse instanceof Error) {
          await sendWhatsAppText(env, pulse.message);
          continue;
        }
        const day = localParts(new Date(), env.CHECKIN_TIME_ZONE || DEFAULT_TIME_ZONE).day;
        await savePulse(env.lydiard, day, pulse, 'whatsapp_reply');
        await completePrompt(env.lydiard, day);
        await sendWhatsAppText(env, `Saved for today — legs ${pulse.legFreshness}/5, energy ${pulse.energy}/5, niggles ${painLabel(pulse.painLevel)}, motivation ${pulse.motivation}/5, sleep ${pulse.sleepQuality}/5.`);
      }
    }
  }
}

async function sendWhatsAppTemplate(env: Env, checkinUrl: string): Promise<string> {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: env.WHATSAPP_RECIPIENT,
    type: 'template',
    template: {
      name: env.WHATSAPP_TEMPLATE_NAME || 'daily_training_checkin',
      language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_GB' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: checkinUrl }] }],
    },
  };
  const response = await whatsappFetch(env, payload);
  const messageId = isRecord(response) && Array.isArray(response.messages) && isRecord(response.messages[0])
    ? response.messages[0].id
    : undefined;
  return typeof messageId === 'string' ? messageId : '';
}

async function sendWhatsAppText(env: Env, body: string): Promise<void> {
  await whatsappFetch(env, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: env.WHATSAPP_RECIPIENT,
    type: 'text',
    text: { preview_url: false, body },
  });
}

async function whatsappFetch(env: Env, body: object): Promise<unknown> {
  if (!whatsappConfigured(env)) throw new Error('WhatsApp outreach is not configured.');
  const version = env.WHATSAPP_GRAPH_VERSION || 'v26.0';
  const response = await fetch(`https://graph.facebook.com/${version}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
      ? payload.error.message
      : `HTTP ${response.status}`;
    throw new Error(`WhatsApp send failed: ${detail}`);
  }
  return payload;
}

async function promptForToken(db: D1Database, token: string): Promise<PromptRow | null> {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) return null;
  return db.prepare('SELECT * FROM daily_checkin_prompts WHERE token_hash=?1').bind(await sha256(token)).first<PromptRow>();
}

async function completePrompt(db: D1Database, day: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE daily_checkin_prompts SET status='completed', completed_at=?2, updated_at=?2 WHERE day=?1`,
  ).bind(day, now).run();
}

function localParts(date: Date, timeZone: string): { day: string; hour: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function whatsappConfigured(env: Env): boolean {
  return Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_RECIPIENT);
}

function pulseInteger(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function boundedInteger(value: string | undefined, min: number, max: number): number | undefined {
  return value === undefined ? undefined : pulseInteger(value, min, max);
}

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function validMetaSignature(body: string, signature: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const receivedHex = signature.slice(7);
  if (!/^[0-9a-f]{64}$/i.test(receivedHex)) return false;
  const received = new Uint8Array(receivedHex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
  if (received.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= expected[index] ^ received[index];
  return diff === 0;
}

function securityHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

function checkinPage(day: string, token: string, saved: DailyCheckin | null, error = '', allowWhatsAppReply = false): string {
  const values = {
    legFreshness: saved?.legFreshness,
    energy: saved?.energy,
    painLevel: saved?.painLevel,
    motivation: saved?.motivation,
    sleepQuality: saved?.sleepQuality,
  };
  return pageShell(`
    <main>
      <p class="eyebrow">Lydiard daily pulse</p>
      <h1>How are you absorbing the work?</h1>
      <p class="intro">Five quick answers. Rest days count too.</p>
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="/check-in/${encodeURIComponent(token)}">
        ${ratingRow('legFreshness', 'Leg freshness', ['Cooked', 'Heavy', 'Okay', 'Good', 'Fresh'], values.legFreshness)}
        ${ratingRow('energy', 'Overall energy', ['Empty', 'Low', 'Okay', 'Good', 'High'], values.energy)}
        ${ratingRow('painLevel', 'Pain / niggles', ['None', 'Mild', 'Moderate', 'Significant'], values.painLevel, 0)}
        ${ratingRow('motivation', 'Motivation', ['None', 'Low', 'Okay', 'Good', 'High'], values.motivation)}
        ${ratingRow('sleepQuality', 'Sleep quality', ['Poor', 'Weak', 'Okay', 'Good', 'Great'], values.sleepQuality)}
        <label class="note"><span>Anything else? <small>Optional</small></span><textarea name="note" maxlength="1000" rows="2" placeholder="One line is enough">${escapeHtml(saved?.note ?? '')}</textarea></label>
        <button type="submit">${saved ? 'Update today' : 'Save check-in'}</button>
      </form>
      ${allowWhatsAppReply ? '<p class="reply-help">You can also reply in WhatsApp with five numbers: legs, energy, niggles (0–3), motivation, sleep. Example: <strong>4 4 0 4 5</strong></p>' : ''}
    </main>`, `${day} check-in`);
}

function ratingRow(name: string, label: string, labels: string[], selected: number | undefined, start = 1): string {
  return `<fieldset><legend>${escapeHtml(label)}</legend><div class="choices">${labels.map((text, index) => {
    const value = index + start;
    return `<label><input type="radio" name="${name}" value="${value}" ${selected === value ? 'checked' : ''} required><span><b>${value}</b><small>${escapeHtml(text)}</small></span></label>`;
  }).join('')}</div></fieldset>`;
}

function thanksPage(saved: DailyCheckin): string {
  return pageShell(`<main class="thanks"><div class="check">✓</div><p class="eyebrow">Saved</p><h1>That’s today covered.</h1><p>Your coach now has the signal for ${escapeHtml(saved.day)}. One off day gets recorded; a trend gets attention.</p><p class="summary">Legs ${saved.legFreshness}/5 · Energy ${saved.energy}/5 · Niggles ${painLabel(saved.painLevel ?? 0)} · Motivation ${saved.motivation}/5 · Sleep ${saved.sleepQuality}/5</p></main>`, 'Check-in saved');
}

function expiredPage(): string {
  return pageShell('<main class="thanks"><h1>This check-in link has expired.</h1><p>Use the latest WhatsApp prompt or open Lydiard to record today.</p></main>', 'Link expired');
}

function painLabel(value: number): string {
  return ['none', 'mild', 'moderate', 'significant'][value] ?? 'unknown';
}

function pageShell(content: string, title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#18392f"><title>${escapeHtml(title)} · Lydiard</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f2eee4;color:#17362e;font:16px/1.4 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(100%,560px);margin:auto;padding:28px 18px 48px}.eyebrow{margin:0 0 8px;color:#a14f32;font-size:.75rem;font-weight:800;letter-spacing:.13em;text-transform:uppercase}h1{margin:0;font-family:Georgia,serif;font-size:clamp(2rem,8vw,3.2rem);font-weight:500;line-height:1.02}.intro{margin:12px 0 24px;color:#5d6c65}form{display:grid;gap:14px}fieldset{margin:0;padding:14px;border:1px solid #d7d0c0;border-radius:16px;background:#fffdf7}legend{padding:0 6px;font-weight:800}.choices{display:flex;gap:7px}.choices label{flex:1;min-width:0}.choices input{position:absolute;opacity:0;pointer-events:none}.choices span{display:grid;place-items:center;min-height:56px;padding:6px 2px;border:1px solid #d9d2c3;border-radius:11px;background:#f7f3ea;cursor:pointer}.choices b{font-size:1rem}.choices small{overflow:hidden;width:100%;font-size:.61rem;text-align:center;text-overflow:ellipsis;white-space:nowrap}.choices input:checked+span{border-color:#1f5a49;background:#1f5a49;color:#fff;box-shadow:0 0 0 2px #b7d7ca}.choices input:focus-visible+span{outline:3px solid #d29054;outline-offset:2px}.note{display:grid;gap:7px;font-weight:800}.note small{color:#78837e;font-weight:500}textarea{width:100%;resize:vertical;border:1px solid #cfc7b7;border-radius:12px;background:#fffdf7;padding:12px;font:inherit;color:inherit}button{min-height:52px;border:0;border-radius:13px;background:#a14f32;color:white;font:800 1rem/1 ui-sans-serif,system-ui;cursor:pointer}.reply-help{padding:14px;color:#68746f;font-size:.78rem}.error{border-radius:10px;background:#f9ded5;padding:10px;color:#8b2d19}.thanks{padding-top:20vh;text-align:center}.thanks .check{display:grid;place-items:center;width:58px;height:58px;margin:0 auto 20px;border-radius:50%;background:#1f5a49;color:#fff;font-size:2rem}.thanks .summary{margin-top:24px;border-radius:14px;background:#fffdf7;padding:16px;font-weight:700}@media(max-width:380px){.choices{gap:4px}.choices span{min-height:52px}.choices small{font-size:.55rem}}
  </style></head><body>${content}</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
