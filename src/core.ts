// 配信の決定 serve()・退避の範囲・ジョブの進め方（仕様 §6・§7.1・§8。m2-t4）。
// 全経路（照合ルート・門番・旧 /api/cache・範囲取得）がこの serve() を通る。core は legacy を知らない。
// 値の依存は context・store・plugins・url_pattern・tile_math・errors だけ（仕様 §3）。
//
// 決まり:
// - モジュール変数を持たない（同時要求の Map は context が持つ）
// - 合成した応答すべてに x-weiwudi-status（7 値）・失敗時の x-weiwudi-error（4 語）・
//   access-control-expose-headers を付ける（上流の同名のヘッダは上書き。R9）。opaque には付けない
// - 合成した応答と保存する応答から 4 ヘッダ（content-encoding・content-length・transfer-encoding・set-cookie）と
//   上流の x-weiwudi-* をすべて落とす
// - 同時要求をまとめるのは storable の要求だけ。Range つきの要求は素通し（仕様 §11）
// - hit の touch は応答を返す前に呼び、完了は待たない（R8・第 1 回 O-6）
// - 保存に失敗しても配信は続け、x-weiwudi-error に quota か storage を付ける（#22）
// - store の読み出しの失敗（接続・Resource・Entry）は reject で返す（呼び出し側が旧 API の文面などへ直す）
import type { Context } from './context';
import { isChildRecord, storedSpecOf, styleSpecOf, toResourceInfo, type EntryBody, type EntryMeta, type EvictionScope, type ResourceInfo, type ResourceMeta, type SourceRecord, type Store } from './store';
import { getPlugins, type WeiwudiPlugin } from './plugins';
import { isInTileBox, scaleTileBox } from './tile_math';
import { WeiwudiError, type TileFailure } from './errors';

// ---- 型 ----

/** 上流の取得の結果。upstream の口は投げずにこれを返す（投げたときは network として扱う） */
export type UpstreamResult =
  | { kind: 'response'; response: Response }
  | { kind: 'opaque'; response: Response }
  | { kind: 'network'; error: unknown };

export interface ServeInput {
  resourceId: string;
  /** Entry のキー（resourceId + '\0' + suffix） */
  key: string;
  /** タイルの座標（範囲外の判定と Entry の z・x・y）。タイル以外は無し */
  coord?: { z: number; x: number; y: number };
  /**
   * 差し込み口へ渡す要求。`Range` ヘッダつきの要求は呼び出し側が serve に入れないのが契約（仕様 §11）。
   * 入ってきたときは守りとして素通しする（上流の応答をそのまま返し、保存・まとめ・差し込み口を使わない）
   */
  request: Request;
  /**
   * 上流の取得。request は差し込み口を通した後の要求。requestChanged は差し込み口が別の Request に替えたとき真
   * （旧 API はこれで fetch(URL の文字列) から fetch(Request) に切り替える。第 1 回 S8）
   */
  upstream: (request: Request, ctx: { hasEntry: boolean; requestChanged: boolean }) => Promise<UpstreamResult>;
  /** 仕様 §4.6 の判定（認証付きの要求は偽）。偽の要求は同時要求をまとめない（他の要求と応答を共有しない） */
  storable: boolean;
  /** style・tilejson は 200 の text/html を失敗にしない */
  isStyleLike?: boolean;
  /**
   * グリフの範囲（'0-255' など。仕様 §11）。あれば key（fontstack まで）のレコードの中の、この範囲の部分を Entry として扱う。
   * 鮮度と削除期限は部分の fetchedAt で見て、保存は store.putGlyphPart で部分を足す
   */
  part?: string;
  /**
   * 本体の書き換え（m3-t6・R28。style・tilejson の提供元の rewriteStyle と資格情報の除去）。上流が成功したとき（§6 の 3）、
   * 差し込み口の fetchDidSucceed の後・cacheWillUpdate の前に 1 度だけ当て、保存も配信も変えた本体を使う。
   * 投げたら上流の失敗（HTTP）として扱い（Entry があれば §6 の 4、無ければ 5）、保存しない（C-S4・C-S1）
   */
  transform?: (blob: Blob) => Promise<Blob>;
  /** 真なら §6 の 2（hit）を飛ばして上流へ出す。失敗したら表の 4・6 で古い本体（m3-t6・R4。update() の取り直し） */
  revalidate?: boolean;
}

