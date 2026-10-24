import fs from 'node:fs';
import { chromium } from 'playwright';
import { parsePushSubscription } from '../worker/webPush';

const BASE_URL = process.env.LYDIARD_BASE_URL ?? 'http://127.0.0.1:8787';
const PUBLIC_KEY = 'BE6TG5_vhK16U8wsU91vQHO8XkDxyQYm6XO4yFF3bHQCtiD0xLuE4nDyj5HvRJ-6Xo8h_MZiAUphV_Wcs8g0aPM';

function readSiteKey(): string {
  if (process.env.LYDIARD_SITE_KEY) return process.env.LYDIARD_SITE_KEY;
  if (!fs.existsSync('.dev.vars')) return '';
  const line = fs.readFileSync('.dev.vars', 'utf8').split(/\r?\n/).find((item) => /^SITE_PASSWORD\s*=/.test(item));
  return line?.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') ?? '';
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const page = await context.newPage();
let subscribed = false;

try {
  await page.addInitScript((siteKey) => localStorage.setItem('lydiard.siteKey', siteKey), readSiteKey());

  await page.route('**/api/push/config*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ enabled: true, publicKey: PUBLIC_KEY }),
  }));
  await page.route('**/api/push/subscribe', async (route) => {
    const body = route.request().postDataJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!body.endpoint || !body.keys?.p256dh || !body.keys.auth) throw new Error('Browser sent an incomplete subscription.');
    subscribed = true;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ subscribed: true, delivered: true }),
    });
  });

  await page.goto(`${BASE_URL}/?view=log`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Open settings' }).click();
  const enable = page.getByRole('button', { name: 'Enable free phone reminder' });
  const blocked = page.getByRole('button', { name: 'Notifications blocked in browser settings' });
  if (await enable.isVisible()) {
    await enable.click();
    await page.getByText('Daily phone reminder on').waitFor();
    if (!subscribed) throw new Error('Browser did not send its push subscription.');
    const note = await page.locator('.push-reminder-control').innerText();
    if (!note.includes('Test reminder sent.')) throw new Error('Successful test reminder state is missing.');
  } else if (!(await blocked.isVisible())) {
    throw new Error(`Reminder control is missing. Menu: ${await page.locator('#topbar-controls').innerText()}`);
  }
  const note = await page.locator('.push-reminder-control').innerText();
  const parsed = parsePushSubscription({
    endpoint: 'https://push.example/device',
    expirationTime: null,
    keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
  });
  if (parsed instanceof Error) throw parsed;
  await page.screenshot({ path: 'progress/push-reminder-mobile.png', fullPage: false });

  // Headless browsers can block real push. Exercise subscription recovery with
  // the browser push boundary stubbed, without sending any notifications.
  const recovery = await context.newPage();
  await recovery.addInitScript({ content: `
    let expired = false;
    const subscription = {
      endpoint: 'https://push.example/existing-device',
      toJSON: () => ({ endpoint: 'https://push.example/existing-device', keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } }),
      unsubscribe: async () => { expired = true; return true; },
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { register: async () => ({ pushManager: {
        getSubscription: async () => expired ? null : subscription,
        subscribe: async () => { expired = false; return subscription; },
      } }) },
    });
    Object.defineProperty(window, 'Notification', { value: { permission: 'granted', requestPermission: async () => 'granted' } });
    Object.defineProperty(window, 'PushManager', { value: class {} });
  ` });
  let backendSubscribed = false;
  let saveFails = true;
  let endpointExpired = false;
  await recovery.route('**/api/push/config*', (route) => {
    if (new URL(route.request().url()).searchParams.get('endpoint') !== 'https://push.example/existing-device') {
      throw new Error('Reminder status did not check the current browser endpoint.');
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, publicKey: PUBLIC_KEY, subscribed: backendSubscribed }) });
  });
  await recovery.route('**/api/push/subscribe', (route) => {
    if (saveFails) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary save failure' }) });
    backendSubscribed = !endpointExpired;
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ subscribed: backendSubscribed, delivered: false }) });
  });
  await recovery.goto(`${BASE_URL}/?view=log`, { waitUntil: 'networkidle' });
  await recovery.getByRole('button', { name: 'Open settings' }).click();
  const recoverEnable = recovery.getByRole('button', { name: 'Enable free phone reminder' });
  await recoverEnable.waitFor();
  await recoverEnable.click();
  await recovery.getByText('Temporary save failure', { exact: true }).waitFor();
  // The failed save must leave the endpoint available for the next attempt.
  if (!(await recovery.evaluate(async () => (await (await navigator.serviceWorker.register('/sw.js')).pushManager.getSubscription())?.endpoint))) {
    throw new Error('A temporary save failure removed the browser subscription.');
  }
  await recovery.reload({ waitUntil: 'networkidle' });
  await recovery.getByRole('button', { name: 'Open settings' }).click();
  await recoverEnable.waitFor();
  saveFails = false;
  await recoverEnable.click();
  await recovery.getByText('Daily phone reminder on', { exact: true }).waitFor();
  await recovery.getByText('Reminder saved, but the test could not be sent.', { exact: false }).waitFor();
  await recovery.reload({ waitUntil: 'networkidle' });
  await recovery.getByRole('button', { name: 'Open settings' }).click();
  await recovery.getByText('Daily phone reminder on', { exact: true }).waitFor();
  backendSubscribed = false;
  endpointExpired = true;
  await recovery.reload({ waitUntil: 'networkidle' });
  await recovery.getByRole('button', { name: 'Open settings' }).click();
  await recoverEnable.click();
  await recovery.getByText('This reminder subscription expired.', { exact: false }).waitFor();
  if (await recovery.evaluate(async () => (await (await navigator.serviceWorker.register('/sw.js')).pushManager.getSubscription()) !== null)) {
    throw new Error('An expired endpoint remained subscribed in the browser.');
  }
  endpointExpired = false;
  await recoverEnable.click();
  await recovery.getByText('Daily phone reminder on', { exact: true }).waitFor();
  await recovery.close();

  console.log(JSON.stringify({ ok: true, subscribed, subscriptionRecovery: true, headlessBlocked: await blocked.isVisible(), state: note.replace(/\s+/g, ' ').trim() }, null, 2));
} finally {
  await browser.close();
}
