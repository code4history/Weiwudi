import { test, expect } from '@playwright/test';
import { PAGE_HOST } from './fixtures/page-origin.mjs';

// 1.1.x の旧 DB からの移行を実ブラウザで確かめる（m4-t10・仕様 §14.2）。legacy-seed.html が 1.1.1 の形の旧 DB
// （Weiwudi.mapSetting と Weiwudi_x.tileCache に Blob）を IndexedDB に直接作ってから SW を登録し、旧 API の
// /api/cache/x/z/x/y を読む。外部へ出ない構成（上流は tile-server.mjs の localhost:5174）。WebKit・Firefox でも走らせる
// （R14'）。Chromium だけで成り立つものは @chromium-only で外す
const UPSTREAM = 'http://localhost:5174';
const PAGE = '/tests/e2e/fixtures/legacy-seed.html';
const PSEUDO = 'weiwudi.example.com';
const ALLOWED_HOSTS = [PAGE_HOST, 'localhost:5174'];
const MAP_ID = 'x';
const TILE_URL = `${UPSTREAM}/tiles/{z}/{x}/{y}.png`;

// 外へ出た要求を数える（range.spec.js と同じ。Chromium だけ）
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

function expectNoLeaks(guard) {
    expect(guard.external).toEqual([]);
    expect(guard.pseudo).toEqual([]);
}

/**
 * 旧 DB を作る。Blob を IndexedDB に保存できない環境（WebKit の非永続領域。1.1.1 もそこでは保存できなかったので、
 * 移すべき旧 DB が存在しない）では試験を飛ばす
 */
async function seed(page, maxZoom) {
    await page.goto(PAGE);
    await page.waitForFunction(() => window.pageReady === true);
    const r = await page.evaluate((opts) => window.seed(opts), { mapID: MAP_ID, url: TILE_URL, maxZoom });
    test.skip(r.blobUnsupported === true, `this engine cannot store a Blob in IndexedDB here: ${r.error}`);
    expect(await page.evaluate(() => window.databases())).toEqual(expect.arrayContaining(['Weiwudi', `Weiwudi_${MAP_ID}`]));
    return r.count;
}

async function startSW(page) {
    expect(await page.evaluate(() => window.attempt(() => window.startSW()))).toMatchObject({ ok: true });
    const r = await page.evaluate((id) => window.attempt(async () => {
        window.map = await window.Weiwudi.retrieveMap(id);
        return { mapID: window.map.mapID, url: window.map.url };
    }), MAP_ID);
    expect(r).toMatchObject({ ok: true, value: { mapID: MAP_ID } });
    return r.value;
}

const getTile = (page, z, x, y) => page.evaluate(([z, x, y]) =>
    window.tile(window.map.url.replace('{z}', z).replace('{x}', x).replace('{y}', y)), [z, x, y]);
const databases = (page) => page.evaluate(() => window.databases());
const usage = (page) => page.evaluate(() => window.Weiwudi.usage());

async function upstreamCount(request) {
    return (await (await request.get(`${UPSTREAM}/__requests`)).json()).count;
}

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

