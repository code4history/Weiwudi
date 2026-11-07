// 全体上限 setLimits と全体の数 totals の試験（m4-t6・仕様 §7.1・R15・R42・第 2 回 M1）。
// 計画 docs/superpowers/plans/2026-11-07-m4-range-release-migration.md の m4-t6。
// store の試験は fake-indexeddb の上の実物の store.ts、setLimits は SW のハーネスの制御 POST で確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBDatabase, IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  openStore, STORE_DB_NAME,
  type EntryMeta, type EvictionScope, type ResourceMeta, type ResourcePolicy, type Store,
} from '../../src/store';
import { createSwHarness, type SwHarness } from './sw-harness';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---- store の試験の準備 ----

let factory: IDBFactory;
const opened: Store[] = [];

const useFreshDb = () => {
  factory = new IDBFactory();
  vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
};

const open = async (): Promise<Store> => {
  const s = await openStore();
  opened.push(s);
  return s;
};

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const POLICY: ResourcePolicy = {
  cacheTtl: 86_400_000,
  store: true,
  outOfRange: { extent: 'transparent', zoom: 'transparent' },
  credentialParams: [],
};

const resource = (id: string, over: Partial<ResourceMeta> = {}): ResourceMeta => ({
  id, type: 'tile', templates: [`https://${id}.example/{z}/{x}/{y}.png`], sourceIds: ['s1'], policy: POLICY,
  count: 0, bytes: 0, pinnedBytes: 0, ...over,
});

const key = (rid: string, suffix: string) => `${rid}\0${suffix}`;

const entry = (rid: string, suffix: string, size: number, accessedAt: number, over: Partial<EntryMeta> = {}): EntryMeta => ({
  key: key(rid, suffix), resourceId: rid, size, fetchedAt: accessedAt, accessedAt, pinned: 0, ...over,
});

const put = (s: Store, meta: EntryMeta, evict: EvictionScope[] = []) =>
  s.putEntry(meta, { key: meta.key, blob: new Blob([new Uint8Array(meta.size)]), headers: {} }, evict);

/** 生の DB を開いて fn を 1 つの tx で行う（store を通さない） */
const raw = async <T>(names: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest | undefined): Promise<T> => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(STORE_DB_NAME);
    req.onsuccess = () => resolve(req.result as unknown as IDBDatabase);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(names, mode) as unknown as IDBTransaction;
      const req = fn(t);
      let value: T;
      if (req) req.onsuccess = () => { value = req.result as T; };
      t.oncomplete = () => resolve(value);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
};

const allEntries = () => raw<EntryMeta[]>(['entries'], 'readonly', (t) => t.objectStore('entries').getAll());
const rawTotals = async () => (await raw<{ value: unknown } | undefined>(['kv'], 'readonly', (t) => t.objectStore('kv').get('totals')))?.value;
const dropTotals = () => raw<void>(['kv'], 'readwrite', (t) => { t.objectStore('kv').delete('totals'); return undefined; });

/** 全件の集計（totals が合っているべき値） */
const aggregate = (all: EntryMeta[]) => ({
  bytes: all.reduce((n, e) => n + e.size, 0),
  pinnedBytes: all.reduce((n, e) => n + (e.pinned === 1 ? e.size : 0), 0),
  count: all.length,
});

const lru = (a: EntryMeta, b: EntryMeta) => a.accessedAt - b.accessedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * 今の getAll の実装を写した参照の関数（第 2 回 M1）。要素ごとに範囲の全件（全体の要素は [pinned, accessedAt] の全件）を読み、
 * 固定・前の要素が消したもの・保存する同じキーを外して、古い順に予算まで消す。消す Entry のキーの集合を返す
 */
const referenceVictims = (all: readonly EntryMeta[], meta: EntryMeta, evict: readonly EvictionScope[]): Set<string> => {
  const willSave = evict.every((e) => e.maxBytes > 0 && meta.size <= e.maxBytes);
  const gone = new Set<string>();
  for (const scope of evict) {
    const ids = scope.resourceIds;
    const candidates = all
      .filter((e) => (ids === undefined || ids.indexOf(e.resourceId) >= 0) && e.pinned === 0 && !gone.has(e.key)
        && !(willSave && e.key === meta.key))
      .sort(lru);
    let total = candidates.reduce((n, e) => n + e.size, 0);
    const budget = willSave ? scope.maxBytes - meta.size : scope.maxBytes;
    for (const e of candidates) {
      if (total <= budget) break;
      gone.add(e.key);
      total -= e.size;
    }
  }
  return gone;
};

