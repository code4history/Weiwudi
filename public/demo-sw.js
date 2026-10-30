// Demo Service Worker - Uses the Workbox files served with the demo
importScripts('./workbox/workbox-sw.js');
workbox.setConfig({ modulePathPrefix: './workbox/' });

// Load Weiwudi UMD module
importScripts('./weiwudi-sw.js');
