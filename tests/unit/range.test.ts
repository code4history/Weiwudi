// src/range.ts と制御の op（estimate・fetchRange・regions・cancel・job/resume）の試験（m4-t3・仕様 §7.2・R2〜R5・R13・R23・
// R45・R46・R55・R57・R58）。ハーネスで大域（self・fetch・indexedDB）を差し替え、context と control は直接作る（ctx.job と
// ctx.inflight に触るため。control.test.ts の direct と同じ形）。仕様の文 1 つにつき 1 件。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSwHarness, PAGE_CLIENT, PAGE_CLIENT_ID, SW_SELF_ORIGIN, type SwHarness } from './sw-harness';
import { createContext, type Context, type JobState } from '../../src/context';
import { createControl } from '../../src/control';
import { installHook, serveResource } from '../../src/hook';
import { credentialSourceFor } from '../../src/registry';
import { createNotifier, enumerate, tileAt } from '../../src/range';
import { normalizeFetchOptions, normalizeRange } from '../../src/spec';
import type { RegionRecord, ResourceMeta, Store, SourceRecord } from '../../src/store';
import { countTiles, scaleTileBox } from '../../src/tile_math';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const TPL = 'https://t.example/{z}/{x}/{y}.png';
const CLIENT_ID = 'range-page';
/** 登録の box（maxZoom 2 の全域）。'all' は 1 + 4 + 16 = 21 枚 */
const SOURCE = { kind: 'raster', id: 's', url: TPL, box: { minX: 0, maxX: 3, minY: 0, maxY: 3 }, minZoom: 0, maxZoom: 2 };
/** z1 の 1 枚と z2 の 4 枚（5 枚） */
const RANGE = { box: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, minZoom: 1, maxZoom: 2 };

const png = (status = 200) => new Response(new Uint8Array([1, 2, 3]), { status, headers: { 'content-type': 'image/png' } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string; detail: Record<string, unknown> } };

interface Env {
  h: SwHarness;
  ctx: Context;
  store: Store;
  client: { id: string; url: string; type: string; postMessage: ReturnType<typeof vi.fn> };
  /** 偽: self.clients.get が client を返さない（ページが閉じた） */
  alive: boolean;
  jobs: Promise<unknown>[];
  post: (op: string, body?: unknown) => Promise<Reply>;
}

const setup = async (): Promise<Env> => {
  const h = createSwHarness();
  h.fetch.mockImplementation(async () => png());
  const ctx = createContext();
  installHook(ctx, () => undefined, { pickCredentialSource: credentialSourceFor });
  ctx.notify = createNotifier(ctx);
  const control = createControl(ctx);
  const client = { id: CLIENT_ID, url: `${SW_SELF_ORIGIN}/index.html`, type: 'window', postMessage: vi.fn() };
  const jobs: Promise<unknown>[] = [];
  const env: Env = {
    h, ctx, store: await ctx.store(), client, alive: true, jobs,
    post: async (op, body = {}) => {
      const url = new URL(`https://weiwudi.example.com/v2/${op}`);
      const request = new Request(url, {
        method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body),
      });
      const event = { clientId: CLIENT_ID, waitUntil: (p: Promise<unknown>) => { jobs.push(Promise.resolve(p)); } };
      return (await control.post({ url, request, event } as never)).json();
    },
  };
  h.self.clients.get.mockImplementation(async (id: unknown) => {
    if (id === CLIENT_ID) return env.alive ? client : undefined;
    return id === PAGE_CLIENT_ID ? PAGE_CLIENT : undefined;
  });
  (h.self.clients as unknown as { matchAll: unknown }).matchAll = vi.fn(async () => [client]);
  return env;
};

const ok = async (env: Env, op: string, body: unknown = {}) => {
  const r = await env.post(op, body);
  expect(r).toMatchObject({ ok: true });
  return r.result;
};

const fails = async (env: Env, op: string, body: unknown, code: string) => {
  const r = await env.post(op, body);
  expect(r.ok).toBe(false);
  expect(r.error!.code).toBe(code);
  return r.error!;
};

/** 始めたジョブ（waitUntil に渡したもの）が全部終わるまで待つ */
const settle = async (env: Env) => {
  while (env.jobs.length > 0) await Promise.all(env.jobs.splice(0));
};

/** ジョブの client に送ったメッセージ */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const messages = (env: Env, type?: string): any[] =>
  env.client.postMessage.mock.calls.map((c) => c[0]).filter((m) => type === undefined || m.type === type);

