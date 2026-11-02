import { defineConfig, devices } from '@playwright/test';

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
