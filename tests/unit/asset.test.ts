// kind: 'asset'（m3-t7・仕様 §5.1・§5.6・§12・R8・P1・R9）。子を持たない 1 つの Source（type: 'data'）。ハーネスの SW の制御と照合ルートで確かめる。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSwHarness, type SwHarness } from './sw-harness';
import { openStore, type SourceRecord } from '../../src/store';
import { normalizeSpec, type NormalizedSpec } from '../../src/spec';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const A = 'https://a.example/data/points.geojson';
const B = 'https://b.example/data/points.geojson';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { ok: boolean; result?: any; error?: { code: string; detail: Record<string, unknown> } };

const call = async (h: SwHarness, op: string, body: unknown = {}): Promise<Reply> => (await h.post(`/v2/${op}`, body))!.json();

const ok = async (h: SwHarness, op: string, body: unknown = {}) => {
  const r = await call(h, op, body);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.result;
};

const setup = () => {
  const h = createSwHarness();
  h.fetch.mockImplementation(async () => new Response('{"type":"FeatureCollection","features":[]}',
    { status: 200, headers: { 'content-type': 'application/geo+json' } }));
  return h;
};

const get = async (h: SwHarness, url: string): Promise<Response> => {
  await h.flushRoutes();
  return (await h.dispatch(url))!;
};

describe('asset', () => {
  it('登録すると type: data の Resource が 1 つ。捕捉して保存し、2 回目は hit', async () => {
    const h = setup();
    const info = await ok(h, 'register', { kind: 'asset', id: 'pts', url: A });
    expect(info).toMatchObject({ id: 'pts', kind: 'asset', url: A, warnings: [] });
    expect(info.resources).toEqual([{ id: A, type: 'data', templates: [A], count: 0, bytes: 0 }]);
    expect((await get(h, A)).headers.get('x-weiwudi-status')).toBe('miss');
    expect((await get(h, A)).headers.get('x-weiwudi-status')).toBe('hit');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('URL 配列はミラー（R8）: 2 つのミラーが 1 つの Resource の同じ Entry', async () => {
    const h = setup();
    const info = await ok(h, 'register', { kind: 'asset', id: 'pts', url: [A, B] });
    expect(info.url).toEqual([A, B]);
    expect(info.resources).toHaveLength(1);
    expect(info.resources[0].templates).toEqual([A, B]);
    expect((await get(h, A)).headers.get('x-weiwudi-status')).toBe('miss');
    expect((await get(h, B)).headers.get('x-weiwudi-status')).toBe('hit');
    expect((await ok(h, 'stats', { id: 'pts' })).count).toBe(1);
  });

  it('範囲を持たない（bounds・minZoom などを渡しても extents が無く、stats に total が無い）', async () => {
    const h = setup();
    await ok(h, 'register', { kind: 'asset', id: 'pts', url: A, bounds: [0, 0, 1, 1], minZoom: 0, maxZoom: 3 });
    const store = await openStore();
    const r = (await store.getResource(A))!;
    expect('extents' in r).toBe(false);
    expect(r.scheme).toBeUndefined();
    expect((await ok(h, 'stats', { id: 'pts' })).total).toBeUndefined();
  });

  it('P1: tile の Resource と衝突しても、その Resource の範囲は変わらない（rangeOnly にも入らない）', async () => {
    const h = setup();
    const store = await openStore();
    // tile の Resource が同じ URL の形を持つ（m2 で作られうる形を直接置く）
    const tile = normalizeSpec({ kind: 'raster', id: 't', url: 'https://a.example/{z}/{x}/{y}.png', minZoom: 3, maxZoom: 5 }) as NormalizedSpec;
    const rec: SourceRecord = { id: 't', kind: 'raster', spec: tile.spec, order: 1, warnings: [], createdAt: 0 };
    await store.putSource(rec);
    const extents = [tile.spec.extent!];
    await store.createResource({
      id: A, type: 'tile', templates: [A], sourceIds: ['t'], policy: tile.spec.policy, extents, count: 0, bytes: 0, pinnedBytes: 0,
    });
    const info = await ok(h, 'register', { kind: 'asset', id: 'pts', url: A });
    expect(info.warnings).toEqual([`resource-conflict: ${A}`]);
    const r = (await store.getResource(A))!;
    expect(r.extents).toEqual(extents);
    expect(r.rangeOnlySourceIds).toBeUndefined();
    expect(r.sourceIds).toEqual(['t']);
  });

  it('自分自身の update() の衝突は resource-conflict の例外で、何も変えない', async () => {
    const h = setup();
    await ok(h, 'register', { kind: 'asset', id: 'pts', url: A });
    const store = await openStore();
    const own = (await store.getResource(A))!;
    // 同じ URL に重なる 2 つ目の Resource（2 つ以上の既存 Resource に重なると合流を拒否する）
    await store.createResource({ ...own, id: `${A}#2`, sourceIds: ['x'] });
    const before = await store.getSource('pts');
    const r = await call(h, 'update', { id: 'pts' });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('resource-conflict');
    expect(await store.getSource('pts')).toEqual(before);
  });

  it('update()・clean()・remove() が asset でも通る', async () => {
    const h = setup();
    await ok(h, 'register', { kind: 'asset', id: 'pts', url: A });
    await get(h, A);
    expect((await ok(h, 'update', { id: 'pts' })).resources).toHaveLength(1);
    await ok(h, 'clean', { id: 'pts' });
    const store = await openStore();
    expect((await store.getResource(A))!.count).toBe(0);
    await ok(h, 'remove', { id: 'pts' });
    expect(await store.listResources()).toEqual([]);
  });
});
