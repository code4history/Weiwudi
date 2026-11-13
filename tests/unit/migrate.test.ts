// 旧 DB（Weiwudi・Weiwudi_<mapID>）からの移行（m4-t7・仕様 §14.2・R17〜R19・R50・R51・R59）。
// fake-indexeddb の IDBFactory に 1.1.x の形の旧 DB を作り（F22）、契機（migrateStep）を 1 回ずつ進めて確かめる。
// 「SW の起動」は新しい Context（メモリの状態が空）で表す。旧 API の要求は同じ Context の handleLegacy に渡す。
// 旧レコードの epoch は試験の今の時刻にする（24 時間を過ぎると stale・refresh になり hit を確かめられない）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { createContext, type Context } from '../../src/context';
import { handleLegacy, migrationDeps } from '../../src/legacy';
import { DELETE_WAIT_MS, migrateStep, type MigrationState } from '../../src/migrate';
import { openStore, STORE_DB_NAME, type MapSetting, type StoredBody } from '../../src/store';
import { createSwHarness, SW_ORIGIN } from './sw-harness';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TEMPLATE = 'https://tile.example/{z}/{x}/{y}.png';

/** factory を大域に置き、上流はオフライン（fetch が reject）にする */
const setup = (factory: IDBFactory | Partial<IDBFactory> = new IDBFactory()) => {
  vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('self', {
    location: new URL('http://localhost:5173/weiwudi-sw.js'),
    clients: { get: vi.fn(async () => undefined) },
  });
  const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
  vi.stubGlobal('fetch', fetchMock);
  return { fetch: fetchMock };
};

/** 新しい SW の起動（メモリの状態が空の Context） */
const startSw = (): Context => createContext();
const step = (ctx: Context) => migrateStep(ctx, migrationDeps);
const get = (ctx: Context, path: string): Promise<Response> =>
  handleLegacy(ctx, { url: new URL(SW_ORIGIN + path), request: new Request(SW_ORIGIN + path), event: undefined } as never);

