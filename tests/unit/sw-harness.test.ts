// tests/unit/sw-harness.ts の試験（m2-t1）。ハーネス自体が Workbox の Router と同じに振る舞うことを確かめる。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createSwHarness, isPluginsNotFound, opaqueResponse, SW_ORIGIN, SW_SELF_ORIGIN } from './sw-harness';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ok = (body: string) => async () => new Response(body);

describe('旧 API のルート', () => {
  it('RegExp を capture にした GET のルートを選び、request はそれを指す', async () => {
    const h = createSwHarness();
    expect(h.capture).toBeInstanceOf(RegExp);
    expect(h.method).toBe('GET');
    expect(await (await h.request('/api/ping')).text()).toBe('Implemented');
  });

  it('dispatch でも旧 API のルートに当たる', async () => {
    const h = createSwHarness();
    const res = await h.dispatch(`${SW_ORIGIN}/api/ping`);
    expect(await res!.text()).toBe('Implemented');
  });
});

describe('dispatch の選び方（Workbox の Router と同じ）', () => {
  it('同じ method で両方当たるときは登録順の先のもの', async () => {
    const h = createSwHarness();
    h.registerRoute(/^https:\/\/a\.example\/x$/, ok('first'), 'GET');
    h.registerRoute(/^https:\/\/a\.example\/x$/, ok('second'), 'GET');
    expect(await (await h.dispatch('https://a.example/x'))!.text()).toBe('first');
  });

  it('method が違うルートは見ない（省略時は GET）', async () => {
    const h = createSwHarness();
    h.registerRoute(/^https:\/\/a\.example\/x$/, ok('post'), 'POST');
    h.registerRoute(/^https:\/\/a\.example\/x$/, ok('get'));
    expect(await (await h.dispatch('https://a.example/x'))!.text()).toBe('get');
    const posted = await h.dispatch(new Request('https://a.example/x', { method: 'POST', body: 'b' }));
    expect(await posted!.text()).toBe('post');
  });

  it('match が偽なら次のルートへ進み、どれも当たらなければ undefined', async () => {
    const h = createSwHarness();
    const never = vi.fn(() => false);
    h.registerRoute(never, ok('never'), 'GET');
    h.registerRoute(({ url }: { url: URL }) => url.hostname === 'b.example', ok('b'), 'GET');
    expect(await (await h.dispatch('https://b.example/y'))!.text()).toBe('b');
    expect(never).toHaveBeenCalled();
    expect(await h.dispatch('https://c.example/z')).toBeUndefined();
  });

  it('別オリジンの URL は RegExp が先頭から当たったときだけ（RegExpRoute の決まり）', async () => {
    const h = createSwHarness();
    h.registerRoute(/a\.example\/x/, ok('partial'), 'GET');
    // 両方を門番（m2-t7。microtask で Weiwudi_Internal が足す）より前に登録する
    h.registerRoute(new RegExp(`^${SW_SELF_ORIGIN}/same`), ok('same'), 'GET');
    expect(await h.dispatch('https://a.example/x')).toBeUndefined();
    expect(await (await h.dispatch(`${SW_SELF_ORIGIN}/same`))!.text()).toBe('same');
  });

  it('g の正規表現は lastIndex を戻さない（workbox-routing 7.4.1 の RegExpRoute と同じ）', async () => {
    const h = createSwHarness();
    const re = /^https:\/\/g\.example\/x/g;
    h.registerRoute(re, ok('g'), 'GET');
    expect(await (await h.dispatch('https://g.example/x'))!.text()).toBe('g');
    // 1 回目の exec で lastIndex が進み、2 回目は同じ URL でも当たらない（実物の挙動）
    expect(re.lastIndex).toBeGreaterThan(0);
    expect(await h.dispatch('https://g.example/x')).toBeUndefined();
    expect(re.lastIndex).toBe(0);
    expect(await (await h.dispatch('https://g.example/x'))!.text()).toBe('g');
  });

  it('method は登録された文字列のまま request.method で引く（大文字にしない）', async () => {
    const h = createSwHarness();
    h.registerRoute(/^https:\/\/m\.example\/x$/, ok('lower'), 'get');
    // Request は標準の method を大文字にするので、'get' で登録したルートには当たらない（実物と同じ）
    expect(await h.dispatch('https://m.example/x')).toBeUndefined();
    // 門番（m2-t7）が microtask で後ろに足されるので、登録したルートを捕捉の値で引く
    expect(h.routes.find((r) => String(r.capture) === String(/^https:\/\/m\.example\/x$/))!.method).toBe('get');
  });

  it('handler は { url, request, event, params } を受け、{ handle } の形の handler も呼べる', async () => {
    const h = createSwHarness();
    const handle = vi.fn(async () => new Response('obj'));
    h.registerRoute(/^https:\/\/a\.example\/(\d+)$/, { handle }, 'GET');
    await h.dispatch('https://a.example/42');
    const [arg] = handle.mock.calls[0] as unknown as [{ url: URL; request: Request; params: unknown }];
    expect(arg.url.href).toBe('https://a.example/42');
    expect(arg.request).toBeInstanceOf(Request);
    expect(arg.params).toEqual(['42']);
  });

  it('post は text/plain;charset=UTF-8 の POST で、本文が文字列でなければ JSON にする', async () => {
    const h = createSwHarness();
    const seen = vi.fn(async ({ request }: { request: Request }) =>
      new Response(`${request.headers.get('content-type')}|${await request.text()}`));
    h.registerRoute(new RegExp(`^${SW_ORIGIN}/v2/`), seen, 'POST');
    const res = await h.post('/v2/register', { id: 'a' });
    expect(await res!.text()).toBe('text/plain;charset=UTF-8|{"id":"a"}');
  });
});

