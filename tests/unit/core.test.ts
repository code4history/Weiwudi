// src/core.ts の試験（m2-t4・仕様 §6・§7.1・§4.6）。fake-indexeddb の上の実物の store.ts で確かめる。
// 計画 docs/superpowers/plans/2026-11-03-m2-core.md の m2-t4。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createContext, type Context } from '../../src/context';
import {
  serve, evictScopesFor, runJob, TRANSPARENT_PNG,
  type ServeInput, type UpstreamResult,
} from '../../src/core';
import type { EntryMeta, ResourceMeta, ResourcePolicy, SourceRecord, Store } from '../../src/store';
import type { StoredSpec } from '../../src/spec';
import { opaqueResponse } from './sw-harness';
import { addPlugin, _resetPluginsForTest } from '../../src/plugins';

// ---- 公開の契約（仕様 §6）。値を増やすときは minor で文書に足す ----
const STATUSES = ['out-of-range', 'hit', 'miss', 'refresh', 'stale', 'upstream-error', 'offline-miss'];
const ERRORS = ['network', 'upstream', 'quota', 'storage'];
const EXPOSE = 'x-weiwudi-status, x-weiwudi-error';
const DROPPED = ['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie'];

const T = 1_000_000_000;
const TTL = 60_000;
const RID = 'https://t.example/{z}/{x}/{y}.png';
const k = (suffix: string) => `${RID}\0${suffix}`;

let ctx: Context;
let store: Store;

const POLICY: ResourcePolicy = {
  cacheTtl: TTL,
  store: true,
  outOfRange: { extent: 'transparent', zoom: 'transparent' },
  credentialParams: ['access_token'],
};

const resource = (over: Partial<ResourceMeta> = {}): ResourceMeta => ({
  id: RID,
  type: 'tile',
  templates: [RID],
  sourceIds: ['s1'],
  policy: POLICY,
  count: 0,
  bytes: 0,
  pinnedBytes: 0,
  ...over,
});

const sourceRecord = (id: string, cacheMaxBytes?: number, legacy = false): SourceRecord => ({
  id,
  kind: legacy ? 'legacy' : 'raster',
  spec: legacy ? {} : ({ kind: 'raster', id, url: RID, templates: [RID], scheme: 'xyz', policy: POLICY, cacheMaxBytes } as StoredSpec),
  order: 1,
  warnings: [],
  createdAt: 0,
  ...(legacy ? { legacy: { mapID: id, cacheMaxBytes } } : {}),
});

const bodyOf = (bytes: number, fill = 1) => new Uint8Array(bytes).fill(fill);

const ok = (bytes = 10, headers: Record<string, string> = {}, fill = 2): UpstreamResult => ({
  kind: 'response',
  response: new Response(bodyOf(bytes, fill), { status: 200, headers: { 'content-type': 'image/png', ...headers } }),
});

/** 保存済みの Entry を置く（store を通す） */
const seed = async (suffix: string, opts: { fetchedAt?: number; accessedAt?: number; size?: number; pinned?: 0 | 1; resourceId?: string } = {}) => {
  const rid = opts.resourceId ?? RID;
  const size = opts.size ?? 5;
  const meta: EntryMeta = {
    key: `${rid}\0${suffix}`,
    resourceId: rid,
    size,
    fetchedAt: opts.fetchedAt ?? T,
    accessedAt: opts.accessedAt ?? opts.fetchedAt ?? T,
    pinned: opts.pinned ?? 0,
    contentType: 'image/png',
  };
  await store.putEntry(meta, { key: meta.key, blob: new Blob([bodyOf(size, 9)]), headers: { 'content-type': 'image/png', 'x-old': '1' } }, []);
};

type Up = ServeInput['upstream'];

const input = (over: Partial<ServeInput> & { upstream?: Up } = {}): ServeInput => ({
  resourceId: RID,
  key: k('1_0_0'),
  coord: { z: 1, x: 0, y: 0 },
  request: new Request('https://t.example/1/0/0.png'),
  upstream: vi.fn<Up>(async () => ok()),
  storable: true,
  ...over,
});

const run = (over: Partial<ServeInput> = {}, at = T) => serve(ctx, input(over), () => at);

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  ctx = createContext();
  store = await ctx.store();
  await store.createResource(resource());
});