const setting = (mapID: string, extra: Partial<MapSetting> = {}): MapSetting => ({
  mapID, type: 'xyz', url: TEMPLATE, width: 1024, height: 1024, tileSize: 256,
  maxZoom: 2, minZoom: 0, minX: 0, maxX: 3, minY: 0, maxY: 3, totalTile: 21, ...extra,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OldRecord = Record<string, any>;
const record = (key: string, size = 4, extra: OldRecord = {}): OldRecord => ({
  z_x_y: key,
  headers: { 'content-type': 'image/png' },
  blob: new Blob([new Uint8Array(size).fill(7)], { type: 'image/png' }),
  epoch: Date.now(),
  ...extra,
});
const many = (n: number, prefix = '1'): OldRecord[] => Array.from({ length: n }, (_, i) => record(`${prefix}_${i}_0`));

const openRaw = (factory: IDBFactory, name: string, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = factory.open(name, 1);
    req.onupgradeneeded = () => upgrade?.(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
const putAll = (db: IDBDatabase, storeName: string, values: unknown[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = db.transaction([storeName], 'readwrite');
    for (const v of values) t.objectStore(storeName).put(v);
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error);
  });
const makeSettings = async (factory: IDBFactory, settings: MapSetting[]) => {
  const db = await openRaw(factory, 'Weiwudi', (d) => d.createObjectStore('mapSetting', { keyPath: 'mapID' }));
  await putAll(db, 'mapSetting', settings);
  db.close();
};
const makeTiles = async (factory: IDBFactory, mapID: string, records: OldRecord[]) => {
  const db = await openRaw(factory, `Weiwudi_${mapID}`, (d) => d.createObjectStore('tileCache', { keyPath: 'z_x_y' }));
  await putAll(db, 'tileCache', records);
  db.close();
};
const names = async (factory: IDBFactory) => (await factory.databases()).map((d) => d.name);
/** 旧 tileCache の件数（DB が無ければ undefined。無い DB を開いて作らない） */
const oldCount = async (factory: IDBFactory, mapID: string): Promise<number | undefined> => {
  if (!(await names(factory)).includes(`Weiwudi_${mapID}`)) return undefined;
  const db = await openRaw(factory, `Weiwudi_${mapID}`);
  try {
    return await new Promise<number>((resolve, reject) => {
      const req = db.transaction(['tileCache'], 'readonly').objectStore('tileCache').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
};
const stateOf = async (ctx: Context) => (await (await ctx.store()).kvGet('migration')) as MigrationState;
const mapState = async (ctx: Context, mapID: string) => (await stateOf(ctx)).maps.find((m) => m.mapID === mapID);
const resourceOf = async (ctx: Context, mapID: string) => (await ctx.store()).getResource(`map:${mapID}`);
const entryOf = async (ctx: Context, mapID: string, key: string) => (await ctx.store()).getEntry(`map:${mapID}\u0000${key}`);
/** 契機を n 回 */
const steps = async (ctx: Context, n: number) => {
  for (let i = 0; i < n; i++) await step(ctx);
};

describe('第 1 段と第 2 段（仕様 §14.2・R51）', () => {
  it('mapSetting 2 件・a 450 件・b 0 件: 1 回目で第 1 段、続く 3 回で 200・200・50 を移し、旧 DB を順に消す', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a'), setting('b')]);
    await makeTiles(factory, 'a', many(450));
    await makeTiles(factory, 'b', []);
    const ctx = startSw();

    await step(ctx);
    const sources = (await (await ctx.store()).listSources()).map((s) => s.id).sort();
    expect(sources).toEqual(['map:a', 'map:b']);
    expect((await stateOf(ctx)).stage).toBe('tiles');
    expect((await resourceOf(ctx, 'a'))!.count).toBe(0);

    await step(ctx);
    expect((await resourceOf(ctx, 'a'))!.count).toBe(200);
    expect(await oldCount(factory, 'a')).toBe(250);
    await step(ctx);
    expect((await resourceOf(ctx, 'a'))!.count).toBe(400);
    expect(await names(factory)).toEqual(expect.arrayContaining(['Weiwudi', 'Weiwudi_a', 'Weiwudi_b']));
    await step(ctx);
    expect(await resourceOf(ctx, 'a')).toMatchObject({ count: 450, bytes: 450 * 4 });
    expect(await mapState(ctx, 'a')).toMatchObject({ status: 'done', recordFailures: 0, batchFailures: 0 });
    expect(await mapState(ctx, 'b')).toMatchObject({ status: 'done' });
    const left = await names(factory);
    expect(left).not.toContain('Weiwudi_a');
    expect(left).not.toContain('Weiwudi_b');
    expect(left).not.toContain('Weiwudi');
    expect(left).toContain(STORE_DB_NAME);
    expect((await stateOf(ctx)).stage).toBe('done');
    expect(ctx.maintenance.migrated).toBe(true);
  });

  it('変換: epoch・accessedAt・z_x_y・size・contentType・本体のバイト列（ArrayBuffer）・ヘッダの名前の小文字化と除去', async () => {
    const factory = new IDBFactory();
    setup(factory);
    const epoch = Date.now() - 1000;
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [
      {
        z_x_y: '2_1_3',
        headers: {
          'Content-Type': 'image/webp', 'Set-Cookie': 'a=b', 'X-Weiwudi-Status': 'hit', 'Content-Length': '4',
          'X-Keep': 'kept',
        },
        blob: new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'image/webp' }),
        epoch,
      },
      record('2_2_3', 2, { accessedAt: epoch + 500, epoch }),
    ]);
    const ctx = startSw();
    await steps(ctx, 2);

    const e = await entryOf(ctx, 'a', '2_1_3');
    expect(e!.meta).toMatchObject({
      fetchedAt: epoch, accessedAt: epoch, z: 2, x: 1, y: 3, size: 4, pinned: 0, contentType: 'image/webp',
    });
    expect(e!.body.headers).toEqual({ 'content-type': 'image/webp', 'x-keep': 'kept' });
    expect([...new Uint8Array(await e!.body.blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect((await entryOf(ctx, 'a', '2_2_3'))!.meta).toMatchObject({ fetchedAt: epoch, accessedAt: epoch + 500, size: 2 });

    const db = await openRaw(factory, STORE_DB_NAME);
    try {
      const stored = await new Promise<StoredBody>((resolve, reject) => {
        const req = db.transaction(['bodies'], 'readonly').objectStore('bodies').get('map:a\u00002_1_3');
        req.onsuccess = () => resolve(req.result as StoredBody);
        req.onerror = () => reject(req.error);
      });
      expect(Object.prototype.toString.call(stored.data)).toBe('[object ArrayBuffer]');
      expect(stored.data.byteLength).toBe(4);
    } finally {
      db.close();
    }
  });

  it('途中で止まって旧にも新にも残っても、続きの契機で冪等に完了する（二重に数えない）', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    const records = many(450);
    await makeTiles(factory, 'a', records);
    const ctx = startSw();
    await steps(ctx, 2);
    expect((await resourceOf(ctx, 'a'))!.count).toBe(200);
    expect(await oldCount(factory, 'a')).toBe(250);

    // 新 DB への書き込みの後・旧レコードの削除と lastKey の記録の前に止まった形を作る
    const old = await openRaw(factory, 'Weiwudi_a');
    await putAll(old, 'tileCache', records);
    old.close();
    const store = await ctx.store();
    const st = (await store.kvGet('migration')) as MigrationState;
    st.maps[0].lastKey = undefined;
    await store.kvPut('migration', st);

    const next = startSw();
    await steps(next, 5);
    expect(await resourceOf(next, 'a')).toMatchObject({ count: 450, bytes: 450 * 4 });
    expect(await oldCount(factory, 'a')).toBeUndefined();
    expect((await stateOf(next)).stage).toBe('done');
  });

  it('sources に既にある mapID は上書きしない（新しい版で先に add した地図）', async () => {
    const factory = new IDBFactory();
    setup(factory);
    const s = await openStore();
    await migrationDeps.registerMap(s, setting('a', { url: 'https://new.example/{z}/{x}/{y}.png' }), 1);
    s.close();
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    const ctx = startSw();
    await steps(ctx, 2);
    const rec = await (await ctx.store()).getSource('map:a');
    expect(rec!.legacy!.url).toBe('https://new.example/{z}/{x}/{y}.png');
    expect(await entryOf(ctx, 'a', '2_1_1')).toBeDefined();
  });

  it('mapID が __proto__ の地図も移る（maps は配列）', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('__proto__')]);
    await makeTiles(factory, '__proto__', [record('2_1_1')]);
    const ctx = startSw();
    await steps(ctx, 2);
    expect(await entryOf(ctx, '__proto__', '2_1_1')).toBeDefined();
    const st = await stateOf(ctx);
    expect(Array.isArray(st.maps)).toBe(true);
    expect(st.maps).toEqual([expect.objectContaining({ mapID: '__proto__', status: 'done' })]);
    expect(st.stage).toBe('done');
  });

  it('孤児の Weiwudi_c（mapSetting に無い）は第 1 段で消える', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    await makeTiles(factory, 'c', [record('2_1_1')]);
    const ctx = startSw();
    await step(ctx);
    const left = await names(factory);
    expect(left).not.toContain('Weiwudi_c');
    expect(left).toContain('Weiwudi_a');
  });
});

