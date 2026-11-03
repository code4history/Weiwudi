// src/store.ts の試験（m2-t2・#37）。仕様 §5.2・§5.4・§9・§13、計画 docs/superpowers/plans/2026-11-03-m2-core.md の m2-t2。
// IndexedDB は試験ごとに新しい fake-indexeddb の IDBFactory（store.ts は大域の indexedDB・IDBKeyRange を使う）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBDatabase, IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import {
  openStore, toResourceInfo, STORE_DB_NAME,
  type EntryBody, type EntryMeta, type ResourceMeta, type ResourcePolicy, type SourceRecord, type Store,
} from '../../src/store';

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
  const bodies = await rawAll<EntryBody>('bodies');
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
      id: 'https://a.example/{z}/{x}/{y}.png', kind: 'raster', spec: { url: 'https://a.example/{z}/{x}/{y}.png' },
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
