// src/weiwudi.ts のページ側の新 API の試験（m2-t8・仕様 §4.1・§12）。navigator.serviceWorker・fetch・location を差し替える。
// ensureV2 の記憶はモジュール変数なので、試験ごとに vi.resetModules() で読み直す。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('../../src/weiwudi');

class FakeContainer {
  controller: object | null;
  private readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(controller: object | null) {
    this.controller = controller;
  }
  addEventListener(type: string, f: (e: unknown) => void) {
    (this.listeners[type] ||= []).push(f);
  }
  removeEventListener(type: string, f: (e: unknown) => void) {
    this.listeners[type] = (this.listeners[type] || []).filter((g) => g !== f);
  }
  fire(type: string, e: unknown = {}) {
    for (const f of (this.listeners[type] || []).slice()) f(e);
  }
  count(type: string) {
    return (this.listeners[type] || []).length;
  }
}

const PING = 'https://weiwudi.example.com/v2/ping';
const TPL = 'https://t.example/{z}/{x}/{y}.png';
const INFO = { id: TPL, kind: 'raster', url: TPL, resources: [{ id: TPL, type: 'tile', templates: [TPL], count: 0, bytes: 0 }], warnings: [] };

const jsonRes = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const pingOk = () => jsonRes({ api: 2, version: '1.2.3' });

/** fetch の呼び出しの記録（url と method） */
let log: { url: string; method: string; init?: RequestInit }[];
let container: FakeContainer;
let fetchMock: ReturnType<typeof vi.fn>;
let pingReply: () => Promise<Response>;
let postReply: (op: string, body: unknown) => Promise<Response>;

const setup = async (controller: object | null = {}): Promise<Mod> => {
  vi.resetModules();
  log = [];
  container = new FakeContainer(controller);
  pingReply = async () => pingOk();
  postReply = async (op) => jsonRes({ ok: true, result: op === 'sources' ? [INFO] : INFO });
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    log.push({ url, method: init?.method ?? 'GET', init });
    if (url === PING) return pingReply();
    if (url.startsWith('https://weiwudi.example.com/v2/')) {
      return postReply(url.slice('https://weiwudi.example.com/v2/'.length), JSON.parse(String(init?.body)));
    }
    if (url === 'https://weiwudi.example.com/api/ping') return new Response('Implemented');
    throw new TypeError('unexpected');
  });
  vi.stubGlobal('navigator', { serviceWorker: container });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { href: 'https://page.example/app/index.html' });
  return import('../../src/weiwudi');
};

const pings = () => log.filter((c) => c.url === PING).length;
const posts = () => log.filter((c) => c.method === 'POST');

