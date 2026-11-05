// 提供元の登録表と、登録・上流への組み込み（m3-t5・#40・仕様 §8・§10）。実ネットワーク・実トークンは使わない。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addPlugin, addProvider, getProviders, _resetPluginsForTest, type WeiwudiProvider } from '../../src/plugins';
import { normalizeSpec } from '../../src/spec';
import { openStore, type ResourceMeta, type SourceRecord } from '../../src/store';
import { createMapboxProvider } from '../../src/providers/mapbox';
import { appendQueryCredentials } from '../../src/upstream';
import { WeiwudiError } from '../../src/errors';
import { createSwHarness, type SwHarness } from './sw-harness';

afterEach(() => {
  _resetPluginsForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const png = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });

const TOKEN = 'pk.FAKE_TEST_TOKEN';
const MAPBOX_TILES = 'mapbox://tiles/u1.t1/{z}/{x}/{y}.png';
const HTTPS_TILES = 'https://api.mapbox.com/v4/u1.t1/{z}/{x}/{y}.png';

const provider = (id: string, over: Partial<WeiwudiProvider> = {}): WeiwudiProvider => ({
  id,
  matches: () => false,
  resolve: (u) => u,
  applyCredentials: () => undefined,
  ...over,
});

/** SW の IndexedDB の中身（Resource・Source・全キー） */
const dump = async (): Promise<{ resources: ResourceMeta[]; sources: SourceRecord[] }> => {
  const store = await openStore();
  try {
    return { resources: await store.listResources(), sources: await store.listSources() };
  } finally {
    store.close();
  }
};

