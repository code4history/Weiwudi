/**
 * Service Worker entry point for cache v1
 */

import { WeiwudiServiceWorker } from './service-worker';
import { WeiwudiMigration } from './migration';

declare const self: ServiceWorkerGlobalScope;

const weiwudi = new WeiwudiServiceWorker();

// Run migration on install
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        // Run migration from v0 to v1
        const migration = new WeiwudiMigration();
        await migration.migrate();
        
        // Initialize Weiwudi
        await weiwudi.init();
        
        // Skip waiting to activate immediately
        await self.skipWaiting();
      } catch (error) {
        console.error('Failed to initialize Weiwudi:', error);
      }
    })()
  );
});

// Claim clients on activate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.clients.claim()
  );
});

// Handle fetch events
self.addEventListener('fetch', (event) => {
  // Only handle HTTP/HTTPS requests
  if (!event.request.url.startsWith('http')) {
    return;
  }
  
  // Handle the request through Weiwudi
  event.respondWith(
    weiwudi.handleRequest(event.request).then(response => {
      // Return cached response or fall back to network
      return response || fetch(event.request);
    }).catch((error) => {
      console.error('Weiwudi fetch error:', error);
      return fetch(event.request);
    })
  );
});

// Handle messages from clients
self.addEventListener('message', async (event) => {
  const { type } = event.data;
  
  try {
    switch (type) {
      case 'register':
        // Register URLs from client
        // This would need implementation
        break;
        
      case 'unregister':
        // Unregister URLs from client
        // This would need implementation
        break;
        
      case 'clean':
        // Clean cache
        // This would need implementation
        break;
        
      default:
        console.warn('Unknown message type:', type);
    }
  } catch (error) {
    console.error('Message handling error:', error);
    event.ports[0]?.postMessage({ error: (error as Error).message });
  }
});

// Export for TypeScript
export {};