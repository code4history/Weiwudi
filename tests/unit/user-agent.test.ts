// 上流へ送る User-Agent（2026-11-14）。検査・組み立て・付ける場面（同じオリジンで cors か same-origin だけ）・
// 指定の経路（registerSW → POST /v2/setUserAgent → kv、SW 側の setUserAgent）を確かめる。
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createSwHarness, SW_SELF_ORIGIN, type SwHarness } from './sw-harness';
import { createContext } from '../../src/context';
import { applyRegister } from '../../src/registry';
import { normalizeSpec } from '../../src/spec';
import { WeiwudiError } from '../../src/errors';
import { KV_USER_AGENT, type Store } from '../../src/store';
import { setUserAgent, getUserAgent, _resetPluginsForTest } from '../../src/plugins';
import {
  USER_AGENT_MAX_LENGTH, composeUserAgent, shouldAttachUserAgent, validateUserAgent, weiwudiProduct, withUserAgent,
} from '../../src/user_agent';

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;
const BROWSER = 'Mozilla/5.0 (TestBrowser)';
const SELF = { origin: SW_SELF_ORIGIN, href: `${SW_SELF_ORIGIN}/weiwudi-sw.js` };

afterEach(() => {
  _resetPluginsForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const png = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });

const codeOf = (f: () => unknown): string | undefined => {
  try {
    f();
    return undefined;
  } catch (e) {
    if (e instanceof WeiwudiError) return e.code;
    throw e;
  }
};

describe('既定値と組み立て', () => {
  it('Weiwudi/<version> の version は package.json の版（vitest の define）', () => {
    expect(weiwudiProduct()).toBe(`Weiwudi/${VERSION}`);
  });

  it('指定が無ければブラウザの User-Agent の後ろに Weiwudi/<version> だけを足す', () => {
    expect(composeUserAgent(BROWSER, undefined)).toBe(`${BROWSER} Weiwudi/${VERSION}`);
  });

  it('指定があっても Weiwudi/<version> を残し、指定値はその前に置く', () => {
    expect(composeUserAgent(BROWSER, 'Maplat/2.0')).toBe(`${BROWSER} Maplat/2.0 Weiwudi/${VERSION}`);
  });

  it('ブラウザの User-Agent が無い環境では省く', () => {
    expect(composeUserAgent(undefined, 'Maplat/2.0')).toBe(`Maplat/2.0 Weiwudi/${VERSION}`);
    expect(composeUserAgent('', undefined)).toBe(`Weiwudi/${VERSION}`);
  });
});

describe('指定値の検査', () => {
  it('普通の値は前後の空白を除いて受ける。上限ちょうどの長さも受ける', () => {
    expect(validateUserAgent('Maplat/2.0')).toBe('Maplat/2.0');
    expect(validateUserAgent('  Maplat/2.0 (+https://example.com)  ')).toBe('Maplat/2.0 (+https://example.com)');
    expect(validateUserAgent('a'.repeat(USER_AGENT_MAX_LENGTH))).toHaveLength(200);
  });

  it('空・空白だけ・制御文字・長すぎる・ASCII 以外・文字列でない値は attribute-invalid', () => {
    for (const v of ['', '   ', '\t', 'Maplat\n/2.0', 'Maplat\u0000', 'Maplat\u007f', 'a'.repeat(201), 'まぷらっと', 1, null, {}]) {
      expect(codeOf(() => validateUserAgent(v)), JSON.stringify(v)).toBe('attribute-invalid');
    }
  });

  it('エラーの文面は Attribute "userAgent" …・detail は attribute', () => {
    let err: WeiwudiError | undefined;
    try {
      validateUserAgent('   ');
    } catch (e) {
      err = e as WeiwudiError;
    }
    expect(err?.message).toBe('Attribute "userAgent" must not be blank');
    expect(err?.detail).toEqual({ attribute: 'userAgent' });
  });
});

