// src/store.ts の試験（m2-t2・#37）。仕様 §5.2・§5.4・§9・§13、計画 docs/superpowers/plans/2026-11-03-m2-core.md の m2-t2。
// IndexedDB は試験ごとに新しい fake-indexeddb の IDBFactory（store.ts は大域の indexedDB・IDBKeyRange を使う）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBDatabase, IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import {
  openStore, toResourceInfo, STORE_DB_NAME,
  type EntryBody, type EntryMeta, type ResourceMeta, type ResourcePolicy, type SourceRecord, type Store, type StoredBody,
} from '../../src/store';
import { normalizeSpec } from '../../src/spec';

let factory: IDBFactory;
const opened: Store[] = [];

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const open = async (): Promise<Store> => {
  const s = await openStore();
  opened.push(s);
  return s;
};

const POLICY: ResourcePolicy = {
  cacheTtl: 86_400_000,
  store: true,
  outOfRange: { extent: 'transparent', zoom: 'transparent' },
  credentialParams: ['access_token'],
};

const resource = (id: string, over: Partial<ResourceMeta> = {}): ResourceMeta => ({
  id,
  type: 'tile',
  templates: [`https://${id.replace(/[^a-z0-9]/gi, '')}.example/{z}/{x}/{y}.png`],
  sourceIds: ['s1'],
  policy: POLICY,
  count: 0,
  bytes: 0,
  pinnedBytes: 0,
  ...over,
});

const key = (resourceId: string, suffix: string) => `${resourceId}\0${suffix}`;

const entry = (resourceId: string, suffix: string, size: number, accessedAt: number, over: Partial<EntryMeta> = {}): EntryMeta => ({
  key: key(resourceId, suffix),
  resourceId,
  size,
  fetchedAt: accessedAt,
  accessedAt,
  pinned: 0,
  contentType: 'image/png',
  ...over,
});

const body = (meta: EntryMeta): EntryBody => ({
  key: meta.key,
  blob: new Blob([new Uint8Array(meta.size)], { type: 'image/png' }),
  headers: { 'content-type': 'image/png' },
});

const put = (s: Store, meta: EntryMeta, evict: { resourceIds: string[]; maxBytes: number }[] = []) =>
  s.putEntry(meta, body(meta), evict);

/** entries ストアの全件（store を通さず直接読む） */
const rawAll = async <T>(storeName: string): Promise<T[]> => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(STORE_DB_NAME);
    req.onsuccess = () => resolve(req.result as unknown as IDBDatabase);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const req = db.transaction([storeName], 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result as T[]);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
};

/** 各 Resource の count・bytes・pinnedBytes が entries の全件の集計と一致することを確かめる */
const expectCountsConsistent = async (s: Store) => {
  const entries = await rawAll<EntryMeta>('entries');
  const bodies = await rawAll<StoredBody>('bodies');
  const resources = await s.listResources();
  const ids = new Set(resources.map((r) => r.id));
  for (const r of resources) {
    const mine = entries.filter((e) => e.resourceId === r.id);
    expect({ id: r.id, count: r.count, bytes: r.bytes, pinnedBytes: r.pinnedBytes }).toEqual({
      id: r.id,
      count: mine.length,
      bytes: mine.reduce((t, e) => t + e.size, 0),
      pinnedBytes: mine.filter((e) => e.pinned === 1).reduce((t, e) => t + e.size, 0),
    });
  }
  // 消えた Resource の Entry が残らない・本体とメタが 1 対 1
  expect(entries.filter((e) => !ids.has(e.resourceId))).toEqual([]);
  expect(bodies.map((b) => b.key).sort()).toEqual(entries.map((e) => e.key).sort());
};

/** 1 回目の put の成功の後に transaction を abort する（tx.error を name の DOMException にする） */
const abortPutAfterSuccess = (name: string) => {
  const original = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const req = original.apply(this, args);
    const tx = this.transaction;
    req.addEventListener('success', () => {
      (tx as unknown as { error: DOMException }).error = new DOMException('simulated', name);
      tx.abort();
    });
    return req;
  });
};

describe('openStore', () => {
  it('単一 DB WeiwudiStore・version 1 に 7 つのストアと索引を作る。旧 DB は作らない', async () => {
    await open();
    const list = await factory.databases();
    expect(list).toEqual([{ name: 'WeiwudiStore', version: 1 }]);
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = factory.open('WeiwudiStore');
      req.onsuccess = () => resolve(req.result as unknown as IDBDatabase);
    });
    try {
      expect([...db.objectStoreNames].sort()).toEqual(['bodies', 'credentials', 'entries', 'kv', 'regions', 'resources', 'sources']);
      const tx = db.transaction(['sources', 'resources', 'entries', 'bodies', 'regions', 'credentials', 'kv'], 'readonly');
      const keyPaths = Object.fromEntries(['sources', 'resources', 'entries', 'bodies', 'regions', 'credentials', 'kv']
        .map((n) => [n, tx.objectStore(n).keyPath]));
      expect(keyPaths).toEqual({
        sources: 'id', resources: 'id', entries: 'key', bodies: 'key', regions: 'id', credentials: 'sourceId', kv: 'key',
      });
      const resources = tx.objectStore('resources');
      expect([...resources.indexNames].sort()).toEqual(['rangeOnlySourceIds', 'sourceIds']);
      expect(resources.index('sourceIds').multiEntry).toBe(true);
      expect(resources.index('rangeOnlySourceIds').multiEntry).toBe(true);
      const entries = tx.objectStore('entries');
      const idx = [...entries.indexNames].map((n) => entries.index(n).keyPath);
      expect(idx).toEqual(expect.arrayContaining([
        ['resourceId', 'pinned', 'accessedAt'], ['pinned', 'accessedAt'], ['pinned', 'fetchedAt'], ['resourceId', 'z'],
      ]));
      expect(idx).toHaveLength(4);
      expect(tx.objectStore('regions').index('sourceId').keyPath).toBe('sourceId');
    } finally {
      db.close();
    }
  });
});

describe('往復', () => {
  it('Source・Resource・Entry・資格情報・kv を書いて読める', async () => {
    const s = await open();
    const src: SourceRecord = {
      id: 'https://a.example/{z}/{x}/{y}.png', kind: 'raster',
      spec: normalizeSpec({ kind: 'raster', url: 'https://a.example/{z}/{x}/{y}.png' }).spec,
      order: 1, warnings: ['w'], createdAt: 10,
    };
    await s.putSource(src);
    await s.putSource({ ...src, id: 'map:m', kind: 'legacy', order: 0, legacy: { mapID: 'm', type: 'xyz' } });
    expect(await s.getSource(src.id)).toEqual(src);
    expect((await s.listSources()).map((x) => x.id)).toEqual(['map:m', src.id]); // 登録順（order）
    expect(await s.getSource('none')).toBeUndefined();

    await s.createResource(resource('r1', { sourceIds: ['s1', 's2'], rangeOnlySourceIds: ['s3'] }));
    await s.createResource(resource('r2', { sourceIds: ['s2'] }));
    expect((await s.getResource('r1'))?.sourceIds).toEqual(['s1', 's2']);
    expect((await s.listResources()).map((r) => r.id)).toEqual(['r1', 'r2']);
    expect((await s.resourcesBySource('s2')).map((r) => r.id).sort()).toEqual(['r1', 'r2']);
    expect((await s.resourcesBySource('s3')).map((r) => r.id)).toEqual([]);
    expect((await s.resourcesByRangeOnlySource('s3')).map((r) => r.id)).toEqual(['r1']);

    const e = entry('r1', '2_1_0', 5, 100, { z: 2, x: 1, y: 0 });
    expect(await put(s, e)).toEqual({ saved: true });
    const got = await s.getEntry(e.key);
    expect(got?.meta).toEqual(e);
    expect(got?.body.headers).toEqual({ 'content-type': 'image/png' });
    expect(got?.body.blob.size).toBe(5);
    expect(await s.getEntry(key('r1', 'none'))).toBeUndefined();
    expect(await s.hasEntries([e.key, key('r1', 'none')])).toEqual([true, false]);
    expect(await s.getResource('r1')).toMatchObject({ count: 1, bytes: 5 });

    await s.putCredentials('s1', { query: { access_token: 't' } });
    expect(await s.getCredentials('s1')).toEqual({ query: { access_token: 't' } });
    expect(await s.getCredentials('s2')).toBeUndefined();

    await s.kvPut('schema', { v: 1 });
    expect(await s.kvGet('schema')).toEqual({ v: 1 });
    expect(await s.kvGet('none')).toBeUndefined();
  });

  it('createResource の重複は reject（ConstraintError の DOMException）。count・bytes は 0 で始まる', async () => {
    const s = await open();
    await s.createResource(resource('r1', { count: 9, bytes: 9, pinnedBytes: 9 }));
    expect(await s.getResource('r1')).toMatchObject({ count: 0, bytes: 0, pinnedBytes: 0 });
    const err = await s.createResource(resource('r1')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('ConstraintError');
  });

  it('deleteResource は自分の Entry と本体だけを消し、他の Resource の Entry を残す', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    await s.createResource(resource('r2'));
    // 'r' の範囲に 'r2' のキーが入らないこと（接頭辞が同じ id）を見る
    await put(s, entry('r', '0_0_0', 1, 1));
    await put(s, entry('r2', '0_0_0', 2, 1));
    await s.deleteResource('r');
    expect(await s.getResource('r')).toBeUndefined();
    expect(await s.getEntry(key('r', '0_0_0'))).toBeUndefined();
    expect(await s.getEntry(key('r2', '0_0_0'))).toBeDefined();
    await expectCountsConsistent(s);
  });

  it('clearEntries は Entry と本体を消し、同じ tx で count・bytes・pinnedBytes を 0 にする', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    await put(s, entry('r', '0_0_0', 3, 1));
    await put(s, entry('r', '1_0_0', 4, 1, { pinned: 1 }));
    expect(await s.getResource('r')).toMatchObject({ count: 2, bytes: 7, pinnedBytes: 4 });
    await s.clearEntries('r');
    expect(await s.getResource('r')).toMatchObject({ count: 0, bytes: 0, pinnedBytes: 0 });
    await expectCountsConsistent(s);
  });

  it('deleteSource は sources と credentials と regions（sourceId）を消し、他の Source の分を残す', async () => {
    const s = await open();
    const base = { kind: 'raster' as const, spec: {}, warnings: [], createdAt: 1 };
    await s.putSource({ ...base, id: 'a', order: 1 });
    await s.putSource({ ...base, id: 'b', order: 2 });
    await s.putCredentials('a', { headers: { authorization: 'x' } });
    await s.putCredentials('b', { headers: { authorization: 'y' } });
    // regions の API は m4。ここでは直接書く
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = factory.open(STORE_DB_NAME);
      req.onsuccess = () => resolve(req.result as unknown as IDBDatabase);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['regions'], 'readwrite');
      tx.objectStore('regions').put({ id: 'ra1', sourceId: 'a' });
      tx.objectStore('regions').put({ id: 'ra2', sourceId: 'a' });
      tx.objectStore('regions').put({ id: 'rb', sourceId: 'b' });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    await s.deleteSource('a');
    expect(await s.getSource('a')).toBeUndefined();
    expect(await s.getSource('b')).toBeDefined();
    expect(await s.getCredentials('a')).toBeUndefined();
    expect(await s.getCredentials('b')).toEqual({ headers: { authorization: 'y' } });
    expect((await rawAll<{ id: string }>('regions')).map((r) => r.id)).toEqual(['rb']);
  });
});

