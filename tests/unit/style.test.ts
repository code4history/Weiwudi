// スタイルの芋づる登録（m3-t7・仕様 §5.5・§5.6・§10・§12・R1〜R5・R10・R30・R33〜R35・P2・C-S2・C-S5・C-S6・X2・X3・S-N1・C-O11）。
// ハーネスの SW（標準の mapbox を持つ配線）の制御（/v2/*）と照合ルートを通し、上流は偽の fetch で返す。実ネットワーク・実トークンは使わない。
// 途中の書き込みの失敗（R30）だけは registerStyle を直接呼ぶ（ハーネスの store を spy できないため）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createSwHarness, SW_SELF_ORIGIN, type SwHarness } from './sw-harness';
import { openStore, type ResourceMeta, type Store } from '../../src/store';
import { createContext } from '../../src/context';
import { normalizeSpec, type NormalizedStyle } from '../../src/spec';
import { registerStyle } from '../../src/style';
import { _resetPluginsForTest } from '../../src/plugins';

afterEach(() => {
  _resetPluginsForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const TOKEN = 'pk.FAKE_STYLE_TOKEN';
const STYLE = 'https://s.example/styles/st.json';
const TJ = 'https://s.example/tiles/tj.json';
const VT = 'https://t.example/{z}/{x}/{y}.pbf';
const TJ_TILES = 'https://tj.example/{z}/{x}/{y}.pbf';
const GLYPHS = 'https://g.example/fonts/{fontstack}/{range}.pbf';
const SPRITE = 'https://s.example/sprites/s';
const DATA = 'https://d.example/points.geojson';
const IMAGE = 'https://i.example/a.png';

const json = (body: unknown, type = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': type } });
const bin = (type = 'application/x-protobuf') =>
  new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': type } });

const styleOf = (sources: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ version: 8, sources, layers: [], ...over });

const FULL = styleOf({
  tj: { type: 'vector', url: TJ },
  vt: { type: 'vector', tiles: [VT] },
  gj: { type: 'geojson', data: DATA },
  img: { type: 'image', url: IMAGE, coordinates: [[0, 0], [1, 0], [1, 1], [0, 1]] },
}, { glyphs: GLYPHS, sprite: SPRITE });

const TILEJSON = { tilejson: '3.0.0', tiles: [TJ_TILES], bounds: [139, 35, 140, 36], minzoom: 2, maxzoom: 10, scheme: 'tms' };

/** 偽の上流。オリジン＋パスで本体を引く（クエリは見ない）。無ければタイルの本体。offline で TypeError */
interface Upstream {
  bodies: Map<string, () => Response>;
  offline: boolean;
  /** 上流へ出た要求の URL（記録順） */
  urls: () => string[];
}

const upstreamOf = (h: SwHarness, bodies: Record<string, unknown> = {}): Upstream => {
  const up: Upstream = {
    bodies: new Map(Object.entries(bodies).map(([k, v]) => [k, typeof v === 'function' ? v as () => Response : () => json(v)])),
    offline: false,
    urls: () => h.fetch.mock.calls.map((c) => (c[0] as Request).url),
  };
  h.fetch.mockImplementation(async (req: Request) => {
    if (up.offline) throw new TypeError('Failed to fetch');
    const u = new URL(req.url);
    const f = up.bodies.get(u.origin + u.pathname);
    return f ? f() : bin();
  });
  return up;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string; detail: Record<string, unknown> } };

const call = async (h: SwHarness, op: string, body: unknown = {}): Promise<Reply> => (await h.post(`/v2/${op}`, body))!.json();

const ok = async (h: SwHarness, op: string, body: unknown = {}) => {
  const r = await call(h, op, body);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.result;
};

const fails = async (h: SwHarness, op: string, body: unknown, code: string) => {
  const r = await call(h, op, body);
  expect(r.ok).toBe(false);
  expect(r.error!.code).toBe(code);
  return r.error!;
};

const get = async (h: SwHarness, url: string): Promise<Response> => {
  await h.flushRoutes();
  return (await h.dispatch(url))!;
};

/** 子の id（\0 の区切り） */
const childId = (parent: string, rest: string) => `${parent}\u0000${rest}`;

/** 全部の状態の写し（何も変わらないことを比べる） */
const snapshot = async (store: Store) => {
  const sources = await store.listSources();
  const resources = (await store.listResources()).sort((a, b) => (a.id < b.id ? -1 : 1));
  const credentials = await Promise.all(sources.map(async (s) => [s.id, await store.getCredentials(s.id)]));
  const entries = await Promise.all(resources.map(async (r) => [r.id, r.count]));
  return { sources, resources, credentials, entries };
};

const setup = async (bodies: Record<string, unknown> = {}) => {
  const h = createSwHarness();
  const up = upstreamOf(h, bodies);
  const store = await openStore();
  return { h, up, store };
};

describe('芋づる（§5.5-2・3）', () => {
  it('url（TileJSON）・tiles・glyphs・sprite・geojson の data・image が全部 Resource になり、source.resources の型が揃う', async () => {
    const { h } = await setup({ [STYLE]: FULL, [TJ]: TILEJSON });
    const info = await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    expect(info).toMatchObject({ id: 'st', kind: 'style', url: STYLE, warnings: [] });
    const types = info.resources.map((r: { type: string }) => r.type).sort();
    expect(types).toEqual(['data', 'data', 'glyph', 'sprite', 'style', 'tile', 'tile', 'tilejson']);
    const ids = info.resources.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining([STYLE, TJ, VT, TJ_TILES, GLYPHS, `${SPRITE}{spriteSuffix}`, DATA, IMAGE]));
  });

  it('捕捉: 登録の後のページの要求（タイル・グリフ・スプライト・data）が hit/miss で保存される', async () => {
    const { h, store } = await setup({ [STYLE]: FULL, [TJ]: TILEJSON });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    for (const u of ['https://t.example/1/0/0.pbf', 'https://g.example/fonts/Noto%20Sans/0-255.pbf', `${SPRITE}@2x.png`, DATA, IMAGE]) {
      expect((await get(h, u)).headers.get('x-weiwudi-status')).toBe('miss');
    }
    expect((await store.getResource(VT))!.count).toBe(1);
    expect((await store.getResource(`${SPRITE}{spriteSuffix}`))!.count).toBe(1);
  });

  it('TileJSON の bounds・scheme: tms・minzoom/maxzoom が範囲になる（tms の上下。直接の vector 登録と同じ箱）', async () => {
    const { h, store } = await setup({ [STYLE]: FULL, [TJ]: TILEJSON });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    const r = (await store.getResource(TJ_TILES))!;
    expect(r.scheme).toBe('tms');
    const want = normalizeSpec({ kind: 'vector', url: TJ_TILES, bounds: [139, 35, 140, 36], minZoom: 2, maxZoom: 10, scheme: 'tms' })
      .spec as { extent: { box: unknown } };
    expect(r.extents).toHaveLength(1);
    expect(r.extents![0]).toMatchObject({ minZoom: 2, maxZoom: 10, box: want.extent.box });
    // ズームの外は範囲外（ベクタは空本体。R29）
    const out = await get(h, 'https://tj.example/1/0/0.pbf');
    expect(out.headers.get('x-weiwudi-status')).toBe('out-of-range');
    expect((await out.arrayBuffer()).byteLength).toBe(0);
  });

  it('スタイルの source の範囲の項目は TileJSON の値に勝つ（MapLibre と同じ）。bounds があって maxzoom が無ければ 30（U1）', async () => {
    const style = styleOf({ tj: { type: 'raster', url: TJ, minzoom: 4 }, b: { type: 'raster', tiles: [VT.replace('pbf', 'png')], bounds: [0, 0, 1, 1] } });
    const { h, store } = await setup({ [STYLE]: style, [TJ]: { tiles: [TJ_TILES], minzoom: 2, maxzoom: 9 } });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    expect((await store.getResource(TJ_TILES))!.extents![0]).toMatchObject({ minZoom: 4, maxZoom: 9 });
    expect((await store.getResource(VT.replace('pbf', 'png')))!.extents![0]).toMatchObject({ minZoom: 0, maxZoom: 30 });
  });

  it('子は利用者に見えない: sources() に出ず、source(子の id) は source-not-found', async () => {
    const { h } = await setup({ [STYLE]: FULL, [TJ]: TILEJSON });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    expect((await ok(h, 'sources')).map((s: { id: string }) => s.id)).toEqual(['st']);
    await fails(h, 'source', { id: childId('st', 'style:style') }, 'source-not-found');
    await fails(h, 'source', { id: childId('st', 'tile:vt') }, 'source-not-found');
  });

  it('stats は子の Resource を併せて数え、total・percent を出さない', async () => {
    const { h } = await setup({ [STYLE]: FULL, [TJ]: TILEJSON });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    await get(h, 'https://t.example/1/0/0.pbf');
    const s = await ok(h, 'stats', { id: 'st' });
    expect(s.count).toBe(3);
    expect(s.total).toBeUndefined();
    expect(s.percent).toBeUndefined();
    expect(s.byResource[VT]).toEqual({ count: 1, bytes: 3 });
  });

  it('video と知らない type は unsupported-source。Mapbox の imports は unsupported-source: imports', async () => {
    const style = styleOf({ v: { type: 'video', urls: ['https://v.example/a.mp4'] }, c: { type: 'custom' } },
      { imports: [{ id: 'basemap', url: 'mapbox://styles/mapbox/standard' }] });
    const { h } = await setup({ [STYLE]: style });
    const info = await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    expect(info.warnings).toEqual(['unsupported-source: sources.v', 'unsupported-source: sources.c', 'unsupported-source: imports']);
  });
});

