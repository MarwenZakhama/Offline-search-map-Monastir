/* Caches the app itself so it opens with no internet.
   The map (monastir.pmtiles) and your points are stored separately, in IndexedDB. */
const VERSION = 'v1';
const CACHE = 'monastir-shell-' + VERSION;
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'lib.js', 'manifest.webmanifest',
  'icon.svg', 'icon-192.png', 'icon-512.png', 'data/sample.csv',
  'vendor/leaflet.css', 'vendor/leaflet.js', 'vendor/pmtiles.js',
  'vendor/protomaps-leaflet.js', 'vendor/papaparse.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('monastir-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Open instantly from the cache, refresh it quietly in the background when online.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.endsWith('.pmtiles')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
    const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
