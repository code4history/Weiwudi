// src/upstream.ts の試験（m2-t7・仕様 §4.5・§4.6・§10）。fake-indexeddb の上の実物の store.ts で確かめる。
// 試験名に節と項目を書く（計画 m2-t7）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createContext, type Context } from '../../src/context';
import { serve, type ServeInput, type UpstreamResult } from '../../src/core';
import { createUpstream, isAuthenticated, isStorable, probeNoCors, CORSLESS_PERIOD_MS } from '../../src/upstream';
import type { Credentials, EntryMeta, ResourceMeta, ResourcePolicy, Store } from '../../src/store';
import { opaqueResponse } from './sw-harness';

const T = 1_000_000_000;
const RID = 'https://t.example/{z}/{x}/{y}.png';
const TILE = 'https://t.example/1/0/0.png';
const KEY = `${RID}\x001_0_0`;

const POLICY: ResourcePolicy = {
  cacheTtl: 60_000,
  store: false,
  outOfRange: { extent: 'transparent', zoom: 'transparent' },
  credentialParams: ['access_token'],
};

const resource = (over: Partial<ResourceMeta> = {}): ResourceMeta => ({
  id: RID, type: 'tile', templates: [RID], sourceIds: ['s1'], policy: POLICY, count: 0, bytes: 0, pinnedBytes: 0, ...over,
});

let ctx: Context;
let store: Store;
let fetchMock: ReturnType<typeof vi.fn>;
let now = T;

/** 偽の opaque。serve は clone() を返すので、clone も opaque にする（実物の opaque の clone は opaque） */
const opq = (): Response => {
  const r = opaqueResponse();
  Object.defineProperty(r, 'clone', { value: () => opq() });
  return r;
};

const png = (status = 200, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array([1, 2, 3]), { status, headers: { 'content-type': 'image/png', ...headers } });

/** <img> の要求（no-cors・include。仕様 §2 の 4） */
const img = (url = TILE, init: RequestInit = {}) => new Request(url, { mode: 'no-cors', credentials: 'include', ...init });
/** fetch() の既定の要求（cors・same-origin） */
const xhr = (url = TILE, init: RequestInit = {}) => new Request(url, init);

const up = (request: Request, credentials?: Credentials) =>
  createUpstream(ctx, { resourceId: RID, original: request, credentials, now: () => now });

const call = (request: Request, hasEntry = false, credentials?: Credentials): Promise<UpstreamResult> =>
  up(request, credentials)(request, { hasEntry, requestChanged: false });

const sent = (i: number): Request => fetchMock.mock.calls[i][0] as Request;

const seed = async () => {
  const meta: EntryMeta = { key: KEY, resourceId: RID, size: 3, fetchedAt: T - 10_000_000, accessedAt: T, pinned: 0, contentType: 'image/png' };
  await store.putEntry(meta, { key: KEY, blob: new Blob([new Uint8Array([9, 9, 9])]), headers: { 'content-type': 'image/png' } }, []);
};

/** serve を通した配信（hook と同じ組み立て。storable は §4.6 の判定） */
const serveVia = (request: Request, policy: ResourcePolicy = POLICY, credentials?: Credentials) => {
  const input: ServeInput = {
    resourceId: RID, key: KEY, coord: { z: 1, x: 0, y: 0 }, request,
    storable: isStorable(request, policy), upstream: up(request, credentials),
  };
  return serve(ctx, input, () => now);
};

const meta = async () => (await store.getResource(RID))!;