describe('読み通し（R18・第 1 回 M5）', () => {
  it('最初の要求: 旧 DB だけで SW を起動し、契機を待たずに /api/cache を 1 回 → 第 1 段を待って読み通しで hit（オフライン）', async () => {
    const factory = new IDBFactory();
    const { fetch } = setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1', 6)]);
    const ctx = startSw();
    const res = await get(ctx, '/api/cache/a/2/1/1');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weiwudi-status')).toBe('hit');
    expect((await res.arrayBuffer()).byteLength).toBe(6);
    expect(fetch).not.toHaveBeenCalled();
    expect(await entryOf(ctx, 'a', '2_1_1')).toBeDefined();
    expect(await oldCount(factory, 'a')).toBe(0);
  });

  it('第 2 段の途中で、まだ移していないタイルを要求すると hit で配信され、新 DB に移り旧から消える', async () => {
    const factory = new IDBFactory();
    const { fetch } = setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [...many(450), record('2_1_1', 5)]);
    const ctx = startSw();
    await steps(ctx, 2);
    expect(await entryOf(ctx, 'a', '2_1_1')).toBeUndefined();
    const res = await get(ctx, '/api/cache/a/2/1/1');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weiwudi-status')).toBe('hit');
    expect(fetch).not.toHaveBeenCalled();
    expect(await oldCount(factory, 'a')).toBe(450 - 200);
    await steps(ctx, 3);
    expect(await resourceOf(ctx, 'a')).toMatchObject({ count: 451 });
    expect((await stateOf(ctx)).stage).toBe('done');
  });

  it('saved を見る: cacheMaxBytes が単体より小さい地図では、旧レコードは移らずに消える', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a', { cacheMaxBytes: 3 }), setting('b', { cacheMaxBytes: 3 })]);
    await makeTiles(factory, 'a', [record('2_1_1', 4)]);
    await makeTiles(factory, 'b', [record('2_1_1', 4), record('2_2_2', 2)]);
    const ctx = startSw();
    await step(ctx);
    // 読み通し: 保存されないので旧レコードを落とし、配信は上流へ（オフラインなので 404）
    const res = await get(ctx, '/api/cache/a/2/1/1');
    expect(res.status).toBe(404);
    expect(await entryOf(ctx, 'a', '2_1_1')).toBeUndefined();
    expect(await oldCount(factory, 'a')).toBe(0);
    // 第 2 段も同じ（収まるものは移る）
    await steps(ctx, 2);
    expect(await entryOf(ctx, 'b', '2_1_1')).toBeUndefined();
    expect(await entryOf(ctx, 'b', '2_2_2')).toBeDefined();
    expect(await mapState(ctx, 'b')).toMatchObject({ status: 'done', recordFailures: 0 });
  });

  it('Resource を消した直後の契機では旧レコードが残る（batchFailures を数える）', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    const ctx = startSw();
    await step(ctx);
    await (await ctx.store()).deleteResource('map:a');
    await step(ctx);
    expect(await oldCount(factory, 'a')).toBe(1);
    expect(await mapState(ctx, 'a')).toMatchObject({ status: 'pending', batchFailures: 1 });
    expect((await mapState(ctx, 'a'))!.lastKey).toBeUndefined();
  });

  it('第 1 段が失敗した（mapSetting の読み出しの reject）とき、/api/info は mapSetting から読み、次の契機でやり直す', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    const original = IDBObjectStore.prototype.getAll;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'mapSetting') throw new DOMException('boom', 'UnknownError');
      return original.apply(this, args);
    });
    const ctx = startSw();
    const res = await get(ctx, '/api/info?mapID=a');
    expect(await res.json()).toMatchObject({ mapID: 'a', url: TEMPLATE });
    expect(await (await ctx.store()).getSource('map:a')).toBeUndefined();
    spy.mockRestore();
    await step(ctx);
    expect(await (await ctx.store()).getSource('map:a')).toBeDefined();
  });
});

