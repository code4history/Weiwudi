import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 実ブラウザの容量超過で x-weiwudi-error: quota になることを確かめる（#33）。
// 単体の再現（put の成功後の abort）が実物からずれていないかを見る。t1 のページと上流サーバを使う。
//
// Storage.overrideQuotaForOrigin について 2026-11-02 に Chromium 1248 で実測したこと:
// - その起動でオリジンの保存を一度でも使った後に掛けると、接続を開き直しても、別の DB でも、
//   28 秒待っても保存を止めない。使う前に掛けると、書き込みが transaction の abort
//   （tx.error が QuotaExceededError）になる（既定のコンテキストでも、使う前に掛ければ効く）
// 地図の登録（保存）を済ませてから上限を掛ける必要があるので、登録した起動を閉じ、
// 起動し直してから使う前に掛ける。既定のコンテキストは起動し直すと保存を引き継げないので、
// プロファイルを持つ永続コンテキストにする
const UPSTREAM = 'http://localhost:5174';
const TILE_URL = `${UPSTREAM}/tiles/{z}/{x}/{y}.png`;
const ORIGIN = 'http://localhost:5173';
const PAGE = `${ORIGIN}/tests/e2e/fixtures/offline-page.html`;
// 上限（byte）。登録の後の使用量より小さい。DB を開くことと読むことはこの上限でも通る（実測）
const QUOTA_BYTES = 1;

async function openPage(page) {
    await page.goto(PAGE);
    await page.waitForFunction(() => window.swReady === true || window.swError, null, { timeout: 30000 });
    expect(await page.evaluate(() => window.swError ?? null)).toBeNull();
}

test.describe('Weiwudi quota', () => {
    let userDataDir;
    let context;
    let page;

    test.beforeEach(async () => {
        userDataDir = mkdtempSync(join(tmpdir(), 'weiwudi-quota-'));
    });

    test.afterEach(async () => {
        try {
            // quotaSize なしで呼んで上限を解除する。残すと同じオリジンの後続の試験が保存に失敗する
            if (context && page) {
                const cdp = await context.newCDPSession(page);
                await cdp.send('Storage.overrideQuotaForOrigin', { origin: ORIGIN });
            }
        } finally {
            try {
                if (context) await context.close();
            } finally {
                context = undefined;
                page = undefined;
                rmSync(userDataDir, { recursive: true, force: true });
            }
        }
    });

    test('reports quota when the real storage quota is exceeded', async ({ playwright }) => {
        // 1 回目の起動: SW を入れて地図を登録する
        context = await playwright.chromium.launchPersistentContext(userDataDir);
        page = await context.newPage();
        await openPage(page);
        await page.evaluate(async (url) => {
            const map = await window.Weiwudi.registerMap('quota_map', {
                type: 'xyz',
                width: 1024,
                height: 1024,
                url
            });
            map.release();
        }, TILE_URL);
        const usage = await page.evaluate(async () => (await navigator.storage.estimate()).usage);
        expect(usage).toBeGreaterThan(QUOTA_BYTES);
        await context.close();
        context = undefined;
        page = undefined;

        // 2 回目の起動: オリジンを使う前に上限を掛ける
        context = await playwright.chromium.launchPersistentContext(userDataDir);
        page = context.pages()[0] ?? await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Storage.overrideQuotaForOrigin', { origin: ORIGIN, quotaSize: QUOTA_BYTES });
        await openPage(page);
        await page.evaluate(async () => {
            window.map = await window.Weiwudi.retrieveMap('quota_map');
        });
        const before = await page.evaluate(() => window.map.stats());

        const tile = await page.evaluate(async () => {
            const url = window.map.url.replace('{z}', '2').replace('{x}', '1').replace('{y}', '1');
            const res = await fetch(url);
            return {
                status: res.status,
                text: await res.text(),
                error: res.headers.get('x-weiwudi-error')
            };
        });
        expect(tile.status).toBe(200);
        expect(tile.text).toBe('tile:2/1/1');
        expect(tile.error).toBe('quota');

        const after = await page.evaluate(() => window.map.stats());
        expect(after.count).toBe(before.count);
    });
});
