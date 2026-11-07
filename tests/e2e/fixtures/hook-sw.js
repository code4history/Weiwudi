// 実 URL の捕捉の e2e（m2-t9）の Service Worker。offline-sw.js と同じく workbox はローカルの上流サーバから読む。
// - 既定: /weiwudi-sw.js を読み、その後で同期に利用者のルート（/precached/）を登録する（門番より前に評価される）
// - ?mode=outdated: Weiwudi の新 API を持たない古い SW の代わり（/v2/ping は 404・POST は受けない）。
//   controllerchange の後に確かめ直すことを見る試験が使う
importScripts('http://localhost:5174/workbox/workbox-sw.js');
workbox.setConfig({ modulePathPrefix: 'http://localhost:5174/workbox/' });

const mode = new URL(self.location.href).searchParams.get('mode');

if (mode === 'outdated') {
    self.addEventListener('install', (event) => {
        event.waitUntil(self.skipWaiting());
    });
    self.addEventListener('activate', (event) => {
        event.waitUntil(self.clients.claim());
    });
    workbox.routing.registerRoute(
        /^https?:\/\/weiwudi\.example\.com\//,
        () => new Response('Not Found', { status: 404 }),
        'GET'
    );
} else {
    importScripts('/weiwudi-sw.js');
    // UMD の大域に差し込み口があるか（exposes addPlugin on the umd global）
    const addPluginType = typeof self.Weiwudi_SW?.addPlugin;
    workbox.routing.registerRoute(/\/precached\//, ({ url }) => new Response(
        JSON.stringify({ by: 'consumer', path: url.pathname, addPlugin: addPluginType }),
        { headers: { 'content-type': 'application/json' } }
    ));
}
