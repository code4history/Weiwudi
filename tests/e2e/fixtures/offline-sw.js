// 外部へ出ない Service Worker（#32）。workbox はローカルの上流サーバ（tile-server.mjs）から読む
importScripts('http://localhost:5174/workbox/workbox-sw.js');
workbox.setConfig({ modulePathPrefix: 'http://localhost:5174/workbox/' });
importScripts('/weiwudi-sw.js');
