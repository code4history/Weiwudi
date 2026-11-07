// m4-t2・仕様 §7.1: 実物の store/core と SW の dispatch で保持期間の掃除を確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import * as contexts from '../../src/context';
import * as core from '../../src/core';
import type { Context, JobState } from '../../src/context';
import type { EntryMeta, ResourceMeta, Store } from '../../src/store';
import { createSwHarness } from './sw-harness';

const NOW = 1_000_000;
let ctx: Context;
let store: Store;
const opened: Store[] = [];
const key = (id: string, suffix: string) => `${id}\0${suffix}`;
const resource = (id: string, retention?: number, type: ResourceMeta['type'] = 'tile'): ResourceMeta => ({
  id, type, templates: [], sourceIds: [id], count: 0, bytes: 0, pinnedBytes: 0,
  policy: { cacheTtl: 100, cacheRetention: retention, store: true,
    outOfRange: { extent: 'transparent', zoom: 'transparent' }, credentialParams: [] },
});
const seed = async (id: string, suffix: string, fetchedAt = NOW - 101, pinned: 0 | 1 = 0) => {
  const meta: EntryMeta = { key: key(id, suffix), resourceId: id, size: 3,
    fetchedAt, accessedAt: fetchedAt, pinned, contentType: 'image/png' };
  await store.putEntry(meta, { key: meta.key, blob: new Blob(['abc']), headers: {} }, []);
  return meta;
};
const job = (): JobState => ({ sourceId: 'r', label: 'r', total: 1, count: 0, error: 0,
  failures: { network: 0, upstream: 0, quota: 0, storage: 0 }, cancel: false });

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  ctx = contexts.createContext();
  store = await ctx.store();
  opened.push(store);
});
afterEach(async () => {
  for (const s of opened.splice(0)) s.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sweepOnce', () => {
  it('Resource ごとの期限で削除し、期限なし・期限境界・固定を残して count/bytes を合わせる', async () => {
    for (const r of [resource('r', 100), resource('forever'), resource('long', 200)]) {
      await store.createResource(r);
      await store.putSource({ id: r.id, kind: 'legacy', spec: {}, order: 0, createdAt: 0, warnings: [] });
    }
    await seed('r', 'fresh', NOW - 99);
    await seed('r', 'boundary', NOW - 100);
    await seed('r', 'expired1');
    await seed('r', 'expired2', NOW - 500);
    await seed('r', 'pin', NOW - 500, 1);
    await seed('forever', 'old', 1);
    await seed('long', 'fresh', NOW - 150);
    await seed('long', 'expired', NOW - 201);
    await core.sweepOnce(ctx);
    expect((await store.entriesOf('r', 100)).metas.map(m => m.key)).toEqual(['boundary', 'fresh', 'pin'].map(s => key('r', s)));
    expect(await store.getResource('r')).toMatchObject({ count: 3, bytes: 9, pinnedBytes: 3 });
    expect(await store.getResource('forever')).toMatchObject({ count: 1, bytes: 3 });
    expect(await store.getResource('long')).toMatchObject({ count: 1, bytes: 3 });
  });

  it('一度終えたら走査せず、force では再び走査する', async () => {
    await store.createResource(resource('r', 100));
    const scan = vi.spyOn(store, 'listResources');
    await core.sweepOnce(ctx);
    await seed('r', 'late');
    await core.sweepOnce(ctx);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(await store.getEntry(key('r', 'late'))).toBeDefined();
    await core.sweepOnce(ctx, { force: true });
    expect(scan).toHaveBeenCalledTimes(2);
    expect(await store.getEntry(key('r', 'late'))).toBeUndefined();
    expect(ctx.maintenance.swept).toBe(true);
  });

  it('保持期間がなければメタ・本体を走査しない', async () => {
    await store.createResource(resource('forever'));
    const list = vi.spyOn(store, 'listUnpinnedBefore');
    const entries = vi.spyOn(store, 'entriesOf');
    const read = vi.spyOn(store, 'getEntry');
    await core.sweepOnce(ctx);
    expect(list).not.toHaveBeenCalled();
    expect(entries).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(ctx.maintenance.swept).toBe(true);
  });

  it('グリフは新しいレコードの古い部分も詰め直し、全期限切れは削除、固定はそのまま', async () => {
    await store.createResource(resource('g', 100, 'glyph'));
    for (const [suffix, newest, pinned] of [['mixed', NOW - 10, 0], ['old', NOW - 101, 0], ['pin', NOW - 101, 1]] as const) {
      const meta = await seed('g', suffix, newest, pinned);
      await store.putGlyphParts(meta, [
        { part: '0-255', blob: new Blob(['old']), fetchedAt: NOW - 500 },
        { part: '256-511', blob: new Blob(['new!']), fetchedAt: newest },
      ], {}, []);
    }
    const prune = vi.spyOn(store, 'pruneGlyphParts');
    const read = vi.spyOn(store, 'getEntry');
    await core.sweepOnce(ctx);
    expect(read).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalledWith(key('g', 'pin'), expect.anything());
    const mixed = await store.getEntry(key('g', 'mixed'));
    expect(mixed?.meta.size).toBe(4);
    expect(Object.keys(mixed!.body.parts!)).toEqual(['256-511']);
    expect(await mixed?.body.blob.text()).toBe('new!');
    expect(await store.getEntry(key('g', 'old'))).toBeUndefined();
    expect((await store.getEntry(key('g', 'pin')))?.meta.size).toBe(7);
    expect(await store.getResource('g')).toMatchObject({ count: 2, bytes: 11, pinnedBytes: 7 });
  });

  it('2001 件は 2000 件で区切り、同じ fetchedAt の next をそのまま渡して残りを消す', async () => {
    await store.createResource(resource('r', 100));
    for (let i = 0; i < 2001; i++) await seed('r', String(i).padStart(4, '0'));
    const scan = vi.spyOn(store, 'listUnpinnedBefore');
    await core.sweepOnce(ctx);
    expect(await store.getResource('r')).toMatchObject({ count: 1, bytes: 3 });
    expect(ctx.maintenance.swept).toBe(false);
    expect(scan).toHaveBeenCalledTimes(10);
    for (let i = 1; i < scan.mock.calls.length; i++) {
      expect(scan.mock.calls[i][2]).toBe((await scan.mock.results[i - 1].value).next);
    }
    const continuation = (await scan.mock.results[9].value).next;
    await core.sweepOnce(ctx);
    expect(scan.mock.calls[10][2]).toBe(continuation);
    expect(await store.getResource('r')).toMatchObject({ count: 0, bytes: 0 });
    expect(ctx.maintenance.swept).toBe(true);
  }, 30_000);

  it('期限なしの古い Entry も訪問上限に数え、続きを進めてグリフも掃除する', async () => {
    for (const r of [resource('r', 100), resource('forever'), resource('g', 100, 'glyph')]) await store.createResource(r);
    for (let i = 0; i < 2000; i++) await seed('forever', String(i).padStart(4, '0'));
    const meta = await seed('g', 'font', NOW - 10);
    await store.putGlyphParts(meta, [
      { part: '0-255', blob: new Blob(['old']), fetchedAt: NOW - 500 },
      { part: '256-511', blob: new Blob(['new']), fetchedAt: NOW - 10 },
    ], {}, []);
    const prune = vi.spyOn(store, 'pruneGlyphParts');
    await core.sweepOnce(ctx);
    expect(prune).not.toHaveBeenCalled();
    await core.sweepOnce(ctx, { force: true });
    expect(prune).toHaveBeenCalledTimes(1);
    expect(await store.getResource('forever')).toMatchObject({ count: 2000 });
    expect((await store.getEntry(meta.key))?.meta.size).toBe(3);
  }, 30_000);

  it.each(['refresh', 'pin'] as const)('一覧の後の %s を削除 tx の条件で守る', async (change) => {
    await store.createResource(resource('r', 100));
    await seed('r', 'race');
    const original = store.listUnpinnedBefore;
    vi.spyOn(store, 'listUnpinnedBefore').mockImplementationOnce(async (...args) => {
      const page = await original(...args);
      if (change === 'refresh') await seed('r', 'race', NOW);
      else await store.setPinned([key('r', 'race')], 1);
      return page;
    });
    const remove = vi.spyOn(store, 'deleteEntries');
    await core.sweepOnce(ctx);
    expect(remove).toHaveBeenCalledWith([key('r', 'race')], { unpinnedOnly: true, fetchedBefore: NOW - 100 });
    expect(await store.getEntry(key('r', 'race'))).toBeDefined();
  });

  it('索引とグリフの訪問数を合算し、グリフのページ途中から再開する', async () => {
    for (const r of [resource('r', 100), resource('forever'), resource('g', 100, 'glyph')]) await store.createResource(r);
    for (let i = 0; i < 1999; i++) await seed('forever', String(i).padStart(4, '0'));
    for (let i = 0; i < 202; i++) {
      const meta = await seed('g', String(i).padStart(4, '0'), NOW - 10);
      await store.putGlyphParts(meta, [
        { part: '0-255', blob: new Blob(['old']), fetchedAt: NOW - 500 },
        { part: '256-511', blob: new Blob(['new']), fetchedAt: NOW - 10 },
      ], {}, []);
    }
    const pages = vi.spyOn(store, 'entriesOf');
    const prune = vi.spyOn(store, 'pruneGlyphParts');
    await core.sweepOnce(ctx);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(pages.mock.calls[0][1]).toBe(1);
    expect(ctx.maintenance.swept).toBe(false);
    const next = (await pages.mock.results[0].value).next;
    await core.sweepOnce(ctx);
    expect(pages.mock.calls[1]).toEqual(['g', 200, next]);
    expect(prune).toHaveBeenCalledTimes(202);
    expect(await store.getResource('g')).toMatchObject({ count: 202, bytes: 606 });
    expect(ctx.maintenance.swept).toBe(true);
  }, 30_000);

  it('走査中に job が始まると削除を止め、終了後に同じページをやり直す', async () => {
    await store.createResource(resource('r', 100));
    await seed('r', 'old');
    const original = store.listUnpinnedBefore;
    vi.spyOn(store, 'listUnpinnedBefore').mockImplementationOnce(async (...args) => {
      const page = await original(...args);
      ctx.job = job();
      return page;
    });
    await core.sweepOnce(ctx);
    expect(await store.getEntry(key('r', 'old'))).toBeDefined();
    expect(ctx.maintenance.swept).toBe(false);
    ctx.job = undefined;
    await core.sweepOnce(ctx, { force: true });
    expect(await store.getEntry(key('r', 'old'))).toBeUndefined();
  });

  it('保守と force が同時でも掃除の Promise を共有する', async () => {
    await store.createResource(resource('r', 100));
    await seed('r', 'old');
    const original = store.listResources;
    let resolve!: (r: ResourceMeta[]) => void;
    const scan = vi.spyOn(store, 'listResources').mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const first = core.sweepOnce(ctx);
    const forced = core.sweepOnce(ctx, { force: true });
    expect(first).toBe(forced);
    await Promise.resolve();
    resolve(await original());
    await Promise.all([first, forced]);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(await store.getEntry(key('r', 'old'))).toBeUndefined();
  });

  it('job 中は force でも走査せず、終了後に掃除する', async () => {
    await store.createResource(resource('r', 100));
    await seed('r', 'old');
    ctx.job = job();
    const scan = vi.spyOn(store, 'listResources');
    await core.sweepOnce(ctx);
    await core.sweepOnce(ctx, { force: true });
    expect(scan).not.toHaveBeenCalled();
    expect(ctx.maintenance.swept).toBe(false);
    ctx.job = undefined;
    await core.sweepOnce(ctx, { force: true });
    expect(await store.getEntry(key('r', 'old'))).toBeUndefined();
  });
});

