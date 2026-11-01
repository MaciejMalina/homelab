// Minimalny service worker: umożliwia instalację jako aplikacja (PWA).
// Celowo bez cache'owania stron — dane mają być zawsze świeże z malinki.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
