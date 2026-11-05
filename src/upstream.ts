// 上流の取得と CORS・認証付きの要求（仕様 §4.5・§4.6・§10。m2-t7）。core.serve に渡す upstream を作る。
// 値の依存は context・store・url_pattern・constants・errors だけ（仕様 §3。値で使っているのは constants だけ）。
//
// 決まり:
// - 匿名の要求は mode: 'cors'・credentials: 'same-origin' に組み替える。認証付きの要求は元の Request のまま
// - corsOk・corslessUntil は判定のたびに store から読み直し、書き換えは patchResource（1 tx で読み・直し・書き。第 1 回 S2）。
//   書き換えの関数の中でも実績の有無を見直す（別の SW が同じ DB に書くため）
// - corslessStreak は context のメモリだけ（保存しない）
// - 条件付き要求（If-None-Match など）を出さない
// - 登録の資格情報は要求に無いときだけ足す（R5）。足す相手のオリジンは呼び出し側（hook）が選ぶ（I2）。
//   差し込み口の後の要求のオリジンがページの要求と違えば足さない（I1・R21）。ヘッダを足した要求は redirect: 'error'
// - 範囲取得側の規則（jobOpaqueStreak ほか）と opaque イベントは m4
import type { Context } from './context';
import type { ServeInput, UpstreamResult } from './core';
import type { Credentials, ResourceMeta, ResourcePolicy } from './store';
import { DAY_MS } from './constants';

/** CORS 非対応と見なすまでの opaque の連続数（仕様 §4.5-3） */
export const CORSLESS_STREAK_LIMIT = 3;
/** corslessUntil の長さ（仕様 §4.5-3） */
export const CORSLESS_PERIOD_MS = DAY_MS;

/** 上流へ出さないヘッダ（条件付き要求。preflight を誘発する。仕様 §4.5 末尾） */
const CONDITIONAL_HEADERS: readonly string[] = ['if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range'];

/** 仕様 §4.6: Authorization がある、または mode: 'cors' で credentials: 'include'。<img> の include（no-cors）は含めない */
export function isAuthenticated(request: Request): boolean {
  return request.headers.has('authorization') || (request.mode === 'cors' && request.credentials === 'include');
}

/** 保存の可否（仕様 §4.6）: 認証付きは policy.store（cachePrivate）のときだけ。匿名は保存する */
export function isStorable(request: Request, policy: ResourcePolicy): boolean {
  return !isAuthenticated(request) || policy.store;
}

/** 空の資格情報（putCredentials(id, {}) で消したもの）は無いものと数える */
export function hasCredentials(c: Credentials | undefined): c is Credentials {
  return !!c && (Object.keys(c.query ?? {}).length > 0 || Object.keys(c.headers ?? {}).length > 0);
}

/**
 * 上流へ出す URL とヘッダを作る。条件付きのヘッダを落とし、登録の資格情報を要求に無いときだけ足す。
 * クエリは文字列で末尾に足す（既存の項目の符号化を変えない。署名つきの URL を壊さない）
 */
