const CACHE_NAME = 'straw-v3';

// install時にプリキャッシュするのはHTMLと最低限のシェルのみ。
// CSS/JSはクエリ文字列付きURLで要求されるため、動的なnetwork-firstキャッシュに任せる。
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        }
        return response;
      })
      .catch(() =>
        // オフライン時: まず完全一致、次にクエリ文字列を無視して検索
        caches.match(event.request).then(
          (hit) => hit || caches.match(event.request, { ignoreSearch: true })
        )
      )
  );
});
