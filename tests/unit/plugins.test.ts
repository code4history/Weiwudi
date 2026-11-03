// 差し込み口（src/plugins.ts と core.serve の呼び出し）の試験（m2-t4・#36・仕様 §8）。
// 計画 docs/superpowers/plans/2026-11-03-m2-core.md の m2-t4。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { addPlugin, getPlugins, _resetPluginsForTest, type WeiwudiPlugin } from '../../src/plugins';
import { createContext, type Context } from '../../src/context';
import { serve, type ServeInput, type UpstreamResult } from '../../src/core';
import type { ResourceMeta, Store } from '../../src/store';
import { createSwHarness } from './sw-harness';

const T = 1_000_000_000;
const TTL = 60_000;
const RID = 'https://t.example/{z}/{x}/{y}.png';
const KEY = `${RID}\u00001_0_0`;

let ctx: Context;
let store: Store;

const resource: ResourceMeta = {
  id: RID,
  type: 'tile',
  templates: [RID],
  sourceIds: ['s1'],
  policy: { cacheTtl: TTL, store: true, outOfRange: { extent: 'transparent', zoom: 'transparent' }, credentialParams: [] },
  corsOk: true,
  corslessUntil: T - 1,
  rangeOnlySourceIds: ['s1'],
  count: 0,
  bytes: 0,
  pinnedBytes: 0,
};

type Up = ServeInput['upstream'];

const ok = (text = 'up'): UpstreamResult => ({ kind: 'response', response: new Response(text, { status: 200, headers: { 'content-type': 'image/png' } }) });

const run = (over: Partial<ServeInput> = {}, at = T) => serve(ctx, {
  resourceId: RID,
  key: KEY,
  coord: { z: 1, x: 0, y: 0 },
  request: new Request('https://t.example/1/0/0.png'),
  upstream: vi.fn<Up>(async () => ok()),
  storable: true,
  ...over,
}, () => at);

const seedFresh = async (text = 'cached') => {
  const blob = new Blob([text]);
  await store.putEntry(
    { key: KEY, resourceId: RID, size: blob.size, fetchedAt: T, accessedAt: T, pinned: 0 },
    { key: KEY, blob, headers: { 'content-type': 'image/png' } },
    [],
  );
};

beforeEach(async () => {
  _resetPluginsForTest();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  ctx = createContext();
  store = await ctx.store();
  await store.createResource(resource);
});