describe('付ける場面（同じオリジンで mode が cors か same-origin だけ）', () => {
  const same = `${SW_SELF_ORIGIN}/tiles/1/0/0.png`;
  const other = 'https://t.example/1/0/0.png';

  it('同じオリジンの cors・same-origin に付ける（文字列の URL は cors。相対は SW の場所で解く）', () => {
    expect(shouldAttachUserAgent(new Request(same), undefined, SELF)).toBe(true);
    expect(shouldAttachUserAgent(new Request(same, { mode: 'same-origin' }), undefined, SELF)).toBe(true);
    expect(shouldAttachUserAgent(same, undefined, SELF)).toBe(true);
    expect(shouldAttachUserAgent('/tiles/1/0/0.png', undefined, SELF)).toBe(true);
  });

  it('別オリジン・no-cors には付けない。SW の場所が分からなければ付けない', () => {
    expect(shouldAttachUserAgent(new Request(other), undefined, SELF)).toBe(false);
    expect(shouldAttachUserAgent(other, undefined, SELF)).toBe(false);
    expect(shouldAttachUserAgent(new Request(same, { mode: 'no-cors' }), undefined, SELF)).toBe(false);
    expect(shouldAttachUserAgent(same, { mode: 'no-cors', credentials: 'omit' }, SELF)).toBe(false);
    expect(shouldAttachUserAgent(new Request(same), { mode: 'no-cors' }, SELF)).toBe(false);
    expect(shouldAttachUserAgent(same, undefined, undefined)).toBe(false);
  });

  it('withUserAgent はヘッダを足し、mode・credentials・他のヘッダを保つ。明示の User-Agent があれば作らない', () => {
    const r = withUserAgent(new Request(same, { mode: 'same-origin', credentials: 'include', headers: { 'x-a': '1' } }), undefined, 'UA');
    expect(r?.headers.get('user-agent')).toBe('UA');
    expect(r?.headers.get('x-a')).toBe('1');
    expect(r?.mode).toBe('same-origin');
    expect(r?.credentials).toBe('include');
    expect(withUserAgent(new Request(same, { headers: { 'user-agent': 'Mine' } }), undefined, 'UA')).toBeUndefined();
  });
});

describe('ctx.upstreamFetch（上流への取得の 1 つの関数）', () => {
  const setup = () => {
    const fetchMock = vi.fn(async () => png());
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('self', { location: new URL(SELF.href) });
    vi.stubGlobal('navigator', { userAgent: BROWSER });
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    return fetchMock;
  };
  const sentUa = (m: ReturnType<typeof vi.fn>, i = 0) => (m.mock.calls[i][0] as Request).headers.get('user-agent');

  it('同じオリジンの要求に既定値を付ける', async () => {
    const f = setup();
    await createContext().upstreamFetch(new Request(`${SW_SELF_ORIGIN}/a.png`));
    expect(sentUa(f)).toBe(`${BROWSER} Weiwudi/${VERSION}`);
  });

  it('別オリジン・no-cors は引数のまま fetch を呼ぶ（Request を作り直さない）', async () => {
    const f = setup();
    const ctx = createContext();
    const cross = new Request('https://t.example/a.png');
    await ctx.upstreamFetch(cross);
    expect(f.mock.calls[0]).toEqual([cross]);
    expect(f.mock.calls[0][0]).toBe(cross);
    const init = { mode: 'no-cors' as const, credentials: 'omit' as const };
    await ctx.upstreamFetch(`${SW_SELF_ORIGIN}/a.png`, init);
    expect(f.mock.calls[1]).toEqual([`${SW_SELF_ORIGIN}/a.png`, init]);
  });

  it('SW 側の指定（ContextOptions.userAgent）を使い、ページの指定（kv）があればそちらを使う', async () => {
    const f = setup();
    const ctx = createContext({ userAgent: () => 'SwSide/1' });
    await ctx.upstreamFetch(`${SW_SELF_ORIGIN}/a.png`);
    expect(sentUa(f, 0)).toBe(`${BROWSER} SwSide/1 Weiwudi/${VERSION}`);
    await (await ctx.store()).kvPut(KV_USER_AGENT, { userAgent: 'Page/2' });
    ctx.userAgent.loaded = undefined;
    await ctx.upstreamFetch(`${SW_SELF_ORIGIN}/a.png`);
    expect(sentUa(f, 1)).toBe(`${BROWSER} Page/2 Weiwudi/${VERSION}`);
  });

  it('store が開けなくても取得は止めない（SW 側の指定か既定値で送る）', async () => {
    const f = setup();
    const ctx = createContext({ open: () => Promise.reject(new Error('blocked')), userAgent: () => 'SwSide/1' });
    await ctx.upstreamFetch(`${SW_SELF_ORIGIN}/a.png`);
    expect(sentUa(f)).toBe(`${BROWSER} SwSide/1 Weiwudi/${VERSION}`);
  });

  it('store の読み込みが止まっても、上限の時間で既定値に切り替えて送る', async () => {
    const f = setup();
    vi.useFakeTimers();
    const ctx = createContext({ open: () => new Promise<Store>(() => undefined) });
    const p = ctx.upstreamFetch(`${SW_SELF_ORIGIN}/a.png`);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(sentUa(f)).toBe(`${BROWSER} Weiwudi/${VERSION}`);
  });
});

