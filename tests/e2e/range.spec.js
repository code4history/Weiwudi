import { test, expect } from '@playwright/test';

// 範囲取得・解放・全体上限を実ブラウザで確かめる（m4-t10・仕様 §7.2・§12）。外部へ出ない構成で、上流は tile-server.mjs
// （localhost:5174。ページは localhost:5173 で別オリジン）。WebKit・Firefox でも走らせる（R14'）。Chromium だけで成り立つ
// ものは @chromium-only で外し、理由をその試験に書く。上流の受信数は tile-server の記録で数える（Playwright の
// context.on('request') はページの要求と SW の要求を両方数える。t9 の申し送り）
const UPSTREAM = 'http://localhost:5174';
const PAGE = '/tests/e2e/fixtures/range-page.html';
const PSEUDO = 'weiwudi.example.com';
const ALLOWED_HOSTS = ['localhost:5173', 'localhost:5174'];

const tpl = (kind) => `${UPSTREAM}/${kind}/{z}/{x}/{y}.png`;
const at = (kind, z, x, y) => `${UPSTREAM}/${kind}/${z}/${x}/${y}.png`;
const WORLD = [-180, -85, 180, 85];
// z0〜2 の全タイル（21 枚）
const coordsUpTo = (maxZoom) => {
    const out = [];
    for (let z = 0; z <= maxZoom; z++) {
        const n = 2 ** z;
        for (let x = 0; x < n; x++) {
            for (let y = 0; y < n; y++) out.push([z, x, y]);
        }
    }
    return out;
};

const STYLE_URL = `${UPSTREAM}/style/basic.json`;
const TILEJSON_URL = `${UPSTREAM}/style/tiles.json`;
const FONTSTACK = 'Open Sans Regular,Arial Unicode MS Regular';

// 外へ出た要求を数える（style.spec.js と同じ。C-O8）。数えるのは Chromium だけ（WebKit の context.route は SW の要求を
// 拾わない。O-N5）。ほかのエンジンでは route を置かず、空の並びを返す
async function guardNetwork(context) {
    const external = [];
    if (test.info().project.name !== 'chromium') return { external, pseudo: [] };
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (ALLOWED_HOSTS.includes(url.host)) return route.continue();
        external.push(`${route.request().method()} ${url.origin}${url.pathname}`);
        return route.abort();
    });
    const pseudo = [];
    await context.route(`**://${PSEUDO}/**`, (route) => {
        pseudo.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
        return route.abort();
    });
    return { external, pseudo };
}

// 各テストの最後に呼ぶ。どちらも 0 件
function expectNoLeaks(guard) {
    expect(guard.external).toEqual([]);
    expect(guard.pseudo).toEqual([]);
}

async function openPage(page) {
    await page.goto(PAGE);
    await page.waitForFunction(() => window.swReady === true || window.swError, null, { timeout: 30000 });
    expect(await page.evaluate(() => window.swError ?? null)).toBeNull();
}

// 新 API で登録し、window[name] に置く（イベントは window.events に積む）
async function register(page, spec, name = 'src') {
    const r = await page.evaluate(async ({ spec, name }) => window.attempt(async () => {
        const src = await window.Weiwudi.register(spec);
        window[name] = src;
        window.track(src);
        return { id: src.id, resources: src.resources, warnings: src.warnings };
    }), { spec, name });
    expect(r).toMatchObject({ ok: true });
    return r.value;
}

const fetchRange = (page, range, opts = {}, name = 'src') =>
    page.evaluate(({ range, opts, name }) => window.attempt(() => window[name].fetchRange(range, opts)), { range, opts, name });
const call = (page, method, args = [], name = 'src') =>
    page.evaluate(({ method, args, name }) => window.attempt(() => window[name][method](...args)), { method, args, name });
const getTile = (page, url) => page.evaluate((url) => window.tile(url), url);
const usage = (page) => page.evaluate(() => window.Weiwudi.usage());
const eventsOf = (page, type) => page.evaluate((type) => window.events.filter((e) => e.type === type).map((e) => e.detail), type);

async function upstreamLog(request, prefix) {
    const res = await request.get(`${UPSTREAM}/__log`);
    return (await res.json()).filter((e) => e.path.startsWith(prefix));
}

// CDP で SW の runningStatus を追う（offline.spec.js・hook.spec.js と同じ追い方）
async function trackServiceWorker(context, page) {
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
    return { cdp, waitFor };
}

