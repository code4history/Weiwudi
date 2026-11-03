// src/registry.ts の試験（m2-t6）。仕様 §5.1・§5.6、計画 docs/superpowers/plans/2026-11-03-m2-core.md の m2-t6。
// 各 it が仕様の文 1 つ。planRegister・composePolicy・isExclusiveTo・credentialSourceFor の試験は IndexedDB を使わない。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  applyRegister, applyRemove, applyUpdate, composePolicy, credentialSourceFor, isExclusiveTo, planRegister,
} from '../../src/registry';
import { normalizeSpec, type NormalizedSpec } from '../../src/spec';
import { openStore, type EntryMeta, type ResourceMeta, type SourceRecord, type Store } from '../../src/store';
import { WeiwudiError } from '../../src/errors';
import { createSwHarness, tileResponse } from './sw-harness';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const A = 'https://a.example/{z}/{x}/{y}.png';
const B = 'https://b.example/{z}/{x}/{y}.png';
const C = 'https://c.example/{z}/{x}/{y}.png';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ns = (over: Record<string, any> = {}): NormalizedSpec => normalizeSpec({ kind: 'raster', url: A, ...over });

const rec = (n: NormalizedSpec, order: number): SourceRecord =>
  ({ id: n.spec.id, kind: n.spec.kind, spec: n.spec, order, warnings: [], createdAt: 0 });

const res = (id: string, over: Partial<ResourceMeta> = {}): ResourceMeta => ({
  id,
  type: 'tile',
  templates: [id],
  sourceIds: ['s1'],
  encoding: 'raster',
  scheme: 'xyz',
  policy: {
    cacheTtl: 1000, store: false, outOfRange: { extent: 'transparent', zoom: 'transparent' },
    credentialParams: ['access_token', 'token', 'key', 'api_key', 'apikey', 'sku'],
  },
  count: 0,
  bytes: 0,
  pinnedBytes: 0,
  ...over,
});

// ---- 純粋関数（IndexedDB を使わない） ----