describe('オフラインと update()（§5.5-1・6・R3・R4・C-S5）', () => {
  it('オフラインで同じ register を繰り返しても成功し、子が変わらない（2 回目はスタイルも TileJSON も hit）', async () => {
    const { h, up, store } = await setup({ [STYLE]: FULL, [TJ]: TILEJSON });
    const first = await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    const before = await store.getSource('st');
    up.offline = true;
    h.fetch.mockClear();
    const again = await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(again.resources).toEqual(first.resources);
    expect((await store.getSource('st'))!.spec).toEqual(before!.spec);
    expect(again.warnings).toEqual([]);
  });

  it('オフラインの update(): TileJSON の Entry が無ければ fetch-failed、その下のタイルの子と Entry は残る（R3・C-S5）', async () => {
    const { h, up, store } = await setup({ [STYLE]: FULL, [TJ]: TILEJSON });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    expect((await get(h, 'https://tj.example/3/7/4.pbf')).headers.get('x-weiwudi-status')).toBe('miss');
    await store.clearEntries(TJ);
    up.offline = true;
    const info = await ok(h, 'update', { id: 'st' });
    expect(info.warnings).toEqual([`fetch-failed: ${TJ}`]);
    expect(info.resources.map((r: { id: string }) => r.id)).toContain(TJ_TILES);
    expect((await store.getResource(TJ_TILES))!.count).toBe(1);
    expect(await store.getSource(childId('st', 'tile:tj/tiles'))).toBeDefined();
  });

  it('C-S5: TileJSON の Entry があるままオフラインで update() → stale の本体で進み、fetch-failed が出ない', async () => {
    const { h, up } = await setup({ [STYLE]: FULL, [TJ]: TILEJSON });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    up.offline = true;
    const info = await ok(h, 'update', { id: 'st' });
    expect(info.warnings).toEqual([]);
    expect(info.resources.map((r: { id: string }) => r.id)).toContain(TJ_TILES);
  });

  it('update() は上流で取り直し（revalidate）、参照が消えた子が外れて Entry ごと消える', async () => {
    const { h, up, store } = await setup({ [STYLE]: FULL, [TJ]: TILEJSON });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    await get(h, 'https://t.example/1/0/0.pbf');
    expect((await store.getResource(VT))!.count).toBe(1);
    up.bodies.set(STYLE, () => json(styleOf({ tj: { type: 'vector', url: TJ } })));
    h.fetch.mockClear();
    const info = await ok(h, 'update', { id: 'st' });
    expect(up.urls()).toContain(STYLE);
    expect(up.urls()).toContain(TJ);
    expect(await store.getResource(VT)).toBeUndefined();
    expect(await store.getSource(childId('st', 'tile:vt'))).toBeUndefined();
    expect(info.resources.map((r: { id: string }) => r.id).sort()).toEqual([STYLE, TJ, TJ_TILES].sort());
    // register は TTL 内なら取り直さない（R4）
    h.fetch.mockClear();
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('update() は子の Resource の CORS の判定をやり直す（corsOk・corslessUntil を消す。§4.5）', async () => {
    const { h, store } = await setup({ [STYLE]: FULL, [TJ]: TILEJSON });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    await store.patchResource(VT, (m) => ({ ...m, corsOk: true, corslessUntil: Date.now() + 1000 }));
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    expect((await store.getResource(VT))!.corsOk).toBe(true);
    await ok(h, 'update', { id: 'st' });
    const r = (await store.getResource(VT))!;
    expect(r.corsOk).toBeUndefined();
    expect(r.corslessUntil).toBeUndefined();
  });

  it('一部の取得に失敗しても登録は成功し、warnings に fetch-failed', async () => {
    const { h } = await setup({ [STYLE]: FULL, [TJ]: () => new Response('no', { status: 500 }) });
    const info = await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    expect(info.warnings).toEqual([`fetch-failed: ${TJ}`]);
    expect(info.resources.map((r: { id: string }) => r.id)).toContain(VT);
  });
});

describe('読めないスタイルと巻き戻し（R30・R33）', () => {
  it('新しい登録でスタイルが読めなければ invalid-style で、何も残らない', async () => {
    const { h, store } = await setup({ [STYLE]: () => json('<html>login</html>', 'text/html') });
    const e = await fails(h, 'register', { kind: 'style', id: 'st', url: STYLE, credentials: { query: { access_token: TOKEN } } }, 'invalid-style');
    expect(e.message).not.toContain(TOKEN);
    expect(await store.listSources()).toEqual([]);
    expect(await store.listResources()).toEqual([]);
    expect(await store.getCredentials('st')).toBeUndefined();
    expect(await store.getCredentials(childId('st', 'style:style'))).toBeUndefined();
  });

  it('新しい登録の上流がオフラインでも invalid-style で、何も残らない', async () => {
    const { h, up, store } = await setup({ [STYLE]: FULL });
    up.offline = true;
    await fails(h, 'register', { kind: 'style', id: 'st', url: STYLE }, 'invalid-style');
    expect(await store.listSources()).toEqual([]);
    expect(await store.listResources()).toEqual([]);
  });

  it('新しい登録が途中（段 C の子の書き込み）で失敗したら、元の例外で reject し何も残らない', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('fetch', vi.fn(async (req: Request) => {
      const u = new URL(req.url);
      if (u.origin + u.pathname === STYLE) return json(FULL);
      if (u.origin + u.pathname === TJ) return json(TILEJSON);
      return bin();
    }));
    const store = await openStore();
    const ctx = createContext({ open: async () => store });
    const glyphChild = childId('st', 'glyph:glyphs');
    const real = store.putSource.bind(store);
    const boom = new DOMException('disk', 'UnknownError');
    vi.spyOn(store, 'putSource').mockImplementation(async (rec) => {
      if (rec.id === glyphChild) throw boom;
      return real(rec);
    });
    const input = normalizeSpec({ kind: 'style', id: 'st', url: STYLE, credentials: { query: { access_token: TOKEN } } }) as NormalizedStyle;
    await expect(registerStyle(ctx, input, { mode: 'register' })).rejects.toBe(boom);
    expect(await store.listSources()).toEqual([]);
    expect(await store.listResources()).toEqual([]);
    for (const id of ['st', childId('st', 'style:style'), childId('st', 'tile:vt')]) expect(await store.getCredentials(id)).toBeUndefined();
  });

  it('既存の登録の update() で invalid-style（HTML・Entry も無い）なら、親・子・資格情報・CORS の印が呼ぶ前と同じ', async () => {
    const { h, up, store } = await setup({ [STYLE]: FULL, [TJ]: TILEJSON });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE, credentials: { query: { access_token: TOKEN } } });
    await store.clearEntries(STYLE);
    await store.patchResource(VT, (m) => ({ ...m, corslessUntil: Date.now() + 1000 }));
    const before = await snapshot(store);
    up.bodies.set(STYLE, () => json('<html>login</html>', 'text/html'));
    await fails(h, 'update', { id: 'st' }, 'invalid-style');
    expect(await snapshot(store)).toEqual(before);
  });

  it('同じ id の再登録でスタイルの URL を替え、新しい URL が読めなければ何も変わらない', async () => {
    const { h, up, store } = await setup({ [STYLE]: FULL, [TJ]: TILEJSON });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    const before = await snapshot(store);
    const other = 'https://s.example/styles/other.json';
    up.bodies.set(other, () => json({ not: 'a style' }));
    await fails(h, 'register', { kind: 'style', id: 'st', url: other }, 'invalid-style');
    expect(await snapshot(store)).toEqual(before);
  });

  it('同じ id で kind を替えた登録は attribute-invalid（R37）', async () => {
    const { h } = await setup({ [STYLE]: FULL, [TJ]: TILEJSON });
    await ok(h, 'register', { kind: 'raster', id: 'st', url: VT.replace('pbf', 'png') });
    await fails(h, 'register', { kind: 'style', id: 'st', url: STYLE }, 'attribute-invalid');
    await ok(h, 'register', { kind: 'style', id: 'st2', url: STYLE });
    await fails(h, 'register', { kind: 'raster', id: 'st2', url: VT.replace('pbf', 'png') }, 'attribute-invalid');
  });
});

