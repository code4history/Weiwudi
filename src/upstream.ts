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
//   （no-cors の要求を除く。ヘッダが送られないため）
// - 範囲取得側の規則（jobOpaqueStreak ほか）は range.ts。no-cors の確かめ（probeNoCors）は fetch を持つここに置く（m4-t3・R4）。
//   corslessUntil を書いたら ctx.notify で opaque イベントを 1 回送る（R20）
// - 提供元の Resource（provider が登録表にあるもの）は、クエリの資格情報を provider.applyCredentials で足す（m3-t5）。
//   オリジンの規則（I1）と redirect の規則はそのまま当たる。applyCredentials がオリジンを替えた結果は使わない
import type { Context } from './context';
import type { ServeInput, UpstreamResult } from './core';
import type { WeiwudiProvider } from './plugins';
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
 * クエリの資格情報を、要求に無い名前（大文字小文字を問わない）だけ url の末尾に文字列で足す
 * （既存の項目の符号化を変えない。署名つきの URL を壊さない）。提供元の applyCredentials もこれを使う（m3-t5）
 */
export function appendQueryCredentials(url: URL, query: Record<string, string>): void {
  const have = new Set([...url.searchParams.keys()].map((n) => n.toLowerCase()));
  let search = url.search;
  for (const [name, value] of Object.entries(query)) {
    if (have.has(name.toLowerCase())) continue;
    search += `${search === '' ? '?' : '&'}${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  }
  url.search = search;
}

/**
 * 提供元の applyCredentials でクエリを足す。投げたとき・オリジンを替えたときは足さない（元の url のまま）
 */
const applyProvider = (url: URL, provider: WeiwudiProvider, credentials: Credentials): URL => {
  const next = new URL(url.href);
  try {
    provider.applyCredentials(next, { ...credentials });
  } catch (e) {
    // 文面に資格情報が入り得るので、提供元の id と例外の名前だけを残す
    console.error(`weiwudi: applyCredentials of provider "${provider.id}" threw ${e instanceof Error ? e.name : typeof e}`);
    return url;
  }
  return next.origin === url.origin ? next : url;
};

/**
 * 上流へ出す URL とヘッダを作る。条件付きのヘッダを落とし、登録の資格情報を要求に無いときだけ足す。
 * クエリは汎用なら appendQueryCredentials、提供元の Resource なら provider.applyCredentials。ヘッダはどちらも汎用
 */
const outgoing = (
  request: Request, credentials: Credentials | undefined, provider: WeiwudiProvider | undefined,
): { url: string; headers: Headers; addedHeader: boolean } => {
  const headers = new Headers(request.headers);
  for (const h of CONDITIONAL_HEADERS) headers.delete(h);
  let url = new URL(request.url);
  let addedHeader = false;
  if (credentials) {
    if (provider) url = applyProvider(url, provider, credentials);
    else appendQueryCredentials(url, credentials.query ?? {});
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
 * no-cors の要求は除く: safelist に無いヘッダは捨てられて送られず、follow 以外の redirect は Fetch の main fetch で
 * network error になる（L1 M-1）。それ以外は元の redirect のまま
 */
const rebuild = (
  request: Request, credentials: Credentials | undefined, provider: WeiwudiProvider | undefined,
  mode: RequestMode, cred: RequestCredentials,
): Request => {
  const { url, headers, addedHeader } = outgoing(request, credentials, provider);
  const redirect: RequestInit = addedHeader && mode !== 'no-cors' ? { redirect: 'error' } : { redirect: request.redirect };
  return new Request(url, {
    method: request.method,
    headers,
    mode,
    credentials: cred,
    ...redirect,
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
  /** Resource の provider の提供元（登録表にあるときだけ。hook が ctx.providers() から引く。m3-t5） */
  provider?: WeiwudiProvider;
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
    const written = await store.patchResource(o.resourceId, (m) => (experienced(m) ? undefined : { ...m, corslessUntil: t + CORSLESS_PERIOD_MS }));
    // 書いたときだけ 1 回知らせる（R20）。知らせの失敗は配信を止めない
    if (written) {
      try {
        ctx.notify?.({ type: 'opaque', resourceId: written.id, sourceIds: written.sourceIds.slice() });
      } catch (_e) {
        // 送れなくても判定の結果（corslessUntil）は保存した
      }
    }
  } catch (_e) {
    // 書けなければ次の判定でまた数える
  }
};

/**
 * 範囲取得の no-cors の確かめ（仕様 §4.5-3・R4）。fetch(url, { mode: 'no-cors' }) を 1 回。登録の資格情報を足さず
 * Cookie も送らない（credentials: 'omit'。R-t3-5）・保存しない。opaque は 'opaque'、TypeError は 'network'、
 * それ以外の応答（同じオリジンの basic など）は 'response'（本文は読み捨てる）
 */
export async function probeNoCors(url: string): Promise<'opaque' | 'network' | 'response'> {
  let res: Response;
  try {
    res = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
  } catch (_e) {
    return 'network';
  }
  if (res.type === 'opaque') return 'opaque';
  try {
    await res.body?.cancel();
  } catch (_e) {
    // 読み捨ての失敗は結果を変えない
  }
  return 'response';
}

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
    const retry = () => attempt(rebuild(request, credentials, o.provider, request.mode, request.credentials));

    // §4.5-3 corslessUntil の間は 1 を省いて元の要求を出す（元が cors の要求は 1 で取る）
    if (noCors && read?.corslessUntil !== undefined && read.corslessUntil > t) return retry();

    // 1 組み替えた形で取る
    let first: Response;
    try {
      first = await fetch(rebuild(request, credentials, o.provider, 'cors', 'same-origin'));
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
