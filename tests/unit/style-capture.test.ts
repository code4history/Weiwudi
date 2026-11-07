// スタイル・TileJSON・スプライトの捕捉（m3-t6・I3 の前半・仕様 §5.5・§6・§10・R5・R6・R28・R32・C-S1・C-S4）。
// t7 の芋づる登録はまだ無いので、t2 の normalizeMember と apply で style・tilejson・sprite の子の Resource を直接作り、
// ハーネスの SW（標準の mapbox を持つ配線）の照合ルート・門番で捕捉させる。実ネットワーク・実トークンは使わない。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSwHarness, type SwHarness } from './sw-harness';
import { createContext } from '../../src/context';
import { apply, childSourceId } from '../../src/registry';
import { acceptsMember, normalizeMember, type StyleSpec } from '../../src/spec';
import { styleSpecOf, type ResourceType, type SourceRecord, type Store } from '../../src/store';
import { compileTemplate, matchUrl, spriteTemplateOf } from '../../src/url_pattern';
import { serveResource } from '../../src/hook';
import { createMapboxProvider } from '../../src/providers/mapbox';
import { appendQueryCredentials } from '../../src/upstream';
import { _resetPluginsForTest } from '../../src/plugins';

afterEach(() => {
  _resetPluginsForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const TOKEN = 'pk.FAKE_STYLE_TOKEN';
const STYLE_URL = 'https://a.example/styles/s/style.json';
const mapbox = createMapboxProvider(appendQueryCredentials);

const json = (body: unknown, type = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': type } });

const styleBody = (sources: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 8, sources, layers: [], ...over });

/** スタイルの親の記録（t7 が作るもの。ここでは直接置く） */
const putParent = async (store: Store, id: string, url: string, provider?: string): Promise<void> => {
  const spec: StyleSpec = {
    kind: 'style', id, url, templates: [url],
    policy: { cacheTtl: 86_400_000, store: false, outOfRange: { extent: 'not-found', zoom: 'not-found' }, credentialParams: ['access_token'] },
    children: [],
    ...(provider ? { provider } : {}),
  };
  const rec: SourceRecord = { id, kind: 'style', spec, order: 1, warnings: [], createdAt: 0 };
  await store.putSource(rec);
};

/** スタイルの子を 1 つ作る（t2 の normalizeMember と apply。親の order・parentId を渡す） */
const putChild = async (
  store: Store, parentId: string, type: ResourceType, logicalName: string, url: string,
  common: Record<string, unknown> = {}, opts: { providers?: boolean; encoding?: 'raster' | 'vector' } = {},
) => {
  const spec = normalizeMember(type, [url], common, {
    kind: 'child', internalId: childSourceId(parentId, type, logicalName), logicalName, single: true,
    ...(opts.encoding ? { encoding: opts.encoding } : {}),
  }, opts.providers ? [mapbox] : undefined);
  return apply(store, spec, undefined, { throwOnConflict: false, resetCors: false, order: 1, parentId });
};

const setup = async () => {
  const h = createSwHarness();
  const store = await createContext().store();
  return { h, store };
};

/** 照合表を読ませて要求を出す（最初の候補は門番が読み込みを待って当てる） */
const get = async (h: SwHarness, url: string): Promise<Response> => {
  await h.flushRoutes();
  return (await h.dispatch(url))!;
};

const entriesOf = async (store: Store, resourceId: string, suffixes: string[]) =>
  Promise.all(suffixes.map((s) => store.getEntry(`${resourceId}\0${s}`)));

describe('スタイルの捕捉', () => {
  it('捕捉したスタイルの本体が提供元の rewriteStyle を通って保存され、hit でも同じ本体（mapbox://）', async () => {
    const { h, store } = await setup();
    await putParent(store, 'st', 'https://api.mapbox.com/styles/v1/u/s', 'mapbox');
    const r = await putChild(store, 'st', 'style', 'style', 'mapbox://styles/u/s', {}, { providers: true });
    const rid = r.resources[0].id;
    expect(r.resources[0].provider).toBe('mapbox');
    h.fetch.mockImplementation(async () => json(styleBody(
      { m: { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' } },
      { glyphs: 'mapbox://fonts/u/{fontstack}/{range}.pbf', sprite: 'mapbox://sprites/u/s' },
    )));
    const first = await get(h, 'https://api.mapbox.com/styles/v1/u/s');
    expect(first.headers.get('x-weiwudi-status')).toBe('miss');
    const text = await first.text();
    expect(text).not.toContain('mapbox://');
    const out = JSON.parse(text);
    expect(out.sources.m.url).toBe('https://api.mapbox.com/v4/mapbox.mapbox-streets-v8.json?secure');
    expect(out.glyphs).toBe('https://api.mapbox.com/fonts/v1/u/{fontstack}/{range}.pbf');
    expect(out.sprite).toBe('https://api.mapbox.com/styles/v1/u/s/sprite');
    const [saved] = await entriesOf(store, rid, ['']);
    expect(await saved!.body.blob.text()).toBe(text);
    const hit = await get(h, 'https://api.mapbox.com/styles/v1/u/s');
    expect(hit.headers.get('x-weiwudi-status')).toBe('hit');
    expect(await hit.text()).toBe(text);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('資格情報のある Source では、スタイルの本体の URL から access_token が除かれる（保存と配信の両方）', async () => {
    const { h, store } = await setup();
    await putParent(store, 'st', STYLE_URL);
    const r = await putChild(store, 'st', 'style', 'style', STYLE_URL, { credentials: { query: { access_token: TOKEN } } });
    const rid = r.resources[0].id;
    h.fetch.mockImplementation(async () => json(styleBody(
      { t: { type: 'vector', tiles: [`https://a.example/{z}/{x}/{y}.pbf?access_token=${TOKEN}`] } },
      { sprite: `https://a.example/sprites/s?access_token=${TOKEN}` },
    )));
    const res = await get(h, STYLE_URL);
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect((h.fetch.mock.calls[0][0] as Request).url).toBe(`${STYLE_URL}?access_token=${TOKEN}`);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).sources.t.tiles).toEqual(['https://a.example/{z}/{x}/{y}.pbf']);
    const [saved] = await entriesOf(store, rid, ['']);
    expect(await saved!.body.blob.text()).not.toContain(TOKEN);
  });

  it('資格情報が無ければ本体は上流のまま（仕様 §10）', async () => {
    const { h, store } = await setup();
    await putParent(store, 'st', STYLE_URL);
    await putChild(store, 'st', 'style', 'style', STYLE_URL);
    const upstream = styleBody({ t: { type: 'vector', tiles: [`https://a.example/{z}/{x}/{y}.pbf?access_token=${TOKEN}`] } });
    h.fetch.mockImplementation(async () => json(upstream));
    const res = await get(h, STYLE_URL);
    expect(await res.text()).toBe(upstream);
  });

  it('content-type: text/html でも JSON として読めるスタイルは保存される（isStyleLike。C-S4）', async () => {
    const { h, store } = await setup();
    await putParent(store, 'st', STYLE_URL);
    const r = await putChild(store, 'st', 'style', 'style', STYLE_URL);
    const upstream = styleBody({});
    h.fetch.mockImplementation(async () => json(upstream, 'text/html'));
    const res = await get(h, STYLE_URL);
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    const [saved] = await entriesOf(store, r.resources[0].id, ['']);
    expect(await saved!.body.blob.text()).toBe(upstream);
  });

  it('HTML の本体（ログイン画面）は保存されず、前に保存した本体が stale で返り、Entry が前のまま（C-S4）', async () => {
    const { h, store } = await setup();
    await putParent(store, 'st', STYLE_URL);
    const r = await putChild(store, 'st', 'style', 'style', STYLE_URL, { cacheTtl: 0 });
    const rid = r.resources[0].id;
    const good = styleBody({});
    h.fetch.mockImplementationOnce(async () => json(good));
    expect((await get(h, STYLE_URL)).headers.get('x-weiwudi-status')).toBe('miss');
    const [before] = await entriesOf(store, rid, ['']);
    await new Promise((res) => setTimeout(res, 5));
    h.fetch.mockImplementationOnce(async () => json('<html><form>login</form></html>', 'text/html'));
    const res = await get(h, STYLE_URL);
    expect(res.headers.get('x-weiwudi-status')).toBe('stale');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(await res.text()).toBe(good);
    const [after] = await entriesOf(store, rid, ['']);
    expect(after!.meta).toEqual(before!.meta);
    expect(await after!.body.blob.text()).toBe(good);
    expect((await store.getResource(rid))!.count).toBe(1);
  });

  it('HTML の本体で Entry も無ければ upstream-error で、保存しない', async () => {
    const { h, store } = await setup();
    await putParent(store, 'st', STYLE_URL);
    const r = await putChild(store, 'st', 'style', 'style', STYLE_URL);
    h.fetch.mockImplementation(async () => json('<html>login</html>', 'text/html'));
    const res = await get(h, STYLE_URL);
    expect(res.headers.get('x-weiwudi-status')).toBe('upstream-error');
    expect((await store.getResource(r.resources[0].id))!.count).toBe(0);
  });

  it('C-S1: a.example のスタイル（資格情報を登録）の中の b.example の ?key=k は保存した本体に残り、ページがそのとおりに出した要求の ?key=k が上流へそのまま出る（キーには残らない）', async () => {
    const { h, store } = await setup();
    await putParent(store, 'st', STYLE_URL);
    const r = await putChild(store, 'st', 'style', 'style', STYLE_URL, { credentials: { query: { access_token: TOKEN } } });
    h.fetch.mockImplementation(async (req: Request) => (req.url.startsWith(STYLE_URL)
      ? json(styleBody({
        // 除くのは登録した資格情報と同じ値の項目だけ（§10 R32）
        a: { type: 'raster', tiles: [`https://a.example/{z}/{x}/{y}.png?access_token=${TOKEN}`] },
        b: { type: 'raster', tiles: ['https://b.example/{z}/{x}/{y}.png?key=k'] },
      }))
      : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })));
    await get(h, STYLE_URL);
    const [saved] = await entriesOf(store, r.resources[0].id, ['']);
    const body = JSON.parse(await saved!.body.blob.text());
    expect(body.sources.a.tiles).toEqual(['https://a.example/{z}/{x}/{y}.png']);
    expect(body.sources.b.tiles).toEqual(['https://b.example/{z}/{x}/{y}.png?key=k']);

    // b.example の子（t7 の R5 では親の資格情報を受け取らない）。テンプレートの key だけを持つ
    const b = await putChild(store, 'st', 'tile', 'b', body.sources.b.tiles[0], {}, { encoding: 'raster' });
    expect(await store.getCredentials(b.source.id)).toEqual({ query: { key: 'k' } });
    expect(await store.getCredentials(b.source.id)).not.toHaveProperty('query.access_token');
    // 表を読み直させる（ハーネスの SW へ届く）
    const { tableChanged, NOTIFY_DEBOUNCE_MS } = await import('../../src/hook');
    await tableChanged(createContext());
    // 通知は最後の変更から NOTIFY_DEBOUNCE_MS 後（m4-t8・I8b・R34）
    await new Promise((res) => setTimeout(res, NOTIFY_DEBOUNCE_MS + 20));
    h.fetch.mockClear();
    const tile = await get(h, 'https://b.example/1/0/0.png?key=k');
    expect(tile.headers.get('x-weiwudi-status')).toBe('miss');
    const sent = (h.fetch.mock.calls[0][0] as Request).url;
    expect(sent).toBe('https://b.example/1/0/0.png?key=k');
    expect(sent).not.toContain(TOKEN);
    const bid = b.resources[0].id;
    expect(bid).not.toContain('key=k');
    expect(await store.getEntry(`${bid}\u00001_0_0`)).toBeDefined();
  });
});

describe('TileJSON の捕捉', () => {
  const TJ = 'https://a.example/tiles/t.json';

  it('資格情報のある TileJSON の子は、親のスタイルと同じオリジンの tiles から資格情報が除かれる', async () => {
    const { h, store } = await setup();
    await putParent(store, 'st', STYLE_URL);
    const r = await putChild(store, 'st', 'tilejson', 'tj', TJ, { credentials: { query: { access_token: TOKEN } } });
    h.fetch.mockImplementation(async () => json({ tilejson: '3.0.0', tiles: [`{z}/{x}/{y}.pbf?access_token=${TOKEN}`] }));
    const res = await get(h, TJ);
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(JSON.parse(await res.text()).tiles).toEqual(['{z}/{x}/{y}.pbf']);
    const [saved] = await entriesOf(store, r.resources[0].id, ['']);
    expect(await saved!.body.blob.text()).not.toContain(TOKEN);
  });

  it('判定は親のスタイルの URL のオリジンで行う（TileJSON と tiles が a.example でもスタイルが c.example なら除かない）', async () => {
    const { h, store } = await setup();
    await putParent(store, 'st', 'https://c.example/style.json');
    await putChild(store, 'st', 'tilejson', 'tj', TJ, { credentials: { query: { access_token: TOKEN } } });
    const upstream = JSON.stringify({ tiles: [`https://a.example/{z}/{x}/{y}.pbf?access_token=${TOKEN}`] });
    h.fetch.mockImplementation(async () => json(upstream));
    expect(await (await get(h, TJ)).text()).toBe(upstream);
  });

  it('tiles の無い本体は保存しない（upstream-error）', async () => {
    const { h, store } = await setup();
    await putParent(store, 'st', STYLE_URL);
    const r = await putChild(store, 'st', 'tilejson', 'tj', TJ);
    h.fetch.mockImplementation(async () => json({ name: 'x' }));
    expect((await get(h, TJ)).headers.get('x-weiwudi-status')).toBe('upstream-error');
    expect((await store.getResource(r.resources[0].id))!.count).toBe(0);
  });
});

describe('L3: 合流後も組の判定には親の credentialParams を使う', () => {
  it('スタイル登録時も直接渡す親に policy を添える', async () => {
    const { h, store } = await setup();
    await putParent(store, 'wide', STYLE_URL);
    const wide = await putChild(store, 'wide', 'style', 'style', STYLE_URL, { credentialParams: ['variant'], cacheTtl: 0 });
    const tiles = ['one', 'two'].map((v) => `https://a.example/${v}/{z}/{x}/{y}.pbf?access_token=${TOKEN}&variant=${v}`);
    h.fetch.mockImplementation(async () => json(styleBody({ t: { type: 'vector', tiles } })));
    const res = await h.post('/v2/register', {
      kind: 'style', id: 'narrow', url: STYLE_URL, cacheTtl: 0,
      credentials: { query: { access_token: TOKEN } },
    });
    expect((await res!.json()).ok).toBe(true);
    const resource = (await store.getResource(wide.resources[0].id))!;
    expect(resource.sourceIds).toHaveLength(2);
    expect(resource.policy.credentialParams).toContain('variant');
    const parent = styleSpecOf((await store.getSource('narrow'))!)!;
    expect(parent.policy.credentialParams).not.toContain('variant');
    expect(parent.children.some((c) => c.type === 'tile')).toBe(true);
    const [saved] = await entriesOf(store, resource.id, ['']);
    expect(await saved!.body.blob.text()).not.toContain(TOKEN);
  });

  it.each(['style', 'tilejson'] as const)('%s: 別の親から増えた資格情報名で組を拒否しない', async (type) => {
    const { h, store } = await setup();
    const url = type === 'style' ? STYLE_URL : 'https://a.example/tiles/t.json';
    await putParent(store, 'narrow', STYLE_URL);
    await putParent(store, 'wide', STYLE_URL);
    const narrow = await putChild(store, 'narrow', type, type, url, {
      credentials: { query: { access_token: TOKEN } },
    });
    await putChild(store, 'wide', type, type, url, { credentialParams: ['variant'] });
    const resource = (await store.getResource(narrow.resources[0].id))!;
    expect(resource.sourceIds).toHaveLength(2);
    expect(resource.policy.credentialParams).toContain('variant');
    const parent = styleSpecOf((await store.getSource('narrow'))!)!;
    expect(parent.policy.credentialParams).not.toContain('variant');
    const tiles = ['one', 'two'].map((v) => `https://a.example/${v}/{z}/{x}/{y}.pbf?access_token=${TOKEN}&variant=${v}`);
    expect(acceptsMember('tile', tiles, parent.policy.credentialParams)).toBe(true);
    expect(acceptsMember('tile', tiles, resource.policy.credentialParams)).toBe(false);
    h.fetch.mockImplementation(async () => json(type === 'style'
      ? styleBody({ t: { type: 'vector', tiles } }) : { tiles }));

    const res = await get(h, url);
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const body = JSON.parse(text);
    // 登録した資格情報と同じ値の access_token だけを除く。variant は登録の値が無いので残す（§10 R32）
    expect(type === 'style' ? body.sources.t.tiles : body.tiles)
      .toEqual(['one', 'two'].map((v) => `https://a.example/${v}/{z}/{x}/{y}.pbf?variant=${v}`));
    const [saved] = await entriesOf(store, resource.id, ['']);
    expect(await saved!.body.blob.text()).toBe(text);
  });
});

describe('スプライトの捕捉（R6）', () => {
  it('スプライト 4 つが 1 つの Resource の別の Entry', async () => {
    const { h, store } = await setup();
    await putParent(store, 'st', STYLE_URL);
    const r = await putChild(store, 'st', 'sprite', 'sprite', spriteTemplateOf('https://a.example/sprites/s'));
    const rid = r.resources[0].id;
    h.fetch.mockImplementation(async (req: Request) => (req.url.endsWith('.json')
      ? json({ a: { x: 0 } })
      : new Response(new Uint8Array([9]), { status: 200, headers: { 'content-type': 'image/png' } })));
    for (const p of ['s.json', 's.png', 's@2x.json', 's@2x.png']) {
      expect((await get(h, `https://a.example/sprites/${p}`)).headers.get('x-weiwudi-status')).toBe('miss');
    }
    const entries = await entriesOf(store, rid, ['.json', '.png', '@2x.json', '@2x.png']);
    expect(entries.every((e) => e?.meta.resourceId === rid)).toBe(true);
    expect((await store.getResource(rid))!.count).toBe(4);
    expect((await get(h, 'https://a.example/sprites/s@2x.png')).headers.get('x-weiwudi-status')).toBe('hit');
  });
});

describe('serveResource を直接呼ぶ（L1 Minor-2・Minor-4）', () => {
  const TJ = 'https://a.example/tiles/t.json';
  const tjBody = () => json({ tiles: [`https://a.example/{z}/{x}/{y}.pbf?access_token=${TOKEN}`] });

  const prepare = async () => {
    vi.stubGlobal('indexedDB', new (await import('fake-indexeddb')).IDBFactory());
    vi.stubGlobal('IDBKeyRange', (await import('fake-indexeddb')).IDBKeyRange);
    const fetchMock = vi.fn(async () => tjBody());
    vi.stubGlobal('fetch', fetchMock);
    const ctx = createContext({ providers: () => [mapbox], acceptsMember });
    const store = await ctx.store();
    return { ctx, store, fetchMock };
  };

  const call = async (ctx: ReturnType<typeof createContext>, rid: string) => {
    const resource = (await (await ctx.store()).getResource(rid))!;
    const url = new URL(TJ);
    const m = matchUrl(compileTemplate(resource.templates[0]), url)!;
    return serveResource(ctx, resource, new Request(TJ), url, m, undefined);
  };

  it('O-N3: credentialSourceId が無ければ sourceIds を登録順に見て、資格情報を持つ最初の Source（後の親）のオリジンで除去する', async () => {
    const { ctx, store } = await prepare();
    // 前の親は c.example のスタイル（その子は資格情報なし）、後の親は a.example のスタイル（その子は資格情報あり）
    await putParent(store, 'p1', 'https://c.example/style.json');
    await putParent(store, 'p2', STYLE_URL);
    const s1 = normalizeMember('tilejson', [TJ], {}, { kind: 'child', internalId: childSourceId('p1', 'tilejson', 'tj'), logicalName: 'tj', single: true });
    await apply(store, s1, undefined, { throwOnConflict: false, resetCors: false, order: 1, parentId: 'p1' });
    const s2 = normalizeMember('tilejson', [TJ], { credentials: { query: { access_token: TOKEN } } },
      { kind: 'child', internalId: childSourceId('p2', 'tilejson', 'tj'), logicalName: 'tj', single: true });
    const r2 = await apply(store, s2, undefined, { throwOnConflict: false, resetCors: false, order: 2, parentId: 'p2' });
    const rid = r2.resources[0].id;
    expect((await store.getResource(rid))!.sourceIds).toEqual([s1.spec.id, s2.spec.id]);
    const res = await call(ctx, rid);
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(JSON.parse(await res.text()).tiles).toEqual(['https://a.example/{z}/{x}/{y}.pbf']);
  });

  it('L3: 直接渡した親の policy で組を判定し、合流後の Resource の policy を使わない', async () => {
    const { ctx, store, fetchMock } = await prepare();
    await putParent(store, 'narrow', 'https://old.example/style.json');
    await putParent(store, 'wide', STYLE_URL);
    const credentials = { query: { access_token: TOKEN } };
    const r = await putChild(store, 'narrow', 'tilejson', 'tj', TJ, { credentials });
    await putChild(store, 'wide', 'tilejson', 'tj', TJ, { credentialParams: ['variant'] });
    const resource = (await store.getResource(r.resources[0].id))!;
    const parent = { ...styleSpecOf((await store.getSource('narrow'))!)!, url: STYLE_URL };
    const tiles = ['one', 'two'].map((v) => `https://a.example/${v}/{z}/{x}/{y}.pbf?access_token=${TOKEN}&variant=${v}`);
    expect(acceptsMember('tile', tiles, parent.policy.credentialParams)).toBe(true);
    expect(acceptsMember('tile', tiles, resource.policy.credentialParams)).toBe(false);
    fetchMock.mockImplementation(async () => json({ tiles }));
    const url = new URL(TJ);
    const m = matchUrl(compileTemplate(resource.templates[0]), url)!;
    const res = await serveResource(ctx, resource, new Request(TJ), url, m, credentials, { parent });
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    // 登録した資格情報と同じ値の access_token だけを除く。variant は登録の値が無いので残す（§10 R32）
    expect((await res.json()).tiles).toEqual(['one', 'two'].map((v) => `https://a.example/${v}/{z}/{x}/{y}.pbf?variant=${v}`));
  });

  it('同じ構成で資格情報を持つ Source が無ければ除去しない', async () => {
    const { ctx, store } = await prepare();
    await putParent(store, 'p2', STYLE_URL);
    const r = await putChild(store, 'p2', 'tilejson', 'tj', TJ);
    const res = await call(ctx, r.resources[0].id);
    expect(await res.text()).toContain(TOKEN);
  });

  it('Minor-4: hit では除去の規則を計算しない（Source・資格情報を IndexedDB から読まない）', async () => {
    const { ctx, store } = await prepare();
    await putParent(store, 'p2', STYLE_URL);
    const r = await putChild(store, 'p2', 'tilejson', 'tj', TJ, { credentials: { query: { access_token: TOKEN } } });
    expect((await call(ctx, r.resources[0].id)).headers.get('x-weiwudi-status')).toBe('miss');
    const getSource = vi.spyOn(store, 'getSource');
    const getCredentials = vi.spyOn(store, 'getCredentials');
    const hit = await call(ctx, r.resources[0].id);
    expect(hit.headers.get('x-weiwudi-status')).toBe('hit');
    expect(getSource).not.toHaveBeenCalled();
    expect(getCredentials).not.toHaveBeenCalled();
  });
});
