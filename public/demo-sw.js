// Demo Service Worker - Uses the Workbox files served with the demo
importScripts('./workbox/workbox-sw.js');
workbox.setConfig({ modulePathPrefix: './workbox/' });

// Load Weiwudi UMD module
importScripts('./weiwudi-sw.js');

// 開発用ページの殻（同じオリジンと Leaflet の配信元）をネットワーク優先で控え、オフラインでも再読み込みできるようにする。
// ページと script・style だけを取る（同じオリジンのタイルを照合表の読み込み中に門番より先に取らない）
workbox.routing.registerRoute(
    ({ url, request }) =>
        (url.origin === self.location.origin || url.hostname === 'unpkg.com') &&
        (request.mode === 'navigate' || request.destination === 'script' || request.destination === 'style'),
    new workbox.strategies.NetworkFirst({ cacheName: 'weiwudi-demo-shell' }),
    'GET'
);