/** 上流へ出した URL（cors の取得は Request、no-cors の確かめは文字列） */
const fetched = (env: Env): string[] =>
  env.h.fetch.mock.calls.map(([r]) => (typeof r === 'string' ? r : (r as Request).url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ページの要求（この ctx の照合表で照合し、serveResource で配信する。照合ルートと同じ組み立て） */
const capture = async (env: Env, url: string): Promise<Response> => {
  const hit = env.ctx.table.current!.table.match(new URL(url))!;
  expect(hit).toBeTruthy();
  const resource = (await env.store.getResource(hit.resourceId))!;
  return serveResource(env.ctx, resource, new Request(url), new URL(url), hit.m, undefined);
};

const tileKey = (rid: string, z: number, x: number, y: number) => `${rid}\0${z}_${x}_${y}`;

const allEntries = async (env: Env, rid: string) => {
  const out = [];
  for (let z = 0; z <= 2; z++) out.push(...(await env.store.entriesAtZoom(rid, z)));
  return out;
};

describe('estimate（§7.2・R29・R30）', () => {
  it('タイルの枚数は countTiles と Resource の範囲の交差に一致する', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    expect(await ok(env, 'estimate', { id: 's', range: RANGE })).toEqual({ tiles: countTiles(RANGE.box, 1, 2) });
    expect(await ok(env, 'estimate', { id: 's', range: 'all' })).toEqual({ tiles: 21 });
    // 登録のズームの外は数えない
    expect(await ok(env, 'estimate', { id: 's', range: { box: { minX: 2, maxX: 5, minY: 0, maxY: 0 }, minZoom: 3, maxZoom: 3 } }))
      .toEqual({ tiles: 0 });
    // 登録の範囲（z2 の 0〜1 × 0〜1）との交差だけ数える
    await ok(env, 'register', { kind: 'raster', id: 'q', url: 'https://q.example/{z}/{x}/{y}.png',
      box: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, minZoom: 2, maxZoom: 2 });
    expect(await ok(env, 'estimate', { id: 'q', range: { box: { minX: 1, maxX: 3, minY: 1, maxY: 3 }, minZoom: 2, maxZoom: 2 } }))
      .toEqual({ tiles: 1 });
  });

  it('同じ Resource を共有するスタイルの 2 つの子では 1 回だけ数える', async () => {
    const env = await setup();
    const policy = { cacheTtl: 1, store: true, outOfRange: { extent: 'transparent' as const, zoom: 'transparent' as const }, credentialParams: [] };
    const child = (id: string): SourceRecord => ({
      id, kind: 'child', parentId: 'p', order: 2, warnings: [], createdAt: 1,
      spec: { kind: 'child', type: 'tile', id, url: TPL, templates: [TPL], policy,
        extent: { minZoom: 0, maxZoom: 2, box: { minX: 0, maxX: 3, minY: 0, maxY: 3 }, sourceId: id } },
    });
    await env.store.putSource({
      id: 'p', kind: 'style', order: 1, warnings: [], createdAt: 1,
      spec: { kind: 'style', id: 'p', url: 'https://st.example/style.json', templates: ['https://st.example/style.json'], policy,
        children: [{ id: 'c1', logicalName: 'a', type: 'tile' }, { id: 'c2', logicalName: 'b', type: 'tile' }] },
    });
    await env.store.putSource(child('c1'));
    await env.store.putSource(child('c2'));
    const extent = (id: string) => ({ minZoom: 0, maxZoom: 2, box: { minX: 0, maxX: 3, minY: 0, maxY: 3 }, sourceId: id });
    await env.store.createResource({
      id: TPL, type: 'tile', templates: [TPL], sourceIds: ['c1', 'c2'], policy, extents: [extent('c1'), extent('c2')],
      scheme: 'xyz', count: 0, bytes: 0, pinnedBytes: 0,
    });
    expect(await ok(env, 'estimate', { id: 'p', range: RANGE })).toEqual({ tiles: 5 });
    expect(await ok(env, 'estimate', { id: 'p', range: 'all' })).toEqual({ tiles: 21 });
  });
});

describe('fetchRange のタイルと固定（§7.2・R24・R46）', () => {
  it('範囲のタイルを全部取り、pinned === 1・pinnedBytes === bytes。応答は running の RegionInfo', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    const info = await ok(env, 'fetchRange', { id: 's', range: RANGE });
    expect(info).toMatchObject({ sourceId: 's', status: 'running', pinned: true, total: 5, error: 0 });
    expect(typeof info.id).toBe('string');
    await settle(env);
    expect(fetched(env).sort()).toEqual([
      'https://t.example/1/0/0.png', 'https://t.example/2/0/0.png', 'https://t.example/2/0/1.png',
      'https://t.example/2/1/0.png', 'https://t.example/2/1/1.png',
    ]);
    const entries = await allEntries(env, TPL);
    expect(entries).toHaveLength(5);
    expect(entries.every((e) => e.pinned === 1)).toBe(true);
    const r = (await env.store.getResource(TPL))!;
    expect(r.pinnedBytes).toBe(r.bytes);
    expect(r.bytes).toBe(15);
  });

  it('pin: false なら固定しない', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    const info = await ok(env, 'fetchRange', { id: 's', range: RANGE, options: { pin: false } });
    expect(info.pinned).toBe(false);
    await settle(env);
    expect((await allEntries(env, TPL)).every((e) => e.pinned === 0)).toBe(true);
    expect((await env.store.getResource(TPL))!.pinnedBytes).toBe(0);
  });

  it('既に有るタイルは上流へ出ずに固定だけ付く', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    await (await capture(env, 'https://t.example/2/1/1.png')).arrayBuffer();
    env.h.fetch.mockClear();
    await ok(env, 'fetchRange', { id: 's', range: RANGE });
    await settle(env);
    expect(fetched(env)).toHaveLength(4);
    expect(fetched(env)).not.toContain('https://t.example/2/1/1.png');
    expect((await env.store.getEntry(tileKey(TPL, 2, 1, 1)))!.meta.pinned).toBe(1);
  });

  it('固定の抜け (a): ページの要求が上流を待つ間にジョブが同じキーを取る（inflight の相乗り）→ pinned === 1（第 1 回 S2）', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    env.h.fetch.mockImplementationOnce(async () => { await gate; return png(); });
    const page = capture(env, 'https://t.example/1/0/0.png');
    await vi.waitFor(() => expect(env.h.fetch).toHaveBeenCalledTimes(1));
    await ok(env, 'fetchRange', { id: 's', range: { box: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, minZoom: 1, maxZoom: 1 } });
    await sleep(30);
    release();
    await (await page).arrayBuffer();
    await settle(env);
    expect(env.h.fetch).toHaveBeenCalledTimes(1);
    expect((await env.store.getEntry(tileKey(TPL, 1, 0, 0)))!.meta.pinned).toBe(1);
  });

  it('固定の抜け (b): hasEntries が偽を返した直後に別の要求が保存し、ジョブの serve が hit → pinned === 1', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    const orig = env.store.hasEntries;
    vi.spyOn(env.store, 'hasEntries').mockImplementationOnce(async (keys) => {
      const r = await orig(keys);
      await (await capture(env, 'https://t.example/1/0/0.png')).arrayBuffer();
      return r;
    });
    await ok(env, 'fetchRange', { id: 's', range: { box: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, minZoom: 1, maxZoom: 1 } });
    await settle(env);
    expect(env.h.fetch).toHaveBeenCalledTimes(1);
    expect((await env.store.getEntry(tileKey(TPL, 1, 0, 0)))!.meta.pinned).toBe(1);
  });

  it('tms の座標（第 1 回 M9）: {y}+tms・{-y}+xyz・{-y}+tms で、範囲取得の URL とキーが捕捉と同じ（y を 2 回反転しない）', async () => {
    const env = await setup();
    const cases = [
      { id: 'a', url: 'https://a.example/{z}/{x}/{y}.png', scheme: 'tms', want: 'https://a.example/2/2/3.png' },
      { id: 'b', url: 'https://b.example/{z}/{x}/{-y}.png', scheme: 'xyz', want: 'https://b.example/2/2/3.png' },
      { id: 'c', url: 'https://c.example/{z}/{x}/{-y}.png', scheme: 'tms', want: 'https://c.example/2/2/0.png' },
    ];
    for (const c of cases) await ok(env, 'register', { kind: 'raster', id: c.id, url: c.url, scheme: c.scheme });
    for (const c of cases) {
      env.h.fetch.mockClear();
      // XYZ の (2, 2, 0) の 1 枚（経緯度で指定）
      await ok(env, 'fetchRange', { id: c.id, range: { bounds: [10, 70, 80, 80], minZoom: 2, maxZoom: 2 } });
      await settle(env);
      expect(fetched(env)).toEqual([c.want]);
      env.h.fetch.mockClear();
      expect((await capture(env, c.want)).headers.get('x-weiwudi-status')).toBe('hit');
      expect(env.h.fetch).not.toHaveBeenCalled();
    }
  });

  it("ratio: '@2x' で @2x の URL とキー（ページ側の既定は devicePixelRatio。SW の既定は ''）", async () => {
    const env = await setup();
    const R = 'https://r.example/{z}/{x}/{y}{ratio}.png';
    await ok(env, 'register', { kind: 'raster', id: 'r', url: R });
    const one = { box: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, minZoom: 1, maxZoom: 1 };
    await ok(env, 'fetchRange', { id: 'r', range: one, options: { ratio: '@2x' } });
    await settle(env);
    expect(fetched(env)).toEqual(['https://r.example/1/0/0@2x.png']);
    expect((await capture(env, 'https://r.example/1/0/0@2x.png')).headers.get('x-weiwudi-status')).toBe('hit');
    env.h.fetch.mockClear();
    await ok(env, 'fetchRange', { id: 'r', range: one });
    await settle(env);
    expect(fetched(env)).toEqual(['https://r.example/1/0/0.png']);
  });
});