afterEach(() => {
  store.close();
  _resetPluginsForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 全フックを記録するプラグイン */
const recorder = (name: string, log: string[]): WeiwudiPlugin => ({
  requestWillFetch: async () => { log.push(`${name}.requestWillFetch`); },
  fetchDidSucceed: async () => { log.push(`${name}.fetchDidSucceed`); },
  fetchDidFail: async () => { log.push(`${name}.fetchDidFail`); },
  cacheWillUpdate: async () => { log.push(`${name}.cacheWillUpdate`); },
  cachedResponseWillBeUsed: async () => { log.push(`${name}.cachedResponseWillBeUsed`); },
});

describe('登録表', () => {
  it('登録順の写しを返す（写しを変えても登録表は変わらない）', () => {
    const a = {};
    const b = {};
    addPlugin(a);
    addPlugin(b);
    const list = getPlugins();
    expect(list).toEqual([a, b]);
    (list as WeiwudiPlugin[]).pop();
    expect(getPlugins()).toEqual([a, b]);
  });

  it('同じオブジェクトの 2 回目の addPlugin は無視する（フックは 1 回だけ。第 2 回 D4）', async () => {
    const p = { fetchDidSucceed: vi.fn(async () => undefined) };
    addPlugin(p);
    addPlugin(p);
    expect(getPlugins()).toHaveLength(1);
    await run();
    expect(p.fetchDidSucceed).toHaveBeenCalledTimes(1);
  });

  it('object でない値は TypeError', () => {
    expect(() => addPlugin(null as unknown as WeiwudiPlugin)).toThrow(TypeError);
    expect(() => addPlugin('x' as unknown as WeiwudiPlugin)).toThrow(TypeError);
    expect(getPlugins()).toHaveLength(0);
  });

  it('createSwHarness が登録表を空にする', () => {
    addPlugin({});
    createSwHarness();
    expect(getPlugins()).toHaveLength(0);
  });
});

describe('5 つのフックの順', () => {
  it('miss: requestWillFetch → fetchDidSucceed → cacheWillUpdate を登録順に', async () => {
    const log: string[] = [];
    addPlugin(recorder('a', log));
    addPlugin(recorder('b', log));
    await run();
    expect(log).toEqual([
      'a.requestWillFetch', 'b.requestWillFetch',
      'a.fetchDidSucceed', 'b.fetchDidSucceed',
      'a.cacheWillUpdate', 'b.cacheWillUpdate',
    ]);
  });

  it('hit: cachedResponseWillBeUsed だけ', async () => {
    await seedFresh();
    const log: string[] = [];
    addPlugin(recorder('a', log));
    await run();
    expect(log).toEqual(['a.cachedResponseWillBeUsed']);
  });

  it('ネットワーク失敗: requestWillFetch → fetchDidFail（Entry があれば cachedResponseWillBeUsed）', async () => {
    await seedFresh();
    const log: string[] = [];
    addPlugin(recorder('a', log));
    await run({ upstream: async () => ({ kind: 'network', error: new TypeError('x') }) }, T + TTL + 1);
    expect(log).toEqual(['a.requestWillFetch', 'a.fetchDidFail', 'a.cachedResponseWillBeUsed']);
  });

  it('保存しない応答（storable が偽・HTTP の失敗）では cacheWillUpdate を呼ばない', async () => {
    const log: string[] = [];
    addPlugin(recorder('a', log));
    await run({ storable: false });
    await run({ upstream: async () => ({ kind: 'response', response: new Response('', { status: 500 }) }) });
    expect(log.filter((l) => l.endsWith('cacheWillUpdate'))).toEqual([]);
  });
});

describe('差し替え', () => {
  it('requestWillFetch が別の Request を返すと、次のプラグインと upstream はそれを受け、requestChanged が真', async () => {
    const replaced = new Request('https://mirror.example/1/0/0.png');
    const seen: string[] = [];
    addPlugin({ requestWillFetch: async () => replaced });
    addPlugin({ requestWillFetch: async ({ request }) => { seen.push(request.url); } });
    const upstream = vi.fn<Up>(async () => ok());
    await run({ upstream });
    expect(seen).toEqual([replaced.url]);
    expect(upstream.mock.calls[0][0]).toBe(replaced);
    expect(upstream.mock.calls[0][1].requestChanged).toBe(true);
  });

  it('requestWillFetch が同じ Request を返す・何も返さないなら requestChanged は偽', async () => {
    addPlugin({ requestWillFetch: async ({ request }) => request });
    addPlugin({ requestWillFetch: async () => undefined });
    const upstream = vi.fn<Up>(async () => ok());
    await run({ upstream });
    expect(upstream.mock.calls[0][1].requestChanged).toBe(false);
  });

  it('fetchDidSucceed が返した Response を配信・保存に使う', async () => {
    addPlugin({ fetchDidSucceed: async () => new Response('changed', { status: 200, headers: { 'content-type': 'image/webp' } }) });
    const res = await run();
    expect(await res.text()).toBe('changed');
    expect((await store.getEntry(KEY))?.meta.contentType).toBe('image/webp');
  });

  it('fetchDidSucceed が失敗の応答を成功に替えれば成功として扱う', async () => {
    addPlugin({ fetchDidSucceed: async () => new Response('fixed', { status: 200 }) });
    const res = await run({ upstream: async () => ({ kind: 'response', response: new Response('', { status: 500 }) }) });
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
  });

  it('cacheWillUpdate が返した Response を保存し、配信は元の応答', async () => {
    addPlugin({ cacheWillUpdate: async () => new Response('stored') });
    const res = await run({ upstream: async () => ok('served-body') });
    expect(await res.text()).toBe('served-body');
    const saved = await store.getEntry(KEY);
    expect(await saved?.body.blob.text()).toBe('stored');
    // 大きさは保存した本体のもの（配信の本体のものではない）
    expect(saved?.meta.size).toBe(6);
    expect((await store.getResource(RID))?.bytes).toBe(6);
  });

  it('cachedResponseWillBeUsed が返した Response を配信する（hit のヘッダは付く）', async () => {
    await seedFresh();
    addPlugin({ cachedResponseWillBeUsed: async () => new Response('other', { headers: { 'x-p': '1' } }) });
    const res = await run();
    expect(await res.text()).toBe('other');
    expect(res.headers.get('x-p')).toBe('1');
    expect(res.headers.get('x-weiwudi-status')).toBe('hit');
  });
});

describe('null の 2 種', () => {
  it('cacheWillUpdate の null で保存しない（配信は miss）', async () => {
    addPlugin({ cacheWillUpdate: async () => null });
    const res = await run();
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    // 保存しないのは意図どおりで、保存の失敗ではない
    expect(res.headers.get('x-weiwudi-error')).toBeNull();
    expect(await store.getEntry(KEY)).toBeUndefined();
  });

  it('cachedResponseWillBeUsed の null で「Entry が無い」として上流へ（hasEntry は偽）', async () => {
    await seedFresh();
    addPlugin({ cachedResponseWillBeUsed: async () => null });
    const upstream = vi.fn<Up>(async () => ok('fresh'));
    const res = await run({ upstream });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][1].hasEntry).toBe(false);
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(await res.text()).toBe('fresh');
  });

  it('stale の場面で cachedResponseWillBeUsed が null なら Entry なしの応答（offline-miss）', async () => {
    await seedFresh();
    addPlugin({ cachedResponseWillBeUsed: async () => null });
    const res = await run({ upstream: async () => ({ kind: 'network', error: 1 }) }, T + TTL + 1);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-weiwudi-status')).toBe('offline-miss');
  });
});