describe('同じオリジンの検査（§5.5-5・R35・C-S2・C-S6・X3）', () => {
  const SELF = SW_SELF_ORIGIN;

  it('別オリジンのスタイルが SW と同じオリジンを指す → その子が無く same-origin-skipped（subject はクエリの無い URL）', async () => {
    const style = styleOf({ api: { type: 'raster', tiles: [`${SELF}/api/{z}/{x}/{y}.png?v=1`] }, ok: { type: 'raster', tiles: ['https://t.example/{z}/{x}/{y}.png'] } },
      { glyphs: `${SELF}/fonts/{fontstack}/{range}.pbf` });
    const { h, store } = await setup({ [STYLE]: style });
    const info = await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    expect(info.warnings).toEqual([
      `same-origin-skipped: ${SELF}/api/{z}/{x}/{y}.png`,
      `same-origin-skipped: ${SELF}/fonts/{fontstack}/{range}.pbf`,
    ]);
    expect(await store.getSource(childId('st', 'tile:api'))).toBeUndefined();
    expect(await store.getSource(childId('st', 'tile:ok'))).toBeDefined();
  });

  it('SW と同じオリジンのスタイルは同じオリジンの子を作る', async () => {
    const own = `${SELF}/styles/own.json`;
    const { h, store } = await setup({ [own]: styleOf({ api: { type: 'raster', tiles: [`${SELF}/api/{z}/{x}/{y}.png`] } }) });
    const info = await ok(h, 'register', { kind: 'style', id: 'st', url: own });
    expect(info.warnings).toEqual([]);
    expect(await store.getSource(childId('st', 'tile:api'))).toBeDefined();
  });

  it('C-S2: 同じオリジンのスタイルが別オリジンの TileJSON を指し、その tiles が SW と同じオリジン → タイルの子が無く same-origin-skipped', async () => {
    const own = `${SELF}/styles/own.json`;
    const { h, store } = await setup({
      [own]: styleOf({ x: { type: 'vector', url: TJ } }),
      [TJ]: { tiles: [`${SELF}/v/{z}/{x}/{y}.pbf`] },
    });
    const info = await ok(h, 'register', { kind: 'style', id: 'st', url: own });
    expect(info.warnings).toEqual([`same-origin-skipped: ${SELF}/v/{z}/{x}/{y}.pbf`]);
    expect(await store.getSource(childId('st', 'tile:x/tiles'))).toBeUndefined();
    expect(await store.getSource(childId('st', 'tilejson:x'))).toBeDefined();
  });

  it('C-S6・X3: 子にしない URL の ?foo=sk.abc・?foo=%73k.abc は subject に出ない。パスに sk.eyJ… を持つ URL は sources.<名前>', async () => {
    const { h } = await setup({
      [STYLE]: styleOf({ a: { type: 'vector', url: TJ }, b: { type: 'vector', url: 'https://s.example/tiles/b.json' }, c: { type: 'vector', url: 'https://s.example/tiles/c.json' } }),
      [TJ]: { tiles: [`${SELF}/a/{z}/{x}/{y}.pbf?foo=sk.abc`] },
      'https://s.example/tiles/b.json': { tiles: [`${SELF}/b/{z}/{x}/{y}.pbf?foo=%73k.abc`] },
      'https://s.example/tiles/c.json': { tiles: [`${SELF}/sk.eyJsecret/{z}/{x}/{y}.pbf`] },
    });
    const info = await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    expect(info.warnings).toEqual([
      `same-origin-skipped: ${SELF}/a/{z}/{x}/{y}.pbf`,
      `same-origin-skipped: ${SELF}/b/{z}/{x}/{y}.pbf`,
      'same-origin-skipped: sources.c',
    ]);
    const all = JSON.stringify(info.warnings);
    expect(all).not.toContain('sk.');
    expect(all).not.toContain('%73k');
  });
});

