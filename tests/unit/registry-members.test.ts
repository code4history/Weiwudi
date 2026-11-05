// registry の一般化の試験（m3-t2）。子 Source（R1・X1）・資源の型（conflictOf）・範囲の持ち主（P1・R9）・
// apply の引数（C-O12）・isExclusiveTo の一覧（C-S7）・同じ id の kind の替え（C-O5）・StyleSpec の保存と読み出し。
// 計画 docs/superpowers/plans/2026-11-04-m3-vector.md の m3-t2。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  apply, applyRegister, childLogicalName, childSourceId, composePolicy, isExclusiveTo, planRegister,
  type ApplyOptions,
} from '../../src/registry';
import { normalizeMember, normalizeSpec, type NormalizedSpec, type StoredSpec, type StyleSpec } from '../../src/spec';
import {
  openStore, styleSpecOf, storedSpecOf, type EntryMeta, type ResourceMeta, type ResourceType, type SourceRecord, type Store,
} from '../../src/store';
import { WeiwudiError } from '../../src/errors';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const P = 'style1';
const TILE = 'https://t.example/{z}/{x}/{y}.pbf';
const GLYPH = 'https://g.example/fonts/{fontstack}/{range}.pbf';
const DATA = 'https://d.example/points.json';
const CREDS = ['access_token', 'token', 'key', 'api_key', 'apikey', 'sku'];

/** 子の指定（t7 がスタイルの下位資源から作る形） */
const child = (type: ResourceType, logicalName: string, url: string, common: Record<string, unknown> = {}): NormalizedSpec =>
  normalizeMember(type, [url], common, {
    kind: 'child', internalId: childSourceId(P, type, logicalName), single: true, logicalName,
    encoding: type === 'tile' ? 'vector' : undefined,
  });

const styleRecord = (over: Partial<StyleSpec> = {}, order = 1): SourceRecord => {
  const spec: StyleSpec = {
    kind: 'style', id: P, url: 'https://s.example/style.json', templates: ['https://s.example/style.json'],
    policy: { cacheTtl: 1000, store: false, outOfRange: { extent: 'not-found', zoom: 'not-found' }, credentialParams: CREDS },
    children: [],
    ...over,
  };
  return { id: P, kind: 'style', spec, order, warnings: [], createdAt: 0 };
};

const rec = (n: NormalizedSpec, order: number, over: Partial<SourceRecord> = {}): SourceRecord =>
  ({ id: n.spec.id, kind: n.spec.kind, spec: n.spec, order, warnings: [], createdAt: 0, ...over });

const res = (id: string, over: Partial<ResourceMeta> = {}): ResourceMeta => ({
  id, type: 'tile', templates: [id], sourceIds: ['s1'], encoding: 'raster', scheme: 'xyz',
  policy: { cacheTtl: 1000, store: false, outOfRange: { extent: 'transparent', zoom: 'transparent' }, credentialParams: CREDS },
  count: 0, bytes: 0, pinnedBytes: 0, ...over,
});

const REGISTER: ApplyOptions = { throwOnConflict: false, resetCors: false };

describe('子 Source の id と論理名（X1・O-N8）', () => {
  it.each([
    ['source', 'a b/c', 'a%20b%2Fc'],
    ['tilejson-tiles', 'a/b', 'a%2Fb/tiles'],
    ['glyphs', undefined, 'glyphs'],
    ['sprite', undefined, 'sprite'],
    ['sprite', 'x/y', 'sprite/x%2Fy'],
    ['data', 'pts', 'sources/pts/data'],
    ['style', undefined, 'style'],
  ] as const)('%s(%s) → %s（キーと id の部分だけ encodeURIComponent）', (slot, key, name) => {
    expect(childLogicalName(slot, key)).toBe(name);
  });

  it('子の id は "<parentId>\\0<type>:<論理名>"', () => {
    expect(childSourceId('p', 'tile', 'a')).toBe('p\u0000tile:a');
  });
});

