// e2e のページ（vite の開発用サーバ）の番号。既定は 5173。手元で 5173 が使われているときは
// 環境変数 WEIWUDI_E2E_PORT で替える（playwright.config.js と各 spec が同じ値を使う）
export const PAGE_PORT = Number(process.env.WEIWUDI_E2E_PORT ?? 5173);
export const PAGE_HOST = `localhost:${PAGE_PORT}`;
export const PAGE_ORIGIN = `http://${PAGE_HOST}`;