/** 種を固定した擬似乱数（mulberry32） */
const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe('退避の見積もり（第 2 回 M1・R42）: 参照の関数との突き合わせ', () => {
  beforeEach(useFreshDb);

  it('Source の上限と全体上限の両方がある保存と、同じキーの置き換えを含む 100 回で、消す Entry の集合が参照と同じ', async () => {
    const s = await open();
    const ids = ['a', 'b', 'c'];
    for (const id of ids) await s.createResource(resource(id));
    const r = rng(20261107);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    let both = 0;
    let victims = 0;
    let replaced = 0;
    for (let i = 0; i < 100; i++) {
      const rid = pick(ids);
      const meta = entry(rid, `k${Math.floor(r() * 6)}`, 1 + Math.floor(r() * 15), Math.floor(r() * 20),
        { pinned: r() < 0.1 ? 1 : 0 });
      const evict: EvictionScope[] = [];
      // Source の要素（その Resource を含む Source）を 0〜2 個、全体の要素を最後に（evictScopesFor と同じ並び）
      if (r() < 0.7) evict.push({ resourceIds: [rid, pick(ids)], maxBytes: 20 + Math.floor(r() * 40) });
      if (r() < 0.4) evict.push({ resourceIds: ids.slice(), maxBytes: 30 + Math.floor(r() * 40) });
      if (r() < 0.7) evict.push({ maxBytes: 25 + Math.floor(r() * 50) });
      const before = await allEntries();
      if (before.some((e) => e.key === meta.key && e.pinned === 0)) replaced++;
      const expected = referenceVictims(before, meta, evict);
      const willSave = evict.every((e) => e.maxBytes > 0 && meta.size <= e.maxBytes);
      expect(await put(s, meta, evict)).toEqual({ saved: willSave });
      const after = new Set((await allEntries()).map((e) => e.key));
      const actual = new Set(before.map((e) => e.key).filter((k) => !after.has(k)));
      expect([...actual].sort()).toEqual([...expected].sort());
      victims += actual.size;
      if (actual.size > 0 && evict.some((e) => e.resourceIds) && evict.some((e) => !e.resourceIds)) both++;
      // 固定も時々付け外す（固定の Entry は候補から外れる）
      if (r() < 0.2) {
        const keys = (await allEntries()).map((e) => e.key);
        if (keys.length > 0) await s.setPinned([pick(keys)], r() < 0.5 ? 1 : 0);
      }
      expect(await s.getTotals()).toEqual(aggregate(await allEntries()));
    }
    // 突き合わせが空振りしていない（退避が起き、両方の要素がある保存と置き換えを含む）
    expect(victims).toBeGreaterThan(20);
    expect(both).toBeGreaterThan(3);
    expect(replaced).toBeGreaterThan(3);
  });

  it('Source の要素が先に消した分を、全体の要素が二重に消さない', async () => {
    const s = await open();
    await s.createResource(resource('a'));
    await s.createResource(resource('b'));
    await put(s, entry('a', '1', 10, 1));
    await put(s, entry('b', '1', 10, 2));
    await put(s, entry('a', '2', 10, 3));
    // a の上限 20 で a/1 が消える（a は a/2 と新しい a/n の 20）。全体は 30 − 10（a/1）＋ 10 ＝ 30 で収まるので b/1 は消えない
    // （a/1 の分を見積もりに入れ忘れると 40 と数えて b/1 まで消す）
    expect(await put(s, entry('a', 'n', 10, 9), [{ resourceIds: ['a'], maxBytes: 20 }, { maxBytes: 30 }])).toEqual({ saved: true });
    expect(await s.hasEntries([key('a', '1'), key('b', '1'), key('a', '2'), key('a', 'n')])).toEqual([false, true, true, true]);
  });
});

