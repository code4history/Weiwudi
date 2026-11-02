// オフラインの e2e が使うローカルの上流サーバ（#32）。Node の http だけで書く。
// - GET /tiles/{z}/{x}/{y}.png: 本体は `tile:{z}/{x}/{y}`。受けた回数を数える
// - GET /__requests: それまでの受信数を { count } で返す
// - GET /__health: 200・本文 `weiwudi-e2e-tile-server`（workbox を写し終えてから listen するので、返れば揃っている）
// - GET /workbox/*: 起動時に一時ディレクトリへ写した workbox の一式
//
// 一時ディレクトリの片付け（m2-t1・第 1 回 S14・第 2 回 O19）:
// - SIGTERM・SIGINT で一時ディレクトリを消してから process.exit(0)。exit の処理でも消す
//   （playwright.config.js の gracefulShutdown で SIGTERM が届く。無いと SIGKILL で止まり消えない）
// - 起動時に、作られてから 1 時間より古い weiwudi-e2e-* を消す（SIGKILL で残った分の保険）
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { copyWorkbox } from '../../../scripts/vite-plugin-copy-workbox.mjs';

const PORT = 5174;
const CORS = { 'access-control-allow-origin': '*' };

const PREFIX = 'weiwudi-e2e-';
const STALE_MS = 60 * 60 * 1000;

// 前の走行が SIGKILL などで残した古い一時ディレクトリを消す
for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = join(tmpdir(), name);
    try {
        const st = statSync(dir);
        const created = st.birthtimeMs || st.ctimeMs;
        if (st.isDirectory() && Date.now() - created > STALE_MS) rmSync(dir, { recursive: true, force: true });
    } catch (_e) {
        // 消せないものは次の起動に任せる
    }
}

const workDir = mkdtempSync(join(tmpdir(), PREFIX));
const cleanup = () => {
    try {
        rmSync(workDir, { recursive: true, force: true });
    } catch (_e) {
        // 終わり際の失敗は無視する（次の起動の保険が拾う）
    }
};
process.on('exit', cleanup);
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        cleanup();
        process.exit(0);
    });
}
await copyWorkbox(workDir);
const workboxDir = join(workDir, 'workbox');

let count = 0;

function serveWorkbox(pathname, res) {
    let rel;
    try {
        rel = decodeURIComponent(pathname.slice('/workbox/'.length));
    } catch (_e) {
        res.writeHead(400, CORS);
        res.end('Bad Request');
        return;
    }
    const file = normalize(join(workboxDir, rel));
    if (!file.startsWith(workboxDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404, CORS);
        res.end('Not Found');
        return;
    }
    const type = file.endsWith('.map') ? 'application/json' : 'text/javascript';
    res.writeHead(200, { ...CORS, 'content-type': type });
    res.end(readFileSync(file));
}

const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, CORS);
        res.end();
        return;
    }
    const tile = pathname.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (tile) {
        count++;
        res.writeHead(200, { ...CORS, 'content-type': 'image/png' });
        res.end(`tile:${tile[1]}/${tile[2]}/${tile[3]}`);
        return;
    }
    if (pathname === '/__requests') {
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify({ count }));
        return;
    }
    if (pathname === '/__health') {
        res.writeHead(200, { ...CORS, 'content-type': 'text/plain' });
        res.end('weiwudi-e2e-tile-server');
        return;
    }
    if (pathname.startsWith('/workbox/')) {
        serveWorkbox(pathname, res);
        return;
    }
    res.writeHead(404, CORS);
    res.end('Not Found');
});

server.listen(PORT, 'localhost', () => {
    console.log(`tile-server listening on http://localhost:${PORT}`);
});