describe('イベントと終わりの順（I5c・R21・R45）', () => {
  it('proceed は concurrency ごと、finish に error・errors・regionId・sourceId。finish の時点で regions() は running でない', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    let atFinish: { job: JobState | undefined; regions: Promise<Reply> } | undefined;
    env.client.postMessage.mockImplementation((m: { type: string }) => {
      if (m.type === 'finish') atFinish = { job: env.ctx.job, regions: env.post('regions', { id: 's' }) };
    });
    const info = await ok(env, 'fetchRange', { id: 's', range: RANGE, options: { concurrency: 2 } });
    await settle(env);
    const proceed = messages(env, 'proceed');
    expect(proceed.map((m) => m.processed)).toEqual([2, 4, 5]);
    expect(proceed[0]).toEqual({
      type: 'proceed', sourceId: 's', regionId: info.id, percent: 40, processed: 2, total: 5, error: 0,
      errors: { network: 0, upstream: 0, quota: 0, storage: 0 },
    });
    expect(messages(env, 'finish')).toEqual([{
      type: 'finish', sourceId: 's', regionId: info.id, percent: 100, processed: 5, total: 5, error: 0,
      errors: { network: 0, upstream: 0, quota: 0, storage: 0 },
    }]);
    expect(atFinish!.job).toBeUndefined();
    const regions = await atFinish!.regions;
    expect(regions.result.map((r: { status: string }) => r.status)).toEqual(['complete']);
  });

  it('cancel() で canceled。応答は取り消したジョブの regionId。解決の後の clean() が通る（第 2 回 M4）', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    env.h.fetch.mockImplementationOnce(async () => { await gate; return png(); });
    const info = await ok(env, 'fetchRange', { id: 's', range: RANGE, options: { concurrency: 1 } });
    await vi.waitFor(() => expect(env.h.fetch).toHaveBeenCalledTimes(1));
    expect(await ok(env, 'cancel', { id: 's' })).toEqual({ regionId: info.id });
    await fails(env, 'clean', { id: 's' }, 'fetch-busy');
    release();
    await settle(env);
    expect(messages(env, 'canceled')).toEqual([{ type: 'canceled', sourceId: 's', regionId: info.id }]);
    expect(env.h.fetch).toHaveBeenCalledTimes(1);
    expect((await env.store.getRegion(info.id))!.status).toBe('canceled');
    await ok(env, 'clean', { id: 's' });
    await fails(env, 'cancel', { id: 's' }, 'no-fetch-process');
  });

  it('stop に code・message・processed・total（Source が消えると次のバッチで source-not-found。R13）', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    let n = 0;
    env.h.fetch.mockImplementation(async () => {
      // 別スコープの SW が消した形（t5 の後は自分の remove() は fetch-busy になる）
      if (++n === 2) await env.store.deleteSource('s');
      return png();
    });
    const info = await ok(env, 'fetchRange', { id: 's', range: RANGE, options: { concurrency: 1 } });
    await settle(env);
    expect(env.h.fetch).toHaveBeenCalledTimes(2);
    const [stop] = messages(env, 'stop');
    expect(stop).toMatchObject({ type: 'stop', sourceId: 's', regionId: info.id, code: 'source-not-found', processed: 2, total: 5 });
    expect(typeof stop.message).toBe('string');
    expect(env.ctx.job).toBeUndefined();
  });
});

