// スタイルの範囲取得の試験（m4-t4・仕様 §7.2・§11・L4・R-G・R32・R53・第 1 回 M15）。range.test.ts と同じく、ハーネスで
// 大域（self・fetch・indexedDB）を差し替え、context と control を直接作る。上流は style.test.ts（m3-t7）と同じ形の偽で、
// オリジン＋パスで本体を引く。実ネットワークは使わない。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSwHarness, PAGE_CLIENT, PAGE_CLIENT_ID, SW_SELF_ORIGIN, type SwHarness } from './sw-harness';
import { createContext, type Context } from '../../src/context';
import { createControl } from '../../src/control';
import { installHook, serveResource } from '../../src/hook';
import { credentialSourceFor } from '../../src/registry';
import { createNotifier } from '../../src/range';
import type { ResourceMeta, Store } from '../../src/store';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const STYLE = 'https://s.example/styles/st.json';
const TJ = 'https://s.example/tiles/tj.json';
const VT = 'https://t.example/{z}/{x}/{y}.pbf';
const TJ_TILES = 'https://tj.example/{z}/{x}/{y}.pbf';
const GLYPHS = 'https://g.example/fonts/{fontstack}/{range}.pbf';
const SPRITE = 'https://s.example/sprites/s';
const DATA = 'https://d.example/points.geojson';
const IMAGE = 'https://i.example/a.png';
const CLIENT_ID = 'range-style-page';

const COMMON = ['0-255', '256-511', '8192-8447', '12288-12543', '65280-65535'];