describe('資格情報の配り先（R5・X2・S-N1・§10）', () => {
  it('第三者のスタイル（a.example）が b.example のタイルを指すとき、b.example への要求に親の access_token が付かず、a.example には付く', async () => {
    const A = 'https://a.example/style.json';
    const { h, up } = await setup({
      [A]: styleOf({ a: { type: 'raster', tiles: ['https://a.example/{z}/{x}/{y}.png'] }, b: { type: 'raster', tiles: ['https://b.example/{z}/{x}/{y}.png'] } }),
    });
    await ok(h, 'register', { kind: 'style', id: 'st', url: A, credentials: { query: { access_token: TOKEN } } });
    h.fetch.mockClear();
    await get(h, 'https://a.example/1/0/0.png');
    await get(h, 'https://b.example/1/0/0.png');
    const [toA, toB] = up.urls();
    expect(toA).toBe(`https://a.example/1/0/0.png?access_token=${TOKEN}`);
    expect(toB).toBe('https://b.example/1/0/0.png');
  });

  it('X2: 子のミラーが a.example（スタイルと同じオリジン）と c.example のとき、その子の資格情報は {} で、どちらのミラーにも付かない', async () => {
    const A = 'https://a.example/style.json';
    const { h, up, store } = await setup({
      [A]: styleOf({ m: { type: 'raster', tiles: ['https://a.example/m/{z}/{x}/{y}.png', 'https://c.example/m/{z}/{x}/{y}.png'] } }),
    });
    await ok(h, 'register', { kind: 'style', id: 'st', url: A, credentials: { query: { access_token: TOKEN } } });
    expect((await store.getCredentials(childId('st', 'tile:m'))) ?? {}).toEqual({});
    h.fetch.mockClear();
    await get(h, 'https://a.example/m/1/0/0.png');
    await get(h, 'https://c.example/m/1/0/0.png');
    expect(up.urls().join(' ')).not.toContain(TOKEN);
  });

  it('S-N1: 同じ子で、本体の a.example のミラーの ?access_token= が保存した本体に残り、ページがその URL のとおりに出した要求に付いて上流へ出る（キーには残らない）', async () => {
    const A = 'https://a.example/style.json';
    const { h, up, store } = await setup({
      [A]: styleOf({ m: { type: 'raster', tiles: [`https://a.example/m/{z}/{x}/{y}.png?access_token=${TOKEN}`, 'https://c.example/m/{z}/{x}/{y}.png'] } }),
    });
    await ok(h, 'register', { kind: 'style', id: 'st', url: A, credentials: { query: { access_token: TOKEN } } });
    const saved = await store.getEntry(`${A}\u0000`);
    const body = JSON.parse(await saved!.body.blob.text());
    expect(body.sources.m.tiles[0]).toBe(`https://a.example/m/{z}/{x}/{y}.png?access_token=${TOKEN}`);
    h.fetch.mockClear();
    const res = await get(h, `https://a.example/m/1/0/0.png?access_token=${TOKEN}`);
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(up.urls()).toEqual([`https://a.example/m/1/0/0.png?access_token=${TOKEN}`]);
    const rid = 'https://a.example/m/{z}/{x}/{y}.png';
    expect(await store.getEntry(`${rid}\u00001_0_0`)).toBeDefined();
    expect((await store.listResources()).map((r) => r.id).join(' ')).not.toContain(TOKEN);
  });

  it('子のテンプレートに載っていた資格情報の値は、同じ名前の親の値に勝つ（t6 の申し送り）', async () => {
    const A = 'https://a.example/style.json';
    const { h, store } = await setup({
      [A]: styleOf({ k: { type: 'raster', tiles: ['https://b.example/{z}/{x}/{y}.png?key=own'] } }),
    });
    await ok(h, 'register', { kind: 'style', id: 'st', url: A, credentials: { query: { key: 'parent' } } });
    // b.example は配る相手でないので、子は自分の値だけ
    expect(await store.getCredentials(childId('st', 'tile:k'))).toEqual({ query: { key: 'own' } });
  });

  it('O-N2: 再登録でスタイルの URL を替えて前の Resource に当たらないときも、取得の本体は新しい正規化の親と資格情報で除き、子に親の値が配られる', async () => {
    const A = 'https://a.example/style.json';
    const A2 = 'https://a.example/style2.json';
    const body = styleOf({ m: { type: 'raster', tiles: ['https://a.example/m/{z}/{x}/{y}.png?access_token=pk.PAGE'] } });
    const { h, store } = await setup({ [A]: styleOf({}), [A2]: body });
    await ok(h, 'register', { kind: 'style', id: 'st', url: A });
    await ok(h, 'register', { kind: 'style', id: 'st', url: A2, credentials: { query: { access_token: TOKEN } } });
    // 除いていなければテンプレートの pk.PAGE が子のもの（子の値が勝つ）になる
    expect(await store.getCredentials(childId('st', 'tile:m'))).toEqual({ query: { access_token: TOKEN } });
  });

  it('O-N4: 保存したスタイルが新しいうちに再登録で資格情報を足すと、本体のトークンが残り、その値が子のもの（子のテンプレートの値が親の値に勝つ）', async () => {
    const A = 'https://a.example/style.json';
    const { h, store } = await setup({
      [A]: styleOf({ m: { type: 'raster', tiles: ['https://a.example/m/{z}/{x}/{y}.png?access_token=pk.PAGE'] } }),
    });
    await ok(h, 'register', { kind: 'style', id: 'st', url: A });
    await ok(h, 'register', { kind: 'style', id: 'st', url: A, credentials: { query: { access_token: TOKEN } } });
    // 2 回目は hit（除かれていない本体）。配る相手の子でも、テンプレートに載っていた値が勝つ
    expect(await store.getCredentials(childId('st', 'tile:m'))).toEqual({ query: { access_token: 'pk.PAGE' } });
    expect(await store.getCredentials('st')).toEqual({ query: { access_token: TOKEN } });
  });

  it('組が 1 つでも子にできない source は丸ごと子にしない（url の TileJSON も作らない。本体の除去と同じ組。Minor-3）', async () => {
    const A = 'https://a.example/style.json';
    const tiles = ['https://a.example/m/{z}/{x}/{y}.png?access_token=pk.ONE', 'https://a.example/n/{z}/{x}/{y}.png?access_token=pk.TWO'];
    const { h, store } = await setup({ [A]: styleOf({ m: { type: 'raster', url: 'https://a.example/m.json', tiles } }) });
    const info = await ok(h, 'register', { kind: 'style', id: 'st', url: A });
    expect(info.warnings).toEqual(['unsupported-source: sources.m']);
    expect(await store.getSource(childId('st', 'tilejson:m'))).toBeUndefined();
  });

  it('R22: ミラーの間で資格情報の値が違う組は子にせず unsupported-source、本体の資格情報も除かない（子作りと除去で揃える）', async () => {
    const A = 'https://a.example/style.json';
    const tiles = ['https://a.example/m/{z}/{x}/{y}.png?access_token=pk.ONE', 'https://a.example/n/{z}/{x}/{y}.png?access_token=pk.TWO'];
    const { h, store } = await setup({ [A]: styleOf({ m: { type: 'raster', tiles } }) });
    const info = await ok(h, 'register', { kind: 'style', id: 'st', url: A, credentials: { query: { access_token: TOKEN } } });
    expect(info.warnings).toEqual(['unsupported-source: sources.m']);
    expect(await store.getSource(childId('st', 'tile:m'))).toBeUndefined();
    const saved = JSON.parse(await (await store.getEntry(`${A}\u0000`))!.body.blob.text());
    expect(saved.sources.m.tiles).toEqual(tiles);
  });

  it('mapbox://styles/u/s で登録 → source.url が https・保存した本体に mapbox:// が無く、本体の Mapbox の URL に access_token が無い', async () => {
    const { h, up, store } = await setup({
      'https://api.mapbox.com/styles/v1/u/s': styleOf(
        { m: { type: 'vector', url: `mapbox://mapbox.mapbox-streets-v8?access_token=${TOKEN}` } },
        { glyphs: 'mapbox://fonts/u/{fontstack}/{range}.pbf', sprite: 'mapbox://sprites/u/s' },
      ),
      'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8.json': { tiles: [`https://a.tiles.mapbox.com/v4/mapbox.mapbox-streets-v8/{z}/{x}/{y}.vector.pbf?access_token=${TOKEN}`] },
    });
    const info = await ok(h, 'register', { kind: 'style', id: 'mb', url: 'mapbox://styles/u/s', credentials: { query: { access_token: TOKEN } } });
    expect(info.url).toBe('https://api.mapbox.com/styles/v1/u/s');
    const text = await (await store.getEntry('https://api.mapbox.com/styles/v1/u/s\u0000'))!.body.blob.text();
    expect(text).not.toContain('mapbox://');
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).sources.m.url).toBe('https://api.mapbox.com/v4/mapbox.mapbox-streets-v8.json?secure');
    // TileJSON は ?secure の形で取り、上流の要求にだけトークンが付く
    expect(up.urls()).toContain(`https://api.mapbox.com/v4/mapbox.mapbox-streets-v8.json?secure&access_token=${TOKEN}`);
    const tj = await (await store.getEntry('https://api.mapbox.com/v4/mapbox.mapbox-streets-v8.json?secure\u0000'))!.body.blob.text();
    expect(tj).not.toContain(TOKEN);
    // タイル（a.tiles.mapbox.com は提供元の matches に当たる）の要求にトークンが付く（C-O2・R5）
    h.fetch.mockClear();
    await get(h, 'https://a.tiles.mapbox.com/v4/mapbox.mapbox-streets-v8/1/0/0.vector.pbf');
    expect(up.urls()).toEqual([`https://a.tiles.mapbox.com/v4/mapbox.mapbox-streets-v8/1/0/0.vector.pbf?access_token=${TOKEN}`]);
    expect(JSON.stringify(info)).not.toContain(TOKEN);
  });

  it('資格情報が id・warnings・resources・エラー文面に出ない（総当たり）', async () => {
    const A = 'https://a.example/style.json';
    const { h, store } = await setup({
      [A]: styleOf({
        a: { type: 'raster', tiles: [`https://a.example/{z}/{x}/{y}.png?access_token=${TOKEN}`] },
        b: { type: 'raster', tiles: [`https://b.example/{z}/{x}/{y}.png?access_token=${TOKEN}`] },
        c: { type: 'vector', url: `https://c.example/tj.json?access_token=${TOKEN}` },
        d: { type: 'raster', tiles: [`https://a.example/u:p@/{z}/{x}/{y}.png?access_token=${TOKEN}`, `https://a.example/q/{z}/{x}/{y}.png?access_token=pk.X`] },
      }, { glyphs: `${SW_SELF_ORIGIN}/f/{fontstack}/{range}.pbf?access_token=${TOKEN}` }),
      'https://c.example/tj.json': () => new Response('x', { status: 500 }),
    });
    const info = await ok(h, 'register', { kind: 'style', id: 'st', url: `${A}?access_token=${TOKEN}`, credentials: { query: { access_token: TOKEN } } });
    const update = await ok(h, 'update', { id: 'st' });
    const list = await ok(h, 'sources');
    const stats = await ok(h, 'stats', { id: 'st' });
    const err = await call(h, 'register', { kind: 'style', id: 'st', url: `https://z.example/x.json?access_token=${TOKEN}` });
    for (const v of [info, update, list, stats, err.error]) expect(JSON.stringify(v)).not.toContain(TOKEN);
    expect((await store.listSources()).map((s) => [s.id, s.warnings, s.spec]).join(' ')).not.toContain(TOKEN);
    expect((await store.listResources()).map((r) => [r.id, r.templates]).join(' ')).not.toContain(TOKEN);
  });
});