describe('数の一致', () => {
  // 種を固定した擬似乱数（mulberry32）
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('種を固定した 300 回の putEntry（退避あり・なし・上書き・大きすぎる応答・上限 2 つ）と deleteResource・clearEntries の後で、count・bytes が entries の集計と一致する', async () => {
    const s = await open();
    const rand = rng(20261103);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const ids = ['ra', 'rb', 'rc'] as const;
    for (const id of ids) await s.createResource(resource(id));
    const kinds = { none: 0, one: 0, two: 0, overwrite: 0, tooLarge: 0, pinned: 0, deleted: 0, cleared: 0, unsaved: 0 };
    for (let i = 0; i < 300; i++) {
      const roll = rand();
      if (roll < 0.03) {
        const id = pick(ids);
        await s.deleteResource(id);
        await s.createResource(resource(id));
        kinds.deleted++;
        continue;
      }
      if (roll < 0.06) {
        await s.clearEntries(pick(ids));
        kinds.cleared++;
        continue;
      }
      const rid = pick(ids);
      const suffix = `${Math.floor(rand() * 3)}_${Math.floor(rand() * 4)}_0`;
      const k = key(rid, suffix);
      if ((await s.hasEntries([k]))[0]) kinds.overwrite++;
      const tooLarge = rand() < 0.08;
      const size = tooLarge ? 200 : 1 + Math.floor(rand() * 20);
      if (tooLarge) kinds.tooLarge++;
      const pinned: 0 | 1 = rand() < 0.1 ? 1 : 0;
      if (pinned) kinds.pinned++;
      const mode = rand();
      let evict: { resourceIds: string[]; maxBytes: number }[] = [];
      if (mode < 0.3) {
        kinds.none++;
      } else if (mode < 0.75) {
        evict = [{ resourceIds: [rid], maxBytes: 40 + Math.floor(rand() * 40) }];
        kinds.one++;
      } else {
        const other = pick(ids.filter((x) => x !== rid));
        evict = [
          { resourceIds: [rid, other], maxBytes: 50 + Math.floor(rand() * 50) },
          { resourceIds: [rid], maxBytes: 30 + Math.floor(rand() * 30) },
        ];
        kinds.two++;
      }
      const { saved } = await put(s, entry(rid, suffix, size, 1000 + i, { pinned }), evict);
      if (!saved) kinds.unsaved++;
      if (i % 50 === 49) await expectCountsConsistent(s);
    }
    await expectCountsConsistent(s);
    // 各経路を実際に通ったこと（種を変えて経路が抜けたら、ここで気づく）
    for (const [name, n] of Object.entries(kinds)) expect(n, name).toBeGreaterThan(0);
  });
});

describe('交互の更新（第 1 回 S2）', () => {
  it('2 つの patchResource を同時に出しても両方の変更が残る', async () => {
    const s = await open();
    await s.createResource(resource('r', { sourceIds: ['s1'] }));
    const [a, b] = await Promise.all([
      s.patchResource('r', (m) => ({ ...m, sourceIds: [...m.sourceIds, 's2'] })),
      s.patchResource('r', (m) => ({ ...m, corsOk: true })),
    ]);
    expect(a?.sourceIds).toEqual(['s1', 's2']);
    expect(b).toMatchObject({ sourceIds: ['s1', 's2'], corsOk: true });
    expect(await s.getResource('r')).toMatchObject({ sourceIds: ['s1', 's2'], corsOk: true });
  });

  it('patchResource は無い Resource では fn を呼ばず undefined。fn が undefined を返せば書かない', async () => {
    const s = await open();
    const fn = vi.fn((m: ResourceMeta) => m);
    expect(await s.patchResource('none', fn)).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
    await s.createResource(resource('r'));
    expect(await s.patchResource('r', () => undefined)).toBeUndefined();
    expect(await s.getResource('r')).toEqual(resource('r'));
  });

  it('patchResource は count・bytes・pinnedBytes と id を書き換えさせない（保存済みの値のまま）', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    await put(s, entry('r', '0_0_0', 7, 1));
    const out = await s.patchResource('r', (m) => ({ ...m, id: 'other', count: 99, bytes: 99, pinnedBytes: 99 }));
    expect(out).toMatchObject({ id: 'r', count: 1, bytes: 7, pinnedBytes: 0 });
    expect(await s.getResource('other')).toBeUndefined();
    await expectCountsConsistent(s);
  });

  it('replaceResource は同じ tx で count・bytes・pinnedBytes を引き継ぐ（保存と並べても消えない）', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    const stale = (await s.getResource('r'))!;
    expect(stale.count).toBe(0);
    const e = entry('r', '0_0_0', 6, 1, { pinned: 1 });
    const [{ saved }] = await Promise.all([
      s.putEntry(e, body(e), []),
      s.replaceResource({ ...stale, templates: ['https://new.example/{z}/{x}/{y}.png'] }),
    ]);
    expect(saved).toBe(true);
    expect(await s.getResource('r')).toMatchObject({
      templates: ['https://new.example/{z}/{x}/{y}.png'], count: 1, bytes: 6, pinnedBytes: 6,
    });
    await expectCountsConsistent(s);
  });

  it('replaceResource は無い Resource では NotFoundError の DOMException で reject し、作らない', async () => {
    const s = await open();
    const err = await s.replaceResource(resource('none')).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('NotFoundError');
    expect(await s.getResource('none')).toBeUndefined();
  });
});

