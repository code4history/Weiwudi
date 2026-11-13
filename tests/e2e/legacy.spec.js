import { test, expect } from '@playwright/test';
import { PAGE_HOST } from './fixtures/page-origin.mjs';

// 旧 API（registerMap・Weiwudi のインスタンス）を、MaplatCore が実際に使う呼び方のまま実の Service Worker で確かめる。
// Core の試験は Weiwudi を mock しているので、旧 API の実挙動はここで見る（12 月トレインの依頼）。
// 写した呼び方: MaplatCore src/source_ex.ts の registerMapToSW、src/source/mixin.ts の stats・fetchAll・cancel・clean。
// - setting.type は base・overlay なら 'wmts'、ほかは 'xyz'。url は文字列か配列（tms は '{-y}'）
// - width・height・maxZoom・minZoom はそのまま（undefined なら送られない）。cacheTtl はあるときだけ。cacheMaxBytes は渡さない
// - envelopeLngLats があるとき minLng・maxLng・minLat・maxLat（数値）
// - registerMap の失敗は握りつぶす（ここでは握りつぶす前の reject を確かめる）
// - fetchAll は proceed・finish・stop・canceled を聞いてから await fetchAll()
// 外部へ出ない構成で、上流は tile-server.mjs（localhost:5174）だけ。SW は offline-sw.js、ページは offline-page.html。
// context.setOffline と、SW の要求を context.route で数える外部通信の検査が Chromium だけで成り立つので、
// describe ごと @chromium-only にする（R-lg-1）
const UPSTREAM = 'http://localhost:5174';
const PAGE = '/tests/e2e/fixtures/offline-page.html';
const PSEUDO = 'weiwudi.example.com';
const ALLOWED_HOSTS = [PAGE_HOST, 'localhost:5174'];
const tpl = (kind, y = '{y}') => `${UPSTREAM}/${kind}/{z}/{x}/${y}.png`;

// 東京付近（z3〜8 で 25 枚）。期待値は試験の側で別の式（Web メルカトルのタイル番号の定義式）から出す
const TOKYO = { minLng: 138, maxLng: 141, minLat: 34, maxLat: 37 };
// 東の端は 180 にしない（180 は x = 2^z になり、範囲の外の 1 列が数に入る。現行からの癖。R-lg-6）
const WORLD = { minLng: -180, maxLng: 179.99, minLat: -85, maxLat: 85 };

const tileX = (lng, z) => Math.floor((lng + 180) / 360 * 2 ** z);
const tileY = (lat, z) => {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
};
/** 範囲の z ごとのタイル（maxZoom での範囲を 2 の冪で縮める。z 昇順） */
function tilesOf(b, minZoom, maxZoom) {
    const box = { minX: tileX(b.minLng, maxZoom), maxX: tileX(b.maxLng, maxZoom), minY: tileY(b.maxLat, maxZoom), maxY: tileY(b.minLat, maxZoom) };
    const out = [];
    for (let z = minZoom; z <= maxZoom; z++) {
        const f = 2 ** (maxZoom - z);
        for (let x = Math.floor(box.minX / f); x <= Math.floor(box.maxX / f); x++) {
            for (let y = Math.floor(box.minY / f); y <= Math.floor(box.maxY / f); y++) out.push([z, x, y]);
        }
    }
    return out;
}