describe('衝突（P2・R10・C-O11）', () => {
  it('update() で新しく現れた子が他の Source の Resource と衝突 → 例外にならず warnings・範囲だけ（tile どうし）', async () => {
    const { h, up, store } = await setup({ [STYLE]: styleOf({}) });
    // 同じテンプレートを raster で登録した Source（符号化の違いで合流しない）
    await ok(h, 'register', { kind: 'raster', id: 'r', url: VT });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    up.bodies.set(STYLE, () => json(styleOf({ vt: { type: 'vector', tiles: [VT], maxzoom: 5 } })));
    const info = await ok(h, 'update', { id: 'st' });
    expect(info.warnings).toEqual([`resource-conflict: ${VT}`]);
    const r = (await store.getResource(VT))!;
    expect(r.sourceIds).toEqual(['r']);
    expect(r.rangeOnlySourceIds).toEqual([childId('st', 'tile:vt')]);
    expect(r.extents!.map((e) => e.sourceId)).toContain(childId('st', 'tile:vt'));
    expect(info.resources.find((x: { id: string }) => x.id === VT)).toMatchObject({ rangeOnly: true });
  });

  it('update() で前からある子の衝突 → keep（古い方針のまま sourceIds に残り、warnings。例外にならない）', async () => {
    const { h, up, store } = await setup({ [STYLE]: styleOf({ vt: { type: 'vector', tiles: [VT] } }) });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE, cacheTtl: 0 });
    await get(h, 'https://t.example/1/0/0.pbf');
    const before = (await store.getResource(VT))!;
    up.bodies.set(STYLE, () => json(styleOf({ vt: { type: 'vector', tiles: [VT] } })));
    const re = await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE, cacheTtl: 0, credentialParams: ['foo'] });
    // スタイル自身の Resource（Entry がある）も同じ理由で keep になる
    expect(re.warnings).toEqual([`resource-conflict: ${STYLE}`, `resource-conflict: ${VT}`]);
    const after = (await store.getResource(VT))!;
    expect(after.sourceIds).toEqual([childId('st', 'tile:vt')]);
    expect(after.policy).toEqual(before.policy);
    const upd = await ok(h, 'update', { id: 'st' });
    expect(upd.warnings).toEqual([`resource-conflict: ${STYLE}`, `resource-conflict: ${VT}`]);
  });

  it('C-O11: スタイルの子の Resource が別の Source の照合の形の影になる → 親の warnings に template-shadowed', async () => {
    const shadowing = 'https://t.example/{z}/{y}/{x}.pbf';
    const { h } = await setup({ [STYLE]: styleOf({ vt: { type: 'vector', tiles: [VT] } }) });
    await ok(h, 'register', { kind: 'vector', id: 'first', url: shadowing });
    const info = await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    expect(info.warnings).toEqual([`template-shadowed: ${VT}`]);
    expect((await ok(h, 'source', { id: 'st' })).warnings).toEqual([`template-shadowed: ${VT}`]);
  });
});