describe('regions() と終わりの書き込み（R5・第 1 回 M7）', () => {
  it('complete・partial（失敗あり）・canceled。running で ctx.job が無い・別の region のジョブ中は partial（記録は書き換えない）', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    const a = await ok(env, 'fetchRange', { id: 's', range: RANGE });
    await settle(env);
    env.h.fetch.mockImplementation(async (r: Request) => (r.url.endsWith('/2/2/2.png') ? png(500) : png()));
    const b = await ok(env, 'fetchRange', { id: 's', range: { box: { minX: 2, maxX: 2, minY: 2, maxY: 3 }, minZoom: 2, maxZoom: 2 } });
    await settle(env);
    const byId = async () => new Map((await ok(env, 'regions', { id: 's' })).map((r: { id: string }) => [r.id, r]));
    const m1 = await byId();
    expect(m1.get(a.id)).toMatchObject({ status: 'complete', error: 0 });
    expect(m1.get(b.id)).toMatchObject({ status: 'partial', error: 1, errors: { network: 0, upstream: 1, quota: 0, storage: 0 } });

    const running: RegionRecord = {
      id: 'g', sourceId: 's', range: RANGE, status: 'running', pinned: true, total: 5, error: 0,
      errors: { network: 0, upstream: 0, quota: 0, storage: 0 }, createdAt: 1, updatedAt: 1,
      normalized: normalizeRange(RANGE, { scheme: 'xyz' }), options: normalizeFetchOptions(undefined),
    };
    await env.store.putRegion(running);
    expect((await byId()).get('g')).toMatchObject({ status: 'partial' });
    env.ctx.job = { sourceId: 's', label: 's', total: 5, count: 0, error: 0, failures: { network: 0, upstream: 0, quota: 0, storage: 0 }, cancel: false, regionId: 'other' };
    expect((await byId()).get('g')).toMatchObject({ status: 'partial' });
    env.ctx.job.regionId = 'g';
    expect((await byId()).get('g')).toMatchObject({ status: 'running' });
    expect((await env.store.getRegion('g'))!.status).toBe('running');
    // 内部の項目は見せない
    expect(Object.keys((await byId()).get('g') as object).sort()).toEqual(
      ['createdAt', 'error', 'errors', 'id', 'pinned', 'range', 'sourceId', 'status', 'total', 'updatedAt']);
  });

  it('ページが閉じた（isAlive が偽）ジョブの region は partial（終わりのイベントは送らない）', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    env.h.fetch.mockImplementation(async () => { env.alive = false; return png(); });
    const info = await ok(env, 'fetchRange', { id: 's', range: RANGE, options: { concurrency: 1 } });
    await settle(env);
    expect(env.h.fetch).toHaveBeenCalledTimes(1);
    expect((await env.store.getRegion(info.id))!.status).toBe('partial');
    expect(messages(env).filter((m) => m.type !== 'proceed')).toEqual([]);
    expect(env.ctx.job).toBeUndefined();
  });

  it('ジョブの途中で region を消す → 書き戻さず canceled で終え、次のバッチから取らない。どの region にも属さない固定を残さない（R57・第 2 回 M3・PR #102 M2）', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    let id = '';
    let n = 0;
    env.h.fetch.mockImplementation(async () => {
      // clean() と同じく、取得の途中で region を消す
      if (++n === 1) await env.store.deleteRegion(id);
      return png();
    });
    id = (await ok(env, 'fetchRange', { id: 's', range: RANGE, options: { concurrency: 1 } })).id;
    await settle(env);
    expect(env.h.fetch).toHaveBeenCalledTimes(1);
    expect(await env.store.getRegion(id)).toBeUndefined();
    expect(messages(env, 'canceled')).toEqual([{ type: 'canceled', sourceId: 's', regionId: id }]);
    // 消したバッチで保存した Entry は固定しない（保存と同じ tx の近道を使わない）
    const entries = await allEntries(env, TPL);
    expect(entries).toHaveLength(1);
    expect(entries.filter((e) => e.pinned === 1)).toHaveLength(0);
    expect((await env.store.getResource(TPL))!.pinnedBytes).toBe(0);
  });

  it('ジョブの途中で partial に書き換える → 終わりに complete で上書きしない', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    let id = '';
    let n = 0;
    env.h.fetch.mockImplementation(async () => {
      if (++n === 1) await env.store.patchRegion(id, (r) => ({ ...r, status: 'partial' }));
      return png();
    });
    id = (await ok(env, 'fetchRange', { id: 's', range: RANGE, options: { concurrency: 1 } })).id;
    await settle(env);
    expect((await env.store.getRegion(id))!.status).toBe('partial');
  });
});