describe('例外', () => {
  it('フックの例外は console.error に残し、そのプラグインを飛ばして続ける', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const after = vi.fn(async () => undefined);
    addPlugin({ requestWillFetch: async () => { throw new Error('bad plugin'); } });
    addPlugin({ requestWillFetch: after });
    addPlugin({ cacheWillUpdate: () => { throw new Error('sync throw'); } });
    const res = await run();
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(after).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(2);
    expect(await store.getEntry(KEY)).toBeDefined();
  });

  it('fetchDidFail の例外も配信を止めない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    addPlugin({ fetchDidFail: async () => { throw new Error('x'); } });
    const res = await run({ upstream: async () => ({ kind: 'network', error: 1 }) });
    expect(res.headers.get('x-weiwudi-status')).toBe('offline-miss');
  });
});

describe('渡すもの', () => {
  it('resource は ResourceInfo だけ（corsOk・policy などの保存の項目が無い。rangeOnly も出さない）', async () => {
    const got: unknown[] = [];
    addPlugin({
      requestWillFetch: async ({ resource: r }) => { got.push(r); },
      cacheWillUpdate: async ({ resource: r }) => { got.push(r); },
    });
    await run();
    expect(got).toHaveLength(2);
    for (const r of got) {
      expect(Object.keys(r as object).sort()).toEqual(['bytes', 'count', 'id', 'templates', 'type']);
      expect(r).toMatchObject({ id: RID, type: 'tile', templates: [RID] });
    }
  });

  it('corslessUntil が今より先なら corsless: true', async () => {
    await store.patchResource(RID, (m) => ({ ...m, corslessUntil: T + 1 }));
    let seen: unknown;
    addPlugin({ requestWillFetch: async ({ resource: r }) => { seen = r; } });
    await run();
    expect(seen).toMatchObject({ corsless: true });
  });

  it('state はプラグインごと・要求ごとに新しい object（同じ要求のフックの間では共有）', async () => {
    const states: Record<string, unknown[]> = { a: [], b: [] };
    const mk = (name: 'a' | 'b'): WeiwudiPlugin => ({
      requestWillFetch: async ({ state }) => { states[name].push(state); },
      fetchDidSucceed: async ({ state }) => { states[name].push(state); },
    });
    addPlugin(mk('a'));
    addPlugin(mk('b'));
    await run({ key: `${RID}\u00001_0_0` });
    await run({ key: `${RID}\u00001_1_0`, coord: { z: 1, x: 1, y: 0 } });
    const [a1, a1b, a2] = states.a;
    expect(a1).toEqual({});
    expect(a1b).toBe(a1);
    expect(a2).not.toBe(a1);
    expect(states.b[0]).not.toBe(a1);
  });

  it('fetchDidFail に error、fetchDidSucceed に上流の response が渡る（L1 m5）', async () => {
    const err = new TypeError('offline');
    let gotErr: unknown;
    addPlugin({ fetchDidFail: async ({ error }) => { gotErr = error; } });
    await run({ upstream: async () => ({ kind: 'network', error: err }) });
    expect(gotErr).toBe(err);
    const upstreamResponse = new Response('up', { status: 200, headers: { 'content-type': 'image/png' } });
    let gotResponse: unknown;
    addPlugin({ fetchDidSucceed: async ({ response }) => { gotResponse = response; } });
    await run({ key: `${RID}\u00001_1_0`, coord: { z: 1, x: 1, y: 0 }, upstream: async () => ({ kind: 'response', response: upstreamResponse }) });
    expect(gotResponse).toBe(upstreamResponse);
  });
});