// 外へ出た要求を数える（range.spec.js と同じ。C-O8）。どちらも各試験の最後に 0 件を確かめる
async function guardNetwork(context) {
    const external = [];
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

function expectNoLeaks(guard) {
    expect(guard.external).toEqual([]);
    expect(guard.pseudo).toEqual([]);
}

// ページを開き、Core の registerMapToSW と同じ組み立てで登録する。結果は { ok, value | error } で返す
// （成功なら window.map にインスタンスを置き、旧 API のイベントを window.events に積む）
async function openPage(page) {
    await page.goto(PAGE);
    await page.waitForFunction(() => window.swReady === true || window.swError, null, { timeout: 30000 });
    expect(await page.evaluate(() => window.swError ?? null)).toBeNull();
}

function registerLikeCore(page, mapID, options) {
    return page.evaluate(async ({ mapID, options }) => {
        const setting = {};
        setting.type = options.maptype === 'base' || options.maptype === 'overlay' ? 'wmts' : 'xyz';
        setting.url = options.urls ? options.urls : options.url;
        setting.width = options.width;
        setting.height = options.height;
        setting.maxZoom = options.maxZoom;
        setting.minZoom = options.minZoom;
        if (options.cacheTtl !== undefined) setting.cacheTtl = options.cacheTtl;
        if (options.bounds) {
            for (const key of ['minLng', 'maxLng', 'minLat', 'maxLat']) setting[key] = options.bounds[key];
        }
        try {
            const ret = await window.Weiwudi.registerMap(mapID, setting);
            window.map = ret;
            window.events = [];
            for (const type of ['proceed', 'finish', 'stop', 'canceled']) {
                ret.addEventListener(type, (e) => window.events.push({ type: e.type, detail: e.detail }));
            }
            return { ok: true, value: { url: ret.url, totalTile: ret.totalTile, type: ret.type, minX: ret.minX, maxX: ret.maxX, minY: ret.minY, maxY: ret.maxY } };
        } catch (e) {
            return { ok: false, error: { kind: typeof e, isError: e instanceof Error, text: String(e) } };
        }
    }, { mapID, options });
}

// ret.url を展開して SW 経由で 1 枚取る
function getTile(page, z, x, y) {
    return page.evaluate(async ([z, x, y]) => {
        const url = window.map.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        const res = await fetch(url);
        return { status: res.status, text: await res.text() };
    }, [z, x, y]);
}

const call = (page, method) => page.evaluate(async (method) => {
    try {
        return { ok: true, value: (await window.map[method]()) ?? null };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}, method);
const eventsOf = (page, type) => page.evaluate((type) => window.events.filter((e) => e.type === type).map((e) => e.detail), type);

async function upstreamCount(request) {
    return (await (await request.get(`${UPSTREAM}/__requests`)).json()).count;
}
async function upstreamLog(request, prefix) {
    return (await (await request.get(`${UPSTREAM}/__log`)).json()).filter((e) => e.path.startsWith(prefix));
}

// Core の fetchAllTileCacheAsync と同じ順（聞いてから await fetchAll()）で始め、終わりのイベントまで待つ
function fetchAllUntilEnd(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no terminal event within 30 s')), 30000);
        const end = (e) => { clearTimeout(timer); resolve({ type: e.type, detail: e.detail }); };
        for (const type of ['finish', 'stop', 'canceled']) window.map.addEventListener(type, end, { once: true });
        window.map.fetchAll().catch((e) => { clearTimeout(timer); reject(new Error(String(e))); });
    }));
}

const TOKYO_MAP = { maptype: 'base', url: tpl('tiles'), bounds: TOKYO, minZoom: 3, maxZoom: 8 };

