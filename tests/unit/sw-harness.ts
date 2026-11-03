// Service Worker の環境を Node の上で差し替えて Weiwudi_Internal を呼ぶ補助（Weiwudi#43・m2-t1）。
// *.test.ts ではないので vitest は収集しない。
//
// - self: addEventListener（登録を記録）・skipWaiting・clients（claim・get）・location を持つ偽物
// - indexedDB: 既定はハーネスごとに新しい fake-indexeddb の IDBFactory（DB を持ち越さない）。
//   `createSwHarness({ factory })` で同じ factory を渡すと、同じオリジンの 2 つの SW として DB を共有する
// - FetchEvent: Node に無いので偽のクラス（handlerCb の instanceof のため）。waitUntil を記録する
// - BroadcastChannel: 同じ factory のハーネスどうしで届く偽の母線（`bus.disable()` で止める）
// - fetch: テストごとに応答を決める vi.fn
//
// 呼び出し側は afterEach で vi.unstubAllGlobals() と vi.useRealTimers() を呼んで戻すこと。
// 2 つのハーネスを同じ試験で作ると、self・fetch・FetchEvent・BroadcastChannel の大域の差し替えは
// 後から作った方になる（Weiwudi_Internal の呼び出しの中で作られた BroadcastChannel は、その時の母線に繋がる）。
import { vi, type Mock } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Weiwudi_Internal } from '../../src/weiwudi_gw_logic';

// 差し込み口の登録表（t4 で入る src/plugins.ts）。無いあいだは何もしない。
// 行き先を変数にして、ファイルが無いときに型検査とバンドラの解決で落ちないようにする
const PLUGINS_MODULE = '../../src/plugins';
// 握るのは「plugins そのものが見つからない」ときだけ。plugins.ts の中の例外（構文・初期化の誤り、
// plugins.ts が読む別のモジュールが無い）は投げ直す。vitest 5 の実測: code が ERR_MODULE_NOT_FOUND で、
// 文面が `Cannot find module '/src/plugins' imported from …`（見つからない側の名前が引用符の中）
export const isPluginsNotFound = (e: unknown): boolean => {
  const err = e as { code?: unknown; message?: unknown } | null;
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') return false;
  const message = typeof err.message === 'string' ? err.message : '';
  return /Cannot find module '[^']*src\/plugins(\.ts)?'/.test(message);
};
const pluginsModule = (await import(/* @vite-ignore */ PLUGINS_MODULE).catch((e: unknown) => {
  if (isPluginsNotFound(e)) return undefined;
  throw e;
})) as
  | { _resetPluginsForTest?: () => void }
  | undefined;

export const SW_ORIGIN = 'https://weiwudi.example.com';
/** SW 自身のオリジン（Workbox の RegExpRoute が「同じオリジンか」を見るのに使う） */
export const SW_SELF_ORIGIN = 'http://localhost:5173';

type Listener = (event: unknown) => void;

interface MatchOptions {
  url: URL;
  request: Request;
  event: unknown;
  sameOrigin: boolean;
}
type MatchCallback = (options: MatchOptions) => unknown;
type HandlerCallback = (options: { url: URL; request: Request; event: unknown; params?: unknown }) => unknown;
type Handler = HandlerCallback | { handle: HandlerCallback };

/** registerRoute に渡された 1 つのルート（登録順） */
export interface HarnessRoute {
  /** 渡されたままの第 1 引数（RegExp・文字列・関数・Route のようなもの） */
  capture: unknown;
  /** 渡されたままの第 2 引数 */
  handler: unknown;
  /** method（省略時は Workbox と同じく GET） */
  method: string;
  /** Workbox と同じ形にした照合 */
  match: MatchCallback;
  /** Workbox と同じ形にした handler */
  handle: HandlerCallback;
}

export interface Bus {
  /** 母線を止める（以後の postMessage はどこにも届かない） */
  disable: () => void;
  /** 止めた母線を戻す */
  enable: () => void;
  /** 届けた数（試験の確かめ用） */
  delivered: number;
}

export interface SwHarness {
  /** 旧 API のルートの捕捉の正規表現 */
  capture: RegExp;
  /** 旧 API のルートの method */
  method: unknown;
  /** registerRoute の偽物 */
  registerRoute: Mock;
  /** 登録順のルート（後から登録されたものも入る） */
  routes: HarnessRoute[];
  /** microtask で後から登録されるルートを待つ */
  flushRoutes: () => Promise<void>;
  /** Workbox の Router と同じく、method ごとに登録順に照合し、最初に当たった handler を呼ぶ。当たらなければ undefined */
  dispatch: (request: Request | string, opts?: { event?: unknown; client?: unknown }) => Promise<Response | undefined>;
  /** text/plain;charset=UTF-8 の POST を dispatch する（本文が文字列でなければ JSON にする） */
  post: (path: string, body: unknown) => Promise<Response | undefined>;
  /** self.addEventListener で登録されたハンドラ（種別ごと） */
  listeners: Record<string, Listener[]>;
  /** self の偽物 */
  self: {
    addEventListener: Mock;
    skipWaiting: Mock;
    clients: { claim: Mock; get: Mock };
    location: URL;
  };
  /** fetch の偽物 */
  fetch: Mock;
  /** FetchEvent の waitUntil に渡された Promise（記録順） */
  waitUntilCalls: Promise<unknown>[];
  /** このハーネスの factory の母線 */
  bus: Bus;
  /** このハーネスの IndexedDB */
  factory: IDBFactory;
  /** 旧 API のパス（クエリ込み）を旧 API の handler へ渡し、Response を返す */
  request: (path: string) => Promise<Response>;
  /** ページ（client）から届いた要求として旧 API の handler へ渡す */
  requestFromClient: (path: string, client: unknown) => Promise<Response>;
}