describe('失敗の数え方（第 1 回 M6・第 2 回 L2）', () => {
  it('先頭の 250 件が壊れた記録（blob が無い）でも lastKey で最後まで進み、recordFailures 250・batchFailures 0', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    const broken = Array.from({ length: 250 }, (_, i) => ({ z_x_y: `1_${i}_0`, headers: {}, epoch: Date.now() }));
    await makeTiles(factory, 'a', [...broken, ...many(50, '3')]);
    const ctx = startSw();
    await steps(ctx, 3);
    expect(await mapState(ctx, 'a')).toMatchObject({ status: 'done', recordFailures: 250, batchFailures: 0 });
    expect((await resourceOf(ctx, 'a'))!.count).toBe(50);
    expect((await stateOf(ctx)).stage).toBe('done');
  });

  it('open が 3 回失敗する地図は failed になり、その Weiwudi_a は残って読み通しが続き、done の地図の DB は消える', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a'), setting('b')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    await makeTiles(factory, 'b', [record('2_1_1')]);
    const open = factory.open.bind(factory);
    let failures = 0;
    vi.spyOn(factory, 'open').mockImplementation((name: string, version?: number) => {
      if (name === 'Weiwudi_a' && failures < 3) {
        failures++;
        throw new DOMException('boom', 'UnknownError');
      }
      return open(name, version);
    });
    const ctx = startSw();
    await steps(ctx, 4);
    expect(await mapState(ctx, 'a')).toMatchObject({ status: 'failed', batchFailures: 3 });
    expect(await entryOf(ctx, 'b', '2_1_1')).toBeUndefined();
    await step(ctx);
    expect(await entryOf(ctx, 'b', '2_1_1')).toBeDefined();
    const left = await names(factory);
    expect(left).toContain('Weiwudi_a');
    expect(left).not.toContain('Weiwudi_b');
    expect(left).not.toContain('Weiwudi');
    expect((await stateOf(ctx)).stage).toBe('done');
    // failed の地図だけ読み通しを続ける
    const res = await get(ctx, '/api/cache/a/2/1/1');
    expect(res.headers.get('x-weiwudi-status')).toBe('hit');
    expect(await oldCount(factory, 'a')).toBe(0);
  });

  it('Resource の無い地図が並びの先頭にあっても、3 回で failed になり後ろの地図が進む', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a'), setting('b')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    await makeTiles(factory, 'b', [record('2_1_1')]);
    const ctx = startSw();
    await step(ctx);
    await (await ctx.store()).deleteResource('map:a');
    await steps(ctx, 3);
    expect(await mapState(ctx, 'a')).toMatchObject({ status: 'failed', batchFailures: 3 });
    expect(await oldCount(factory, 'a')).toBe(1);
    await step(ctx);
    expect(await entryOf(ctx, 'b', '2_1_1')).toBeDefined();
    expect(await mapState(ctx, 'b')).toMatchObject({ status: 'done' });
  });
});

describe('PR #103 のレビュー（M1・L1・L2）', () => {
  it('M1: putEntry が 3 回 reject すると failed になり、Weiwudi_a と旧レコードが残る（lastKey は進めない）', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1'), record('2_1_2'), record('2_1_3')]);
    const ctx = startSw();
    await step(ctx);
    const store = await ctx.store();
    vi.spyOn(store, 'putEntry').mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));
    await steps(ctx, 3);
    const a = await mapState(ctx, 'a');
    expect(a).toMatchObject({ status: 'failed', batchFailures: 3, recordFailures: 0 });
    expect(a!.lastKey).toBeUndefined();
    expect(await oldCount(factory, 'a')).toBe(3);
    await step(ctx);
    expect((await stateOf(ctx)).stage).toBe('done');
    expect(await names(factory)).toContain('Weiwudi_a');
    expect(await oldCount(factory, 'a')).toBe(3);
  });

  it('L1: 失敗と成功のバッチを交互に繰り返しても failed にならない（連続 3 回で failed）', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', many(700));
    const ctx = startSw();
    await step(ctx);
    const spy = vi.spyOn(await ctx.store(), 'putEntry');
    for (let i = 0; i < 3; i++) {
      spy.mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'));
      await step(ctx);
      expect(await mapState(ctx, 'a')).toMatchObject({ batchFailures: 1 });
      await step(ctx);
      expect(await mapState(ctx, 'a')).toMatchObject({ status: 'copying', batchFailures: 0 });
    }
    expect((await resourceOf(ctx, 'a'))!.count).toBe(600);
    await step(ctx);
    expect(await mapState(ctx, 'a')).toMatchObject({ status: 'done', batchFailures: 0 });
    expect((await resourceOf(ctx, 'a'))!.count).toBe(700);
  });

  it('L2: done の後に Weiwudi_a だけが残る（Weiwudi が無い）とき、sources に地図があれば孤児にせず移す', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    const ctx = startSw();
    await steps(ctx, 2);
    expect((await stateOf(ctx)).stage).toBe('done');
    await makeTiles(factory, 'a', [record('2_2_2')]);
    expect(await names(factory)).not.toContain('Weiwudi');
    const next = startSw();
    await steps(next, 2);
    expect(await entryOf(next, 'a', '2_2_2')).toBeDefined();
    expect((await stateOf(next)).stage).toBe('done');
    expect(await names(factory)).not.toContain('Weiwudi_a');
  });

  it('L2: sources にも無い Weiwudi_c は従来どおり孤児として消す', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeTiles(factory, 'c', [record('2_1_1')]);
    const ctx = startSw();
    await step(ctx);
    expect(await names(factory)).not.toContain('Weiwudi_c');
    expect(await entryOf(ctx, 'c', '2_1_1')).toBeUndefined();
  });
});