describe('SW 側の setUserAgent', () => {
  it('検査した値を持ち、undefined で外す。不正な値は attribute-invalid で、前の値を変えない', () => {
    setUserAgent(' Maplat/2.0 ');
    expect(getUserAgent()).toBe('Maplat/2.0');
    expect(codeOf(() => setUserAgent('  '))).toBe('attribute-invalid');
    expect(getUserAgent()).toBe('Maplat/2.0');
    setUserAgent(undefined);
    expect(getUserAgent()).toBeUndefined();
  });
});

// ---- SW 全体（ハーネス）: 新旧の API とも同じ関数を通る ----

const SAME_TPL = `${SW_SELF_ORIGIN}/tiles/{z}/{x}/{y}.png`;
const CROSS_TPL = 'https://t.example/{z}/{x}/{y}.png';

const harness = (): SwHarness => {
  const h = createSwHarness();
  vi.stubGlobal('navigator', { userAgent: BROWSER });
  h.fetch.mockImplementation(async () => png());
  return h;
};

const registerBoth = async () => {
  const ctx = createContext();
  const store = await ctx.store();
  await applyRegister(store, normalizeSpec({ kind: 'raster', url: SAME_TPL }));
  await applyRegister(store, normalizeSpec({ kind: 'raster', url: CROSS_TPL }));
};

/** 上流へ出た要求（URL ごとの最後のもの）の User-Agent */
const uaSentTo = (h: SwHarness, url: string): string | null | undefined => {
  const calls = h.fetch.mock.calls.filter((c) => (c[0] instanceof Request ? c[0].url : String(c[0])) === url);
  const last = calls[calls.length - 1]?.[0];
  return last instanceof Request ? last.headers.get('user-agent') : undefined;
};