describe('退避（putItemWithEviction と同じ規則）', () => {
  it('accessedAt が同じときはキー昇順で消す（map:m\\x002_10_0 が map:m\\x002_1_0 より先）', async () => {
    const s = await open();
    await s.createResource(resource('map:m', { sourceIds: ['map:m'] }));
    await put(s, entry('map:m', '2_1_0', 10, 5));
    await put(s, entry('map:m', '2_10_0', 10, 5));
    await put(s, entry('map:m', '2_2_0', 10, 9), [{ resourceIds: ['map:m'], maxBytes: 20 }]);
    expect(await s.hasEntries([key('map:m', '2_10_0'), key('map:m', '2_1_0'), key('map:m', '2_2_0')]))
      .toEqual([false, true, true]);
    await expectCountsConsistent(s);
  });

  it('旧 API の試験と同じ入力（上限 20 に 10 バイトを 3 つ）で、最も古い 1 つが消え count 2・bytes 20', async () => {
    const s = await open();
    await s.createResource(resource('map:m', { sourceIds: ['map:m'] }));
    const cap = [{ resourceIds: ['map:m'], maxBytes: 20 }];
    for (const [i, x] of [0, 1, 2].entries()) await put(s, entry('map:m', `2_${x}_0`, 10, i + 1), cap);
    expect(await s.hasEntries(['2_0_0', '2_1_0', '2_2_0'].map((x) => key('map:m', x)))).toEqual([false, true, true]);
    expect(await s.getResource('map:m')).toMatchObject({ count: 2, bytes: 20 });
  });

  it('上限より大きい 21 バイトは保存しない（saved: false・count は増えない）', async () => {
    const s = await open();
    await s.createResource(resource('map:m', { sourceIds: ['map:m'] }));
    const cap = [{ resourceIds: ['map:m'], maxBytes: 20 }];
    await put(s, entry('map:m', '2_0_0', 10, 1), cap);
    await put(s, entry('map:m', '2_1_0', 10, 2), cap);
    expect(await put(s, entry('map:m', '2_2_0', 21, 3), cap)).toEqual({ saved: false });
    expect(await s.getResource('map:m')).toMatchObject({ count: 2, bytes: 20 });
    expect(await s.hasEntries([key('map:m', '2_2_0')])).toEqual([false]);
  });

  it('同じキーの上書きは退避の候補から外し、大きさの差だけ bytes を直す', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    const cap = [{ resourceIds: ['r'], maxBytes: 20 }];
    await put(s, entry('r', 'a', 10, 1), cap);
    await put(s, entry('r', 'b', 10, 2), cap);
    // a を 10 → 10 で上書き: a を消さず、b も消さない
    expect(await put(s, entry('r', 'a', 10, 3), cap)).toEqual({ saved: true });
    expect(await s.hasEntries([key('r', 'a'), key('r', 'b')])).toEqual([true, true]);
    expect(await s.getResource('r')).toMatchObject({ count: 2, bytes: 20 });
    await expectCountsConsistent(s);
  });

  it('固定（pinned = 1）の Entry は退避しない', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    await put(s, entry('r', 'p', 10, 1, { pinned: 1 }));
    await put(s, entry('r', 'u', 10, 2));
    await put(s, entry('r', 'n', 10, 3), [{ resourceIds: ['r'], maxBytes: 10 }]);
    expect(await s.hasEntries(['p', 'u', 'n'].map((x) => key('r', x)))).toEqual([true, false, true]);
    await expectCountsConsistent(s);
  });

  it('maxBytes が 0 の上限では保存しない（第 2 回 O16）', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    expect(await put(s, entry('r', 'a', 1, 1), [{ resourceIds: ['r'], maxBytes: 0 }])).toEqual({ saved: false });
    expect(await s.getResource('r')).toMatchObject({ count: 0, bytes: 0 });
  });

  it('maxBytes が 0 の上限では大きさ 0 の応答も保存しない（m2-t2 水準 1 Minor 3）', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    expect(await put(s, entry('r', 'z', 0, 1), [{ resourceIds: ['r'], maxBytes: 0 }])).toEqual({ saved: false });
    expect(await s.hasEntries([key('r', 'z')])).toEqual([false]);
    expect(await s.getResource('r')).toMatchObject({ count: 0, bytes: 0 });
  });

  it('別の Resource に同じ accessedAt の Entry があり 1 つの要素にまとめたとき、キー昇順で消す（m2-t2 水準 1 Minor 2）', async () => {
    const s = await open();
    for (const id of ['A', 'B']) await s.createResource(resource(id));
    await put(s, entry('B', 'x', 10, 5));
    await put(s, entry('A', 'x', 10, 5));
    // resourceIds の順は B → A。併合の順のままなら B\0x が先に消える。キー昇順なら A\0x が先
    expect(await put(s, entry('B', 'n', 10, 9), [{ resourceIds: ['B', 'A'], maxBytes: 20 }])).toEqual({ saved: true });
    expect(await s.hasEntries(['A\0x', 'B\0x', 'B\0n'])).toEqual([false, true, true]);
    await expectCountsConsistent(s);
  });

  it('上限 2 つ（第 1 回 S4）: 1 つの Resource を 2 つの Source が上限つきで参照するとき、両方の上限を満たすまで消える', async () => {
    const s = await open();
    // 共有 R を、S1（R と A・上限 30）と S2（R と B・上限 25）が参照する
    for (const id of ['R', 'A', 'B']) await s.createResource(resource(id));
    await put(s, entry('A', 'a1', 10, 1));
    await put(s, entry('R', 'r1', 10, 2));
    await put(s, entry('B', 'b1', 10, 3));
    await put(s, entry('R', 'r2', 10, 4));
    await put(s, entry('A', 'a2', 10, 5));
    await put(s, entry('B', 'b2', 10, 6));
    const evict = [{ resourceIds: ['R', 'A'], maxBytes: 30 }, { resourceIds: ['R', 'B'], maxBytes: 25 }];
    expect(await put(s, entry('R', 'r3', 10, 7), evict)).toEqual({ saved: true });
    const sum = async (rs: string[]) => (await Promise.all(rs.map((r) => s.getResource(r)))).reduce((t, m) => t + m!.bytes, 0);
    expect(await sum(['R', 'A'])).toBeLessThanOrEqual(30);
    expect(await sum(['R', 'B'])).toBeLessThanOrEqual(25);
    // S1: 候補 a1(1) r1(2) r2(4) a2(5)=40、予算 20 → a1・r1 を消す。S2: 残り r2(4) b1(3) b2(6)=30、予算 15 → b1・r2 を消す
    expect(await s.hasEntries(['A\0a1', 'R\0r1', 'B\0b1', 'R\0r2', 'A\0a2', 'B\0b2', 'R\0r3']))
      .toEqual([false, false, false, false, true, true, true]);
    await expectCountsConsistent(s);
  });

  it('どれか 1 つの上限で大きすぎれば保存しない。その要素の退避は上限まで行う', async () => {
    const s = await open();
    for (const id of ['R', 'A']) await s.createResource(resource(id));
    await put(s, entry('A', 'a1', 10, 1));
    await put(s, entry('A', 'a2', 10, 2));
    await put(s, entry('R', 'r1', 10, 3));
    const evict = [{ resourceIds: ['R', 'A'], maxBytes: 100 }, { resourceIds: ['R'], maxBytes: 5 }];
    expect(await put(s, entry('R', 'r2', 8, 4), evict)).toEqual({ saved: false });
    // 2 つ目の要素（R・上限 5）: r1 の 10 が上限を超えるので消える。1 つ目は上限内なので何も消さない
    expect(await s.hasEntries(['A\0a1', 'A\0a2', 'R\0r1', 'R\0r2'])).toEqual([true, true, false, false]);
    await expectCountsConsistent(s);
  });
});

describe('消された Resource（第 1 回 O-7）', () => {
  it('putEntry は、同じ tx の前に消された Resource には書かない（saved: false・entries が増えない）', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    const e = entry('r', '0_0_0', 4, 1);
    const [, result] = await Promise.all([s.deleteResource('r'), s.putEntry(e, body(e), [])]);
    expect(result).toEqual({ saved: false });
    expect(await rawAll('entries')).toEqual([]);
    expect(await rawAll('bodies')).toEqual([]);
  });

  it('無い Resource への putEntry は saved: false', async () => {
    const s = await open();
    expect(await put(s, entry('none', 'a', 1, 1))).toEqual({ saved: false });
    expect(await rawAll('entries')).toEqual([]);
  });
});

describe('putEntry のキーの守り（m2-t2 水準 1 Info 1）', () => {
  it.each([
    ['別の Resource の前置き', 'other\0a'],
    ['区切りが無い', 'ra'],
    ['前置きだけが一致し区切りが違う', 'r\x01a'],
    ['id の途中まで一致', 'r'],
  ])('key が resourceId + \\0 で始まらない（%s）と DataError の DOMException で reject し、何も書かない', async (_label, badKey) => {
    const s = await open();
    await s.createResource(resource('r'));
    const meta = { ...entry('r', 'a', 3, 1), key: badKey };
    const err = await s.putEntry(meta, body(meta), []).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('DataError');
    expect(err).not.toBeInstanceOf(Event);
    expect(await rawAll('entries')).toEqual([]);
    expect(await rawAll('bodies')).toEqual([]);
    expect(await s.getResource('r')).toMatchObject({ count: 0, bytes: 0 });
  });

  it('本体の key がメタの key と違うと DataError で reject し、何も書かない', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    const meta = entry('r', 'a', 3, 1);
    const err = await s.putEntry(meta, { ...body(meta), key: key('r', 'b') }, []).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('DataError');
    expect(await rawAll('entries')).toEqual([]);
    expect(await rawAll('bodies')).toEqual([]);
  });
});

describe('touch（第 1 回 O-6）', () => {
  it('entries の accessedAt だけを直し、bodies へ書かない', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    const e = entry('r', 'a', 3, 1);
    await put(s, e);
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    await s.touch(e.key, 50);
    const targets = putSpy.mock.contexts.map((c) => (c as IDBObjectStore).name);
    expect(targets).toEqual(['entries']);
    expect((await s.getEntry(e.key))?.meta).toEqual({ ...e, accessedAt: 50 });
  });

  it('呼び出しが戻った時点で tx が作られている（transaction が同期で呼ばれる）', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    await put(s, entry('r', 'a', 3, 1));
    const txSpy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const p = s.touch(key('r', 'a'), 9);
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy.mock.calls[0][0]).toEqual(['entries']);
    await p;
  });

  it('無いキーの touch は何もしない', async () => {
    const s = await open();
    await s.touch(key('r', 'none'), 1);
    expect(await rawAll('entries')).toEqual([]);
  });
});

describe('reject の値（仕様 §9）', () => {
  it('保存の abort で、reject の値が name === QuotaExceededError の DOMException（Event ではない）', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    const spy = abortPutAfterSuccess('QuotaExceededError');
    const err = await put(s, entry('r', 'a', 3, 1)).catch((x: unknown) => x);
    expect(spy).toHaveBeenCalled();
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('QuotaExceededError');
    expect(err).not.toBeInstanceOf(Event);
    // abort したので何も残らない
    expect(await s.getResource('r')).toMatchObject({ count: 0, bytes: 0 });
    await expectCountsConsistent(s);
  });

  it('要求の失敗も DOMException で reject する（Event ではない）', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    const original = IDBObjectStore.prototype.get;
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementationOnce(function (this: IDBObjectStore) {
      return original.call(this, {} as unknown as IDBValidKey); // 不正なキー → DataError を同期で投げる
    });
    const err = await s.getResource('r').catch((x: unknown) => x);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('DataError');
  });
});