describe('退避・clean・remove（§7.1・§5.6）', () => {
  it('スタイルの cacheMaxBytes が子の Resource を併せて退避する', async () => {
    const { h, store } = await setup({ [STYLE]: styleOf({ a: { type: 'raster', tiles: ['https://a.example/{z}/{x}/{y}.png'] }, b: { type: 'raster', tiles: ['https://b.example/{z}/{x}/{y}.png'] } }) });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE, cacheMaxBytes: 200 });
    const styleBytes = (await store.getResource(STYLE))!.bytes;
    expect(styleBytes).toBeGreaterThan(0);
    // 3 バイトのタイルを上限まで: スタイルの本体＋タイルの和が 200 を超えたら古いものから消える
    const n = Math.floor((200 - styleBytes) / 3) + 2;
    for (let i = 0; i < n; i++) await get(h, `https://${i % 2 === 0 ? 'a' : 'b'}.example/10/${i}/0.png`);
    const all = (await store.listResources()) as ResourceMeta[];
    expect(all.reduce((s, r) => s + r.bytes, 0)).toBeLessThanOrEqual(200);
  });

  it('clean が子の Resource の Entry を消し、他の Source と共有する Resource の Entry を残す。remove が子と親を全部消す', async () => {
    const { h, store } = await setup({ [STYLE]: styleOf({ vt: { type: 'vector', tiles: [VT] }, own: { type: 'raster', tiles: ['https://o.example/{z}/{x}/{y}.png'] } }) });
    await ok(h, 'register', { kind: 'style', id: 'st', url: STYLE });
    await ok(h, 'register', { kind: 'vector', id: 'v', url: VT });
    await get(h, 'https://t.example/1/0/0.pbf');
    await get(h, 'https://o.example/1/0/0.png');
    await ok(h, 'clean', { id: 'st' });
    expect((await store.getResource(VT))!.count).toBe(1);
    expect((await store.getResource('https://o.example/{z}/{x}/{y}.png'))!.count).toBe(0);
    expect((await store.getResource(STYLE))!.count).toBe(0);
    await ok(h, 'remove', { id: 'st' });
    expect((await store.listSources()).map((s) => s.id)).toEqual(['v']);
    expect((await store.listResources()).map((r) => r.id)).toEqual([VT]);
    expect((await store.getResource(VT))!.sourceIds).toEqual(['v']);
    await fails(h, 'source', { id: 'st' }, 'source-not-found');
  });
});
