// Registered only over HTTPS, so the phone can install Faravan as an app. It caches nothing:
// requests change by the minute, and a stale inbox would be worse than an honest "can't reach your computer".
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
