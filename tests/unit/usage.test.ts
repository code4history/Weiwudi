// Weiwudi.usage() の SW 側（POST /v2/usage。m3-t8・R19・#38・仕様 §12）。ハーネスの SW の制御と照合ルートで確かめる。
// 実ネットワーク・実トークンは使わない（標準の mapbox の提供元は偽の fetch で答える）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSwHarness, SW_SELF_ORIGIN, type SwHarness } from './sw-harness';
import { openStore, type EntryMeta, type ResourceMeta } from '../../src/store';
import { _resetPluginsForTest } from '../../src/plugins';

afterEach(() => {
  _resetPluginsForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const TOKEN = 'pk.FAKE_USAGE_TOKEN';
const TPL = 'https://t.example/{z}/{x}/{y}.png';
const MAPBOX = 'mapbox://tiles/u1.t1/{z}/{x}/{y}.png';
const MAPBOX_TILE = 'https://api.mapbox.com/v4/u1.t1/3/1/2.png';
const GID = 'https://g.example/fonts/{fontstack}/{range}.pbf';

/** n バイトの png */
const png = (n = 3) => new Response(new Uint8Array(n).fill(1), { status: 200, headers: { 'content-type': 'image/png' } });

const harness = (): SwHarness => {
  const h = createSwHarness();
  h.fetch.mockImplementation(async () => png());
  return h;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ok = async (h: SwHarness, op: string, body: unknown = {}): Promise<any> => {
  const r = await (await h.post(`/v2/${op}`, body))!.json();
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.result;
};

const tile = async (h: SwHarness, url: string) => {
  await h.flushRoutes();
  expect((await h.dispatch(url))!.headers.get('x-weiwudi-status')).toBe('miss');
};

const policy: ResourceMeta['policy'] = {
  cacheTtl: 60_000, store: true, outOfRange: { extent: 'not-found', zoom: 'not-found' }, credentialParams: [],
};

describe('usage（R19・#38）', () => {
  it('Resource が無ければ 0 と空の byProvider', async () => {
    const h = harness();
    expect(await ok(h, 'usage')).toEqual({ count: 0, bytes: 0, byProvider: {} });
  });

  it('提供元の Resource は ResourceMeta.provider を鍵に、無いものは先頭のテンプレートの origin を鍵にする', async () => {
    const h = harness();
    await ok(h, 'register', { kind: 'raster', id: 'mb', url: MAPBOX, credentials: { query: { access_token: TOKEN } } });
    await ok(h, 'register', { kind: 'raster', id: 't', url: TPL });
    await tile(h, MAPBOX_TILE);
    await tile(h, 'https://t.example/3/1/2.png');
    await tile(h, 'https://t.example/3/1/3.png');
    expect((await (await openStore()).getResource('https://api.mapbox.com/v4/u1.t1/{z}/{x}/{y}.png'))!.provider).toBe('mapbox');
    expect(await ok(h, 'usage')).toEqual({
      count: 3, bytes: 9,
      byProvider: { mapbox: { count: 1, bytes: 3 }, 'https://t.example': { count: 2, bytes: 6 } },
    });
  });

  it('旧 API の地図（map:）も数える。相対の URL は SW の場所で解決した origin', async () => {
    const h = harness();
    await h.request(`/api/add?mapID=m&type=xyz&url=${encodeURIComponent('./tiles/{z}/{x}/{y}.png')}&width=1024&height=1024`);
    expect((await h.request('/api/cache/m/2/1/0')).status).toBe(200);
    await h.request(`/api/add?mapID=a&type=xyz&url=${encodeURIComponent(TPL)}&width=1024&height=1024`);
    expect((await h.request('/api/cache/a/2/1/0')).status).toBe(200);
    await ok(h, 'register', { kind: 'raster', id: 't', url: TPL });
    await tile(h, 'https://t.example/3/1/2.png');
    expect(await ok(h, 'usage')).toEqual({
      count: 3, bytes: 9,
      byProvider: { [SW_SELF_ORIGIN]: { count: 1, bytes: 3 }, 'https://t.example': { count: 2, bytes: 6 } },
    });
  });

  it('提供元が __proto__ でも壊れない（null プロトタイプ。JSON にも出る）', async () => {
    const h = harness();
    await ok(h, 'register', { kind: 'raster', id: 't', url: TPL });
    await tile(h, 'https://t.example/3/1/2.png');
    await (await openStore()).patchResource(TPL, (m) => ({ ...m, provider: '__proto__' }));
    const u = await ok(h, 'usage');
    expect(Object.keys(u.byProvider)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(u.byProvider, '__proto__')!.value).toEqual({ count: 1, bytes: 3 });
    expect(u).toMatchObject({ count: 1, bytes: 3 });
  });

  it('グリフの結合レコード（fontstack ごと）の大きさを数える', async () => {
    const h = harness();
    const store = await openStore();
    await store.createResource({ id: GID, type: 'glyph', templates: [GID], sourceIds: ['g'], policy, count: 0, bytes: 0, pinnedBytes: 0 });
    const meta = (fontstack: string): EntryMeta => ({
      key: `${GID}\0${fontstack}`, resourceId: GID, size: 0, fetchedAt: 1, accessedAt: 1, pinned: 0,
    });
    const blob = (n: number) => new Blob([new Uint8Array(n).fill(2)]);
    await store.putGlyphParts(meta('A'), [{ part: '0-255', blob: blob(4), fetchedAt: 1 }, { part: '256-511', blob: blob(5), fetchedAt: 1 }], {}, []);
    await store.putGlyphParts(meta('B'), [{ part: '0-255', blob: blob(7), fetchedAt: 1 }], {}, []);
    expect(await ok(h, 'usage')).toEqual({
      count: 2, bytes: 16, byProvider: { 'https://g.example': { count: 2, bytes: 16 } },
    });
  });
});
