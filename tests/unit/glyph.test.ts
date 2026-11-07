// グリフの結合保存の試験（m3-t4・#39・仕様 §11）。fake-indexeddb の上の実物の store.ts・core.ts で確かめる。
// 計画 docs/superpowers/plans/2026-11-04-m3-vector.md の m3-t4。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createContext, type Context } from '../../src/context';
import { serve, type ServeInput, type UpstreamResult } from '../../src/core';
import { STORE_DB_NAME, type EntryMeta, type ResourceMeta, type ResourcePolicy, type SourceRecord, type Store, type StoredBody } from '../../src/store';
import type { StoredSpec } from '../../src/spec';
import { createSwHarness } from './sw-harness';

const T = 1_000_000_000;
const TTL = 60_000;
const GID = 'https://g.example/fonts/{fontstack}/{range}.pbf';
const TID = 'https://t.example/{z}/{x}/{y}.png';
const gkey = (fontstack: string) => `${GID}\0${fontstack}`;

const POLICY: ResourcePolicy = {
  cacheTtl: TTL,
  store: true,
  outOfRange: { extent: 'not-found', zoom: 'not-found' },
  credentialParams: [],
};

const glyphResource = (over: Partial<ResourceMeta> = {}): ResourceMeta => ({
  id: GID,
  type: 'glyph',
  templates: [GID],
  sourceIds: ['s1'],
  policy: POLICY,
  count: 0,
  bytes: 0,
  pinnedBytes: 0,
  ...over,
});

const sourceRecord = (id: string, cacheMaxBytes?: number): SourceRecord => ({
  id,
  kind: 'raster',
  spec: ({ kind: 'raster', id, url: TID, templates: [TID], scheme: 'xyz', policy: POLICY, cacheMaxBytes } as StoredSpec),
  order: 1,
  warnings: [],
  createdAt: 0,
});

/** 範囲ごとに違う本体（長さと中身が範囲と通し番号で決まる） */
const glyphBytes = (range: string, size: number, seq = 0): Uint8Array => {
  const start = Number(range.split('-')[0]);
  return Uint8Array.from({ length: size }, (_v, i) => (start / 256 + seq * 7 + i) % 251);
};

const okBody = (bytes: Uint8Array): UpstreamResult => ({
  kind: 'response',
  response: new Response(bytes.slice(), { status: 200, headers: { 'content-type': 'application/x-protobuf' } }),
});

type Up = ServeInput['upstream'];

const glyphInput = (fontstack: string, range: string, upstream: Up, over: Partial<ServeInput> = {}): ServeInput => ({
  resourceId: GID,
  key: gkey(fontstack),
  part: range,
  request: new Request(`https://g.example/fonts/${fontstack}/${range}.pbf`),
  upstream,
  storable: true,
  ...over,
});

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

let ctx: Context;
let store: Store;