const outgoing = (request: Request, credentials: Credentials | undefined): { url: string; headers: Headers; addedHeader: boolean } => {
  const headers = new Headers(request.headers);
  for (const h of CONDITIONAL_HEADERS) headers.delete(h);
  const url = new URL(request.url);
  let addedHeader = false;
  if (credentials) {
    const have = new Set([...url.searchParams.keys()].map((n) => n.toLowerCase()));
    let search = url.search;
    for (const [name, value] of Object.entries(credentials.query ?? {})) {
      if (have.has(name.toLowerCase())) continue;
      search += `${search === '' ? '?' : '&'}${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    }
    url.search = search;
    for (const [name, value] of Object.entries(credentials.headers ?? {})) {
      if (headers.has(name)) continue;
      headers.set(name, value);
      addedHeader = true;
    }
  }
  return { url: url.href, headers, addedHeader };
};

/**
 * 要求を mode・credentials を指定して作り直す（referrer などは元のまま）。
 * ヘッダの資格情報を足したときは redirect: 'error'（別オリジンへのリダイレクトにヘッダを持って行かせない。I1・R21）。
 * それ以外は元の redirect のまま
 */
const rebuild = (request: Request, credentials: Credentials | undefined, mode: RequestMode, cred: RequestCredentials): Request => {
  const { url, headers, addedHeader } = outgoing(request, credentials);
  return new Request(url, {
    method: request.method,
    headers,
    mode,
    credentials: cred,
    redirect: addedHeader ? 'error' : request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  });
};

/** 1 回の取得。opaque は opaque、TypeError などは network */
const attempt = async (request: Request): Promise<UpstreamResult> => {
  try {
    const response = await fetch(request);
    return { kind: response.type === 'opaque' ? 'opaque' : 'response', response };
  } catch (error) {
    return { kind: 'network', error };
  }
};

const experienced = (m: ResourceMeta | undefined): boolean => !!m && (m.count > 0 || m.corsOk === true);

export interface UpstreamOptions {
  resourceId: string;
  /** ページから届いた要求（認証付きの判定に使う。差し込み口が替えた要求ではない） */
  original: Request;
  /** 足す資格情報（hook がオリジンで選んだもの。認証付きの要求には足さない） */
  credentials?: Credentials;
  now: () => number;
}

/** CORS を通った応答を受けた: 連続数を 0 に、corsOk を立て、corslessUntil を消す */
const markCors = async (ctx: Context, read: ResourceMeta | undefined, o: UpstreamOptions): Promise<void> => {
  ctx.corslessStreak.delete(o.resourceId);
  if (read && read.corsOk === true && read.corslessUntil === undefined) return;
  try {
    const store = await ctx.store();
    await store.patchResource(o.resourceId, (m) => {
      if (m.corsOk === true && m.corslessUntil === undefined) return undefined;
      const next: ResourceMeta = { ...m, corsOk: true };
      delete next.corslessUntil;
      return next;
    });
  } catch (_e) {
    // 印の書き込みの失敗は配信を止めない（次の応答で書き直す）
  }
};

/** 実績が無いうちの opaque を数え、上限で corslessUntil を書く。書いたら連続数は 0 から数え直す */
const countCorsless = async (ctx: Context, o: UpstreamOptions, t: number): Promise<void> => {
  const n = (ctx.corslessStreak.get(o.resourceId) ?? 0) + 1;
  if (n < CORSLESS_STREAK_LIMIT) {
    ctx.corslessStreak.set(o.resourceId, n);
    return;
  }
  ctx.corslessStreak.delete(o.resourceId);
  try {
    const store = await ctx.store();
    // 書き換えの関数の中でも実績を見直す（読んだ後に別の要求・別の SW が CORS を通していれば書かない）
    await store.patchResource(o.resourceId, (m) => (experienced(m) ? undefined : { ...m, corslessUntil: t + CORSLESS_PERIOD_MS }));
  } catch (_e) {
    // 書けなければ次の判定でまた数える
  }
};

const readResource = async (ctx: Context, id: string): Promise<ResourceMeta | undefined> => {
  try {
    return await (await ctx.store()).getResource(id);
  } catch (_e) {
    return undefined;
  }
};

/**
 * core.serve に渡す upstream（仕様 §4.5 の手順 1〜4・§4.6）。request は差し込み口を通した後の要求で、
 * 匿名の要求ではこれを組み替える（mode・credentials・条件付きのヘッダ・資格情報）
 */
export function createUpstream(ctx: Context, o: UpstreamOptions): ServeInput['upstream'] {
  return async (request, { hasEntry, requestChanged }) => {
    // §4.6 認証付き: 元の Request のまま。組み替えず、2〜4 も通らない（hasEntry も見ない）
    if (isAuthenticated(o.original)) return attempt(request);

    // 差し込み口が別オリジンへ替えた要求には登録の資格情報を足さない（I1・R21）
    const credentials = requestChanged && new URL(request.url).origin !== new URL(o.original.url).origin ? undefined : o.credentials;

    const t = o.now();
    const read = await readResource(ctx, o.resourceId);
    const noCors = request.mode === 'no-cors';
    const retry = () => attempt(rebuild(request, credentials, request.mode, request.credentials));

    // §4.5-3 corslessUntil の間は 1 を省いて元の要求を出す（元が cors の要求は 1 で取る）
    if (noCors && read?.corslessUntil !== undefined && read.corslessUntil > t) return retry();

    // 1 組み替えた形で取る
    let first: Response;
    try {
      first = await fetch(rebuild(request, credentials, 'cors', 'same-origin'));
    } catch (error) {
      // 4 元の要求が cors なら取り直さない
      if (!noCors) return { kind: 'network', error };
      // 2 元の要求（no-cors）で 1 回取り直す。両方失敗（オフライン）は数えない
      const second = await retry();
      // 3 実績が無いうちの opaque だけを数える。実績があれば upstream として serve が §6 の 4・5 にする
      if (second.kind === 'opaque' && !experienced(read)) await countCorsless(ctx, o, t);
      return second;
    }
    // CORS を通った（状態コードを問わない）
    await markCors(ctx, read, o);

    // §4.5-3 S-F: no-cors の要求の 401・403。Entry があれば取り直さない（serve が古い本体を返す）
    if (noCors && (first.status === 401 || first.status === 403) && !hasEntry) {
      const second = await retry();
      // 取り直しが TypeError なら 1 の応答をそのまま（serve が §6 の 5 にする）
      return second.kind === 'network' ? { kind: 'response', response: first } : second;
    }
    return { kind: first.type === 'opaque' ? 'opaque' : 'response', response: first };
  };
}