afterEach(() => {
  _resetPluginsForTest();
  store.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('context', () => {
  it('store() は 1 つの接続を使い回し、開くのに失敗したら次の呼び出しで開き直す', async () => {
    const s = await ctx.store();
    expect(await ctx.store()).toBe(s);
    const open = vi.fn<() => Promise<Store>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(s);
    const c = createContext(open);
    await expect(c.store()).rejects.toThrow('boom');
    expect(await c.store()).toBe(s);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('呼び出しごとに別の inflight を持つ', () => {
    expect(createContext().inflight).not.toBe(createContext().inflight);
  });
});

describe('serve: 仕様 §6 の表の 1〜7', () => {
  it('1 範囲外: x-weiwudi-status: out-of-range・上流へ出ない', async () => {
    await store.patchResource(RID, (m) => ({ ...m, extents: [{ minZoom: 0, maxZoom: 2, sourceId: 's1' }] }));
    const upstream = vi.fn<Up>(async () => ok());
    const res = await run({ upstream, key: k('3_0_0'), coord: { z: 3, x: 0, y: 0 } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weiwudi-status')).toBe('out-of-range');
    expect(res.headers.get('access-control-expose-headers')).toBe(EXPOSE);
    expect(res.headers.get('x-weiwudi-error')).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it('2 新しい Entry: 保存した本体・hit・上流へ出ない', async () => {
    await seed('1_0_0', { fetchedAt: T - 10 });
    const upstream = vi.fn<Up>(async () => ok());
    const res = await run({ upstream });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weiwudi-status')).toBe('hit');
    expect(res.headers.get('x-old')).toBe('1');
    expect(res.headers.get('access-control-expose-headers')).toBe(EXPOSE);
    expect(res.headers.get('x-weiwudi-error')).toBeNull();
    expect(await bytesOf(res)).toEqual(bodyOf(5, 9));
    expect(upstream).not.toHaveBeenCalled();
  });

  it('3 上流が成功: Entry なしは miss・保存する', async () => {
    const res = await run();
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(res.headers.get('x-weiwudi-error')).toBeNull();
    expect(res.headers.get('access-control-expose-headers')).toBe(EXPOSE);
    expect(await bytesOf(res)).toEqual(bodyOf(10, 2));
    const saved = await store.getEntry(k('1_0_0'));
    expect(saved?.meta).toMatchObject({ resourceId: RID, z: 1, x: 0, y: 0, size: 10, fetchedAt: T, accessedAt: T, pinned: 0, contentType: 'image/png' });
    expect(saved?.body.blob.size).toBe(10);
    expect((await store.getResource(RID))?.count).toBe(1);
  });

  it('3 上流が成功: 古い Entry があれば refresh・置き換える（固定は保つ）', async () => {
    await seed('1_0_0', { fetchedAt: T - TTL - 1, pinned: 1 });
    const res = await run();
    expect(res.headers.get('x-weiwudi-status')).toBe('refresh');
    const saved = await store.getEntry(k('1_0_0'));
    expect(saved?.meta.fetchedAt).toBe(T);
    expect(saved?.meta.pinned).toBe(1);
    expect(saved?.body.blob.size).toBe(10);
  });

  it('4 上流が失敗（HTTP）・Entry あり: 古い本体・stale・upstream', async () => {
    await seed('1_0_0', { fetchedAt: T - TTL - 1 });
    const res = await run({ upstream: async () => ({ kind: 'response', response: new Response('x', { status: 500 }) }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weiwudi-status')).toBe('stale');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(await bytesOf(res)).toEqual(bodyOf(5, 9));
  });

  it('5 上流が失敗（HTTP）・Entry なし: 上流の status・statusText・本体・ヘッダを写した合成応答', async () => {
    const res = await run({
      upstream: async () => ({ kind: 'response', response: new Response('gone', { status: 503, statusText: 'Busy', headers: { 'x-up': 'u' } }) }),
    });
    expect(res.status).toBe(503);
    expect(res.statusText).toBe('Busy');
    expect(await res.text()).toBe('gone');
    expect(res.headers.get('x-up')).toBe('u');
    expect(res.headers.get('x-weiwudi-status')).toBe('upstream-error');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(res.headers.get('access-control-expose-headers')).toBe(EXPOSE);
    expect(await store.getEntry(k('1_0_0'))).toBeUndefined();
  });

  it('6 ネットワーク失敗・Entry あり: 古い本体・stale・network', async () => {
    await seed('1_0_0', { fetchedAt: T - TTL - 1 });
    const res = await run({ upstream: async () => ({ kind: 'network', error: new TypeError('offline') }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weiwudi-status')).toBe('stale');
    expect(res.headers.get('x-weiwudi-error')).toBe('network');
    expect(await bytesOf(res)).toEqual(bodyOf(5, 9));
  });

  it('7 ネットワーク失敗・Entry なし: 404・offline-miss・network', async () => {
    const res = await run({ upstream: async () => ({ kind: 'network', error: new TypeError('offline') }) });
    expect(res.status).toBe(404);
    expect(res.statusText).toBe('Not Found');
    expect(res.headers.get('x-weiwudi-status')).toBe('offline-miss');
    expect(res.headers.get('x-weiwudi-error')).toBe('network');
  });

  it('upstream が投げてもネットワーク失敗として扱う', async () => {
    const res = await run({ upstream: async () => { throw new TypeError('boom'); } });
    expect(res.status).toBe(404);
    expect(res.headers.get('x-weiwudi-status')).toBe('offline-miss');
  });

  it('保存の失敗でも配信を続け、x-weiwudi-error に quota・storage を付ける', async () => {
    const spy = vi.spyOn(store, 'putEntry');
    spy.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    const q = await run();
    expect(q.status).toBe(200);
    expect(q.headers.get('x-weiwudi-status')).toBe('miss');
    expect(q.headers.get('x-weiwudi-error')).toBe('quota');
    expect(await bytesOf(q)).toEqual(bodyOf(10, 2));
    spy.mockRejectedValueOnce(new DOMException('bad', 'DataError'));
    const s = await run({ key: k('1_1_0'), coord: { z: 1, x: 1, y: 0 } });
    expect(s.headers.get('x-weiwudi-error')).toBe('storage');
  });

  it('公開の契約: x-weiwudi-status は 7 値、x-weiwudi-error は 4 語で、合成した応答すべてに expose を付ける', async () => {
    const seen = new Set<string>();
    const errors = new Set<string>();
    const note = (res: Response) => {
      seen.add(res.headers.get('x-weiwudi-status') ?? '(none)');
      const e = res.headers.get('x-weiwudi-error');
      if (e) errors.add(e);
      expect(res.headers.get('access-control-expose-headers')).toBe(EXPOSE);
    };
    await store.patchResource(RID, (m) => ({ ...m, extents: [{ minZoom: 0, maxZoom: 5, sourceId: 's1' }] }));
    note(await run({ key: k('9_0_0'), coord: { z: 9, x: 0, y: 0 } }));
    note(await run({ key: k('1_0_0') }));
    note(await run({ key: k('1_0_0') }));
    note(await run({ key: k('1_0_0') }, T + TTL + 1));
    note(await run({ key: k('1_0_0'), upstream: async () => ({ kind: 'response', response: new Response('', { status: 500 }) }) }, T + 3 * TTL));
    note(await run({ key: k('2_0_0'), coord: { z: 2, x: 0, y: 0 }, upstream: async () => ({ kind: 'response', response: new Response('', { status: 500 }) }) }));
    note(await run({ key: k('2_0_1'), coord: { z: 2, x: 0, y: 1 }, upstream: async () => ({ kind: 'network', error: 1 }) }));
    const spy = vi.spyOn(store, 'putEntry');
    spy.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    note(await run({ key: k('2_1_0'), coord: { z: 2, x: 1, y: 0 } }));
    spy.mockRejectedValueOnce(new Error('x'));
    note(await run({ key: k('2_1_1'), coord: { z: 2, x: 1, y: 1 } }));
    expect([...seen].sort()).toEqual([...STATUSES].sort());
    expect([...errors].sort()).toEqual([...ERRORS].sort());
  });
});

describe('serve: 範囲外（policy.outOfRange・extents の和）', () => {
  const withRange = (outOfRange: ResourcePolicy['outOfRange'], extents = [{ minZoom: 1, maxZoom: 3, box: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, sourceId: 's1' }]) =>
    store.patchResource(RID, (m) => ({ ...m, policy: { ...m.policy, outOfRange }, extents }));

  it('transparent: 透明 PNG・200・image/png', async () => {
    await withRange({ extent: 'transparent', zoom: 'transparent' });
    const res = await run({ key: k('0_0_0'), coord: { z: 0, x: 0, y: 0 } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await bytesOf(res)).toEqual(TRANSPARENT_PNG);
    // 定数は配信で書き換わらない
    expect(Array.from(TRANSPARENT_PNG.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('empty: 空本体・200・application/vnd.mapbox-vector-tile', async () => {
    await withRange({ extent: 'empty', zoom: 'empty' });
    const res = await run({ key: k('0_0_0'), coord: { z: 0, x: 0, y: 0 } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.mapbox-vector-tile');
    expect((await bytesOf(res)).length).toBe(0);
  });

  it('not-found: 404・Not Found', async () => {
    await withRange({ extent: 'not-found', zoom: 'not-found' });
    const res = await run({ key: k('0_0_0'), coord: { z: 0, x: 0, y: 0 } });
    expect(res.status).toBe(404);
    expect(res.statusText).toBe('Not Found');
    expect(res.headers.get('x-weiwudi-status')).toBe('out-of-range');
  });

  it('ズームの外は zoom、広がりの外は extent の方針を引く（旧 API の形）', async () => {
    await withRange({ extent: 'transparent', zoom: 'not-found' });
    const zoomOut = await run({ key: k('4_0_0'), coord: { z: 4, x: 0, y: 0 } });
    expect(zoomOut.status).toBe(404);
    // maxZoom 3 で x 0〜1 → z 2 では x 0（floor(1/2)）。x 1 は広がりの外
    const extentOut = await run({ key: k('2_1_0'), coord: { z: 2, x: 1, y: 0 } });
    expect(extentOut.status).toBe(200);
    expect(extentOut.headers.get('content-type')).toBe('image/png');
    expect(extentOut.headers.get('x-weiwudi-status')).toBe('out-of-range');
    const inside = await run({ key: k('3_1_1'), coord: { z: 3, x: 1, y: 1 } });
    expect(inside.headers.get('x-weiwudi-status')).toBe('miss');
  });

  it('extents は和: どれか 1 つに入れば範囲内。全部でズームの外ならズームの外、それ以外は広がりの外', async () => {
    await withRange({ extent: 'transparent', zoom: 'not-found' }, [
      { minZoom: 1, maxZoom: 3, box: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, sourceId: 'a' },
      { minZoom: 5, maxZoom: 6, sourceId: 'b' },
    ]);
    expect((await run({ key: k('6_40_40'), coord: { z: 6, x: 40, y: 40 } })).headers.get('x-weiwudi-status')).toBe('miss');
    expect((await run({ key: k('4_0_0'), coord: { z: 4, x: 0, y: 0 } })).status).toBe(404);
    // z 3 は a のズームの内・b のズームの外 → 広がりの外
    const r = await run({ key: k('3_5_5'), coord: { z: 3, x: 5, y: 5 } });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-weiwudi-status')).toBe('out-of-range');
  });

  it('extents が無い・coord が無いときは範囲外にしない', async () => {
    expect((await run({ key: k('20_0_0'), coord: { z: 20, x: 0, y: 0 } })).headers.get('x-weiwudi-status')).toBe('miss');
    await withRange({ extent: 'not-found', zoom: 'not-found' });
    expect((await run({ key: k('style'), coord: undefined })).headers.get('x-weiwudi-status')).toBe('miss');
  });
});

describe('serve: 鮮度と削除期限', () => {
  it('ちょうど cacheTtl は hit、1 ms 過ぎれば refresh', async () => {
    await seed('1_0_0', { fetchedAt: T - TTL });
    expect((await run()).headers.get('x-weiwudi-status')).toBe('hit');
    await seed('1_1_0', { fetchedAt: T - TTL - 1 });
    expect((await run({ key: k('1_1_0'), coord: { z: 1, x: 1, y: 0 } })).headers.get('x-weiwudi-status')).toBe('refresh');
  });

  it('削除期限を過ぎた Entry は無いもの（ネットワーク失敗で offline-miss、成功で miss）', async () => {
    await store.patchResource(RID, (m) => ({ ...m, policy: { ...m.policy, cacheTtl: 10 * TTL, cacheRetention: TTL } }));
    await seed('1_0_0', { fetchedAt: T - TTL - 1 });
    const upstream = vi.fn<Up>(async () => ({ kind: 'network', error: 1 }));
    const res = await run({ upstream });
    expect(res.status).toBe(404);
    expect(res.headers.get('x-weiwudi-status')).toBe('offline-miss');
    expect(upstream.mock.calls[0][1].hasEntry).toBe(false);
    expect((await run()).headers.get('x-weiwudi-status')).toBe('miss');
  });

  it('ちょうど削除期限は有効・固定した Entry は削除期限の対象外', async () => {
    await store.patchResource(RID, (m) => ({ ...m, policy: { ...m.policy, cacheTtl: 10 * TTL, cacheRetention: TTL } }));
    await seed('1_0_0', { fetchedAt: T - TTL });
    expect((await run()).headers.get('x-weiwudi-status')).toBe('hit');
    await seed('1_1_0', { fetchedAt: T - 5 * TTL, pinned: 1 });
    expect((await run({ key: k('1_1_0'), coord: { z: 1, x: 1, y: 0 } })).headers.get('x-weiwudi-status')).toBe('hit');
  });
});

describe('serve: text/html（仕様 §4.6）', () => {
  const html = (): UpstreamResult => ({
    kind: 'response',
    response: new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
  });

  it('Entry ありなら stale・upstream で古い本体（保存しない）', async () => {
    await seed('1_0_0', { fetchedAt: T - TTL - 1 });
    const res = await run({ upstream: async () => html() });
    expect(res.headers.get('x-weiwudi-status')).toBe('stale');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(await bytesOf(res)).toEqual(bodyOf(5, 9));
    expect((await store.getEntry(k('1_0_0')))?.meta.fetchedAt).toBe(T - TTL - 1);
  });

  it('Entry なしなら上流の応答を写した合成応答（upstream-error）で、保存しない', async () => {
    const res = await run({ upstream: async () => html() });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weiwudi-status')).toBe('upstream-error');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(await res.text()).toBe('<html>login</html>');
    expect(await store.getEntry(k('1_0_0'))).toBeUndefined();
  });

  it('スタイル（isStyleLike）は text/html でも保存する', async () => {
    const res = await run({ key: k('style'), coord: undefined, isStyleLike: true, upstream: async () => html() });
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(await store.getEntry(k('style'))).toBeDefined();
  });
});

describe('serve: ヘッダ', () => {
  const withDropped = (status: number): UpstreamResult => ({
    kind: 'response',
    response: new Response(status === 200 ? bodyOf(10, 2) : 'err', {
      status,
      headers: {
        'content-type': 'image/png',
        'content-encoding': 'gzip',
        'content-length': '10',
        'transfer-encoding': 'chunked',
        'set-cookie': 'a=1',
        'x-keep': 'k',
        'access-control-expose-headers': 'x-up',
        'x-weiwudi-error': 'quota',
        'x-weiwudi-foo': 'f',
        'x-weiwudi-status': 'hit',
      },
    }),
  });

  it('保存時に 4 ヘッダを落とす（保存した headers・miss の応答・後の hit のどれにも残らない）', async () => {
    const miss = await run({ upstream: async () => withDropped(200) });
    for (const h of DROPPED) expect(miss.headers.get(h)).toBeNull();
    expect(miss.headers.get('x-keep')).toBe('k');
    const saved = await store.getEntry(k('1_0_0'));
    for (const h of DROPPED) expect(saved?.body.headers[h]).toBeUndefined();
    expect(saved?.body.headers['x-keep']).toBe('k');
    const hit = await run();
    expect(hit.headers.get('x-weiwudi-status')).toBe('hit');
    for (const h of DROPPED) expect(hit.headers.get(h)).toBeNull();
  });

  it('表の 5: 上流 500（4 ヘッダつき）・Entry なしの合成応答に 4 ヘッダが残らず、upstream が付き、expose は上書き（第 4 回 S-1）', async () => {
    const res = await run({ upstream: async () => withDropped(500) });
    expect(res.status).toBe(500);
    for (const h of DROPPED) expect(res.headers.get(h)).toBeNull();
    expect(res.headers.get('x-keep')).toBe('k');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(res.headers.get('access-control-expose-headers')).toBe(EXPOSE);
  });

  it('上流が付けた x-weiwudi-error は残さない（成功の応答では付かない）', async () => {
    const res = await run({ upstream: async () => withDropped(200) });
    expect(res.headers.get('x-weiwudi-error')).toBeNull();
    expect(res.headers.get('access-control-expose-headers')).toBe(EXPOSE);
  });

  it('opaque は保存せず、ヘッダも付けない（そのまま返す）', async () => {
    const opaque = opaqueResponse();
    // 呼び出し側には clone() を返す（実物の opaque の clone は opaque。偽物の type は clone で落ちるので、写しの出どころで見る）
    const clone = vi.spyOn(opaque, 'clone');
    const res = await run({ upstream: async () => ({ kind: 'opaque', response: opaque }) });
    expect(clone).toHaveBeenCalledTimes(1);
    expect(res).toBe(clone.mock.results[0].value);
    expect(res.headers.get('x-weiwudi-status')).toBeNull();
    expect(await store.getEntry(k('1_0_0'))).toBeUndefined();
  });

  it('storable が偽なら保存しない（配信は miss）', async () => {
    const res = await run({ storable: false });
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(await store.getEntry(k('1_0_0'))).toBeUndefined();
  });
});

describe('serve: 上流の口と同時要求', () => {
  it('upstream に hasEntry が渡る（Entry あり・なし。第 1 回 S3）', async () => {
    const none = vi.fn<Up>(async () => ok());
    await run({ upstream: none });
    expect(none.mock.calls[0][1]).toEqual({ hasEntry: false, requestChanged: false });
    await seed('1_1_0', { fetchedAt: T - TTL - 1 });
    const some = vi.fn<Up>(async () => ok());
    await run({ upstream: some, key: k('1_1_0'), coord: { z: 1, x: 1, y: 0 } });
    expect(some.mock.calls[0][1]).toEqual({ hasEntry: true, requestChanged: false });
  });

  it('upstream には ServeInput.request が渡る（差し込み口が変えなければ同じ実体）', async () => {
    const req = new Request('https://t.example/1/0/0.png');
    const upstream = vi.fn<Up>(async () => ok());
    await run({ request: req, upstream });
    expect(upstream.mock.calls[0][0]).toBe(req);
  });

  it('同じ key の同時要求で上流は 1 回、各呼び出しは本体を読める', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const upstream = vi.fn<Up>(async () => { await gate; return ok(); });
    const a = run({ upstream });
    const b = run({ upstream });
    const c = run({ upstream });
    release();
    const rs = await Promise.all([a, b, c]);
    expect(upstream).toHaveBeenCalledTimes(1);
    for (const r of rs) expect(await bytesOf(r)).toEqual(bodyOf(10, 2));
    expect(ctx.inflight.size).toBe(0);
    // 終わった後の要求はまとめない
    await run({ upstream });
    expect(upstream).toHaveBeenCalledTimes(1); // hit
  });

  it('Resource が無いときは保存せず上流をそのまま配信する', async () => {
    const res = await run({ resourceId: 'nope', key: 'nope\u00001_0_0' });
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(await store.getEntry('nope\u00001_0_0')).toBeUndefined();
  });
});

describe('退避（evictScopesFor・仕様 §7.1・第 1 回 S4）', () => {
  it('上限を持つ Source ごとに 1 要素。rangeOnly の Source と上限の無い Source は数えない', async () => {
    const OTHER = 'https://o.example/{z}/{x}/{y}.png';
    // r は範囲だけの Source。sourceIds に紛れても数えない（守り）
    await store.patchResource(RID, (m) => ({ ...m, sourceIds: ['a', 'r', 'b', 'c'], rangeOnlySourceIds: ['r'] }));
    await store.createResource(resource({ id: OTHER, templates: [OTHER], sourceIds: ['b'] }));
    await store.putSource(sourceRecord('a', 30));
    await store.putSource(sourceRecord('b', 20, true));
    await store.putSource(sourceRecord('c'));
    await store.putSource(sourceRecord('r', 1));
    const scopes = await evictScopesFor(store, (await store.getResource(RID))!);
    expect(scopes.map((s) => ({ ...s, resourceIds: [...s.resourceIds].sort() }))).toEqual([
      { resourceIds: [RID], maxBytes: 30 },
      { resourceIds: [OTHER, RID].sort(), maxBytes: 20 },
    ]);
  });

  it('上限 2 つ: 両方の上限を満たすまで消える', async () => {
    const OTHER = 'https://o.example/{z}/{x}/{y}.png';
    await store.patchResource(RID, (m) => ({ ...m, sourceIds: ['a', 'b'] }));
    await store.createResource(resource({ id: OTHER, templates: [OTHER], sourceIds: ['b'] }));
    await store.putSource(sourceRecord('a', 30));
    await store.putSource(sourceRecord('b', 20));
    await seed('0_0_0', { size: 10, accessedAt: 1 });
    await seed('0_0_1', { size: 10, accessedAt: 2 });
    await seed('0_0_2', { size: 10, accessedAt: 4, resourceId: OTHER });
    // 新しい 10 バイト: a は 10+10+10 ≤ 30 で消さない。b は (RID 20 + OTHER 10 + 新 10) > 20 → 古い順に 2 件消す
    const res = await run({ key: k('1_0_0') });
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(await store.hasEntries([k('0_0_0'), k('0_0_1'), `${OTHER}\u00000_0_2`, k('1_0_0')])).toEqual([false, false, true, true]);
  });

  it('hit と保存を並行に出しても、hit したキーは残る（上限 2 枚）', async () => {
    await store.putSource(sourceRecord('s1', 20));
    await seed('0_0_0', { size: 10, accessedAt: 1, fetchedAt: T });
    await seed('0_0_1', { size: 10, accessedAt: 2, fetchedAt: T });
    const [hit, miss] = await Promise.all([
      run({ key: k('0_0_0'), coord: { z: 0, x: 0, y: 0 } }),
      run({ key: k('1_0_0'), coord: { z: 1, x: 0, y: 0 } }),
    ]);
    expect(hit.headers.get('x-weiwudi-status')).toBe('hit');
    expect(miss.headers.get('x-weiwudi-status')).toBe('miss');
    expect(await store.hasEntries([k('0_0_0'), k('0_0_1'), k('1_0_0')])).toEqual([true, false, true]);
  });

  it('serve() が解決する前に store.touch が呼ばれている（hit・第 3 回 S-C）', async () => {
    await seed('1_0_0', { fetchedAt: T - 10, accessedAt: T - 10 });
    const order: string[] = [];
    const real = store.touch.bind(store);
    vi.spyOn(store, 'touch').mockImplementation((key, at) => {
      order.push(`touch:${at}`);
      return real(key, at);
    });
    const p = run().then((r) => { order.push('resolved'); return r; });
    await p;
    expect(order).toEqual([`touch:${T}`, 'resolved']);
  });

  it('touch の失敗は配信に影響しない', async () => {
    await seed('1_0_0', { fetchedAt: T - 10 });
    vi.spyOn(store, 'touch').mockRejectedValue(new Error('x'));
    const res = await run();
    expect(res.headers.get('x-weiwudi-status')).toBe('hit');
    expect(res.headers.get('x-weiwudi-error')).toBeNull();
  });
});

describe('runJob（現行の fetchAll の進め方）', () => {
  const tasks = Array.from({ length: 12 }, (_v, i) => i);

  it('5 枚ずつ進めて finished。バッチの前に isAlive・isCanceled を見る', async () => {
    const calls: string[] = [];
    let active = 0;
    let peak = 0;
    const result = await runJob({
      tasks,
      isAlive: async () => { calls.push('alive'); return true; },
      isCanceled: () => { calls.push('canceled?'); return false; },
      run: async (t) => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        calls.push(`run:${t}`);
      },
      onBatch: (processed) => { calls.push(`batch:${processed}`); },
    });
    expect(result).toBe('finished');
    expect(peak).toBe(5);
    expect(calls.filter((c) => c.startsWith('batch:'))).toEqual(['batch:5', 'batch:10', 'batch:12']);
    expect(calls.slice(0, 2)).toEqual(['alive', 'canceled?']);
    expect(calls.indexOf('alive', 1)).toBeGreaterThan(calls.indexOf('batch:5'));
  });

  it('isCanceled が真なら canceled（そのバッチは走らない）', async () => {
    const ran: number[] = [];
    let n = 0;
    const result = await runJob({ tasks, isAlive: async () => true, isCanceled: () => n++ >= 1, run: async (t) => { ran.push(t); } });
    expect(result).toBe('canceled');
    expect(ran).toEqual([0, 1, 2, 3, 4]);
  });

  it('isAlive が偽なら gone（isCanceled より先に見る）', async () => {
    const isCanceled = vi.fn(() => true);
    const result = await runJob({ tasks, isAlive: async () => false, isCanceled, run: async () => undefined });
    expect(result).toBe('gone');
    expect(isCanceled).not.toHaveBeenCalled();
  });

  it('isAlive の例外は捕まえずに reject で返す（第 1 回 O-4）', async () => {
    const err = new Error('alive failed');
    await expect(runJob({ tasks, isAlive: async () => { throw err; }, isCanceled: () => false, run: async () => undefined })).rejects.toBe(err);
  });

  it('run の例外も reject で返す', async () => {
    const err = new Error('run failed');
    await expect(runJob({ tasks, isAlive: async () => true, isCanceled: () => false, run: async () => { throw err; } })).rejects.toBe(err);
  });

  it('生成器を配列にせずに読む（batchSize を指定できる）', async () => {
    let pulled = 0;
    function* gen() { for (let i = 0; i < 7; i++) { pulled++; yield i; } }
    const seen: number[] = [];
    await runJob({
      tasks: gen(), batchSize: 3, isAlive: async () => true, isCanceled: () => false,
      run: async () => undefined,
      onBatch: () => { seen.push(pulled); },
    });
    expect(seen).toEqual([3, 6, 7]);
  });
});

describe('レビューの指摘（PR #75）', () => {
  const gated = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    return { gate, release };
  };

  it('認証付き（storable が偽）の要求はまとめず、Map にも登録しない（L1 M1）', async () => {
    const { gate, release } = gated();
    const upstream = vi.fn<Up>(async (req) => {
      await gate;
      return ok(10, {}, req.headers.get('authorization') ? 7 : 3);
    });
    const privateReq = new Request('https://t.example/1/0/0.png', { headers: { authorization: 'Bearer x' } });
    const p = run({ upstream, storable: false, request: privateReq });
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.inflight.has(k('1_0_0'))).toBe(false);
    const a = run({ upstream });
    const p2 = run({ upstream, storable: false, request: privateReq });
    release();
    const [priv, anon, priv2] = await Promise.all([p, a, p2]);
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(await bytesOf(priv)).toEqual(bodyOf(10, 7));
    expect(await bytesOf(priv2)).toEqual(bodyOf(10, 7));
    expect(await bytesOf(anon)).toEqual(bodyOf(10, 3));
  });

  it('匿名の要求の処理中に来た認証付きの要求も、匿名の応答を受け取らない', async () => {
    const { gate, release } = gated();
    const upstream = vi.fn<Up>(async (req) => {
      await gate;
      return ok(10, {}, req.headers.get('authorization') ? 7 : 3);
    });
    const a = run({ upstream });
    const p = run({ upstream, storable: false, request: new Request('https://t.example/1/0/0.png', { headers: { authorization: 'Bearer x' } }) });
    release();
    const [anon, priv] = await Promise.all([a, p]);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(await bytesOf(anon)).toEqual(bodyOf(10, 3));
    expect(await bytesOf(priv)).toEqual(bodyOf(10, 7));
  });

  it('退避の範囲の読み出しの失敗は storage にせず reject で返す（L2・R3）', async () => {
    const err = new DOMException('read failed', 'UnknownError');
    vi.spyOn(store, 'getSource').mockRejectedValue(err);
    await expect(run()).rejects.toBe(err);
  });

  it('putEntry の書き込みの失敗だけを storage にする（読み出しは成功）', async () => {
    const getSource = vi.spyOn(store, 'getSource');
    vi.spyOn(store, 'putEntry').mockRejectedValueOnce(new DOMException('x', 'UnknownError'));
    const res = await run();
    expect(getSource).toHaveBeenCalled();
    expect(res.headers.get('x-weiwudi-error')).toBe('storage');
  });

  it('上流の x-weiwudi- で始まるヘッダは、合成した応答にも保存にも残らない（L2）', async () => {
    const res = await run({
      upstream: async () => ({ kind: 'response', response: new Response(bodyOf(10), { status: 200, headers: { 'content-type': 'image/png', 'X-Weiwudi-Foo': 'f', 'x-weiwudi-error': 'quota' } }) }),
    });
    expect(res.headers.get('x-weiwudi-foo')).toBeNull();
    expect(res.headers.get('x-weiwudi-error')).toBeNull();
    const saved = await store.getEntry(k('1_0_0'));
    expect(Object.keys(saved?.body.headers ?? {}).filter((h) => h.startsWith('x-weiwudi-'))).toEqual([]);
    // 保存済みのヘッダに紛れていても、hit の合成で落とす
    await store.putEntry(
      { key: k('1_1_0'), resourceId: RID, size: 1, fetchedAt: T, accessedAt: T, pinned: 0 },
      { key: k('1_1_0'), blob: new Blob(['x']), headers: { 'x-weiwudi-bar': 'b', 'x-weiwudi-status': 'miss' } },
      [],
    );
    const hit = await run({ key: k('1_1_0'), coord: { z: 1, x: 1, y: 0 } });
    expect(hit.headers.get('x-weiwudi-bar')).toBeNull();
    expect(hit.headers.get('x-weiwudi-status')).toBe('hit');
  });

  it('opaque: Entry があれば §6 の 4（古い本体・stale・upstream）、無ければ opaque をそのまま（L2・仕様 §4.5-3）', async () => {
    await seed('1_0_0', { fetchedAt: T - TTL - 1 });
    const res = await run({ upstream: async () => ({ kind: 'opaque', response: opaqueResponse() }) });
    expect(res.headers.get('x-weiwudi-status')).toBe('stale');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(await bytesOf(res)).toEqual(bodyOf(5, 9));
    expect((await store.getEntry(k('1_0_0')))?.meta.fetchedAt).toBe(T - TTL - 1);
  });

  it('opaque の判定は kind でも見る（L1 m3。response.type が opaque でなくても保存せず、ヘッダを付けない）', async () => {
    const res = await run({ upstream: async () => ({ kind: 'opaque', response: new Response('o') }) });
    expect(res.headers.get('x-weiwudi-status')).toBeNull();
    expect(await store.getEntry(k('1_0_0'))).toBeUndefined();
  });

  it('上流の 2xx は 200 OK として配信・保存する（Ruling。旧 API の miss と同じ）', async () => {
    const res = await run({ upstream: async () => ({ kind: 'response', response: new Response(bodyOf(4), { status: 203, statusText: 'Non-Authoritative' }) }) });
    expect(res.status).toBe(200);
    expect(res.statusText).toBe('OK');
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
  });

  it('Range つきの要求は素通し: 上流の応答をそのまま返し、保存もまとめもせず、差し込み口も呼ばない（仕様 §11）', async () => {
    await seed('1_0_0', { fetchedAt: T });
    const hook = vi.fn(async () => undefined);
    addPlugin({ requestWillFetch: hook, cachedResponseWillBeUsed: hook });
    const partial = new Response(bodyOf(3), { status: 206, headers: { 'content-range': 'bytes 0-2/10' } });
    const req = new Request('https://t.example/1/0/0.png', { headers: { range: 'bytes=0-2' } });
    const upstream = vi.fn<Up>(async () => ({ kind: 'response', response: partial }));
    const p = run({ upstream, request: req });
    expect(ctx.inflight.has(k('1_0_0'))).toBe(false);
    const res = await p;
    expect(res).toBe(partial);
    expect(upstream).toHaveBeenCalledWith(req, { hasEntry: false, requestChanged: false });
    expect(hook).not.toHaveBeenCalled();
    expect((await store.getEntry(k('1_0_0')))?.meta.size).toBe(5);
  });

  it('Range つきでネットワーク失敗なら 404・offline-miss', async () => {
    const req = new Request('https://t.example/1/0/0.png', { headers: { range: 'bytes=0-2' } });
    const res = await run({ request: req, upstream: async () => ({ kind: 'network', error: 1 }) });
    expect(res.status).toBe(404);
    expect(res.headers.get('x-weiwudi-status')).toBe('offline-miss');
  });

  it('runJob が gone・canceled で途中で終わるとき、生成器の return を呼ぶ（L2）', async () => {
    const closed: string[] = [];
    function* gen(name: string) {
      try { for (let i = 0; i < 20; i++) yield i; } finally { closed.push(name); }
    }
    await runJob({ tasks: gen('gone'), isAlive: async () => false, isCanceled: () => false, run: async () => undefined });
    let n = 0;
    await runJob({ tasks: gen('canceled'), isAlive: async () => true, isCanceled: () => n++ >= 1, run: async () => undefined });
    expect(closed).toEqual(['gone', 'canceled']);
  });

  it('runJob の例外のときも生成器の return を呼ぶ', async () => {
    const closed: string[] = [];
    function* gen() {
      try { for (let i = 0; i < 20; i++) yield i; } finally { closed.push('x'); }
    }
    await expect(runJob({ tasks: gen(), isAlive: async () => { throw new Error('e'); }, isCanceled: () => false, run: async () => undefined })).rejects.toThrow('e');
    expect(closed).toEqual(['x']);
  });
});

describe('認証付きの要求と保存済みの Entry（仕様 §4.6・PR #75 追加）', () => {
  it('storable が偽なら新鮮な Entry があっても上流へ出し、上流の本体を返す（hit にしない・touch しない）', async () => {
    await seed('1_0_0', { fetchedAt: T - 10, accessedAt: T - 10 });
    const touch = vi.spyOn(store, 'touch');
    const upstream = vi.fn<Up>(async () => ok(10, {}, 4));
    const res = await run({ storable: false, upstream });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][1].hasEntry).toBe(true);
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(await bytesOf(res)).toEqual(bodyOf(10, 4));
    expect(touch).not.toHaveBeenCalled();
    // 保存済みの Entry は書き換えない
    expect((await store.getEntry(k('1_0_0')))?.meta.size).toBe(5);
  });

  it('storable が偽で上流が HTTP の失敗なら、Entry の古い本体（stale・upstream）', async () => {
    await seed('1_0_0', { fetchedAt: T - 10 });
    const res = await run({ storable: false, upstream: async () => ({ kind: 'response', response: new Response('', { status: 401 }) }) });
    expect(res.headers.get('x-weiwudi-status')).toBe('stale');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(await bytesOf(res)).toEqual(bodyOf(5, 9));
  });

  it('storable が偽でネットワーク失敗なら、Entry の古い本体（stale・network）', async () => {
    await seed('1_0_0', { fetchedAt: T - 10 });
    const res = await run({ storable: false, upstream: async () => ({ kind: 'network', error: new TypeError('x') }) });
    expect(res.headers.get('x-weiwudi-status')).toBe('stale');
    expect(res.headers.get('x-weiwudi-error')).toBe('network');
  });
});

describe('退避の範囲: 子 Source は親ごとに 1 要素（m3-t2）', () => {
  const OTHER = 'https://o.example/{z}/{x}/{y}.png';
  const childRecord = (id: string, parentId?: string): SourceRecord => ({
    id,
    kind: 'child',
    spec: { kind: 'child', type: 'tile', id, url: RID, templates: [RID], scheme: 'xyz', policy: POLICY, logicalName: id },
    order: 1,
    warnings: [],
    createdAt: 0,
    ...(parentId !== undefined ? { parentId } : {}),
  });
  const parentRecord = (cacheMaxBytes?: number): SourceRecord => ({
    id: 'P',
    kind: 'style',
    spec: {
      kind: 'style', id: 'P', url: 'https://s.example/style.json', templates: ['https://s.example/style.json'], policy: POLICY,
      ...(cacheMaxBytes !== undefined ? { cacheMaxBytes } : {}),
      children: [{ id: 'c1', logicalName: 'a', type: 'tile' }, { id: 'c2', logicalName: 'b', type: 'tile' }],
    },
    order: 1,
    warnings: [],
    createdAt: 0,
  });

  it('子 2 つの親が cacheMaxBytes を持つとき、2 つの子の Resource を併せて 1 要素で退避する', async () => {
    // 同じ親の子 c1・c2 が同じ RID を参照し、c2 は OTHER も参照する
    await store.patchResource(RID, (m) => ({ ...m, sourceIds: ['c1', 'c2'] }));
    await store.createResource(resource({ id: OTHER, templates: [OTHER], sourceIds: ['c2'] }));
    await store.putSource(parentRecord(40));
    await store.putSource(childRecord('c1', 'P'));
    await store.putSource(childRecord('c2', 'P'));
    const scopes = await evictScopesFor(store, (await store.getResource(RID))!);
    expect(scopes.map((s) => ({ ...s, resourceIds: [...s.resourceIds].sort() }))).toEqual([
      { resourceIds: [OTHER, RID].sort(), maxBytes: 40 },
    ]);
  });

  it('親が cacheMaxBytes を持たなければ要素なし（子自身は上限を持たない）。親の無い子も数えない', async () => {
    await store.patchResource(RID, (m) => ({ ...m, sourceIds: ['c1', 'c3'] }));
    await store.putSource(parentRecord());
    await store.putSource(childRecord('c1', 'P'));
    await store.putSource({ ...childRecord('c3'), spec: { ...childRecord('c3').spec, cacheMaxBytes: 5 } as StoredSpec });
    expect(await evictScopesFor(store, (await store.getResource(RID))!)).toEqual([]);
  });

  it('2 つの子の Resource の合計で上限を見て、古い順に消す', async () => {
    await store.patchResource(RID, (m) => ({ ...m, sourceIds: ['c1'] }));
    await store.createResource(resource({ id: OTHER, templates: [OTHER], sourceIds: ['c2'] }));
    await store.putSource(parentRecord(20));
    await store.putSource(childRecord('c1', 'P'));
    await store.putSource(childRecord('c2', 'P'));
    await seed('0_0_0', { size: 10, accessedAt: 1, resourceId: OTHER });
    await seed('0_0_1', { size: 10, accessedAt: 2 });
    // 新しい 10 バイト: (OTHER 10 + RID 10 + 新 10) > 20 → 最も古い OTHER の 1 件を消す
    const res = await run({ key: k('1_0_0') });
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(await store.hasEntries([`${OTHER}\u00000_0_0`, k('0_0_1'), k('1_0_0')])).toEqual([false, true, true]);
  });
});

describe('グリフの範囲（m3-t4・仕様 §11）', () => {
  it('part の無い要求は putEntry、part のある要求は putGlyphPart で保存する', async () => {
    const entrySpy = vi.spyOn(store, 'putEntry');
    const glyphSpy = vi.spyOn(store, 'putGlyphPart');
    await run();
    expect(entrySpy).toHaveBeenCalledTimes(1);
    expect(glyphSpy).not.toHaveBeenCalled();
    await run({ key: k('glyph'), coord: undefined, part: '0-255' });
    expect(entrySpy).toHaveBeenCalledTimes(1);
    expect(glyphSpy).toHaveBeenCalledTimes(1);
    expect(glyphSpy.mock.calls[0][1]).toBe('0-255');
  });

  it('parts を持たないレコードに part の要求が来たら Entry 無しとして扱い、部分の索引を持つレコードに作り直す', async () => {
    await seed('glyph', { size: 5 });
    const up = vi.fn<Up>(async () => ok(3));
    const res = await run({ key: k('glyph'), coord: undefined, part: '0-255', upstream: up });
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(up.mock.calls[0][1].hasEntry).toBe(false);
    const got = await store.getEntry(k('glyph'));
    expect(got!.body.parts).toEqual({ '0-255': { offset: 0, length: 3, fetchedAt: T } });
    expect(await store.getResource(RID)).toMatchObject({ count: 1, bytes: 3 });
  });
});

describe('ServeInput.transform・revalidate（m3-t6・R28・R4・C-S4・C-S1）', () => {
  const upper = async (b: Blob) => new Blob([(await b.text()).toUpperCase()], { type: b.type });
  const textOk = (s: string, type = 'application/json'): UpstreamResult => ({
    kind: 'response', response: new Response(s, { status: 200, headers: { 'content-type': type } }),
  });
  const throwing = vi.fn(async (_b: Blob): Promise<Blob> => { throw new Error('not json'); });

  it('上流が成功したとき 1 度だけ当て、保存も配信も変えた本体（hit でも同じ本体）', async () => {
    const transform = vi.fn(upper);
    const res = await run({ upstream: async () => textOk('abc'), transform });
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(await res.text()).toBe('ABC');
    expect(transform).toHaveBeenCalledTimes(1);
    expect(await (await store.getEntry(k('1_0_0')))!.body.blob.text()).toBe('ABC');
    const hit = await run({ upstream: async () => textOk('zzz'), transform }, T + 1);
    expect(hit.headers.get('x-weiwudi-status')).toBe('hit');
    expect(await hit.text()).toBe('ABC');
    expect(transform).toHaveBeenCalledTimes(1);
  });

  it('fetchDidSucceed の後・cacheWillUpdate の前に当てる', async () => {
    const order: string[] = [];
    addPlugin({
      fetchDidSucceed: async ({ response }) => { order.push('fetchDidSucceed'); return response; },
      cacheWillUpdate: async ({ response }) => { order.push(`cacheWillUpdate:${await response.clone().text()}`); return response; },
    });
    await run({ upstream: async () => textOk('abc'), transform: async (b) => { order.push('transform'); return upper(b); } });
    expect(order).toEqual(['fetchDidSucceed', 'transform', 'cacheWillUpdate:ABC']);
  });

  it('transform が投げた・Entry あり: 古い本体・stale・x-weiwudi-error: upstream。保存しない（Entry が前のまま）', async () => {
    await seed('1_0_0', { fetchedAt: T - TTL - 1 });
    const before = await store.getEntry(k('1_0_0'));
    const res = await run({ upstream: async () => textOk('<html>login</html>', 'text/html'), transform: throwing, isStyleLike: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weiwudi-status')).toBe('stale');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(await bytesOf(res)).toEqual(bodyOf(5, 9));
    const after = await store.getEntry(k('1_0_0'));
    expect(after!.meta).toEqual(before!.meta);
    expect(await after!.body.blob.arrayBuffer()).toEqual(await before!.body.blob.arrayBuffer());
    expect((await store.getResource(RID))!.count).toBe(1);
  });

  it('transform が投げた・Entry なし: 上流の応答を写した合成応答・upstream-error。保存しない（entries が増えない）', async () => {
    const res = await run({ upstream: async () => textOk('<html>login</html>', 'text/html'), transform: throwing, isStyleLike: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weiwudi-status')).toBe('upstream-error');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(res.headers.get('access-control-expose-headers')).toBe(EXPOSE);
    expect(await res.text()).toBe('<html>login</html>');
    expect(await store.getEntry(k('1_0_0'))).toBeUndefined();
    expect((await store.getResource(RID))!.count).toBe(0);
  });

  it('上流が失敗（HTTP）なら transform を呼ばない', async () => {
    const transform = vi.fn(upper);
    const res = await run({ upstream: async () => ({ kind: 'response', response: new Response('x', { status: 500 }) }), transform });
    expect(res.headers.get('x-weiwudi-status')).toBe('upstream-error');
    expect(transform).not.toHaveBeenCalled();
  });

  it('revalidate: 新しい Entry があっても hit を飛ばして上流へ出し、refresh で置き換える', async () => {
    await seed('1_0_0', { fetchedAt: T - 10 });
    const upstream = vi.fn<Up>(async () => ok());
    const res = await run({ upstream, revalidate: true });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(res.headers.get('x-weiwudi-status')).toBe('refresh');
    expect((await store.getEntry(k('1_0_0')))!.meta.fetchedAt).toBe(T);
  });

  it('revalidate で上流が失敗（HTTP・ネットワーク）なら古い本体・stale', async () => {
    await seed('1_0_0', { fetchedAt: T - 10 });
    const http = await run({ upstream: async () => ({ kind: 'response', response: new Response('x', { status: 500 }) }), revalidate: true });
    expect(http.headers.get('x-weiwudi-status')).toBe('stale');
    expect(http.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(await bytesOf(http)).toEqual(bodyOf(5, 9));
    const net = await run({ upstream: async () => ({ kind: 'network', error: new TypeError('offline') }), revalidate: true });
    expect(net.headers.get('x-weiwudi-status')).toBe('stale');
    expect(net.headers.get('x-weiwudi-error')).toBe('network');
  });

  it('revalidate が無ければ新しい Entry は hit のまま（既存の挙動）', async () => {
    await seed('1_0_0', { fetchedAt: T - 10 });
    const upstream = vi.fn<Up>(async () => ok());
    const res = await run({ upstream, revalidate: false });
    expect(res.headers.get('x-weiwudi-status')).toBe('hit');
    expect(upstream).not.toHaveBeenCalled();
  });
});
