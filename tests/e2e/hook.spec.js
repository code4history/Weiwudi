import { test, expect } from '@playwright/test';

// 実 URL の捕捉（新 API）を実ブラウザで確かめる（m2-t9・仕様 §4）。外部へ出ない構成で、上流は tile-server.mjs
// （localhost:5174。ページは localhost:5173 なので別オリジン）。Chromium だけ（R14）
const UPSTREAM = 'http://localhost:5174';
const PAGE = '/tests/e2e/fixtures/hook-page.html';
const PSEUDO = 'weiwudi.example.com';

const tpl = (kind) => `${UPSTREAM}/${kind}/{z}/{x}/{y}.png`;
const at = (kind, z, x, y) => `${UPSTREAM}/${kind}/${z}/${x}/${y}.png`;

// 疑似ホストへの要求のうち、ネットワークへ出たものだけを数える（SW が受けたものはここに来ない。第 1 回 S15）
async function countPseudoHits(context) {
    const hits = [];
    await context.route(`**://${PSEUDO}/**`, (route) => {
        hits.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
        route.abort();
    });
    return hits;
}

async function openPage(page, query = '') {
    await page.goto(PAGE + query);
    await page.waitForFunction(() => window.swReady === true || window.swError, null, { timeout: 30000 });
    expect(await page.evaluate(() => window.swError ?? null)).toBeNull();
}

// 新 API で登録し、window.src に置く
async function register(page, spec) {
    const r = await page.evaluate(async (spec) => window.attempt(async () => {
        window.src = await window.Weiwudi.register(spec);
        return { id: window.src.id, warnings: window.src.warnings };
    }), spec);
    expect(r).toMatchObject({ ok: true });
    return r.value;
}

const getTile = (page, url) => page.evaluate((url) => window.tile(url), url);
const getImg = (page, url) => page.evaluate((url) => window.img(url), url);
const statsCount = (page) => page.evaluate(async () => (await window.src.stats()).count);

async function upstreamLog(request, path) {
    const res = await request.get(`${UPSTREAM}/__log`);
    return (await res.json()).filter((e) => e.path === path);
}

// CDP で SW を止める（offline.spec.js と同じ追い方）。戻り値の waitFor('running') で起き直しを待てる
async function stopServiceWorker(context, page) {
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
    await waitFor('stopped');
    return { waitFor };
}

