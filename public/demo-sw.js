// Demo Service Worker - Uses the Workbox files served with the demo
importScripts('./workbox/workbox-sw.js');
workbox.setConfig({ modulePathPrefix: './workbox/' });

// Load Weiwudi UMD module
importScripts('./weiwudi-sw.js');

// 開発用ページの殻（同じオリジンと Leaflet の配信元）をネットワーク優先で控え、オフラインでも再読み込みできるようにする。
// タイルは Weiwudi が捕捉する（この経路はタイルの配信元に当たらない）
workbox.routing.registerRoute(
    ({ url }) => url.origin === self.location.origin || url.hostname === 'unpkg.com',
    new workbox.strategies.NetworkFirst({ cacheName: 'weiwudi-demo-shell' }),
    'GET'
);