describe('旧 API の clean・delete との順（第 1 回 M6・第 2 回 M2）', () => {
  it('第 2 段の途中の clean の後、契機を重ねても消したタイルが新 DB に戻らない', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [...many(450), record('2_1_1')]);
    const ctx = startSw();
    await steps(ctx, 2);
    expect(await (await get(ctx, '/api/clean?mapID=a')).text()).toBe('Cleaned: a');
    await steps(ctx, 4);
    expect((await resourceOf(ctx, 'a'))!.count).toBe(0);
    expect(await oldCount(factory, 'a')).toBeUndefined();
    expect(await mapState(ctx, 'a')).toMatchObject({ status: 'done' });
    expect((await get(ctx, '/api/cache/a/2/1/1')).status).toBe(404);
    expect((await stateOf(ctx)).stage).toBe('done');
  });

  it('delete は Weiwudi_a を消し、maps から外す', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a'), setting('b')]);
    await makeTiles(factory, 'a', many(300));
    await makeTiles(factory, 'b', [record('2_1_1')]);
    const ctx = startSw();
    await steps(ctx, 2);
    expect(await (await get(ctx, '/api/delete?mapID=a')).text()).toBe('Deleted: a');
    expect(await oldCount(factory, 'a')).toBeUndefined();
    expect((await stateOf(ctx)).maps.map((m) => m.mapID)).toEqual(['b']);
    await steps(ctx, 2);
    expect(await entryOf(ctx, 'b', '2_1_1')).toBeDefined();
    expect((await stateOf(ctx)).stage).toBe('done');
  });

  /** Blob の arrayBuffer の最初の呼び出しを止める偽物 */
  const gateFirstConversion = () => {
    const original = Blob.prototype.arrayBuffer;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const spy = vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(async function (this: Blob) {
      calls++;
      if (calls === 1) await gate;
      return original.call(this);
    });
    return { release, started: () => calls > 0, spy };
  };

  it('バッチが arrayBuffer() の変換を待っている間の clean は、バッチの終わりを待ってから消し、変換の後に putEntry しない', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', many(10));
    const ctx = startSw();
    await step(ctx);
    const g = gateFirstConversion();
    const batch = step(ctx);
    await vi.waitFor(() => expect(g.started()).toBe(true));
    let cleaned = false;
    const clean = get(ctx, '/api/clean?mapID=a').then(async (r) => { cleaned = true; return r.text(); });
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
    expect(cleaned).toBe(false);
    g.release();
    await batch;
    expect(await clean).toBe('Cleaned: a');
    expect((await resourceOf(ctx, 'a'))!.count).toBe(0);
    expect(await entryOf(ctx, 'a', '1_0_0')).toBeUndefined();
    expect(await oldCount(factory, 'a')).toBeUndefined();
    await steps(ctx, 2);
    expect((await resourceOf(ctx, 'a'))!.count).toBe(0);
  });

  it('pullTile の最中の clean も、読み通しの終わりを待ってから消し、読み通しは書かない', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    const ctx = startSw();
    await step(ctx);
    const g = gateFirstConversion();
    const tile = get(ctx, '/api/cache/a/2/1/1');
    await vi.waitFor(() => expect(g.started()).toBe(true));
    let cleaned = false;
    const clean = get(ctx, '/api/clean?mapID=a').then(async (r) => { cleaned = true; return r.text(); });
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
    expect(cleaned).toBe(false);
    g.release();
    expect((await tile).status).toBe(404);
    expect(await clean).toBe('Cleaned: a');
    expect(await entryOf(ctx, 'a', '2_1_1')).toBeUndefined();
    expect(await oldCount(factory, 'a')).toBeUndefined();
  });
});

