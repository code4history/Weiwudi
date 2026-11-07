import { test, expect } from '@playwright/test';

// スタイルの芋づる登録と捕捉を実ブラウザで確かめる（m3-t9・仕様 §5.5・§10・§12）。MapLibre は依存に足さない（R15）。
// ページの blob Worker から、MapLibre 6.9.0 が出すのと同じ形の要求（スタイル → TileJSON → タイル・sprite@2x・
// {fontstack}/{range}）を fetch で出す。上流は tile-server.mjs（localhost:5174。ページは localhost:5173 で別オリジン）、
// api.mapbox.com は context.route で tile-server の /style/mapbox*.json などを返す。外部へは出ない（各テストの最後に数える）。
// WebKit・Firefox でも走らせる（m3-t10・R14'）。Chromium だけで成り立つものは @chromium-only で外し、理由をその試験に書く
const UPSTREAM = 'http://localhost:5174';
const PAGE = '/tests/e2e/fixtures/style-page.html';
const PSEUDO = 'weiwudi.example.com';
const ALLOWED_HOSTS = ['localhost:5173', 'localhost:5174'];

const STYLE_URL = `${UPSTREAM}/style/basic.json`;
const TILEJSON_URL = `${UPSTREAM}/style/tiles.json`;
const DATA_URL = `${UPSTREAM}/style/data.geojson`;
const vtTile = (z, x, y) => `${UPSTREAM}/style/tiles/${z}/${x}/${y}.pbf`;
const rasterTile = (z, x, y) => `${UPSTREAM}/style/raster/${z}/${x}/${y}.png`;
// MapLibre は fontstack をそのまま置く（空白は fetch が %20 にする）
const FONTSTACK = 'Open Sans Regular,Arial Unicode MS Regular';
const glyph = (range, base = `${UPSTREAM}/style/fonts`) => `${base}/${FONTSTACK}/${range}.pbf`;
const sprite = (file, base = `${UPSTREAM}/style/sprite`) => `${base}${file}`;

// Mapbox（実のトークンは使わない。偽の値）
const MAPBOX_TOKEN = 'pk.FAKE_E2E_TOKEN';
const MAPBOX_STYLE = 'https://api.mapbox.com/styles/v1/u/s';
const MAPBOX_TILEJSON = 'https://api.mapbox.com/v4/u.tileset.json?secure';
const MAPBOX_SPRITE = 'https://api.mapbox.com/styles/v1/u/s/sprite';
const MAPBOX_FONTS = 'https://api.mapbox.com/fonts/v1/u';
const mapboxTile = (z, x, y) => `https://api.mapbox.com/v4/u.tileset/${z}/${x}/${y}.vector.pbf`;

// 外へ出た要求を数える（C-O8）。localhost:5173・5174 は通す。api.mapbox.com は routeMapbox が先に受けるので
// ここには来ない（後に足した route が先に評価される）。疑似ホストは countPseudoHits が数える。
// 数えるのは Chromium だけ: WebKit の context.route は SW が出した要求を拾わず（O-N5）、ページの要求を SW より
// 先に受けうるので、数が意味を持たない。ほかのエンジンでは route を置かず、空の並びを返す（expectNoLeaks は素通り）
async function guardNetwork(context) {
    const external = [];
    if (test.info().project.name !== 'chromium') return { external, pseudo: [] };
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (ALLOWED_HOSTS.includes(url.host)) return route.continue();
        external.push(`${route.request().method()} ${url.origin}${url.pathname}`);
        return route.abort();
    });
    const pseudo = [];
    // 疑似ホストへの要求のうち、ネットワークへ出たものだけ（SW が受けたものはここに来ない。m2 の countPseudoHits）
    await context.route(`**://${PSEUDO}/**`, (route) => {
        pseudo.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
        return route.abort();
    });
    return { external, pseudo };
}

// 各テストの最後に呼ぶ。どちらも 0 件（C-O8。Chromium でだけ数える。guardNetwork を参照）
function expectNoLeaks(guard) {
    expect(guard.external).toEqual([]);
    expect(guard.pseudo).toEqual([]);
}

