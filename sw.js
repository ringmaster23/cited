// Cited Conversations — no-op service worker
// Registers with no caching and no fetch interception.
// This file exists solely to suppress 404 errors from browsers
// that probe for a service worker.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// No fetch handler — all requests pass through to the network normally.
