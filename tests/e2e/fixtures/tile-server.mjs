// オフラインの e2e が使うローカルの上流サーバ（#32）。Node の http だけで書く。
// - GET /tiles/{z}/{x}/{y}.png: 本体は `tile:{z}/{x}/{y}`。受けた回数を数える
// - GET /__requests: それまでの受信数を { count } で返す
// - GET /__health: 200・本文 `weiwudi-e2e-tile-server`（workbox を写し終えてから listen するので、返れば揃っている）
// - GET /workbox/*: 起動時に一時ディレクトリへ写した workbox の一式
// 実 URL の捕捉の e2e（m2-t9・hook.spec.js）の端点。本体は 1×1 の PNG（<img> で読めるもの）:
// - GET /png/{z}/{x}/{y}.png: 200・CORS あり
// - GET /nocors/{z}/{x}/{y}.png: 200・CORS ヘッダなし
// - GET /sparse/{z}/{x}/{y}.png: x が偶数なら 404・CORS ヘッダなし、奇数なら 200・CORS あり
// - GET /auth/{z}/{x}/{y}.png: Cookie `weiwudi=1` があれば 200・なければ 401。どちらも CORS あり
// - GET /html/{z}/{x}/{y}.png: 200・text/html・CORS あり
// - GET /__log: 上の端点が受けた要求の { path, mode（sec-fetch-mode）, cookie（weiwudi=1 の有無） } の並び
//
// 一時ディレクトリの片付け（m2-t1・第 1 回 S14・第 2 回 O19）:
// - SIGTERM・SIGINT で一時ディレクトリを消してから process.exit(0)。exit の処理でも消す
//   （playwright.config.js の gracefulShutdown で SIGTERM が届く。無いと SIGKILL で止まり消えない）
// - listen に成功した後に、作られてから 1 時間より古い weiwudi-e2e-* を消す（SIGKILL で残った分の保険）
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { copyWorkbox } from '../../../scripts/vite-plugin-copy-workbox.mjs';

const PORT = 5174;
const CORS = { 'access-control-allow-origin': '*' };

const PREFIX = 'weiwudi-e2e-';
const STALE_MS = 60 * 60 * 1000;

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

// 1×1 の透明 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const log = [];

// 実 URL の捕捉の e2e の端点（m2-t9）。応えたら true
function serveHookTile(req, pathname, res) {
    const m = pathname.match(/^\/(png|nocors|sparse|auth|html)\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (!m) return false;
    const kind = m[1];
    const x = Number(m[3]);
    const cookie = /(?:^|;\s*)weiwudi=1(?:;|$)/.test(req.headers.cookie ?? '');
    log.push({ path: pathname, mode: req.headers['sec-fetch-mode'] ?? null, cookie });
    const png = (headers) => {
        res.writeHead(200, { ...headers, 'content-type': 'image/png' });
        res.end(PNG);
    };
    if (kind === 'png') png(CORS);
    else if (kind === 'nocors') png({});
    else if (kind === 'sparse') {
        if (x % 2 === 0) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('Not Found');
        } else png(CORS);
    } else if (kind === 'auth') {
        if (cookie) png(CORS);
        else {
            res.writeHead(401, { ...CORS, 'content-type': 'text/plain' });
            res.end('Unauthorized');
        }
    } else {
        res.writeHead(200, { ...CORS, 'content-type': 'text/html' });
        res.end('<!DOCTYPE html><title>login</title>');
    }
    return true;
}

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

// 前の走行が SIGKILL などで残した古い一時ディレクトリを消す。listen に成功した後にだけ呼ぶ
// （ポートを取れなかった起動は、走っている別の実例の一時ディレクトリを消しうるので掃除しない）
const sweepStale = () => {
    for (const name of readdirSync(tmpdir())) {
        if (!name.startsWith(PREFIX)) continue;
        const dir = join(tmpdir(), name);
        if (dir === workDir) continue;
        try {
            const st = statSync(dir);
            const created = st.birthtimeMs || st.ctimeMs;
            if (st.isDirectory() && Date.now() - created > STALE_MS) rmSync(dir, { recursive: true, force: true });
        } catch (_e) {
            // 消せないものは次の起動に任せる
        }
    }
};

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
    if (serveHookTile(req, pathname, res)) return;
    if (pathname === '/__log') {
        // ?reset=1 で空にする（再試行で前の試行の記録が残らないように）
        if (new URL(req.url, 'http://localhost').searchParams.has('reset')) log.length = 0;
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify(log));
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
    sweepStale();
    console.log(`tile-server listening on http://localhost:${PORT}`);
});