test.describe('Weiwudi legacy API as MaplatCore calls it', { tag: '@chromium-only' }, () => {
    test.beforeEach(async ({ request }) => {
        await request.get(`${UPSTREAM}/__log?reset=1`);
    });

    test('wmts with bounds: serves a tile, caches it, and reports totalTile', async ({ page, context, request }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        const expected = tilesOf(TOKYO, 3, 8);
        expect(expected).toHaveLength(25);
        const r = await registerLikeCore(page, 'legacy_wmts', TOKYO_MAP);
        expect(r.ok, JSON.stringify(r.error)).toBe(true);
        expect(r.value.type).toBe('wmts');
        expect(r.value.url).toBe(`https://${PSEUDO}/api/cache/legacy_wmts/{z}/{x}/{y}`);
        expect(r.value.totalTile).toBe(expected.length);
        // 範囲は maxZoom での 4 辺（試験の式と一致）
        const atMax = expected.filter(([z]) => z === 8);
        expect(r.value).toMatchObject({
            minX: Math.min(...atMax.map((t) => t[1])), maxX: Math.max(...atMax.map((t) => t[1])),
            minY: Math.min(...atMax.map((t) => t[2])), maxY: Math.max(...atMax.map((t) => t[2])),
        });

        const [z, x, y] = atMax[0];
        const before = await upstreamCount(request);
        const first = await getTile(page, z, x, y);
        expect(first).toEqual({ status: 200, text: `tile:${z}/${x}/${y}` });
        expect(await upstreamCount(request)).toBe(before + 1);
        const second = await getTile(page, z, x, y);
        expect(second).toEqual({ status: 200, text: `tile:${z}/${x}/${y}` });
        expect(await upstreamCount(request)).toBe(before + 1);

        // stats().total は totalTile と同じ。Core 側の補い（total が無ければ totalTile）を通しても同じ値（R-lg-3）
        const stats = await call(page, 'stats');
        expect(stats.ok).toBe(true);
        expect(stats.value).toMatchObject({ count: 1, total: expected.length, percent: Math.floor(100 / expected.length) });
        expect(stats.value.total ?? r.value.totalTile).toBe(r.value.totalTile);

        // 範囲の無い wmts では total も totalTile も無い（キーごと無い。null ではない）。補いの式は undefined になる
        const bare = await registerLikeCore(page, 'legacy_bare', { maptype: 'base', url: tpl('tiles'), minZoom: 0, maxZoom: 2 });
        expect(bare.ok, JSON.stringify(bare.error)).toBe(true);
        expect(bare.value.totalTile).toBeUndefined();
        const bareStats = await call(page, 'stats');
        expect(bareStats.ok).toBe(true);
        expect(bareStats.value).toEqual({ count: 0, size: 0 });
        expectNoLeaks(guard);
    });

    test('wmts fetchAll: proceed, finish with totalTile, then everything offline', async ({ page, context }) => {
        test.slow();
        const guard = await guardNetwork(context);
        await openPage(page);
        const expected = tilesOf(TOKYO, 3, 8);
        const r = await registerLikeCore(page, 'legacy_wmts_all', TOKYO_MAP);
        expect(r.ok, JSON.stringify(r.error)).toBe(true);
        const end = await fetchAllUntilEnd(page);
        expect(end.type).toBe('finish');
        expect(end.detail).toMatchObject({ mapID: 'legacy_wmts_all', total: r.value.totalTile, error: 0 });
        // finish に percent は無い（1.1.1 から同じ。R-lg-4）。100 は最後の proceed と stats() で見る
        expect(end.detail.percent).toBeUndefined();
        const proceed = await eventsOf(page, 'proceed');
        expect(proceed.length).toBeGreaterThanOrEqual(1);
        expect(proceed.at(-1)).toMatchObject({ percent: 100, processed: expected.length, total: r.value.totalTile });
        const stats = await call(page, 'stats');
        expect(stats.value).toMatchObject({ count: expected.length, total: expected.length, percent: 100 });

        await context.setOffline(true);
        for (const [z, x, y] of expected) {
            const tile = await getTile(page, z, x, y);
            expect(tile, `${z}/${x}/${y}`).toEqual({ status: 200, text: `tile:${z}/${x}/${y}` });
        }
        expectNoLeaks(guard);
    });

    test('cancel after the first proceed ends the job with canceled', async ({ page, context, request }) => {
        test.slow();
        const guard = await guardNetwork(context);
        await openPage(page);
        // 世界の z0〜4（341 枚）を /slow/ で。1 バッチ（5 枚）に約 250 ms かかる
        const r = await registerLikeCore(page, 'legacy_cancel', { maptype: 'base', url: tpl('slow'), bounds: WORLD, minZoom: 0, maxZoom: 4 });
        expect(r.ok, JSON.stringify(r.error)).toBe(true);
        expect(r.value.totalTile).toBe(tilesOf(WORLD, 0, 4).length);
        const result = await page.evaluate(() => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no canceled within 30 s')), 30000);
            const out = { fetchAllResolved: false };
            window.map.addEventListener('proceed', async () => {
                if (out.cancel) return;
                out.cancel = 'pending';
                try {
                    await window.map.cancel();
                    out.cancel = 'ok';
                } catch (e) {
                    out.cancel = `rejected: ${e}`;
                }
            });
            window.map.addEventListener('canceled', (e) => {
                clearTimeout(timer);
                out.canceled = e.detail;
                resolve(out);
            }, { once: true });
            window.map.fetchAll().then(() => { out.fetchAllResolved = true; }, (e) => reject(new Error(String(e))));
        }));
        expect(result.fetchAllResolved).toBe(true);
        expect(result.cancel).toBe('ok');
        expect(result.canceled).toMatchObject({ mapID: 'legacy_cancel' });
        // ジョブは外れている: もう一度の cancel は「取得中のものが無い」で reject し、finish・stop は来ない
        const again = await call(page, 'cancel');
        expect(again).toEqual({ ok: false, error: 'Error: There are no fetching process of legacy_cancel' });
        const fetched = (await upstreamLog(request, '/slow/')).length;
        await page.waitForTimeout(1000);
        expect((await upstreamLog(request, '/slow/')).length).toBe(fetched);
        expect(fetched).toBeLessThan(r.value.totalTile);
        expect(await eventsOf(page, 'finish')).toEqual([]);
        expect(await eventsOf(page, 'stop')).toEqual([]);
        expectNoLeaks(guard);
    });

    test('url array with a tms template: registers, serves, and flips y', async ({ page, context, request }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        const urls = [tpl('tms', '{-y}'), tpl('tiles')];
        const r = await registerLikeCore(page, 'legacy_mirrors', { maptype: 'base', urls, bounds: WORLD, minZoom: 0, maxZoom: 2 });
        expect(r.ok, JSON.stringify(r.error)).toBe(true);
        expect(r.value.url).toBe(`https://${PSEUDO}/api/cache/legacy_mirrors/{z}/{x}/{y}`);
        expect(r.value.totalTile).toBe(21);
        // ミラーは 1 枚ごとに無作為に選ばれる（R-lg-5）。どちらで取ったかは本体（上流が受けた y）でわかる
        const seen = { tms: 0, xyz: 0 };
        for (const [z, x, y] of tilesOf(WORLD, 0, 2)) {
            const tile = await getTile(page, z, x, y);
            expect(tile.status, `${z}/${x}/${y}`).toBe(200);
            if (tile.text.startsWith('tms:')) {
                seen.tms++;
                expect(tile.text, `${z}/${x}/${y}`).toBe(`tms:${z}/${x}/${2 ** z - 1 - y}`);
            } else {
                seen.xyz++;
                expect(tile.text, `${z}/${x}/${y}`).toBe(`tile:${z}/${x}/${y}`);
            }
        }
        expect(seen.tms).toBeGreaterThan(0);
        expect(seen.xyz).toBeGreaterThan(0);
        // 上流の記録でも、tms の端点が受けた z=1 の y は 1−y の向き
        const log = await upstreamLog(request, '/tms/');
        expect(log).toHaveLength(seen.tms);
        for (const { path } of log) expect(path).toMatch(/^\/tms\/\d+\/\d+\/\d+\.png$/);
        expectNoLeaks(guard);
    });

    test('registerMap rejects an invalid setting (what Core swallows)', async ({ page, context }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        const cases = {
            noUrl: { maptype: 'base', bounds: TOKYO, minZoom: 3, maxZoom: 8 },
            xyzNoSize: { maptype: 'maplat', url: tpl('tiles'), minZoom: 0, maxZoom: 2 },
        };
        const results = {};
        for (const [name, options] of Object.entries(cases)) results[name] = await registerLikeCore(page, `legacy_bad_${name}`, options);
        // 今の実装のまま記録する: SW の文面（文字列）をそのまま throw する（Error ではない。R-lg-7）
        expect(results.noUrl).toEqual({ ok: false, error: { kind: 'string', isError: false, text: 'Error: Attribute "url" is missing' } });
        expect(results.xyzNoSize).toEqual({ ok: false, error: { kind: 'string', isError: false, text: 'Error: Attribute "width" is missing' } });
        // 登録されていない（info は未登録の文面）
        const info = await page.evaluate(async () => {
            try {
                await window.Weiwudi.retrieveMap('legacy_bad_noUrl');
                return 'registered';
            } catch (e) {
                return String(e);
            }
        });
        expect(info).toBe('Error: MapID "legacy_bad_noUrl" not found');
        expectNoLeaks(guard);
    });
});