// ---- BroadcastChannel の偽の母線（factory ごと） ----

interface FakeChannel {
  name: string;
  closed: boolean;
  receive: (data: unknown) => void;
}

interface BusState extends Bus {
  channels: Set<FakeChannel>;
  enabled: boolean;
}

const buses = new WeakMap<IDBFactory, BusState>();

const busFor = (factory: IDBFactory): BusState => {
  let bus = buses.get(factory);
  if (!bus) {
    const state: BusState = {
      channels: new Set(),
      enabled: true,
      delivered: 0,
      disable: () => { state.enabled = false; },
      enable: () => { state.enabled = true; },
    };
    bus = state;
    buses.set(factory, bus);
  }
  return bus;
};

const makeBroadcastChannel = (bus: BusState) =>
  class FakeBroadcastChannel {
    readonly name: string;
    onmessage: ((event: MessageEvent) => void) | null = null;
    private readonly listeners = new Set<(event: MessageEvent) => void>();
    private readonly self: FakeChannel;

    constructor(name: string) {
      this.name = String(name);
      this.self = {
        name: this.name,
        closed: false,
        receive: (data: unknown) => {
          const event = { data, type: 'message' } as MessageEvent;
          this.onmessage?.(event);
          for (const l of this.listeners) l(event);
        },
      };
      bus.channels.add(this.self);
    }

    postMessage(data: unknown) {
      if (this.self.closed) throw new DOMException('BroadcastChannel is closed', 'InvalidStateError');
      if (!bus.enabled) return;
      const copy = structuredClone(data);
      for (const ch of bus.channels) {
        if (ch === this.self || ch.closed || ch.name !== this.name) continue;
        // 実物と同じく非同期に届ける。届く時点で止まっていれば落とす
        queueMicrotask(() => {
          if (!bus.enabled || ch.closed) return;
          bus.delivered++;
          ch.receive(copy);
        });
      }
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === 'message') this.listeners.add(listener);
    }

    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === 'message') this.listeners.delete(listener);
    }

    close() {
      this.self.closed = true;
      bus.channels.delete(this.self);
    }
  };

// ---- Workbox の Route と同じ形に直す ----

const toMatch = (capture: unknown): MatchCallback => {
  if (capture instanceof RegExp) {
    // workbox-routing 7.4.1 の RegExpRoute と同じ: 別オリジンの URL は先頭から当たったときだけ。
    // 実物は lastIndex を戻さないので、ここも戻さない（g・y の正規表現は実物と同じく前回の位置から探す）
    return ({ url }) => {
      const result = capture.exec(url.href);
      if (!result) return undefined;
      if (url.origin !== SW_SELF_ORIGIN && result.index !== 0) return undefined;
      return result.slice(1);
    };
  }
  if (typeof capture === 'string') {
    const target = new URL(capture, SW_SELF_ORIGIN + '/').href;
    return ({ url }) => url.href === target;
  }
  if (typeof capture === 'function') return capture as MatchCallback;
  if (capture && typeof (capture as { match?: unknown }).match === 'function') {
    return (capture as { match: MatchCallback }).match;
  }
  throw new Error(`unsupported route capture: ${String(capture)}`);
};

const toHandle = (handler: unknown): HandlerCallback => {
  if (typeof handler === 'function') return handler as HandlerCallback;
  if (handler && typeof (handler as { handle?: unknown }).handle === 'function') {
    const h = handler as { handle: HandlerCallback };
    return (o) => h.handle(o);
  }
  throw new Error('unsupported route handler');
};

// Workbox の Router と同じく、空の配列・空の object・真偽値の params は undefined にする
const normalizeParams = (result: unknown): unknown => {
  if (Array.isArray(result) && result.length === 0) return undefined;
  if (result && (result as object).constructor === Object && Object.keys(result as object).length === 0) return undefined;
  if (typeof result === 'boolean') return undefined;
  return result;
};