beforeEach(async () => {
  now = T;
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  fetchMock = vi.fn(async () => png());
  vi.stubGlobal('fetch', fetchMock);
  ctx = createContext();
  store = await ctx.store();
  await store.createResource(resource());
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('§4.5 の表: 上流へ出す形', () => {
  it('§4.5 表-匿名 <img>（no-cors）の要求は mode: cors・credentials: same-origin に組み替える', async () => {
    const r = await call(img(TILE, { referrer: 'https://page.example/map' }));
    expect(r.kind).toBe('response');
    expect(sent(0).mode).toBe('cors');
    expect(sent(0).credentials).toBe('same-origin');
    expect(sent(0).url).toBe(TILE);
    expect(sent(0).referrer).toBe('https://page.example/map');
  });

  it('§4.5 表-匿名 cors・omit の要求も同じ形に組み替える', async () => {
    await call(xhr(TILE, { credentials: 'omit' }));
    expect(sent(0).mode).toBe('cors');
    expect(sent(0).credentials).toBe('same-origin');
  });

  it('§4.5 末尾 上流へ出る要求に If-None-Match・If-Modified-Since が無い（第 2 回 O20）', async () => {
    await call(xhr(TILE, { headers: { 'if-none-match': '"e"', 'if-modified-since': 'Mon, 01 Jan 2024 00:00:00 GMT', 'x-keep': '1' } }));
    expect(sent(0).headers.get('if-none-match')).toBeNull();
    expect(sent(0).headers.get('if-modified-since')).toBeNull();
    expect(sent(0).headers.get('x-keep')).toBe('1');
  });

  it('§4.5 末尾 no-cors の取り直しにも条件付きのヘッダを付けない', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('cors')).mockResolvedValueOnce(opq());
    await call(img(TILE, { headers: { 'if-none-match': '"e"' } }));
    expect(sent(1).mode).toBe('no-cors');
    expect(sent(1).headers.get('if-none-match')).toBeNull();
  });
});

describe('§4.6 認証付きの要求', () => {
  it('§4.6-1 Authorization のある要求は認証付き・元の Request のまま上流へ出す', async () => {
    const req = xhr(TILE, { headers: { authorization: 'Bearer x' } });
    expect(isAuthenticated(req)).toBe(true);
    const r = await call(req);
    expect(r.kind).toBe('response');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(0)).toBe(req);
  });

  it('§4.6-1 mode: cors かつ credentials: include は認証付き', () => {
    expect(isAuthenticated(xhr(TILE, { credentials: 'include' }))).toBe(true);
  });

  it('§4.6-1 <img> の credentials: include（no-cors）は認証付きにしない', () => {
    expect(isAuthenticated(img())).toBe(false);
    expect(isAuthenticated(xhr())).toBe(false);
  });

  it('§4.6-1 認証付きは TypeError でも no-cors で取り直さない（2〜4 を通らない）', async () => {
    const req = new Request(TILE, { mode: 'no-cors', headers: { authorization: 'Bearer x' } });
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const r = await call(req);
    expect(r.kind).toBe('network');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('§4.6-1 認証付きの取得は hasEntry を見ない（Entry の有無で上流への要求も結果も変わらない。t4 の申し送り）', async () => {
    const req = () => xhr(TILE, { credentials: 'include' });
    for (const status of [200, 401, 403, 500]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => png(status));
      const a = await call(req(), false);
      const b = await call(req(), true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect([a.kind, (a as { response: Response }).response.status]).toEqual([b.kind, (b as { response: Response }).response.status]);
    }
  });

  it('§4.6-1 認証付きは登録の資格情報を足さない（元の Request のまま）', async () => {
    const req = xhr(TILE, { headers: { authorization: 'Bearer user' } });
    await call(req, false, { query: { access_token: 'reg' }, headers: { 'x-api-key': 'reg' } });
    expect(sent(0).url).toBe(TILE);
    expect(sent(0).headers.get('x-api-key')).toBeNull();
  });

  it('§4.6-2 cachePrivate が無ければ認証付きは保存しない・あれば保存する', async () => {
    const req = () => xhr(TILE, { credentials: 'include' });
    expect(isStorable(req(), POLICY)).toBe(false);
    expect(isStorable(req(), { ...POLICY, store: true })).toBe(true);
    const res = await serveVia(req());
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect((await meta()).count).toBe(0);
    await store.patchResource(RID, (m) => ({ ...m, policy: { ...m.policy, store: true } }));
    const res2 = await serveVia(req(), { ...POLICY, store: true });
    expect(res2.headers.get('x-weiwudi-status')).toBe('miss');
    expect((await meta()).count).toBe(1);
  });

  it('§4.6-3 登録の資格情報で足したものは認証付きに当たらず保存する', async () => {
    const res = await serveVia(img(), POLICY, { headers: { authorization: 'Bearer reg' }, query: { access_token: 'q' } });
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect(sent(0).headers.get('authorization')).toBe('Bearer reg');
    expect(new URL(sent(0).url).searchParams.get('access_token')).toBe('q');
    expect((await meta()).count).toBe(1);
  });

  it('§4.6-4 同一オリジンの既定（credentials: same-origin）の要求は匿名として保存する（第 2 回 O20）', async () => {
    const req = xhr('https://t.example/1/0/0.png', { credentials: 'same-origin' });
    expect(isAuthenticated(req)).toBe(false);
    expect(isStorable(req, POLICY)).toBe(true);
    await serveVia(req);
    expect((await meta()).count).toBe(1);
  });
});

describe('§10 資格情報を足す（R5）', () => {
  it('§10 要求に無いときだけ足す（名前は大文字小文字を問わない）。他のクエリの符号化を変えない', async () => {
    await call(img('https://t.example/1/0/0.png?a=%20b&ACCESS_TOKEN=page'), false,
      { query: { access_token: 'reg', extra: 'v' }, headers: { 'x-k': 'reg' } });
    expect(sent(0).url).toBe('https://t.example/1/0/0.png?a=%20b&ACCESS_TOKEN=page&extra=v');
    expect(sent(0).headers.get('x-k')).toBe('reg');
  });

  it('§10 要求にあるヘッダは上書きしない', async () => {
    await call(xhr(TILE, { headers: { 'x-k': 'page' } }), false, { headers: { 'x-k': 'reg' } });
    expect(sent(0).headers.get('x-k')).toBe('page');
  });

  it('§10 no-cors の取り直しにも足す', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('cors')).mockResolvedValueOnce(opq());
    await call(img(), false, { query: { key: 'reg' } });
    expect(new URL(sent(1).url).searchParams.get('key')).toBe('reg');
  });
});