describe('composePolicy: 合成の 8 行（仕様 §5.6 の表）', () => {
  const tokyo = ns({ id: 'tokyo', minZoom: 0, maxZoom: 10, box: { minX: 900, maxX: 910, minY: 400, maxY: 410 } });
  const osaka = ns({ id: 'osaka', minZoom: 5, maxZoom: 12, box: { minX: 3500, maxX: 3510, minY: 1600, maxY: 1610 } });

  it('範囲: 和集合（Source ごとの TileExtent を全部持つ）', () => {
    const { extents } = composePolicy(res(A), [rec(tokyo, 1), rec(osaka, 2)], []);
    expect(extents).toEqual([tokyo.spec.extent, osaka.spec.extent]);
  });

  it('範囲: 範囲の指定が無い Source が 1 つでもあれば広がりの制限なし（box の無い全ズームの extent が入る）', () => {
    const free = ns({ id: 'free' });
    const { extents } = composePolicy(res(A), [rec(tokyo, 1), rec(free, 2)], []);
    expect(extents).toContainEqual({ minZoom: 0, maxZoom: 30, sourceId: 'free' });
  });

  it('ズーム: Source ごとの minZoom・maxZoom がそのまま和になる', () => {
    const { extents } = composePolicy(res(A), [rec(tokyo, 1), rec(osaka, 2)], []);
    expect(extents?.map((e) => [e.minZoom, e.maxZoom])).toEqual([[0, 10], [5, 12]]);
  });

  it('cacheTtl: 最短', () => {
    const { policy } = composePolicy(res(A), [rec(ns({ id: 'p', cacheTtl: 500 }), 1), rec(ns({ id: 'q', cacheTtl: 300 }), 2)], []);
    expect(policy.cacheTtl).toBe(300);
  });

  it('cacheRetention: 最長。指定なしの Source があれば無期限', () => {
    const p = rec(ns({ id: 'p', cacheRetention: 100 }), 1);
    const q = rec(ns({ id: 'q', cacheRetention: 900 }), 2);
    expect(composePolicy(res(A), [p, q], []).policy.cacheRetention).toBe(900);
    const r = composePolicy(res(A), [p, q, rec(ns({ id: 'r' }), 3)], []).policy;
    expect(r.cacheRetention).toBeUndefined();
    expect('cacheRetention' in r).toBe(false);
  });

  it('outOfRange: 全 Source で同じならその値、違えば型の既定（ラスタは transparent・ベクタは empty）', () => {
    const nf = { outOfRange: { extent: 'not-found', zoom: 'not-found' } };
    const same = composePolicy(res(A), [rec(ns({ id: 'p', ...nf }), 1), rec(ns({ id: 'q', ...nf }), 2)], []);
    expect(same.policy.outOfRange).toEqual({ extent: 'not-found', zoom: 'not-found' });
    const diff = composePolicy(res(A), [rec(ns({ id: 'p', ...nf }), 1), rec(ns({ id: 'q' }), 2)], []);
    expect(diff.policy.outOfRange).toEqual({ extent: 'transparent', zoom: 'transparent' });
    const vnf = { kind: 'vector', outOfRange: { zoom: 'not-found' } };
    const vector = composePolicy(res(A, { encoding: 'vector' }),
      [rec(ns({ id: 'p', ...vnf }), 1), rec(ns({ id: 'q', kind: 'vector' }), 2)], []);
    // extent は両方 empty で同じ、zoom は違うので既定の empty
    expect(vector.policy.outOfRange).toEqual({ extent: 'empty', zoom: 'empty' });
  });

  it('store（cachePrivate）: 全 Source が true のときだけ true', () => {
    const t = rec(ns({ id: 'p', cachePrivate: true }), 1);
    expect(composePolicy(res(A), [t, rec(ns({ id: 'q', cachePrivate: true }), 2)], []).policy.store).toBe(true);
    expect(composePolicy(res(A), [t, rec(ns({ id: 'q' }), 2)], []).policy.store).toBe(false);
  });

  it('資格情報: sourceIds の登録順で、持っている最初の Source のもの。消せば次へ移る', () => {
    const r = res(A, { sourceIds: ['q', 'p', 'r'] });
    const sources = [rec(ns({ id: 'q' }), 2), rec(ns({ id: 'p' }), 1), rec(ns({ id: 'r' }), 3)];
    expect(credentialSourceFor(r, sources, ['q', 'r'])).toBe('q');
    expect(credentialSourceFor(r, sources, ['p', 'q', 'r'])).toBe('p'); // 登録順（order）で p が先
    expect(credentialSourceFor(res(A, { sourceIds: ['q', 'r'] }), sources, ['p', 'q', 'r'])).toBe('q');
    expect(credentialSourceFor(r, sources, [])).toBeUndefined();
  });

  it('credentialParams: 和集合（Entry が無いとき）', () => {
    const { policy } = composePolicy(res(A), [rec(ns({ id: 'p', credentialParams: ['foo'] }), 1),
      rec(ns({ id: 'q', credentialParams: ['bar'] }), 2)], []);
    expect([...policy.credentialParams].sort()).toEqual(['access_token', 'api_key', 'apikey', 'bar', 'foo', 'key', 'sku', 'token']);
  });

  it('credentialParams: Entry がある間は計算し直さない（縮めない）', () => {
    const old = [...res(A).policy.credentialParams, 'foo'];
    const r = res(A, { count: 3, policy: { ...res(A).policy, credentialParams: old } });
    expect(composePolicy(r, [rec(ns({ id: 'p' }), 1)], []).policy.credentialParams).toEqual(old);
    // Entry が無ければ縮む
    expect(composePolicy({ ...r, count: 0 }, [rec(ns({ id: 'p' }), 1)], []).policy.credentialParams).not.toContain('foo');
  });

  it('範囲だけの Source は extents にだけ入り、他の方針の合成に入らない', () => {
    const only = rec(ns({ id: 'only', cacheTtl: 1, cacheRetention: 5, maxZoom: 3 }), 2);
    const { policy, extents } = composePolicy(res(A), [rec(ns({ id: 'p', cacheTtl: 900 }), 1)], [only]);
    expect(policy.cacheTtl).toBe(900);
    expect(policy.cacheRetention).toBeUndefined();
    expect(extents?.map((e) => e.sourceId)).toEqual(['p', 'only']);
  });

  it('scheme の違う範囲だけの Source は maxZoom で y を反転して読み替える（ズームはそのまま）', () => {
    const tms = rec(ns({ id: 'tms', scheme: 'tms', minZoom: 2, maxZoom: 4, box: { minX: 1, maxX: 2, minY: 3, maxY: 5 } }), 2);
    const { extents } = composePolicy(res(A, { scheme: 'xyz' }), [rec(ns({ id: 'p' }), 1)], [tms]);
    // 2^4 − 1 = 15: minY' = 15 − 5 = 10・maxY' = 15 − 3 = 12
    expect(extents?.[1]).toEqual({ minZoom: 2, maxZoom: 4, sourceId: 'tms', box: { minX: 1, maxX: 2, minY: 10, maxY: 12 } });
    // 元の spec は書き換えない
    expect((tms.spec as { extent?: { box?: unknown } }).extent?.box).toEqual({ minX: 1, maxX: 2, minY: 3, maxY: 5 });
  });
});