describe('job/resume（§7.2・R45・R57）', () => {
  const crafted = (id = 'g'): RegionRecord => ({
    id, sourceId: 's', range: RANGE, status: 'running', pinned: true, total: 5, error: 0,
    errors: { network: 0, upstream: 0, quota: 0, storage: 0 }, createdAt: 1, updatedAt: 1,
    normalized: normalizeRange(RANGE, { scheme: 'xyz' }), options: normalizeFetchOptions({ concurrency: 2 }),
  });

  /** z1 の 1 枚だけを先に取った後、SW が止まった running の region（ctx.job は無い）を作る */
  const restarted = async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    await ok(env, 'fetchRange', { id: 's', range: { box: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, minZoom: 1, maxZoom: 1 } });
    await settle(env);
    await env.store.putRegion(crafted());
    env.h.fetch.mockClear();
    env.client.postMessage.mockClear();
    return env;
  };

  it('SW の再起動の後の job/resume は残りだけ取る（既に有るタイルは飛ぶ）。応答は running の RegionInfo', async () => {
    const env = await restarted();
    expect(await ok(env, 'job/resume', { id: 's', regionId: 'g' })).toMatchObject({ id: 'g', status: 'running' });
    await settle(env);
    expect(env.h.fetch).toHaveBeenCalledTimes(4);
    expect(messages(env, 'finish')).toMatchObject([{ regionId: 'g', processed: 5, total: 5 }]);
    // concurrency は保存した指定を使う（R-t3-3）
    expect(messages(env, 'proceed').map((m) => m.processed)).toEqual([2, 4, 5]);
    expect((await env.store.getRegion('g'))!.status).toBe('complete');
  });

  it('同時の job/resume 2 つでジョブは 1 つ', async () => {
    const env = await restarted();
    const [a, b] = await Promise.all([env.post('job/resume', { id: 's', regionId: 'g' }), env.post('job/resume', { id: 's', regionId: 'g' })]);
    expect(a.ok && b.ok).toBe(true);
    expect(env.jobs).toHaveLength(1);
    await settle(env);
    expect(env.h.fetch).toHaveBeenCalledTimes(4);
  });

  it('同じ region のジョブ中は今の RegionInfo、別の region のジョブ中は fetch-busy、終わった region はその RegionInfo', async () => {
    const env = await restarted();
    const job = (regionId: string): JobState => ({
      sourceId: 's', label: 's', total: 5, count: 0, error: 0, failures: { network: 0, upstream: 0, quota: 0, storage: 0 }, cancel: false, regionId,
    });
    env.ctx.job = job('g');
    expect(await ok(env, 'job/resume', { id: 's', regionId: 'g' })).toMatchObject({ id: 'g', status: 'running' });
    env.ctx.job = job('other');
    await fails(env, 'job/resume', { id: 's', regionId: 'g' }, 'fetch-busy');
    env.ctx.job = undefined;
    await env.store.patchRegion('g', (r) => ({ ...r, status: 'stopped', code: 'quota' }));
    expect(await ok(env, 'job/resume', { id: 's', regionId: 'g' })).toMatchObject({ id: 'g', status: 'stopped', code: 'quota' });
    expect(env.jobs).toHaveLength(0);
    expect(env.h.fetch).not.toHaveBeenCalled();
  });

  it('無い region・他の Source の region は attribute-invalid（regionId）', async () => {
    const env = await restarted();
    await ok(env, 'register', { ...SOURCE, id: 't', url: 'https://u.example/{z}/{x}/{y}.png' });
    const e = await fails(env, 'job/resume', { id: 's', regionId: 'none' }, 'attribute-invalid');
    expect(e.detail).toEqual({ attribute: 'regionId' });
    await fails(env, 'job/resume', { id: 't', regionId: 'g' }, 'attribute-invalid');
  });

  it('clean() が直列で進んでいる最中の job/resume はジョブを始めず、clean() の後に attribute-invalid（第 2 回 M3）', async () => {
    const env = await restarted();
    const [cleaned, resumed] = await Promise.all([
      env.post('clean', { id: 's' }),
      env.post('job/resume', { id: 's', regionId: 'g' }),
    ]);
    expect(cleaned.ok).toBe(true);
    expect(resumed).toMatchObject({ ok: false, error: { code: 'attribute-invalid' } });
    expect(env.jobs).toHaveLength(0);
    expect(env.h.fetch).not.toHaveBeenCalled();
    expect(await env.store.listRegions('s')).toEqual([]);
  });
});