describe('§4.5-2 TypeError と no-cors の取り直し', () => {
  it('§4.5-2 TypeError で元の要求が no-cors なら元の形で 1 回取り直し、opaque を返す（保存しない）', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('cors')).mockResolvedValueOnce(opq());
    const res = await serveVia(img());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1).mode).toBe('no-cors');
    expect(sent(1).credentials).toBe('include');
    expect(res.type).toBe('opaque');
    expect(res.headers.get('x-weiwudi-status')).toBeNull();
    expect((await meta()).count).toBe(0);
  });

  it('§4.5-4 元の要求が cors なら取り直さない（network）', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('cors'));
    const r = await call(xhr());
    expect(r.kind).toBe('network');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('§4.5-3 両方 TypeError（オフライン）は network', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const r = await call(img());
    expect(r.kind).toBe('network');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('§4.5-3 corsOk・corslessStreak・corslessUntil', () => {
  const opaqueOnce = () => fetchMock.mockRejectedValueOnce(new TypeError('cors')).mockResolvedValueOnce(opq());

  it('§4.5-3 実績が無いうちに opaque が 3 回で corslessUntil = now + 24 時間', async () => {
    opaqueOnce();
    opaqueOnce();
    await call(img());
    await call(img());
    expect((await meta()).corslessUntil).toBeUndefined();
    expect(ctx.corslessStreak.get(RID)).toBe(2);
    opaqueOnce();
    await call(img());
    expect((await meta()).corslessUntil).toBe(T + CORSLESS_PERIOD_MS);
    expect(CORSLESS_PERIOD_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('§4.5-3 corslessUntil の間は 1 を省いて元の要求（no-cors）を出す', async () => {
    await store.patchResource(RID, (m) => ({ ...m, corslessUntil: T + 1000 }));
    fetchMock.mockResolvedValueOnce(opq());
    const r = await call(img());
    expect(r.kind).toBe('opaque');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(0).mode).toBe('no-cors');
  });

  it('§4.5-3 corslessUntil の期限を過ぎたら 1 に戻す', async () => {
    await store.patchResource(RID, (m) => ({ ...m, corslessUntil: T + 1000 }));
    now = T + 1001;
    await call(img());
    expect(sent(0).mode).toBe('cors');
  });

  it('§4.5-3 CORS を通った応答で連続数が 0 に戻り corslessUntil が消え corsOk が立つ', async () => {
    opaqueOnce();
    opaqueOnce();
    await call(img());
    await call(img());
    expect(ctx.corslessStreak.get(RID)).toBe(2);
    await call(img());
    expect(ctx.corslessStreak.get(RID) ?? 0).toBe(0);
    expect((await meta()).corsOk).toBe(true);
    // 期限の中でも cors の要求（1 を省かない）が通れば消える
    await store.patchResource(RID, (m) => ({ ...m, corsOk: undefined, corslessUntil: T + 1000 }));
    await call(xhr());
    const m = await meta();
    expect(m.corslessUntil).toBeUndefined();
    expect(m.corsOk).toBe(true);
  });

  it('§4.5-3 CORS ヘッダつきの 404 でも corsOk が立つ（状態コードを問わない。第 2 回 O20）', async () => {
    fetchMock.mockResolvedValueOnce(png(404));
    await call(img());
    expect((await meta()).corsOk).toBe(true);
  });

  it('§4.5-3 両方失敗（オフライン）は数えない', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    for (let i = 0; i < 4; i++) await call(img());
    expect(ctx.corslessStreak.get(RID) ?? 0).toBe(0);
    expect((await meta()).corslessUntil).toBeUndefined();
  });

  it('§4.5-3 実績あり（count > 0）なら数えない', async () => {
    await seed();
    for (let i = 0; i < 4; i++) opaqueOnce();
    for (let i = 0; i < 4; i++) await call(img(), true);
    expect(ctx.corslessStreak.get(RID) ?? 0).toBe(0);
    expect((await meta()).corslessUntil).toBeUndefined();
  });

  it('§4.5-3 実績あり（corsOk）なら数えない', async () => {
    await store.patchResource(RID, (m) => ({ ...m, corsOk: true }));
    for (let i = 0; i < 4; i++) opaqueOnce();
    for (let i = 0; i < 4; i++) await call(img());
    expect((await meta()).corslessUntil).toBeUndefined();
  });

  it('§4.5-3 同じ Resource で CORS の成功の後に opaque が 3 回続いても corslessUntil が立たない（古い写しで判定しない。第 1 回 S2）', async () => {
    // 1 本目の要求の判定より前に別の要求が CORS を通す（同じ upstream を作った後で corsOk が立つ）
    const ups = [img(), img(), img()].map((r) => ({ r, f: up(r) }));
    await call(img());
    expect((await meta()).corsOk).toBe(true);
    for (const { r, f } of ups) {
      opaqueOnce();
      await f(r, { hasEntry: false, requestChanged: false });
    }
    expect((await meta()).corslessUntil).toBeUndefined();
    expect(ctx.corslessStreak.get(RID) ?? 0).toBe(0);
  });

  it('§4.5 本文 同時の 2 要求で corsOk の書き込みが消えない（patchResource。第 1 回 S2）', async () => {
    // B は実績なしと読んだ後、3 回目の opaque で corslessUntil を書く。その間に A（同じ DB の別の SW）が
    // CORS を通して corsOk を書く。古い写しで書けば A の corsOk が消えるか、実績ありなのに corslessUntil が立つ
    ctx.corslessStreak.set(RID, 2);
    let releaseB!: (r: Response) => void;
    const bOpaque = new Promise<Response>((r) => { releaseB = r; });
    fetchMock
      .mockRejectedValueOnce(new TypeError('cors')) // B の 1
      .mockImplementationOnce(() => bOpaque); // B の 2（止めておく）
    const b = call(img());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await store.patchResource(RID, (m) => ({ ...m, corsOk: true })); // A
    releaseB(opq());
    await b;
    const m = await meta();
    expect(m.corsOk).toBe(true);
    expect(m.corslessUntil).toBeUndefined();
  });

  it('§4.5-3 実績ありで 1 が TypeError: Entry あり→古い本体（stale・upstream）、無し→opaque', async () => {
    await store.patchResource(RID, (m) => ({ ...m, corsOk: true }));
    fetchMock.mockRejectedValueOnce(new TypeError('cors')).mockResolvedValueOnce(opq());
    const none = await serveVia(img());
    expect(none.type).toBe('opaque');
    await seed();
    fetchMock.mockRejectedValueOnce(new TypeError('cors')).mockResolvedValueOnce(opq());
    const res = await serveVia(img());
    expect(res.headers.get('x-weiwudi-status')).toBe('stale');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([9, 9, 9]);
  });

  it('§4.5-3 実績あり・オフライン・Entry なしで network（404・offline-miss。第 1 回 O-9）', async () => {
    await store.patchResource(RID, (m) => ({ ...m, corsOk: true }));
    fetchMock.mockRejectedValue(new TypeError('offline'));
    expect((await call(img())).kind).toBe('network');
    const res = await serveVia(img());
    expect(res.status).toBe(404);
    expect(res.headers.get('x-weiwudi-status')).toBe('offline-miss');
    expect(res.headers.get('x-weiwudi-error')).toBe('network');
  });
});

describe('§4.5-3 S-F: no-cors の 401・403', () => {
  for (const status of [401, 403]) {
    it(`§4.5-3 S-F ${status}: Entry あり→取り直さず古い本体`, async () => {
      await seed();
      fetchMock.mockResolvedValueOnce(png(status));
      const res = await serveVia(img());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res.headers.get('x-weiwudi-status')).toBe('stale');
      expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    });
  }

  it('§4.5-3 S-F Entry なし→元の要求で取り直し、opaque なら渡して保存しない', async () => {
    fetchMock.mockResolvedValueOnce(png(401)).mockResolvedValueOnce(opq());
    const res = await serveVia(img());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1).mode).toBe('no-cors');
    expect(sent(1).credentials).toBe('include');
    expect(res.type).toBe('opaque');
    expect((await meta()).count).toBe(0);
  });

  it('§4.5-3 S-F 取り直しが TypeError→元の 401 をそのまま返す（upstream-error）', async () => {
    fetchMock.mockResolvedValueOnce(png(401)).mockRejectedValueOnce(new TypeError('x'));
    const res = await serveVia(img());
    expect(res.status).toBe(401);
    expect(res.headers.get('x-weiwudi-status')).toBe('upstream-error');
  });

  it('§4.5-3 S-F 取り直しが cors・basic の 200→通常（保存）', async () => {
    fetchMock.mockResolvedValueOnce(png(403)).mockResolvedValueOnce(png(200));
    const res = await serveVia(img());
    expect(res.headers.get('x-weiwudi-status')).toBe('miss');
    expect((await meta()).count).toBe(1);
  });

  it('§4.5-3 S-F 取り直しが 401→保存せず返す', async () => {
    fetchMock.mockResolvedValueOnce(png(401)).mockResolvedValueOnce(png(401));
    const res = await serveVia(img());
    expect(res.status).toBe(401);
    expect((await meta()).count).toBe(0);
  });

  it('§4.5-3 S-F cors の要求の 401 は取り直さない', async () => {
    fetchMock.mockResolvedValueOnce(png(401));
    await call(xhr());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('§4.5-3 S-F は数えない', async () => {
    for (let i = 0; i < 3; i++) fetchMock.mockResolvedValueOnce(png(401)).mockResolvedValueOnce(opq());
    for (let i = 0; i < 3; i++) await call(img());
    expect(ctx.corslessStreak.get(RID) ?? 0).toBe(0);
    expect((await meta()).corslessUntil).toBeUndefined();
  });
});

describe('opaque イベントの口（ctx.notify）と probeNoCors（m4-t3・R20・R4）', () => {
  const opaqueOnce = () => fetchMock.mockRejectedValueOnce(new TypeError('cors')).mockResolvedValueOnce(opq());

  it('countCorsless が corslessUntil を書いたとき ctx.notify が 1 回（resourceId と sourceIds）', async () => {
    const notify = vi.fn();
    ctx.notify = notify;
    for (let i = 0; i < 3; i++) {
      opaqueOnce();
      await call(img());
    }
    expect((await meta()).corslessUntil).toBe(T + CORSLESS_PERIOD_MS);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ type: 'opaque', resourceId: RID, sourceIds: ['s1'] });
  });

  it('書かなかった（実績あり）ときは 0 回。notify が投げても配信を止めない', async () => {
    const notify = vi.fn(() => { throw new Error('x'); });
    ctx.notify = notify;
    await store.patchResource(RID, (m) => ({ ...m, corsOk: true }));
    for (let i = 0; i < 3; i++) {
      opaqueOnce();
      await call(img());
    }
    expect(notify).not.toHaveBeenCalled();
    await store.patchResource(RID, (m) => ({ ...m, corsOk: undefined }));
    ctx.corslessStreak.clear();
    for (let i = 0; i < 3; i++) {
      opaqueOnce();
      expect((await call(img())).kind).toBe('opaque');
    }
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("probeNoCors: opaque は 'opaque'、TypeError は 'network'。要求は no-cors で資格情報を付けない", async () => {
    fetchMock.mockResolvedValueOnce(opq());
    expect(await probeNoCors(TILE)).toBe('opaque');
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await probeNoCors(TILE)).toBe('network');
    for (const [input, init] of fetchMock.mock.calls) {
      expect(input).toBe(TILE);
      expect(init).toEqual({ mode: 'no-cors', credentials: 'omit' });
    }
    fetchMock.mockResolvedValueOnce(png());
    expect(await probeNoCors(TILE)).toBe('response');
  });
});
