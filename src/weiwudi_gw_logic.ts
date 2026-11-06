/// <reference lib="webworker" />
// 配線だけ（仕様 §3・§13・§4.3）。実行中の状態（context）を呼び出しごとに 1 つ作り、install・activate のリスナと、
// 疑似ホストの GET のルート 1 本・制御の POST のルート（/v2/*）・照合ルート・門番（hook）をこの順に登録する。
// 疑似ホストの GET のうち /v2/ で始まるパス（ping）は control へ、それ以外は legacy へ渡す（legacy から control を
// 呼ばない。第 2 回 O12）。
import type { RouteHandlerCallback, RouteMatchCallback } from 'workbox-core';
import { createContext } from './context';
import { createControl } from './control';
import { handleLegacy } from './legacy';
import { installHook } from './hook';
import { credentialSourceFor } from './registry';
import { getProviders } from './plugins';
import { createMapboxProvider } from './providers/mapbox';
import { appendQueryCredentials } from './upstream';
import { acceptsMember } from './spec';

declare const self: ServiceWorkerGlobalScope;

// Allow string based method to be compatible with both Workbox types and simple strings
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Weiwudi_Internal(registerRoute: (capture: RegExp | RouteMatchCallback, handler: RouteHandlerCallback, method?: any) => unknown) {
  "use strict";
  // 提供元は利用者のもの（addProvider の登録順）を先に、標準の mapbox を後に評価する（m3-t5・R13）
  const mapbox = createMapboxProvider(appendQueryCredentials);
  const providers = () => [...getProviders(), mapbox];
  // 本体の資格情報の除去は、スタイルの子作りと同じ判定（spec.acceptsMember）で組を選ぶ（m3-t7。hook は spec を import できない）
  const ctx = createContext({
    providers,
    acceptsMember: (type, templates, credentialParams) => acceptsMember(type, templates, credentialParams, providers()),
  });

  // 初回ナビゲーションをリロードせずに SW の制御下へ置くため、install で skipWaiting・
  // activate で clients.claim を実行する（#30）
  self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
  });
  self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
  });

  const control = createControl(ctx);
  const handlerCb: RouteHandlerCallback = async (options) => {
    if (options.url.pathname.startsWith('/v2/')) return control.get(options);
    return handleLegacy(ctx, options);
  };

  registerRoute(/^https?:\/\/weiwudi\.example\.com(?=[/?#]|$)/, handlerCb, 'GET');
  // 制御（仕様 §4.3 の表の 2 本目）。本文は text/plain;charset=UTF-8 の JSON（preflight の要らない単純要求）
  registerRoute(/^https?:\/\/weiwudi\.example\.com\/v2\//, control.post, 'POST');
  // 照合ルート（同期）と門番（queueMicrotask）。資格情報の Source は registry の規則で選ぶ（hook は registry を import できない）
  installHook(ctx, registerRoute, { pickCredentialSource: credentialSourceFor });
}
