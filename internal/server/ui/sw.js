// Dakort's service worker: makes the app installable and shows a plain
// page when the server can't be reached. Network first for the app's own
// files (a copy is kept for when the network fails); the API, the event
// stream and the login page always go to the network and are never kept.
const cache = 'dakort-v1'
const offline = '/offline.html'

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(cache)
      .then((c) => c.add(offline))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== cache).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/login') return
  if ((req.headers.get('accept') || '').includes('text/event-stream')) return

  if (req.mode === 'navigate') {
    // The page itself: never a stale copy, the offline page instead.
    e.respondWith(fetch(req).catch(() => caches.match(offline)))
    return
  }
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone()
          caches.open(cache).then((c) => c.put(req, copy))
        }
        return res
      })
      .catch(() => caches.match(req).then((hit) => hit || Response.error())),
  )
})
