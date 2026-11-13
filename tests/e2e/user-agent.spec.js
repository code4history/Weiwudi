import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { PAGE_ORIGIN } from './fixtures/page-origin.mjs';

// 上流へ送る User-Agent。SW は同じオリジンの上流にだけ `<ブラウザの UA> [userAgent] Weiwudi/<version>` を付ける。
// - 同じオリジンの上流: vite の開発用サーバの /__e2e/ua/（tests/e2e/fixtures/vite-plugin-ua-echo.mjs）
// - 別オリジンの上流: tile-server.mjs（localhost:5174）。付けない（付けると WebKit が preflight を出して 405 で失敗する）
// エンジンの差（実測）: WebKit は同じオリジンの要求の User-Agent を送る。Chromium は SW の fetch の User-Agent を捨てる
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const UPSTREAM = 'http://localhost:5174';
const SAME_TPL = `${PAGE_ORIGIN}/__e2e/ua/{z}/{x}/{y}.png`;
const sameAt = (z, x, y) => `${PAGE_ORIGIN}/__e2e/ua/${z}/${x}/${y}.png`;
const crossAt = (z, x, y) => `${UPSTREAM}/png/${z}/${x}/${y}.png`;

async function openPage(page, ua) {
    await page.goto(`/tests/e2e/fixtures/ua-page.html${ua === undefined ? '' : `?ua=${encodeURIComponent(ua)}`}`);
    await page.waitForFunction(() => window.swReady === true || window.swError, null, { timeout: 30000 });
    expect(await page.evaluate(() => window.swError ?? null)).toBeNull();
}

const register = (page, url) => page.evaluate((url) => window.attempt(async () => {
    window.src = await window.Weiwudi.register({ kind: 'raster', url });
    return window.src.id;
}), url);

async function sameOriginLog(request, url) {
    const res = await request.get(`${PAGE_ORIGIN}/__e2e/ua-log`);
    const path = new URL(url).pathname;
    return (await res.json()).filter((e) => e.path === path);
}

async function crossOriginLog(request, url) {
    const res = await request.get(`${UPSTREAM}/__log`);
    const path = new URL(url).pathname;
    return (await res.json()).filter((e) => e.path === path);
}

const browserUa = (page) => page.evaluate(() => navigator.userAgent);

test.describe('Weiwudi upstream User-Agent', () => {
    test.beforeEach(async ({ request }) => {
        await request.get(`${PAGE_ORIGIN}/__e2e/ua-log?reset=1`);
        await request.get(`${UPSTREAM}/__log?reset=1`);
    });

    test('appends the given userAgent and Weiwudi/<version> to same-origin upstream requests', async ({ page, request, browserName }) => {
        await openPage(page, 'Maplat/2.0');
        expect(await register(page, SAME_TPL)).toMatchObject({ ok: true });
        const url = sameAt(2, 1, 1);
        expect(await page.evaluate((u) => window.tile(u), url)).toMatchObject({ status: 200, weiwudi: 'miss' });
        const log = await sameOriginLog(request, url);
        expect(log.map((e) => e.mode)).toEqual(['cors']);
        const ua = log[0].ua;
        console.log(`[user-agent] ${browserName} same-origin: ${ua}`);
        if (browserName === 'chromium') {
            // Chromium は SW の fetch に付けた User-Agent を捨てる（期待どおり。取得は成功する）
            expect(ua).not.toContain('Weiwudi/');
            expect(ua).toBe(await browserUa(page));
        } else {
            expect(ua).toBe(`${await browserUa(page)} Maplat/2.0 Weiwudi/${VERSION}`);
        }
    });

    test('sends only Weiwudi/<version> when no userAgent is given', async ({ page, request, browserName }) => {
        await openPage(page);
        expect(await register(page, SAME_TPL)).toMatchObject({ ok: true });
        const url = sameAt(2, 0, 1);
        expect(await page.evaluate((u) => window.tile(u), url)).toMatchObject({ status: 200, weiwudi: 'miss' });
        const [entry] = await sameOriginLog(request, url);
        if (browserName === 'chromium') {
            expect(entry.ua).not.toContain('Weiwudi/');
        } else {
            expect(entry.ua).toBe(`${await browserUa(page)} Weiwudi/${VERSION}`);
        }
    });

    test('rejects an invalid userAgent in registerSW with attribute-invalid', async ({ page }) => {
        await page.goto('/tests/e2e/fixtures/ua-page.html?ua=%20%20');
        await page.waitForFunction(() => window.swReady === true || window.swError, null, { timeout: 30000 });
        expect(await page.evaluate(() => window.swError)).toContain('Attribute "userAgent" must not be blank');
        const r = await page.evaluate(() => window.attempt(() => window.Weiwudi.registerSW('./hook-sw.js', {
            scope: '/tests/e2e/fixtures/', userAgent: 'x'.repeat(201),
        })));
        expect(r).toMatchObject({ ok: false, code: 'attribute-invalid' });
    });

    test('keeps a same-origin upstream that redirects to another origin working', async ({ page, request, browserName }) => {
        // 付けた要求が redirect 先で preflight を要して失敗しても（WebKit・Firefox）、付けずに 1 回取り直して成功する
        await openPage(page, 'Maplat/2.0');
        expect(await register(page, `${PAGE_ORIGIN}/__e2e/ua-redirect/{z}/{x}/{y}.png`)).toMatchObject({ ok: true });
        const url = `${PAGE_ORIGIN}/__e2e/ua-redirect/2/1/3.png`;
        expect(await page.evaluate((u) => window.tile(u), url)).toMatchObject({ status: 200, weiwudi: 'miss' });
        const sameLog = await sameOriginLog(request, url);
        const crossLog = await crossOriginLog(request, crossAt(2, 1, 3));
        console.log(`[user-agent] ${browserName} redirect: same-origin ${sameLog.length} request(s), cross-origin ${crossLog.length} GET(s)`);
        // Chromium は User-Agent を捨てるので preflight が要らず 1 回。ほかは付けた 1 回が失敗し、付けずに取り直した 1 回
        expect(sameLog.length).toBe(browserName === 'chromium' ? 1 : 2);
        expect(crossLog.length).toBeGreaterThanOrEqual(1);
        expect(crossLog.every((e) => !String(e.ua).includes('Weiwudi/'))).toBe(true);
    });

    test('keeps cross-origin upstream requests working without the header', async ({ page, request }) => {
        await openPage(page, 'Maplat/2.0');
        expect(await register(page, `${UPSTREAM}/png/{z}/{x}/{y}.png`)).toMatchObject({ ok: true });
        // fetch（cors）
        const url = crossAt(2, 2, 1);
        expect(await page.evaluate((u) => window.tile(u), url)).toMatchObject({ status: 200, weiwudi: 'miss' });
        const log = await crossOriginLog(request, url);
        // preflight（OPTIONS）は /__log に積まれない。GET が 1 回だけ cors で届き、Weiwudi の値は付いていない
        expect(log.map((e) => e.mode)).toEqual(['cors']);
        expect(log[0].ua).not.toContain('Weiwudi/');
        // <img>（no-cors。SW が cors に組み替えて取る）
        const imgUrl = crossAt(2, 3, 1);
        expect(await page.evaluate((u) => window.img(u), imgUrl)).toBe(true);
        const imgLog = await crossOriginLog(request, imgUrl);
        expect(imgLog.map((e) => e.mode)).toEqual(['cors']);
        expect(imgLog[0].ua).not.toContain('Weiwudi/');
    });
});
