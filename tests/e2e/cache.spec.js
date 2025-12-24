import { test, expect } from '@playwright/test';

test.describe('Weiwudi Cache Operations', () => {

    test('should register Service Worker and activate successfully', async ({ page, context }) => {
        await context.grantPermissions(['notifications']);

        await page.goto('/tests/e2e/fixtures/test-page.html');

        // Wait for initialization
        await page.waitForFunction(() => window.weiwudiTest?.ready || window.weiwudiTest?.error, {
            timeout: 10000
        });

        // Check for errors
        const error = await page.evaluate(() => window.weiwudiTest.error);
        expect(error).toBeNull();

        // Verify SW is activated
        const swState = await page.evaluate(async () => {
            const reg = await navigator.serviceWorker.getRegistration();
            return reg?.active?.state;
        });

        expect(swState).toBe('activated');
    });

    test('should cache tile requests', async ({ page, context }) => {
        await context.grantPermissions(['notifications']);

        await page.goto('/tests/e2e/fixtures/test-page.html');

        await page.waitForFunction(() => window.weiwudiTest?.ready, { timeout: 10000 });

        // Fetch a tile to trigger caching
        const tileUrl = await page.evaluate(() => {
            return window.weiwudiTest.map.url.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0');
        });

        // Make a request to the tile
        await page.evaluate(async (url) => {
            await fetch(url);
        }, tileUrl);

        // Wait a bit for caching
        await page.waitForTimeout(1000);

        // Check cache stats
        const stats = await page.evaluate(async () => {
            return await window.weiwudiTest.map.stats();
        });

        expect(stats.count).toBeGreaterThan(0);
    });

    test('should retrieve cache statistics', async ({ page, context }) => {
        await context.grantPermissions(['notifications']);

        await page.goto('/tests/e2e/fixtures/test-page.html');

        await page.waitForFunction(() => window.weiwudiTest?.ready, { timeout: 10000 });

        const stats = await page.evaluate(async () => {
            return await window.weiwudiTest.map.stats();
        });

        expect(stats).toBeDefined();
        expect(stats).toHaveProperty('count');
        expect(stats).toHaveProperty('size');
    });

    test('should clear cached tiles', async ({ page, context }) => {
        await context.grantPermissions(['notifications']);

        await page.goto('/tests/e2e/fixtures/test-page.html');

        await page.waitForFunction(() => window.weiwudiTest?.ready, { timeout: 10000 });

        // Cache a tile first
        const tileUrl = await page.evaluate(() => {
            return window.weiwudiTest.map.url.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0');
        });

        await page.evaluate(async (url) => {
            await fetch(url);
        }, tileUrl);

        await page.waitForTimeout(1000);

        // Clear cache
        await page.evaluate(async () => {
            await window.weiwudiTest.map.clean();
        });

        await page.waitForTimeout(500);

        // Verify cache is empty
        const statsAfterClear = await page.evaluate(async () => {
            return await window.weiwudiTest.map.stats();
        });

        expect(statsAfterClear.count).toBe(0);
    });
});
