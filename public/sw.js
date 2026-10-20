self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : 'Time for your daily check-in.' };
  }
  event.waitUntil(self.registration.showNotification(message.title || 'Lydiard', {
    body: message.body || 'Time for your daily check-in.',
    icon: '/lydiard-mark-512.png',
    badge: '/lydiard-mark-512.png',
    tag: message.tag || 'lydiard',
    renotify: false,
    data: { url: message.url || '/?view=log' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/?view=log', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    if (existing) {
      await existing.navigate(url);
      return existing.focus();
    }
    return self.clients.openWindow(url);
  })());
});
