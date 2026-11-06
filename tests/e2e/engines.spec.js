import { test, expect } from '@playwright/test';

// エンジンごとの差を見る（m3-t10・I7 のうち m2 の hook.spec.js に試験が無いもの）。Chromium・WebKit（CI）・
// Firefox（CI で 1 回）で走らせる。上流は tile-server.mjs（localhost:5174。ページは localhost:5173 で別オリジン）
const UPSTREAM = 'http://localhost:5174';
const PAGE = '/tests/e2e/fixtures/iframe-page.html';

const tpl = (kind) => `${UPSTREAM}/${kind}/{z}/{x}/{y}.png`;
const at = (kind, z, x, y) => `${UPSTREAM}/${kind}/${z}/${x}/${y}.png`;

async function openPage(page) {
    await page.goto(PAGE);
    await page.waitForFunction(() => window.swReady === true || window.swError, null, { timeout: 30000 });
    expect(await page.evaluate(() => window.swError ?? null)).toBeNull();
}

async function upstreamModes(request, url) {
    const res = await request.get(`${UPSTREAM}/__log`);
    const path = new URL(url).pathname;
    return (await res.json()).filter((e) => e.path === path).map((e) => e.mode);
}

const statsCount = (page) => page.evaluate(async () => (await window.src.stats()).count);

test.describe('Weiwudi engines', () => {
    test.beforeEach(async ({ request }) => {
        await request.get(`${UPSTREAM}/__log?reset=1`);
    });

    // [diag] 一時の診断（m3-t10 の WebKit の CI で何も保存されない件の切り分け）。結果を出力するだけで落とさない。
    // 原因が分かったら消す
    test('diag: storage of blobs in indexeddb', async ({ page }) => {
        await openPage(page);
        const reg = await page.evaluate((url) => window.attempt(async () => {
            window.src = await window.Weiwudi.register({ kind: 'raster', url });
            return window.src.id;
        }), tpl('png'));
        const tiles = [];
        for (let i = 0; i < 2; i++) {
            tiles.push(await page.evaluate(async (url) => {
                const res = await fetch(url);
                await res.arrayBuffer();
                return { status: res.status, wstatus: res.headers.get('x-weiwudi-status'), werror: res.headers.get('x-weiwudi-error') };
            }, at('png', 4, 1, 1)));
        }
        const probe = await page.evaluate(async () => {
            const open = () => new Promise((resolve, reject) => {
                const req = indexedDB.open('weiwudi-diag', 1);
                req.onupgradeneeded = () => req.result.createObjectStore('s');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            const put = (db, key, value) => new Promise((resolve) => {
                try {
                    const tx = db.transaction('s', 'readwrite');
                    tx.objectStore('s').put(value, key);
                    tx.oncomplete = () => resolve('ok');
                    tx.onabort = () => resolve(`abort: ${tx.error && tx.error.name}: ${tx.error && tx.error.message}`);
                    tx.onerror = () => {};
                } catch (e) {
                    resolve(`throw: ${e && e.name}: ${e && e.message}`);
                }
            });
            try {
                const db = await open();
                return {
                    string: await put(db, 'a', 'text'),
                    arrayBuffer: await put(db, 'b', new Uint8Array([1, 2, 3]).buffer),
                    blob: await put(db, 'c', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })),
                };
            } catch (e) {
                return { open: String(e) };
            }
        });
        const stats = await page.evaluate(() => window.src ? window.src.stats() : null);
        console.log(`[diag] ${test.info().project.name}: register=${JSON.stringify(reg)} tiles=${JSON.stringify(tiles)} idb=${JSON.stringify(probe)} stats=${JSON.stringify(stats)}`);
    });

    test('does not touch script and navigate requests', async ({ page, request }) => {
        await openPage(page);
        const r = await page.evaluate((url) => window.attempt(async () => {
            window.src = await window.Weiwudi.register({ kind: 'raster', url });
            return window.src.id;
        }), tpl('png'));
        expect(r).toMatchObject({ ok: true });
        // 対照: 同じテンプレートの <img> は捕捉される（SW が cors で取り直して保存する）
        const imgUrl = at('png', 3, 0, 1);
        const img = await page.evaluate((url) => new Promise((resolve) => {
            const el = new Image();
            el.onload = () => resolve(true);
            el.onerror = () => resolve(false);
            el.src = url;
        }), imgUrl);
        expect(img).toBe(true);
        await expect.poll(() => statsCount(page)).toBe(1);
        expect(await upstreamModes(request, imgUrl)).toEqual(['cors']);

        // 同じテンプレートの URL を <script>（destination: script）と iframe（mode: navigate）で読む
        const scriptUrl = at('png', 3, 1, 1);
        const frameUrl = at('png', 3, 2, 1);
        const scriptRes = page.waitForResponse(scriptUrl);
        const frameRes = page.waitForResponse(frameUrl);
        const script = await page.evaluate((url) => window.loadScript(url), scriptUrl);
        const frame = await page.evaluate((url) => window.loadFrame(url), frameUrl);
        expect(script).not.toBe('timeout');
        expect(frame).toBe('load');
        // SW を通っていれば x-weiwudi-status が付き、上流へは cors で出る
        expect(await (await scriptRes).headerValue('x-weiwudi-status'), 'script').toBeNull();
        expect(await (await frameRes).headerValue('x-weiwudi-status'), 'navigate').toBeNull();
        expect(await upstreamModes(request, scriptUrl), 'script').toEqual(['no-cors']);
        expect(await upstreamModes(request, frameUrl), 'navigate').toEqual(['navigate']);
        expect(await statsCount(page)).toBe(1);
    });

    test('records whether a sandboxed srcdoc iframe inherits the controller', async ({ page }, testInfo) => {
        await openPage(page);
        const url = tpl('png');
        const r = await page.evaluate((url) => window.srcdocProbe(url), url);
        expect(r.error ?? null).toBeNull();
        expect(r.href).toBe('about:srcdoc');
        // 継いだか継がないかを記録する（どちらも仕様の範囲。CI の結果を README と仕様 §2 に書く）
        testInfo.annotations.push({ type: 'srcdoc-controlled', description: `${testInfo.project.name}: ${r.controlled}` });
        console.log(`[engines] ${testInfo.project.name}: sandboxed srcdoc iframe controlled=${r.controlled}`);
        if (r.controlled) {
            // 継ぐなら新 API が使える（登録した Source が親のページからも見える）
            expect(r.result).toMatchObject({ ok: true, value: { url } });
            const listed = await page.evaluate(() => window.Weiwudi.sources());
            expect(listed.map((s) => s.id)).toEqual([r.result.value.id]);
        } else {
            // 継がないなら何も送らずに sw-not-controlling
            expect(r.result).toMatchObject({ ok: false, code: 'sw-not-controlling' });
        }
    });
});