describe('toResourceInfo（第 2 回 O6）', () => {
  const meta = resource('r', {
    rangeOnlySourceIds: ['s9'], corsOk: true, corslessUntil: 1000, provider: 'mapbox', count: 3, bytes: 30, pinnedBytes: 10,
  });

  it('範囲だけの Resource で sourceId を渡すと rangeOnly: true、渡さないと出ない', () => {
    expect(toResourceInfo(meta, 2000, 's9').rangeOnly).toBe(true);
    expect('rangeOnly' in toResourceInfo(meta, 2000, 's1')).toBe(false);
    expect('rangeOnly' in toResourceInfo(meta, 2000)).toBe(false);
  });

  it('corsless は corslessUntil が今より先のときだけ', () => {
    expect(toResourceInfo(meta, 999).corsless).toBe(true);
    expect('corsless' in toResourceInfo(meta, 1000)).toBe(false);
    expect('corsless' in toResourceInfo(resource('x'), 0)).toBe(false);
  });

  it('保存の項目（corsOk・policy など）が出ない。templates は写し', () => {
    const info = toResourceInfo(meta, 2000, 's9');
    expect(info).toEqual({ id: 'r', type: 'tile', templates: meta.templates, count: 3, bytes: 30, rangeOnly: true });
    expect(info.templates).not.toBe(meta.templates);
  });
});

describe('別の接続（仕様 §13 の :553・:563 に当たる 2 件）', () => {
  /** WeiwudiStore を version 1 で開いたまま、versionchange でも閉じない接続（古い版の SW などの代わり） */
  const holdOpen = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(STORE_DB_NAME, 1);
    req.onsuccess = () => resolve(req.result as unknown as IDBDatabase);
    req.onerror = () => reject(req.error);
  });

  it('onversionchange で譲る: 開いている store があっても別の接続の削除は blocked にならず、store は次の呼び出しで開き直して読める', async () => {
    const s = await open();
    await s.kvPut('k', 1);
    await new Promise<void>((resolve, reject) => {
      const req = factory.deleteDatabase(STORE_DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
    // 消えた後の DB を開き直す（中身は空）
    expect(await s.kvGet('k')).toBeUndefined();
    await s.kvPut('k', 2);
    expect(await s.kvGet('k')).toBe(2);
  });

  it('blocked で止まらない: 閉じない接続が版の更新を止めるあいだは BlockedError で reject し、閉じたあとは成功する', async () => {
    const holder = await holdOpen();
    // version 1 しか無いので、版の更新を待たせる場面は「開く版を上げた open」で作る（WeiwudiStore の次の版の代わり）
    const original = factory.open.bind(factory);
    vi.spyOn(factory, 'open').mockImplementation((name: string) => original(name, 2));
    const s = await open(); // blocked でも openStore 自体は止まらずに返る
    const first = await s.kvGet('k').catch((x: unknown) => x);
    expect((first as Error).name).toBe('BlockedError');
    expect((first as Error).message).toMatch(/WeiwudiStore.*blocked/);
    // 2 回目も待たずに reject する（止まった open の後ろに並ばない）
    const second = await s.listSources().catch((x: unknown) => x);
    expect((second as Error).name).toBe('BlockedError');
    holder.close();
    await vi.waitFor(async () => {
      await s.kvPut('k', 1);
    });
    expect(await s.kvGet('k')).toBe(1);
  });
});

describe('putGlyphPart（m3-t4・仕様 §11）', () => {
  const G = 'https://g.example/{fontstack}/{range}.pbf';
  const gmeta = (fetchedAt: number): EntryMeta => ({
    key: key(G, 'Noto'), resourceId: G, size: 0, fetchedAt, accessedAt: fetchedAt, pinned: 0,
  });
  const blob = (n: number, fill: number) => new Blob([new Uint8Array(n).fill(fill)]);

  it('1 つの readwrite tx で読み・作り直し・書く（transaction の spy が 1 回）', async () => {
    const s = await open();
    await s.createResource(resource(G, { type: 'glyph', templates: [G] }));
    await s.putGlyphPart(gmeta(1), '0-255', blob(4, 1), { 'content-type': 'application/x-protobuf' }, []);
    const txSpy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    // 本体を ArrayBuffer にしてから tx を作る（m3-t10）ので、tx は呼び出しの後に 1 つだけ
    const p = s.putGlyphPart(gmeta(2), '256-511', blob(3, 2), { 'content-type': 'application/x-protobuf' }, []);
    expect(await p).toEqual({ saved: true });
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy.mock.calls[0][1]).toBe('readwrite');
    const got = await s.getEntry(key(G, 'Noto'));
    expect(got!.meta).toMatchObject({ size: 7, fetchedAt: 2 });
    expect(got!.body.parts).toEqual({
      '0-255': { offset: 0, length: 4, fetchedAt: 1 },
      '256-511': { offset: 4, length: 3, fetchedAt: 2 },
    });
    expect(new Uint8Array(await got!.body.blob.arrayBuffer())).toEqual(Uint8Array.from([1, 1, 1, 1, 2, 2, 2]));
    expect(await s.getResource(G)).toMatchObject({ count: 1, bytes: 7 });
  });

  it('同じ範囲の差し替えは古い部分を落として詰める（空きを残さない）', async () => {
    const s = await open();
    await s.createResource(resource(G, { type: 'glyph', templates: [G] }));
    await s.putGlyphPart(gmeta(1), '0-255', blob(4, 1), {}, []);
    await s.putGlyphPart(gmeta(2), '256-511', blob(3, 2), {}, []);
    await s.putGlyphPart(gmeta(3), '0-255', blob(2, 5), {}, []);
    const got = await s.getEntry(key(G, 'Noto'));
    expect(got!.body.parts).toEqual({
      '256-511': { offset: 0, length: 3, fetchedAt: 2 },
      '0-255': { offset: 3, length: 2, fetchedAt: 3 },
    });
    expect(new Uint8Array(await got!.body.blob.arrayBuffer())).toEqual(Uint8Array.from([2, 2, 2, 5, 5]));
    expect(await s.getResource(G)).toMatchObject({ count: 1, bytes: 5 });
    await expectCountsConsistent(s);
  });

  it('古い部分の fetchedAt で差し替えても、Entry の fetchedAt は最も新しい部分の値', async () => {
    const s = await open();
    await s.createResource(resource(G, { type: 'glyph', templates: [G] }));
    await s.putGlyphPart(gmeta(9), '0-255', blob(1, 1), {}, []);
    await s.putGlyphPart(gmeta(5), '256-511', blob(1, 1), {}, []);
    expect((await s.getEntry(key(G, 'Noto')))!.meta.fetchedAt).toBe(9);
  });

  it('キーが resourceId で始まらなければ tx を作らずに DataError', async () => {
    const s = await open();
    await s.createResource(resource(G, { type: 'glyph', templates: [G] }));
    const txSpy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const err = await s.putGlyphPart({ ...gmeta(1), key: 'x\0Noto' }, '0-255', blob(1, 1), {}, []).catch((x: unknown) => x);
    expect((err as DOMException).name).toBe('DataError');
    expect(txSpy).not.toHaveBeenCalled();
  });

  it('無い Resource には書かない（saved: false）', async () => {
    const s = await open();
    expect(await s.putGlyphPart(gmeta(1), '0-255', blob(1, 1), {}, [])).toEqual({ saved: false });
    expect(await rawAll('entries')).toEqual([]);
  });
});

describe('putGlyphParts（m3-t7・仕様 §11 の「1 fontstack 分を溜めてから 1 回で書く」。t4 の申し送り）', () => {
  const G = 'https://g.example/{fontstack}/{range}.pbf';
  const gmeta = (fetchedAt: number): EntryMeta => ({
    key: key(G, 'Noto'), resourceId: G, size: 0, fetchedAt, accessedAt: fetchedAt, pinned: 0,
  });
  const blob = (n: number, fill: number) => new Blob([new Uint8Array(n).fill(fill)]);

  it('複数の範囲を 1 つの readwrite tx で 1 回に書く。部分ごとの fetchedAt と、最も新しい部分の EntryMeta.fetchedAt', async () => {
    const s = await open();
    await s.createResource(resource(G, { type: 'glyph', templates: [G] }));
    await s.putGlyphPart(gmeta(1), '0-255', blob(4, 1), {}, []);
    const txSpy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const out = await s.putGlyphParts(gmeta(99), [
      { part: '256-511', blob: blob(3, 2), fetchedAt: 5 },
      { part: '512-767', blob: blob(2, 3), fetchedAt: 4 },
    ], { 'content-type': 'application/x-protobuf' }, []);
    expect(out).toEqual({ saved: true });
    expect(txSpy).toHaveBeenCalledTimes(1);
    const got = await s.getEntry(key(G, 'Noto'));
    expect(got!.meta).toMatchObject({ size: 9, fetchedAt: 5 });
    expect(got!.body.parts).toEqual({
      '0-255': { offset: 0, length: 4, fetchedAt: 1 },
      '256-511': { offset: 4, length: 3, fetchedAt: 5 },
      '512-767': { offset: 7, length: 2, fetchedAt: 4 },
    });
    expect(new Uint8Array(await got!.body.blob.arrayBuffer())).toEqual(Uint8Array.from([1, 1, 1, 1, 2, 2, 2, 3, 3]));
    expect(await s.getResource(G)).toMatchObject({ count: 1, bytes: 9 });
    await expectCountsConsistent(s);
  });

  it('並びに同じ範囲が 2 つあれば後のものが勝ち、保存済みの同じ範囲は落とす。空の並びは何も書かない', async () => {
    const s = await open();
    await s.createResource(resource(G, { type: 'glyph', templates: [G] }));
    await s.putGlyphPart(gmeta(1), '0-255', blob(4, 1), {}, []);
    await s.putGlyphParts(gmeta(2), [
      { part: '0-255', blob: blob(1, 7), fetchedAt: 2 },
      { part: '0-255', blob: blob(2, 8), fetchedAt: 3 },
    ], {}, []);
    const got = await s.getEntry(key(G, 'Noto'));
    expect(got!.body.parts).toEqual({ '0-255': { offset: 0, length: 2, fetchedAt: 3 } });
    expect(new Uint8Array(await got!.body.blob.arrayBuffer())).toEqual(Uint8Array.from([8, 8]));
    const txSpy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    expect(await s.putGlyphParts(gmeta(3), [], {}, [])).toEqual({ saved: false });
    expect(txSpy).not.toHaveBeenCalled();
    await expectCountsConsistent(s);
  });
});

