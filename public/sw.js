self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open('zgledaj-store').then((cache) => cache.addAll([
      '/',
      '/index.html',
      '/zg-icon.png',
    ])),
  );
});

self.addEventListener('fetch', (e) => {
  console.log(e.request.url);
  e.respondWith(
    caches.match(e.request).then((response) => response || fetch(e.request)),
  );
});