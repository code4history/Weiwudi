// 範囲取得の CORS・認証の規則の試験（m4-t3・P6・R4。仕様 §4.5-3・§4.6 の文ごとに）。
// cors の取得（Request）と no-cors の確かめ（upstream.probeNoCors の fetch(文字列, init)）を偽の上流で分けて答える。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSwHarness, PAGE_CLIENT, PAGE_CLIENT_ID, SW_SELF_ORIGIN, opaqueResponse, type SwHarness } from './sw-harness';
import { createContext, type Context } from '../../src/context';
import { createControl } from '../../src/control';
import { installHook, serveResource } from '../../src/hook';
import { credentialSourceFor } from '../../src/registry';
import { createNotifier } from '../../src/range';
import type { Store } from '../../src/store';
import { normalizeSpec } from '../../src/spec';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const TPL = 'https://t.example/{z}/{x}/{y}.png';
const CLIENT_ID = 'range-page';
const SOURCE = { kind: 'raster', id: 's', url: TPL, box: { minX: 0, maxX: 3, minY: 0, maxY: 3 }, minZoom: 0, maxZoom: 2 };
/** z2 の 16 枚 */
const Z2 = { box: { minX: 0, maxX: 3, minY: 0, maxY: 3 }, minZoom: 2, maxZoom: 2 };
/** z1 の 1 枚と z2 の 4 枚 */
const SMALL = { box: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, minZoom: 1, maxZoom: 2 };