describe('本体の保存の形（m3-t10。WebKit の非永続の保存領域は Blob を put できない）', () => {
  /** bodies へ直接書く（古い形のレコードを作る） */
  const rawPut = async (storeName: string, value: unknown): Promise<void> => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(STORE_DB_NAME);
      req.onsuccess = () => resolve(req.result as unknown as IDBDatabase);
      req.onerror = () => reject(req.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction([storeName], 'readwrite');
        t.objectStore(storeName).put(value);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  };
  const bytesOf = async (b: Blob) => Array.from(new Uint8Array(await b.arrayBuffer()));
  const isArrayBuffer = (x: unknown) => Object.prototype.toString.call(x) === '[object ArrayBuffer]';
  const deferredBody = (meta: EntryMeta) => {
    const b = body(meta);
    let resolve!: (data: ArrayBuffer) => void;
    let reject!: (error: unknown) => void;
    const converted = new Promise<ArrayBuffer>((yes, no) => { resolve = yes; reject = no; });
    vi.spyOn(b.blob, 'arrayBuffer').mockReturnValue(converted);
    return { body: b, resolve, reject };
  };
  // microtask の変換・待機列を進める。Blob のサイズや実時間の待ちには頼らない。
  const flushConversions = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('putEntry は本体を ArrayBuffer・型を type で保存し、getEntry は同じ型とバイト列の Blob を返す', async () => {
    const s = await open();
    await s.createResource(resource('r1'));
    const e = entry('r1', '1_0_0', 3, 10);
    expect(await s.putEntry(e, { key: e.key, blob: new Blob([Uint8Array.from([7, 8, 9])], { type: 'image/png' }), headers: { a: '1' } }, []))
      .toEqual({ saved: true });
    const [raw] = await rawAll<Record<string, unknown>>('bodies');
    expect(isArrayBuffer(raw.data)).toBe(true);
    expect(raw).toMatchObject({ key: e.key, type: 'image/png', headers: { a: '1' } });
    expect('blob' in raw).toBe(false);
    const got = await s.getEntry(e.key);
    expect(got!.body.blob).toBeInstanceOf(Blob);
    expect(got!.body.blob.type).toBe('image/png');
    expect(await bytesOf(got!.body.blob)).toEqual([7, 8, 9]);
    expect(got!.body.headers).toEqual({ a: '1' });
  });

  it('putGlyphPart の結合した本体も ArrayBuffer（parts と型を保つ）', async () => {
    const G = 'https://g.example/{fontstack}/{range}.pbf';
    const s = await open();
    await s.createResource(resource(G, { type: 'glyph', templates: [G] }));
    const m = (t: number): EntryMeta => ({ key: key(G, 'Noto'), resourceId: G, size: 0, fetchedAt: t, accessedAt: t, pinned: 0 });
    await s.putGlyphPart(m(1), '0-255', new Blob([Uint8Array.from([1, 1])], { type: 'application/x-protobuf' }), {}, []);
    await s.putGlyphPart(m(2), '256-511', new Blob([Uint8Array.from([2])], { type: 'application/x-protobuf' }), {}, []);
    const [raw] = await rawAll<StoredBody>('bodies');
    expect(isArrayBuffer(raw.data)).toBe(true);
    expect(raw.type).toBe('application/x-protobuf');
    expect(Array.from(new Uint8Array(raw.data))).toEqual([1, 1, 2]);
    const got = await s.getEntry(key(G, 'Noto'));
    expect(got!.body.blob.type).toBe('application/x-protobuf');
    expect(await bytesOf(got!.body.blob)).toEqual([1, 1, 2]);
    expect(got!.body.parts).toEqual({ '0-255': { offset: 0, length: 2, fetchedAt: 1 }, '256-511': { offset: 2, length: 1, fetchedAt: 2 } });
  });

  it('Blob を持つ古いレコードは miss（getEntry が undefined）で、書き直すと数が合う', async () => {
    const s = await open();
    await s.createResource(resource('r1'));
    const e = entry('r1', '1_0_0', 4, 10);
    await put(s, e);
    await rawPut('bodies', { key: e.key, blob: new Blob([new Uint8Array(4)], { type: 'image/png' }), headers: {} });
    expect(await s.getEntry(e.key)).toBeUndefined();
    expect(await s.hasEntries([e.key, key('r1', 'missing')])).toEqual([true, false]);
    // 作り直し（同じキーの putEntry）は古い Entry を置き換え、count・bytes を二重に数えない
    const e2 = entry('r1', '1_0_0', 6, 20);
    expect(await put(s, e2)).toEqual({ saved: true });
    expect((await s.getEntry(e.key))!.body.blob.size).toBe(6);
    expect(await s.hasEntries([e.key])).toEqual([true]);
    expect(await s.getResource('r1')).toMatchObject({ count: 1, bytes: 6 });
    await expectCountsConsistent(s);
  });

  it('Blob を持つ古いグリフのレコードは残さず、新しい部分だけで作り直す', async () => {
    const G = 'https://g.example/{fontstack}/{range}.pbf';
    const s = await open();
    await s.createResource(resource(G, { type: 'glyph', templates: [G] }));
    const m = (t: number): EntryMeta => ({ key: key(G, 'Noto'), resourceId: G, size: 0, fetchedAt: t, accessedAt: t, pinned: 0 });
    await s.putGlyphPart(m(1), '0-255', new Blob([Uint8Array.from([1, 1, 1])]), {}, []);
    await rawPut('bodies', {
      key: key(G, 'Noto'), blob: new Blob([Uint8Array.from([1, 1, 1])]), headers: {},
      parts: { '0-255': { offset: 0, length: 3, fetchedAt: 1 } },
    });
    expect(await s.getEntry(key(G, 'Noto'))).toBeUndefined();
    await s.putGlyphPart(m(2), '256-511', new Blob([Uint8Array.from([2, 2])]), {}, []);
    const got = await s.getEntry(key(G, 'Noto'));
    expect(got!.body.parts).toEqual({ '256-511': { offset: 0, length: 2, fetchedAt: 2 } });
    expect(await bytesOf(got!.body.blob)).toEqual([2, 2]);
    expect(await s.getResource(G)).toMatchObject({ count: 1, bytes: 2 });
    await expectCountsConsistent(s);
  });

  it('本体の変換を待つあいだも tx は呼び出しの順に作る（後の clearEntries・putEntry が追い越さない）', async () => {
    const s = await open();
    await s.createResource(resource('r1'));
    const a = entry('r1', 'a', 2, 10);
    const b = entry('r1', 'b', 3, 10);
    const prepA = deferredBody(a);
    const prepB = deferredBody(b);
    // B の変換を先に終える。A を解放するまで clear も B も tx を作れない。
    const txSpy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const writes = Promise.all([
      s.putEntry(a, prepA.body, []), s.clearEntries('r1'),
      s.putEntry(b, prepB.body, []), s.clearEntries('r1'),
    ]);
    prepB.resolve(new ArrayBuffer(b.size));
    await flushConversions();
    const earlyTransactions = txSpy.mock.calls.length;
    prepA.resolve(new ArrayBuffer(a.size));
    await writes;
    expect(earlyTransactions).toBe(0);
    expect(await s.getEntry(a.key)).toBeUndefined();
    expect(await s.getEntry(b.key)).toBeUndefined();
    expect(await s.getResource('r1')).toMatchObject({ count: 0, bytes: 0 });
    // 同じサイズ・同じキーでも、後から呼んだ put が残る（変換は逆順に完了）。
    const first = entry('r1', 'k', 1, 10);
    const last = entry('r1', 'k', 1, 20);
    const prepFirst = deferredBody(first);
    const prepLast = deferredBody(last);
    const sameKey = Promise.all([s.putEntry(first, prepFirst.body, []), s.putEntry(last, prepLast.body, [])]);
    prepLast.resolve(Uint8Array.from([2]).buffer);
    await flushConversions();
    prepFirst.resolve(Uint8Array.from([1]).buffer);
    await sameKey;
    const got = await s.getEntry(first.key);
    expect(got!.meta.fetchedAt).toBe(20);
    expect(await bytesOf(got!.body.blob)).toEqual([2]);
    await expectCountsConsistent(s);
  });

  it.each(['entry', 'glyph'] as const)('変換が失敗しても先の保留中の put を clear が追い越さない（%s）', async (kind) => {
    const s = await open();
    await s.createResource(resource('r1', { type: kind === 'glyph' ? 'glyph' : 'tile' }));
    const a = entry('r1', 'a', 2, 10);
    const b = entry('r1', 'b', 3, 20);
    const prepA = deferredBody(a);
    const prepB = deferredBody(b);
    const write = (meta: EntryMeta, prepared: ReturnType<typeof deferredBody>) => kind === 'entry'
      ? s.putEntry(meta, prepared.body, [])
      : s.putGlyphParts(meta, [{ part: '0-255', blob: prepared.body.blob, fetchedAt: meta.fetchedAt }], {}, []);
    const txSpy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const putA = write(a, prepA);
    const failure = new Error('conversion failed');
    const putB = write(b, prepB).catch((error: unknown) => error);
    const clear = s.clearEntries('r1');
    prepB.reject(failure);
    await flushConversions();
    const earlyTransactions = txSpy.mock.calls.length;
    prepA.resolve(new ArrayBuffer(a.size));
    expect(await putA).toEqual({ saved: true });
    expect(await putB).toBe(failure);
    await clear;
    expect(await s.getResource('r1')).toMatchObject({ count: 0, bytes: 0 });
    expect(await s.getEntry(a.key)).toBeUndefined();
    expect(await s.getEntry(b.key)).toBeUndefined();
    expect(earlyTransactions).toBe(0);
    // 失敗後も待機数が戻り、次の書き込みを受け付ける。
    expect(await put(s, b)).toEqual({ saved: true });
    await expectCountsConsistent(s);
  });

  it('putGlyphParts は不正なキーなら Blob の変換を始めない', async () => {
    const s = await open();
    const invalid = entry('r1', 'x', 1, 10, { key: 'invalid' });
    const blob = new Blob(['x']);
    // 変換を保留し、キーの検査が変換の結果を待たないことも確かめる。
    const convert = vi.spyOn(blob, 'arrayBuffer').mockReturnValue(new Promise(() => {}));
    await expect(s.putGlyphParts(invalid, [{ part: '0-255', blob, fetchedAt: 10 }], {}, []))
      .rejects.toMatchObject({ name: 'DataError' });
    expect(convert).not.toHaveBeenCalled();
  });

  it('本体を超える parts は全体を読めないものとして新しい部分だけで作り直す', async () => {
    const s = await open();
    await s.createResource(resource('r1', { type: 'glyph' }));
    const m = entry('r1', 'Noto', 3, 10);
    await s.putGlyphPart(m, '0-255', new Blob([Uint8Array.from([1, 1, 1])]), {}, []);
    await rawPut('bodies', {
      key: m.key, data: Uint8Array.from([1, 1, 1]).buffer, type: '', headers: {},
      parts: {
        '0-255': { offset: 0, length: 2, fetchedAt: 10 },
        '256-511': { offset: 2, length: 2, fetchedAt: 10 },
      },
    });
    expect(await s.putGlyphPart({ ...m, fetchedAt: 20 }, '512-767', new Blob([Uint8Array.from([2])]), {}, []))
      .toEqual({ saved: true });
    const got = await s.getEntry(m.key);
    expect(got!.body.parts).toEqual({ '512-767': { offset: 0, length: 1, fetchedAt: 20 } });
    expect(await bytesOf(got!.body.blob)).toEqual([2]);
    expect(await s.getResource('r1')).toMatchObject({ count: 1, bytes: 1 });
    await expectCountsConsistent(s);
  });
});