describe('planRegister: 拒否の 3 条件（仕様 §5.6）', () => {
  it('重ならなければ新しい Resource（id は先頭のテンプレートの正規化）', () => {
    const plan = planRegister(ns({ id: 'p', url: [B, A] }), undefined, [res(C)]);
    expect(plan.join).toEqual({ resourceId: B, create: true });
    expect(plan.warnings).toEqual([]);
  });

  it('ミラーの 1 つが重なれば合流し、既存の id を変えない', () => {
    const plan = planRegister(ns({ id: 'p', url: [B, A] }), undefined, [res(A)]);
    expect(plan.join).toEqual({ resourceId: A, create: false });
  });

  it('credentialParams の和が広がり Entry があれば拒否、Entry が無ければ合流', () => {
    const widen = ns({ id: 'p', credentialParams: ['foo'] });
    const withEntries = planRegister(widen, undefined, [res(A, { count: 1 })]);
    expect(withEntries.join).toBeUndefined();
    expect(withEntries.conflicts).toEqual([A]);
    expect(withEntries.warnings).toEqual([`resource-conflict: ${A}`]);
    expect(planRegister(widen, undefined, [res(A)]).join).toEqual({ resourceId: A, create: false });
    // 狭い側（既定だけ）の登録は Entry があっても拒否しない
    expect(planRegister(ns({ id: 'p' }), undefined, [res(A, { count: 1 })]).join).toEqual({ resourceId: A, create: false });
  });

  it('scheme・encoding・type が違えば拒否', () => {
    expect(planRegister(ns({ id: 'p', scheme: 'tms' }), undefined, [res(A)]).conflicts).toEqual([A]);
    expect(planRegister(ns({ id: 'p', kind: 'vector' }), undefined, [res(A)]).conflicts).toEqual([A]);
    expect(planRegister(ns({ id: 'p' }), undefined, [res(A, { type: 'sprite' })]).conflicts).toEqual([A]);
  });

  it('2 つ以上の既存 Resource に重なれば、どれとも合流しない', () => {
    const plan = planRegister(ns({ id: 'p', url: [A, B] }), undefined, [res(A), res(B)]);
    expect(plan.join).toBeUndefined();
    expect(plan.conflicts).toEqual([A, B]);
    expect(plan.rangeOnly).toEqual([A, B]);
  });

  it('既に属している Resource との衝突は keep（rangeOnly へ移さない。S-I）', () => {
    const p = ns({ id: 'p', credentialParams: ['foo'] });
    const plan = planRegister(p, rec(ns({ id: 'p' }), 1), [res(A, { sourceIds: ['p'], count: 2 })]);
    expect(plan.keep).toEqual([A]);
    expect(plan.rangeOnly).toEqual([]);
    expect(plan.warnings).toEqual([`resource-conflict: ${A}`]);
  });

  it('旧 API の Resource（map: の id）は合流の候補に入らない（第 2 回 S-6）', () => {
    const legacy = res('map:m', { templates: [A], sourceIds: ['map:m'], policy: { ...res(A).policy, credentialParams: [] } });
    const plan = planRegister(ns({ id: 'p' }), undefined, [legacy]);
    expect(plan.join).toEqual({ resourceId: A, create: true });
    expect(plan.conflicts).toEqual([]);
  });

  it('既定の id が他の Resource（重ならない）に使われていれば、次のテンプレートか連番の id にする', () => {
    const taken = res(A, { templates: [C] });
    expect(planRegister(ns({ id: 'p', url: [A, B] }), undefined, [taken]).join).toEqual({ resourceId: B, create: true });
    expect(planRegister(ns({ id: 'p' }), undefined, [taken]).join).toEqual({ resourceId: `${A}#2`, create: true });
  });

  it('前の登録で参照していて今回は重ならない Resource は leave', () => {
    const plan = planRegister(ns({ id: 'p', url: B }), rec(ns({ id: 'p' }), 1),
      [res(A, { sourceIds: ['p', 'q'] }), res(C, { sourceIds: ['q'], rangeOnlySourceIds: ['p'] })]);
    expect(plan.leave).toEqual([A, C]);
  });
});

