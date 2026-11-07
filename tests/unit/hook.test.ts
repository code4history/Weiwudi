// src/hook.ts の試験（m2-t7・仕様 §4.2・§4.3・§10）。ハーネスの dispatch・flushRoutes・BroadcastChannel で確かめる。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createSwHarness, type SwHarness } from './sw-harness';
import { createContext, type Context } from '../../src/context';
import { GATE_WAIT_MS, installHook, isCandidate, tableChanged } from '../../src/hook';
import { applyRegister, credentialSourceFor } from '../../src/registry';
import { normalizeSpec } from '../../src/spec';
import { openStore, type ResourceMeta, type Store } from '../../src/store';
import type { RouteHandlerCallback } from 'workbox-core';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const TPL = 'https://t.example/{z}/{x}/{y}.png';
const TILE = 'https://t.example/3/1/2.png';

const png = (status = 200) => new Response(new Uint8Array([1, 2, 3]), { status, headers: { 'content-type': 'image/png' } });

/** 同じ factory の別の SW の文脈（ルートは登録しない。登録を処理する側） */
const otherSw = (): Context => {
  const ctx = createContext();
  installHook(ctx, () => undefined, { pickCredentialSource: credentialSourceFor });
  return ctx;
};

const register = async (ctx: Context, spec: Record<string, unknown>) => {
  const r = await applyRegister(await ctx.store(), normalizeSpec({ kind: 'raster', ...spec }));
  return { ...r, tableWarnings: await tableChanged(ctx) };
};

/** ハーネスの表を読み込ませる（門番に候補を 1 つ通す） */
const warm = async (h: SwHarness) => {
  await h.flushRoutes();
  await h.dispatch('https://warm.example/');
};

const harness = (opts: { factory?: IDBFactory } = {}) => {
  const h = createSwHarness(opts);
  h.fetch.mockImplementation(async () => png());
  return h;
};

/** mode・destination を差し替えた要求（Node の Request は navigate を作れない） */
const withMode = (url: string, mode: string, destination = '') => {
  const r = new Request(url);
  Object.defineProperty(r, 'mode', { value: mode });
  Object.defineProperty(r, 'destination', { value: destination });
  return r;
};

describe('候補の条件（仕様 §4.3）', () => {
  it('GET・navigate でない・destination が空か image', () => {
    expect(isCandidate(new Request(TILE))).toBe(true);
    expect(isCandidate(withMode(TILE, 'no-cors', 'image'))).toBe(true);
    expect(isCandidate(withMode(TILE, 'navigate', 'document'))).toBe(false);
    expect(isCandidate(withMode(TILE, 'navigate', ''))).toBe(false);
    expect(isCandidate(withMode(TILE, 'no-cors', 'script'))).toBe(false);
    expect(isCandidate(withMode(TILE, 'cors', 'style'))).toBe(false);
    expect(isCandidate(new Request(TILE, { method: 'POST', body: 'x' }))).toBe(false);
  });
});

