// Dakort no longer has a service worker. This file stays for the phones
// that installed the one it had (2026-11-18 to 2026-11-21): the browser
// checks the worker's script on each visit, finds this one, and runs it;
// it deletes the saved copies, removes itself and reloads the open pages,
// which then come straight from the server. The old worker kept copies of
// the app's files, and an iPhone went on showing a PDF error that a fix
// on the server had already removed.
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((pages) => pages.forEach((p) => p.navigate(p.url))),
  )
})
