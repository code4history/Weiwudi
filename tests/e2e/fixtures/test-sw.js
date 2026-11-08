// Test Service Worker - workbox はローカルの上流サーバ（tile-server.mjs）から読み、外へ出ない
importScripts('http://localhost:5174/workbox/workbox-sw.js');
workbox.setConfig({ modulePathPrefix: 'http://localhost:5174/workbox/' });

// Load Weiwudi UMD module (served from public/ at root)
importScripts('/weiwudi-sw.js');
