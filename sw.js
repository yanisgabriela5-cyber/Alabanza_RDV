// Service worker: permite instalar la app y abrirla sin conexión.
// Estrategia: red primero para los archivos de la app (siempre la última versión),
// con copia en caché como respaldo. Las llamadas a Supabase no se tocan.
const CACHE = 'alabanza-v2';
const SHELL = [
  './', 'index.html', 'css/styles.css', 'js/app.js', 'js/acordes.js', 'js/config.js',
  'manifest.webmanifest', 'icons/logo.png', 'icons/icon-192.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const propio = url.origin === location.origin;
  const cdn = url.hostname === 'cdn.jsdelivr.net';
  if (!propio && !cdn) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copia = res.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
        return res;
      })
      .catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
  );
});