// ---- m4-t1（計画 docs/superpowers/plans/2026-11-07-m4-range-release-migration.md の m4-t1）。追記のみ ----
// 既存の行を変えないため、import はここに足す（import 宣言は巻き上げられる）
import { IDBIndex } from 'fake-indexeddb';
import type { RegionRecord } from '../../src/store';

/** 種を固定した擬似乱数（mulberry32） */
const m4rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const glyphBlob = (size: number, fill: number) => new Blob([new Uint8Array(size).fill(fill)]);
const glyphMeta = (rid: string, fontstack: string, t: number, over: Partial<EntryMeta> = {}): EntryMeta =>
  ({ key: key(rid, fontstack), resourceId: rid, size: 0, fetchedAt: t, accessedAt: t, pinned: 0, ...over });

describe('固定の競合（m4-t1・L1・R6）', () => {
  it('上流を待つ間に setPinned で固定したキーは、pinned: 0 の putEntry の後も固定のまま（pinnedBytes は本体の大きさ）', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    await put(s, entry('r', 'a', 4, 1));
    expect(await s.setPinned([key('r', 'a')], 1)).toBe(1);
    expect(await put(s, entry('r', 'a', 7, 2))).toEqual({ saved: true });
    expect((await s.getEntry(key('r', 'a')))!.meta.pinned).toBe(1);
    expect(await s.getResource('r')).toMatchObject({ count: 1, bytes: 7, pinnedBytes: 7 });
    await expectCountsConsistent(s);
  });

  it('pinned: 1 の putEntry は、保存済みが pinned: 0 でも 1', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    await put(s, entry('r', 'a', 4, 1));
    await put(s, entry('r', 'a', 5, 2, { pinned: 1 }));
    expect((await s.getEntry(key('r', 'a')))!.meta.pinned).toBe(1);
    expect(await s.getResource('r')).toMatchObject({ count: 1, bytes: 5, pinnedBytes: 5 });
    await expectCountsConsistent(s);
  });

  it('putGlyphParts も保存済みの固定を保つ', async () => {
    const G = 'https://g.example/{fontstack}/{range}.pbf';
    const s = await open();
    await s.createResource(resource(G, { type: 'glyph', templates: [G] }));
    await s.putGlyphPart(glyphMeta(G, 'Noto', 1), '0-255', glyphBlob(3, 1), {}, []);
    await s.setPinned([key(G, 'Noto')], 1);
    await s.putGlyphPart(glyphMeta(G, 'Noto', 2), '256-511', glyphBlob(2, 2), {}, []);
    expect((await s.getEntry(key(G, 'Noto')))!.meta.pinned).toBe(1);
    expect(await s.getResource(G)).toMatchObject({ count: 1, bytes: 5, pinnedBytes: 5 });
    await expectCountsConsistent(s);
  });
});

describe('上限を超えた結合レコード（m4-t1・L3・R7）', () => {
  const G = 'https://g.example/{fontstack}/{range}.pbf';
  const setup = async () => {
    const s = await open();
    await s.createResource(resource(G, { type: 'glyph', templates: [G] }));
    return s;
  };
  const cap = (maxBytes: number) => [{ resourceIds: [G], maxBytes }];

  it('予算が 2 範囲分のとき、3 つ目の範囲を足すと最も古い範囲が落ちて saved: true・parts が 2 つ・size <= maxBytes', async () => {
    const s = await setup();
    // 古い順に 256-511（t=1）・0-255（t=2）。本体の中の順と fetchedAt の順を変えておく
    await s.putGlyphPart(glyphMeta(G, 'Noto', 1), '256-511', glyphBlob(10, 1), {}, cap(20));
    await s.putGlyphPart(glyphMeta(G, 'Noto', 2), '0-255', glyphBlob(10, 2), {}, cap(20));
    expect(await s.putGlyphPart(glyphMeta(G, 'Noto', 3), '512-767', glyphBlob(10, 3), {}, cap(20))).toEqual({ saved: true });
    const got = await s.getEntry(key(G, 'Noto'));
    expect(Object.keys(got!.body.parts!).sort()).toEqual(['0-255', '512-767']);
    expect(got!.meta.size).toBeLessThanOrEqual(20);
    expect(Array.from(new Uint8Array(await got!.body.blob.arrayBuffer()))).toEqual([...Array(10).fill(2), ...Array(10).fill(3)]);
    expect(got!.meta.fetchedAt).toBe(3);
    await expectCountsConsistent(s);
  });

  it('本体の前が新しく後ろが古いときも、fetchedAt の古い部分（後ろ）から落とす（レビュー L1）', async () => {
    const s = await setup();
    // 1 回の putGlyphParts で、本体の前に新しい部分（t=20）・後ろに古い部分（t=10）を置く
    await s.putGlyphParts(glyphMeta(G, 'Noto', 20), [
      { part: '0-255', blob: glyphBlob(10, 2), fetchedAt: 20 },
      { part: '256-511', blob: glyphBlob(10, 1), fetchedAt: 10 },
    ], {}, cap(20));
    expect(await s.putGlyphPart(glyphMeta(G, 'Noto', 30), '512-767', glyphBlob(10, 3), {}, cap(20))).toEqual({ saved: true });
    const got = await s.getEntry(key(G, 'Noto'));
    expect(got!.body.parts).toEqual({
      '0-255': { offset: 0, length: 10, fetchedAt: 20 },
      '512-767': { offset: 10, length: 10, fetchedAt: 30 },
    });
    expect(Array.from(new Uint8Array(await got!.body.blob.arrayBuffer()))).toEqual([...Array(10).fill(2), ...Array(10).fill(3)]);
    await expectCountsConsistent(s);
  });

  it('新しい部分 1 つで maxBytes を超えるときは saved: false（保存済みのレコードはそのまま）', async () => {
    const s = await setup();
    await s.putGlyphPart(glyphMeta(G, 'Noto', 1), '0-255', glyphBlob(10, 1), {}, cap(20));
    expect(await s.putGlyphPart(glyphMeta(G, 'Noto', 2), '256-511', glyphBlob(21, 2), {}, cap(20))).toEqual({ saved: false });
    const got = await s.getEntry(key(G, 'Noto'));
    expect(Object.keys(got!.body.parts!)).toEqual(['0-255']);
    await expectCountsConsistent(s);
  });

  it('上限が 2 つあれば小さい方の予算で落とす', async () => {
    const s = await setup();
    await s.createResource(resource('o'));
    const evict = [{ resourceIds: [G, 'o'], maxBytes: 100 }, { resourceIds: [G], maxBytes: 15 }];
    await s.putGlyphPart(glyphMeta(G, 'Noto', 1), '0-255', glyphBlob(8, 1), {}, evict);
    expect(await s.putGlyphPart(glyphMeta(G, 'Noto', 2), '256-511', glyphBlob(8, 2), {}, evict)).toEqual({ saved: true });
    expect(Object.keys((await s.getEntry(key(G, 'Noto')))!.body.parts!)).toEqual(['256-511']);
    await expectCountsConsistent(s);
  });
});