test.describe('Weiwudi range (fetchRange・releaseRange・setLimits)', () => {
    test.beforeEach(async ({ request }) => {
        await request.get(`${UPSTREAM}/__log?reset=1`);
    });

    // context.setOffline が SW の fetch まで切るのは Chromium でだけ確かめた（仕様 §2 の 7）
    test('fetches a range and serves it offline', { tag: '@chromium-only' }, async ({ page, context, request }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('tiles'), bounds: WORLD, minZoom: 0, maxZoom: 2 });
        const range = { bounds: WORLD, minZoom: 0, maxZoom: 2 };
        expect(await call(page, 'estimate', [range])).toEqual({ ok: true, value: { tiles: 21 } });
        const before = (await (await request.get(`${UPSTREAM}/__requests`)).json()).count;
        const r = await fetchRange(page, range);
        expect(r).toMatchObject({ ok: true, value: { status: 'complete', pinned: true, total: 21, error: 0 } });
        const finish = await eventsOf(page, 'finish');
        expect(finish).toHaveLength(1);
        expect(finish[0]).toMatchObject({ regionId: r.value.id, percent: 100, total: 21, error: 0 });
        // 上流へは 21 枚が 1 回ずつ
        expect((await (await request.get(`${UPSTREAM}/__requests`)).json()).count).toBe(before + 21);
        await context.setOffline(true);
        for (const [z, x, y] of coordsUpTo(2)) {
            const res = await getTile(page, at('tiles', z, x, y));
            expect(res.status, `${z}/${x}/${y}`).toBe(200);
            expect(res.wstatus, `${z}/${x}/${y}`).toBe('hit');
            expect(res.text).toBe(`tile:${z}/${x}/${y}`);
        }
        const stats = await call(page, 'stats');
        expect(stats.value).toMatchObject({ count: 21, total: 21, percent: 100 });
        const regions = await call(page, 'regions');
        expect(regions.value).toHaveLength(1);
        expect(regions.value[0]).toMatchObject({ id: r.value.id, status: 'complete', pinned: true, total: 21 });
        expectNoLeaks(guard);
    });

    test('pins fetched tiles against cacheMaxBytes', async ({ page, context }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        // 本体は `tile:z/x/y`（10〜12 byte）。固定の 5 枚（約 50 byte）は上限に届かず、通常の取得の 30 枚は上限を超える
        const LIMIT = 200;
        const src = await register(page, { kind: 'raster', url: tpl('tiles'), cacheMaxBytes: LIMIT });
        const rid = src.resources[0].id;
        const r = await fetchRange(page, { box: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, minZoom: 0, maxZoom: 1 });
        expect(r).toMatchObject({ ok: true, value: { status: 'complete', pinned: true, total: 5 } });
        let fetched = 0;
        for (let x = 0; x < 6; x++) {
            for (let y = 0; y < 5; y++) {
                const res = await getTile(page, at('tiles', 4, x, y));
                expect(res.status).toBe(200);
                fetched += res.size;
            }
        }
        expect(fetched).toBeGreaterThan(LIMIT);
        // 固定は消えない（byResource の count は固定の 5 枚以上）。通常の取得の分は上限まで退避される
        const stats = await call(page, 'stats');
        expect(stats.value.byResource[rid].count).toBeGreaterThanOrEqual(5);
        expect(stats.value.byResource[rid].count).toBeLessThan(5 + 30);
        for (const [z, x, y] of coordsUpTo(1)) {
            const res = await getTile(page, at('tiles', z, x, y));
            expect(res.wstatus, `${z}/${x}/${y}`).toBe('hit');
        }
        expectNoLeaks(guard);
    });

    test('releases a range and frees entries', async ({ page, context }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('tiles') });
        const range = { box: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, minZoom: 0, maxZoom: 1 };
        const r = await fetchRange(page, range);
        expect(r).toMatchObject({ ok: true, value: { status: 'complete', total: 5 } });
        expect((await call(page, 'stats')).value.count).toBe(5);
        expect(await call(page, 'releaseRange', [r.value.id])).toMatchObject({ ok: true });
        expect((await call(page, 'regions')).value).toEqual([]);
        expect((await call(page, 'stats')).value.count).toBe(0);
        expect((await getTile(page, at('tiles', 1, 0, 0))).wstatus).toBe('miss');
        // 解放した region の id は attribute-invalid
        expect(await call(page, 'releaseRange', [r.value.id])).toMatchObject({ ok: false, code: 'attribute-invalid' });
        // keep: true は固定だけを外し、本体を残す（t9 の申し送り）
        const kept = await fetchRange(page, range);
        expect(kept).toMatchObject({ ok: true, value: { status: 'complete' } });
        expect(await call(page, 'releaseRange', [kept.value.id, { keep: true }])).toMatchObject({ ok: true });
        expect((await call(page, 'regions')).value).toEqual([]);
        expect((await call(page, 'stats')).value.count).toBe(5);
        expect((await getTile(page, at('tiles', 1, 1, 1))).wstatus).toBe('hit');
        expectNoLeaks(guard);
    });

    test('keeps overlapping tiles on release', async ({ page, context }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('tiles') });
        // a: z0〜1 の 5 枚、b: z1 の x = 1 の 2 枚（a と重なる）
        const a = await fetchRange(page, { box: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, minZoom: 0, maxZoom: 1 });
        const b = await fetchRange(page, { box: { minX: 1, maxX: 1, minY: 0, maxY: 1 }, minZoom: 1, maxZoom: 1 });
        expect(a).toMatchObject({ ok: true, value: { status: 'complete', total: 5 } });
        expect(b).toMatchObject({ ok: true, value: { status: 'complete', total: 2 } });
        expect(await call(page, 'releaseRange', [a.value.id])).toMatchObject({ ok: true });
        const regions = (await call(page, 'regions')).value;
        expect(regions.map((x) => x.id)).toEqual([b.value.id]);
        expect((await call(page, 'stats')).value.count).toBe(2);
        // 重なりは残り、a だけの分は消える
        for (const [x, y] of [[1, 0], [1, 1]]) expect((await getTile(page, at('tiles', 1, x, y))).wstatus).toBe('hit');
        for (const [z, x, y] of [[0, 0, 0], [1, 0, 0], [1, 0, 1]]) {
            expect((await getTile(page, at('tiles', z, x, y))).wstatus, `${z}/${x}/${y}`).toBe('miss');
        }
        expectNoLeaks(guard);
    });

    // context.setOffline が SW の fetch まで切るのは Chromium でだけ確かめた（仕様 §2 の 7）
    test('fetches a style range with glyphs', { tag: '@chromium-only' }, async ({ page, context, request }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        await register(page, { kind: 'style', url: STYLE_URL });
        // スタイルの layers に text-font が無いので、fontstack は fonts で渡す
        const r = await fetchRange(page, { bounds: WORLD, minZoom: 0, maxZoom: 1 }, { fonts: [FONTSTACK] });
        expect(r).toMatchObject({ ok: true, value: { status: 'complete', pinned: true } });
        // タイルは TileJSON の vt と raster の 2 つ × 5 枚
        expect(r.value.total).toBe(10);
        // 既定の glyphRanges（common）の 5 範囲を取った
        const glyphs = await upstreamLog(request, `/style/fonts/${FONTSTACK}/`);
        expect(glyphs.map((e) => e.path.split('/').pop()).sort())
            .toEqual(['0-255.pbf', '12288-12543.pbf', '256-511.pbf', '65280-65535.pbf', '8192-8447.pbf']);
        await context.setOffline(true);
        const urls = [
            STYLE_URL, TILEJSON_URL, `${UPSTREAM}/style/tiles/1/1/0.pbf`, `${UPSTREAM}/style/raster/0/0/0.png`,
            `${UPSTREAM}/style/fonts/${FONTSTACK}/0-255.pbf`, `${UPSTREAM}/style/sprite@2x.json`,
        ];
        for (const url of urls) {
            const res = await getTile(page, url);
            expect(res.status, url).toBe(200);
            expect(res.wstatus, url).toBe('hit');
        }
        expect((await getTile(page, `${UPSTREAM}/style/fonts/${FONTSTACK}/0-255.pbf`)).text).toBe(`glyph:${FONTSTACK}:0-255`);
        expect(JSON.parse((await getTile(page, `${UPSTREAM}/style/sprite@2x.json`)).text).dot.pixelRatio).toBe(2);
        // 範囲の外のタイルは取っていない（オフラインであることの確かめ）
        expect((await getTile(page, `${UPSTREAM}/style/tiles/3/1/1.pbf`)).status).not.toBe(200);
        expectNoLeaks(guard);
    });

    // CDP の ServiceWorker.stopAllWorkers を使う
    test('resumes a job after the service worker restarts', { tag: '@chromium-only' }, async ({ page, context }) => {
        test.slow();
        const guard = await guardNetwork(context);
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('slow') });
        // ページが出した job/resume の POST（SW が受けるもの）を記録する
        const resumes = [];
        page.on('request', (req) => {
            if (req.method() === 'POST' && req.url().endsWith('/v2/job/resume')) resumes.push(Date.now());
        });
        const sw = await trackServiceWorker(context, page);
        // z0〜3 の 85 枚。1 枚 250 ms・5 並行で約 4 秒かかる
        await page.evaluate(() => window.startRange(window.src, { box: { minX: 0, maxX: 7, minY: 0, maxY: 7 }, minZoom: 0, maxZoom: 3 }));
        await page.waitForFunction(() => window.events.some((e) => e.type === 'proceed'), null, { timeout: 15000 });
        await sw.cdp.send('ServiceWorker.stopAllWorkers');
        await sw.waitFor('stopped');
        const stoppedAt = Date.now();
        expect(await page.evaluate(() => window.job.done)).toBe(false);
        // 偽のタイマは使わない。fetchRange の Promise が解決することで見る
        await page.waitForFunction(() => window.job.done, null, { timeout: 60000 });
        const result = await page.evaluate(() => window.job.result);
        expect(result).toMatchObject({ ok: true, value: { status: 'complete', total: 85, error: 0 } });
        // 止めてから 30 秒以内（最後の proceed から 30 秒。届くまでの遅れに 1 秒の余裕）に job/resume が出た
        expect(resumes.length).toBeGreaterThanOrEqual(1);
        expect(resumes[0] - stoppedAt).toBeLessThan(31000);
        expect(await eventsOf(page, 'finish')).toHaveLength(1);
        expect((await call(page, 'stats')).value.count).toBe(85);
        expectNoLeaks(guard);
    });

    test('reports an opaque event for a server without cors', async ({ page, context }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        const src = await register(page, { kind: 'raster', url: tpl('nocors') });
        const r = await fetchRange(page, { box: { minX: 0, maxX: 3, minY: 0, maxY: 3 }, minZoom: 0, maxZoom: 2 });
        expect(r).toMatchObject({ ok: false, code: 'opaque' });
        const stop = await eventsOf(page, 'stop');
        expect(stop).toHaveLength(1);
        expect(stop[0]).toMatchObject({ sourceId: src.id, code: 'opaque' });
        await expect.poll(() => eventsOf(page, 'opaque')).toEqual([
            expect.objectContaining({ type: 'opaque', sourceId: src.id, resourceId: src.resources[0].id }),
        ]);
        const regions = (await call(page, 'regions')).value;
        expect(regions).toHaveLength(1);
        expect(regions[0]).toMatchObject({ status: 'stopped', code: 'opaque' });
        expectNoLeaks(guard);
    });

    test('enforces a global limit', async ({ page, context }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        const LIMIT = 60;
        expect(await page.evaluate((maxBytes) => window.attempt(() => window.Weiwudi.setLimits({ maxBytes })), LIMIT))
            .toMatchObject({ ok: true });
        await register(page, { kind: 'raster', url: tpl('tiles') }, 'a');
        await register(page, { kind: 'raster', url: `${UPSTREAM}/style/raster/{z}/{x}/{y}.png` }, 'b');
        // 2 つの Source を交互に 10 枚ずつ取る（本体は 10〜14 byte。合計は上限を超える）
        let fetched = 0;
        let last;
        for (let i = 0; i < 10; i++) {
            for (const url of [at('tiles', 3, i % 8, 1), `${UPSTREAM}/style/raster/3/${i % 8}/${1 + Math.floor(i / 8)}.png`]) {
                const res = await getTile(page, url);
                expect(res.status).toBe(200);
                fetched += res.size;
                last = url;
            }
        }
        expect(fetched).toBeGreaterThan(LIMIT);
        // 最後に取ったものは残り、全体は上限以下（固定の無い Entry だけ）
        await expect.poll(async () => (await getTile(page, last)).wstatus).toBe('hit');
        const report = await usage(page);
        expect(report.bytes).toBeLessThanOrEqual(LIMIT);
        expect(report.count).toBeGreaterThan(0);
        expect(report.count).toBeLessThan(20);
        expectNoLeaks(guard);
    });

    test('cancels a running job', async ({ page, context, request }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        await register(page, { kind: 'raster', url: tpl('slow') });
        await page.evaluate(() => window.startRange(window.src, { box: { minX: 0, maxX: 7, minY: 0, maxY: 7 }, minZoom: 0, maxZoom: 3 }));
        await page.waitForFunction(() => window.events.some((e) => e.type === 'proceed'), null, { timeout: 15000 });
        expect(await call(page, 'cancel')).toMatchObject({ ok: true });
        const result = await page.evaluate(() => window.job.promise);
        expect(result).toMatchObject({ ok: true, value: { status: 'canceled', total: 85 } });
        expect(await eventsOf(page, 'canceled')).toHaveLength(1);
        // 取り消しの後は上流へ出ない（始まっていたバッチの分まで）
        const fetchedAtCancel = (await upstreamLog(request, '/slow/')).length;
        expect(fetchedAtCancel).toBeLessThan(85);
        await page.waitForTimeout(1000);
        expect((await upstreamLog(request, '/slow/')).length).toBe(fetchedAtCancel);
        // もう取り消すものは無い
        expect(await call(page, 'cancel')).toMatchObject({ ok: false, code: 'no-fetch-process' });
        expectNoLeaks(guard);
    });
});
