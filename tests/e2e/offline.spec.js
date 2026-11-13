import { test, expect } from '@playwright/test';
import { PAGE_HOST } from './fixtures/page-origin.mjs';

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

// 外へ出た要求を数える（range.spec.js と同じ。C-O8）。localhost:5173・5174 以外と疑似ホストへ出たものが 0 件であることを
// 試験の最後に確かめる（この describe は Chromium だけ）
async function guardNetwork(context) {
    const external = [];
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if ([PAGE_HOST, 'localhost:5174'].includes(url.host)) return route.continue();
        external.push(`${route.request().method()} ${url.origin}${url.pathname}`);
        return route.abort();
    });
    const pseudo = [];
    await context.route('**://weiwudi.example.com/**', (route) => {
        pseudo.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
        return route.abort();
    });
    return { external, pseudo };
}

function expectNoLeaks(guard) {
    expect(guard.external).toEqual([]);
    expect(guard.pseudo).toEqual([]);
}

// どの試験も context.setOffline を使う。SW の fetch まで切るのは Chromium でだけ確かめた（仕様 §2 の 7。WebKit は
// ページの fetch が先に失敗し SW 到達を測れない）ので、WebKit・Firefox では走らせない（m3-t10）
test.describe('Weiwudi offline', { tag: '@chromium-only' }, () => {

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

    test('serves a stale tile offline after cacheTtl', async ({ page, context, request }) => {
        await openPage(page, { cacheTtl: 1 });
        const online = await getTile(page, 2, 0, 1);
        expect(online.status).toBe(200);
        await page.waitForTimeout(10);
        // 期限切れなら上流へ取りに行く（受信 +1）ことをオンラインで確かめてから、オフラインで同じ経路を通す
        const before = await upstreamCount(request);
        const refetched = await getTile(page, 2, 0, 1);
        expect(refetched.status).toBe(200);
        expect(await upstreamCount(request)).toBe(before + 1);
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
        const guard = await guardNetwork(context);
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
        // 旧 API の地図も usage() に入る（m4-t10）
        const report = await page.evaluate(() => window.Weiwudi.usage());
        expect(report.count).toBe(21);
        expectNoLeaks(guard);
    });

    test('serves a cached tile after the service worker restarted offline', async ({ page, context }) => {
        await openPage(page);
        const online = await getTile(page, 2, 0, 0);
        expect(online.status).toBe(200);
        await context.setOffline(true);
        // SW の runningStatus を CDP の workerVersionUpdated で追い、止まったことと起き直したことを確かめる
        const cdp = await context.newCDPSession(page);
        let status;
        const waiters = [];
        cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
            const active = versions.find((v) => v.status === 'activated') ?? versions[0];
            if (!active) return;
            status = active.runningStatus;
            for (const w of waiters.splice(0)) {
                if (w.want === status) w.resolve();
                else waiters.push(w);
            }
        });
        const waitFor = (want) => new Promise((resolve, reject) => {
            if (status === want) return resolve();
            const timer = setTimeout(() => reject(new Error(`runningStatus stayed ${status}, want ${want}`)), 10000);
            waiters.push({ want, resolve: () => { clearTimeout(timer); resolve(); } });
        });
        await cdp.send('ServiceWorker.enable');
        await waitFor('running');
        await cdp.send('ServiceWorker.stopAllWorkers');
        // stopped は stopAllWorkers の返りより数 ms 遅れて届くので、待ってから取る
        await waitFor('stopped');
        const tile = await getTile(page, 2, 0, 0);
        expect(tile.status).toBe(200);
        expect(tile.text).toBe('tile:2/0/0');
        await waitFor('running');
        expect(status).toBe('running');
    });

    test('keeps the client api working offline', async ({ page, context }) => {
        await openPage(page);
        const online = await getTile(page, 2, 0, 0);
        expect(online.status).toBe(200);
        await context.setOffline(true);
        const result = await page.evaluate(async () => {
            const first = await window.map.stats();
            await window.map.clean();
            const second = await window.map.stats();
            return { first, second };
        });
        expect(result.first.count).toBe(1);
        expect(result.second.count).toBe(0);
    });
});
