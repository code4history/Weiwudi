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
importScripts("./example.js");

workbox.core.skipWaiting();

workbox.core.clientsClaim();

/**
 * The workboxSW.precacheAndRoute() method efficiently caches and responds to
 * requests for URLs in the manifest.
 * See https://goo.gl/S9QRab
 */
workbox.precaching.precacheAndRoute([{"revision":"10d1f1f6834156d70a494fd94e7aeafa","url":"example.js"},{"revision":"a7eae6db1bf89ff3497ea957e1da57ea","url":"index.html"}], {});
workbox.routing.registerRoute(/(?:maps\/.+\.json|pwa\/.+|pois\/.+\.json|apps\/.+\.json|tmbs\/.+_menu\.jpg|img\/.+\.(?:png|jpg))$/, new workbox.strategies.StaleWhileRevalidate({ "cacheName":"resourcesCache", plugins: [new workbox.expiration.ExpirationPlugin({ maxAgeSeconds: 86400, purgeOnQuotaError: false })] }), 'GET');