const png = (status = 200) => new Response(new Uint8Array([1, 2, 3]), { status, headers: { 'content-type': 'image/png' } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { ok: boolean; result?: any; error?: { code: string } };

interface Env {
  h: SwHarness;
  ctx: Context;
  store: Store;
  client: { id: string; url: string; type: string; postMessage: ReturnType<typeof vi.fn> };
  jobs: Promise<unknown>[];
  post: (op: string, body?: unknown) => Promise<Reply>;
}

/**
 * cors は cors(url)、no-cors の確かめは noCors(url) で答える（どちらも投げると TypeError）
 */
const setup = async (answer: { cors: (url: string) => Response; noCors: (url: string) => Response }): Promise<Env> => {
  const h = createSwHarness();
  h.fetch.mockImplementation(async (input: Request | string) => (typeof input === 'string' ? answer.noCors(input) : answer.cors(input.url)));
  const ctx = createContext();
  installHook(ctx, () => undefined, { pickCredentialSource: credentialSourceFor });
  ctx.notify = createNotifier(ctx);
  const control = createControl(ctx);
  const client = { id: CLIENT_ID, url: `${SW_SELF_ORIGIN}/index.html`, type: 'window', postMessage: vi.fn() };
  const jobs: Promise<unknown>[] = [];
  h.self.clients.get.mockImplementation(async (id: unknown) => (id === CLIENT_ID ? client : id === PAGE_CLIENT_ID ? PAGE_CLIENT : undefined));
  (h.self.clients as unknown as { matchAll: unknown }).matchAll = vi.fn(async () => [client]);
  return {
    h, ctx, store: await ctx.store(), client, jobs,
    post: async (op, body = {}) => {
      const url = new URL(`https://weiwudi.example.com/v2/${op}`);
      const request = new Request(url, { method: 'POST', body: JSON.stringify(body) });
      const event = { clientId: CLIENT_ID, waitUntil: (p: Promise<unknown>) => { jobs.push(Promise.resolve(p)); } };
      return (await control.post({ url, request, event } as never)).json();
    },
  };
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

const corsCalls = (env: Env) => env.h.fetch.mock.calls.filter(([r]) => typeof r !== 'string');
const noCorsCalls = (env: Env) => env.h.fetch.mock.calls.filter(([r]) => typeof r === 'string');

const typeError = (): Response => { throw new TypeError('Failed to fetch'); };

describe('§4.5-3 jobOpaqueStreak と 5 枚の確かめ', () => {
  it('実績の無い Resource で cors が TypeError・no-cors が opaque を 3 枚 → 5 枚の確かめ → 全部 opaque → stop（opaque）・opaque イベントが 1 回', async () => {
    const env = await setup({ cors: typeError, noCors: () => opaqueResponse() });
    await ok(env, 'register', SOURCE);
    await ok(env, 'fetchRange', { id: 's', range: Z2, options: { concurrency: 1 } });
    await settle(env);
    const [stop] = messages(env, 'stop');
    expect(stop).toMatchObject({ code: 'opaque', processed: 3, total: 16 });
    // 3 枚の取得と 5 枚の確かめ（cors と no-cors が 1 回ずつ）
    expect(corsCalls(env)).toHaveLength(8);
    expect(noCorsCalls(env)).toHaveLength(8);
    await vi.waitFor(() => expect(messages(env, 'opaque')).toEqual([{ type: 'opaque', sourceId: 's', resourceId: TPL }]));
    const [region] = await env.store.listRegions('s');
    expect(region).toMatchObject({ status: 'stopped', code: 'opaque', errors: { upstream: 3 } });
    // 範囲取得は照合ルートの corslessStreak を増やさない・corslessUntil を書かない
    expect(env.ctx.corslessStreak.size).toBe(0);
    expect((await env.store.getResource(TPL))!.corslessUntil).toBeUndefined();
  });

  it('確かめの 1 枚が cors を通る → corsOk が立ち続行。確かめで取れた 200 は保存され processed に入る', async () => {
    const LAST = 'https://t.example/2/3/3.png';
    const env = await setup({ cors: (u) => (u === LAST ? png() : typeError()), noCors: () => opaqueResponse() });
    await ok(env, 'register', SOURCE);
    // 無作為の 5 枚は全部 16 枚目（2/3/3）
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    await ok(env, 'fetchRange', { id: 's', range: Z2, options: { concurrency: 1 } });
    await settle(env);
    expect(messages(env, 'stop')).toEqual([]);
    const [finish] = messages(env, 'finish');
    expect(finish).toMatchObject({ processed: 16, total: 16, error: 15, errors: { upstream: 15, network: 0 } });
    expect((await env.store.getResource(TPL))!.corsOk).toBe(true);
    expect((await env.store.getEntry(`${TPL}\x002_3_3`))!.meta.pinned).toBe(1);
    // 確かめで取った 16 枚目は列挙で取り直さない
    expect(corsCalls(env).filter(([r]) => (r as Request).url === LAST)).toHaveLength(1);
  });

  it('全部が両方失敗 → stop（network）。両方失敗は jobOpaqueStreak を増やさない', async () => {
    let n = 0;
    const env = await setup({ cors: typeError, noCors: () => (++n <= 3 ? opaqueResponse() : typeError()) });
    await ok(env, 'register', SOURCE);
    await ok(env, 'fetchRange', { id: 's', range: Z2, options: { concurrency: 1 } });
    await settle(env);
    expect(messages(env, 'stop')).toMatchObject([{ code: 'network', processed: 3 }]);
    expect(messages(env, 'opaque')).toEqual([]);
  });

  it('両方失敗だけなら止まらず network に数えて進む', async () => {
    const env = await setup({ cors: typeError, noCors: typeError });
    await ok(env, 'register', SOURCE);
    await ok(env, 'fetchRange', { id: 's', range: SMALL, options: { concurrency: 1 } });
    await settle(env);
    expect(messages(env, 'finish')).toMatchObject([{ processed: 5, error: 5, errors: { network: 5, upstream: 0 } }]);
  });

  it('実績のある Resource では opaque を数えず upstream として進む', async () => {
    const env = await setup({ cors: typeError, noCors: () => opaqueResponse() });
    await ok(env, 'register', SOURCE);
    await env.store.patchResource(TPL, (m) => ({ ...m, corsOk: true }));
    await ok(env, 'fetchRange', { id: 's', range: SMALL, options: { concurrency: 1 } });
    await settle(env);
    expect(messages(env, 'stop')).toEqual([]);
    expect(messages(env, 'finish')).toMatchObject([{ processed: 5, error: 5, errors: { upstream: 5, network: 0 } }]);
    expect((await env.store.listRegions('s'))[0].status).toBe('partial');
  });
});

describe('§4.6 範囲取得の認証', () => {
  it('count === 0 で 401 が 3 回 → stop（upstream）', async () => {
    const env = await setup({ cors: () => png(401), noCors: () => opaqueResponse() });
    await ok(env, 'register', SOURCE);
    await ok(env, 'fetchRange', { id: 's', range: Z2, options: { concurrency: 1 } });
    await settle(env);
    expect(messages(env, 'stop')).toMatchObject([{ code: 'upstream', processed: 3 }]);
  });

  it('count > 0 なら 401 が続いても止まらない', async () => {
    let refuse = false;
    const env = await setup({ cors: () => (refuse ? png(401) : png()), noCors: () => opaqueResponse() });
    await ok(env, 'register', SOURCE);
    // 範囲の外のタイルを 1 枚保存しておく（count 1）
    const url = 'https://t.example/0/0/0.png';
    const hit = env.ctx.table.current!.table.match(new URL(url))!;
    await (await serveResource(env.ctx, (await env.store.getResource(TPL))!, new Request(url), new URL(url), hit.m, undefined)).arrayBuffer();
    refuse = true;
    await ok(env, 'fetchRange', { id: 's', range: SMALL, options: { concurrency: 1 } });
    await settle(env);
    expect(messages(env, 'stop')).toEqual([]);
    expect(messages(env, 'finish')).toMatchObject([{ processed: 5, errors: { upstream: 5 } }]);
  });
});

describe('probeNoCors の要求', () => {
  it('no-cors の確かめに資格情報（クエリ・ヘッダ）を付けない。cors の取得には付く', async () => {
    const env = await setup({ cors: typeError, noCors: () => opaqueResponse() });
    await ok(env, 'register', { ...SOURCE, url: `${TPL}?access_token=pk.secret`, credentials: { headers: { 'x-key': 'k' } } });
    await ok(env, 'fetchRange', { id: 's', range: SMALL, options: { concurrency: 1 } });
    await settle(env);
    expect(noCorsCalls(env).length).toBeGreaterThan(0);
    for (const [url, init] of noCorsCalls(env)) {
      expect(url).not.toContain('access_token');
      expect(init).toEqual({ mode: 'no-cors', credentials: 'omit' });
    }
    for (const [r] of corsCalls(env)) {
      expect(new URL((r as Request).url).searchParams.get('access_token')).toBe('pk.secret');
      expect((r as Request).headers.get('x-key')).toBe('k');
    }
  });
});

describe('確かめの数え直しと固定（PR #102 L1・L2）', () => {
  it('確かめで取れたタイルが列挙で失敗と数えたものなら、その場で成功に数え直して固定する（L2）', async () => {
    const FIRST = 'https://t.example/2/0/0.png';
    let firstCalls = 0;
    const env = await setup({ cors: (u) => (u === FIRST && ++firstCalls >= 2 ? png() : typeError()), noCors: () => opaqueResponse() });
    await ok(env, 'register', SOURCE);
    // 無作為の 5 枚は 1〜5 枚目（1 枚目は列挙で失敗と数えた後で通る）
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await ok(env, 'fetchRange', { id: 's', range: Z2, options: { concurrency: 1 } });
    await settle(env);
    expect(messages(env, 'stop')).toEqual([]);
    expect(messages(env, 'finish')).toMatchObject([{ processed: 16, error: 15, errors: { upstream: 15, network: 0 } }]);
    expect((await env.store.getEntry(`${TPL}\x002_0_0`))!.meta.pinned).toBe(1);
  });

  it('確かめが stop を投げても、そのバッチで取れたタイルは固定する（L1）', async () => {
    // スタイルの 2 つの子: a.example（CORS なし）と b.example（取れる）。1 つ目のバッチに a の 3 枚と b の 1 枚が入る
    const A = 'https://a.example/{z}/{x}/{y}.png';
    const B = 'https://b.example/{z}/{x}/{y}.png';
    const env = await setup({ cors: (u) => (u.startsWith('https://b.example/') ? png() : typeError()), noCors: () => opaqueResponse() });
    const policy = normalizeSpec({ kind: 'raster', url: A }).spec.policy;
    const extent = (sourceId: string) => ({ minZoom: 0, maxZoom: 2, box: { minX: 0, maxX: 3, minY: 0, maxY: 3 }, sourceId });
    await env.store.putSource({
      id: 'p', kind: 'style', order: 1, warnings: [], createdAt: 1,
      spec: { kind: 'style', id: 'p', url: 'https://st.example/style.json', templates: ['https://st.example/style.json'], policy,
        children: [{ id: 'c1', logicalName: 'a', type: 'tile' }, { id: 'c2', logicalName: 'b', type: 'tile' }] },
    });
    for (const [id, tpl] of [['c1', A], ['c2', B]]) {
      await env.store.putSource({
        id, kind: 'child', parentId: 'p', order: 2, warnings: [], createdAt: 1,
        spec: { kind: 'child', type: 'tile', id, url: tpl, templates: [tpl], policy, extent: extent(id) },
      });
      await env.store.createResource({
        id: tpl, type: 'tile', templates: [tpl], sourceIds: [id], policy, extents: [extent(id)], scheme: 'xyz', count: 0, bytes: 0, pinnedBytes: 0,
      });
    }
    await ok(env, 'fetchRange', { id: 'p', range: { box: { minX: 0, maxX: 2, minY: 0, maxY: 0 }, minZoom: 2, maxZoom: 2 }, options: { concurrency: 4 } });
    await settle(env);
    expect(messages(env, 'stop')).toMatchObject([{ code: 'opaque', processed: 4 }]);
    expect((await env.store.getEntry(`${B}\x002_0_0`))!.meta.pinned).toBe(1);
  });
});