describe('SW の配信（新 API）', () => {
  it('同じオリジンの上流には既定値、別オリジンには付けない', async () => {
    const h = harness();
    await registerBoth();
    await h.flushRoutes();
    await h.dispatch(`${SW_SELF_ORIGIN}/tiles/1/0/0.png`);
    await h.dispatch('https://t.example/1/0/0.png');
    expect(uaSentTo(h, `${SW_SELF_ORIGIN}/tiles/1/0/0.png`)).toBe(`${BROWSER} Weiwudi/${VERSION}`);
    expect(uaSentTo(h, 'https://t.example/1/0/0.png')).toBeNull();
  });

  it('no-cors の要求（<img>）は同じオリジンでも付けない', async () => {
    const h = harness();
    await registerBoth();
    await h.flushRoutes();
    // §4.5: 匿名の no-cors はまず cors に組み替えて取る。組み替えた要求は cors なので付く。元の形での取り直しには付けない
    h.fetch.mockImplementationOnce(async () => { throw new TypeError('cors failed'); });
    await h.dispatch(new Request(`${SW_SELF_ORIGIN}/tiles/2/0/0.png`, { mode: 'no-cors' }));
    const calls = h.fetch.mock.calls.map((c) => c[0] as Request).filter((r) => r.url === `${SW_SELF_ORIGIN}/tiles/2/0/0.png`);
    expect(calls.map((r) => r.mode)).toEqual(['cors', 'no-cors']);
    expect(calls[0].headers.get('user-agent')).toBe(`${BROWSER} Weiwudi/${VERSION}`);
    expect(calls[1].headers.get('user-agent')).toBeNull();
  });

  it('POST /v2/setUserAgent の値を kv に保存して使い、{} で外す。SW 側の setUserAgent より先', async () => {
    const h = harness();
    // ハーネスが登録表を空にするので、作った後に指定する（SW のスクリプトの先頭で呼ぶのと同じく、取得より前）
    setUserAgent('SwSide/1');
    await registerBoth();
    await h.flushRoutes();
    const url = `${SW_SELF_ORIGIN}/tiles/3/0/0.png`;
    await h.dispatch(url);
    expect(uaSentTo(h, url)).toBe(`${BROWSER} SwSide/1 Weiwudi/${VERSION}`);

    const r = await h.post('/v2/setUserAgent', { userAgent: 'Maplat/2.0' });
    expect(await r!.json()).toEqual({ ok: true, result: null });
    expect(await (await createContext().store()).kvGet(KV_USER_AGENT)).toEqual({ userAgent: 'Maplat/2.0' });
    await h.dispatch(`${SW_SELF_ORIGIN}/tiles/3/0/1.png`);
    expect(uaSentTo(h, `${SW_SELF_ORIGIN}/tiles/3/0/1.png`)).toBe(`${BROWSER} Maplat/2.0 Weiwudi/${VERSION}`);

    await h.post('/v2/setUserAgent', {});
    expect(await (await createContext().store()).kvGet(KV_USER_AGENT)).toEqual({});
    await h.dispatch(`${SW_SELF_ORIGIN}/tiles/3/1/1.png`);
    expect(uaSentTo(h, `${SW_SELF_ORIGIN}/tiles/3/1/1.png`)).toBe(`${BROWSER} SwSide/1 Weiwudi/${VERSION}`);
  });

  it('POST /v2/setUserAgent の不正な値は attribute-invalid で、保存しない', async () => {
    const h = harness();
    const r = await h.post('/v2/setUserAgent', { userAgent: 'x'.repeat(201) });
    const body = await r!.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('attribute-invalid');
    expect(await (await createContext().store()).kvGet(KV_USER_AGENT)).toBeUndefined();
  });

  it('別の SW の起動（新しい context）でも kv の値を使う', async () => {
    const h1 = harness();
    await h1.post('/v2/setUserAgent', { userAgent: 'Maplat/2.0' });
    const h2 = createSwHarness({ factory: h1.factory });
    vi.stubGlobal('navigator', { userAgent: BROWSER });
    h2.fetch.mockImplementation(async () => png());
    const ctx = createContext();
    await applyRegister(await ctx.store(), normalizeSpec({ kind: 'raster', url: SAME_TPL }));
    await h2.flushRoutes();
    await h2.dispatch(`${SW_SELF_ORIGIN}/tiles/4/0/0.png`);
    expect(uaSentTo(h2, `${SW_SELF_ORIGIN}/tiles/4/0/0.png`)).toBe(`${BROWSER} Maplat/2.0 Weiwudi/${VERSION}`);
  });
});