/** x-weiwudi-status の値（公開の契約。仕様 §6） */
export type ServeStatus = 'out-of-range' | 'hit' | 'miss' | 'refresh' | 'stale' | 'upstream-error' | 'offline-miss';

// ---- 定数 ----

/** 範囲外のラスタの応答（現行の 256×256 の透明 PNG。配信では写しを使う） */
export const TRANSPARENT_PNG: Uint8Array = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAMAAABrrFhUAAAAB3RJTUUH3QgIBToaSbAjlwAAABd0' +
  'RVh0U29mdHdhcmUAR0xEUE5HIHZlciAzLjRxhaThAAAACHRwTkdHTEQzAAAAAEqAKR8AAAAEZ0FN' +
  'QQAAsY8L/GEFAAAAA1BMVEX///+nxBvIAAAAAXRSTlMAQObYZgAAAFRJREFUeNrtwQEBAAAAgJD+' +
  'r+4ICgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAABgBDwABHHIJwwAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

/** ベクタの空本体の content-type（登録時に分からないときの既定。仕様 §6） */
const VECTOR_TILE_TYPE = 'application/vnd.mapbox-vector-tile';

/** 保存時と合成時に落とすヘッダ（本体は復号済みなので、残すと再生時に矛盾する） */
const DROPPED_HEADERS: readonly string[] = ['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie'];

const H_STATUS = 'x-weiwudi-status';
const H_ERROR = 'x-weiwudi-error';
const H_EXPOSE = 'access-control-expose-headers';
const EXPOSE_VALUE = `${H_STATUS}, ${H_ERROR}`;

/** 上流の値を写さない名前の前置き（こちらの名前空間。上流の x-weiwudi-* はすべて落とす） */
const OWN_PREFIX = 'x-weiwudi-';

const JOB_BATCH = 5;

// ---- ヘッダの補助 ----

/** 保存にも合成にも写さないヘッダ（4 ヘッダと x-weiwudi-*） */
const isDropped = (n: string): boolean => DROPPED_HEADERS.indexOf(n) >= 0 || n.startsWith(OWN_PREFIX);

/** Headers を名前小文字の record にし、4 ヘッダと x-weiwudi-* を落とす */
const copyHeaders = (h: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  h.forEach((value, name) => {
    const n = name.toLowerCase();
    if (!isDropped(n)) out[n] = value;
  });
  return out;
};

const isHtml = (headers: Record<string, string>): boolean =>
  (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'text/html';

interface Parts {
  body: Blob | Uint8Array | null;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

/** 合成した応答を作る。4 ヘッダと上流の x-weiwudi-* を落とし、こちらのヘッダを付ける */
const synthesize = (p: Parts, status: ServeStatus, error?: TileFailure): Response => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(p.headers)) {
    const n = name.toLowerCase();
    if (isDropped(n) || n === H_EXPOSE) continue;
    headers.set(n, value);
  }
  headers.set(H_STATUS, status);
  if (error) headers.set(H_ERROR, error);
  headers.set(H_EXPOSE, EXPOSE_VALUE);
  return new Response(p.body as BodyInit | null, { status: p.status, statusText: p.statusText, headers });
};

const partsOf = async (res: Response): Promise<Parts> => ({
  body: await res.blob(),
  status: res.status,
  statusText: res.statusText,
  headers: copyHeaders(res.headers),
});

// ---- 差し込み口の呼び出し ----

/** フックを 1 つ呼ぶ。例外は console.error に残して undefined（そのプラグインを飛ばす） */
const callHook = async <R>(plugin: WeiwudiPlugin, name: keyof WeiwudiPlugin, call: () => Promise<R> | R | undefined): Promise<R | undefined> => {
  try {
    return await call();
  } catch (err) {
    console.error(`Weiwudi plugin ${String(name)} failed:`, err);
    return undefined;
  }
};

