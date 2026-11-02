import { test, expect } from '@playwright/test';

// オフライン時の挙動を、外部へ出ない構成（ローカルの上流サーバ・ローカルの workbox）で確かめる（#32）
const UPSTREAM = 'http://localhost:5174';
const TILE_URL = `${UPSTREAM}/tiles/{z}/{x}/{y}.png`;
const PAGE = '/tests/e2e/fixtures/offline-page.html';

async function openPage(page, extra = {}) {
    await page.goto(PAGE);
    await page.waitForFunction(() => window.swReady === true || window.swError, null, { timeout: 30000 });
    const error = await page.evaluate(() => window.swError ?? null);
    expect(error).toBeNull();
    await page.evaluate(async ({ url, extra }) => {
        window.map = await window.Weiwudi.registerMap('offline_map', {
            type: 'xyz',
            width: 1024,
            height: 1024,
            url,
            ...extra
        });
    }, { url: TILE_URL, extra });
}

// SW を経由してタイルを取り、状態・型・本体・先頭 8 バイトを返す
function getTile(page, z, x, y) {
    return page.evaluate(async ([z, x, y]) => {
        const url = window.map.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        const res = await fetch(url);
        const buf = new Uint8Array(await res.arrayBuffer());
        return {
            status: res.status,
            type: res.headers.get('content-type'),
            text: new TextDecoder().decode(buf),
            head: Array.from(buf.slice(0, 8))
        };
    }, [z, x, y]);
}

async function upstreamCount(request) {
    const res = await request.get(`${UPSTREAM}/__requests`);
    return (await res.json()).count;
}

test.describe('Weiwudi offline', () => {

    test('setOffline cuts the service worker network', async ({ page, context, request }) => {
        await openPage(page);
        const before = await upstreamCount(request);
        await context.setOffline(true);
        const tile = await getTile(page, 2, 1, 1);
        expect(tile.status).toBe(404);
        expect(await upstreamCount(request)).toBe(before);
    });

    test('serves a cached tile offline', async ({ page, context }) => {
        await openPage(page);
        const online = await getTile(page, 2, 0, 0);
        expect(online.status).toBe(200);
        await context.setOffline(true);
        const tile = await getTile(page, 2, 0, 0);
        expect(tile.status).toBe(200);
        expect(tile.text).toBe('tile:2/0/0');
    });

    test('returns 404 for an uncached tile offline', async ({ page, context }) => {
        await openPage(page);
        await context.setOffline(true);
        const tile = await getTile(page, 2, 3, 3);
        expect(tile.status).toBe(404);
    });

    test('serves a stale tile offline after cacheTtl', async ({ page, context }) => {
        await openPage(page, { cacheTtl: 1 });
        const online = await getTile(page, 2, 0, 1);
        expect(online.status).toBe(200);
        await page.waitForTimeout(10);
        await context.setOffline(true);
        const tile = await getTile(page, 2, 0, 1);
        expect(tile.status).toBe(200);
        expect(tile.text).toBe('tile:2/0/1');
    });

    test('serves transparent png out of extent offline', async ({ page, context }) => {
        await openPage(page);
        await context.setOffline(true);
        const tile = await getTile(page, 2, 4, 0);
        expect(tile.status).toBe(200);
        expect(tile.type).toBe('image/png');
        expect(tile.head).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    });

    test('returns 404 out of zoom offline', async ({ page, context }) => {
        await openPage(page);
        await context.setOffline(true);
        const tile = await getTile(page, 3, 0, 0);
        expect(tile.status).toBe(404);
    });

    test('serves every tile offline after fetchAll', async ({ page, context }) => {
        test.slow();
        await openPage(page);
        await page.evaluate(() => new Promise((resolve, reject) => {
            window.map.addEventListener('finish', () => resolve());
            window.map.addEventListener('stop', (e) => reject(new Error(JSON.stringify(e.detail))));
            window.map.fetchAll().catch(reject);
        }));
        await context.setOffline(true);
        const coords = [];
        for (let z = 0; z <= 2; z++) {
            const n = 2 ** z;
            for (let x = 0; x < n; x++) {
                for (let y = 0; y < n; y++) coords.push([z, x, y]);
            }
        }
        expect(coords.length).toBe(21);
        for (const [z, x, y] of coords) {
            const tile = await getTile(page, z, x, y);
            expect(tile.status, `${z}/${x}/${y}`).toBe(200);
            expect(tile.text).toBe(`tile:${z}/${x}/${y}`);
        }
        const stats = await page.evaluate(() => window.map.stats());
        expect(stats.count).toBe(21);
        expect(stats.percent).toBe(100);
    });

    test('serves a cached tile after the service worker restarted offline', async ({ page, context }) => {
        await openPage(page);
        const online = await getTile(page, 2, 0, 0);
        expect(online.status).toBe(200);
        await context.setOffline(true);
        const cdp = await context.newCDPSession(page);
        await cdp.send('ServiceWorker.enable');
        await cdp.send('ServiceWorker.stopAllWorkers');
        const tile = await getTile(page, 2, 0, 0);
        expect(tile.status).toBe(200);
        expect(tile.text).toBe('tile:2/0/0');
    });

    test('keeps the client api working offline', async ({ page, context }) => {
        await openPage(page);
        await context.setOffline(true);
        const result = await page.evaluate(async () => {
            const first = await window.map.stats();
            await window.map.clean();
            const second = await window.map.stats();
            return { first, second };
        });
        expect(result.first).toHaveProperty('count');
        expect(result.second.count).toBe(0);
    });
});