const rejectsWith = async (p: Promise<unknown>, code: string, mod: Mod) => {
  const e = await p.then(() => undefined, (err: unknown) => err);
  expect(e).toBeInstanceOf(mod.WeiwudiError);
  expect((e as { code: string }).code).toBe(code);
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ensureV2（仕様 §4.1）', () => {
  it('制御下に無いと fetch を 1 度も呼ばずに sw-not-controlling', async () => {
    const m = await setup(null);
    await rejectsWith(m.default.register({ kind: 'raster', url: TPL }), 'sw-not-controlling', m);
    await rejectsWith(m.default.sources(), 'sw-not-controlling', m);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ping が 404 なら sw-outdated で、POST を出さない。次の呼び出しで確かめ直す', async () => {
    const m = await setup();
    pingReply = async () => new Response('Not Found', { status: 404 });
    await rejectsWith(m.default.sources(), 'sw-outdated', m);
    await rejectsWith(m.default.sources(), 'sw-outdated', m);
    expect(pings()).toBe(2);
    expect(posts()).toHaveLength(0);
  });

  it('ping のネットワーク失敗は sw-not-controlling（記憶しない）', async () => {
    const m = await setup();
    pingReply = async () => { throw new TypeError('Failed to fetch'); };
    await rejectsWith(m.default.sources(), 'sw-not-controlling', m);
    pingReply = async () => pingOk();
    expect(await m.default.sources()).toHaveLength(1);
    expect(pings()).toBe(2);
  });

  it('200 でも JSON が違えば sw-outdated（api が違う・version が無い・空・JSON でない）', async () => {
    const m = await setup();
    for (const body of [{ api: 1, version: '1' }, { api: 2 }, { api: 2, version: '' }, { api: 2, version: 3 }, null]) {
      pingReply = async () => jsonRes(body);
      await rejectsWith(m.default.sources(), 'sw-outdated', m);
    }
    pingReply = async () => new Response('Implemented');
    await rejectsWith(m.default.sources(), 'sw-outdated', m);
    expect(pings()).toBe(6);
    expect(posts()).toHaveLength(0);
  });

  it('その他の状態は sw-not-controlling', async () => {
    const m = await setup();
    pingReply = async () => new Response('x', { status: 500 });
    await rejectsWith(m.default.sources(), 'sw-not-controlling', m);
  });

  it('成功は同じ controller で 1 度だけ', async () => {
    const m = await setup();
    await m.default.sources();
    await m.default.register({ kind: 'raster', url: TPL });
    await m.default.source(TPL);
    expect(pings()).toBe(1);
    expect(posts()).toHaveLength(3);
  });

  it('controllerchange の後と、controller の実体が替わった後は確かめ直す（第 2 回 D2）', async () => {
    const m = await setup();
    const first = container.controller;
    await m.default.sources();
    container.fire('controllerchange');
    await m.default.sources();
    expect(pings()).toBe(2);
    container.controller = {};
    await m.default.sources();
    expect(pings()).toBe(3);
    // 確かめた実体ごとに覚える（元の実体に戻れば確かめ直さない）
    container.controller = first;
    await m.default.sources();
    expect(pings()).toBe(3);
  });

  it('ping の間に controller が替わると 1 回だけ確かめ直す（第 3 回 M2）', async () => {
    const m = await setup();
    let n = 0;
    pingReply = async () => {
      n++;
      if (n === 1) container.controller = {};
      return pingOk();
    };
    expect(await m.default.sources()).toHaveLength(1);
    expect(pings()).toBe(2);
    expect(posts()).toHaveLength(1);
  });

  it('2 回目も替わると sw-not-controlling で、POST を出さない（第 3 回 M2）', async () => {
    const m = await setup();
    pingReply = async () => {
      container.controller = {};
      return pingOk();
    };
    await rejectsWith(m.default.sources(), 'sw-not-controlling', m);
    expect(pings()).toBe(2);
    expect(posts()).toHaveLength(0);
  });

  it('ping の失敗（404）の間に controller が替わっていたら、新しい controller を確かめ直す（PR #80 水準 2 必須）', async () => {
    const m = await setup();
    let n = 0;
    pingReply = async () => {
      n++;
      if (n === 1) {
        container.controller = {};
        return new Response('Not Found', { status: 404 });
      }
      return pingOk();
    };
    expect(await m.default.sources()).toHaveLength(1);
    expect(pings()).toBe(2);
    expect(posts()).toHaveLength(1);
  });

  it('ping の失敗の間に 2 回とも controller が替わると sw-not-controlling（元の例外を返さない）', async () => {
    const m = await setup();
    pingReply = async () => {
      container.controller = {};
      return new Response('Not Found', { status: 404 });
    };
    await rejectsWith(m.default.sources(), 'sw-not-controlling', m);
    expect(pings()).toBe(2);
    expect(posts()).toHaveLength(0);
  });

  it('ping の失敗の間に controller が替わらなければ、元の例外を 1 回で返す', async () => {
    const m = await setup();
    pingReply = async () => { throw new TypeError('down'); };
    await rejectsWith(m.default.sources(), 'sw-not-controlling', m);
    pingReply = async () => jsonRes({ api: 2, version: '' });
    await rejectsWith(m.default.sources(), 'sw-outdated', m);
    expect(pings()).toBe(2);
  });

  it('進行中の確認を待った後、今の controller が確認済みでなければ確かめ直す（水準 1 Minor 6）', async () => {
    const m = await setup();
    const A = {};
    const B = {};
    let pinged = false;
    let reads = 0;
    // ping の後の読み出し: 1 回目は verify の比較（A）、2 回目は先の呼び出しの見直し（A）、3 回目からは後の呼び出しの
    // 見直しで B（確認が終わってから、後の呼び出しが再開するまでの間に替わった）
    Object.defineProperty(container, 'controller', {
      configurable: true,
      get: () => {
        if (!pinged) return A;
        reads++;
        return reads >= 3 ? B : A;
      },
    });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let n = 0;
    pingReply = async () => {
      n++;
      if (n === 1) {
        await held;
        pinged = true;
      }
      return pingOk();
    };
    const a = m.default.sources();
    const b = m.default.sources();
    await Promise.resolve();
    release();
    await Promise.all([a, b]);
    expect(pings()).toBe(2);
    expect(posts()).toHaveLength(2);
  });

  it('同時の 2 つの呼び出しで ping は 1 本（第 3 回 推奨）', async () => {
    const m = await setup();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    pingReply = async () => {
      await held;
      return pingOk();
    };
    const a = m.default.sources();
    const b = m.default.register({ kind: 'raster', url: TPL });
    await Promise.resolve();
    release();
    await Promise.all([a, b]);
    expect(pings()).toBe(1);
  });

  it('ping の成功より前に POST が出ない（呼び出しの順）', async () => {
    const m = await setup();
    await m.default.register({ kind: 'raster', url: TPL });
    expect(log.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${PING}`,
      'POST https://weiwudi.example.com/v2/register',
    ]);
  });

  it('swCheck（旧 API）の結果は新 API の確認に影響されない（第 1 回 C2）', async () => {
    const m = await setup();
    pingReply = async () => new Response('Not Found', { status: 404 });
    await rejectsWith(m.default.sources(), 'sw-outdated', m);
    // 新 API の失敗の後も旧 API の確認は /api/ping を見て成功する
    expect(await m.default.swCheck()).toBe(true);
    expect(log.filter((c) => c.url === 'https://weiwudi.example.com/api/ping')).toHaveLength(1);
    // 旧 API の成功は新 API の確認を飛ばさない
    pingReply = async () => pingOk();
    await m.default.sources();
    expect(pings()).toBe(2);
  });
});

describe('POST の形（仕様 §4.1・§12）', () => {
  it('Content-Type は text/plain;charset=UTF-8 で、本文は JSON 文字列', async () => {
    const m = await setup();
    await m.default.register({ kind: 'raster', url: TPL, minZoom: 2 });
    const [p] = posts();
    expect(p.init!.method).toBe('POST');
    expect(new Headers(p.init!.headers).get('content-type')).toBe('text/plain;charset=UTF-8');
    expect(typeof p.init!.body).toBe('string');
    expect(JSON.parse(String(p.init!.body))).toEqual({ kind: 'raster', url: TPL, minZoom: 2 });
  });

  it('ping と POST は cache: no-store・redirect: error（キャッシュの 200 を成功と取り違えず、本文を別オリジンへ移さない）', async () => {
    const m = await setup();
    await m.default.sources();
    expect(log).toHaveLength(2);
    for (const c of log) {
      expect(c.init?.cache).toBe('no-store');
      expect(c.init?.redirect).toBe('error');
    }
  });

  it('相対の url はページの場所で絶対化する（字句は符号化しない）。絶対の url はそのまま', async () => {
    const m = await setup();
    await m.default.register({ kind: 'raster', url: ['tiles/{z}/{x}/{y}.png', 'https://U.example/{z}/{x}/{y}.png'] });
    expect(JSON.parse(String(posts()[0].init!.body)).url).toEqual([
      'https://page.example/app/tiles/{z}/{x}/{y}.png',
      'https://U.example/{z}/{x}/{y}.png',
    ]);
  });

  it('SW の失敗の応答は WeiwudiError（code・message・detail）で reject', async () => {
    const m = await setup();
    postReply = async () => jsonRes({ ok: false, error: { code: 'resource-conflict', message: 'conflict', detail: { resourceIds: ['r'] } } });
    const e = await m.default.register({ kind: 'raster', url: TPL }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(m.WeiwudiError);
    expect(e).toMatchObject({ code: 'resource-conflict', message: 'conflict', detail: { resourceIds: ['r'] } });
  });

  it('POST のネットワーク失敗は sw-not-controlling、JSON でない応答は internal（どちらも WeiwudiError）', async () => {
    const m = await setup();
    postReply = async () => { throw new TypeError('Failed'); };
    await rejectsWith(m.default.sources(), 'sw-not-controlling', m);
    postReply = async () => new Response('<html>');
    await rejectsWith(m.default.sources(), 'internal', m);
  });
});

describe('WeiwudiSource（仕様 §12）', () => {
  it('register は WeiwudiSource（id・url・resources・warnings は写し）', async () => {
    const m = await setup();
    const s = await m.default.register({ kind: 'raster', url: TPL });
    expect(s).toBeInstanceOf(m.WeiwudiSource);
    expect([s.id, s.url, s.resources, s.warnings]).toEqual([INFO.id, INFO.url, INFO.resources, INFO.warnings]);
    expect(s.resources).not.toBe(INFO.resources);
  });

  it('stats・update・clean・remove は id を本文に POST する。update は写しを置き換える', async () => {
    const m = await setup();
    const s = await m.default.register({ kind: 'raster', url: TPL });
    postReply = async (op) => {
      if (op === 'stats') return jsonRes({ ok: true, result: { count: 1, size: 3, byResource: {} } });
      if (op === 'update') return jsonRes({ ok: true, result: { ...INFO, warnings: ['resource-conflict: r'] } });
      return jsonRes({ ok: true, result: null });
    };
    expect(await s.stats()).toEqual({ count: 1, size: 3, byResource: {} });
    const before = s.warnings;
    await s.update();
    expect(before).toEqual([]);
    expect(s.warnings).toEqual(['resource-conflict: r']);
    await s.clean();
    await s.remove();
    expect(posts().slice(1).map((p) => [p.url.split('/').pop(), JSON.parse(String(p.init!.body))])).toEqual([
      ['stats', { id: TPL }], ['update', { id: TPL }], ['clean', { id: TPL }], ['remove', { id: TPL }],
    ]);
  });

  it('release はページ側のリスナを外し、以後のメソッドは instance-released', async () => {
    const m = await setup();
    const s = await m.default.register({ kind: 'raster', url: TPL });
    expect(container.count('message')).toBe(1);
    const seen = vi.fn();
    s.addEventListener('proceed', seen);
    container.fire('message', { data: { sourceId: TPL, type: 'proceed' } });
    container.fire('message', { data: { sourceId: 'other', type: 'proceed' } });
    expect(seen).toHaveBeenCalledTimes(1);
    s.release();
    expect(container.count('message')).toBe(0);
    await rejectsWith(s.stats(), 'instance-released', m);
  });

  it('source・sources', async () => {
    const m = await setup();
    expect((await m.default.source(TPL)).id).toBe(TPL);
    expect(await m.default.sources()).toEqual([INFO]);
    expect(JSON.parse(String(posts()[0].init!.body))).toEqual({ id: TPL });
  });
});

describe('removeResource・usage（m3-t8・R18・R19）', () => {
  it('removeResource は id と resourceId を本文に POST し、undefined で解決する', async () => {
    const m = await setup();
    const s = await m.default.register({ kind: 'raster', url: TPL });
    postReply = async () => jsonRes({ ok: true, result: null });
    expect(await s.removeResource(TPL)).toBeUndefined();
    const last = posts().pop()!;
    expect([last.url, JSON.parse(String(last.init!.body))]).toEqual(['https://weiwudi.example.com/v2/removeResource', { id: TPL, resourceId: TPL }]);
  });

  it('removeResource の失敗は WeiwudiError（resource-not-found）。release の後は instance-released で POST しない', async () => {
    const m = await setup();
    const s = await m.default.register({ kind: 'raster', url: TPL });
    postReply = async () => jsonRes({ ok: false, error: { code: 'resource-not-found', message: 'nope', detail: { sourceId: TPL, resourceId: 'x' } } });
    const e = await s.removeResource('x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(m.WeiwudiError);
    expect(e).toMatchObject({ code: 'resource-not-found', detail: { sourceId: TPL, resourceId: 'x' } });
    s.release();
    const n = posts().length;
    await rejectsWith(s.removeResource('x'), 'instance-released', m);
    expect(posts()).toHaveLength(n);
  });

  it('usage は {} を POST し、byProvider は null プロトタイプ（__proto__ の鍵も自前の項目）', async () => {
    const m = await setup();
    // JSON の文字列で返す（__proto__ の鍵を JSON.parse の自前の項目として届ける）
    postReply = async () => new Response('{"ok":true,"result":{"count":3,"bytes":9,"byProvider":{"__proto__":{"count":1,"bytes":3},"mapbox":{"count":2,"bytes":6}}}}');
    const u = await m.default.usage();
    expect(JSON.parse(String(posts()[0].init!.body))).toEqual({});
    expect(posts()[0].url).toBe('https://weiwudi.example.com/v2/usage');
    expect(Object.getPrototypeOf(u.byProvider)).toBeNull();
    expect(Object.keys(u.byProvider)).toEqual(['__proto__', 'mapbox']);
    expect(u.byProvider['__proto__']).toEqual({ count: 1, bytes: 3 });
    expect(u.byProvider.mapbox).toEqual({ count: 2, bytes: 6 });
    expect([u.count, u.bytes]).toEqual([3, 9]);
  });

  it('SW の答えの code は書式（/^[a-z][a-z0-9-]*$/）に合えば未知でも保ち、合わなければ internal', async () => {
    const m = await setup();
    postReply = async () => jsonRes({ ok: false, error: { code: 'future-code', message: 'x', detail: {} } });
    await rejectsWith(m.default.usage(), 'future-code', m);
    for (const code of ['Bad Code', '', '1x', 3]) {
      postReply = async () => jsonRes({ ok: false, error: { code, message: 'x', detail: {} } });
      await rejectsWith(m.default.usage(), 'internal', m);
    }
  });

  it('usage の失敗は WeiwudiError', async () => {
    const m = await setup();
    postReply = async () => jsonRes({ ok: false, error: { code: 'storage', message: 'x', detail: {} } });
    await rejectsWith(m.default.usage(), 'storage', m);
  });
});

describe('範囲取得（m4-t3・§7.2・R22・R45・R58・R-ratio・I5b）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const RANGE = { box: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, minZoom: 1, maxZoom: 2 };
  const region = (over: Record<string, unknown> = {}) => ({
    id: 'g1', sourceId: TPL, range: RANGE, status: 'running', pinned: true, total: 5, error: 0,
    errors: { network: 0, upstream: 0, quota: 0, storage: 0 }, createdAt: 1, updatedAt: 1, ...over,
  });
  /** SW からのメッセージ（navigator.serviceWorker の message） */
  const fromSw = (data: Record<string, unknown>) => container.fire('message', { data: { sourceId: TPL, regionId: 'g1', ...data } });
  const bodies = (op: string) => posts().filter((p) => p.url.endsWith(`/v2/${op}`)).map((p) => JSON.parse(String(p.init!.body)));

  /** op ごとの答え（無い op は INFO） */
  const answer = (table: Record<string, () => unknown>) => {
    postReply = async (op) => {
      const f = table[op];
      if (!f) return jsonRes({ ok: true, result: INFO });
      const v = f();
      return v instanceof Response ? v : jsonRes({ ok: true, result: v });
    };
  };
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  it('estimate・fetchRange・regions・cancel の POST の形。fetchRange は persist を試し、ratio の既定は devicePixelRatio（1 なら ""）', async () => {
    const m = await setup();
    const persist = vi.fn(async () => { throw new Error('denied'); });
    (navigator as unknown as { storage: unknown }).storage = { persist };
    vi.stubGlobal('devicePixelRatio', 1);
    answer({ estimate: () => ({ tiles: 5 }), fetchRange: () => region({ status: 'complete' }), regions: () => [region({ status: 'complete' })], cancel: () => ({ regionId: null }) });
    const src = await m.default.register({ kind: 'raster', url: TPL });
    expect(await src.estimate(RANGE)).toEqual({ tiles: 5 });
    expect(await src.fetchRange(RANGE)).toMatchObject({ id: 'g1', status: 'complete' });
    expect(await src.regions()).toMatchObject([{ id: 'g1' }]);
    await src.cancel();
    expect(bodies('estimate')).toEqual([{ id: TPL, range: RANGE }]);
    expect(bodies('fetchRange')).toEqual([{ id: TPL, range: RANGE, options: { ratio: '' } }]);
    expect(bodies('regions')).toEqual([{ id: TPL }]);
    expect(bodies('cancel')).toEqual([{ id: TPL }]);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("ratio の既定は devicePixelRatio > 1 なら '@2x'。指定があればそのまま", async () => {
    const m = await setup();
    vi.stubGlobal('devicePixelRatio', 2);
    answer({ fetchRange: () => region({ status: 'complete' }) });
    const src = await m.default.register({ kind: 'raster', url: TPL });
    await src.fetchRange(RANGE, { concurrency: 2 });
    await src.fetchRange(RANGE, { ratio: '' });
    expect(bodies('fetchRange').map((b) => b.options)).toEqual([{ concurrency: 2, ratio: '@2x' }, { ratio: '' }]);
  });

  it('POST の応答（running）の後、その regionId の finish を待って regions() の RegionInfo で解決する。別の region の finish では解決しない', async () => {
    const m = await setup();
    answer({ fetchRange: () => region(), regions: () => [region({ status: 'complete' })] });
    const src = await m.default.register({ kind: 'raster', url: TPL });
    let settled: unknown;
    const p = src.fetchRange(RANGE).then((r) => { settled = r; });
    await flush();
    fromSw({ type: 'finish', regionId: 'other' });
    fromSw({ type: 'proceed', percent: 40 });
    await flush();
    expect(settled).toBeUndefined();
    fromSw({ type: 'finish', error: 0 });
    await p;
    expect(settled).toMatchObject({ id: 'g1', status: 'complete' });
  });

  it('POST の応答より先に届いた finish でも解決する', async () => {
    const m = await setup();
    answer({
      fetchRange: () => { fromSw({ type: 'finish', error: 0 }); return region(); },
      regions: () => [region({ status: 'complete' })],
    });
    const src = await m.default.register({ kind: 'raster', url: TPL });
    expect(await src.fetchRange(RANGE)).toMatchObject({ status: 'complete' });
  });

  it('stop は WeiwudiError(code, message) で reject、canceled は status: canceled で resolve', async () => {
    const m = await setup();
    answer({ fetchRange: () => region(), regions: () => [region({ status: 'canceled' })] });
    const src = await m.default.register({ kind: 'raster', url: TPL });
    const a = src.fetchRange(RANGE);
    await flush();
    fromSw({ type: 'stop', code: 'opaque', message: 'no CORS' });
    const e = await a.then(() => undefined, (err: unknown) => err);
    expect(e).toBeInstanceOf(m.WeiwudiError);
    expect(e).toMatchObject({ code: 'opaque', message: 'no CORS' });
    const b = src.fetchRange(RANGE);
    await flush();
    fromSw({ type: 'canceled' });
    expect(await b).toMatchObject({ status: 'canceled' });
  });

  it('30 秒イベントが来なければ job/resume。running ならまた待ち、complete で resolve（偽のタイマ）', async () => {
    const m = await setup();
    const replies = [region(), region({ status: 'complete' })];
    answer({ fetchRange: () => region(), 'job/resume': () => replies.shift() });
    const src = await m.default.register({ kind: 'raster', url: TPL });
    vi.useFakeTimers();
    let settled: unknown;
    const p = src.fetchRange(RANGE).then((r) => { settled = r; });
    await vi.advanceTimersByTimeAsync(29_000);
    fromSw({ type: 'proceed' });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(bodies('job/resume')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bodies('job/resume')).toEqual([{ id: TPL, regionId: 'g1' }]);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    await p;
    expect(bodies('job/resume')).toHaveLength(2);
    expect(settled).toMatchObject({ status: 'complete' });
  });

  it('再開の応答が stopped なら reject、job/resume の fetch-busy なら reject', async () => {
    const m = await setup();
    let resume: () => unknown = () => region({ status: 'stopped', code: 'quota' });
    answer({ fetchRange: () => region(), 'job/resume': () => resume() });
    const src = await m.default.register({ kind: 'raster', url: TPL });
    vi.useFakeTimers();
    const a = src.fetchRange(RANGE).then(() => undefined, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejectsWith(Promise.reject(await a), 'quota', m);
    resume = () => jsonRes({ ok: false, error: { code: 'fetch-busy', message: 'busy', detail: {} } });
    const b = src.fetchRange(RANGE).then(() => undefined, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejectsWith(Promise.reject(await b), 'fetch-busy', m);
  });

  it('release() で待ちを instance-released で reject する', async () => {
    const m = await setup();
    answer({ fetchRange: () => region() });
    const src = await m.default.register({ kind: 'raster', url: TPL });
    const p = src.fetchRange(RANGE);
    await flush();
    src.release();
    await rejectsWith(p, 'instance-released', m);
    await rejectsWith(src.fetchRange(RANGE), 'instance-released', m);
  });

  it('cancel() は canceled のメッセージを受けるまで解決しない。regionId が無ければすぐ解決（第 2 回 M4）', async () => {
    const m = await setup();
    let reply: unknown = { regionId: 'g1' };
    answer({ cancel: () => reply });
    const src = await m.default.register({ kind: 'raster', url: TPL });
    let done = false;
    const p = src.cancel().then(() => { done = true; });
    await flush();
    fromSw({ type: 'proceed' });
    await flush();
    expect(done).toBe(false);
    fromSw({ type: 'canceled' });
    await p;
    expect(done).toBe(true);
    reply = { regionId: null };
    await src.cancel();
  });

  it('cancel() は 30 秒来なければ regions() を読んで解決する（偽のタイマ）。失敗は reject', async () => {
    const m = await setup();
    answer({ cancel: () => ({ regionId: 'g1' }), regions: () => [region({ status: 'partial' })] });
    const src = await m.default.register({ kind: 'raster', url: TPL });
    vi.useFakeTimers();
    let done = false;
    const p = src.cancel().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(done).toBe(false);
    expect(bodies('regions')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(bodies('regions')).toHaveLength(1);
    answer({ cancel: () => jsonRes({ ok: false, error: { code: 'no-fetch-process', message: 'none', detail: {} } }) });
    await rejectsWith(src.cancel(), 'no-fetch-process', m);
  });
});