describe('1 度に 1 ジョブ・code（R23・R30）', () => {
  it('別の Source のジョブ中・旧 API の fetchAll 中は fetch-busy。region を書かない', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    await ok(env, 'register', { ...SOURCE, id: 't', url: 'https://u.example/{z}/{x}/{y}.png' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    env.h.fetch.mockImplementationOnce(async () => { await gate; return png(); });
    await ok(env, 'fetchRange', { id: 's', range: RANGE });
    const e = await fails(env, 'fetchRange', { id: 't', range: RANGE }, 'fetch-busy');
    expect(e.message).toContain('"s"');
    release();
    await settle(env);
    expect(await env.store.listRegions('t')).toEqual([]);
    env.ctx.job = { sourceId: 'map:old', label: 'old', total: 9, count: 3, error: 0, failures: { network: 0, upstream: 0, quota: 0, storage: 0 }, cancel: false };
    await fails(env, 'fetchRange', { id: 't', range: RANGE }, 'fetch-busy');
    // 旧 API のジョブは新 API の cancel では止まらない
    await fails(env, 'cancel', { id: 't' }, 'no-fetch-process');
    expect(env.ctx.job.cancel).toBe(false);
  });

  it("範囲（box）の無い Source の 'all' は cannot-fetch-all（estimate も）", async () => {
    const env = await setup();
    await ok(env, 'register', { kind: 'raster', id: 'w', url: TPL });
    await fails(env, 'fetchRange', { id: 'w', range: 'all' }, 'cannot-fetch-all');
    await fails(env, 'estimate', { id: 'w', range: 'all' }, 'cannot-fetch-all');
    expect(env.ctx.job).toBeUndefined();
  });

  it('不正な範囲・指定は attribute-invalid、無い Source は source-not-found', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    await fails(env, 'fetchRange', { id: 's', range: { box: RANGE.box, minZoom: 3, maxZoom: 2 } }, 'attribute-invalid');
    await fails(env, 'fetchRange', { id: 's', range: RANGE, options: { concurrency: 50 } }, 'attribute-invalid');
    await fails(env, 'fetchRange', { id: 'none', range: RANGE }, 'source-not-found');
    expect(env.ctx.job).toBeUndefined();
  });
});