const allKeys = async (h: SwHarness): Promise<string[]> => {
  const db: IDBDatabase = await new Promise((res, rej) => {
    const q = h.factory.open('WeiwudiStore');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  const names = [...db.objectStoreNames].filter((n) => n !== 'credentials');
  const out: string[] = [];
  for (const name of names) {
    const keys: IDBValidKey[] = await new Promise((res, rej) => {
      const q = db.transaction(name).objectStore(name).getAllKeys();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    out.push(...keys.map((k) => `${name}:${String(k)}`));
  }
  db.close();
  return out;
};

const register = async (h: SwHarness, body: unknown) => (await h.post('/v2/register', body))!.json();

describe('登録表（plugins.ts）', () => {
  it('addProvider は冪等（同じオブジェクトの 2 回目は無視）で、getProviders は登録順の写し', () => {
    const a = provider('a');
    const b = provider('b');
    addProvider(a);
    addProvider(b);
    addProvider(a);
    const list = getProviders();
    expect(list).toEqual([a, b]);
    (list as WeiwudiProvider[]).pop();
    expect(getProviders()).toEqual([a, b]);
  });

  it('_resetPluginsForTest で提供元の登録表も空になる', () => {
    addProvider(provider('a'));
    addPlugin({});
    _resetPluginsForTest();
    expect(getProviders()).toEqual([]);
  });

  it('形の違う値は TypeError', () => {
    expect(() => addProvider(null as unknown as WeiwudiProvider)).toThrow(TypeError);
    expect(() => addProvider({ id: '' } as unknown as WeiwudiProvider)).toThrow(TypeError);
    expect(() => addProvider({ ...provider('x'), resolve: 1 } as unknown as WeiwudiProvider)).toThrow(TypeError);
  });
});

describe('normalizeSpec の providers（X8）', () => {
  const mapbox = createMapboxProvider(appendQueryCredentials);

  it('providers を渡さなければ提供元を使わない（mapbox:// は unsupported-template のまま）', () => {
    expect(() => normalizeSpec({ kind: 'raster', url: MAPBOX_TILES })).toThrow(WeiwudiError);
    expect(normalizeSpec({ kind: 'raster', url: HTTPS_TILES }).spec.provider).toBeUndefined();
  });

  it('mapbox:// を解決し、templates・url・id が https で provider: mapbox', () => {
    const n = normalizeSpec({ kind: 'raster', url: `${MAPBOX_TILES}?access_token=${TOKEN}` }, [mapbox]);
    expect(n.spec.templates).toEqual([HTTPS_TILES]);
    expect(n.spec.url).toBe(HTTPS_TILES);
    expect(n.spec.id).toBe(HTTPS_TILES);
    expect(n.spec.provider).toBe('mapbox');
    expect(n.credentials).toEqual({ query: { access_token: TOKEN } });
  });

  it('提供元の credentialParams が和に入る', () => {
    const p = provider('p', { matches: (u) => u.startsWith('https://p.example/'), credentialParams: ['pkey'] });
    const n = normalizeSpec({ kind: 'raster', url: 'https://p.example/{z}/{x}/{y}.png?pkey=V1' }, [p]);
    expect(n.spec.policy.credentialParams).toContain('pkey');
    expect(n.spec.templates).toEqual(['https://p.example/{z}/{x}/{y}.png']);
    expect(n.credentials).toEqual({ query: { pkey: 'V1' } });
  });

  it('validateCredentials を呼ぶ（投げたら登録の失敗）', () => {
    const seen: unknown[] = [];
    const p = provider('p', {
      matches: (u) => u.startsWith('https://p.example/'),
      validateCredentials: (c) => {
        seen.push(c);
        throw new WeiwudiError('credential-rejected', 'no', {});
      },
    });
    expect(() => normalizeSpec({ kind: 'raster', url: 'https://p.example/{z}/{x}/{y}.png', credentials: { query: { k: 'v' } } }, [p]))
      .toThrow(expect.objectContaining({ code: 'credential-rejected' }));
    expect(seen).toEqual([{ query: { k: 'v' } }]);
  });

  it('mapbox の validateCredentials: 登録の access_token が sk. なら credential-rejected', () => {
    expect(() => normalizeSpec({ kind: 'raster', url: MAPBOX_TILES, credentials: { query: { access_token: 'sk.x' } } }, [mapbox]))
      .toThrow(expect.objectContaining({ code: 'credential-rejected' }));
  });

  it('当たる提供元がミラーの間で違えば attribute-invalid', () => {
    expect(() => normalizeSpec({ kind: 'raster', url: [MAPBOX_TILES, 'https://other.example/{z}/{x}/{y}.png'] }, [mapbox]))
      .toThrow(expect.objectContaining({ code: 'attribute-invalid' }));
  });

  it('解決できない mapbox:// は unsupported-template（番号つき）', () => {
    expect(() => normalizeSpec({ kind: 'raster', url: 'mapbox://tiles/u1.t1' }, [mapbox]))
      .toThrow(expect.objectContaining({ code: 'unsupported-template', detail: { index: 0 } }));
  });

  it('先に並んだ提供元が勝つ', () => {
    const mine = provider('mine', { matches: (u) => u.startsWith('mapbox://'), resolve: () => 'https://mine.example/{z}/{x}/{y}.png' });
    const n = normalizeSpec({ kind: 'raster', url: MAPBOX_TILES }, [mine, mapbox]);
    expect(n.spec.provider).toBe('mine');
    expect(n.spec.templates).toEqual(['https://mine.example/{z}/{x}/{y}.png']);
  });
});

describe('SW を通した登録と上流（標準の mapbox）', () => {
  it('raster を mapbox://tiles/…/{z}/{x}/{y}.png で登録すると templates が https で provider: mapbox', async () => {
    const h = createSwHarness();
    const r = await register(h, { kind: 'raster', id: 'mb', url: MAPBOX_TILES, credentials: { query: { access_token: TOKEN } } });
    expect(r.ok).toBe(true);
    expect(r.result.url).toBe(HTTPS_TILES);
    expect(r.result.resources.map((x: { templates: string[] }) => x.templates)).toEqual([[HTTPS_TILES]]);
    const { resources, sources } = await dump();
    expect(resources).toHaveLength(1);
    expect(resources[0].templates).toEqual([HTTPS_TILES]);
    expect(resources[0].provider).toBe('mapbox');
    expect((sources.find((s) => s.id === 'mb')!.spec as { provider?: string }).provider).toBe('mapbox');
  });

  it('上流の要求に access_token が付き、キー・templates・warnings に無い', async () => {
    const h = createSwHarness();
    h.fetch.mockImplementation(async () => png());
    const r = await register(h, { kind: 'raster', id: 'mb', url: `${MAPBOX_TILES}?access_token=${TOKEN}` });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.result)).not.toContain(TOKEN);
    await h.flushRoutes();
    const res = await h.dispatch('https://api.mapbox.com/v4/u1.t1/3/1/2.png');
    expect(res!.headers.get('x-weiwudi-status')).toBe('miss');
    const sent = h.fetch.mock.calls[0][0] as Request;
    expect(sent.url).toBe(`https://api.mapbox.com/v4/u1.t1/3/1/2.png?access_token=${TOKEN}`);
    expect((await allKeys(h)).some((k) => k.includes(TOKEN))).toBe(false);
    const { resources, sources } = await dump();
    expect(JSON.stringify(resources)).not.toContain(TOKEN);
    expect(JSON.stringify(sources)).not.toContain(TOKEN);
  });

  it('提供元の Resource でも、差し込み口が別オリジンへ替えたら付かない（t3 の I1）', async () => {
    const h = createSwHarness();
    h.fetch.mockImplementation(async () => png());
    addPlugin({ requestWillFetch: async ({ request }) => new Request(request.url.replace('https://api.mapbox.com', 'https://mirror.example')) });
    await register(h, { kind: 'raster', id: 'mb', url: MAPBOX_TILES, credentials: { query: { access_token: TOKEN } } });
    await h.flushRoutes();
    await h.dispatch('https://api.mapbox.com/v4/u1.t1/3/1/2.png');
    const sent = h.fetch.mock.calls[0][0] as Request;
    expect(new URL(sent.url).origin).toBe('https://mirror.example');
    expect(sent.url).not.toContain(TOKEN);
  });

  it('https://a.tiles.mapbox.com/v4/… の要求にも access_token が付く（C-O2。matches が *.tiles.mapbox.com を拾う）', async () => {
    const h = createSwHarness();
    h.fetch.mockImplementation(async () => png());
    const url = 'https://a.tiles.mapbox.com/v4/u1.t1/{z}/{x}/{y}.vector.pbf';
    const r = await register(h, { kind: 'vector', id: 'a', url, credentials: { query: { access_token: TOKEN } } });
    expect(r.ok).toBe(true);
    expect((await dump()).resources[0].provider).toBe('mapbox');
    await h.flushRoutes();
    await h.dispatch('https://a.tiles.mapbox.com/v4/u1.t1/3/1/2.vector.pbf');
    expect((h.fetch.mock.calls[0][0] as Request).url).toBe(`https://a.tiles.mapbox.com/v4/u1.t1/3/1/2.vector.pbf?access_token=${TOKEN}`);
  });

  it('提供元の Resource のヘッダの資格情報は汎用のまま足し、redirect: error（no-cors でない要求）', async () => {
    const h = createSwHarness();
    h.fetch.mockImplementation(async () => png());
    await register(h, { kind: 'raster', id: 'mb', url: MAPBOX_TILES, credentials: { headers: { 'x-api-key': 'HFAKE' } } });
    await h.flushRoutes();
    await h.dispatch('https://api.mapbox.com/v4/u1.t1/3/1/2.png');
    const sent = h.fetch.mock.calls[0][0] as Request;
    expect(sent.headers.get('x-api-key')).toBe('HFAKE');
    expect(sent.redirect).toBe('error');
  });

  it('control を通して register した spec.templates が https で、update() でも同じ（X8）', async () => {
    const h = createSwHarness();
    const r = await register(h, { kind: 'raster', id: 'mb', url: MAPBOX_TILES, credentials: { query: { access_token: TOKEN } } });
    expect(r.ok).toBe(true);
    const before = (await dump()).sources.find((s) => s.id === 'mb')!.spec as { templates: string[]; provider?: string };
    expect(before.templates).toEqual([HTTPS_TILES]);
    const u = await (await h.post('/v2/update', { id: 'mb' }))!.json();
    expect(u.ok).toBe(true);
    expect(u.result.url).toBe(HTTPS_TILES);
    const { resources, sources } = await dump();
    const after = sources.find((s) => s.id === 'mb')!.spec as { templates: string[]; provider?: string };
    expect(after.templates).toEqual([HTTPS_TILES]);
    expect(after.provider).toBe('mapbox');
    expect(resources.map((m) => [m.templates, m.provider])).toEqual([[[HTTPS_TILES], 'mapbox']]);
  });
});

describe('SW を通した利用者の提供元', () => {
  it('利用者の提供元が標準より先に評価される（同じ URL に当たれば利用者のものが勝つ）', async () => {
    const h = createSwHarness();
    const applied: string[] = [];
    addProvider(provider('mine', {
      matches: (u) => u.startsWith('mapbox://'),
      resolve: () => 'https://mine.example/{z}/{x}/{y}.png',
      applyCredentials: (url, c) => {
        applied.push(url.href);
        url.searchParams.set('mk', c.query?.access_token ?? '');
      },
    }));
    h.fetch.mockImplementation(async () => png());
    const r = await register(h, { kind: 'raster', id: 'm', url: MAPBOX_TILES, credentials: { query: { access_token: TOKEN } } });
    expect(r.ok).toBe(true);
    expect(r.result.url).toBe('https://mine.example/{z}/{x}/{y}.png');
    expect((await dump()).resources[0].provider).toBe('mine');
    await h.flushRoutes();
    await h.dispatch('https://mine.example/3/1/2.png');
    expect(applied).toEqual(['https://mine.example/3/1/2.png']);
    expect((h.fetch.mock.calls[0][0] as Request).url).toBe(`https://mine.example/3/1/2.png?mk=${TOKEN}`);
  });

  it('applyCredentials がオリジンを替えたら、その結果を使わない（資格情報を足さずに元のオリジンへ）', async () => {
    const h = createSwHarness();
    addProvider(provider('bad', {
      matches: (u) => u.startsWith('https://bad.example/'),
      applyCredentials: (url, c) => {
        url.host = 'evil.example';
        url.searchParams.set('k', c.query?.k ?? '');
      },
    }));
    h.fetch.mockImplementation(async () => png());
    await register(h, { kind: 'raster', id: 'b', url: 'https://bad.example/{z}/{x}/{y}.png', credentials: { query: { k: 'KFAKE' } } });
    await h.flushRoutes();
    await h.dispatch('https://bad.example/3/1/2.png');
    expect((h.fetch.mock.calls[0][0] as Request).url).toBe('https://bad.example/3/1/2.png');
  });

  it('登録表に無い provider の Resource は汎用の足し方（SW の再起動で利用者の提供元が未登録のとき）', async () => {
    const h = createSwHarness();
    const mine = provider('mine', { matches: (u) => u.startsWith('https://mine.example/'), applyCredentials: () => undefined });
    addProvider(mine);
    h.fetch.mockImplementation(async () => png());
    await register(h, { kind: 'raster', id: 'm', url: 'https://mine.example/{z}/{x}/{y}.png', credentials: { query: { k: 'KFAKE' } } });
    expect((await dump()).resources[0].provider).toBe('mine');
    _resetPluginsForTest();
    await h.flushRoutes();
    await h.dispatch('https://mine.example/3/1/2.png');
    expect((h.fetch.mock.calls[0][0] as Request).url).toBe('https://mine.example/3/1/2.png?k=KFAKE');
  });
});
