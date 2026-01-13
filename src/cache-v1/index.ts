/**
 * Client-side entry point for Weiwudi cache v1
 */

import { WeiwudiClient } from './client';

// Global instance
let globalWeiwudi: WeiwudiClient | null = null;

/**
 * Register and initialize Service Worker
 */
export async function register(swPath = '/weiwudi-sw.js'): Promise<WeiwudiClient> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service Worker not supported');
  }

  try {
    const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
    const useModule = isDev && swPath === '/weiwudi-sw.js';
    const resolvedSwPath = useModule ? '/weiwudi-sw-dev.js' : swPath;

    // Register Service Worker
    const registration = await navigator.serviceWorker.register(resolvedSwPath, {
      scope: '/',
      ...(useModule ? { type: 'module' } : {})
    });

    // Wait for Service Worker to be ready
    let sw = registration.active;
    
    if (!sw) {
      // Wait for activation
      await new Promise<void>((resolve) => {
        const checkState = () => {
          sw = registration.installing || registration.waiting || registration.active;
          
          if (sw?.state === 'activated') {
            resolve();
          } else if (sw) {
            sw.addEventListener('statechange', () => {
              if (sw?.state === 'activated') {
                resolve();
              }
            });
          }
        };
        
        checkState();
      });
    }

    // Initialize Weiwudi client
    if (!globalWeiwudi) {
      globalWeiwudi = new WeiwudiClient();
      await globalWeiwudi.init();
    }

    return globalWeiwudi;
  } catch (error) {
    console.error('Failed to register Weiwudi:', error);
    throw error;
  }
}

/**
 * Get global Weiwudi instance
 */
export function getWeiwudi(): WeiwudiClient {
  if (!globalWeiwudi) {
    throw new Error('Weiwudi not initialized. Call register() first.');
  }
  return globalWeiwudi;
}

// Re-export types
export * from './types';
export { WeiwudiClient } from './client';