describe('固定分の上限（§7.1・R55・第 1 回 M8）', () => {
  it('cacheMaxBytes が 3 枚分の Source で 20 枚の範囲 → 3 枚目のバッチの後で stop（quota）', async () => {
    const env = await setup();
    await ok(env, 'register', { ...SOURCE, cacheMaxBytes: 9 });
    await ok(env, 'fetchRange', { id: 's', range: { box: SOURCE.box, minZoom: 1, maxZoom: 2 }, options: { concurrency: 1 } });
    await settle(env);
    const [stop] = messages(env, 'stop');
    expect(stop).toMatchObject({ code: 'quota', processed: 3, total: 20 });
    expect(env.h.fetch).toHaveBeenCalledTimes(3);
    const [region] = await env.store.listRegions('s');
    expect(region).toMatchObject({ status: 'stopped', code: 'quota' });
  });
});

describe('直列の外・range の写し・asset・資格情報', () => {
  it('estimate・regions は直列の外（register を待たない）', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    env.h.fetch.mockImplementation(async (r: Request) => {
      if (r.url.startsWith('https://st.example/')) await gate;
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const reg = env.post('register', { kind: 'style', id: 'st', url: 'https://st.example/style.json' });
    await vi.waitFor(() => expect(env.h.fetch).toHaveBeenCalled());
    expect(await ok(env, 'estimate', { id: 's', range: RANGE })).toEqual({ tiles: 5 });
    expect(await ok(env, 'regions', { id: 's' })).toEqual([]);
    release();
    await reg;
  });

  it('RegionInfo.range に利用者のオブジェクトの余分な項目が入らない', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    const info = await ok(env, 'fetchRange', { id: 's', range: { box: { ...RANGE.box, z: 9 }, minZoom: 1, maxZoom: 2, extra: 'x' } });
    expect(info.range).toEqual(RANGE);
    await settle(env);
    expect((await ok(env, 'regions', { id: 's' }))[0].range).toEqual(RANGE);
    expect((await env.store.getRegion(info.id))!.range).toEqual(RANGE);
  });

  it("kind: 'asset' の fetchRange('all') で Resource が固定され、'all' 以外は attribute-invalid。estimate は 0（R52）", async () => {
    const env = await setup();
    const D = 'https://d.example/a.json';
    env.h.fetch.mockImplementation(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    await ok(env, 'register', { kind: 'asset', id: 'a', url: D });
    expect(await ok(env, 'estimate', { id: 'a', range: 'all' })).toEqual({ tiles: 0 });
    const e = await fails(env, 'fetchRange', { id: 'a', range: RANGE }, 'attribute-invalid');
    expect(e.detail).toEqual({ attribute: 'range' });
    await ok(env, 'fetchRange', { id: 'a', range: 'all' });
    await settle(env);
    expect(fetched(env)).toEqual([D]);
    expect((await env.store.getEntry(`${D}\0`))!.meta.pinned).toBe(1);
    expect(messages(env, 'finish')).toMatchObject([{ percent: 100, processed: 1, total: 0 }]);
  });

  it('資格情報: 上流の URL に access_token が付き、キー・regions()・イベントに無い。足さない相手のミラーには付かない（R3）', async () => {
    const env = await setup();
    const A = 'https://a.example/{z}/{x}/{y}.png';
    const B = 'https://b.example/{z}/{x}/{y}.png';
    await ok(env, 'register', { kind: 'raster', id: 'A', url: `${A}?access_token=pk.secret` });
    await ok(env, 'register', { kind: 'raster', id: 'B', url: [A, B] });
    const one = { box: { minX: 0, maxX: 1, minY: 0, maxY: 0 }, minZoom: 1, maxZoom: 1 };
    await ok(env, 'fetchRange', { id: 'A', range: one });
    await settle(env);
    expect(fetched(env).every((u) => new URL(u).searchParams.get('access_token') === 'pk.secret')).toBe(true);
    for (const e of await env.store.entriesAtZoom(A, 1)) expect(e.key).not.toContain('pk.secret');
    expect(JSON.stringify(await ok(env, 'regions', { id: 'A' }))).not.toContain('pk.secret');
    expect(JSON.stringify(messages(env))).not.toContain('pk.secret');
    // B の b.example のミラーを選ぶ（m3 R5: そのオリジンの Source は資格情報を持たない）。Resource は A と共有なので別のタイルで見る
    env.h.fetch.mockClear();
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    await ok(env, 'fetchRange', { id: 'B', range: { box: { minX: 0, maxX: 1, minY: 1, maxY: 1 }, minZoom: 1, maxZoom: 1 } });
    await settle(env);
    expect(fetched(env)).toEqual(['https://b.example/1/0/1.png', 'https://b.example/1/1/1.png']);
  });
});

describe('enumerate・tileAt（R-tms・第 1 回 L）', () => {
  /** 種を固定した乱数（mulberry32） */
  const rng = (seed: number) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const policy = { cacheTtl: 1, store: true, outOfRange: { extent: 'transparent' as const, zoom: 'transparent' as const }, credentialParams: [] };

  it('tileAt(n) は enumerate の n 番目（種を固定した 100 回）。z 昇順で重ならない', () => {
    const r = rng(42);
    const int = (n: number) => Math.floor(r() * n);
    for (let round = 0; round < 100; round++) {
      const maxZoom = 1 + int(4);
      const last = Math.pow(2, maxZoom) - 1;
      const box = () => {
        const a = int(last + 1); const b = int(last + 1); const c = int(last + 1); const d = int(last + 1);
        return { minX: Math.min(a, b), maxX: Math.max(a, b), minY: Math.min(c, d), maxY: Math.max(c, d) };
      };
      const extents = Array.from({ length: 1 + int(2) }, () => {
        const ez = int(maxZoom + 1);
        const elast = Math.pow(2, ez) - 1;
        const a = int(elast + 1); const b = int(elast + 1);
        return { minZoom: int(ez + 1), maxZoom: ez, box: { minX: Math.min(a, b), maxX: Math.max(a, b), minY: 0, maxY: elast }, sourceId: 's' };
      });
      const resource: ResourceMeta = {
        id: 'r', type: 'tile', templates: [TPL], sourceIds: ['s'], policy, extents, scheme: r() < 0.5 ? 'xyz' : 'tms',
        count: 0, bytes: 0, pinnedBytes: 0,
      };
      const normalized = { kind: 'boxes' as const, boxes: [box(), box()], minZoom: int(maxZoom + 1), maxZoom };
      const all = [...enumerate(resource, normalized)];
      const seen = new Set(all.map((t) => t.join('/')));
      expect(seen.size).toBe(all.length);
      for (let i = 1; i < all.length; i++) expect(all[i][0]).toBeGreaterThanOrEqual(all[i - 1][0]);
      for (let i = 0; i < all.length; i++) expect(tileAt(resource, normalized, i)).toEqual(all[i]);
      expect(tileAt(resource, normalized, all.length)).toBeUndefined();
      // 範囲と Resource の範囲の両方に入る（tms は Resource の座標に直してから比べる）
      for (const [z, x, y] of all) {
        const yy = resource.scheme === 'tms' ? Math.pow(2, z) - 1 - y : y;
        expect(normalized.boxes.some((b) => {
          const s = scaleTileBox(b, maxZoom, z);
          return x >= s.minX && x <= s.maxX && yy >= s.minY && yy <= s.maxY;
        })).toBe(true);
        expect(extents.some((e) => z >= e.minZoom && z <= e.maxZoom)).toBe(true);
      }
    }
  });
});

// ---- m4-t6 PR #107 レビュー L3（追記のみ） ----
describe('固定分の上限: 全体上限（m4-t6・PR #107 L3）', () => {
  it('setLimits の maxBytes が 3 枚分のとき、固定が上限に届いた後の fetchRange は stop（quota）', async () => {
    const env = await setup();
    await ok(env, 'register', SOURCE);
    await ok(env, 'setLimits', { maxBytes: 9 });
    await ok(env, 'fetchRange', { id: 's', range: { box: SOURCE.box, minZoom: 1, maxZoom: 2 }, options: { concurrency: 1 } });
    await settle(env);
    const [stop] = messages(env, 'stop');
    expect(stop).toMatchObject({ code: 'quota', processed: 3, total: 20 });
    expect(env.h.fetch).toHaveBeenCalledTimes(3);
    const [region] = await env.store.listRegions('s');
    expect(region).toMatchObject({ status: 'stopped', code: 'quota' });
  });
});
