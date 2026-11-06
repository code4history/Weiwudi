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
// スタイルの e2e（m3-t9・style.spec.js）の端点。どれも CORS あり。受けた要求は /__log に積む（path はデコード後）:
// - GET /style/basic.json: スタイル（sources の url の TileJSON・tiles・geojson の data、glyphs・sprite）
// - GET /style/tiles.json: TileJSON（tiles・bounds・minzoom・maxzoom）
// - GET /style/tiles/{z}/{x}/{y}.pbf: 本体は `vt:{z}/{x}/{y}`（application/x-protobuf）
// - GET /style/raster/{z}/{x}/{y}.png: 本体は `raster:{z}/{x}/{y}`（image/png）
// - GET /style/fonts/{fontstack}/{range}.pbf: 本体は `glyph:{fontstack}:{range}`（範囲ごとに違うバイト列）
// - GET /style/sprite{@2x?}.{json,png}: 4 つ。json は pixelRatio で、png は末尾の 1 バイトで見分ける
// - GET /style/data.geojson: GeoJSON（FeatureCollection・点 1 つ）
// - GET /style/mapbox.json: mapbox:// を含むスタイル（試験が context.route で api.mapbox.com の要求にこれを返す）
// - GET /style/mapbox-tiles.json: mapbox:// のソースの TileJSON（tiles は api.mapbox.com。同上）
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

// スタイルの e2e の端点（m3-t9）
const STYLE_BASE = `http://localhost:${PORT}/style`;
const STYLE = {
    version: 8,
    name: 'weiwudi-e2e-basic',
    sources: {
        vt: { type: 'vector', url: `${STYLE_BASE}/tiles.json` },
        raster: { type: 'raster', tiles: [`${STYLE_BASE}/raster/{z}/{x}/{y}.png`], tileSize: 256, maxzoom: 18 },
        points: { type: 'geojson', data: `${STYLE_BASE}/data.geojson` },
    },
    glyphs: `${STYLE_BASE}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${STYLE_BASE}/sprite`,
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#fff' } }],
};
const TILEJSON = {
    tilejson: '3.0.0',
    tiles: [`${STYLE_BASE}/tiles/{z}/{x}/{y}.pbf`],
    bounds: [-180, -85, 180, 85],
    minzoom: 0,
    maxzoom: 14,
};
// Mapbox の API が返す形（mapbox:// のまま）。glyphs には資格情報を書いておく（保存した本体から除かれることを見る）
const MAPBOX_TOKEN = 'pk.FAKE_E2E_TOKEN';
const MAPBOX_STYLE = {
    version: 8,
    name: 'weiwudi-e2e-mapbox',
    sources: { m: { type: 'vector', url: 'mapbox://u.tileset' } },
    glyphs: `mapbox://fonts/u/{fontstack}/{range}.pbf?access_token=${MAPBOX_TOKEN}`,
    sprite: 'mapbox://sprites/u/s',
    layers: [],
};
const MAPBOX_TILEJSON = {
    tilejson: '2.2.0',
    tiles: ['https://api.mapbox.com/v4/u.tileset/{z}/{x}/{y}.vector.pbf'],
    bounds: [-180, -85, 180, 85],
    minzoom: 0,
    maxzoom: 16,
};
const GEOJSON = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { name: 'e2e' }, geometry: { type: 'Point', coordinates: [139.7, 35.6] } }],
};

function serveStyle(pathname, res) {
    if (!pathname.startsWith('/style/')) return false;
    let path;
    try {
        path = decodeURIComponent(pathname);
    } catch (_e) {
        return false;
    }
    log.push({ path, mode: null, cookie: false });
    const send = (type, body) => {
        res.writeHead(200, { ...CORS, 'content-type': type });
        res.end(body);
    };
    const json = (v) => send('application/json', JSON.stringify(v));
    const fixed = {
        '/style/basic.json': STYLE,
        '/style/tiles.json': TILEJSON,
        '/style/mapbox.json': MAPBOX_STYLE,
        '/style/mapbox-tiles.json': MAPBOX_TILEJSON,
    };
    if (Object.hasOwn(fixed, path)) {
        json(fixed[path]);
        return true;
    }
    if (path === '/style/data.geojson') {
        send('application/geo+json', JSON.stringify(GEOJSON));
        return true;
    }
    const generated = [
        [/^\/style\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/, 'application/x-protobuf', (m) => `vt:${m[1]}/${m[2]}/${m[3]}`],
        [/^\/style\/raster\/(\d+)\/(\d+)\/(\d+)\.png$/, 'image/png', (m) => `raster:${m[1]}/${m[2]}/${m[3]}`],
        [/^\/style\/fonts\/([^/]+)\/(\d+-\d+)\.pbf$/, 'application/x-protobuf', (m) => `glyph:${m[1]}:${m[2]}`],
    ];
    for (const [re, type, body] of generated) {
        const g = path.match(re);
        if (g) {
            send(type, body(g));
            return true;
        }
    }
    const m = path.match(/^\/style\/sprite(@2x)?\.(json|png)$/);
    if (m) {
        const ratio = m[1] ? 2 : 1;
        if (m[2] === 'json') json({ dot: { x: 0, y: 0, width: ratio, height: ratio, pixelRatio: ratio } });
        else send('image/png', Buffer.concat([PNG, Buffer.from([ratio])]));
        return true;
    }
    res.writeHead(404, CORS);
    res.end('Not Found');
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
    if (serveStyle(pathname, res)) return;
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
