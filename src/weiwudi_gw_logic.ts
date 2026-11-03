/// <reference lib="webworker" />
// 配線だけ（仕様 §3・§13・§4.3）。実行中の状態（context）を呼び出しごとに 1 つ作り、install・activate のリスナと、
// 疑似ホストの GET のルート 1 本・照合ルート・門番（hook）を登録する。/v2/ で始まるパスは t8 の control へ、
// それ以外は legacy へ渡す（legacy から control を呼ばない。第 2 回 O12）。t8 までは /v2/ も legacy と同じ 404。
import type { RouteHandlerCallback, RouteMatchCallback } from 'workbox-core';
import { createContext } from './context';
import { handleLegacy } from './legacy';
import { installHook } from './hook';
import { credentialSourceFor } from './registry';

declare const self: ServiceWorkerGlobalScope;

// Allow string based method to be compatible with both Workbox types and simple strings
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Weiwudi_Internal(registerRoute: (capture: RegExp | RouteMatchCallback, handler: RouteHandlerCallback, method?: any) => unknown) {
  "use strict";
  const ctx = createContext();

  // 初回ナビゲーションをリロードせずに SW の制御下へ置くため、install で skipWaiting・
  // activate で clients.claim を実行する（#30）
  self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
  });
  self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
  });

  const handlerCb: RouteHandlerCallback = async (options) => {
    if (options.url.pathname.startsWith('/v2/')) return new Response('Not Found', { status: 404 });
    return handleLegacy(ctx, options);
  };

  registerRoute(/^https?:\/\/weiwudi\.example\.com(?=[/?#]|$)/, handlerCb, 'GET');
  // 照合ルート（同期）と門番（queueMicrotask）。資格情報の Source は registry の規則で選ぶ（hook は registry を import できない）
  installHook(ctx, registerRoute, { pickCredentialSource: credentialSourceFor });
}