describe('純粋関数: 範囲の持ち主・型の違う衝突・isExclusiveTo', () => {
  it('型の違う衝突（tile の Resource に data の指定）は resource-conflict だが rangeOnly に入らない（P1）', () => {
    const plan = planRegister(normalizeMember('data', [DATA], {}, { kind: 'asset', id: 'd', single: true }),
      undefined, [res(DATA, { sourceIds: ['t'] })]);
    expect(plan.warnings).toEqual([`resource-conflict: ${DATA}`]);
    expect(plan.conflicts).toEqual([DATA]);
    expect(plan.rangeOnly).toEqual([]);
    expect(plan.join).toBeUndefined();
  });

  it('tile どうしの encoding 違いは範囲だけ足す（m2 と同じ）', () => {
    const plan = planRegister(normalizeSpec({ kind: 'vector', id: 'v', url: TILE }), undefined,
      [res(TILE, { encoding: 'raster' })]);
    expect(plan.warnings).toEqual([`resource-conflict: ${TILE}`]);
    expect(plan.rangeOnly).toEqual([TILE]);
  });

  it('asset（data）の Source の合成で extents が作られない', () => {
    const d = normalizeMember('data', [DATA], {}, { kind: 'asset', id: 'd', single: true });
    const { extents } = composePolicy(res(DATA, { type: 'data' }), [rec(d, 1)], [rec(d, 1)]);
    expect(extents).toEqual([]);
  });

  it.each([
    ['親の子だけ', res(TILE, { sourceIds: ['c1', 'c2'] }), true],
    ['他の Source あり', res(TILE, { sourceIds: ['c1', 'x'] }), false],
    ['範囲だけの他者あり', res(TILE, { sourceIds: ['c1'], rangeOnlySourceIds: ['x'] }), false],
    ['空', res(TILE, { sourceIds: [] }), false],
  ])('isExclusiveTo（一覧）: %s → %s', (_name, r, want) => {
    expect(isExclusiveTo(r, ['c1', 'c2'])).toBe(want);
  });

  it('isExclusiveTo の文字列は 1 つの一覧として読む（m2 の呼び出しのまま）', () => {
    expect(isExclusiveTo(res(TILE, { sourceIds: ['c1'] }), 'c1')).toBe(true);
    expect(isExclusiveTo(res(TILE, { sourceIds: ['c1', 'c2'] }), 'c1')).toBe(false);
  });
});

