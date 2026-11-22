// 밑줄서재 서비스워커 — 업데이트할 때마다 VERSION을 올려주세요
const VERSION = 'mitjul-v41';
const SHELL = [
  './', './index.html', './style.css', './manifest.webmanifest',
  './js/app.js', './js/db.js', './js/bookapi.js', './js/scanner.js', './js/ocr.js', './js/graph.js', './js/shelf3d.js', './js/peopletext.js',
  './icons/icon-192.png', './icons/icon-512.png',
];
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
const NO_CACHE = /^https:\/\/(www\.googleapis\.com|dapi\.kakao\.com)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || NO_CACHE.test(req.url)) return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // 앱 파일: 네트워크 우선, 오프라인이면 캐시
    // cache:'no-cache' → GitHub Pages의 10분 HTTP 캐시를 건너뛰고 항상 새 파일 확인
    e.respondWith(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))));
  } else if (CDN.test(req.url)) {
    // 라이브러리·폰트: 캐시 우선, 뒤에서 갱신
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
