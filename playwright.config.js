import { defineConfig, devices } from '@playwright/test';

// WebKit・Firefox は環境変数 WEIWUDI_E2E_ENGINES（webkit・firefox をカンマで）があるときだけ足す（m3-t10・R14'）。
// 手元は Chromium だけ（共有キャッシュに playwright install をしない）。CI の e2e-engines の job が足して走らせる。
// Chromium だけで成り立つ試験（CDP・context.setOffline・SW の要求を context.route で数えるもの）は @chromium-only で外す
const ENGINE_DEVICES = { webkit: 'Desktop Safari', firefox: 'Desktop Firefox' };
const engines = (process.env.WEIWUDI_E2E_ENGINES ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
for (const e of engines) {
    if (!(e in ENGINE_DEVICES)) throw new Error(`WEIWUDI_E2E_ENGINES: unknown engine "${e}" (webkit, firefox)`);
}
const engineProjects = [...new Set(engines)].map((name) => ({
    name,
    use: { ...devices[ENGINE_DEVICES[name]] },
    grepInvert: /@chromium-only/,
}));

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: 1,
    reporter: [['html', { open: 'never' }]],
    use: {
        baseURL: 'http://localhost:5173',
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
        ...engineProjects,
    ],
    webServer: [
        {
            command: 'pnpm run dev',
            url: 'http://localhost:5173',
            reuseExistingServer: !process.env.CI,
        },
        // オフラインの e2e が使うローカルの上流サーバ（タイルと workbox を配る）
        {
            command: 'node tests/e2e/fixtures/tile-server.mjs',
            url: 'http://localhost:5174/__health',
            // 5174 に別のものが居るときに取り違えず、失敗させる（申し送り 3）
            reuseExistingServer: false,
            // SIGTERM で止め、上流サーバが一時ディレクトリを消せるようにする（無いと SIGKILL。第 1 回 S14）
            gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
        },
    ],
});