describe('store 上の合流（IndexedDB）', () => {
  let store: Store;
  let tick = 0;

  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    store = await openStore();
  });

  afterEach(() => {
    store.close();
  });

  const putTile = async (resourceId: string, suffix = '1_0_0', size = 10) => {
    const t = ++tick;
    const meta: EntryMeta = { key: `${resourceId}\0${suffix}`, resourceId, size, fetchedAt: t, accessedAt: t, pinned: 0 };
    expect((await store.putEntry(meta, { key: meta.key, blob: new Blob([new Uint8Array(size)]), headers: {} }, [])).saved).toBe(true);
  };

  /** 子を親の order で登録する（t7 の register の子の扱い） */
  const applyChild = async (n: NormalizedSpec, opts: Partial<ApplyOptions> = {}) =>
    apply(store, n, await store.getSource(n.spec.id), { ...REGISTER, order: 5, parentId: P, ...opts });

  it('子 Source 2 つ（tile と glyph）を同じ親で登録 → Resource 2 つ・sourceIds は子の id・order は親と同じ', async () => {
    await store.putSource(styleRecord({}, 5));
    const t = child('tile', childLogicalName('source', 'base'), TILE);
    const g = child('glyph', childLogicalName('glyphs'), GLYPH);
    await applyChild(t);
    await applyChild(g);
    const resources = await store.listResources();
    expect(resources.map((r) => [r.id, r.type, r.sourceIds])).toEqual(expect.arrayContaining([
      [TILE, 'tile', [t.spec.id]],
      [GLYPH, 'glyph', [g.spec.id]],
    ]));
    expect(resources).toHaveLength(2);
    const glyph = resources.find((r) => r.id === GLYPH)!;
    expect(glyph.extents).toBeUndefined();
    expect(glyph.encoding).toBeUndefined();
    expect(glyph.scheme).toBeUndefined();
    expect(resources.find((r) => r.id === TILE)).toMatchObject({ encoding: 'vector', scheme: 'xyz' });
    const sources = await store.listSources();
    const byId = (x: unknown[], y: unknown[]) => (String(x[0]) < String(y[0]) ? -1 : 1);
    expect(sources.map((s) => [s.id, s.order, s.parentId]).sort(byId)).toEqual([
      [P, 5, undefined], [t.spec.id, 5, P], [g.spec.id, 5, P],
    ].sort(byId));
    expect(storedSpecOf(sources.find((s) => s.id === g.spec.id)!)).toMatchObject({ kind: 'child', type: 'glyph', logicalName: 'glyphs' });
  });

  it('型の違う衝突（tile の Resource に data の指定）→ rangeOnly に入らず extents が変わらない（P1 の再現）', async () => {
    const tileSpec = normalizeSpec({ kind: 'raster', id: 't', url: 'https://d.example/{z}/{x}/{y}.png', minZoom: 3, maxZoom: 5 });
    await store.putSource(rec(tileSpec, 1));
    const extents = [tileSpec.spec.extent!];
    await store.createResource(res(DATA, { sourceIds: ['t'], extents }));
    const out = await applyRegister(store, normalizeMember('data', [DATA], {}, { kind: 'asset', id: 'd', single: true }));
    expect(out.warnings).toEqual([`resource-conflict: ${DATA}`]);
    const r = await store.getResource(DATA);
    expect(r?.rangeOnlySourceIds).toBeUndefined();
    expect(r?.extents).toEqual(extents);
    expect(r?.sourceIds).toEqual(['t']);
  });

  it('tile でない Resource の範囲だけの計算し直しは extents を書かない（L1 m1）', async () => {
    const d = normalizeMember('data', [DATA], {}, { kind: 'asset', id: 'd', single: true });
    await store.putSource(rec(d, 1));
    await store.putSource(rec(normalizeSpec({ kind: 'raster', id: 'x', url: TILE }), 2));
    // 範囲だけの参加者 x を持つ data の Resource（m2 の形）。x の再登録で参照が消え、範囲だけを計算し直す
    await store.createResource(res(DATA, { type: 'data', sourceIds: ['d'], rangeOnlySourceIds: ['x'] }));
    await applyRegister(store, normalizeSpec({ kind: 'raster', id: 'x', url: 'https://x.example/{z}/{x}/{y}.png' }));
    const r = await store.getResource(DATA);
    expect(r?.rangeOnlySourceIds).toBeUndefined();
    expect(r && 'extents' in r).toBe(false);
  });

  it('m2 の型の記録（type が無い spec）を読んで tile として合成できる', async () => {
    const n = normalizeSpec({ kind: 'raster', id: 'old', url: TILE, minZoom: 2, maxZoom: 4 });
    const legacyShape = { ...n.spec } as Partial<StoredSpec>;
    delete legacyShape.type;
    await store.putSource({ id: 'old', kind: 'raster', spec: legacyShape as StoredSpec, order: 1, warnings: [], createdAt: 0 });
    expect(storedSpecOf((await store.getSource('old'))!)?.type).toBe('tile');
    await store.createResource(res(TILE, { sourceIds: ['old'], encoding: 'raster' }));
    // 同じ URL の新しい登録が合流し、old の範囲が extents に入る
    await applyRegister(store, normalizeSpec({ kind: 'raster', id: 'new', url: TILE }));
    const r = await store.getResource(TILE);
    expect(r?.sourceIds).toEqual(['old', 'new']);
    expect(r?.extents).toContainEqual({ minZoom: 2, maxZoom: 4, sourceId: 'old' });
  });

  it('X1: 同じ URL で bounds の違う 2 つの論理ソース → 子 2 つ・Resource 1 つ・extents は和。bounds を替えても子の id は変わらない', async () => {
    await store.putSource(styleRecord({}, 5));
    const a = child('tile', childLogicalName('source', 'a'), TILE, { bounds: [130, 30, 140, 40], maxZoom: 8 });
    const b = child('tile', childLogicalName('source', 'b'), TILE, { bounds: [-10, -10, 0, 0], maxZoom: 8 });
    expect(a.spec.id).not.toBe(b.spec.id);
    await applyChild(a);
    await applyChild(b);
    const resources = await store.listResources();
    expect(resources).toHaveLength(1);
    expect(resources[0].sourceIds).toEqual([a.spec.id, b.spec.id]);
    expect(resources[0].extents).toEqual([a.spec.extent, b.spec.extent]);

    const a2 = child('tile', childLogicalName('source', 'a'), TILE, { bounds: [135, 35, 136, 36], maxZoom: 9 });
    expect(a2.spec.id).toBe(a.spec.id);
    await applyChild(a2);
    const after = await store.getResource(TILE);
    expect(after?.sourceIds).toEqual([a.spec.id, b.spec.id]);
    expect(after?.extents).toEqual([a2.spec.extent, b.spec.extent]);
    expect((await store.listSources()).filter((s) => s.parentId === P).map((s) => s.id).sort()).toEqual([a.spec.id, b.spec.id].sort());
  });

  it('同じ id で kind を替えた登録は attribute-invalid で、何も変わらない（C-O5）', async () => {
    await applyRegister(store, normalizeSpec({ kind: 'raster', id: 'k', url: TILE }));
    const before = { source: await store.getSource('k'), resources: await store.listResources() };
    const err = await applyRegister(store, normalizeSpec({ kind: 'vector', id: 'k', url: TILE })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WeiwudiError);
    expect((err as WeiwudiError).code).toBe('attribute-invalid');
    expect((err as WeiwudiError).detail).toEqual({ attribute: 'kind' });
    expect({ source: await store.getSource('k'), resources: await store.listResources() }).toEqual(before);
  });

  it('apply を { throwOnConflict: false, resetCors: true } で呼ぶと、衝突しても例外にならず合流先の corsOk・corslessUntil が消える（C-O12）', async () => {
    await store.putSource(styleRecord({}, 5));
    const t = child('tile', childLogicalName('source', 'base'), TILE);
    const g = child('glyph', childLogicalName('glyphs'), GLYPH);
    await applyChild(t);
    await applyChild(g);
    await store.patchResource(TILE, (m) => ({ ...m, corsOk: true, corslessUntil: 99 }));
    await store.patchResource(GLYPH, (m) => ({ ...m, corsOk: true, corslessUntil: 99 }));
    await putTile(TILE);

    // applyRegister 自身は { false, false }: 衝突の無い再登録でも corsOk を消さない
    await applyChild(g);
    expect(await store.getResource(GLYPH)).toMatchObject({ corsOk: true, corslessUntil: 99 });

    // スタイルの update()（P2）: tile の子は credentialParams が広がって衝突（keep）、glyph の子は合流し直す
    const P2: Partial<ApplyOptions> = { resetCors: true };
    const conflicted = await applyChild(child('tile', childLogicalName('source', 'base'), TILE, { credentialParams: ['sig'] }), P2);
    expect(conflicted.warnings).toEqual([`resource-conflict: ${TILE}`]);
    await applyChild(g, P2);
    expect(await store.getResource(TILE)).toMatchObject({ corsOk: true, corslessUntil: 99, sourceIds: [t.spec.id] });
    const glyph = await store.getResource(GLYPH);
    expect(glyph?.corsOk).toBeUndefined();
    expect(glyph?.corslessUntil).toBeUndefined();
  });

  it('StyleSpec の children が保存・読み出しで往復する。children の無い記録は空の配列として読める', async () => {
    const children: StyleSpec['children'] = [
      { id: childSourceId(P, 'tilejson', 'a'), logicalName: 'a', type: 'tilejson' },
      { id: childSourceId(P, 'tile', 'a/tiles'), logicalName: 'a/tiles', type: 'tile', from: childSourceId(P, 'tilejson', 'a') },
    ];
    await store.putSource(styleRecord({ children, fonts: ['Noto Sans Regular'], cacheMaxBytes: 100 }));
    const read = styleSpecOf((await store.getSource(P))!);
    expect(read?.children).toEqual(children);
    expect(read?.fonts).toEqual(['Noto Sans Regular']);
    expect(storedSpecOf((await store.getSource(P))!)).toBeUndefined();

    const bare = styleRecord();
    delete (bare.spec as Partial<StyleSpec>).children;
    await store.putSource(bare);
    expect(styleSpecOf((await store.getSource(P))!)?.children).toEqual([]);
    expect(styleSpecOf(rec(normalizeSpec({ kind: 'raster', id: 'r', url: TILE }), 1))).toBeUndefined();
  });
});
