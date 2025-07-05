// Weiwudi Service Worker entry point
// In development, this loads the source directly
// In production, this will be replaced with the built version

if (location.hostname === 'localhost') {
  // Development mode - load from source
  importScripts('/dist/weiwudi-sw.js');
} else {
  // Production mode
  importScripts('/dist/weiwudi-sw.js');
}