const harnessContext = () => {
  const create = contexts.createContext;
  let captured!: Context;
  vi.spyOn(contexts, 'createContext').mockImplementation((...args) => (captured = create(...args)));
  const h = createSwHarness();
  return { h, captured };
};
const addMap = (h: ReturnType<typeof createSwHarness>) => h.request('/api/add?mapID=x&type=xyz&url=https://tile.example/{z}/{x}/{y}.png&width=256&height=256');

describe('保守の契機（R9）', () => {
  it('info の dispatch は waitUntil に結び付き、掃除は起動後 1 回だけ', async () => {
    const { h, captured } = harnessContext();
    await addMap(h);
    opened.push(await captured.store());
    const sweep = vi.spyOn(core, 'sweepOnce');
    for (let i = 0; i < 2; i++) {
      expect((await h.dispatch('https://weiwudi.example.com/api/info?mapID=x'))?.status).toBe(200);
      await Promise.all(h.waitUntilCalls);
    }
    expect(h.waitUntilCalls).toHaveLength(2);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('ping は waitUntil も IndexedDB.open も増やさない', async () => {
    const h = createSwHarness();
    const open = vi.spyOn(h.factory, 'open');
    await h.dispatch('https://weiwudi.example.com/api/ping');
    await h.dispatch('https://weiwudi.example.com/v2/ping');
    expect(h.waitUntilCalls).toHaveLength(0);
    expect(open).not.toHaveBeenCalled();
  });

  it('waitUntil が無い直接呼び出しは保守を開始しない', async () => {
    const { h, captured } = harnessContext();
    await addMap(h);
    opened.push(await captured.store());
    const sweep = vi.spyOn(core, 'sweepOnce');
    await h.request('/api/info?mapID=x');
    await h.dispatch('https://weiwudi.example.com/api/info?mapID=x', { event: {} });
    expect(sweep).not.toHaveBeenCalled();
    expect(h.waitUntilCalls).toHaveLength(0);
  });

  it('同時の契機は進行中の Promise を共有する', async () => {
    const { h, captured } = harnessContext();
    await addMap(h);
    const s = await captured.store();
    opened.push(s);
    const original = s.listResources;
    let resolve!: (r: ResourceMeta[]) => void;
    const scan = vi.spyOn(s, 'listResources').mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await h.dispatch('https://weiwudi.example.com/api/info?mapID=x');
    await h.dispatch('https://weiwudi.example.com/api/info?mapID=x');
    expect(scan).toHaveBeenCalledTimes(1);
    expect(h.waitUntilCalls).toHaveLength(2);
    expect(h.waitUntilCalls[0]).toBe(h.waitUntilCalls[1]);
    resolve(await original());
    await Promise.all(h.waitUntilCalls);
    expect(captured.maintenance.running).toBeUndefined();
  });

  it('保守失敗は console.error 1 回に留め、配信を変えず次の契機でやり直す', async () => {
    const { h, captured } = harnessContext();
    await addMap(h);
    const s = await captured.store();
    opened.push(s);
    const before = await (await h.request('/api/info?mapID=x')).text();
    vi.spyOn(s, 'listResources').mockRejectedValueOnce(new Error('maintenance failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await (await h.dispatch('https://weiwudi.example.com/api/info?mapID=x'))!.text()).toBe(before);
    await Promise.all(h.waitUntilCalls);
    expect(error).toHaveBeenCalledTimes(1);
    expect(captured.maintenance.swept).toBe(false);
    await h.dispatch('https://weiwudi.example.com/api/info?mapID=x');
    await Promise.all(h.waitUntilCalls);
    expect(captured.maintenance.swept).toBe(true);
  });

  it('fetchAll の waitUntil はジョブ 1 つだけで、終了後に force の掃除をする', async () => {
    const { h, captured } = harnessContext();
    await addMap(h);
    opened.push(await captured.store());
    captured.maintenance.swept = true;
    h.fetch.mockImplementation(async () => new Response('tile'));
    const client = { id: 'client-1', postMessage: vi.fn() };
    h.self.clients.get.mockResolvedValue(client);
    const sweep = vi.spyOn(core, 'sweepOnce');
    const res = await h.requestFromClient('/api/fetchAll?mapID=x', client);
    expect(await res.text()).toBe('Fetching task start: x');
    expect(h.waitUntilCalls).toHaveLength(1);
    await h.waitUntilCalls[0];
    expect(sweep).toHaveBeenCalledWith(captured, { force: true });
    expect(captured.job).toBeUndefined();
  });
});