describe('SW の配信（旧 API）', () => {
  it('旧 API のタイルも同じ関数を通る: 同じオリジンには付け、別オリジンは fetch(URL の文字列) のまま', async () => {
    const h = harness();
    await h.post('/v2/setUserAgent', { userAgent: 'Maplat/2.0' });
    await h.request(`/api/add?mapID=s&type=xyz&url=${encodeURIComponent(SAME_TPL)}&width=1024&height=1024`);
    await h.request(`/api/add?mapID=c&type=xyz&url=${encodeURIComponent(CROSS_TPL)}&width=1024&height=1024`);
    await h.request('/api/cache/s/2/1/0');
    await h.request('/api/cache/c/2/1/0');
    expect(uaSentTo(h, `${SW_SELF_ORIGIN}/tiles/2/1/0.png`)).toBe(`${BROWSER} Maplat/2.0 Weiwudi/${VERSION}`);
    const cross = h.fetch.mock.calls.filter((c) => c[0] === 'https://t.example/2/1/0.png');
    expect(cross).toEqual([['https://t.example/2/1/0.png']]);
  });
});

describe('ページの registerSW', () => {
  class Container {
    controller: object | null = {};
    register = vi.fn(async () => ({}) as ServiceWorkerRegistration);
    ready = Promise.resolve();
    addEventListener() {}
    removeEventListener() {}
  }
  const setupPage = async (reply: (op: string, body: unknown) => Response = () => new Response(JSON.stringify({ ok: true, result: null }))) => {
    vi.resetModules();
    const container = new Container();
    const posts: { op: string; body: unknown }[] = [];
    vi.stubGlobal('navigator', { serviceWorker: container });
    vi.stubGlobal('location', { href: 'https://page.example/index.html' });
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/ping')) return new Response(JSON.stringify({ api: 2, version: VERSION }));
      if (url.endsWith('/api/ping')) return new Response('Implemented');
      const op = url.slice('https://weiwudi.example.com/v2/'.length);
      const body = JSON.parse(String(init?.body));
      posts.push({ op, body });
      return reply(op, body);
    }));
    const mod = await import('../../src/weiwudi');
    return { Weiwudi: mod.default, WeiwudiError: mod.WeiwudiError, container, posts };
  };

  it('不正な userAgent は登録の前に WeiwudiError(attribute-invalid)。register を呼ばない', async () => {
    const { Weiwudi, WeiwudiError: E, container } = await setupPage();
    const e = await Weiwudi.registerSW('./sw.js', { scope: './', userAgent: ' \t ' }).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(E);
    expect((e as WeiwudiError).code).toBe('attribute-invalid');
    expect(container.register).not.toHaveBeenCalled();
  });

  it('userAgent を除いた options で register し、制御下に入った後で setUserAgent を送る', async () => {
    const { Weiwudi, container, posts } = await setupPage();
    await Weiwudi.registerSW('./sw.js', { scope: './', userAgent: 'Maplat/2.0' });
    expect(container.register).toHaveBeenCalledWith('./sw.js', { scope: './' });
    expect(posts).toEqual([{ op: 'setUserAgent', body: { userAgent: 'Maplat/2.0' } }]);
  });

  it('省略すると前の値を外す（{} を送る）。options はそのまま渡す', async () => {
    const { Weiwudi, container, posts } = await setupPage();
    const opts = { scope: './' };
    await Weiwudi.registerSW('./sw.js', opts);
    expect(container.register.mock.calls[0][1]).toBe(opts);
    expect(posts).toEqual([{ op: 'setUserAgent', body: {} }]);
  });

  it('省略したときの外す送信が失敗しても（旧い SW など）登録は成功する', async () => {
    const { Weiwudi } = await setupPage(() => new Response('Not Found', { status: 404 }));
    await expect(Weiwudi.registerSW('./sw.js')).resolves.toBeDefined();
  });

  it('指定したときの失敗は WeiwudiError で reject する', async () => {
    const { Weiwudi, WeiwudiError: E } = await setupPage(() =>
      new Response(JSON.stringify({ ok: false, error: { code: 'api-not-found', message: 'Operation "setUserAgent" not found' } })));
    const e = await Weiwudi.registerSW('./sw.js', { userAgent: 'Maplat/2.0' }).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(E);
    expect((e as WeiwudiError).code).toBe('api-not-found');
  });
});