describe('全体上限の退避（store）', () => {
  beforeEach(useFreshDb);

  it('全体の要素は Resource をまたいで accessedAt の古い順に消す。固定は消さない', async () => {
    const s = await open();
    await s.createResource(resource('a'));
    await s.createResource(resource('b'));
    await put(s, entry('a', '1', 10, 1, { pinned: 1 }));
    await put(s, entry('b', '1', 10, 2));
    await put(s, entry('a', '2', 10, 3));
    await put(s, entry('b', '2', 10, 4));
    expect(await put(s, entry('a', '3', 10, 5), [{ maxBytes: 30 }])).toEqual({ saved: true });
    // 固定の a/1 は数えない（固定でない b/1・a/2・b/2 の 30 ＋ 新しい 10 を 30 に）: 全体で最も古い固定でない b/1 だけが消える
    expect(await s.hasEntries(['a\u00001', 'b\u00001', 'a\u00002', 'b\u00002', 'a\u00003'])).toEqual([true, false, true, true, true]);
    expect(await s.getTotals()).toEqual(aggregate(await allEntries()));
  });

  it('全体上限 0 なら何も保存しない', async () => {
    const s = await open();
    await s.createResource(resource('a'));
    expect(await put(s, entry('a', '1', 1, 1), [{ maxBytes: 0 }])).toEqual({ saved: false });
    expect(await allEntries()).toEqual([]);
  });
});

describe('全体の数 totals（R15・第 1 回 M13）', () => {
  beforeEach(useFreshDb);

  it('全操作を混ぜた種を固定の 100 回で、totals が全件の集計と一致する', async () => {
    const s = await open();
    const ids = ['a', 'b', 'g'];
    for (const id of ids) await s.createResource(resource(id, id === 'g' ? { type: 'glyph' } : {}));
    const r = rng(7);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    const seen = new Set<string>();
    let pruned = 0;
    let evicted = 0;
    for (let i = 0; i < 100; i++) {
      const ops = ['put', 'glyph', 'clear', 'deleteResource', 'deleteEntries', 'setPinned', 'prune', 'evictGlobal', 'put', 'glyph'];
      // 初めの 10 回は全操作を 1 回ずつ通し、その後は無作為
      const op = i < ops.length ? ops[i] : pick(ops);
      const keys = (await allEntries()).map((e) => e.key);
      const t = i + 1;
      switch (op) {
        case 'put': {
          const rid = pick(['a', 'b']);
          const evict: EvictionScope[] = r() < 0.5 ? [{ maxBytes: 20 + Math.floor(r() * 40) }] : [];
          if (r() < 0.3) evict.unshift({ resourceIds: [rid], maxBytes: 15 + Math.floor(r() * 20) });
          await put(s, entry(rid, `k${Math.floor(r() * 8)}`, 1 + Math.floor(r() * 9), t, { pinned: r() < 0.2 ? 1 : 0 }), evict);
          break;
        }
        case 'glyph': {
          const range = `${Math.floor(r() * 4) * 256}-${Math.floor(r() * 4) * 256 + 255}`;
          const meta = entry('g', `font${Math.floor(r() * 2)}`, 0, t);
          await s.putGlyphParts(meta, [{ part: range, blob: new Blob([new Uint8Array(1 + Math.floor(r() * 5))]), fetchedAt: t }], {},
            r() < 0.3 ? [{ maxBytes: 30 }] : []);
          break;
        }
        case 'clear': await s.clearEntries(pick(ids)); break;
        case 'deleteResource': {
          const id = pick(ids);
          await s.deleteResource(id);
          await s.createResource(resource(id, id === 'g' ? { type: 'glyph' } : {}));
          break;
        }
        case 'deleteEntries':
          await s.deleteEntries(keys.filter(() => r() < 0.3), r() < 0.5 ? { unpinnedOnly: true } : { fetchedBefore: t - 5 });
          break;
        case 'setPinned': await s.setPinned(keys.filter(() => r() < 0.3), r() < 0.5 ? 1 : 0); break;
        case 'prune': {
          const glyphs = keys.filter((k) => k.startsWith('g\0'));
          if (glyphs.length > 0) pruned += await s.pruneGlyphParts(pick(glyphs), t - Math.floor(r() * 20));
          break;
        }
        case 'evictGlobal': evicted += await s.evictGlobal(Math.floor(r() * 20)); break;
      }
      seen.add(op);
      const all = await allEntries();
      expect(await s.getTotals()).toEqual(aggregate(all));
      // Resource の和とも一致する
      const resources = await s.listResources();
      expect({
        bytes: resources.reduce((n, x) => n + x.bytes, 0),
        pinnedBytes: resources.reduce((n, x) => n + x.pinnedBytes, 0),
        count: resources.reduce((n, x) => n + x.count, 0),
      }).toEqual(aggregate(all));
    }
    expect(seen.size).toBe(8);
    // 空振りしていない（部分の掃除と全体の退避が実際に消している）
    expect(pruned).toBeGreaterThan(0);
    expect(evicted).toBeGreaterThan(0);
    expect(await rawTotals()).toEqual(aggregate(await allEntries()));
  });

  it('totals の無い DB で最初の保存が、同じ tx の resources の和から作る（同時の保存を挟んでもずれない）', async () => {
    const s = await open();
    await s.createResource(resource('a'));
    await s.createResource(resource('b'));
    await put(s, entry('a', '1', 4, 1));
    await put(s, entry('b', '1', 6, 2, { pinned: 1 }));
    await dropTotals();
    expect(await rawTotals()).toBeUndefined();
    // 読むだけ（getTotals）は作らずに和を返す
    expect(await s.getTotals()).toEqual({ bytes: 10, pinnedBytes: 6, count: 2 });
    expect(await rawTotals()).toBeUndefined();
    await Promise.all([
      put(s, entry('a', '2', 3, 3)),
      put(s, entry('b', '2', 5, 4), [{ maxBytes: 100 }]),
      s.setPinned([key('a', '1')], 1),
    ]);
    expect(await rawTotals()).toEqual(aggregate(await allEntries()));
    expect(await rawTotals()).toEqual({ bytes: 18, pinnedBytes: 10, count: 4 });
  });

  it('deleteResource の後に totals から消した Resource の分が引かれている', async () => {
    const s = await open();
    await s.createResource(resource('a'));
    await s.createResource(resource('b'));
    await put(s, entry('a', '1', 4, 1));
    await put(s, entry('a', '2', 5, 2, { pinned: 1 }));
    await put(s, entry('b', '1', 6, 3));
    expect(await s.getTotals()).toEqual({ bytes: 15, pinnedBytes: 5, count: 3 });
    await s.deleteResource('a');
    expect(await rawTotals()).toEqual({ bytes: 6, pinnedBytes: 0, count: 1 });
    // 無い Resource の deleteResource は数を変えない
    await s.deleteResource('none');
    expect(await rawTotals()).toEqual({ bytes: 6, pinnedBytes: 0, count: 1 });
  });
});