describe('flushRoutes', () => {
  it('microtask で後から登録されるルートが、flushRoutes の後に見える', async () => {
    const h = createSwHarness();
    // Weiwudi_Internal 自身の microtask のルート（m2-t7 の門番）を先に済ませる
    await h.flushRoutes();
    const before = h.routes.length;
    Promise.resolve().then(() => Promise.resolve()).then(() => {
      h.registerRoute(/^https:\/\/late\.example\//, ok('late'), 'GET');
    });
    expect(h.routes.length).toBe(before);
    await h.flushRoutes();
    expect(h.routes.length).toBe(before + 1);
    // 門番は表を読み込むまで候補を受けるので、先に 1 回通して表を読み込ませる（以後の門番は何も受けない）
    await h.dispatch('https://warm.example/');
    expect(await (await h.dispatch('https://late.example/a'))!.text()).toBe('late');
  });
});

describe('FetchEvent の waitUntil', () => {
  it('handler が渡した Promise を waitUntilCalls に記録する', async () => {
    const h = createSwHarness();
    h.registerRoute(/^https:\/\/a\.example\//, async ({ event }: { event: { waitUntil: (p: Promise<unknown>) => void } }) => {
      event.waitUntil(Promise.resolve('job'));
      return new Response('ok');
    }, 'GET');
    await h.dispatch('https://a.example/');
    expect(h.waitUntilCalls).toHaveLength(1);
    await expect(h.waitUntilCalls[0]).resolves.toBe('job');
  });
});

describe('同じ factory の 2 つのハーネス', () => {
  it('IndexedDB を共有する（片方で登録した地図をもう片方が読める）', async () => {
    const factory = new IDBFactory();
    const a = createSwHarness({ factory });
    await a.request('/api/add?mapID=m&type=xyz&url=u&width=256&height=256');
    const b = createSwHarness({ factory });
    expect(b.factory).toBe(factory);
    expect(await (await b.request('/api/info?mapID=m')).json()).toMatchObject({ mapID: 'm' });
  });

  it('母線が届き、disable() で止まる。別の factory には届かない', async () => {
    const factory = new IDBFactory();
    const a = createSwHarness({ factory });
    const chA = new BroadcastChannel('weiwudi');
    const b = createSwHarness({ factory });
    const chB = new BroadcastChannel('weiwudi');
    const got: unknown[] = [];
    chB.onmessage = (e) => { got.push(e.data); };
    createSwHarness();
    const chOther = new BroadcastChannel('weiwudi');
    const other: unknown[] = [];
    chOther.onmessage = (e) => { other.push(e.data); };

    chA.postMessage({ n: 1 });
    await b.flushRoutes();
    expect(got).toEqual([{ n: 1 }]);
    expect(other).toEqual([]);
    expect(a.bus).toBe(b.bus);

    a.bus.disable();
    chA.postMessage({ n: 2 });
    await b.flushRoutes();
    expect(got).toEqual([{ n: 1 }]);

    a.bus.enable();
    chA.postMessage({ n: 3 });
    await b.flushRoutes();
    expect(got).toEqual([{ n: 1 }, { n: 3 }]);
  });

  it('送り手自身には届かず、名前の違う channel にも届かない', async () => {
    const h = createSwHarness();
    const self = new BroadcastChannel('weiwudi');
    const otherName = new BroadcastChannel('else');
    const got: unknown[] = [];
    self.onmessage = (e) => { got.push(['self', e.data]); };
    otherName.onmessage = (e) => { got.push(['else', e.data]); };
    self.postMessage('x');
    await h.flushRoutes();
    expect(got).toEqual([]);
  });
});

describe('plugins の読み込みで握る例外', () => {
  const notFound = (message: string, code = 'ERR_MODULE_NOT_FOUND') => Object.assign(new Error(message), { code });

  it('plugins そのものが見つからないときだけ握る', () => {
    expect(isPluginsNotFound(notFound("Cannot find module '/src/plugins' imported from /x/tests/unit/sw-harness.ts"))).toBe(true);
    expect(isPluginsNotFound(notFound("Cannot find module '/repo/src/plugins.ts' imported from /x"))).toBe(true);
  });

  it('plugins.ts の中の誤り・plugins.ts が読む別のモジュールの欠落・code の無い例外は握らない', () => {
    expect(isPluginsNotFound(notFound("Cannot find module './gone' imported from /repo/src/plugins.ts"))).toBe(false);
    expect(isPluginsNotFound(new SyntaxError("Unexpected token in /repo/src/plugins.ts"))).toBe(false);
    expect(isPluginsNotFound(new Error("Cannot find module '/src/plugins'"))).toBe(false);
    expect(isPluginsNotFound(undefined)).toBe(false);
  });
});

describe('opaqueResponse', () => {
  it('type opaque・status 0・ok false', () => {
    const res = opaqueResponse();
    expect(res).toBeInstanceOf(Response);
    expect(res.type).toBe('opaque');
    expect(res.status).toBe(0);
    expect(res.ok).toBe(false);
  });
});
