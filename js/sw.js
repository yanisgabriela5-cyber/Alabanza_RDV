// Service worker: permite instalar la app y abrirla sin conexión.
// - Archivos de la app: red primero (siempre la última versión), copia en caché como respaldo.
// - Imágenes y partituras de Supabase Storage: caché primero (no cambian), red si no están.
// - Datos de Supabase (REST): no se tocan; la app guarda su propia copia (IndexedDB).
const CACHE = 'alabanza-v8';
const ARCHIVOS = 'alabanza-archivos';
const SHELL = [
  './', 'index.html', 'css/styles.css', 'js/app.js', 'js/acordes.js', 'js/cifrado.js', 'js/config.js',
  'manifest.webmanifest', 'icons/logo.png', 'icons/icon-192.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== ARCHIVOS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.pathname.includes('/storage/v1/object/public/')) {
    e.respondWith(
      caches.match(req.url).then(hit => hit || fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') { const copia = res.clone(); caches.open(ARCHIVOS).then(c => c.put(req.url, copia)); }
        return res;
      }))
    );
    return;
  }

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
