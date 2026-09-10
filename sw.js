/**
 * The planner's service worker. Two jobs: show a reminder pushed from the
 * server while the tab is shut, and focus (or open) the planner when one is
 * clicked.
 *
 * The in-tab checkReminders() loop in main.js still handles reminders while the
 * planner is open; this is the path for every other time. A push and an in-tab
 * fire for the same task carry the same `tag`, so the second only replaces the
 * first rather than stacking a duplicate.
 */

// Take over as soon as a new version is installed rather than waiting for every
// tab to close. Without this, an updated worker sits idle behind the old one --
// and the old one has no `push` listener, so a reminder pushed to it is
// silently dropped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = {};
    }
    const title = data.title || 'Task reminder';
    const options = {
        body: data.body || 'Task reminder',
        tag: data.tag || 'task-reminder',
        renotify: true,
        data: { url: data.url || './main_page.html' },
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const raw = (event.notification.data && event.notification.data.url) || './main_page.html';
    const target = new URL(raw, self.location.href).href;
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url === target && 'focus' in client) return client.focus();
            }
            return clients.openWindow(target);
        })
    );
});