describe('レビューの指摘（PR #75）', () => {
  it('fetchDidSucceed が本体を読んで何も返さなくても配信を続け、読む前の応答に戻して console.error に残す（L1 m1）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    addPlugin({ fetchDidSucceed: async ({ response }) => { await response.text(); } });
    const res = await run({ upstream: async () => ok('body-kept') });
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(await res.text()).toBe('body-kept');
    expect(await (await store.getEntry(KEY))?.body.blob.text()).toBe('body-kept');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('fetchDidSucceed が読み終えた Response を返しても、読む前の応答に戻す', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    addPlugin({ fetchDidSucceed: async ({ response }) => { await response.arrayBuffer(); return response; } });
    const res = await run({ upstream: async () => ok('body-kept') });
    expect(await res.text()).toBe('body-kept');
  });

  it('hit で cachedResponseWillBeUsed が null でも、保存し直す Entry は保存済みの pinned を引き継ぐ（L1 m2）', async () => {
    const blob = new Blob(['cached']);
    await store.putEntry(
      { key: KEY, resourceId: RID, size: blob.size, fetchedAt: T, accessedAt: T, pinned: 1 },
      { key: KEY, blob, headers: { 'content-type': 'image/png' } },
      [],
    );
    addPlugin({ cachedResponseWillBeUsed: async () => null });
    const res = await run({ upstream: async () => ok('fresh') });
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    const saved = await store.getEntry(KEY);
    expect(await saved?.body.blob.text()).toBe('fresh');
    expect(saved?.meta.pinned).toBe(1);
  });

  it('cacheWillUpdate が返した Response の本体が読めなければ、保存の失敗（storage）として配信を続ける（L2 推奨）', async () => {
    const used = new Response('used');
    await used.text();
    addPlugin({ cacheWillUpdate: async () => used });
    const res = await run({ upstream: async () => ok('served') });
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(res.headers.get('x-weiwudi-error')).toBe('storage');
    expect(await res.text()).toBe('served');
    expect(await store.getEntry(KEY)).toBeUndefined();
  });
});

describe('処理中の addPlugin（第 3 回 推奨）', () => {
  it('処理中の要求には効かず、次の要求から効く', async () => {
    const early = vi.fn(async () => undefined);
    const late = { fetchDidSucceed: vi.fn(async () => undefined) };
    addPlugin({ fetchDidSucceed: early });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = run({ upstream: async () => { await gate; return ok(); } });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    addPlugin(late);
    release();
    await first;
    expect(early).toHaveBeenCalledTimes(1);
    expect(late.fetchDidSucceed).not.toHaveBeenCalled();
    await run({ key: `${RID}\u00001_1_0`, coord: { z: 1, x: 1, y: 0 } });
    expect(late.fetchDidSucceed).toHaveBeenCalledTimes(1);
  });
});