const layers = [
  { id: 'l1', type: 'symbol', source: 'vt', layout: { 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'] } },
  { id: 'l2', type: 'symbol', source: 'vt', layout: { 'text-font': ['literal', ['Noto Sans Bold']] } },
  { id: 'l3', type: 'symbol', source: 'vt', layout: { 'text-font': ['get', 'font'] } },
  { id: 'l4', type: 'fill', source: 'vt' },
];

const styleOf = (sources: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ version: 8, sources, layers: [], ...over });

const FULL = styleOf({
  tj: { type: 'vector', url: TJ },
  vt: { type: 'vector', tiles: [VT] },
  gj: { type: 'geojson', data: DATA },
  img: { type: 'image', url: IMAGE, coordinates: [[0, 0], [1, 0], [1, 1], [0, 1]] },
}, { glyphs: GLYPHS, sprite: SPRITE, layers });

/** 日本の付近（z2 の x3・y1 を含む）。TileJSON の子は z2〜10 */
const TILEJSON = { tilejson: '3.0.0', tiles: [TJ_TILES], bounds: [139, 35, 140, 36], minzoom: 2, maxzoom: 10, scheme: 'tms' };

/** z0〜2 の、z2 の x3・y1 を含む範囲（vt は z0・z1・z2 の 3 枚、TileJSON の子は z2 の 1 枚） */
const RANGE = { box: { minX: 3, maxX: 3, minY: 1, maxY: 1 }, minZoom: 0, maxZoom: 2 };

const json = (body: unknown, type = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': type } });
const bin = (bytes: Uint8Array = new Uint8Array([1, 2, 3])) =>
  new Response(bytes.slice(), { status: 200, headers: { 'content-type': 'application/x-protobuf' } });

/** グリフの本体（fontstack・範囲・通し番号で決まる） */
const glyphBody = (fontstack: string, range: string, seq: number) => new TextEncoder().encode(`${fontstack}|${range}|${seq}`);

/** グリフの URL の fontstack と範囲 */
const glyphOf = (url: string): { fontstack: string; range: string } | undefined => {
  const m = /^https:\/\/g\.example\/fonts\/([^/]+)\/(\d+-\d+)\.pbf/.exec(url);
  return m ? { fontstack: decodeURIComponent(m[1]), range: m[2] } : undefined;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string; detail: Record<string, unknown> } };

interface Env {
  h: SwHarness;
  ctx: Context;
  store: Store;
  client: { id: string; url: string; type: string; postMessage: ReturnType<typeof vi.fn> };
  jobs: Promise<unknown>[];
  bodies: Map<string, () => Response | Promise<Response>>;
  /** 上流へ出たグリフの要求の通し番号（同じ URL の 2 回目は違う本体） */
  glyphSeq: Map<string, number>;
  /** グリフの要求ごとに呼ぶ（取り消しの試験） */
  onGlyph?: (g: { fontstack: string; range: string }) => void;
  post: (op: string, body?: unknown) => Promise<Reply>;
}

const setup = async (bodies: Record<string, unknown> = { [STYLE]: FULL, [TJ]: TILEJSON }): Promise<Env> => {
  const h = createSwHarness();
  const ctx = createContext();
  installHook(ctx, () => undefined, { pickCredentialSource: credentialSourceFor });
  ctx.notify = createNotifier(ctx);
  const control = createControl(ctx);
  const client = { id: CLIENT_ID, url: `${SW_SELF_ORIGIN}/index.html`, type: 'window', postMessage: vi.fn() };
  const jobs: Promise<unknown>[] = [];
  const env: Env = {
    h, ctx, store: await ctx.store(), client, jobs, glyphSeq: new Map(),
    bodies: new Map(Object.entries(bodies).map(([k, v]) => [k, () => json(v)])),
    post: async (op, body = {}) => {
      const url = new URL(`https://weiwudi.example.com/v2/${op}`);
      const request = new Request(url, {
        method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body),
      });
      const event = { clientId: CLIENT_ID, waitUntil: (p: Promise<unknown>) => { jobs.push(Promise.resolve(p)); } };
      return (await control.post({ url, request, event } as never)).json();
    },
  };
  h.fetch.mockImplementation(async (req: Request | string) => {
    const href = typeof req === 'string' ? req : req.url;
    const u = new URL(href);
    const g = glyphOf(href);
    if (g) {
      env.onGlyph?.(g);
      const seq = (env.glyphSeq.get(href) ?? 0) + 1;
      env.glyphSeq.set(href, seq);
      return bin(glyphBody(g.fontstack, g.range, seq));
    }
    const f = env.bodies.get(u.origin + u.pathname);
    return f ? f() : bin();
  });
  h.self.clients.get.mockImplementation(async (id: unknown) => {
    if (id === CLIENT_ID) return client;
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

const settle = async (env: Env) => {
  while (env.jobs.length > 0) await Promise.all(env.jobs.splice(0));
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const messages = (env: Env, type?: string): any[] =>
  env.client.postMessage.mock.calls.map((c) => c[0]).filter((m) => type === undefined || m.type === type);

const fetched = (env: Env): string[] => env.h.fetch.mock.calls.map(([r]) => (typeof r === 'string' ? r : (r as Request).url));

const glyphFetches = (env: Env) => fetched(env).map(glyphOf).filter((g): g is { fontstack: string; range: string } => !!g);

const resourceOfType = async (env: Env, type: ResourceMeta['type']): Promise<ResourceMeta[]> =>
  (await env.store.listResources()).filter((r) => r.type === type);

const glyphKey = async (env: Env, fontstack: string) => `${(await resourceOfType(env, 'glyph'))[0].id}\0${fontstack}`;

/** グリフのレコードの範囲ごとの本体 */
const glyphParts = async (env: Env, fontstack: string): Promise<Record<string, string>> => {
  const got = await env.store.getEntry(await glyphKey(env, fontstack));
  if (!got) return {};
  const data = new Uint8Array(await got.body.blob.arrayBuffer());
  const out: Record<string, string> = {};
  for (const [name, p] of Object.entries(got.body.parts ?? {})) {
    out[name] = new TextDecoder().decode(data.slice(p.offset, p.offset + p.length));
  }
  return out;
};

const register = async (env: Env, extra: Record<string, unknown> = {}) => {
  await ok(env, 'register', { kind: 'style', id: 'st', url: STYLE, ...extra });
  env.h.fetch.mockClear();
};

describe('スタイルの fetchRange（§7.2・m4-t4）', () => {
  it('style・tilejson・tile・glyph・sprite（4 つ）・data が全部 Entry になり、固定される', async () => {
    const env = await setup();
    await register(env);
    await ok(env, 'fetchRange', { id: 'st', range: RANGE });
    await settle(env);
    expect(messages(env, 'finish')).toHaveLength(1);
    expect(messages(env, 'finish')[0]).toMatchObject({ error: 0 });
    const resources = await env.store.listResources();
    expect(resources.map((r) => r.type).sort()).toEqual(['data', 'data', 'glyph', 'sprite', 'style', 'tile', 'tile', 'tilejson']);
    for (const r of resources) {
      expect({ id: r.id, has: r.count > 0 }).toEqual({ id: r.id, has: true });
      expect({ id: r.id, pinnedBytes: r.pinnedBytes }).toEqual({ id: r.id, pinnedBytes: r.bytes });
    }
    // スプライトは 4 つ
    expect((await resourceOfType(env, 'sprite'))[0].count).toBe(4);
    expect(fetched(env).filter((u) => u.startsWith(SPRITE)).sort()).toEqual([
      `${SPRITE}.json`, `${SPRITE}.png`, `${SPRITE}@2x.json`, `${SPRITE}@2x.png`,
    ].sort());
    // グリフは fontstack ごとに 1 レコード（text-font のリテラル 2 つ。式は飛ぶ）
    expect((await resourceOfType(env, 'glyph'))[0].count).toBe(2);
  });
});

describe('グリフ（§11・L4・R32）', () => {
  it("fontstack 1 つ・'common' の 5 範囲で putGlyphParts が 1 回、evictScopesFor も 1 回、parts が 5 つ、各範囲の再生が上流の本体と同じ", async () => {
    const env = await setup({ [STYLE]: { ...FULL, layers: [layers[1]] }, [TJ]: TILEJSON });
    await register(env);
    const glyph = (await resourceOfType(env, 'glyph'))[0];
    // スタイルの取得を止めておき、計画の読み出しの後から数える（evictScopesFor は glyph の sourceIds の Source を読む）
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    env.bodies.set(STYLE, async () => {
      await gate;
      return json({ ...FULL, layers: [layers[1]] });
    });
    await ok(env, 'fetchRange', { id: 'st', range: RANGE, options: { pin: false } });
    const putMany = vi.spyOn(env.store, 'putGlyphParts');
    const putOne = vi.spyOn(env.store, 'putGlyphPart');
    const getSource = vi.spyOn(env.store, 'getSource');
    release();
    await settle(env);
    expect(putMany).toHaveBeenCalledTimes(1);
    expect(putOne).not.toHaveBeenCalled();
    expect(getSource.mock.calls.filter(([id]) => glyph.sourceIds.indexOf(id) >= 0)).toHaveLength(glyph.sourceIds.length);
    const parts = await glyphParts(env, 'Noto Sans Bold');
    expect(Object.keys(parts).sort()).toEqual([...COMMON].sort());
    for (const range of COMMON) expect(parts[range]).toBe(`Noto Sans Bold|${range}|1`);
  });

  it("'all' で 256 範囲、配列はそのまま。並びに同じ範囲が 2 つあれば後勝ち（L4）", async () => {
    const env = await setup({ [STYLE]: { ...FULL, layers: [layers[1]] }, [TJ]: TILEJSON });
    await register(env);
    await ok(env, 'fetchRange', { id: 'st', range: RANGE, options: { glyphRanges: 'all' } });
    await settle(env);
    const all = await glyphParts(env, 'Noto Sans Bold');
    expect(Object.keys(all)).toHaveLength(256);
    expect(all['0-255']).toBeDefined();
    expect(all['65280-65535']).toBeDefined();
    expect(all['256-511']).toBe('Noto Sans Bold|256-511|1');

    const env2 = await setup({ [STYLE]: { ...FULL, layers: [layers[1]] }, [TJ]: TILEJSON });
    await register(env2);
    const putMany = vi.spyOn(env2.store, 'putGlyphParts');
    await ok(env2, 'fetchRange', { id: 'st', range: RANGE, options: { glyphRanges: ['512-767', '0-255', '512-767'] } });
    await settle(env2);
    expect(putMany).toHaveBeenCalledTimes(1);
    expect(glyphFetches(env2).map((g) => g.range)).toEqual(['512-767', '0-255', '512-767']);
    expect(await glyphParts(env2, 'Noto Sans Bold')).toEqual({ '0-255': 'Noto Sans Bold|0-255|1', '512-767': 'Noto Sans Bold|512-767|2' });
  });

  it('グリフの単位の途中で cancel() → その fontstack の取れた範囲は書かれ、次の単位から止まる（第 1 回 M15）', async () => {
    const env = await setup({ [STYLE]: { ...FULL, layers: [] }, [TJ]: TILEJSON });
    await register(env);
    env.onGlyph = (g) => {
      if (g.fontstack === 'A' && g.range === '256-511') void env.post('cancel', { id: 'st' });
    };
    await ok(env, 'fetchRange', { id: 'st', range: RANGE, options: { fonts: ['A', 'B'], concurrency: 1 } });
    await settle(env);
    expect(messages(env, 'canceled')).toHaveLength(1);
    const gotA = glyphFetches(env).filter((g) => g.fontstack === 'A').map((g) => g.range);
    expect(gotA.length).toBeGreaterThanOrEqual(2);
    // 単位の途中で抜ける（範囲の間で取り消しを見る。PR #104 L1）
    expect(gotA.length).toBeLessThan(COMMON.length);
    expect(Object.keys(await glyphParts(env, 'A')).sort()).toEqual([...gotA].sort());
    expect(glyphFetches(env).filter((g) => g.fontstack === 'B')).toEqual([]);
    expect(await env.store.getEntry(await glyphKey(env, 'B'))).toBeUndefined();
    // 取り消しでも取れた分は固定する（region が有る）
    expect((await env.store.getEntry(await glyphKey(env, 'A')))!.meta.pinned).toBe(1);
  });

  it('flush が QuotaExceededError で失敗すると errors.quota が 1 増える（範囲の数ではない）', async () => {
    const env = await setup({ [STYLE]: { ...FULL, layers: [layers[1]] }, [TJ]: TILEJSON });
    await register(env);
    // m4-t6: 容量超過は 1 回だけ再試行するので、再試行も失敗させる（R16）
    vi.spyOn(env.store, 'putGlyphParts').mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError')).mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    await ok(env, 'fetchRange', { id: 'st', range: RANGE });
    await settle(env);
    const finish = messages(env, 'finish')[0];
    expect(finish).toMatchObject({ error: 1, errors: { quota: 1, storage: 0, network: 0, upstream: 0 } });
    const [region] = await ok(env, 'regions', { id: 'st' });
    expect(region).toMatchObject({ status: 'partial', error: 1, errors: { quota: 1 } });
  });

  it('fontstack は text-font のリテラルと fonts・StyleSpec.fonts の和。式は飛ぶ。名前 1 つの fonts はそのまま 1 つの fontstack', async () => {
    const env = await setup();
    await register(env, { fonts: ['Style Font Regular', 'Noto Sans Bold'] });
    await ok(env, 'fetchRange', { id: 'st', range: RANGE, options: { fonts: ['Noto Sans Regular', 'Open Sans Regular,Arial Unicode MS Regular'] } });
    await settle(env);
    const stacks = [...new Set(glyphFetches(env).map((g) => g.fontstack))].sort();
    expect(stacks).toEqual([
      'Noto Sans Bold', 'Noto Sans Regular', 'Open Sans Regular,Arial Unicode MS Regular', 'Style Font Regular',
    ]);
    // fontstack ごと・範囲ごとに 1 回
    expect(glyphFetches(env)).toHaveLength(4 * COMMON.length);
    expect(fetched(env)).toContain('https://g.example/fonts/Noto%20Sans%20Regular/0-255.pbf');
    expect(stacks).not.toContain('font');
  });

  it('既に有る範囲は上流へ出ず、無い範囲だけ足す。既に有る範囲だけのレコードも固定される', async () => {
    const env = await setup({ [STYLE]: { ...FULL, layers: [layers[1]] }, [TJ]: TILEJSON });
    await register(env);
    // ページの要求で 0-255 を先に持つ（照合ルートと同じ組み立て）
    const url = 'https://g.example/fonts/Noto%20Sans%20Bold/0-255.pbf';
    const hit = env.ctx.table.current!.table.match(new URL(url))!;
    const glyph = (await env.store.getResource(hit.resourceId))!;
    await (await serveResource(env.ctx, glyph, new Request(url), new URL(url), hit.m, undefined)).arrayBuffer();
    env.h.fetch.mockClear();
    await ok(env, 'fetchRange', { id: 'st', range: RANGE, options: { pin: false } });
    await settle(env);
    expect(glyphFetches(env).map((g) => g.range).sort()).toEqual(COMMON.filter((r) => r !== '0-255').sort());
    expect(Object.keys(await glyphParts(env, 'Noto Sans Bold')).sort()).toEqual([...COMMON].sort());
    expect((await env.store.getEntry(await glyphKey(env, 'Noto Sans Bold')))!.meta.pinned).toBe(0);

    env.h.fetch.mockClear();
    await ok(env, 'fetchRange', { id: 'st', range: RANGE });
    await settle(env);
    expect(glyphFetches(env)).toEqual([]);
    expect((await env.store.getEntry(await glyphKey(env, 'Noto Sans Bold')))!.meta.pinned).toBe(1);
  });
});

describe('枚数と進み（§7.2・R29）', () => {
  it('estimate と total はタイルだけ。タイルが残っている間は percent が 100 にならず、100 を超えない', async () => {
    const env = await setup();
    await register(env);
    const { tiles } = await ok(env, 'estimate', { id: 'st', range: RANGE });
    const info = await ok(env, 'fetchRange', { id: 'st', range: RANGE, options: { concurrency: 1 } });
    expect(info.total).toBe(tiles);
    await settle(env);
    const tileUrls = fetched(env).filter((u) => u.startsWith('https://t.example/') || u.startsWith('https://tj.example/'));
    expect(tileUrls).toHaveLength(tiles);
    expect(tiles).toBe(4);
    const proceed = messages(env, 'proceed');
    // 単位: style 1・tilejson 1・data 2・sprite 4・tile 4・glyph 2（fontstack）
    expect(proceed).toHaveLength(14);
    expect(proceed.every((m) => m.total === tiles && m.percent <= 100)).toBe(true);
    const lastTile = 1 + 1 + 2 + 4 + tiles - 1;
    proceed.slice(0, lastTile).forEach((m) => expect(m.percent).toBeLessThan(100));
    expect(proceed[lastTile].percent).toBe(100);
    for (let i = 1; i < proceed.length; i++) expect(proceed[i].percent).toBeGreaterThanOrEqual(proceed[i - 1].percent);
    expect(messages(env, 'finish')[0]).toMatchObject({ percent: 100, processed: 14, total: tiles });
    const [region] = await ok(env, 'regions', { id: 'st' });
    expect(region.total).toBe(tiles);
  });

  it('TileJSON の下のタイルの子も範囲の交差で取る。同じ Resource の子 2 つは 1 回', async () => {
    const style = styleOf({
      tj: { type: 'vector', url: TJ },
      a: { type: 'vector', tiles: [VT] },
      b: { type: 'vector', tiles: [VT] },
    }, { layers: [] });
    const env = await setup({ [STYLE]: style, [TJ]: TILEJSON });
    await register(env);
    await ok(env, 'fetchRange', { id: 'st', range: RANGE });
    await settle(env);
    // TileJSON の子（tms・z2〜10）は z2 の x3・y1（tms の y は 2）の 1 枚だけ
    expect(fetched(env).filter((u) => u.startsWith('https://tj.example/'))).toEqual(['https://tj.example/2/3/2.pbf']);
    const vt = fetched(env).filter((u) => u.startsWith('https://t.example/')).sort();
    expect(vt).toEqual(['https://t.example/0/0/0.pbf', 'https://t.example/1/1/0.pbf', 'https://t.example/2/3/1.pbf']);
  });

  it('スタイルが読めない（HTML）とき、スタイルの子だけ upstream に数えて他は取れる', async () => {
    const env = await setup();
    await register(env, { fonts: ['F'] });
    const styleRes = (await resourceOfType(env, 'style'))[0];
    await env.store.clearEntries(styleRes.id);
    env.bodies.set(STYLE, () => json('<!doctype html><title>login</title>', 'text/html'));
    await ok(env, 'fetchRange', { id: 'st', range: RANGE });
    await settle(env);
    expect(messages(env, 'finish')[0]).toMatchObject({ error: 1, errors: { upstream: 1, network: 0, quota: 0, storage: 0 } });
    expect((await env.store.getResource(styleRes.id))!.count).toBe(0);
    for (const r of await env.store.listResources()) {
      if (r.type === 'style') continue;
      expect({ id: r.id, has: r.count > 0 }).toEqual({ id: r.id, has: true });
    }
    // スタイルが読めなくても fonts の fontstack は取る
    expect([...new Set(glyphFetches(env).map((g) => g.fontstack))]).toEqual(['F']);
  });
});

// ---- PR #104 のレビュー（L2・L3）。追記のみ ----

describe('PR #104 のレビュー（L2・L3）', () => {
  it('保存済みのスタイルの取り直しが失敗しても（stale）、記録は固定され、失敗は 1 件に数える（L2）', async () => {
    const env = await setup({ [STYLE]: { ...FULL, layers: [layers[1]] }, [TJ]: TILEJSON });
    // cacheTtl: 0 で、保存済みのスタイルも上流へ出る
    await register(env, { cacheTtl: 0 });
    const styleRes = (await resourceOfType(env, 'style'))[0];
    expect(styleRes.count).toBe(1);
    env.bodies.set(STYLE, () => { throw new TypeError('Failed to fetch'); });
    await ok(env, 'fetchRange', { id: 'st', range: RANGE });
    await settle(env);
    expect(messages(env, 'finish')[0]).toMatchObject({ error: 1 });
    const r = (await env.store.getResource(styleRes.id))!;
    expect(r.count).toBe(1);
    expect(r.pinnedBytes).toBe(r.bytes);
    // 古い本体から fontstack を集めている
    expect([...new Set(glyphFetches(env).map((g) => g.fontstack))]).toEqual(['Noto Sans Bold']);
  });

  it('job.count はタイルの枚数で数える（job.total と同じ単位。L3）', async () => {
    const env = await setup({ [STYLE]: { ...FULL, layers: [layers[1]] }, [TJ]: TILEJSON });
    await register(env);
    const seen: [number, number][] = [];
    env.onGlyph = () => {
      const job = env.ctx.job!;
      seen.push([job.count, job.total]);
    };
    await ok(env, 'fetchRange', { id: 'st', range: RANGE, options: { concurrency: 1 } });
    await settle(env);
    expect(seen.length).toBeGreaterThan(0);
    // グリフはタイルの後。タイルを全部数え終えた count は total と同じで、超えない
    for (const [count, total] of seen) expect(count).toBe(total);
    expect(seen[0][1]).toBe(4);
  });
});