// ---- setLimits（制御 POST） ----

const A = 'https://a.example/{z}/{x}/{y}.png';
const B = 'https://b.example/{z}/{x}/{y}.png';
const tileOf = (tpl: string, x: number) => tpl.replace('{z}', '3').replace('{x}', String(x)).replace('{y}', '1');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { ok: boolean; result?: any; error?: { code: string; detail: Record<string, unknown> } };
const call = async (h: SwHarness, op: string, body: unknown = {}): Promise<Reply> => (await h.post(`/v2/${op}`, body))!.json();

describe('setLimits({ maxBytes })（仕様 §7.1・§12）', () => {
  let h: SwHarness;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    now = 1_000_000;
    vi.setSystemTime(now);
    h = createSwHarness();
    // 3 byte のタイル
    h.fetch.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
  });

  /** 1 ms 進めてタイルを 1 枚取る */
  const fetchTile = async (url: string) => {
    vi.setSystemTime(++now);
    const res = await h.dispatch(url);
    expect(res!.status).toBe(200);
    return res!;
  };

  /** Resource の保存済みの x の一覧 */
  const savedX = async (rid: string) => {
    const s = await openStore();
    try {
      return (await s.entriesOf(rid, 100)).metas.map((m) => m.x).sort();
    } finally {
      s.close();
    }
  };

  const totals = async () => {
    const s = await openStore();
    try {
      return await s.getTotals();
    } finally {
      s.close();
    }
  };

  it('2 つの Source の Entry の和が上限を超えると、Source をまたいで accessedAt の古い順に消える。固定は消えない', async () => {
    const a = (await call(h, 'register', { kind: 'raster', url: A })).result;
    const b = (await call(h, 'register', { kind: 'raster', url: B })).result;
    const ra = a.resources[0].id as string;
    const rb = b.resources[0].id as string;
    expect(await call(h, 'setLimits', { maxBytes: 9 })).toEqual({ ok: true, result: null });
    await fetchTile(tileOf(A, 1));
    await fetchTile(tileOf(B, 1));
    await fetchTile(tileOf(A, 2));
    // 和 9 で上限いっぱい。a の x=1 を固定する
    const s = await openStore();
    const [first] = (await s.entriesOf(ra, 100)).metas.filter((m) => m.x === 1);
    await s.setPinned([first.key], 1);
    s.close();
    // 固定の a/1 は上限に数えない（Source の上限と同じ）: 固定でない b/1・a/2 の 6 ＋ 新しい 3 は 9 に収まる
    const res = await fetchTile(tileOf(B, 2));
    expect(res.headers.get('x-weiwudi-error')).toBeNull();
    expect(await savedX(ra)).toEqual([1, 2]);
    expect(await savedX(rb)).toEqual([1, 2]);
    // 固定でない分が 9 を超えると、Source をまたいで最も古い b/1、次に a/2 が消える（固定の a/1 は残る）
    await fetchTile(tileOf(B, 3));
    expect(await savedX(ra)).toEqual([1, 2]);
    expect(await savedX(rb)).toEqual([2, 3]);
    await fetchTile(tileOf(A, 3));
    expect(await savedX(ra)).toEqual([1, 3]);
    expect(await savedX(rb)).toEqual([2, 3]);
    expect(await totals()).toEqual({ bytes: 12, pinnedBytes: 3, count: 4 });
  });

  it('cacheMaxBytes と全体上限の両方があるとき、両方を満たす', async () => {
    const a = (await call(h, 'register', { kind: 'raster', url: A, cacheMaxBytes: 6 })).result;
    const b = (await call(h, 'register', { kind: 'raster', url: B })).result;
    const ra = a.resources[0].id as string;
    const rb = b.resources[0].id as string;
    await call(h, 'setLimits', { maxBytes: 12 });
    for (const x of [1, 2, 3]) await fetchTile(tileOf(A, x));
    // Source の上限 6 で a/1 が消える
    expect(await savedX(ra)).toEqual([2, 3]);
    for (const x of [1, 2]) await fetchTile(tileOf(B, x));
    expect((await totals()).bytes).toBe(12);
    await fetchTile(tileOf(B, 3));
    // 全体上限 12 で、全体で最も古い a/2 が消える
    expect(await savedX(ra)).toEqual([3]);
    expect(await savedX(rb)).toEqual([1, 2, 3]);
    await fetchTile(tileOf(A, 4));
    // a の上限 6（a/3 と a/4 で 6）は満たすが全体が 15 になるので、全体で最も古い a/3 が消える
    expect(await savedX(ra)).toEqual([4]);
    expect(await savedX(rb)).toEqual([1, 2, 3]);
    expect(await totals()).toEqual({ bytes: 12, pinnedBytes: 0, count: 4 });
  });

  it('setLimits({ maxBytes: 0 }) の後は何も保存されない（配信は続く）。setLimits({}) で外れる', async () => {
    const a = (await call(h, 'register', { kind: 'raster', url: A })).result;
    const ra = a.resources[0].id as string;
    await call(h, 'setLimits', { maxBytes: 0 });
    const res = await fetchTile(tileOf(A, 1));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(res.headers.get('x-weiwudi-error')).toBeNull();
    expect(await savedX(ra)).toEqual([]);
    expect((await fetchTile(tileOf(A, 1))).headers.get('x-weiwudi-status')).toBe('miss');
    expect(await call(h, 'setLimits', {})).toEqual({ ok: true, result: null });
    await fetchTile(tileOf(A, 1));
    expect(await savedX(ra)).toEqual([1]);
    expect((await fetchTile(tileOf(A, 1))).headers.get('x-weiwudi-status')).toBe('hit');
  });

  it('不正な値は attribute-invalid で、保存済みの上限を変えない', async () => {
    const a = (await call(h, 'register', { kind: 'raster', url: A })).result;
    const ra = a.resources[0].id as string;
    await call(h, 'setLimits', { maxBytes: 0 });
    for (const v of [-1, 1.5, '10', null, true, {}, 1e400]) {
      const r = await call(h, 'setLimits', { maxBytes: v });
      expect(r.ok).toBe(false);
      expect(r.error).toMatchObject({ code: 'attribute-invalid', detail: { attribute: 'maxBytes' } });
    }
    for (const body of [[], 'x', 5]) {
      const r = await call(h, 'setLimits', body);
      expect(r.error).toMatchObject({ code: 'attribute-invalid' });
    }
    await fetchTile(tileOf(A, 1));
    expect(await savedX(ra)).toEqual([]);
  });
});