describe('戻して上げ直す・blocked・databases() の無い環境（R17・R59）', () => {
  it('done の後に旧 DB を作り直して SW を起動し直すと、最初の契機で databases() が見つけて移行をやり直す', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    const ctx = startSw();
    await steps(ctx, 2);
    expect((await stateOf(ctx)).stage).toBe('done');
    // 1.1.x に戻している間に作り直された旧 DB
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_2_2')]);
    const next = startSw();
    await step(next);
    expect((await stateOf(next)).stage).not.toBe('done');
    await step(next);
    expect(await entryOf(next, 'a', '2_2_2')).toBeDefined();
    expect((await stateOf(next)).stage).toBe('done');
    const left = await names(factory);
    expect(left).not.toContain('Weiwudi_a');
    expect(left).not.toContain('Weiwudi');
  });

  it('done の後に旧 DB が現れたとき、新しい SW の最初の旧 API の要求（契機より先）が map-not-found にならず、地図を移す', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    const ctx = startSw();
    await steps(ctx, 2);
    expect((await stateOf(ctx)).stage).toBe('done');
    // 1.1.x で新しく足された地図（sources に無い）
    await makeSettings(factory, [setting('b')]);
    await makeTiles(factory, 'b', [record('2_2_2')]);
    const next = startSw();
    // migrateStep（R59 の boot）を先に呼ばず、旧 API の要求を最初に受ける
    const res = await get(next, '/api/info?mapID=b');
    expect(await res.text()).not.toMatch(/not found/);
    expect(await (await next.store()).getSource('map:b')).toBeDefined();
    expect(next.maintenance.migrated).not.toBe(true);
    const tile = await get(next, '/api/cache/b/2/2/2');
    expect(tile.status).toBe(200);
    await steps(next, 2);
    expect((await stateOf(next)).stage).toBe('done');
    const left = await names(factory);
    expect(left).not.toContain('Weiwudi_b');
    expect(left).not.toContain('Weiwudi');
  });

  it('done の後に旧 DB が現れたとき、最初の要求と最初の契機が同時でも、やり直しの判定（boot）は 1 回だけ', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    const ctx = startSw();
    await steps(ctx, 2);
    await makeSettings(factory, [setting('b')]);
    await makeTiles(factory, 'b', [record('2_2_2')]);
    const next = startSw();
    const spy = vi.spyOn(indexedDB, 'databases');
    const [res] = await Promise.all([get(next, '/api/info?mapID=b'), step(next)]);
    expect(await res.text()).not.toMatch(/not found/);
    // boot の databases() は 1 回（copySettings の 1 回と合わせて 2 回まで）
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(next.maintenance.migrationBooted).toBe(true);
  });

  it('同じ名前の削除が待ちのまま返らなくても、新しい SW の最初の旧 API の要求は pendingDelete の消し直しを待たずに返る', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    const holder = await openRaw(factory, 'Weiwudi_a');
    const ctx = startSw();
    await steps(ctx, 2);
    expect((await stateOf(ctx)).pendingDelete).toContain('Weiwudi_a');
    holder.close();
    // 別の削除の後ろに並んだ deleteDatabase（success も blocked も来ない）
    const hung = vi.fn(() => ({}) as IDBOpenDBRequest);
    vi.stubGlobal('indexedDB', {
      open: factory.open.bind(factory),
      databases: factory.databases.bind(factory),
      cmp: factory.cmp.bind(factory),
      deleteDatabase: (name: string) => (name === 'Weiwudi_a' ? hung() : factory.deleteDatabase(name)),
    });
    const next = startSw();
    let stepSettled = false;
    void step(next).finally(() => { stepSettled = true; });
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000));
    const res = await Promise.race([get(next, '/api/info?mapID=a'), timeout]);
    expect(res).not.toBe('timeout');
    expect(await (res as Response).text()).not.toMatch(/not found/);
    expect(next.maintenance.migrationBooted).toBe(true);
    // 消し直しは契機の側だけが行う。返らない削除は上限（DELETE_WAIT_MS）で blocked として切り、pendingDelete に残す
    expect(hung).toHaveBeenCalled();
    expect(stepSettled).toBe(false);
    await vi.waitFor(() => expect(stepSettled).toBe(true), { timeout: DELETE_WAIT_MS + 1000 });
    expect(next.maintenance.pendingDeletesRetried).toBe(true);
    expect(next.maintenance.blockedDeletes?.has('Weiwudi_a')).toBe(true);
    expect((await stateOf(next)).pendingDelete).toContain('Weiwudi_a');
  }, DELETE_WAIT_MS + 5000);

  it('消し直しの削除が返らなくても、別の地図の旧 API の clean・delete は上限のうちに返り、契機も終わる（R51）', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a'), setting('b'), setting('c')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    await makeTiles(factory, 'b', [record('2_2_2')]);
    await makeTiles(factory, 'c', [record('2_3_3')]);
    const holder = await openRaw(factory, 'Weiwudi_a');
    const ctx = startSw();
    await steps(ctx, 2);
    expect((await stateOf(ctx)).pendingDelete).toContain('Weiwudi_a');
    holder.close();
    const hung = vi.fn(() => ({}) as IDBOpenDBRequest);
    vi.stubGlobal('indexedDB', {
      open: factory.open.bind(factory),
      databases: factory.databases.bind(factory),
      cmp: factory.cmp.bind(factory),
      deleteDatabase: (name: string) => (name === 'Weiwudi_a' ? hung() : factory.deleteDatabase(name)),
    });
    const next = startSw();
    let stepSettled = false;
    void step(next).finally(() => { stepSettled = true; });
    await vi.waitFor(() => expect(hung).toHaveBeenCalled());
    const t0 = Date.now();
    const limit = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), DELETE_WAIT_MS + 1500));
    const [clean, del] = await Promise.all([
      Promise.race([get(next, '/api/clean?mapID=b').then((r) => r.text()), limit]),
      Promise.race([get(next, '/api/delete?mapID=c').then((r) => r.text()), limit]),
    ]);
    expect(clean).toBe('Cleaned: b');
    expect(del).toBe('Deleted: c');
    expect(Date.now() - t0).toBeLessThan(DELETE_WAIT_MS + 1500);
    expect(stepSettled).toBe(true);
    expect(next.maintenance.migrating).toBeUndefined();
    expect(next.maintenance.pendingDeletesRetried).toBe(true);
    // 返らなかった名前だけが pendingDelete に残る（次の起動で消し直す）
    const st = await stateOf(next);
    expect(st.pendingDelete).toEqual(['Weiwudi_a']);
  }, DELETE_WAIT_MS + 5000);

  it('やり直し（R59）の第 1 段は pendingDelete の名前を開かず・消さず、前の削除が裏で並んだままでも最初の旧 API の要求が止まらない', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    // 閉じない接続で Weiwudi_a と Weiwudi の削除を待ちのまま残す（前の SW の削除が裏で並んでいる）
    const holders = [await openRaw(factory, 'Weiwudi_a'), await openRaw(factory, 'Weiwudi')];
    const ctx = startSw();
    await steps(ctx, 2);
    const done = await stateOf(ctx);
    expect(done.stage).toBe('done');
    expect(done.pendingDelete).toEqual(expect.arrayContaining(['Weiwudi_a', 'Weiwudi']));
    // 1.1.x に戻している間に作られた孤児の旧 DB（やり直しの契機）
    await makeTiles(factory, 'x', [record('2_1_1')]);
    const opened: string[] = [];
    const deleted: string[] = [];
    vi.stubGlobal('indexedDB', {
      open: (name: string, v?: number) => { opened.push(name); return factory.open(name, v); },
      databases: factory.databases.bind(factory),
      cmp: factory.cmp.bind(factory),
      deleteDatabase: (name: string) => { deleted.push(name); return factory.deleteDatabase(name); },
    });
    const next = startSw();
    const limit = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000));
    const res = await Promise.race([get(next, '/api/info?mapID=a'), limit]);
    expect(res).not.toBe('timeout');
    expect(await (res as Response).text()).not.toMatch(/not found/);
    expect(next.maintenance.settingsDone).toBe(true);
    // 孤児は消し、pendingDelete の名前は開きも消しもしない（消し直しに任せる）
    expect(deleted).toContain('Weiwudi_x');
    for (const n of ['Weiwudi', 'Weiwudi_a']) {
      expect(opened).not.toContain(n);
      expect(deleted).not.toContain(n);
    }
    const st = await stateOf(next);
    expect(st.pendingDelete).toEqual(expect.arrayContaining(['Weiwudi_a', 'Weiwudi']));
    expect(st.maps.find((x) => x.mapID === 'a')?.status ?? 'done').toBe('done');
    for (const h of holders) h.close();
  });

  it('起動後の点検の kvPut が 1 回失敗しても、旧 API の要求は readLegacySetting で補い、次の呼び出しで点検をやり直す（R51）', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    const ctx = startSw();
    await steps(ctx, 2);
    expect((await stateOf(ctx)).stage).toBe('done');
    await makeSettings(factory, [setting('b')]);
    await makeTiles(factory, 'b', [record('2_2_2')]);
    const next = startSw();
    const store = await next.store();
    const put = vi.spyOn(store, 'kvPut').mockRejectedValueOnce(new Error('kvPut failed'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const first = await get(next, '/api/info?mapID=b');
    expect(await first.text()).not.toMatch(/not found/);
    expect(put).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    expect(next.maintenance.migrationBooted).not.toBe(true);
    expect((await stateOf(next)).stage).toBe('done');
    expect(await store.getSource('map:b')).toBeUndefined();

    const second = await get(next, '/api/info?mapID=b');
    expect(await second.text()).not.toMatch(/not found/);
    expect(next.maintenance.migrationBooted).toBe(true);
    expect((await stateOf(next)).stage).not.toBe('done');
    expect(await store.getSource('map:b')).toBeDefined();
  });

  it('Weiwudi が pendingDelete にあり、その削除が並んでいる間に第 1 段が失敗しても、readLegacySetting は Weiwudi を開かずに上限のうちに返る（R51）', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    // 閉じない接続で Weiwudi の削除を待ちのまま残す
    const holder = await openRaw(factory, 'Weiwudi');
    const ctx = startSw();
    await steps(ctx, 2);
    expect((await stateOf(ctx)).pendingDelete).toContain('Weiwudi');
    // 1.1.x に戻している間に作られた孤児の旧 DB（やり直しの契機）
    await makeTiles(factory, 'x', [record('2_1_1')]);
    // Weiwudi の削除が並んでいて、開く要求も消す要求もその後ろに並んで返らない
    const opened: string[] = [];
    const hung = () => ({}) as IDBOpenDBRequest;
    vi.stubGlobal('indexedDB', {
      open: (name: string, v?: number) => { opened.push(name); return name === 'Weiwudi' ? hung() : factory.open(name, v); },
      databases: factory.databases.bind(factory),
      cmp: factory.cmp.bind(factory),
      deleteDatabase: (name: string) => (name === 'Weiwudi' ? hung() : factory.deleteDatabase(name)),
    });
    const next = startSw();
    const store = await next.store();
    // 起動後の点検の kvPut を 1 回落として第 1 段を失敗させ、getSetting を readLegacySetting の補いへ回す
    const put = vi.spyOn(store, 'kvPut').mockRejectedValueOnce(new Error('kvPut failed'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const limit = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000));
    const res = await Promise.race([get(next, '/api/info?mapID=b'), limit]);
    expect(res).not.toBe('timeout');
    expect(put).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
    expect(next.maintenance.settingsDone).not.toBe(true);
    expect(opened).not.toContain('Weiwudi');
    holder.close();
  });

  it('上限を過ぎて blocked とした削除に success が遅れて届くと、blockedDeletes から外れる（R51）', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    const holder = await openRaw(factory, 'Weiwudi_a');
    const ctx = startSw();
    await steps(ctx, 2);
    expect((await stateOf(ctx)).pendingDelete).toContain('Weiwudi_a');
    holder.close();
    // success も blocked も上限のうちに来ない削除（後から success を届ける）
    const late = {} as IDBOpenDBRequest;
    vi.stubGlobal('indexedDB', {
      open: factory.open.bind(factory),
      databases: factory.databases.bind(factory),
      cmp: factory.cmp.bind(factory),
      deleteDatabase: (name: string) => (name === 'Weiwudi_a' ? late : factory.deleteDatabase(name)),
    });
    const next = startSw();
    await step(next);
    expect(next.maintenance.blockedDeletes?.has('Weiwudi_a')).toBe(true);
    expect((await stateOf(next)).pendingDelete).toContain('Weiwudi_a');
    // 遅れて届いた success で印が外れる（pendingDelete は残り、次の起動で消し直す）
    (late.onsuccess as (ev: Event) => void)(new Event('success'));
    expect(next.maintenance.blockedDeletes?.has('Weiwudi_a')).toBe(false);
    expect((await stateOf(next)).pendingDelete).toContain('Weiwudi_a');
  }, DELETE_WAIT_MS + 5000);

  it('閉じない接続で deleteDatabase が blocked でも契機は終わり、pendingDelete に残り、次の SW の最初の契機で消える', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    const holder = await openRaw(factory, 'Weiwudi_a');
    const ctx = startSw();
    await steps(ctx, 2);
    const st = await stateOf(ctx);
    expect(st.stage).toBe('done');
    expect(st.pendingDelete).toContain('Weiwudi_a');
    expect(await names(factory)).not.toContain('Weiwudi');
    holder.close();
    const next = startSw();
    await step(next);
    expect((await stateOf(next)).pendingDelete).toEqual([]);
    expect(await names(factory)).not.toContain('Weiwudi_a');
  });

  it('indexedDB.databases が無い factory で、旧 DB が無ければ空で完了し、自分で作った Weiwudi が残らない', async () => {
    const factory = new IDBFactory();
    const noList = {
      open: factory.open.bind(factory),
      deleteDatabase: factory.deleteDatabase.bind(factory),
      cmp: factory.cmp.bind(factory),
    };
    setup(noList);
    const ctx = startSw();
    await step(ctx);
    // 旧 DB が無いので kv に書かずにメモリだけで完了する（R-t7-3）
    expect(ctx.maintenance.migrated).toBe(true);
    expect(await stateOf(ctx)).toBeUndefined();
    expect(await names(factory)).not.toContain('Weiwudi');
  });

  it('indexedDB.databases が無い factory でも、旧 DB があれば移す', async () => {
    const factory = new IDBFactory();
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    setup({
      open: factory.open.bind(factory),
      deleteDatabase: factory.deleteDatabase.bind(factory),
      cmp: factory.cmp.bind(factory),
    });
    const ctx = startSw();
    await steps(ctx, 2);
    expect(await entryOf(ctx, 'a', '2_1_1')).toBeDefined();
    expect((await stateOf(ctx)).stage).toBe('done');
    const left = await names(factory);
    expect(left).not.toContain('Weiwudi_a');
    expect(left).not.toContain('Weiwudi');
  });
});