/** entries・bodies の全件（store を通さず直接読む） */
const rawAll = async <V>(name: string): Promise<V[]> => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(STORE_DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise<V[]>((resolve, reject) => {
      const req = db.transaction([name], 'readonly').objectStore(name).getAll();
      req.onsuccess = () => resolve(req.result as V[]);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
};

/** 各 Resource の count・bytes・pinnedBytes が entries の全件の集計と一致し、本体の大きさが parts の和と一致する */
const expectConsistent = async () => {
  const entries = await rawAll<EntryMeta>('entries');
  const bodies = await rawAll<StoredBody>('bodies');
  for (const r of await store.listResources()) {
    const mine = entries.filter((e) => e.resourceId === r.id);
    expect({ id: r.id, count: r.count, bytes: r.bytes, pinnedBytes: r.pinnedBytes }).toEqual({
      id: r.id,
      count: mine.length,
      bytes: mine.reduce((s, e) => s + e.size, 0),
      pinnedBytes: mine.filter((e) => e.pinned === 1).reduce((s, e) => s + e.size, 0),
    });
  }
  expect(bodies.map((b) => b.key).sort()).toEqual(entries.map((e) => e.key).sort());
  for (const e of entries) {
    const b = bodies.find((x) => x.key === e.key)!;
    expect(b.data.byteLength).toBe(e.size);
    if (b.parts) {
      const list = Object.values(b.parts).sort((a, c) => a.offset - c.offset);
      // 空きを残さない: 部分は 0 から隙間なく並び、合計が本体の大きさ
      let at = 0;
      for (const p of list) {
        expect(p.offset).toBe(at);
        at += p.length;
      }
      expect(at).toBe(e.size);
      expect(e.fetchedAt).toBe(Math.max(...list.map((p) => p.fetchedAt)));
    }
  }
};

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  ctx = createContext();
  store = await ctx.store();
  await store.createResource(glyphResource());
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('グリフの結合保存（仕様 §11）', () => {
  it('範囲 2 つを順に取ると Entry が 1 つ・parts が 2 つ・それぞれの再生が上流の本体と同じバイト列', async () => {
    const a = glyphBytes('0-255', 30);
    const b = glyphBytes('256-511', 17);
    const resA = await serve(ctx, glyphInput('Noto', '0-255', vi.fn<Up>(async () => okBody(a))), () => T);
    expect(resA.headers.get('x-weiwudi-status')).toBe('miss');
    expect(await bytesOf(resA)).toEqual(a);
    const resB = await serve(ctx, glyphInput('Noto', '256-511', vi.fn<Up>(async () => okBody(b))), () => T + 1);
    expect(resB.headers.get('x-weiwudi-status')).toBe('miss');

    const entries = await rawAll<EntryMeta>('entries');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: gkey('Noto'), resourceId: GID, size: 47, fetchedAt: T + 1 });
    const got = await store.getEntry(gkey('Noto'));
    expect(Object.keys(got!.body.parts!).sort()).toEqual(['0-255', '256-511']);
    expect(await store.getResource(GID)).toMatchObject({ count: 1, bytes: 47 });

    const never = vi.fn<Up>(async () => ({ kind: 'network', error: new Error('x') }));
    const hitA = await serve(ctx, glyphInput('Noto', '0-255', never), () => T + 2);
    const hitB = await serve(ctx, glyphInput('Noto', '256-511', never), () => T + 2);
    expect(hitA.headers.get('x-weiwudi-status')).toBe('hit');
    expect(hitB.headers.get('x-weiwudi-status')).toBe('hit');
    expect(await bytesOf(hitA)).toEqual(a);
    expect(await bytesOf(hitB)).toEqual(b);
    expect(hitA.headers.get('content-type')).toBe('application/x-protobuf');
    expect(never).not.toHaveBeenCalled();
    await expectConsistent();
  });

  it('同じ範囲の差し替えで size が増えない（古い部分が落ちる）', async () => {
    await serve(ctx, glyphInput('Noto', '0-255', vi.fn<Up>(async () => okBody(glyphBytes('0-255', 20)))), () => T);
    await serve(ctx, glyphInput('Noto', '256-511', vi.fn<Up>(async () => okBody(glyphBytes('256-511', 10)))), () => T);
    expect((await store.getResource(GID))!.bytes).toBe(30);
    // 鮮度切れの後に同じ範囲を同じ大きさで差し替える
    const next = glyphBytes('0-255', 20, 5);
    const res = await serve(ctx, glyphInput('Noto', '0-255', vi.fn<Up>(async () => okBody(next))), () => T + TTL + 1);
    expect(res.headers.get('x-weiwudi-status')).toBe('refresh');
    const entries = await rawAll<EntryMeta>('entries');
    expect(entries).toHaveLength(1);
    expect(entries[0].size).toBe(30);
    expect(await store.getResource(GID)).toMatchObject({ count: 1, bytes: 30 });
    // 差し替えた部分も残した部分も正しく再生する
    const never = vi.fn<Up>(async () => ({ kind: 'network', error: new Error('x') }));
    expect(await bytesOf(await serve(ctx, glyphInput('Noto', '0-255', never), () => T + TTL + 2))).toEqual(next);
    expect(await bytesOf(await serve(ctx, glyphInput('Noto', '256-511', never), () => T + TTL + 2)))
      .toEqual(glyphBytes('256-511', 10));
    await expectConsistent();
  });

  it('部分ごとの鮮度: 古い範囲だけ上流へ、新しい範囲は hit', async () => {
    await serve(ctx, glyphInput('Noto', '0-255', vi.fn<Up>(async () => okBody(glyphBytes('0-255', 8)))), () => T);
    await serve(ctx, glyphInput('Noto', '256-511', vi.fn<Up>(async () => okBody(glyphBytes('256-511', 8)))), () => T + TTL);
    const at = T + TTL + 1;
    const upOld = vi.fn<Up>(async () => okBody(glyphBytes('0-255', 8, 1)));
    const upNew = vi.fn<Up>(async () => okBody(glyphBytes('256-511', 8, 1)));
    const old = await serve(ctx, glyphInput('Noto', '0-255', upOld), () => at);
    const fresh = await serve(ctx, glyphInput('Noto', '256-511', upNew), () => at);
    expect(old.headers.get('x-weiwudi-status')).toBe('refresh');
    expect(upOld).toHaveBeenCalledTimes(1);
    expect(upOld.mock.calls[0][1].hasEntry).toBe(true);
    expect(fresh.headers.get('x-weiwudi-status')).toBe('hit');
    expect(upNew).not.toHaveBeenCalled();
    await expectConsistent();
  });

  it('部分の無い範囲は Entry 無し（hasEntry が偽・miss）', async () => {
    await serve(ctx, glyphInput('Noto', '0-255', vi.fn<Up>(async () => okBody(glyphBytes('0-255', 8)))), () => T);
    const up = vi.fn<Up>(async () => okBody(glyphBytes('512-767', 4)));
    const res = await serve(ctx, glyphInput('Noto', '512-767', up), () => T + 1);
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(up.mock.calls[0][1].hasEntry).toBe(false);
  });

  it('部分ごとの削除期限: 期限を過ぎた範囲は無いもの、他の範囲は hit', async () => {
    const RET = 10 * TTL;
    await store.replaceResource(glyphResource({ policy: { ...POLICY, cacheRetention: RET } }));
    await serve(ctx, glyphInput('Noto', '0-255', vi.fn<Up>(async () => okBody(glyphBytes('0-255', 8)))), () => T);
    await serve(ctx, glyphInput('Noto', '256-511', vi.fn<Up>(async () => okBody(glyphBytes('256-511', 8)))), () => T + RET);
    const at = T + RET + 1;
    // 期限を過ぎた範囲は stale にもならない（無いもの）
    const offline = vi.fn<Up>(async () => ({ kind: 'network', error: new Error('offline') }));
    const expired = await serve(ctx, glyphInput('Noto', '0-255', offline), () => at);
    expect(expired.headers.get('x-weiwudi-status')).toBe('offline-miss');
    expect(offline.mock.calls[0][1].hasEntry).toBe(false);
    // もう一方の範囲は新しい部分（鮮度の内・削除期限の内）
    const live = await serve(ctx, glyphInput('Noto', '256-511', offline), () => at);
    expect(live.headers.get('x-weiwudi-status')).toBe('hit');
    expect(await bytesOf(live)).toEqual(glyphBytes('256-511', 8));
  });

  it('同じ fontstack の別の範囲の同時要求で上流が 2 回、同じ範囲の同時要求で 1 回', async () => {
    const upA = vi.fn<Up>(async () => okBody(glyphBytes('0-255', 8)));
    const upB = vi.fn<Up>(async () => okBody(glyphBytes('256-511', 9)));
    const [a, b] = await Promise.all([
      serve(ctx, glyphInput('Noto', '0-255', upA), () => T),
      serve(ctx, glyphInput('Noto', '256-511', upB), () => T),
    ]);
    expect(upA).toHaveBeenCalledTimes(1);
    expect(upB).toHaveBeenCalledTimes(1);
    expect(await bytesOf(a)).toEqual(glyphBytes('0-255', 8));
    expect(await bytesOf(b)).toEqual(glyphBytes('256-511', 9));

    const upC = vi.fn<Up>(async () => okBody(glyphBytes('512-767', 5)));
    const [c1, c2] = await Promise.all([
      serve(ctx, glyphInput('Noto', '512-767', upC), () => T),
      serve(ctx, glyphInput('Noto', '512-767', upC), () => T),
    ]);
    expect(upC).toHaveBeenCalledTimes(1);
    expect(await bytesOf(c1)).toEqual(glyphBytes('512-767', 5));
    expect(await bytesOf(c2)).toEqual(glyphBytes('512-767', 5));
    expect(ctx.inflight.size).toBe(0);
    // 同時に書いた 3 つの範囲がすべて残る（同じレコードへの書き込みが互いを消さない）
    const got = await store.getEntry(gkey('Noto'));
    expect(Object.keys(got!.body.parts!).sort()).toEqual(['0-255', '256-511', '512-767']);
    await expectConsistent();
  });

  it('上流の失敗で部分があれば stale、無ければ offline-miss／upstream-error', async () => {
    await serve(ctx, glyphInput('Noto', '0-255', vi.fn<Up>(async () => okBody(glyphBytes('0-255', 8)))), () => T);
    const at = T + TTL + 1;
    const network = vi.fn<Up>(async () => ({ kind: 'network', error: new Error('offline') }));
    const http = vi.fn<Up>(async () => ({ kind: 'response', response: new Response('no', { status: 500 }) }));

    const s1 = await serve(ctx, glyphInput('Noto', '0-255', network), () => at);
    expect(s1.headers.get('x-weiwudi-status')).toBe('stale');
    expect(s1.headers.get('x-weiwudi-error')).toBe('network');
    expect(await bytesOf(s1)).toEqual(glyphBytes('0-255', 8));
    const s2 = await serve(ctx, glyphInput('Noto', '0-255', http), () => at);
    expect(s2.headers.get('x-weiwudi-status')).toBe('stale');
    expect(s2.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(await bytesOf(s2)).toEqual(glyphBytes('0-255', 8));

    const m1 = await serve(ctx, glyphInput('Noto', '256-511', network), () => at);
    expect(m1.status).toBe(404);
    expect(m1.headers.get('x-weiwudi-status')).toBe('offline-miss');
    const m2 = await serve(ctx, glyphInput('Noto', '256-511', http), () => at);
    expect(m2.status).toBe(500);
    expect(m2.headers.get('x-weiwudi-status')).toBe('upstream-error');
    // 失敗は保存しない
    const got = await store.getEntry(gkey('Noto'));
    expect(Object.keys(got!.body.parts!)).toEqual(['0-255']);
  });

  it('count・bytes が entries の全件の集計と一致する（種を固定した 100 回の取得と差し替え）', async () => {
    // 退避も混ぜる: 同じ Source に上限を持たせる
    await store.putSource(sourceRecord('s1', 400));
    let seed = 20261105;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const fontstacks = ['Noto', 'Open', 'Klee'];
    const ranges = ['0-255', '256-511', '512-767', '65280-65535'];
    let t = T;
    for (let i = 0; i < 100; i++) {
      const fs = fontstacks[Math.floor(rand() * fontstacks.length)];
      const range = ranges[Math.floor(rand() * ranges.length)];
      const size = 1 + Math.floor(rand() * 60);
      // 半分ほどは鮮度切れの後（差し替え）
      t += rand() < 0.5 ? TTL + 1 : 1;
      const body = glyphBytes(range, size, i);
      const res = await serve(ctx, glyphInput(fs, range, vi.fn<Up>(async () => okBody(body))), () => t);
      const status = res.headers.get('x-weiwudi-status');
      expect(['hit', 'miss', 'refresh']).toContain(status);
      if (status !== 'hit') expect(await bytesOf(res)).toEqual(body);
    }
    await expectConsistent();
    const entries = await rawAll<EntryMeta>('entries');
    expect(entries.reduce((s, e) => s + e.size, 0)).toBeLessThanOrEqual(400);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('退避（cacheMaxBytes）でレコードごと消える', async () => {
    await store.putSource(sourceRecord('s1', 100));
    await store.createResource({
      id: TID, type: 'tile', templates: [TID], sourceIds: ['s1'], policy: POLICY, count: 0, bytes: 0, pinnedBytes: 0,
    });
    await serve(ctx, glyphInput('Noto', '0-255', vi.fn<Up>(async () => okBody(glyphBytes('0-255', 30)))), () => T);
    await serve(ctx, glyphInput('Noto', '256-511', vi.fn<Up>(async () => okBody(glyphBytes('256-511', 30)))), () => T + 1);
    expect(await store.getResource(GID)).toMatchObject({ count: 1, bytes: 60 });
    // 後から取ったタイル 50 バイトで予算 100 を超える → 最も古いグリフのレコードが丸ごと消える
    const tile = await serve(ctx, {
      resourceId: TID,
      key: `${TID}\x001_0_0`,
      coord: { z: 1, x: 0, y: 0 },
      request: new Request('https://t.example/1/0/0.png'),
      upstream: async () => ({ kind: 'response', response: new Response(new Uint8Array(50), { status: 200 }) }),
      storable: true,
    }, () => T + 2);
    expect(tile.headers.get('x-weiwudi-status')).toBe('miss');
    expect(await store.getEntry(gkey('Noto'))).toBeUndefined();
    expect(await store.getResource(GID)).toMatchObject({ count: 0, bytes: 0 });
    expect(await store.getResource(TID)).toMatchObject({ count: 1, bytes: 50 });
    await expectConsistent();
  });

  it('グリフ自身の保存が予算を超える分を退避し、同じレコードは候補から外す', async () => {
    await store.putSource(sourceRecord('s1', 100));
    await store.createResource({
      id: TID, type: 'tile', templates: [TID], sourceIds: ['s1'], policy: POLICY, count: 0, bytes: 0, pinnedBytes: 0,
    });
    await serve(ctx, {
      resourceId: TID,
      key: `${TID}\x001_0_0`,
      coord: { z: 1, x: 0, y: 0 },
      request: new Request('https://t.example/1/0/0.png'),
      upstream: async () => ({ kind: 'response', response: new Response(new Uint8Array(40), { status: 200 }) }),
      storable: true,
    }, () => T);
    await serve(ctx, glyphInput('Noto', '0-255', vi.fn<Up>(async () => okBody(glyphBytes('0-255', 40)))), () => T + 1);
    // 40 + 40 + 30 = 110 > 100 → 古いタイルが消え、グリフは 2 つの部分を持つ
    await serve(ctx, glyphInput('Noto', '256-511', vi.fn<Up>(async () => okBody(glyphBytes('256-511', 30)))), () => T + 2);
    expect(await store.getResource(TID)).toMatchObject({ count: 0, bytes: 0 });
    expect(await store.getResource(GID)).toMatchObject({ count: 1, bytes: 70 });
    const got = await store.getEntry(gkey('Noto'));
    expect(Object.keys(got!.body.parts!).sort()).toEqual(['0-255', '256-511']);
    await expectConsistent();
  });
});

describe('照合ルートからグリフの範囲を渡す（hook）', () => {
  it('同じ fontstack の 2 つの範囲が 1 つの Entry にまとまり、それぞれ hit で再生される', async () => {
    const h = createSwHarness();
    const bodies: Record<string, Uint8Array> = {
      '0-255': glyphBytes('0-255', 12),
      '256-511': glyphBytes('256-511', 7),
    };
    h.fetch.mockImplementation(async (r: RequestInfo | URL) => {
      const url = typeof r === 'string' ? r : r instanceof URL ? r.href : r.url;
      const range = /\/(\d+-\d+)\.pbf$/.exec(url)?.[1];
      if (range === undefined) return new Response('other');
      return new Response(bodies[range].slice(), { status: 200, headers: { 'content-type': 'application/x-protobuf' } });
    });
    const c = createContext();
    const s = await c.store();
    await s.createResource(glyphResource({ sourceIds: [] }));
    await h.flushRoutes();
    await h.dispatch('https://warm.example/');
    const a1 = await h.dispatch('https://g.example/fonts/Noto/0-255.pbf');
    const b1 = await h.dispatch('https://g.example/fonts/Noto/256-511.pbf');
    expect(a1!.headers.get('x-weiwudi-status')).toBe('miss');
    expect(b1!.headers.get('x-weiwudi-status')).toBe('miss');
    const a2 = await h.dispatch('https://g.example/fonts/Noto/0-255.pbf');
    const b2 = await h.dispatch('https://g.example/fonts/Noto/256-511.pbf');
    expect(a2!.headers.get('x-weiwudi-status')).toBe('hit');
    expect(b2!.headers.get('x-weiwudi-status')).toBe('hit');
    expect(await bytesOf(a2!)).toEqual(bodies['0-255']);
    expect(await bytesOf(b2!)).toEqual(bodies['256-511']);
    const got = await s.getEntry(gkey('Noto'));
    expect(Object.keys(got!.body.parts!).sort()).toEqual(['0-255', '256-511']);
    expect(await s.getResource(GID)).toMatchObject({ count: 1, bytes: 19 });
    s.close();
  });
});

// ---- m4-t1（計画 docs/superpowers/plans/2026-11-07-m4-range-release-migration.md の m4-t1）。追記のみ ----

describe('固定の競合のグリフ版（m4-t1・L1・R6）', () => {
  it('上流を待つ間に固定されたレコードは、putGlyphParts の後も固定のまま（old.pinned を保つ）', async () => {
    await serve(ctx, glyphInput('Noto', '0-255', vi.fn<Up>(async () => okBody(glyphBytes('0-255', 10)))), () => T);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const upstream = vi.fn<Up>(async () => {
      await gate;
      return okBody(glyphBytes('256-511', 6));
    });
    const p = serve(ctx, glyphInput('Noto', '256-511', upstream), () => T + 1);
    await vi.waitFor(() => expect(upstream).toHaveBeenCalled());
    await store.setPinned([gkey('Noto')], 1);
    release();
    expect((await p).headers.get('x-weiwudi-status')).toBe('miss');
    const got = await store.getEntry(gkey('Noto'));
    expect(got!.meta.pinned).toBe(1);
    expect(Object.keys(got!.body.parts!).sort()).toEqual(['0-255', '256-511']);
    expect(await store.getResource(GID)).toMatchObject({ count: 1, bytes: 16, pinnedBytes: 16 });
    await expectConsistent();
  });

  it('上限を超える結合レコードは古い範囲を落として新しい範囲を保存する（L3・R7）', async () => {
    await store.putSource(sourceRecord('s1', 25));
    await serve(ctx, glyphInput('Noto', '0-255', vi.fn<Up>(async () => okBody(glyphBytes('0-255', 12)))), () => T);
    await serve(ctx, glyphInput('Noto', '256-511', vi.fn<Up>(async () => okBody(glyphBytes('256-511', 12)))), () => T + 1);
    const res = await serve(ctx, glyphInput('Noto', '512-767', vi.fn<Up>(async () => okBody(glyphBytes('512-767', 12)))), () => T + 2);
    expect(res.headers.get('x-weiwudi-error')).toBeNull();
    const got = await store.getEntry(gkey('Noto'));
    expect(Object.keys(got!.body.parts!).sort()).toEqual(['256-511', '512-767']);
    await expectConsistent();
  });
});

// ---- m4-t4（計画 docs/superpowers/plans/2026-11-07-m4-range-release-migration.md の m4-t4・L4・R-G）。追記のみ ----

import { createGlyphCollector } from '../../src/core';

describe('グリフの束ね書き（m4-t4・L4・R-G・第 1 回 M15）', () => {
  it('collect のある serve は putGlyphPart も evictScopesFor も呼ばず（配信は通常どおり）、flush で 1 回書く', async () => {
    await store.putSource(sourceRecord('s1', 10_000));
    const resource = (await store.getResource(GID))!;
    const collect = createGlyphCollector(ctx, resource, gkey('Noto'));
    const putOne = vi.spyOn(store, 'putGlyphPart');
    const putMany = vi.spyOn(store, 'putGlyphParts');
    // evictScopesFor は Resource の sourceIds の Source を読む（同じモジュールの中の呼び出しは spy できないので読みで数える）
    const getSource = vi.spyOn(store, 'getSource');
    const a = glyphBytes('0-255', 9);
    const b = glyphBytes('256-511', 4);
    const resA = await serve(ctx, glyphInput('Noto', '0-255', vi.fn<Up>(async () => okBody(a)), { collect }), () => T);
    const resB = await serve(ctx, glyphInput('Noto', '256-511', vi.fn<Up>(async () => okBody(b)), { collect }), () => T + 1);
    expect(resA.headers.get('x-weiwudi-status')).toBe('miss');
    expect(resA.headers.get('x-weiwudi-error')).toBeNull();
    expect(await bytesOf(resA)).toEqual(a);
    expect(await bytesOf(resB)).toEqual(b);
    expect(putOne).not.toHaveBeenCalled();
    expect(putMany).not.toHaveBeenCalled();
    expect(getSource).not.toHaveBeenCalled();
    // まだ書いていない
    expect(await store.getEntry(gkey('Noto'))).toBeUndefined();

    expect(await collect.flush()).toBeUndefined();
    expect(putMany).toHaveBeenCalledTimes(1);
    expect(putOne).not.toHaveBeenCalled();
    expect(getSource.mock.calls.filter(([id]) => id === 's1')).toHaveLength(1);
    const got = await store.getEntry(gkey('Noto'));
    expect(Object.keys(got!.body.parts!).sort()).toEqual(['0-255', '256-511']);
    expect(got!.meta).toMatchObject({ fetchedAt: T + 1, size: 13, pinned: 0 });
    const never = vi.fn<Up>(async () => ({ kind: 'network', error: new Error('x') }));
    expect(await bytesOf(await serve(ctx, glyphInput('Noto', '0-255', never), () => T + 2))).toEqual(a);
    expect(await bytesOf(await serve(ctx, glyphInput('Noto', '256-511', never), () => T + 2))).toEqual(b);
    // 2 回目の flush は何も書かない（集めた部分は 1 回で出し切る）
    expect(await collect.flush()).toBeUndefined();
    expect(putMany).toHaveBeenCalledTimes(1);
    await expectConsistent();
  });

  it('同じ範囲を 2 回集めると後のものが勝つ。flush の失敗は quota／storage を 1 つ返す（投げない）', async () => {
    const resource = (await store.getResource(GID))!;
    const collect = createGlyphCollector(ctx, resource, gkey('Noto'));
    await serve(ctx, glyphInput('Noto', '0-255', vi.fn<Up>(async () => okBody(glyphBytes('0-255', 5, 1))), { collect }), () => T);
    const later = glyphBytes('0-255', 6, 2);
    // 集めた部分はまだ Entry でないので、同じ範囲の 2 回目も上流へ出る
    const second = vi.fn<Up>(async () => okBody(later));
    await serve(ctx, glyphInput('Noto', '0-255', second, { collect }), () => T + 1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(await collect.flush()).toBeUndefined();
    const never = vi.fn<Up>(async () => ({ kind: 'network', error: new Error('x') }));
    expect(await bytesOf(await serve(ctx, glyphInput('Noto', '0-255', never), () => T + 2))).toEqual(later);

    const failing = createGlyphCollector(ctx, resource, gkey('Other'));
    await serve(ctx, glyphInput('Other', '0-255', vi.fn<Up>(async () => okBody(glyphBytes('0-255', 3))), { collect: failing }), () => T);
    vi.spyOn(store, 'putGlyphParts').mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    expect(await failing.flush()).toBe('quota');
    const broken = createGlyphCollector(ctx, resource, gkey('Broken'));
    await serve(ctx, glyphInput('Broken', '0-255', vi.fn<Up>(async () => okBody(glyphBytes('0-255', 3))), { collect: broken }), () => T);
    vi.spyOn(store, 'putGlyphParts').mockRejectedValueOnce(new Error('boom'));
    expect(await broken.flush()).toBe('storage');
  });
});