export const createSwHarness = (opts: { factory?: IDBFactory } = {}): SwHarness => {
  // 差し込み口の登録表はモジュール変数なので、試験ごとに空にする（t4 から）
  pluginsModule?._resetPluginsForTest?.();

  const factory = opts.factory ?? new IDBFactory();
  const bus = busFor(factory);
  const listeners: Record<string, Listener[]> = {};
  const fakeSelf = {
    addEventListener: vi.fn((type: string, listener: Listener) => {
      (listeners[type] ||= []).push(listener);
    }),
    skipWaiting: vi.fn(() => Promise.resolve()),
    clients: {
      claim: vi.fn(() => Promise.resolve()),
      get: vi.fn(() => Promise.resolve(undefined)),
    },
    location: new URL(`${SW_SELF_ORIGIN}/weiwudi-sw.js`),
  };
  const fetchMock = vi.fn();
  const waitUntilCalls: Promise<unknown>[] = [];

  vi.stubGlobal('self', fakeSelf);
  vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  class FakeFetchEvent {
    clientId = 'client-1';
    request?: Request;
    constructor(request?: Request) {
      this.request = request;
    }
    waitUntil(p: Promise<unknown>) {
      waitUntilCalls.push(Promise.resolve(p));
    }
  }
  vi.stubGlobal('FetchEvent', FakeFetchEvent);
  vi.stubGlobal('BroadcastChannel', makeBroadcastChannel(bus));
  vi.stubGlobal('fetch', fetchMock);

  const routes: HarnessRoute[] = [];
  const registerRoute = vi.fn((capture: unknown, handler?: unknown, method?: string) => {
    // Route のようなもの（match・handler・method を持つ）を 1 引数で渡す形も受ける
    const isRouteObject = handler === undefined && capture && typeof (capture as { handler?: unknown }).handler !== 'undefined';
    const rawHandler = isRouteObject ? (capture as { handler: unknown }).handler : handler;
    const rawMethod = isRouteObject ? (capture as { method?: string }).method : method;
    routes.push({
      capture,
      handler: rawHandler,
      // workbox-routing 7.4.1 の Route と同じ: 省略（undefined）のときだけ既定の 'GET'。大文字にはしない
      method: rawMethod === undefined ? 'GET' : rawMethod,
      match: toMatch(capture),
      handle: toHandle(rawHandler),
    });
  });
  Weiwudi_Internal(registerRoute);

  // 旧 API のルート: RegExp を capture にして method が GET の呼び出しがちょうど 1 つ
  const legacy = routes.filter((r) => r.capture instanceof RegExp && r.method === 'GET');
  if (legacy.length !== 1) {
    throw new Error(`expected exactly one legacy GET route with a RegExp capture, got ${legacy.length}`);
  }
  const [legacyRoute] = legacy;
  const handler = legacyRoute.handler as HandlerCallback;

  const request = async (path: string): Promise<Response> => {
    const url = new URL(SW_ORIGIN + path);
    return handler({ url, event: undefined } as never) as Promise<Response>;
  };

  const requestFromClient = async (path: string, client: unknown): Promise<Response> => {
    fakeSelf.clients.get.mockResolvedValueOnce(client as never);
    return handler({ url: new URL(SW_ORIGIN + path), event: new FakeFetchEvent() } as never) as Promise<Response>;
  };

  const flushRoutes = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };

  const dispatch = async (input: Request | string, dopts: { event?: unknown; client?: unknown } = {}) => {
    const req = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(req.url);
    const event = dopts.event ?? new FakeFetchEvent(req);
    if (dopts.client !== undefined) fakeSelf.clients.get.mockResolvedValueOnce(dopts.client as never);
    const sameOrigin = url.origin === SW_SELF_ORIGIN;
    // workbox-routing 7.4.1 の Router と同じ: 登録された method の文字列のまま request.method で引く
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const result = route.match({ url, request: req, event, sameOrigin });
      if (!result) continue;
      return (await route.handle({ url, request: req, event, params: normalizeParams(result) })) as Response | undefined;
    }
    return undefined;
  };

  const post = (path: string, body: unknown) =>
    dispatch(new Request(SW_ORIGIN + path, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }));

  return {
    capture: legacyRoute.capture as RegExp,
    method: legacyRoute.method,
    registerRoute,
    routes,
    flushRoutes,
    dispatch,
    post,
    listeners,
    self: fakeSelf,
    fetch: fetchMock,
    waitUntilCalls,
    bus,
    factory,
    request,
    requestFromClient,
  };
};

/** 指定バイト数・content-type の 200 応答を作る */
export const tileResponse = (bytes: number, contentType = 'image/png', fill = 1): Response =>
  new Response(new Uint8Array(bytes).fill(fill), {
    status: 200,
    headers: { 'content-type': contentType },
  });

/** opaque な応答（no-cors の別オリジン）を真似る。type・status・ok を上書きした Response（R10） */
export const opaqueResponse = (): Response => {
  const res = new Response(null, { status: 200 });
  Object.defineProperty(res, 'type', { value: 'opaque' });
  Object.defineProperty(res, 'status', { value: 0 });
  Object.defineProperty(res, 'ok', { value: false });
  return res;
};
