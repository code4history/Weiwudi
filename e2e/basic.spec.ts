import { test, expect } from '@playwright/test';

test.describe('Weiwudi Basic Tests', () => {
  test('should register service worker', async ({ page }) => {
    // Create test page
    await page.goto('/e2e-test.html');
    
    // Register Weiwudi
    const result = await page.evaluate(async () => {
      const { register } = await import('/src/cache-v1/index.ts');
      const weiwudi = await register('/weiwudi-sw.js');
      return weiwudi !== null;
    });
    
    expect(result).toBe(true);
    
    // Check service worker is active
    const swState = await page.evaluate(() => {
      return navigator.serviceWorker.controller?.state;
    });
    
    expect(swState).toBe('activated');
  });

  test('should register and cache resources', async ({ page }) => {
    await page.goto('/e2e-test.html');
    
    // Register and cache a style
    const registered = await page.evaluate(async () => {
      const { register } = await import('/src/cache-v1/index.ts');
      const weiwudi = await register('/weiwudi-sw.js');
      
      await weiwudi.register({
        url: 'https://api.mapbox.com/styles/v1/mapbox/streets-v11/style.json',
        options: {
          autoRegisterAssets: false
        }
      });
      
      return weiwudi.isManaged('https://api.mapbox.com/styles/v1/mapbox/streets-v11/style.json');
    });
    
    expect(registered).toBe(true);
  });

  test('should support quota management', async ({ page }) => {
    await page.goto('/e2e-test.html');
    
    const usage = await page.evaluate(async () => {
      const { register } = await import('/src/cache-v1/index.ts');
      const weiwudi = await register('/weiwudi-sw.js');
      
      // Set quota
      await weiwudi.setQuota({
        maxCacheSize: 100 * 1024 * 1024 // 100MB
      });
      
      // Get usage
      return await weiwudi.getStorageUsage();
    });
    
    expect(usage.quota).toBe(100 * 1024 * 1024);
    expect(usage.used).toBeGreaterThanOrEqual(0);
    expect(usage.percentage).toBeGreaterThanOrEqual(0);
  });
});