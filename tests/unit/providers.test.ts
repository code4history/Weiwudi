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

  it('別のオブジェクトで id が同じなら TypeError（同じオブジェクトの 2 回目は無視のまま）', () => {
    const a = provider('dup');
    addProvider(a);
    expect(() => addProvider(a)).not.toThrow();
    expect(() => addProvider(provider('dup'))).toThrow(TypeError);
    expect(getProviders()).toEqual([a]);
  });

  it('id が mapbox の利用者の提供元は登録できる（標準は登録表に無い）', () => {
    expect(() => addProvider(provider('mapbox'))).not.toThrow();
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

  it('ミラーの間はオブジェクトの同一性で比べる（id が同じ別の提供元に当たれば attribute-invalid）', () => {
    const p1 = provider('same', { matches: (u) => u.startsWith('https://one.example/') });
    const p2 = provider('same', { matches: (u) => u.startsWith('https://two.example/') });
    expect(() => normalizeSpec({ kind: 'raster', url: ['https://one.example/{z}/{x}/{y}.png', 'https://two.example/{z}/{x}/{y}.png'] }, [p1, p2]))
      .toThrow(expect.objectContaining({ code: 'attribute-invalid' }));
  });

  it.each([
    ['Error', () => new Error('SECRET_MSG pk.leak')],
    ['別の code の WeiwudiError', () => new WeiwudiError('attribute-invalid', 'SECRET_MSG pk.leak', {})],
    ['unsupported-template の WeiwudiError', () => new WeiwudiError('unsupported-template', 'SECRET_MSG pk.leak', {})],
  ])('resolve の例外（%s）は固定の文面の unsupported-template', (_l, make) => {
    const p = provider('rx', { matches: (u) => u.startsWith('rx://'), resolve: () => { throw make(); } });
    expect.assertions(3);
    try {
      normalizeSpec({ kind: 'raster', url: 'rx://a/{z}/{x}/{y}' }, [p]);
    } catch (e) {
      expect((e as WeiwudiError).code).toBe('unsupported-template');
      expect((e as Error).message).toBe('URL template #1: cannot be resolved by the provider "rx"');
      expect(JSON.stringify((e as WeiwudiError).detail)).not.toContain('SECRET_MSG');
    }
  });

  it.each([
    ['Error', () => new Error('SECRET_MSG pk.leak')],
    ['credential-rejected の WeiwudiError', () => new WeiwudiError('credential-rejected', 'SECRET_MSG pk.leak', { leak: 'SECRET_MSG' })],
    ['別の code の WeiwudiError', () => new WeiwudiError('attribute-invalid', 'SECRET_MSG pk.leak', {})],
  ])('validateCredentials の例外（%s）は固定の文面の credential-rejected', (_l, make) => {
    const p = provider('vx', { matches: (u) => u.startsWith('https://vx.example/'), validateCredentials: () => { throw make(); } });
    expect.assertions(3);
    try {
      normalizeSpec({ kind: 'raster', url: 'https://vx.example/{z}/{x}/{y}.png' }, [p]);
    } catch (e) {
      expect((e as WeiwudiError).code).toBe('credential-rejected');
      expect((e as Error).message).toBe('Credentials are rejected by the provider "vx"');
      expect(JSON.stringify((e as WeiwudiError).detail)).not.toContain('SECRET_MSG');
    }
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

  it('applyCredentials の例外は console.error に提供元の id と例外の名前だけを出す', async () => {
    const h = createSwHarness();
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a); });
    addProvider(provider('thrower', {
      matches: (u) => u.startsWith('https://thr.example/'),
      applyCredentials: () => { throw new RangeError(`SECRET_MSG ${TOKEN}`); },
    }));
    h.fetch.mockImplementation(async () => png());
    await register(h, { kind: 'raster', id: 't', url: 'https://thr.example/{z}/{x}/{y}.png', credentials: { query: { k: 'KFAKE' } } });
    await h.flushRoutes();
    await h.dispatch('https://thr.example/3/1/2.png');
    expect((h.fetch.mock.calls[0][0] as Request).url).toBe('https://thr.example/3/1/2.png');
    const text = JSON.stringify(logged.map((a) => a.map(String)));
    expect(text).toContain('thrower');
    expect(text).toContain('RangeError');
    expect(text).not.toContain('SECRET_MSG');
    expect(text).not.toContain(TOKEN);
  });

  it('id が mapbox の利用者の提供元は標準の差し替えになり、再起動で未登録なら標準の mapbox を使う', async () => {
    const h = createSwHarness();
    addProvider(provider('mapbox', {
      matches: (u) => u.startsWith('mapbox://') || u.startsWith('https://api.mapbox.com/'),
      resolve: (u) => u.replace(/^mapbox:\/\/tiles\//, 'https://api.mapbox.com/v4/'),
      applyCredentials: (url) => { url.searchParams.set('mine', '1'); },
    }));
    h.fetch.mockImplementation(async () => png());
    const r = await register(h, { kind: 'raster', id: 'mb', url: MAPBOX_TILES, credentials: { query: { access_token: TOKEN } } });
    expect(r.ok).toBe(true);
    expect((await dump()).resources[0].provider).toBe('mapbox');
    await h.flushRoutes();
    await h.dispatch('https://api.mapbox.com/v4/u1.t1/3/1/2.png');
    expect((h.fetch.mock.calls[0][0] as Request).url).toBe('https://api.mapbox.com/v4/u1.t1/3/1/2.png?mine=1');
    _resetPluginsForTest();
    await h.dispatch('https://api.mapbox.com/v4/u1.t1/3/1/3.png');
    expect((h.fetch.mock.calls[1][0] as Request).url).toBe(`https://api.mapbox.com/v4/u1.t1/3/1/3.png?access_token=${TOKEN}`);
  });

  it('provider の違う Source は同じテンプレートでも合流させない（resource-conflict。資格情報は先の Source のもの）', async () => {
    const h = createSwHarness();
    h.fetch.mockImplementation(async () => png());
    const a = await register(h, { kind: 'raster', id: 'A', url: MAPBOX_TILES, credentials: { query: { access_token: 'pk.A_FAKE' } } });
    expect(a.ok).toBe(true);
    addProvider(provider('mine', { matches: (u) => u.startsWith('https://api.mapbox.com/') }));
    const b = await register(h, { kind: 'raster', id: 'B', url: HTTPS_TILES, credentials: { query: { access_token: 'pk.B_FAKE' } } });
    expect(b.ok).toBe(true);
    const rid = (await dump()).resources[0].id;
    expect(b.result.warnings).toEqual([`resource-conflict: ${rid}`]);
    const { resources } = await dump();
    expect(resources).toHaveLength(1);
    expect(resources[0].provider).toBe('mapbox');
    expect(resources[0].sourceIds).toEqual(['A']);
    expect(resources[0].rangeOnlySourceIds).toEqual(['B']);
    await h.flushRoutes();
    await h.dispatch('https://api.mapbox.com/v4/u1.t1/3/1/2.png');
    expect((h.fetch.mock.calls[0][0] as Request).url).toBe('https://api.mapbox.com/v4/u1.t1/3/1/2.png?access_token=pk.A_FAKE');
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