describe('ルートの登録順（仕様 §4.3）', () => {
  it('旧 API・制御（POST）・照合・利用者のルート・門番の順。旧 API の GET RegExp ルートはちょうど 1 本', async () => {
    const h = harness();
    const user = vi.fn(async () => new Response('user'));
    h.registerRoute(/^https:\/\/user\.example\//, user, 'GET');
    expect(h.routes).toHaveLength(4);
    await h.flushRoutes();
    expect(h.routes).toHaveLength(5);
    expect(h.routes[0].capture).toBe(h.capture);
    expect(h.routes[1].method).toBe('POST');
    expect(typeof h.routes[2].capture).toBe('function');
    expect(String(h.routes[3].capture)).toBe(String(/^https:\/\/user\.example\//));
    expect(typeof h.routes[4].capture).toBe('function');
    expect(h.routes.filter((r) => r.capture instanceof RegExp && r.method === 'GET')).toHaveLength(2);
    expect(h.routes.filter((r) => r.method !== 'GET')).toEqual([h.routes[1]]);
  });
});

describe('門番と照合ルート', () => {
  it('門番が表の読み込みを待って当て、読み込み後は照合ルートが当てる（門番は何も受けない）', async () => {
    const h = harness();
    const ctx = createContext();
    await applyRegister(await ctx.store(), normalizeSpec({ kind: 'raster', url: TPL }));
    await h.flushRoutes();
    const gate = vi.spyOn(h.routes[3], 'handle');
    const match = vi.spyOn(h.routes[2], 'handle');
    const first = await h.dispatch(TILE);
    expect(first!.headers.get('x-weiwudi-status')).toBe('miss');
    expect(gate).toHaveBeenCalledTimes(1);
    expect(match).not.toHaveBeenCalled();
    const second = await h.dispatch(TILE);
    expect(second!.headers.get('x-weiwudi-status')).toBe('hit');
    expect(match).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('外れは素通し（元の Request のまま fetch）', async () => {
    const h = harness();
    await h.flushRoutes();
    const req = new Request('https://other.example/a.js');
    await h.dispatch(req);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][0]).toBe(req);
  });

  it('利用者のルートが門番より先に当たり、表を読み込まない', async () => {
    const h = harness();
    h.registerRoute(/^https:\/\/t\.example\//, async () => new Response('precache'), 'GET');
    const open = vi.spyOn(h.factory, 'open');
    await h.flushRoutes();
    expect(await (await h.dispatch(TILE))!.text()).toBe('precache');
    expect(open).not.toHaveBeenCalled();
  });

  it('同時の要求で読み込みは 1 回', async () => {
    const h = harness();
    const ctx = createContext();
    await applyRegister(await ctx.store(), normalizeSpec({ kind: 'raster', url: TPL }));
    const { IDBObjectStore } = await import('fake-indexeddb');
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    await h.flushRoutes();
    // m4-t2: この試験は照合表の読み込みだけを数える。waitUntil の無いイベントで保守の走査を分ける。
    await Promise.all([TILE, 'https://t.example/3/1/3.png', 'https://x.example/']
      .map(url => h.dispatch(url, { event: {} })));
    const resourceReads = getAll.mock.instances.filter((s) => (s as unknown as { name: string }).name === 'resources');
    expect(resourceReads).toHaveLength(1);
  });

  it('3 秒の上限（偽の時計）: 読み込みが終わらなければ素通しし、次は間隔を空けてやり直す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = harness();
    // open が終わらない（blocked のまま）
    const open = vi.spyOn(h.factory, 'open').mockImplementation(() => ({}) as IDBOpenDBRequest);
    await h.flushRoutes();
    const req = new Request(TILE);
    const pending = h.dispatch(req);
    await vi.advanceTimersByTimeAsync(GATE_WAIT_MS - 1);
    expect(h.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][0]).toBe(req);
    expect(open).toHaveBeenCalledTimes(1);
    // やり直しの間隔（1 秒）の中は門番も受けない（待たずに素通し）
    expect(await h.dispatch(TILE)).toBeUndefined();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    // 間隔を過ぎると門番がまた受け、読み込みをやり直して最大 3 秒待つ
    await vi.advanceTimersByTimeAsync(1000);
    const again = h.dispatch(TILE);
    await vi.advanceTimersByTimeAsync(GATE_WAIT_MS - 1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await again;
    expect(h.fetch).toHaveBeenCalledTimes(2);
    // 2 回目も上限越えなので、間隔は 2 秒に延びる
    await vi.advanceTimersByTimeAsync(1999);
    expect(await h.dispatch(TILE)).toBeUndefined();
  });

  it('読み込みの失敗が続くと間隔が 1 秒から倍々に 30 秒まで延び、失敗の間は待たずに素通し', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness();
    const open = vi.spyOn(h.factory, 'open').mockImplementation(() => { throw new DOMException('no', 'UnknownError'); });
    await h.flushRoutes();
    const gaps: number[] = [];
    let last = Date.now();
    for (let i = 0; i < 8; i++) {
      // 次に門番が受けるまで 100ms ずつ進める
      for (;;) {
        const before = open.mock.calls.length;
        const res = await h.dispatch(TILE);
        if (open.mock.calls.length > before) {
          expect(res).toBeDefined(); // 失敗した要求も素通しで返る
          gaps.push(Date.now() - last);
          last = Date.now();
          break;
        }
        expect(res).toBeUndefined();
        vi.setSystemTime(Date.now() + 100);
      }
    }
    expect(gaps.slice(1)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('navigate と script には、門番も照合ルートも触らない（第 1 回 O-8）', async () => {
    const h = harness();
    const ctx = createContext();
    await applyRegister(await ctx.store(), normalizeSpec({ kind: 'raster', url: TPL }));
    const open = vi.spyOn(h.factory, 'open');
    await h.flushRoutes();
    expect(await h.dispatch(withMode(TILE, 'navigate', 'document'))).toBeUndefined();
    expect(await h.dispatch(withMode(TILE, 'no-cors', 'script'))).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    await warm(h);
    expect(await h.dispatch(withMode(TILE, 'navigate', 'document'))).toBeUndefined();
    expect(await h.dispatch(withMode(TILE, 'no-cors', 'script'))).toBeUndefined();
    expect((await h.dispatch(withMode(TILE, 'no-cors', 'image')))!.headers.get('x-weiwudi-status')).toBe('miss');
  });
});

describe('Range つきの要求（仕様 §11・t4・t5 の申し送り）', () => {
  it('照合しても serve に入れず、元の Request のまま素通し（保存しない・範囲外の判定より前）', async () => {
    const h = harness();
    const ctx = createContext();
    // ズーム 3 は範囲外の登録。Range つきは範囲外の応答にもならない
    await applyRegister(await ctx.store(), normalizeSpec({ kind: 'raster', url: TPL, minZoom: 0, maxZoom: 2 }));
    await warm(h);
    h.fetch.mockReset();
    h.fetch.mockImplementation(async () => new Response('ab', { status: 206, headers: { 'content-range': 'bytes 0-1/10' } }));
    const req = new Request(TILE, { headers: { range: 'bytes=0-1' } });
    const res = await h.dispatch(req);
    expect(res!.status).toBe(206);
    expect(h.fetch.mock.calls[0][0]).toBe(req);
    const all = await (await ctx.store()).listResources();
    expect(all.every((r: ResourceMeta) => r.count === 0)).toBe(true);
  });

  it('素通しのネットワーク失敗は 404・offline-miss・x-weiwudi-error: network・expose（旧 API と同じ形）', async () => {
    const h = harness();
    const ctx = createContext();
    await applyRegister(await ctx.store(), normalizeSpec({ kind: 'raster', url: TPL }));
    await warm(h);
    h.fetch.mockRejectedValue(new TypeError('offline'));
    const res = await h.dispatch(new Request(TILE, { headers: { range: 'bytes=0-1' } }));
    expect(res!.status).toBe(404);
    expect(res!.headers.get('x-weiwudi-status')).toBe('offline-miss');
    expect(res!.headers.get('x-weiwudi-error')).toBe('network');
    expect(res!.headers.get('access-control-expose-headers')).toBe('x-weiwudi-status, x-weiwudi-error');
  });
});

describe('2 つの SW（同じ factory。第 1 回 S1 の対照）', () => {
  it('片方の登録がもう片方の表に届き、bus.disable() にすると届かない', async () => {
    const factory = new IDBFactory();
    const b = harness({ factory });
    await warm(b);
    expect(await b.dispatch(TILE)).toBeUndefined();

    const a = otherSw();
    await register(a, { url: TPL });
    await vi.waitFor(async () => {
      const res = await b.dispatch(TILE);
      expect(res?.headers.get('x-weiwudi-status')).toBe('miss');
    });
  });

  it('bus.disable() の対照: 届かなければ、もう片方の表は古いまま（捕捉しない）', async () => {
    const factory = new IDBFactory();
    const b = harness({ factory });
    await warm(b);
    b.bus.disable();
    const a = otherSw();
    await register(a, { url: TPL });
    // 母線が届けば b の表の作り直しが終わるだけの時間を待ってから見る（待たずに見ると、届いても古い表のまま偽の緑。m2-t7 Minor 1）
    await new Promise((r) => setTimeout(r, 100));
    expect(b.bus.delivered).toBe(0);
    for (let i = 0; i < 5; i++) expect(await b.dispatch(TILE)).toBeUndefined();
    // 処理した SW 自身の表は即時に作り直されている
    expect(a.table.current!.table.match(new URL(TILE))).not.toBeNull();
  });
});

describe('読み込み中の表の更新', () => {
  it('読み込みの途中で { type: table } が届いたら、古い世代で読んだ表を捨てて読み直す', async () => {
    harness();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let first = true;
    // 最初の listResources は登録の前に読み、返すのを止めておく（古い世代の読み込み）
    const ctxB = createContext(async () => {
      const s = await openStore();
      const wrapped: Store = {
        ...s,
        listResources: async () => {
          const r = await s.listResources();
          if (first) {
            first = false;
            await held;
          }
          return r;
        },
      };
      return wrapped;
    });
    const handlers: RouteHandlerCallback[] = [];
    installHook(ctxB, (_c, h) => { handlers.push(h); }, { pickCredentialSource: credentialSourceFor });
    await Promise.resolve();
    expect(handlers).toHaveLength(2);
    const gate = handlers[1];
    const pending = gate({ url: new URL(TILE), request: new Request(TILE), event: undefined as never } as never);
    await vi.waitFor(() => expect(first).toBe(false));

    const a = otherSw();
    await register(a, { url: TPL });
    await vi.waitFor(() => expect(ctxB.table.generation).toBe(1));
    release();
    await pending;
    await vi.waitFor(() => expect(ctxB.table.current?.table.match(new URL(TILE))).toBeTruthy());
  });
});

describe('照合表の作り方', () => {
  it('旧 API の Resource（map:）と weiwudi.example.com のテンプレートは照合表に入らない', async () => {
    const h = harness();
    await h.request(`/api/add?mapID=m&type=xyz&url=${encodeURIComponent(TPL)}&width=1024&height=1024`);
    const ctx = otherSw();
    const store = await ctx.store();
    await store.createResource({
      id: 'pseudo', type: 'tile', templates: ['https://weiwudi.example.com/t/{z}/{x}/{y}.png'], sourceIds: [],
      policy: { cacheTtl: 1, store: true, outOfRange: { extent: 'transparent', zoom: 'transparent' }, credentialParams: [] },
      count: 0, bytes: 0, pinnedBytes: 0,
    });
    await tableChanged(ctx);
    expect((await store.listResources()).map((r) => r.id).sort()).toEqual(['map:m', 'pseudo']);
    expect(ctx.table.current!.table.size).toBe(0);
    await warm(h);
    expect(await h.dispatch('https://t.example/1/0/0.png')).toBeUndefined();
  });

  it('{y} と {-y}・{z}/{x} と {x}/{z} の影を warnings に出す', async () => {
    harness();
    const ctx = otherSw();
    await register(ctx, { id: 'a', url: 'https://s.example/{z}/{x}/{y}.png' });
    const r2 = await register(ctx, { id: 'b', url: 'https://s.example/{z}/{x}/{-y}.png' });
    expect(r2.tableWarnings).toEqual(['template-shadowed: https://s.example/{z}/{x}/{-y}.png']);
    const r3 = await register(ctx, { id: 'c', url: 'https://s.example/{x}/{z}/{y}.png' });
    expect(r3.tableWarnings).toEqual([
      'template-shadowed: https://s.example/{z}/{x}/{-y}.png',
      'template-shadowed: https://s.example/{x}/{z}/{y}.png',
    ]);
    // 影の側には当たらない（先に登録した a が当たる）
    expect(ctx.table.current!.table.match(new URL('https://s.example/2/1/1.png'))!.resourceId).toBe('https://s.example/{z}/{x}/{y}.png');
  });

  it('規則の順: 固定値のクエリ項目を持つ規則が、後の登録でも先に当たる（影の warnings は出さない）', async () => {
    harness();
    const ctx = otherSw();
    await register(ctx, { id: 'all', url: 'https://w.example/{z}/{x}/{y}.png' });
    const r = await register(ctx, { id: 'layer', url: 'https://w.example/{z}/{x}/{y}.png?layer=a' });
    expect(r.tableWarnings).toEqual([]);
    const t = ctx.table.current!.table;
    expect(t.match(new URL('https://w.example/1/0/0.png?layer=a'))!.resourceId).toBe('https://w.example/{z}/{x}/{y}.png?layer=a');
    expect(t.match(new URL('https://w.example/1/0/0.png?layer=b'))!.resourceId).toBe('https://w.example/{z}/{x}/{y}.png');
  });

  it('registry の書き換え（tableChanged）で、この SW の表がその場で作り直される', async () => {
    harness();
    const ctx = otherSw();
    await tableChanged(ctx);
    expect(ctx.table.current!.table.size).toBe(0);
    await register(ctx, { url: TPL });
    expect(ctx.table.current!.table.size).toBe(1);
  });
});

describe('資格情報（仕様 §10・I2・t6 の申し送り）', () => {
  const A = 'https://a.example/{z}/{x}/{y}.png';
  const B = 'https://b.example/{z}/{x}/{y}.png';

  const setup = async () => {
    const factory = new IDBFactory();
    harness({ factory });
    const ctx = otherSw();
    // 1 つの Resource に合流する 2 つの Source。A は a だけ・B は a と b。資格情報は別々
    await register(ctx, { id: 'A', url: A, credentials: { query: { key: 'KA' } } });
    const r = await register(ctx, { id: 'B', url: [A, B], credentials: { query: { key: 'KB' } } });
    expect(r.resources).toHaveLength(1);
    // 配信する SW は登録の後に起こす（表を最初の要求で読む。母線の作り直しの完了を待たない）
    const h = harness({ factory });
    await warm(h);
    return { h, ctx };
  };

  const sentUrl = (h: SwHarness, i: number) => new URL((h.fetch.mock.calls[i][0] as Request).url);

  it('I2: 要求のオリジンをテンプレートに持つ Source の資格情報だけを足す（別ホストへ送らない）', async () => {
    const { h } = await setup();
    h.fetch.mockClear();
    // ミラーは同じキーを持つので、別のタイルで見る
    await h.dispatch('https://b.example/1/0/0.png');
    await h.dispatch('https://a.example/1/1/0.png');
    expect(sentUrl(h, 0).searchParams.get('key')).toBe('KB');
    expect(sentUrl(h, 1).searchParams.get('key')).toBe('KA');
    for (const [req] of h.fetch.mock.calls) {
      const u = new URL((req as Request).url);
      if (u.host === 'b.example') expect(u.search).not.toContain('KA');
    }
  });

  it('putCredentials(id, {}) で空にした資格情報は無いものと数え、次の Source を選ぶ', async () => {
    const { h, ctx } = await setup();
    await (await ctx.store()).putCredentials('A', {});
    await tableChanged(ctx);
    await h.flushRoutes();
    // 母線で作り直されるまで、毎回別のタイルで確かめる（同じタイルは hit になる）
    let x = 0;
    await vi.waitFor(async () => {
      h.fetch.mockClear();
      await h.dispatch(`https://a.example/5/${x++}/0.png`);
      expect(sentUrl(h, 0).searchParams.get('key')).toBe('KB');
    });
  });

  it('資格情報を誰も持たなければ足さない', async () => {
    const h = harness();
    const ctx = otherSw();
    await register(ctx, { id: 'A', url: A });
    await warm(h);
    h.fetch.mockClear();
    await h.dispatch('https://a.example/1/0/0.png');
    expect(sentUrl(h, 0).search).toBe('');
  });

  it('要求の URL の資格情報はキーに残らない（§10・§5.3）', async () => {
    const h = harness();
    const ctx = otherSw();
    await register(ctx, { id: 'A', url: A });
    await warm(h);
    await h.dispatch('https://a.example/1/0/0.png?access_token=secret&v=2');
    const store = await ctx.store();
    const [res] = await store.listResources();
    expect(res.count).toBe(1);
    expect(await store.getEntry(`${A}\x001_0_0?v=2`)).toBeDefined();
  });

  it('認証付きの要求は保存せず、元の Request のまま（資格情報も足さない）', async () => {
    const { h, ctx } = await setup();
    h.fetch.mockClear();
    const req = new Request('https://a.example/4/0/0.png', { headers: { authorization: 'Bearer u' } });
    const res = await h.dispatch(req);
    expect(res!.headers.get('x-weiwudi-status')).toBe('miss');
    expect(h.fetch.mock.calls[0][0]).toBe(req);
    const [r] = await (await ctx.store()).listResources();
    expect(r.count).toBe(0);
  });
});