test.describe('Weiwudi hook (real urls)', () => {
    // 上流の記録を試験ごとに空にする（workers: 1。CI の再試行で前の試行の記録を見ないため）
    test.beforeEach(async ({ request }) => {
        await request.get(`${UPSTREAM}/__log?reset=1`);
    });

    test('hooks a real cross-origin tile url after register', async ({ page }) => {
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('tiles') });
        const first = await getTile(page, at('tiles', 1, 0, 1));
        expect(first.status).toBe(200);
        expect(first.wstatus).toBe('miss');
        expect(first.text).toBe('tile:1/0/1');
        const second = await getTile(page, at('tiles', 1, 0, 1));
        expect(second.wstatus).toBe('hit');
        expect(second.text).toBe('tile:1/0/1');
    });

    test('sends control requests through the service worker', async ({ page, context }) => {
        const hits = await countPseudoHits(context);
        await openPage(page);
        const r = await page.evaluate(async (url) => window.attempt(async () => {
            const src = await window.Weiwudi.register({ kind: 'raster', url });
            const one = await window.Weiwudi.source(src.id);
            const all = await window.Weiwudi.sources();
            const stats = await src.stats();
            await src.update();
            await src.clean();
            await src.remove();
            return { id: one.id, n: all.length, count: stats.count, after: (await window.Weiwudi.sources()).length };
        }), tpl('tiles'));
        // 先に hits を見る（捕捉が外れると POST がネットワークへ出て、ここで落ちる）
        expect(hits).toEqual([]);
        expect(r).toMatchObject({ ok: true, value: { n: 1, count: 0, after: 0 } });
    });

    test('reads control responses from a cross-origin page', async ({ page, context }) => {
        // ページ（localhost:5173）から見て疑似ホストは別オリジン。SW が合成した制御の応答を読めるか（t8 の申し送り 2）
        const hits = await countPseudoHits(context);
        await openPage(page);
        const r = await page.evaluate(async (url) => {
            const ping = await fetch(`https://weiwudi.example.com/v2/ping`, { mode: 'cors', cache: 'no-store' });
            const post = await fetch(`https://weiwudi.example.com/v2/register`, {
                method: 'POST',
                mode: 'cors',
                cache: 'no-store',
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                body: JSON.stringify({ kind: 'raster', url }),
            });
            const bad = await fetch(`https://weiwudi.example.com/v2/nope`, { method: 'POST', mode: 'cors', body: '{}' });
            // 旧 API も同じ形（SW が合成する応答）
            const legacy = await fetch(`https://weiwudi.example.com/api/ping`, { mode: 'cors' });
            const shape = async (res) => ({
                status: res.status,
                type: res.type,
                contentType: res.headers.get('content-type'),
                body: await res.text(),
            });
            return { ping: await shape(ping), post: await shape(post), bad: await shape(bad), legacy: await shape(legacy) };
        }, tpl('tiles'));
        expect(hits).toEqual([]);
        expect(r.ping).toMatchObject({ status: 200, contentType: 'application/json' });
        expect(JSON.parse(r.ping.body)).toMatchObject({ api: 2 });
        expect(r.post).toMatchObject({ status: 200, contentType: 'application/json' });
        expect(JSON.parse(r.post.body)).toMatchObject({ ok: true, result: { kind: 'raster' } });
        expect(JSON.parse(r.bad.body)).toMatchObject({ ok: false, error: { code: 'api-not-found' } });
        expect(r.legacy).toMatchObject({ status: 200, body: 'Implemented' });
        // 合成した応答の type は、Chromium では basic・仕様上は cors もあり得る。読めることは上で見ている
        for (const t of [r.ping.type, r.post.type, r.bad.type, r.legacy.type]) expect(['basic', 'cors']).toContain(t);
    });

    test('re-verifies the new api after controllerchange', async ({ page, context }) => {
        const hits = await countPseudoHits(context);
        await openPage(page);
        const first = await page.evaluate(() => window.attempt(() => window.Weiwudi.sources()));
        expect(first).toMatchObject({ ok: true });
        // 新 API を持たない SW に替える（同じスコープに別のスクリプト。skipWaiting と claim で controllerchange が起きる）
        const swapped = await page.evaluate(() => new Promise((resolve, reject) => {
            const before = navigator.serviceWorker.controller;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                resolve(navigator.serviceWorker.controller !== before && navigator.serviceWorker.controller !== null);
            }, { once: true });
            navigator.serviceWorker.register('./hook-sw.js?mode=outdated', { scope: '/tests/e2e/fixtures/' }).catch(reject);
            setTimeout(() => reject(new Error('no controllerchange')), 10000);
        }));
        expect(swapped).toBe(true);
        // 前の controller で確かめた結果を使い回すと、POST が新 API を持たない SW を素通りしてネットワークへ出る
        const second = await page.evaluate(() => window.attempt(() => window.Weiwudi.sources()));
        expect(hits).toEqual([]);
        expect(second).toMatchObject({ ok: false, code: 'sw-outdated' });
    });

    test('hooks img requests in no-cors mode', async ({ page, request }) => {
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('png') });
        const img = await getImg(page, at('png', 2, 1, 2));
        expect(img.loaded).toBe(true);
        await expect.poll(() => statsCount(page)).toBe(1);
        // SW が組み替えた形（cors）で上流へ出た
        expect((await upstreamLog(request, '/png/2/1/2.png')).map((e) => e.mode)).toEqual(['cors']);
    });

    test('serves hooked tiles offline', async ({ page, context }) => {
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('tiles') });
        expect((await getTile(page, at('tiles', 2, 3, 1))).wstatus).toBe('miss');
        await context.setOffline(true);
        const tile = await getTile(page, at('tiles', 2, 3, 1));
        expect(tile.status).toBe(200);
        expect(tile.wstatus).toBe('hit');
        expect(tile.text).toBe('tile:2/3/1');
    });

    test('serves hooked tiles offline after the service worker restarted', async ({ page, context }) => {
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('tiles') });
        expect((await getTile(page, at('tiles', 2, 2, 3))).wstatus).toBe('miss');
        await context.setOffline(true);
        const sw = await stopServiceWorker(context, page);
        // 起き直した SW は照合表を持たない。最初の要求は門番が受ける
        const tile = await getTile(page, at('tiles', 2, 2, 3));
        expect(tile.status).toBe(200);
        expect(tile.wstatus).toBe('hit');
        expect(tile.text).toBe('tile:2/2/3');
        await sw.waitFor('running');
    });

    test('does not steal a consumer route while the table is loading', async ({ page, context }) => {
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('tiles') });
        await stopServiceWorker(context, page);
        const [consumer, tile] = await page.evaluate((url) => Promise.all([
            fetch('/precached/a.png').then((r) => r.json()),
            window.tile(url),
        ]), at('tiles', 2, 1, 3));
        expect(consumer).toMatchObject({ by: 'consumer', path: '/precached/a.png' });
        expect(tile.status).toBe(200);
        expect(tile.wstatus).toBe('miss');
    });

    test('passes through unregistered urls', async ({ page }) => {
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('tiles') });
        const res = await getTile(page, `${UPSTREAM}/__health`);
        expect(res.status).toBe(200);
        expect(res.text).toBe('weiwudi-e2e-tile-server');
        expect(res.wstatus).toBeNull();
    });

    test('delivers opaque without saving for cors-less servers', async ({ page, request }) => {
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('nocors') });
        const img = await getImg(page, at('nocors', 2, 0, 1));
        expect(img.loaded).toBe(true);
        // SW が受けた印: 組み替えた cors が失敗し、元の要求（no-cors）で取り直した
        expect((await upstreamLog(request, '/nocors/2/0/1.png')).map((e) => e.mode)).toEqual(['cors', 'no-cors']);
        expect(await statsCount(page)).toBe(0);
    });

    test('retries cors-less servers with no-cors even with header credentials (m3-t3 L1 M-1)', async ({ page, request }) => {
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('nocors'), credentials: { headers: { 'x-api-key': 'HKEY' } } });
        const img = await getImg(page, at('nocors', 2, 1, 1));
        // no-cors の取り直しが redirect: 'error' だと network error になり、画像が読めない
        expect(img.loaded).toBe(true);
        const modes = (await upstreamLog(request, '/nocors/2/1/1.png')).map((e) => e.mode);
        expect(modes[modes.length - 1]).toBe('no-cors');
        expect(await statsCount(page)).toBe(0);
    });

    test('keeps sparse cors servers cacheable', async ({ page }) => {
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('sparse') });
        expect((await getImg(page, at('sparse', 3, 1, 0))).loaded).toBe(true);
        await expect.poll(() => statsCount(page)).toBe(1);
        for (const x of [0, 2, 4]) {
            expect((await getImg(page, at('sparse', 3, x, 0))).loaded).toBe(false);
        }
        expect((await getImg(page, at('sparse', 3, 3, 0))).loaded).toBe(true);
        await expect.poll(() => statsCount(page)).toBe(2);
    });

    test('retries no-cors 401 with the original request', async ({ page, context, request }) => {
        await context.addCookies([{ name: 'weiwudi', value: '1', domain: 'localhost', path: '/' }]);
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('auth') });
        const img = await getImg(page, at('auth', 2, 2, 2));
        expect(img.loaded).toBe(true);
        // 組み替えた形は別オリジンへ Cookie を送らず 401、元の要求（no-cors・Cookie つき）で取り直した
        const log = await upstreamLog(request, '/auth/2/2/2.png');
        expect(log.map((e) => [e.mode, e.cookie])).toEqual([['cors', false], ['no-cors', true]]);
        expect(await statsCount(page)).toBe(0);
    });

    test('does not store text/html tiles', async ({ page }) => {
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('html') });
        const res = await getTile(page, at('html', 2, 1, 1));
        expect(res.status).toBe(200);
        expect(res.type).toBe('text/html');
        expect(res.wstatus).toBe('upstream-error');
        expect(res.text).toContain('login');
        expect(await statsCount(page)).toBe(0);
    });

    test('serves transparent png out of range', async ({ page, request }) => {
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('png'), bounds: [139, 35, 140, 36], minZoom: 0, maxZoom: 4 });
        const res = await getTile(page, at('png', 2, 0, 0));
        expect(res.status).toBe(200);
        expect(res.type).toBe('image/png');
        expect(res.wstatus).toBe('out-of-range');
        expect(res.head).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(await upstreamLog(request, '/png/2/0/0.png')).toEqual([]);
    });

    test('rejects with sw-not-controlling outside the scope', async ({ page, context }) => {
        const hits = await countPseudoHits(context);
        await openPage(page, '?scope=out');
        const r = await page.evaluate(async (url) => ({
            controlled: navigator.serviceWorker.controller !== null,
            result: await window.attempt(() => window.Weiwudi.register({ kind: 'raster', url })),
        }), tpl('tiles'));
        expect(r.controlled).toBe(false);
        expect(r.result).toMatchObject({ ok: false, code: 'sw-not-controlling' });
        expect(hits).toEqual([]);
    });

    test('exposes addPlugin on the umd global', async ({ page }) => {
        await openPage(page);
        const consumer = await page.evaluate(() => fetch('/precached/plugin').then((r) => r.json()));
        expect(consumer).toMatchObject({ by: 'consumer', addPlugin: 'function' });
    });
});
