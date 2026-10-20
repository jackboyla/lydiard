import { useEffect, useState } from 'react';
import { Bell, BellOff, Check } from 'lucide-react';
import { getPushConfig, subscribeToPush, unsubscribeFromPush } from '../data/api';

type ReminderState = 'loading' | 'unavailable' | 'install' | 'off' | 'asking' | 'on' | 'blocked' | 'error';

export function PushReminderControl() {
  const [state, setState] = useState<ReminderState>('loading');
  const [message, setMessage] = useState('');
  const [publicKey, setPublicKey] = useState('');

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        if (active) setState('unavailable');
        return;
      }
      if (isIos() && !isStandalone()) {
        if (active) setState('install');
        return;
      }
      try {
        const registration = await navigator.serviceWorker.register('/sw.js');
        const subscription = await registration.pushManager.getSubscription();
        const config = await getPushConfig(subscription?.endpoint);
        if (!active) return;
        if (!config.enabled || !config.publicKey) {
          setState('unavailable');
          return;
        }
        setPublicKey(config.publicKey);
        setState(subscription && config.subscribed ? 'on' : Notification.permission === 'denied' ? 'blocked' : 'off');
      } catch (error) {
        if (active) {
          setMessage(error instanceof Error ? error.message : 'Could not check reminder settings.');
          setState('error');
        }
      }
    })();
    return () => { active = false; };
  }, []);

  const enable = async () => {
    setState('asking');
    setMessage('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'blocked' : 'off');
        return;
      }
      const registration = await navigator.serviceWorker.register('/sw.js');
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlBytes(publicKey),
      });
      const result = await subscribeToPush(subscription.toJSON());
      if (!result.subscribed) {
        await subscription.unsubscribe();
        throw new Error('This reminder subscription expired. Enable reminders again to renew it.');
      }
      setState('on');
      setMessage(result.delivered ? 'Test reminder sent.' : 'Reminder saved, but the test could not be sent. We’ll try again at the daily reminder time.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not enable reminders.');
      setState('error');
    }
  };

  const disable = async () => {
    setState('asking');
    setMessage('');
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await unsubscribeFromPush(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState('off');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not disable reminders.');
      setState('error');
    }
  };

  if (state === 'loading' || state === 'unavailable') return null;
  if (state === 'install') {
    return <p className="push-reminder-install"><Bell size={15} /> On iPhone, add Lydiard to your Home Screen, reopen it, then enable reminders here.</p>;
  }
  if (state === 'on') {
    return (
      <div className="push-reminder-control is-on">
        <span><Check size={15} /> Daily phone reminder on</span>
        <button type="button" onClick={() => void disable()}>Turn off</button>
        {message && <small>{message}</small>}
      </div>
    );
  }
  return (
    <div className="push-reminder-control">
      <button type="button" onClick={() => void enable()} disabled={state === 'asking' || state === 'blocked'}>
        {state === 'blocked' ? <BellOff size={15} /> : <Bell size={15} />}
        {state === 'asking' ? 'Enabling…' : state === 'blocked' ? 'Notifications blocked in browser settings' : 'Enable free phone reminder'}
      </button>
      {message && <small>{message}</small>}
    </div>
  );
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}