describe('NUL を含む mapID（I7c・R19）', () => {
  it('移行では failed にして飛ばし、旧 DB にも残す', async () => {
    const factory = new IDBFactory();
    setup(factory);
    await makeSettings(factory, [setting('n\u0000x'), setting('a')]);
    await makeTiles(factory, 'n\u0000x', [record('2_1_1')]);
    await makeTiles(factory, 'a', [record('2_1_1')]);
    const ctx = startSw();
    await steps(ctx, 2);
    expect(await mapState(ctx, 'n\u0000x')).toMatchObject({ status: 'failed' });
    expect(await (await ctx.store()).getSource('map:n\u0000x')).toBeUndefined();
    expect(await entryOf(ctx, 'a', '2_1_1')).toBeDefined();
    expect((await stateOf(ctx)).stage).toBe('done');
    expect(await oldCount(factory, 'n\u0000x')).toBe(1);
  });
});

describe('配線（runMaintenance の migrateStep）', () => {
  it('旧 API の要求の契機（waitUntil）で移行が進み、activate は待たない', async () => {
    const factory = new IDBFactory();
    await makeSettings(factory, [setting('a')]);
    await makeTiles(factory, 'a', many(5));
    const h = createSwHarness({ factory });
    const client = { id: 'client-1', postMessage: vi.fn() };
    for (let i = 0; i < 3; i++) {
      await h.requestFromClient('/api/info?mapID=a', client);
      await Promise.all(h.waitUntilCalls);
    }
    const store = await openStore();
    try {
      expect(await store.getResource('map:a')).toMatchObject({ count: 5 });
      expect(((await store.kvGet('migration')) as MigrationState).stage).toBe('done');
    } finally {
      store.close();
    }
    expect(await names(factory)).not.toContain('Weiwudi_a');
  });
});