// api.mapbox.com の要求を tile-server の端点で返す。受けた URL を並べて返す（資格情報が付いたかを見る）
const MAPBOX_PATHS = [
    [/^\/styles\/v1\/u\/s$/, () => '/style/mapbox.json'],
    [/^\/v4\/u\.tileset\.json$/, () => '/style/mapbox-tiles.json'],
    [/^\/v4\/u\.tileset\/(\d+)\/(\d+)\/(\d+)\.vector\.pbf$/, (m) => `/style/tiles/${m[1]}/${m[2]}/${m[3]}.pbf`],
    [/^\/fonts\/v1\/u\/([^/]+)\/(\d+-\d+\.pbf)$/, (m) => `/style/fonts/${m[1]}/${m[2]}`],
    [/^\/styles\/v1\/u\/s\/sprite(@2x)?\.(json|png)$/, (m) => `/style/sprite${m[1] ?? ''}.${m[2]}`],
];
async function routeMapbox(context) {
    const seen = [];
    await context.route('https://api.mapbox.com/**', async (route) => {
        const url = new URL(route.request().url());
        seen.push(url.href);
        for (const [re, to] of MAPBOX_PATHS) {
            const m = url.pathname.match(re);
            if (m) {
                const response = await route.fetch({ url: `${UPSTREAM}${to(m)}` });
                return route.fulfill({ response });
            }
        }
        return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'Not Found' });
    });
    return seen;
}

async function openPage(page) {
    await page.goto(PAGE);
    await page.waitForFunction(() => window.swReady === true || window.swError, null, { timeout: 30000 });
    expect(await page.evaluate(() => window.swError ?? null)).toBeNull();
}

// 新 API で登録し、window.src に置く
async function register(page, spec) {
    const r = await page.evaluate(async (spec) => window.attempt(async () => {
        window.src = await window.Weiwudi.register(spec);
        const { id, url, resources, warnings } = window.src;
        return { id, url, resources, warnings };
    }), spec);
    expect(r).toMatchObject({ ok: true });
    return r.value;
}

const getTile = (page, url) => page.evaluate((url) => window.tile(url), url);
const byResource = (page) => page.evaluate(async () => (await window.src.stats()).byResource);
const usage = (page) => page.evaluate(() => window.Weiwudi.usage());
const resourceOf = (info, type, pred = () => true) => info.resources.find((r) => r.type === type && pred(r));

// blob Worker の中で urls を順に 2 回ずつ取る（MapLibre の Worker が出す要求の代わり）
const workerFetchTwice = (page, urls) => page.evaluate((urls) => window.inWorker(`async (urls) => {
    const first = [];
    for (const u of urls) first.push(await tile(u));
    const second = [];
    for (const u of urls) second.push(await tile(u));
    return { first, second };
}`, urls), urls);

async function upstreamLog(request, path) {
    const res = await request.get(`${UPSTREAM}/__log`);
    return (await res.json()).filter((e) => e.path === path);
}

