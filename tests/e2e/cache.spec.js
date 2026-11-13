import { test, expect } from '@playwright/test';
import { PAGE_HOST } from './fixtures/page-origin.mjs';

// 地図の上流と workbox は手元のタイルサーバ（localhost:5174）。外のサーバへ出ないことを各試験の後で確かめる。
// weiwudi.example.com は旧 API の制御の擬似オリジンで、SW が応答する（外へは出ない）
const ALLOWED_HOSTS = [PAGE_HOST, 'localhost:5174', 'weiwudi.example.com'];

test.describe.serial('Weiwudi Cache Operations', () => {

    let external = [];

    test.afterEach(() => {
        expect(external).toEqual([]);
    });

    // Simple cleanup: just unregister SWs
    test.beforeEach(async ({ page, context }) => {
        external = [];
        context.on('request', (req) => {
            const url = new URL(req.url());
            if (/^https?:$/.test(url.protocol) && !ALLOWED_HOSTS.includes(url.host)) {
                external.push(`${req.method()} ${url.origin}${url.pathname}`);
            }
        });
        await page.goto('/tests/e2e/fixtures/blank.html');
        await page.evaluate(async () => {
            if ('serviceWorker' in navigator) {
                const registrations = await navigator.serviceWorker.getRegistrations();
                await Promise.all(registrations.map(reg => reg.unregister()));
            }
        });
    });

    test('should register Service Worker and activate successfully', async ({ page, context }) => {
        test.slow();

        // Debug logging
        page.on('console', msg => console.log(`BROWSER LOG: ${msg.text()}`));
        page.on('pageerror', err => console.log(`BROWSER ERROR: ${err.message}`));

        await context.grantPermissions(['notifications']);
        await page.goto('/tests/e2e/fixtures/test-page.html');

        // Wait for initialization
        await page.waitForFunction(() => window.weiwudiTest?.ready || window.weiwudiTest?.error, {
            timeout: 30000
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
        await page.waitForTimeout(2000); // Increased wait time

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

    test('should proxy tiles on first visit without reload', async ({ page, context }) => {
        await context.grantPermissions(['notifications']);
        await page.goto('/tests/e2e/fixtures/test-page.html');
        await page.waitForFunction(() => window.weiwudiTest?.ready || window.weiwudiTest?.error, {
            timeout: 30000
        });

        const error = await page.evaluate(() => window.weiwudiTest.error);
        expect(error).toBeNull();

        // reload されていないこと（初回ナビゲーションのまま）
        const loadCount = await page.evaluate(() => window.weiwudiTest.loadCount);
        expect(loadCount).toBe(1);

        // registerSW resolve 時点で controller を持つこと
        const hasController = await page.evaluate(() => navigator.serviceWorker.controller !== null);
        expect(hasController).toBe(true);

        // 最初のタイル API 要求がプロキシ経由で成功すること
        const tileUrl = await page.evaluate(() => {
            return window.weiwudiTest.map.url.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0');
        });
        const fetchResult = await page.evaluate(async (url) => {
            const resp = await fetch(url);
            return { ok: resp.ok, status: resp.status };
        }, tileUrl);
        expect(fetchResult.ok).toBe(true);

        // stats の count > 0（タイルがキャッシュされた）
        const stats = await page.evaluate(async () => {
            return await window.weiwudiTest.map.stats();
        });
        expect(stats.count).toBeGreaterThan(0);
    });

    test('should evict oldest tiles beyond capacity limit', async ({ page, context }) => {
        await context.grantPermissions(['notifications']);
        await page.goto('/tests/e2e/fixtures/test-page.html');
        await page.waitForFunction(() => window.weiwudiTest?.ready, { timeout: 10000 });

        const result = await page.evaluate(async () => {
            const Weiwudi = window.weiwudiTest.Weiwudi;
            // 固定 500 byte の data: URL をタイルソースに使う（外部依存なし）
            const tileData = 'data:application/octet-stream;base64,' + btoa('x'.repeat(500));
            const map = await Weiwudi.registerMap('capacity_map', {
                type: 'xyz',
                width: 512,
                height: 512,
                tileSize: 256,
                url: tileData,
                cacheMaxBytes: 1000
            });
            const fetchTile = async (x, y) => {
                const u = map.url.replace('{z}', '1').replace('{x}', String(x)).replace('{y}', String(y));
                await fetch(u);
            };
            await fetchTile(0, 0); // 500 bytes
            await fetchTile(1, 0); // 合計 1000 bytes
            await fetchTile(0, 1); // 1500 > 1000 → 最古 (1_0_0) を退避
            const stats = await map.stats();
            // 残ったタイルを公開の応答ヘッダ x-weiwudi-status で確かめる（内部の保存の形は公開の約束ではない。仕様 §13）。
            // hit は accessedAt を進めるだけで退避しない。退避された 1_0_0 は最後に見る（取り直しで別のタイルが退避される）
            const statusOf = async (x, y) => {
                const u = map.url.replace('{z}', '1').replace('{x}', String(x)).replace('{y}', String(y));
                const res = await fetch(u);
                await res.arrayBuffer();
                return res.headers.get('x-weiwudi-status');
            };
            const kept10 = await statusOf(1, 0);
            const kept01 = await statusOf(0, 1);
            const evicted00 = await statusOf(0, 0);
            return { count: stats.count, size: stats.size, kept10, kept01, evicted00 };
        });

        expect(result.count).toBe(2);
        expect(result.size).toBeLessThanOrEqual(1000);
        expect(result.kept10).toBe('hit');
        expect(result.kept01).toBe('hit');
        expect(result.evicted00).toBe('miss');
    });

    test('should deliver oversized tile without caching', async ({ page, context }) => {
        await context.grantPermissions(['notifications']);
        await page.goto('/tests/e2e/fixtures/test-page.html');
        await page.waitForFunction(() => window.weiwudiTest?.ready, { timeout: 10000 });

        const result = await page.evaluate(async () => {
            const Weiwudi = window.weiwudiTest.Weiwudi;
            const tileData = 'data:application/octet-stream;base64,' + btoa('x'.repeat(500));

            // case 1: cacheMaxBytes = 0 → 配信は成功し保存しない
            const map0 = await Weiwudi.registerMap('no_cache_map', {
                type: 'xyz', width: 512, height: 512, tileSize: 256,
                url: tileData, cacheMaxBytes: 0
            });
            let resp = await fetch(map0.url.replace('{z}', '1').replace('{x}', '0').replace('{y}', '0'));
            const ok0 = resp.ok;
            const stats0 = await map0.stats();

            // case 2: 単一 Blob が上限を超える → 配信は成功し保存しない
            const map2 = await Weiwudi.registerMap('small_limit_map', {
                type: 'xyz', width: 512, height: 512, tileSize: 256,
                url: tileData, cacheMaxBytes: 100
            });
            resp = await fetch(map2.url.replace('{z}', '1').replace('{x}', '0').replace('{y}', '0'));
            const ok2 = resp.ok;
            const stats2 = await map2.stats();

            return {
                ok0, count0: stats0.count, size0: stats0.size,
                ok2, count2: stats2.count, size2: stats2.size
            };
        });

        expect(result.ok0).toBe(true);
        expect(result.count0).toBe(0);
        expect(result.size0).toBe(0);
        expect(result.ok2).toBe(true);
        expect(result.count2).toBe(0);
        expect(result.size2).toBe(0);
    });

    test('should reject registerSW when page is out of scope', async ({ page }) => {
        await page.goto('/tests/e2e/fixtures/scope-out-page.html');
        await page.waitForFunction(() => window.scopeOutTest?.done, { timeout: 20000 });

        const error = await page.evaluate(() => window.scopeOutTest.error);
        expect(error).toBe('Error: Service worker did not control this page within 10000 ms');
    });
});