/** 今の getAll の実装（m3 まで）を写した参照の関数。保存の前の entries の全件から、消える Entry のキーを返す */
const referenceEviction = (all: readonly EntryMeta[], meta: EntryMeta, evict: { resourceIds: string[]; maxBytes: number }[]): Set<string> => {
  const newSize = meta.size;
  const willSave = evict.every((e) => e.maxBytes > 0 && newSize <= e.maxBytes);
  const gone = new Set<string>();
  for (const scope of evict) {
    const ids = new Set(scope.resourceIds);
    const candidates = all
      .filter((e) => ids.has(e.resourceId) && e.pinned === 0 && !gone.has(e.key) && !(willSave && e.key === meta.key))
      .sort((a, b) => a.accessedAt - b.accessedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let total = candidates.reduce((sum, e) => sum + e.size, 0);
    const budget = willSave ? scope.maxBytes - newSize : scope.maxBytes;
    for (let i = 0; total > budget && i < candidates.length; i++) {
      gone.add(candidates[i].key);
      total -= candidates[i].size;
    }
  }
  return gone;
};

describe('退避の走査の省略（m4-t1・P7・R7\'・R42）', () => {
  it('予算内の保存では IDBIndex.getAll を呼ばない', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    const cap = [{ resourceIds: ['r'], maxBytes: 100 }];
    await put(s, entry('r', 'a', 10, 1), cap);
    const spy = vi.spyOn(IDBIndex.prototype, 'getAll');
    const cursor = vi.spyOn(IDBIndex.prototype, 'openCursor');
    expect(await put(s, entry('r', 'b', 10, 2), cap)).toEqual({ saved: true });
    expect(spy).not.toHaveBeenCalled();
    expect(cursor).not.toHaveBeenCalled();
  });

  it('予算を超える保存は cursor で accessedAt 昇順・同値はキー昇順に消す（getAll を呼ばない）', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    await put(s, entry('r', 'b', 10, 5));
    await put(s, entry('r', 'a', 10, 5));
    await put(s, entry('r', 'c', 10, 3));
    const spy = vi.spyOn(IDBIndex.prototype, 'getAll');
    expect(await put(s, entry('r', 'n', 10, 9), [{ resourceIds: ['r'], maxBytes: 20 }])).toEqual({ saved: true });
    expect(spy).not.toHaveBeenCalled();
    expect(await s.hasEntries(['c', 'a', 'b', 'n'].map((x) => key('r', x)))).toEqual([false, false, true, true]);
    await expectCountsConsistent(s);
  });

  it('(a) 予算いっぱいの Resource で、固定していない同じキーの大きい Entry を小さい本体で置き換えても何も消えない', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    const cap = [{ resourceIds: ['r'], maxBytes: 30 }];
    await put(s, entry('r', 'a', 10, 1), cap);
    await put(s, entry('r', 'big', 20, 2), cap);
    expect(await put(s, entry('r', 'big', 5, 3), cap)).toEqual({ saved: true });
    expect(await s.hasEntries([key('r', 'a'), key('r', 'big')])).toEqual([true, true]);
    expect(await s.getResource('r')).toMatchObject({ count: 2, bytes: 15 });
    await expectCountsConsistent(s);
  });

  it('(b) 2 つの要素が同じ Resource を共有するとき、参照の関数（今の getAll の実装）と同じ Entry が消える（種を固定した 100 回）', async () => {
    const s = await open();
    const rand = m4rng(20261107);
    const ids = ['R', 'A', 'B'] as const;
    for (const id of ids) await s.createResource(resource(id));
    let pinnedSeen = 0;
    let evicted = 0;
    for (let i = 0; i < 100; i++) {
      const rid = ids[Math.floor(rand() * ids.length)];
      const suffix = `${Math.floor(rand() * 6)}`;
      const size = 1 + Math.floor(rand() * 15);
      const pinned: 0 | 1 = rand() < 0.1 ? 1 : 0;
      if (pinned) pinnedSeen++;
      const meta = entry(rid, suffix, size, 1000 + Math.floor(rand() * 50), { pinned });
      // 共有の R を、S1（R と A）と S2（R と B）が上限つきで参照する
      const evict = [
        { resourceIds: ['R', 'A'], maxBytes: 30 + Math.floor(rand() * 20) },
        { resourceIds: ['R', 'B'], maxBytes: 25 + Math.floor(rand() * 20) },
      ];
      const before = await rawAll<EntryMeta>('entries');
      const gone = referenceEviction(before, meta, evict);
      evicted += gone.size;
      const { saved } = await put(s, meta, evict);
      const expected = new Set(before.map((e) => e.key).filter((k2) => !gone.has(k2)));
      if (saved) expected.add(meta.key);
      expect(new Set((await rawAll<EntryMeta>('entries')).map((e) => e.key)), `round ${i}`).toEqual(expected);
    }
    await expectCountsConsistent(s);
    expect(pinnedSeen).toBeGreaterThan(0);
    expect(evicted).toBeGreaterThan(0);
  });

  it('2 つの Resource をまたぐ要素で、cursor の併合が accessedAt の順を守る（A の古い → B の古い → A の新しい）', async () => {
    const s = await open();
    for (const id of ['A', 'B']) await s.createResource(resource(id));
    await put(s, entry('A', 'old', 10, 1));
    await put(s, entry('B', 'old', 10, 2));
    await put(s, entry('A', 'new', 10, 3));
    await put(s, entry('B', 'new', 10, 4));
    const evict = [{ resourceIds: ['A', 'B'], maxBytes: 20 }];
    expect(await put(s, entry('A', 'n', 10, 5), evict)).toEqual({ saved: true });
    expect(await s.hasEntries(['A\0old', 'B\0old', 'A\0new', 'B\0new', 'A\0n'])).toEqual([false, false, false, true, true]);
    await expectCountsConsistent(s);
  });
});

