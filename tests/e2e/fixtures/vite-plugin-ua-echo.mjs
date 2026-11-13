// User-Agent の e2e（user-agent.spec.js）の、ページと同じオリジンの上流（vite の開発用サーバの中）。
// - GET /__e2e/ua/{z}/{x}/{y}.png: 1×1 の PNG。受けた要求の { path, ua（user-agent）, mode（sec-fetch-mode） } を積む
// - GET /__e2e/ua-redirect/{z}/{x}/{y}.png: 302 で別オリジン（tile-server.mjs の /png/{z}/{x}/{y}.png）へ送る。受けた要求を同じく積む
// - GET /__e2e/ua-log: 積んだ並び。?reset=1 で空にする
// 開発用サーバだけに効く（build には入らない）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/** 別オリジンの上流（tile-server.mjs） */
const CROSS_ORIGIN = 'http://localhost:5174';

export function uaEchoPlugin() {
    const log = [];
    return {
        name: 'weiwudi-e2e-ua-echo',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = new URL(req.url ?? '/', 'http://localhost');
                if (url.pathname === '/__e2e/ua-log') {
                    if (url.searchParams.has('reset')) log.length = 0;
                    res.setHeader('content-type', 'application/json');
                    res.setHeader('cache-control', 'no-store');
                    res.end(JSON.stringify(log));
                    return;
                }
                const redirect = url.pathname.match(/^\/__e2e\/ua-redirect\/(\d+)\/(\d+)\/(\d+)\.png$/);
                if (redirect) {
                    log.push({ path: url.pathname, ua: req.headers['user-agent'] ?? null, mode: req.headers['sec-fetch-mode'] ?? null });
                    res.statusCode = 302;
                    res.setHeader('location', `${CROSS_ORIGIN}/png/${redirect[1]}/${redirect[2]}/${redirect[3]}.png`);
                    res.setHeader('cache-control', 'no-store');
                    res.end();
                    return;
                }
                if (/^\/__e2e\/ua\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) {
                    log.push({ path: url.pathname, ua: req.headers['user-agent'] ?? null, mode: req.headers['sec-fetch-mode'] ?? null });
                    res.setHeader('content-type', 'image/png');
                    res.setHeader('cache-control', 'no-store');
                    res.end(PNG);
                    return;
                }
                next();
            });
        },
    };
}
