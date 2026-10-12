// Service Worker の環境を Node の上で差し替えて Weiwudi_Internal を呼ぶ補助（Weiwudi#43）。
// *.test.ts ではないので vitest は収集しない。
//
// - self: addEventListener（登録を記録）・skipWaiting・clients（claim・get）を持つ偽物
// - indexedDB: テストごとに新しい fake-indexeddb の IDBFactory（DB を持ち越さない）
// - FetchEvent: Node に無いので空のクラス（handlerCb の instanceof のため）
// - fetch: テストごとに応答を決める vi.fn
//
// 呼び出し側は afterEach で vi.unstubAllGlobals() と vi.useRealTimers() を呼んで戻すこと。
import { vi, type Mock } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Weiwudi_Internal } from '../../src/weiwudi_gw_logic';

export const SW_ORIGIN = 'https://weiwudi.example.com';

type Listener = (event: unknown) => void;

export interface SwHarness {
  /** registerRoute に渡された捕捉の正規表現 */
  capture: RegExp;
  /** registerRoute に渡された method */
  method: unknown;
  /** registerRoute の呼び出し回数 */
  registerRoute: Mock;
  /** self.addEventListener で登録されたハンドラ（種別ごと） */
  listeners: Record<string, Listener[]>;
  /** self の偽物 */
  self: {
    addEventListener: Mock;
    skipWaiting: Mock;
    clients: { claim: Mock; get: Mock };
  };
  /** fetch の偽物 */
  fetch: Mock;
  /** パス（クエリ込み）を SW のハンドラへ渡し、Response を返す */
  request: (path: string) => Promise<Response>;
}

export const createSwHarness = (): SwHarness => {
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
  };
  const fetchMock = vi.fn();

  vi.stubGlobal('self', fakeSelf);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('FetchEvent', class FetchEvent {});
  vi.stubGlobal('fetch', fetchMock);

  const registerRoute = vi.fn();
  Weiwudi_Internal(registerRoute);
  if (registerRoute.mock.calls.length !== 1) {
    throw new Error(`registerRoute was called ${registerRoute.mock.calls.length} times`);
  }
  const [capture, handler, method] = registerRoute.mock.calls[0];

  const request = async (path: string): Promise<Response> => {
    const url = new URL(SW_ORIGIN + path);
    return handler({ url, event: undefined });
  };

  return {
    capture,
    method,
    registerRoute,
    listeners,
    self: fakeSelf,
    fetch: fetchMock,
    request,
  };
};

/** 指定バイト数・content-type の 200 応答を作る */
export const tileResponse = (bytes: number, contentType = 'image/png', fill = 1): Response =>
  new Response(new Uint8Array(bytes).fill(fill), {
    status: 200,
    headers: { 'content-type': contentType },
  });