test.describe('Weiwudi style (kind: style)', () => {
    test.beforeEach(async ({ request }) => {
        await request.get(`${UPSTREAM}/__log?reset=1`);
    });

    test('registers a style and its sub-resources', async ({ page, context }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        const src = await register(page, { kind: 'style', url: STYLE_URL });
        expect(src.url).toBe(STYLE_URL);
        expect(src.warnings).toEqual([]);
        const types = src.resources.map((r) => r.type);
        expect([...new Set(types)].sort()).toEqual(['data', 'glyph', 'sprite', 'style', 'tile', 'tilejson']);
        // タイルは TileJSON の tiles と、スタイルの tiles の 2 つ
        expect(types.filter((t) => t === 'tile')).toHaveLength(2);
        expect(resourceOf(src, 'tile', (r) => r.templates[0].includes('/style/tiles/')).templates)
            .toEqual([`${UPSTREAM}/style/tiles/{z}/{x}/{y}.pbf`]);
        // 登録と sources() が同じものを返す
        const listed = await page.evaluate(() => window.Weiwudi.sources());
        expect(listed.map((s) => [s.id, s.kind])).toEqual([[src.id, 'style']]);
        expect(listed[0].resources.map((r) => r.id).sort()).toEqual(src.resources.map((r) => r.id).sort());
        expectNoLeaks(guard);
    });

    test('serves a style and its sub-resources from a worker', async ({ page, context, request }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        await register(page, { kind: 'style', url: STYLE_URL });
        // 登録の時点でスタイルと TileJSON は保存済み（SW が自分のキャッシュを通して取った）
        const registered = [STYLE_URL, TILEJSON_URL];
        const later = [
            vtTile(3, 4, 2), rasterTile(2, 1, 1), sprite('@2x.json'), sprite('@2x.png'), sprite('.json'),
            glyph('0-255'), DATA_URL,
        ];
        const r = await workerFetchTwice(page, [...registered, ...later]);
        expect(r.ok).toBe(true);
        const { first, second } = r.value;
        for (const res of [...first, ...second]) expect(res.status, res.url).toBe(200);
        expect(first.map((res) => res.wstatus)).toEqual([...registered.map(() => 'hit'), ...later.map(() => 'miss')]);
        expect(second.map((res) => res.wstatus)).toEqual([...registered, ...later].map(() => 'hit'));
        // 本体は上流のもの（hit でも同じ）
        expect(JSON.parse(second[0].text).sources.vt.url).toBe(TILEJSON_URL);
        expect(JSON.parse(second[1].text)).toMatchObject({ tiles: [`${UPSTREAM}/style/tiles/{z}/{x}/{y}.pbf`], maxzoom: 14 });
        expect(second[2].text).toBe('vt:3/4/2');
        expect(second[3].text).toBe('raster:2/1/1');
        expect(JSON.parse(second[4].text).dot.pixelRatio).toBe(2);
        expect(second[5].tail).toBe(2);
        expect(JSON.parse(second[6].text).dot.pixelRatio).toBe(1);
        expect(second[7].text).toBe(`glyph:${FONTSTACK}:0-255`);
        expect(JSON.parse(second[8].text)).toMatchObject({ type: 'FeatureCollection' });
        // 上流へは 1 回ずつ（2 回目は保存した本体）
        for (const path of ['/style/tiles/3/4/2.pbf', '/style/sprite@2x.json', `/style/fonts/${FONTSTACK}/0-255.pbf`]) {
            expect(await upstreamLog(request, path), path).toHaveLength(1);
        }
        expectNoLeaks(guard);
    });

    // context.setOffline が SW の fetch まで切るのは Chromium でだけ確かめた（仕様 §2 の 7）
    test('serves the style offline after registering twice', { tag: '@chromium-only' }, async ({ page, context }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        const spec = { kind: 'style', url: STYLE_URL };
        const first = await register(page, spec);
        expect((await getTile(page, vtTile(2, 1, 1))).wstatus).toBe('miss');
        expect((await getTile(page, glyph('0-255'))).wstatus).toBe('miss');
        await context.setOffline(true);
        // 同じ spec での 2 回目はキャッシュを使う（オフラインでも成功する）
        const second = await register(page, spec);
        expect(second.id).toBe(first.id);
        expect(second.resources.map((r) => r.id).sort()).toEqual(first.resources.map((r) => r.id).sort());
        for (const [url, text] of [
            [STYLE_URL, null], [vtTile(2, 1, 1), 'vt:2/1/1'], [glyph('0-255'), `glyph:${FONTSTACK}:0-255`],
        ]) {
            const res = await getTile(page, url);
            expect(res.status, url).toBe(200);
            expect(res.wstatus, url).toBe('hit');
            if (text) expect(res.text).toBe(text);
        }
        // 保存していないタイルは上流へ出られない（オフラインであることの確かめ）
        expect((await getTile(page, vtTile(2, 2, 2))).status).not.toBe(200);
        expectNoLeaks(guard);
    });

    test('combines glyph ranges into one entry', async ({ page, context }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        const src = await register(page, { kind: 'style', url: STYLE_URL });
        const rid = resourceOf(src, 'glyph').id;
        for (const range of ['0-255', '256-511']) {
            const res = await getTile(page, glyph(range));
            expect(res.wstatus).toBe('miss');
            expect(res.text).toBe(`glyph:${FONTSTACK}:${range}`);
        }
        // 1 fontstack は 1 つの Entry にまとまる（仕様 §11）
        await expect.poll(async () => (await byResource(page))[rid]?.count).toBe(1);
        for (const range of ['256-511', '0-255']) {
            const res = await getTile(page, glyph(range));
            expect(res.wstatus).toBe('hit');
            expect(res.text).toBe(`glyph:${FONTSTACK}:${range}`);
        }
        expectNoLeaks(guard);
    });

    // context.setOffline が SW の fetch まで切るのは Chromium でだけ確かめた（仕様 §2 の 7）
    test('keeps entries when the tilejson is unreachable on update', { tag: '@chromium-only' }, async ({ page, context }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        const src = await register(page, { kind: 'style', url: STYLE_URL });
        const tilejson = resourceOf(src, 'tilejson').id;
        expect((await getTile(page, vtTile(4, 3, 5))).wstatus).toBe('miss');
        // 先に TileJSON の Resource を空にする（キャッシュがあると古い本体で通ってしまう。C-S5）
        await page.evaluate((rid) => window.src.removeResource(rid), tilejson);
        expect((await byResource(page))[tilejson]?.count ?? 0).toBe(0);
        await context.setOffline(true);
        const r = await page.evaluate(() => window.attempt(async () => {
            await window.src.update();
            return { warnings: window.src.warnings, resources: window.src.resources };
        }));
        expect(r).toMatchObject({ ok: true });
        expect(r.value.warnings).toContain(`fetch-failed: ${tilejson}`);
        // TileJSON の下の Resource とその Entry は残る
        expect(r.value.resources.map((x) => x.id).sort()).toEqual(src.resources.map((x) => x.id).sort());
        const tile = await getTile(page, vtTile(4, 3, 5));
        expect(tile.status).toBe(200);
        expect(tile.wstatus).toBe('hit');
        expect(tile.text).toBe('vt:4/3/5');
        expectNoLeaks(guard);
    });

    // WebKit の context.route は SW の要求を拾わず、SW が本物の api.mapbox.com へ出てしまう（O-N5）
    test('resolves mapbox urls without leaking the token', { tag: '@chromium-only' }, async ({ page, context }) => {
        const guard = await guardNetwork(context);
        const seen = await routeMapbox(context);
        await openPage(page);
        const src = await register(page, {
            kind: 'style', url: 'mapbox://styles/u/s', credentials: { query: { access_token: MAPBOX_TOKEN } },
        });
        expect(src.url).toBe(MAPBOX_STYLE);
        expect(JSON.stringify(src)).not.toContain(MAPBOX_TOKEN);
        // 登録の戻り値（url・resources のテンプレート）に mapbox:// が残らない（t9 L1 i-1）
        expect(JSON.stringify(src)).not.toContain('mapbox://');
        // MapLibre の Worker と同じ順: スタイル → ?secure の TileJSON → タイル・sprite@2x・{fontstack}/{range}
        const urls = [
            MAPBOX_STYLE, MAPBOX_TILEJSON, mapboxTile(5, 28, 12), `${MAPBOX_SPRITE}@2x.json`, `${MAPBOX_SPRITE}@2x.png`,
            glyph('0-255', MAPBOX_FONTS),
        ];
        const r = await workerFetchTwice(page, urls);
        expect(r.ok).toBe(true);
        const { first, second } = r.value;
        for (const res of [...first, ...second]) expect(res.status, res.url).toBe(200);
        expect(first.map((res) => res.wstatus)).toEqual(['hit', 'hit', 'miss', 'miss', 'miss', 'miss']);
        expect(second.map((res) => res.wstatus)).toEqual(urls.map(() => 'hit'));
        // 保存したスタイルと TileJSON には access_token も mapbox:// も無い
        for (const res of [first[0], second[0], first[1]]) {
            expect(res.text).not.toContain('access_token');
            expect(res.text).not.toContain(MAPBOX_TOKEN);
            expect(res.text).not.toContain('mapbox://');
        }
        const style = JSON.parse(second[0].text);
        expect(style.sources.m.url).toBe(MAPBOX_TILEJSON);
        expect(style.glyphs).toBe(`${MAPBOX_FONTS}/{fontstack}/{range}.pbf`);
        expect(style.sprite).toBe(MAPBOX_SPRITE);
        expect(second[2].text).toBe('vt:5/28/12');
        expect(second[5].text).toBe(`glyph:${FONTSTACK}:0-255`);
        // api.mapbox.com への要求には、SW が付けた資格情報がある（上流へは 1 回ずつ）
        const paths = seen.map((u) => new URL(u).pathname);
        expect(paths).toEqual(expect.arrayContaining([
            '/styles/v1/u/s', '/v4/u.tileset.json', '/v4/u.tileset/5/28/12.vector.pbf',
            '/styles/v1/u/s/sprite@2x.json', '/styles/v1/u/s/sprite@2x.png',
        ]));
        expect(new Set(paths).size).toBe(paths.length);
        for (const u of seen) expect(new URL(u).searchParams.get('access_token'), u).toBe(MAPBOX_TOKEN);
        expect(new URL(seen.find((u) => u.includes('/v4/u.tileset.json'))).searchParams.has('secure')).toBe(true);
        expectNoLeaks(guard);
    });

    test('removes a resource and keeps capturing it', async ({ page, context, request }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        const src = await register(page, { kind: 'style', url: STYLE_URL });
        const rid = resourceOf(src, 'tile', (r) => r.templates[0].includes('/style/tiles/')).id;
        const url = vtTile(6, 10, 20);
        expect((await getTile(page, url)).wstatus).toBe('miss');
        expect((await getTile(page, url)).wstatus).toBe('hit');
        await expect.poll(async () => (await byResource(page))[rid]?.count).toBe(1);
        const before = await usage(page);
        await page.evaluate((rid) => window.src.removeResource(rid), rid);
        expect((await byResource(page))[rid]?.count ?? 0).toBe(0);
        const removed = await usage(page);
        expect(removed.count).toBe(before.count - 1);
        // 記録と捕捉は残る: 次の要求は取り直して保存する
        const again = await getTile(page, url);
        expect(again.wstatus).toBe('miss');
        expect(again.text).toBe('vt:6/10/20');
        expect(await upstreamLog(request, '/style/tiles/6/10/20.pbf')).toHaveLength(2);
        expect((await getTile(page, url)).wstatus).toBe('hit');
        await expect.poll(async () => (await usage(page)).count).toBe(before.count);
        // 名指ししない Resource は消えない
        expect((await getTile(page, glyph('0-255'))).wstatus).toBe('miss');
        expect((await getTile(page, glyph('0-255'))).wstatus).toBe('hit');
        // 持っていない id は resource-not-found
        const missing = await page.evaluate(() => window.attempt(() => window.src.removeResource('no-such-resource')));
        expect(missing).toMatchObject({ ok: false, code: 'resource-not-found' });
        expectNoLeaks(guard);
    });

    // WebKit の context.route は SW の要求を拾わず、SW が本物の api.mapbox.com へ出てしまう（O-N5）
    test('reports usage by provider', { tag: '@chromium-only' }, async ({ page, context }) => {
        const guard = await guardNetwork(context);
        await routeMapbox(context);
        await openPage(page);
        await register(page, { kind: 'style', url: STYLE_URL });
        await register(page, { kind: 'style', url: 'mapbox://styles/u/s', credentials: { query: { access_token: MAPBOX_TOKEN } } });
        expect((await getTile(page, vtTile(1, 1, 1))).wstatus).toBe('miss');
        expect((await getTile(page, mapboxTile(1, 0, 0))).wstatus).toBe('miss');
        const report = await usage(page);
        // 鍵は提供元（mapbox）か、最初のテンプレートの origin（C-O12）
        expect(Object.keys(report.byProvider).sort()).toEqual(['http://localhost:5174', 'mapbox']);
        expect(report.byProvider['http://localhost:5174'].count).toBeGreaterThan(0);
        expect(report.byProvider.mapbox.count).toBeGreaterThan(0);
        const sum = Object.values(report.byProvider).reduce((a, p) => ({ count: a.count + p.count, bytes: a.bytes + p.bytes }), { count: 0, bytes: 0 });
        expect(sum).toEqual({ count: report.count, bytes: report.bytes });
        // 制御の POST は、blob Worker・同じオリジンの iframe・srcdoc の iframe からも通る（I6・t8 の申し送り）
        const fromWorker = await page.evaluate(() => window.inWorker('async () => control("usage", {})', null));
        expect(fromWorker, 'from a blob worker').toEqual({ ok: true, value: { ok: true, result: report } });
        const fromIframe = await page.evaluate(() => window.inIframe('usage', {}));
        expect(fromIframe, 'from a same-origin iframe').toEqual({ controlled: true, value: { ok: true, result: report } });
        const fromSrcdoc = await page.evaluate(() => window.inSrcdoc('usage', {}));
        expect(fromSrcdoc, 'from a srcdoc iframe').toMatchObject({ ok: true, href: 'about:srcdoc', controlled: true, value: { ok: true, result: report } });
        expectNoLeaks(guard);
    });

    test('registers an asset', async ({ page, context }) => {
        const guard = await guardNetwork(context);
        await openPage(page);
        const src = await register(page, { kind: 'asset', url: DATA_URL });
        expect(src.url).toBe(DATA_URL);
        expect(src.resources.map((r) => r.type)).toEqual(['data']);
        const first = await getTile(page, DATA_URL);
        expect(first.status).toBe(200);
        expect(first.wstatus).toBe('miss');
        const second = await getTile(page, DATA_URL);
        expect(second.wstatus).toBe('hit');
        expect(JSON.parse(second.text)).toMatchObject({ type: 'FeatureCollection' });
        expect(second.text).toBe(first.text);
        expectNoLeaks(guard);
    });
});