describe('store の新しい操作（m4-t1）', () => {
  it('deleteEntries・setPinned・pruneGlyphParts の後も count・bytes・pinnedBytes が全件の集計と一致する（種を固定した 100 回）', async () => {
    const G = 'https://g.example/{fontstack}/{range}.pbf';
    const s = await open();
    const rand = m4rng(20261108);
    await s.createResource(resource('r1'));
    await s.createResource(resource('r2'));
    await s.createResource(resource(G, { type: 'glyph', templates: [G] }));
    const tileKeys = (n: number) => Array.from({ length: n }, () => key(rand() < 0.5 ? 'r1' : 'r2', `${Math.floor(rand() * 8)}`));
    const kinds = { put: 0, del: 0, pin: 0, unpin: 0, glyph: 0, prune: 0 };
    for (let i = 0; i < 100; i++) {
      const roll = rand();
      if (roll < 0.35) {
        const rid = rand() < 0.5 ? 'r1' : 'r2';
        await put(s, entry(rid, `${Math.floor(rand() * 8)}`, 1 + Math.floor(rand() * 20), i, { pinned: rand() < 0.2 ? 1 : 0 }));
        kinds.put++;
      } else if (roll < 0.5) {
        await s.deleteEntries(tileKeys(3), rand() < 0.5 ? { unpinnedOnly: true } : rand() < 0.5 ? { fetchedBefore: i - 10 } : undefined);
        kinds.del++;
      } else if (roll < 0.65) {
        await s.setPinned(tileKeys(3), 1);
        kinds.pin++;
      } else if (roll < 0.75) {
        await s.setPinned(tileKeys(3), 0);
        kinds.unpin++;
      } else if (roll < 0.9) {
        const range = ['0-255', '256-511', '512-767'][Math.floor(rand() * 3)];
        await s.putGlyphPart(glyphMeta(G, rand() < 0.5 ? 'Noto' : 'Open', i), range, glyphBlob(1 + Math.floor(rand() * 9), i % 250), {}, []);
        kinds.glyph++;
      } else {
        await s.pruneGlyphParts(key(G, rand() < 0.5 ? 'Noto' : 'Open'), i - Math.floor(rand() * 30));
        kinds.prune++;
      }
    }
    await expectCountsConsistent(s);
    for (const [name, n] of Object.entries(kinds)) expect(n, name).toBeGreaterThan(0);
  });

  it('deleteEntries は tx の中で条件を見直す（一覧の後の固定・取り直しを消さない）。戻り値は消した数', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    await put(s, entry('r', 'a', 4, 10));
    await put(s, entry('r', 'b', 4, 10));
    await put(s, entry('r', 'c', 4, 10));
    // 一覧を読んだ後に固定された a と、取り直されて fetchedAt が新しくなった b
    const listed = (await s.listUnpinnedBefore(100, 10)).metas.map((m) => m.key);
    expect(listed).toEqual([key('r', 'a'), key('r', 'b'), key('r', 'c')]);
    await s.setPinned([key('r', 'a')], 1);
    await put(s, entry('r', 'b', 4, 200));
    expect(await s.deleteEntries([key('r', 'a')], { unpinnedOnly: true })).toBe(0);
    expect(await s.deleteEntries([key('r', 'b')], { fetchedBefore: 100 })).toBe(0);
    expect(await s.deleteEntries([key('r', 'c'), key('r', 'missing')], { unpinnedOnly: true, fetchedBefore: 100 })).toBe(1);
    expect(await s.hasEntries(['a', 'b', 'c'].map((x) => key('r', x)))).toEqual([true, true, false]);
    // 条件なしなら固定も消す
    expect(await s.deleteEntries([key('r', 'a'), key('r', 'b')])).toBe(2);
    expect(await s.getResource('r')).toMatchObject({ count: 0, bytes: 0, pinnedBytes: 0 });
    await expectCountsConsistent(s);
  });

  it('setPinned は付けた・外した数を返し、同じ値や無いキーは数えない', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    await put(s, entry('r', 'a', 3, 1));
    await put(s, entry('r', 'b', 5, 1, { pinned: 1 }));
    expect(await s.setPinned([key('r', 'a'), key('r', 'b'), key('r', 'x')], 1)).toBe(1);
    expect(await s.getResource('r')).toMatchObject({ pinnedBytes: 8 });
    expect(await s.setPinned([key('r', 'a'), key('r', 'b')], 0)).toBe(2);
    expect(await s.getResource('r')).toMatchObject({ pinnedBytes: 0, count: 2, bytes: 8 });
    expect(await s.setPinned([], 1)).toBe(0);
    await expectCountsConsistent(s);
  });

  it('pruneGlyphParts: 古い部分だけ落ちて size が減る・全部落ちればレコードが消える・固定のレコードは触らない', async () => {
    const G = 'https://g.example/{fontstack}/{range}.pbf';
    const s = await open();
    await s.createResource(resource(G, { type: 'glyph', templates: [G] }));
    await s.putGlyphParts(glyphMeta(G, 'Noto', 0), [
      { part: '0-255', blob: glyphBlob(3, 1), fetchedAt: 10 },
      { part: '256-511', blob: glyphBlob(4, 2), fetchedAt: 30 },
      { part: '512-767', blob: glyphBlob(5, 3), fetchedAt: 20 },
    ], {}, []);
    expect(await s.pruneGlyphParts(key(G, 'Noto'), 25)).toBe(2);
    const got = await s.getEntry(key(G, 'Noto'));
    expect(got!.body.parts).toEqual({ '256-511': { offset: 0, length: 4, fetchedAt: 30 } });
    expect(got!.meta).toMatchObject({ size: 4, fetchedAt: 30 });
    expect(Array.from(new Uint8Array(await got!.body.blob.arrayBuffer()))).toEqual([2, 2, 2, 2]);
    expect(await s.pruneGlyphParts(key(G, 'Noto'), 25)).toBe(0);
    expect(await s.pruneGlyphParts(key(G, 'Noto'), 31)).toBe(1);
    expect(await s.getEntry(key(G, 'Noto'))).toBeUndefined();
    expect(await s.getResource(G)).toMatchObject({ count: 0, bytes: 0 });
    // 固定のレコード
    await s.putGlyphPart(glyphMeta(G, 'Open', 5, { pinned: 1 }), '0-255', glyphBlob(2, 1), {}, []);
    expect(await s.pruneGlyphParts(key(G, 'Open'), 100)).toBe(0);
    expect((await s.getEntry(key(G, 'Open')))!.meta.size).toBe(2);
    expect(await s.pruneGlyphParts(key(G, 'missing'), 100)).toBe(0);
    await expectCountsConsistent(s);
  });

  it('listUnpinnedBefore は固定を含めず、before 未満だけを古い順に limit 件、next で続きが読める', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    await put(s, entry('r', 'b', 1, 5));
    await put(s, entry('r', 'a', 1, 5));
    await put(s, entry('r', 'c', 1, 3));
    await put(s, entry('r', 'p', 1, 1, { pinned: 1 }));
    await put(s, entry('r', 'late', 1, 50));
    const first = await s.listUnpinnedBefore(10, 2);
    expect(first.metas.map((m) => m.key)).toEqual([key('r', 'c'), key('r', 'a')]);
    expect(first.next).toBeDefined();
    const second = await s.listUnpinnedBefore(10, 2, first.next);
    expect(second.metas.map((m) => m.key)).toEqual([key('r', 'b')]);
    expect(second.next).toBeUndefined();
    expect((await s.listUnpinnedBefore(10, 10)).metas.map((m) => m.key)).toEqual([key('r', 'c'), key('r', 'a'), key('r', 'b')]);
  });

  it('listUnpinnedBefore は同じ fetchedAt の途中から続きを読み、続きの位置のキーが消えても欠けも重複もない（レビュー L2）', async () => {
    const s = await open();
    await s.createResource(resource('r'));
    for (const x of ['a', 'b', 'c', 'd']) await put(s, entry('r', x, 1, 5));
    const first = await s.listUnpinnedBefore(10, 2);
    expect(first.metas.map((m) => m.key)).toEqual([key('r', 'a'), key('r', 'b')]);
    const second = await s.listUnpinnedBefore(10, 2, first.next);
    expect(second.metas.map((m) => m.key)).toEqual([key('r', 'c'), key('r', 'd')]);
    // 続きの位置（b）を消してから読み直す
    expect(await s.deleteEntries([key('r', 'b')], {})).toBe(1);
    const again = await s.listUnpinnedBefore(10, 2, first.next);
    expect(again.metas.map((m) => m.key)).toEqual([key('r', 'c'), key('r', 'd')]);
  });

  it('entriesOf は Resource のキーの範囲だけを limit 件ずつ読む', async () => {
    const s = await open();
    for (const id of ['r', 'r2']) await s.createResource(resource(id));
    for (const x of ['a', 'b', 'c']) await put(s, entry('r', x, 1, 1));
    await put(s, entry('r2', 'a', 1, 1));
    const first = await s.entriesOf('r', 2);
    expect(first.metas.map((m) => m.key)).toEqual([key('r', 'a'), key('r', 'b')]);
    expect(first.next).toBe(key('r', 'b'));
    const second = await s.entriesOf('r', 2, first.next);
    expect(second.metas.map((m) => m.key)).toEqual([key('r', 'c')]);
    expect(second.next).toBeUndefined();
  });

  it('entriesAtZoom は z の Entry だけを返す', async () => {
    const s = await open();
    for (const id of ['r', 'r2']) await s.createResource(resource(id));
    await put(s, entry('r', '1_0_0', 1, 1, { z: 1, x: 0, y: 0 }));
    await put(s, entry('r', '2_0_0', 1, 1, { z: 2, x: 0, y: 0 }));
    await put(s, entry('r', '2_1_0', 1, 1, { z: 2, x: 1, y: 0 }));
    await put(s, entry('r2', '2_0_0', 1, 1, { z: 2, x: 0, y: 0 }));
    await put(s, entry('r', 'style', 1, 1));
    expect((await s.entriesAtZoom('r', 2)).map((m) => m.key).sort()).toEqual([key('r', '2_0_0'), key('r', '2_1_0')]);
    expect(await s.entriesAtZoom('r', 3)).toEqual([]);
  });

  it('regions の 5 操作。patchRegion は無い id で何もしない・fn が undefined なら書かない。deleteSource が regions を消す', async () => {
    const s = await open();
    const r1: RegionRecord = { id: 'g1', sourceId: 's1', status: 'running' };
    const r2: RegionRecord = { id: 'g2', sourceId: 's1', status: 'complete' };
    const r3: RegionRecord = { id: 'g3', sourceId: 's2', status: 'running' };
    for (const r of [r1, r2, r3]) await s.putRegion(r);
    expect(await s.getRegion('g1')).toEqual(r1);
    expect((await s.listRegions('s1')).map((r) => r.id).sort()).toEqual(['g1', 'g2']);
    expect(await s.patchRegion('g1', (r) => ({ ...r, status: 'complete' }))).toEqual({ ...r1, status: 'complete' });
    expect(await s.getRegion('g1')).toEqual({ ...r1, status: 'complete' });
    const fn = vi.fn(() => undefined);
    expect(await s.patchRegion('g2', fn)).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await s.getRegion('g2')).toEqual(r2);
    const never = vi.fn((r: RegionRecord) => r);
    expect(await s.patchRegion('none', never)).toBeUndefined();
    expect(never).not.toHaveBeenCalled();
    expect(await s.getRegion('none')).toBeUndefined();
    await s.deleteRegion('g2');
    expect((await s.listRegions('s1')).map((r) => r.id)).toEqual(['g1']);
    await s.deleteSource('s1');
    expect(await s.listRegions('s1')).toEqual([]);
    expect(await s.getRegion('g3')).toEqual(r3);
  });

  it('hasEntries（I12）: 古い形の本体を持つキーでも true。本体を読まない（bodies の get が 0 回）', async () => {
    const s = await open();
    await s.createResource(resource('r1'));
    const e = entry('r1', '1_0_0', 4, 10);
    await put(s, e);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(STORE_DB_NAME);
      req.onsuccess = () => resolve(req.result as unknown as IDBDatabase);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(['bodies'], 'readwrite');
      t.objectStore('bodies').put({ key: e.key, blob: new Blob([new Uint8Array(4)]), headers: {} });
      t.oncomplete = () => resolve();
      t.onabort = () => reject(t.error);
    });
    db.close();
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    expect(await s.hasEntries([e.key, key('r1', 'missing')])).toEqual([true, false]);
    expect(get.mock.contexts.filter((c) => (c as IDBObjectStore).name === 'bodies')).toHaveLength(0);
  });
});