interface Hooks {
  plugins: readonly WeiwudiPlugin[];
  info: ResourceInfo;
  /** プラグインごと・要求ごとの state */
  states: Map<WeiwudiPlugin, Record<string, unknown>>;
}

const stateOf = (h: Hooks, p: WeiwudiPlugin): Record<string, unknown> => {
  let s = h.states.get(p);
  if (!s) {
    s = {};
    h.states.set(p, s);
  }
  return s;
};

const runRequestWillFetch = async (h: Hooks, request: Request): Promise<Request> => {
  let current = request;
  for (const p of h.plugins) {
    if (!p.requestWillFetch) continue;
    const r = await callHook(p, 'requestWillFetch', () => p.requestWillFetch!({ request: current, resource: h.info, state: stateOf(h, p) }));
    if (r instanceof Request) current = r;
  }
  return current;
};

/**
 * 本体を読んだまま何も返さない（または読み終えた Response を返す）プラグインがあっても配信を止めないよう、
 * 呼ぶ前の写しを持ち、使えない本体になったら写しへ戻して console.error に残す（PR #75 L1 m1）
 */
const runFetchDidSucceed = async (h: Hooks, request: Request, response: Response): Promise<Response> => {
  let current = response;
  for (const p of h.plugins) {
    if (!p.fetchDidSucceed) continue;
    const backup = current.clone();
    const r = await callHook(p, 'fetchDidSucceed', () => p.fetchDidSucceed!({ request, response: current, resource: h.info, state: stateOf(h, p) }));
    const next = r instanceof Response ? r : current;
    if (next.bodyUsed) {
      console.error('Weiwudi plugin fetchDidSucceed consumed the response body without returning a new Response; the response before the hook is used');
      current = backup;
    } else {
      current = next;
    }
  }
  return current;
};

const runFetchDidFail = async (h: Hooks, request: Request, error: unknown): Promise<void> => {
  for (const p of h.plugins) {
    if (!p.fetchDidFail) continue;
    await callHook(p, 'fetchDidFail', () => p.fetchDidFail!({ request, error, resource: h.info, state: stateOf(h, p) }));
  }
};

/** null で保存しない。Response を返したらそれを保存する */
const runCacheWillUpdate = async (h: Hooks, request: Request, response: Response): Promise<Response | null> => {
  let current = response;
  for (const p of h.plugins) {
    if (!p.cacheWillUpdate) continue;
    const r = await callHook(p, 'cacheWillUpdate', () => p.cacheWillUpdate!({ request, response: current, resource: h.info }));
    if (r === null) return null;
    if (r instanceof Response) current = r;
  }
  return current;
};

/** null で「保存した応答が無い」 */
const runCachedResponseWillBeUsed = async (h: Hooks, request: Request, cached: Response): Promise<Response | null> => {
  let current = cached;
  for (const p of h.plugins) {
    if (!p.cachedResponseWillBeUsed) continue;
    const r = await callHook(p, 'cachedResponseWillBeUsed', () => p.cachedResponseWillBeUsed!({ request, cachedResponse: current, resource: h.info }));
    if (r === null) return null;
    if (r instanceof Response) current = r;
  }
  return current;
};

// ---- 範囲外 ----

/** 範囲外なら 'zoom' か 'extent'。extents が無い・coord が無いときは範囲外にしない */
const outOfRangeKind = (resource: ResourceMeta, coord: ServeInput['coord']): 'zoom' | 'extent' | undefined => {
  const extents = resource.extents;
  if (!coord || !extents || extents.length === 0) return undefined;
  const { z, x, y } = coord;
  let allZoomOut = true;
  for (const e of extents) {
    if (z < e.minZoom || z > e.maxZoom) continue;
    allZoomOut = false;
    if (!e.box || isInTileBox(scaleTileBox(e.box, e.maxZoom, z), x, y)) return undefined;
  }
  return allZoomOut ? 'zoom' : 'extent';
};