describe('isExclusiveTo（clean・remove の判定）', () => {
  it.each([
    ['単独', res(A, { sourceIds: ['p'] }), true],
    ['共有', res(A, { sourceIds: ['p', 'q'] }), false],
    ['範囲だけの他者あり', res(A, { sourceIds: ['p'], rangeOnlySourceIds: ['q'] }), false],
    ['自分が範囲だけ', res(A, { sourceIds: ['q'], rangeOnlySourceIds: ['p'] }), false],
  ])('%s', (_label, r, want) => {
    expect(isExclusiveTo(r, 'p')).toBe(want);
  });
});

// ---- 保存を伴う試験（fake-indexeddb） ----

describe('applyRegister・applyUpdate・applyRemove', () => {
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

  /** Resource に Entry を 1 枚足す（count・bytes は store が直す） */
  const putTile = async (resourceId: string, suffix = '1_0_0', size = 10) => {
    const t = ++tick;
    const meta: EntryMeta = { key: `${resourceId}\0${suffix}`, resourceId, size, fetchedAt: t, accessedAt: t, pinned: 0 };
    const r = await store.putEntry(meta, { key: meta.key, blob: new Blob([new Uint8Array(size)]), headers: {} }, []);
    expect(r.saved).toBe(true);
  };

  const get = async (id: string) => store.getResource(id);

  it('新しい登録で Source と Resource を作る', async () => {
    const out = await applyRegister(store, ns({ id: 'p', cacheTtl: 5 }));
    expect(out.warnings).toEqual([]);
    expect(out.source).toMatchObject({ id: 'p', kind: 'raster', order: 1, warnings: [] });
    const r = await get(A);
    expect(r).toMatchObject({ id: A, type: 'tile', encoding: 'raster', scheme: 'xyz', templates: [A], sourceIds: ['p'] });
    expect(r?.policy.cacheTtl).toBe(5);
    expect(out.resources.map((x) => x.id)).toEqual([A]);
    expect((await store.getSource('p'))?.order).toBe(1);
    expect((await applyRegister(store, ns({ id: 'q', url: B }))).source.order).toBe(2);
  });

  it('合流すると sourceIds に足し、テンプレートと方針を合成し直す', async () => {
    await applyRegister(store, ns({ id: 'p', cacheTtl: 500 }));
    await applyRegister(store, ns({ id: 'q', url: [B, A], cacheTtl: 100 }));
    const r = await get(A);
    expect(r?.sourceIds).toEqual(['p', 'q']);
    expect(r?.templates).toEqual([A, B]);
    expect(r?.policy.cacheTtl).toBe(100);
    expect(await get(B)).toBeUndefined();
  });

  it('S-I: 同じ id で credentialParams を足して再登録（Entry あり）は例外にせず warnings・sourceIds に残る・方針と範囲が古いまま', async () => {
    await applyRegister(store, ns({ id: 'p', cacheTtl: 500, maxZoom: 5 }));
    await putTile(A);
    const before = await get(A);
    const out = await applyRegister(store, ns({ id: 'p', cacheTtl: 1, maxZoom: 9, credentialParams: ['foo'] }));
    expect(out.warnings).toEqual([`resource-conflict: ${A}`]);
    expect((await store.getSource('p'))?.warnings).toEqual([`resource-conflict: ${A}`]);
    const after = await get(A);
    expect(after?.sourceIds).toEqual(['p']);
    expect(after?.rangeOnlySourceIds ?? []).toEqual([]);
    expect(after?.policy).toEqual(before?.policy);
    expect(after?.extents).toEqual(before?.extents);
    expect(after?.count).toBe(1);
  });

  it('自分の update() の衝突は resource-conflict の例外で、何も変わらない（corsOk も消えない）', async () => {
    await applyRegister(store, ns({ id: 'p', cacheTtl: 500 }));
    await putTile(A);
    await store.patchResource(A, (m) => ({ ...m, corsOk: true, corslessUntil: 99 }));
    const beforeR = await get(A);
    const beforeS = await store.getSource('p');
    const err = await applyUpdate(store, 'p', ns({ id: 'p', cacheTtl: 1, credentialParams: ['foo'] })).catch((e) => e);
    expect(err).toBeInstanceOf(WeiwudiError);
    expect((err as WeiwudiError).code).toBe('resource-conflict');
    expect(await get(A)).toEqual(beforeR);
    expect(await store.getSource('p')).toEqual(beforeS);
  });

  it('衝突の無い update() は方針を入れ替え、corsOk・corslessUntil を消す（count には触らない）', async () => {
    await applyRegister(store, ns({ id: 'p', cacheTtl: 500 }));
    await putTile(A);
    await store.patchResource(A, (m) => ({ ...m, corsOk: true, corslessUntil: 99 }));
    await applyUpdate(store, 'p', ns({ id: 'p', cacheTtl: 7 }));
    const r = await get(A);
    expect(r?.policy.cacheTtl).toBe(7);
    expect(r?.corsOk).toBeUndefined();
    expect(r?.corslessUntil).toBeUndefined();
    expect(r?.count).toBe(1);
  });

  it('update(): 無い Source・id の違う spec は拒否', async () => {
    expect((await applyUpdate(store, 'p', ns({ id: 'p' })).catch((e) => e)).code).toBe('source-not-found');
    await applyRegister(store, ns({ id: 'p' }));
    expect((await applyUpdate(store, 'p', ns({ id: 'q' })).catch((e) => e)).code).toBe('attribute-invalid');
  });

  describe('範囲だけ（rangeOnlySourceIds）', () => {
    it('新しい id の衝突で rangeOnlySourceIds に入り extents に加わる（方針には入らない）', async () => {
      await applyRegister(store, ns({ id: 'p', cacheTtl: 500, maxZoom: 5 }));
      await putTile(A);
      const out = await applyRegister(store, ns({ id: 'q', cacheTtl: 1, maxZoom: 9, credentialParams: ['foo'] }));
      expect(out.warnings).toEqual([`resource-conflict: ${A}`]);
      const r = await get(A);
      expect(r?.sourceIds).toEqual(['p']);
      expect(r?.rangeOnlySourceIds).toEqual(['q']);
      expect(r?.extents?.map((e) => [e.sourceId, e.maxZoom])).toEqual([['p', 5], ['q', 9]]);
      expect(r?.policy.cacheTtl).toBe(500);
      expect(out.resources.map((x) => x.id)).toEqual([A]);
    });

    it('scheme 違いは y を反転して加える', async () => {
      await applyRegister(store, ns({ id: 'p' }));
      await applyRegister(store, ns({ id: 'q', scheme: 'tms', minZoom: 1, maxZoom: 3, box: { minX: 0, maxX: 1, minY: 0, maxY: 2 } }));
      const r = await get(A);
      expect(r?.rangeOnlySourceIds).toEqual(['q']);
      expect(r?.extents?.find((e) => e.sourceId === 'q')?.box).toEqual({ minX: 0, maxX: 1, minY: 5, maxY: 7 });
    });

    it('再登録で置き換わり、重ねて入らない', async () => {
      await applyRegister(store, ns({ id: 'p' }));
      await applyRegister(store, ns({ id: 'q', scheme: 'tms', maxZoom: 3 }));
      await applyRegister(store, ns({ id: 'q', scheme: 'tms', maxZoom: 7 }));
      const r = await get(A);
      expect(r?.rangeOnlySourceIds).toEqual(['q']);
      expect(r?.extents?.filter((e) => e.sourceId === 'q').map((e) => e.maxZoom)).toEqual([7]);
    });

    it('通常の合流に変わると rangeOnlySourceIds から外れる', async () => {
      await applyRegister(store, ns({ id: 'p' }));
      await applyRegister(store, ns({ id: 'q', scheme: 'tms' }));
      await applyRegister(store, ns({ id: 'q', scheme: 'xyz' }));
      const r = await get(A);
      expect(r?.sourceIds).toEqual(['p', 'q']);
      expect(r?.rangeOnlySourceIds ?? []).toEqual([]);
      expect(r?.extents?.filter((e) => e.sourceId === 'q')).toHaveLength(1);
    });

    it('範囲だけの Source の削除で外れ、和を計算し直す', async () => {
      await applyRegister(store, ns({ id: 'p', maxZoom: 5 }));
      await applyRegister(store, ns({ id: 'q', scheme: 'tms', maxZoom: 9 }));
      await applyRemove(store, 'q');
      const r = await get(A);
      expect(r?.rangeOnlySourceIds ?? []).toEqual([]);
      expect(r?.extents?.map((e) => e.sourceId)).toEqual(['p']);
      expect(await store.getSource('q')).toBeUndefined();
    });

    it('sourceIds が空の Resource は範囲だけが残っても Entry ごと消える', async () => {
      await applyRegister(store, ns({ id: 'p' }));
      await applyRegister(store, ns({ id: 'q', scheme: 'tms' }));
      await putTile(A);
      await applyRemove(store, 'p');
      expect(await get(A)).toBeUndefined();
      expect(await store.getEntry(`${A}\u00001_0_0`)).toBeUndefined();
    });
  });

  it('applyRemove は共有・範囲だけの Resource の Entry を残し、単独の Resource は Entry ごと消す', async () => {
    await applyRegister(store, ns({ id: 'p', url: A }));
    await applyRegister(store, ns({ id: 'q', url: A }));
    await applyRegister(store, ns({ id: 'r', url: B }));
    await applyRegister(store, ns({ id: 'q2', url: B, scheme: 'tms' })); // B に範囲だけ
    await applyRegister(store, ns({ id: 's', url: C }));
    await putTile(A);
    await putTile(B);
    await putTile(C);
    await applyRemove(store, 'q'); // 共有
    await applyRemove(store, 'q2'); // 範囲だけ
    await applyRemove(store, 's'); // 単独
    expect((await get(A))?.sourceIds).toEqual(['p']);
    expect(await store.getEntry(`${A}\u00001_0_0`)).toBeDefined();
    expect(await store.getEntry(`${B}\u00001_0_0`)).toBeDefined();
    expect(await get(C)).toBeUndefined();
    expect(await store.getEntry(`${C}\u00001_0_0`)).toBeUndefined();
    expect((await store.listSources()).map((s) => s.id)).toEqual(['p', 'r']);
    expect((await applyRemove(store, 's').catch((e) => e)).code).toBe('source-not-found');
  });

  it('credentialParams は Entry がある間は縮まず、Entry が無ければ縮む', async () => {
    await applyRegister(store, ns({ id: 'p', credentialParams: ['foo'] }));
    await applyRegister(store, ns({ id: 'q' }));
    await putTile(A);
    await applyRemove(store, 'p');
    expect((await get(A))?.policy.credentialParams).toContain('foo');
    await store.clearEntries(A);
    await applyUpdate(store, 'q', ns({ id: 'q' }));
    expect((await get(A))?.policy.credentialParams).not.toContain('foo');
  });

  it('同じ id の再登録で、前の登録にだけあったテンプレートの Resource が sourceIds から外れ、空なら Entry ごと消える（第 1 回 O-11）', async () => {
    await applyRegister(store, ns({ id: 'p', url: A }));
    await applyRegister(store, ns({ id: 'p2', url: B }));
    await applyRegister(store, ns({ id: 'p', url: [A, B, C] })); // A と B の 2 つに重なる → 衝突
    // 片方ずつに戻す: A をやめて C だけにする
    await putTile(A);
    await applyRegister(store, ns({ id: 'p', url: C }));
    expect(await get(A)).toBeUndefined();
    expect(await store.getEntry(`${A}\u00001_0_0`)).toBeUndefined();
    const b = await get(B);
    expect(b?.sourceIds).toEqual(['p2']);
    expect(b?.rangeOnlySourceIds ?? []).toEqual([]);
    expect((await get(C))?.sourceIds).toEqual(['p']);
  });

  it('id と warnings に資格情報が入らない（第 1 回 C3）', async () => {
    await applyRegister(store, normalizeSpec({ kind: 'raster', url: `${A}?access_token=pk.SECRET1` }));
    // Entry を置いて、credentialParams を広げる登録で衝突させる（warnings を出す）
    const [only] = await store.listResources();
    await putTile(only.id);
    const out = await applyRegister(store, normalizeSpec({
      kind: 'raster', url: `${A}?access_token=pk.SECRET2&foo=1`, credentialParams: ['foo'],
    }));
    expect(out.warnings).toHaveLength(1);
    const dump = JSON.stringify([await store.listSources(), await store.listResources(), out]);
    // 名前 access_token は policy.credentialParams（除く項目の一覧）にだけ現れる。値つきの項目と値は無い
    expect(dump).not.toContain('access_token=');
    expect(dump).not.toContain('SECRET');
    expect(dump.replace(/"access_token"(?=[,\]])/g, '')).not.toContain('access_token');
    expect((await store.getCredentials(out.source.id))?.query).toEqual({ access_token: 'pk.SECRET2', foo: '1' });
  });

  it('replaceResource・patchResource を挟んでも count・bytes が消えない（保存と並べる）', async () => {
    await applyRegister(store, ns({ id: 'p' }));
    await Promise.all([
      putTile(A, '1_0_0', 10),
      applyRegister(store, ns({ id: 'q', cacheTtl: 3 })),
      putTile(A, '1_1_0', 20),
      applyUpdate(store, 'p', ns({ id: 'p', cacheTtl: 2 })),
      putTile(A, '1_1_1', 30),
    ]);
    const r = await get(A);
    expect(r?.count).toBe(3);
    expect(r?.bytes).toBe(60);
    expect(r?.sourceIds).toEqual(['p', 'q']);
  });
});