test.describe('Weiwudi migration from 1.1.x', () => {
    test('serves legacy tiles through the new store', async ({ page, context, request }) => {
        const guard = await guardNetwork(context);
        const count = await seed(page, 2);
        expect(count).toBe(21);
        const map = await startSW(page);
        expect(map.url).toBe(`https://${PSEUDO}/api/cache/${MAP_ID}/{z}/{x}/{y}`);
        const before = await upstreamCount(request);
        // SW の更新直後の最初の要求から旧 DB のタイルが読める（読み通し）
        for (const [z, x, y] of [[2, 1, 1], [0, 0, 0], [2, 3, 3]]) {
            const res = await getTile(page, z, x, y);
            expect(res.status, `${z}/${x}/${y}`).toBe(200);
            expect(res.wstatus, `${z}/${x}/${y}`).toBe('hit');
            expect(res.text).toBe(`legacy:${z}/${x}/${y}`);
        }
        // 上流へは出ていない（旧 Blob の arrayBuffer() から作った本体）
        expect(await upstreamCount(request)).toBe(before);
        const stats = await page.evaluate(() => window.map.stats());
        expect(stats.total).toBe(21);
        expect(stats.count).toBeGreaterThanOrEqual(3);
        expectNoLeaks(guard);
    });

    test('migrates every legacy tile and drops the old databases', async ({ page, context, request }) => {
        const guard = await guardNetwork(context);
        // z0〜4 の 341 枚（1 回の契機で 200 件ずつ移すので、2 回以上のバッチになる）
        const count = await seed(page, 4);
        expect(count).toBe(341);
        // 旧 DB の接続を開いたままにする: Weiwudi_x は onversionchange で閉じる、Weiwudi は閉じない（blocked になる）
        await page.evaluate(async (id) => {
            await window.hold(`Weiwudi_${id}`, true);
            await window.hold('Weiwudi', false);
        }, MAP_ID);
        await startSW(page);
        const before = await upstreamCount(request);
        const coords = coordsUpTo(4);
        // 要求を繰り返し、Weiwudi_x が消えて Weiwudi の削除が試みられるまで待つ。移行は waitUntil で並行して進み、
        // 同時の契機は同じ Promise を共有するので、要求の数ではなく時間（20 秒）で打ち切る
        const deadline = Date.now() + 20000;
        let finished = false;
        for (let i = 0; !finished && Date.now() < deadline; i++) {
            const [z, x, y] = coords[i % coords.length];
            const res = await getTile(page, z, x, y);
            expect(res.status).toBe(200);
            expect(res.text).toBe(`legacy:${z}/${x}/${y}`);
            const names = await databases(page);
            const state = await page.evaluate(() => window.heldState());
            finished = !names.includes(`Weiwudi_${MAP_ID}`) && state.Weiwudi.versionchange > 0;
            if (!finished) await page.waitForTimeout(50);
        }
        expect(finished).toBe(true);
        const held = await page.evaluate(() => window.heldState());
        // Weiwudi_x は onversionchange で閉じたので消えた
        expect(held[`Weiwudi_${MAP_ID}`]).toEqual({ versionchange: 1, closed: true });
        // Weiwudi は閉じない接続があるので blocked で残り、接続を閉じると待っていた削除が通る
        expect(held.Weiwudi).toEqual({ versionchange: 1, closed: false });
        expect(await databases(page)).toContain('Weiwudi');
        await page.evaluate(() => window.release('Weiwudi'));
        await expect.poll(async () => (await databases(page)).filter((n) => n.startsWith('Weiwudi') && n !== 'WeiwudiStore'))
            .toEqual([]);
        // 旧の件数がすべて新 DB に入り、上流へは出ていない
        await expect.poll(async () => (await usage(page)).count).toBe(count);
        expect(await upstreamCount(request)).toBe(before);
        // 移行の後も旧 API で読める
        const res = await getTile(page, 4, 15, 15);
        expect(res).toMatchObject({ status: 200, wstatus: 'hit', text: 'legacy:4/15/15' });
        expectNoLeaks(guard);
    });

    // context.setOffline が SW の fetch まで切るのは Chromium でだけ確かめた（仕様 §2 の 7）
    test('serves migrated tiles offline during migration', { tag: '@chromium-only' }, async ({ page, context, request }) => {
        const guard = await guardNetwork(context);
        // z0〜5 の 1365 枚（200 件ずつで 7 バッチ）。最後に読まれるキー（z_x_y の辞書順の末尾）は数回の要求では移らない
        const count = await seed(page, 5);
        expect(count).toBe(1365);
        await startSW(page);
        expect((await getTile(page, 0, 0, 0)).text).toBe('legacy:0/0/0');
        const before = await upstreamCount(request);
        await context.setOffline(true);
        for (const [z, x, y] of [[5, 9, 9], [5, 9, 8], [5, 9, 7]]) {
            const res = await getTile(page, z, x, y);
            expect(res.status, `${z}/${x}/${y}`).toBe(200);
            expect(res.wstatus, `${z}/${x}/${y}`).toBe('hit');
            expect(res.text).toBe(`legacy:${z}/${x}/${y}`);
        }
        // まだ移行の途中（旧 DB が残り、新 DB の件数は旧の件数に届かない）
        expect(await databases(page)).toContain(`Weiwudi_${MAP_ID}`);
        expect((await usage(page)).count).toBeLessThan(count);
        expect(await upstreamCount(request)).toBe(before);
        expectNoLeaks(guard);
    });
});
