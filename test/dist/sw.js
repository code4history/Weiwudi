/**
 * Welcome to your Workbox-powered service worker!
 *
 * You'll need to register this file in your web app and you should
 * disable HTTP caching for this file too.
 * See https://goo.gl/nhQhGp
 *
 * The rest of the code is auto-generated. Please don't update this file
 * directly; instead, make changes to your Workbox build configuration
 * and re-run your build process.
 * See https://goo.gl/2aRDsh
 */
importScripts("https://storage.googleapis.com/workbox-cdn/releases/5.1.4/workbox-sw.js");
importScripts("https://cdn.jsdelivr.net/npm/weiwudi@0.0.6/src/weiwudi_sw.js");
//importScripts("../../src/weiwudi_sw.js");

workbox.core.skipWaiting();

workbox.core.clientsClaim();

/**
 * The workboxSW.precacheAndRoute() method efficiently caches and responds to
 * requests for URLs in the manifest.
 * See https://goo.gl/S9QRab
 */
workbox.precaching.precacheAndRoute([{"revision":"aad3e5790a2fdd54fcae5e4bacc7b4bf","url":"index.js"},{"revision":"ed68dd0d2ba66aff280ecbf39ced2ba5","url":"index.html"}], {});
workbox.routing.registerRoute(/(?:maps\/.+\.json|pwa\/.+|pois\/.+\.json|apps\/.+\.json|tmbs\/.+_menu\.jpg|img\/.+\.(?:png|jpg))$/, new workbox.strategies.StaleWhileRevalidate({ "cacheName":"resourcesCache", plugins: [new workbox.expiration.ExpirationPlugin({ maxAgeSeconds: 86400, purgeOnQuotaError: false })] }), 'GET');