describe('旧 API の Resource と合流しない（第 2 回 S-6・m2-t5 の申し送り）', () => {
  it('旧 API の地図と同じテンプレートを新 API で登録すると別の Resource ができ、旧 API の地図はそのまま動く', async () => {
    const h = createSwHarness();
    const add = await h.request(`/api/add?mapID=m&type=xyz&url=${encodeURIComponent(A)}&width=1024&height=1024`);
    expect(add.status).toBe(200);
    h.fetch.mockImplementation(async () => tileResponse(4));
    await h.request('/api/cache/m/2/1/0');

    const store = await openStore();
    try {
      const legacyBefore = await store.getResource('map:m');
      expect(legacyBefore?.templates).toEqual([A]);
      const out = await applyRegister(store, ns({ id: 'p' }));
      expect(out.warnings).toEqual([]);
      expect(out.resources.map((r) => r.id)).toEqual([A]);
      expect((await store.getResource(A))?.sourceIds).toEqual(['p']);
      expect(await store.getResource('map:m')).toEqual(legacyBefore);
      // 新 API の削除も旧 API の Resource に触らない
      await applyRemove(store, 'p');
      expect(await store.getResource('map:m')).toEqual(legacyBefore);
    } finally {
      store.close();
    }
    const stats = await (await h.request('/api/stats?mapID=m')).json();
    expect(stats.count).toBe(1);
  });
});