const outOfRangeResponse = (resource: ResourceMeta, kind: 'zoom' | 'extent'): Response => {
  const policy = resource.policy.outOfRange[kind];
  if (policy === 'transparent') {
    return synthesize({ body: TRANSPARENT_PNG.slice(), status: 200, statusText: 'OK', headers: { 'content-type': 'image/png' } }, 'out-of-range');
  }
  if (policy === 'empty') {
    return synthesize({ body: new Uint8Array(0), status: 200, statusText: 'OK', headers: { 'content-type': VECTOR_TILE_TYPE } }, 'out-of-range');
  }
  return synthesize({ body: null, status: 404, statusText: 'Not Found', headers: {} }, 'out-of-range');
};

// ---- 退避の範囲 ----

const sourceMaxBytes = (rec: SourceRecord): number | undefined => {
  const v = rec.kind === 'legacy'
    ? rec.legacy?.cacheMaxBytes
    : (storedSpecOf(rec) ?? styleSpecOf(rec))?.cacheMaxBytes;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

/**
 * putEntry の退避の範囲（仕様 §7.1・第 1 回 S4）。その Resource を sourceIds に持ち cacheMaxBytes を持つ
 * Source ごとに 1 要素（その Source の Resource 群）。rangeOnlySourceIds の Source は数えない。
 * 子 Source（m3-t2）は親に読み替え、親ごとに 1 要素にする（maxBytes は親の cacheMaxBytes、resourceIds は
 * 親の全子（StyleSpec.children）の Resource）。子自身は cacheMaxBytes を持たない
 */
export async function evictScopesFor(store: Store, resource: ResourceMeta): Promise<EvictionScope[]> {
  const rangeOnly = resource.rangeOnlySourceIds ?? [];
  const scopes: EvictionScope[] = [];
  const seen: string[] = [];
  for (const sourceId of resource.sourceIds) {
    if (rangeOnly.indexOf(sourceId) >= 0) continue;
    const rec = await store.getSource(sourceId);
    let owner = rec;
    let ownerId = sourceId;
    let members = [sourceId];
    if (rec && isChildRecord(rec)) {
      // 親の無い子は上限を持たない（子自身は cacheMaxBytes を持たない）
      if (rec.parentId === undefined) continue;
      ownerId = rec.parentId;
      owner = await store.getSource(ownerId);
      members = (owner ? styleSpecOf(owner)?.children ?? [] : []).map((c) => c.id);
    }
    if (seen.indexOf(ownerId) >= 0) continue;
    seen.push(ownerId);
    const maxBytes = owner ? sourceMaxBytes(owner) : undefined;
    if (maxBytes === undefined) continue;
    const resourceIds: string[] = [];
    for (const member of members) {
      for (const r of await store.resourcesBySource(member)) {
        if (resourceIds.indexOf(r.id) < 0) resourceIds.push(r.id);
      }
    }
    if (resourceIds.indexOf(resource.id) < 0) resourceIds.push(resource.id);
    scopes.push({ resourceIds, maxBytes });
  }
  return scopes;
}

// ---- serve ----

/**
 * 配信の決定（仕様 §6 の表の 1〜7 をこの順に）。同じ key の同時要求は ctx.inflight で 1 本にまとめ、
 * 各呼び出し側へ clone() を返す。差し込み口は呼び出しの始めの登録の写しで進める
 */
export function serve(ctx: Context, input: ServeInput, now: () => number): Promise<Response> {
  // Range つきは素通し（仕様 §11。206 を全体として保存すると壊れる）
  if (input.request.headers.has('range')) return passServeInput(input);
  const plugins = getPlugins();
  // 認証付き（保存しない）要求はまとめない。匿名の要求と応答を共有しない（PR #75 L1 M1）
  if (!input.storable) return serveOnce(ctx, input, now(), plugins);
  // グリフは範囲ごとにまとめる（同じ fontstack の別の範囲を 1 本にしない。仕様 §11）
  // revalidate は hit を返す通常の要求にまとめない（印を足して別の 1 本にする。L1 Minor-1）
  const base = input.part === undefined ? input.key : `${input.key}\0${input.part}`;
  const flightKey = input.revalidate === true ? `${base}\0revalidate` : base;
  const shared = ctx.inflight.get(flightKey);
  if (shared) return shared.then((r) => r.clone());
  const p = serveOnce(ctx, input, now(), plugins);
  ctx.inflight.set(flightKey, p);
  const done = () => {
    if (ctx.inflight.get(flightKey) === p) ctx.inflight.delete(flightKey);
  };
  p.then(done, done);
  return p.then((r) => r.clone());
}

/**
 * 素通し（Range つきの要求。仕様 §11）の唯一の実装。新旧どちらの経路もこれを使う（hook・legacy・serve の守り）。
 * 上流の応答をそのまま返し、保存・まとめ・差し込み口を使わない。ネットワーク失敗（fetcher の reject）だけは
 * 表の 7 の形（404・offline-miss・x-weiwudi-error: network・access-control-expose-headers）で返す
 */
export const passThrough = async (fetcher: () => Promise<Response>): Promise<Response> => {
  try {
    return await fetcher();
  } catch (_e) {
    return synthesize({ body: null, status: 404, statusText: 'Not Found', headers: {} }, 'offline-miss', 'network');
  }
};

/** serve に入ってきた Range つきの要求の守り（呼び出し側が入れないのが契約） */
const passServeInput = (input: ServeInput): Promise<Response> =>
  passThrough(async () => {
    const result = await input.upstream(input.request, { hasEntry: false, requestChanged: false });
    if (result.kind === 'network') throw result.error;
    return result.response;
  });

interface LiveEntry {
  meta: EntryMeta;
  blob: Blob;
  headers: Record<string, string>;
}

/**
 * 保存済みのレコードを配信の Entry として見る。グリフの範囲（part）があれば、その範囲の部分だけを Entry とし
 * （無ければ Entry 無し）、fetchedAt は部分の値・本体は blob.slice（仕様 §11）
 */
const liveEntryOf = (meta: EntryMeta, body: EntryBody, part: string | undefined): LiveEntry | undefined => {
  if (part === undefined) return { meta, blob: body.blob, headers: body.headers };
  const p = body.parts?.[part];
  if (!p) return undefined;
  return {
    meta: { ...meta, fetchedAt: p.fetchedAt, size: p.length },
    blob: body.blob.slice(p.offset, p.offset + p.length),
    headers: body.headers,
  };
};

const serveOnce = async (ctx: Context, input: ServeInput, t: number, plugins: readonly WeiwudiPlugin[]): Promise<Response> => {
  const store = await ctx.store();
  const resource = await store.getResource(input.resourceId);
  // Resource が無い（消された直後など）ときは、保存も差し込み口も使わずに上流を配信する
  const hooks: Hooks | undefined = resource
    ? { plugins, info: toResourceInfo(resource, t), states: new Map() }
    : undefined;

  // 1 範囲外
  if (resource) {
    const kind = outOfRangeKind(resource, input.coord);
    if (kind) return outOfRangeResponse(resource, kind);
  }

  // Entry（削除期限を過ぎたものは無いもの。固定は対象外。R21）
  let entry: LiveEntry | undefined;
  // 保存し直すときに引き継ぐ固定（Entry を無いもの扱いにしても、保存済みの値を保つ。PR #75 L1 m2）
  let savedPinned: 0 | 1 = 0;
  if (resource) {
    const got = await store.getEntry(input.key);
    if (got) savedPinned = got.meta.pinned;
    const live = got && liveEntryOf(got.meta, got.body, input.part);
    const retention = resource.policy.cacheRetention;
    if (live && !(retention !== undefined && live.meta.pinned !== 1 && t - live.meta.fetchedAt > retention)) {
      entry = live;
    }
  }

  /** 保存した応答を差し込み口へ通す。null なら使わない */
  const useCached = async (e: LiveEntry): Promise<Parts | null> => {
    const parts: Parts = { body: e.blob, status: 200, statusText: 'OK', headers: e.headers };
    if (!hooks || !hooks.plugins.some((p) => p.cachedResponseWillBeUsed)) return parts;
    const cached = new Response(e.blob, { status: 200, statusText: 'OK', headers: e.headers });
    const r = await runCachedResponseWillBeUsed(hooks, input.request, cached);
    if (r === null) return null;
    return r === cached ? parts : partsOf(r);
  };

  // 2 新しい Entry。認証付き（storable が偽）は hit を飛ばして必ず上流へ出し、上流の失敗のときだけ表の 4 以降で Entry を使う（§4.6。Ruling）
  // revalidate（m3-t6・R4）も hit を飛ばす
  if (resource && entry && input.storable && input.revalidate !== true && t - entry.meta.fetchedAt <= resource.policy.cacheTtl) {
    // touch は返す前に呼ぶ（tx はその場で同期に作られる）。完了は待たない（R8）
    store.touch(input.key, t).catch(() => undefined);
    const parts = await useCached(entry);
    if (parts) return synthesize(parts, 'hit');
    entry = undefined;
  }

  /** 上流が失敗したとき: Entry があれば古い本体（stale）、無ければ undefined */
  const stale = async (error: TileFailure): Promise<Response | undefined> => {
    if (!entry) return undefined;
    const parts = await useCached(entry);
    return parts ? synthesize(parts, 'stale', error) : undefined;
  };

  // 上流へ
  const request = hooks ? await runRequestWillFetch(hooks, input.request) : input.request;
  let result: UpstreamResult;
  try {
    result = await input.upstream(request, { hasEntry: !!entry, requestChanged: request !== input.request });
  } catch (error) {
    result = { kind: 'network', error };
  }

  // 6・7 ネットワーク失敗
  if (result.kind === 'network') {
    if (hooks) await runFetchDidFail(hooks, request, result.error);
    return (await stale('network'))
      ?? synthesize({ body: null, status: 404, statusText: 'Not Found', headers: {} }, 'offline-miss', 'network');
  }

  const response = hooks ? await runFetchDidSucceed(hooks, request, result.response) : result.response;
  // opaque（仕様 §4.5-3）: Entry があれば §6 の 4（古い本体・stale・upstream）。無ければ SW が合成した応答では
  // ないので、そのまま返す（保存せず、ヘッダも付けない）
  if (result.kind === 'opaque' || response.type === 'opaque') {
    return (await stale('upstream')) ?? response;
  }

  let up = await partsOf(response);
  // 4・5 上流が失敗（HTTP）。!ok と、スタイル・TileJSON 以外の 200 の text/html（§4.6）
  if (!response.ok || (!input.isStyleLike && response.status === 200 && isHtml(up.headers))) {
    return (await stale('upstream')) ?? synthesize(up, 'upstream-error', 'upstream');
  }
  // 本体の書き換え（R28）。投げたら 4・5 と同じ扱いで、保存しない（読めない本体・除去に失敗した本体を固定しない）
  if (input.transform) {
    try {
      up = { ...up, body: await input.transform(up.body as Blob) };
    } catch (_e) {
      return (await stale('upstream')) ?? synthesize(up, 'upstream-error', 'upstream');
    }
  }

  // 3 上流が成功。2xx は 200 OK として配信・保存する（旧 API の miss と同じ。hit の再生とも揃う。Ruling）
  // 保存しない要求は Entry を更新しないので refresh にしない
  const status: ServeStatus = entry && input.storable ? 'refresh' : 'miss';
  let failure: TileFailure | undefined;
  if (resource && input.storable) {
    failure = await save(store, resource, input, hooks!, up, savedPinned, t);
  }
  return synthesize({ ...up, status: 200, statusText: 'OK' }, status, failure);
};

/** 保存する。失敗は種類を返す（配信は続ける）。cacheWillUpdate には元の要求（ServeInput.request）を渡す */
const save = async (
  store: Store, resource: ResourceMeta, input: ServeInput, hooks: Hooks,
  up: Parts, pinned: 0 | 1, t: number,
): Promise<TileFailure | undefined> => {
  let blob = up.body as Blob;
  let headers = up.headers;
  if (hooks.plugins.some((p) => p.cacheWillUpdate)) {
    const offered = new Response(blob, { status: up.status, statusText: up.statusText, headers });
    const r = await runCacheWillUpdate(hooks, input.request, offered);
    if (r === null) return undefined;
    if (r !== offered) {
      try {
        blob = await r.blob();
      } catch (_e) {
        // 差し替えた応答の本体が読めない: 保存の失敗として配信を続ける
        return 'storage';
      }
      headers = copyHeaders(r.headers);
    }
  }
  const meta: EntryMeta = {
    key: input.key,
    resourceId: resource.id,
    // putEntry は meta.size で数えるので、保存する本体の大きさと揃える（t2 の申し送り）
    size: blob.size,
    fetchedAt: t,
    accessedAt: t,
    pinned,
  };
  if (input.coord) {
    meta.z = input.coord.z;
    meta.x = input.coord.x;
    meta.y = input.coord.y;
  }
  if (headers['content-type'] !== undefined) meta.contentType = headers['content-type'];
  // 退避の範囲の読み出しの失敗は reject で返す（store の読み出しは R3）。書き込みの失敗だけを種類に直す
  const evict = await evictScopesFor(store, resource);
  try {
    if (input.part === undefined) await store.putEntry(meta, { key: input.key, blob, headers }, evict);
    else await store.putGlyphPart(meta, input.part, blob, headers, evict);
    return undefined;
  } catch (err) {
    return WeiwudiError.from(err).code === 'quota' ? 'quota' : 'storage';
  }
};

// ---- ジョブ ----

export interface JobSpec<T> {
  /** 取得する単位の列（生成器でよい。配列にせずに読む） */
  tasks: Iterable<T>;
  /** 1 バッチの数。既定 5（現行の fetchAll と同じ） */
  batchSize?: number;
  /** バッチの前に見る。偽なら 'gone'（現行は self.clients.get(client.id)） */
  isAlive: () => Promise<boolean> | boolean;
  /** isAlive の後に見る。真なら 'canceled' */
  isCanceled: () => Promise<boolean> | boolean;
  /** 1 単位の処理（バッチの中は並行） */
  run: (task: T) => Promise<unknown>;
  /** バッチの後に、処理した数（累計）で呼ぶ */
  onBatch?: (processed: number) => Promise<void> | void;
}

/**
 * 現行の fetchAll の進め方（batchSize ずつ・各バッチの前に isAlive、次に isCanceled）。
 * isAlive・isCanceled・run・onBatch の例外は捕まえずに reject で返す（呼び出し側が stop を出す。第 1 回 O-4）。
 * 途中で終わるときは tasks の反復子の return() を呼ぶ
 */
export async function runJob<T>(job: JobSpec<T>): Promise<'finished' | 'canceled' | 'gone'> {
  const size = job.batchSize ?? JOB_BATCH;
  const it = job.tasks[Symbol.iterator]();
  const take = (): T[] => {
    const batch: T[] = [];
    while (batch.length < size) {
      const n = it.next();
      if (n.done) break;
      batch.push(n.value);
    }
    return batch;
  };
  let processed = 0;
  let exhausted = false;
  try {
    for (let batch = take(); batch.length > 0; batch = take()) {
      if (!(await job.isAlive())) return 'gone';
      if (await job.isCanceled()) return 'canceled';
      await Promise.all(batch.map((task) => job.run(task)));
      processed += batch.length;
      if (job.onBatch) await job.onBatch(processed);
    }
    exhausted = true;
    return 'finished';
  } finally {
    // 途中で終わる（gone・canceled・例外）ときは生成器を閉じる（finally を走らせる。PR #75 L2）
    if (!exhausted) it.return?.();
  }
}
