/// <reference lib="webworker" />
// 照合表とルート（仕様 §4.2・§4.3。m2-t7）。実 URL の要求を照合ルートと門番で受け、core.serve へ渡す。
// 値の依存は core・upstream・context・store・url_pattern・style_body・constants・errors だけ（仕様 §3）。registry は import できないので、
// 資格情報の Source の選び方（registry.credentialSourceFor）は配線（weiwudi_gw_logic.ts）が installHook に渡す。
//
// 決まり:
// - 照合表は context に持つ（モジュール変数を置かない）。読み込みの Promise は 1 つだけ持って共有する
// - 候補の条件（isCandidate）は照合ルートと門番の両方に当てる（第 1 回 O-8・R19）
// - 照合表は map: で始まらない Resource から作る。weiwudi.example.com のテンプレートは入れない
// - 読み込みは最初の候補の要求で始める（Weiwudi_Internal の呼び出しでは IndexedDB を開かない。Ruling）
// - Range つきの要求は照合しても serve に入れず core.passThrough で素通し（範囲外の判定より前。仕様 §11・Ruling）
// - 規則の順: 固定値のクエリ項目が多いもの → 座標のクエリ項目が多いもの → 早く登録された Source の Resource →
//   Resource の id → テンプレートの順（Ruling）。同じ要求に当たる別の照合の形は warnings に出す
// - 資格情報は、要求のオリジンをテンプレートに持つ Source だけから credentialSourceFor で選ぶ（別ホストへ送らない。I2）
// - Resource の provider の提供元を ctx.providers() から引いて upstream へ渡す（m3-t5）
// - 資格情報の選び方は credentialsForResource 1 つ（照合ルートと範囲取得が共有する。m4-t3・R3）
// - ServeInput を作るのは serveResource 1 つ（照合ルート・門番・t7 の登録時の取得・範囲取得が共有する。C-O12）。
//   style・tilejson は isStyleLike と transform（style_body の rewrite*）を付け、sprite のキーは {spriteSuffix} で作る（m3-t6・I3）
import type { RouteHandlerCallback, RouteHandlerCallbackOptions, RouteMatchCallback } from 'workbox-core';
import type { Context, CredentialSourcePicker, LoadedTable, TableState } from './context';
import { passThrough, serve, type GlyphCollector, type ServeInput } from './core';
import { createUpstream, hasCredentials, isAuthenticated, isStorable } from './upstream';
import type { Credentials, ResourceMeta, ResourcePolicy, ResourceType, SourceRecord } from './store';
import type { WeiwudiProvider } from './plugins';
import { isLegacyRecord, styleSpecOf, templatesOf } from './store';
import { credentialTargetOf, rewriteStyleBody, rewriteTileJsonBody, type StripRule } from './style_body';
import { LEGACY_PREFIX, PSEUDO_HOST } from './constants';
import { MatchTable, compileTemplate, entryKey, type CompiledTemplate, type MatchResult, type MatchRule } from './url_pattern';

/** 表の更新を伝える BroadcastChannel の名前と通知（仕様 §4.3） */
export const TABLE_CHANNEL = 'weiwudi';
export const TABLE_MESSAGE: Readonly<{ type: 'table' }> = Object.freeze({ type: 'table' });
/** 門番が読み込みを待つ上限（仕様 §4.3） */
export const GATE_WAIT_MS = 3000;
/** 表の更新の通知をまとめる間隔（最後の変更から。m4-t8・I8b・R34） */
export const NOTIFY_DEBOUNCE_MS = 100;
/** 読み込みのやり直しの間隔（1 秒から倍々に 30 秒まで） */
export const RETRY_MIN_MS = 1000;
export const RETRY_MAX_MS = 30000;

/** 照合の結果（照合ルートの params） */
export interface TableHit {
  resourceId: string;
  type: ResourceType;
  m: MatchResult;
}

/** 候補の条件（仕様 §4.3）: GET・navigate でない・destination が '' か 'image'。照合ルートと門番で 1 つ */
export const isCandidate = (request: Request): boolean =>
  request.method === 'GET' && request.mode !== 'navigate' && (request.destination === '' || request.destination === 'image');

// ---- 照合表を作る ----

interface RankedRule extends MatchRule {
  rank: number;
  index: number;
}

const originOf = (template: string): string | undefined => {
  try {
    return compileTemplate(template).origin;
  } catch (_e) {
    return undefined;
  }
};

/** 規則の順（Ruling）。具体的な形を先に、同じ具体さなら早く登録されたものを先に */
const compareRules = (a: RankedRule, b: RankedRule): number =>
  b.compiled.queryFixed.length - a.compiled.queryFixed.length
  || b.compiled.queryTokens.length - a.compiled.queryTokens.length
  || a.rank - b.rank
  || (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0)
  || a.index - b.index;

/** 照合の形の値（字句の意味を除く）。同じなら、同じ要求の URL に両方が当たる */
const requestShape = (c: CompiledTemplate): string => JSON.stringify([
  c.origin,
  c.pathRe.source,
  c.queryTokens.map((q) => [q.name, q.re.source]).sort(),
  c.queryFixed.map((f) => [f.name, f.value]).sort(),
]);

/**
 * 先に評価される規則と同じ要求の URL に当たる、別の Resource の規則（`{y}` と `{-y}`、`{z}/{x}` と `{x}/{z}` など）。
 * 後の規則は影になり、黙って捕捉されない（m2-t6 の申し送り）。"template-shadowed: <影になった Resource.id>"
 */
const shadowWarnings = (rules: readonly RankedRule[]): string[] => {
  const first = new Map<string, string>();
  const out: string[] = [];
  for (const r of rules) {
    const shape = requestShape(r.compiled);
    const owner = first.get(shape);
    if (owner === undefined) first.set(shape, r.resourceId);
    else if (owner !== r.resourceId) {
      const w = `template-shadowed: ${r.resourceId}`;
      if (out.indexOf(w) < 0) out.push(w);
    }
  }
  return out;
};

/** store から照合表を作る（仕様 §4.2）。失敗は reject */
const buildTable = async (ctx: Context): Promise<LoadedTable> => {
  const store = await ctx.store();
  const [resources, sources] = await Promise.all([store.listResources(), store.listSources()]);
  const live = sources.filter((s) => !isLegacyRecord(s));
  const creds = await Promise.all(live.map((s) => store.getCredentials(s.id)));
  const withCredentials = live.filter((_s, i) => hasCredentials(creds[i])).map((s) => s.id);
  const orderOf = new Map(live.map((s) => [s.id, s.order]));

  const rules: RankedRule[] = [];
  const credentialSources = new Map<string, Map<string, string>>();
  for (const r of resources) {
    if (r.id.startsWith(LEGACY_PREFIX)) continue;
    const rank = Math.min(Infinity, ...r.sourceIds.map((id) => orderOf.get(id) ?? Infinity));
    const origins: string[] = [];
    r.templates.forEach((t, index) => {
      let compiled: CompiledTemplate;
      try {
        compiled = compileTemplate(t);
      } catch (_e) {
        return;
      }
      if (new URL(compiled.origin).hostname === PSEUDO_HOST) return;
      rules.push({ resourceId: r.id, type: r.type, compiled, rank, index });
      if (origins.indexOf(compiled.origin) < 0) origins.push(compiled.origin);
    });
    const pick = ctx.table.pickCredentialSource;
    if (!pick || withCredentials.length === 0) continue;
    const byOrigin = new Map<string, string>();
    for (const origin of origins) {
      // そのオリジンをテンプレートに持つ Source だけを候補にする（別ホストへ資格情報を送らない。I2）
      const candidates = live.filter((s) => templatesOf(s).some((t) => originOf(t) === origin));
      const id = pick(r, candidates, withCredentials);
      if (id !== undefined) byOrigin.set(origin, id);
    }
    if (byOrigin.size > 0) credentialSources.set(r.id, byOrigin);
  }
  rules.sort(compareRules);
  return { table: new MatchTable(rules), credentialSources, warnings: shadowWarnings(rules) };
};

// ---- 読み込み・失敗と停止（仕様 §4.3） ----

const fail = (s: TableState, t: number): void => {
  s.failures++;
  s.retryAt = t + Math.min(RETRY_MIN_MS * Math.pow(2, s.failures - 1), RETRY_MAX_MS);
};

/** 読み込みを始める。古い世代で読んだ結果は捨てて読み直す（読み込み中に表の更新が来たとき） */
const startLoad = (ctx: Context): Promise<LoadedTable> => {
  const s = ctx.table;
  const generation = s.generation;
  const p: Promise<LoadedTable> = buildTable(ctx).then((built) => {
    if (s.loading === p) s.loading = undefined;
    if (s.generation !== generation) return s.loading ?? startLoad(ctx);
    s.current = built;
    s.failures = 0;
    s.retryAt = 0;
    return built;
  }, (e: unknown) => {
    if (s.loading === p) {
      s.loading = undefined;
      fail(s, Date.now());
    }
    throw e;
  });
  s.loading = p;
  p.catch(() => undefined);
  return p;
};

/** 読み込み済みの表・読み込み中の Promise・新しい読み込み。やり直しの間隔の中なら undefined（待たずに素通し） */
const ensureLoad = (ctx: Context, t: number): Promise<LoadedTable> | undefined => {
  const s = ctx.table;
  if (s.current) return Promise.resolve(s.current);
  if (s.loading) return s.loading;
  if (t < s.retryAt) return undefined;
  return startLoad(ctx);
};

/** p を ms まで待つ。超えたら Error('timeout') で reject（門番と control.refreshTable が使う。m4-t8・F34） */
export const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), ms);
  p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
});

/** 表を作り直す（古い表は新しい表ができるまで使う）。読み込み中なら、その完了後に読み直す */
const reload = (ctx: Context): Promise<LoadedTable> => {
  ctx.table.generation++;
  return ctx.table.loading ?? startLoad(ctx);
};

/**
 * 登録の書き換え（registry の applyRegister・applyUpdate・applyRemove）の後に呼ぶ（t8 の control）。
 * この SW の表を即時に作り直し、同じオリジンの別の SW へ { type: 'table' } を伝える。照合表の warnings を返す。
 * 通知は NOTIFY_DEBOUNCE_MS でまとめる（最後の変更から 1 回。ctx.table.notifyTimer。m4-t8・I8b・R34）
 */
export async function tableChanged(ctx: Context): Promise<string[]> {
  const p = reload(ctx);
  const s = ctx.table;
  if (s.notifyTimer !== undefined) clearTimeout(s.notifyTimer);
  s.notifyTimer = setTimeout(() => {
    s.notifyTimer = undefined;
    try {
      channelOf(ctx)?.postMessage(TABLE_MESSAGE);
    } catch (_e) {
      // 閉じた・無い母線は伝えない（相手は次の起動で読み直す）
    }
  }, NOTIFY_DEBOUNCE_MS);
  return (await p).warnings.slice();
}

const channelOf = (ctx: Context): BroadcastChannel | undefined => {
  if (!ctx.table.channel && typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel(TABLE_CHANNEL);
    ch.onmessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown } | null;
      if (data && data.type === TABLE_MESSAGE.type) reload(ctx).catch(() => undefined);
    };
    ctx.table.channel = ch;
  }
  return ctx.table.channel;
};

// ---- 配信 ----

/**
 * 資格情報の選び方の唯一の関数（照合ルートと範囲取得が共有する。m4-t3・R3・第 1 回 M4）。照合表の credentialSources の
 * Resource × オリジンから Source を選び、その資格情報と id を返す。loaded が無ければ ctx.table.current、それも無ければ
 * 門番と同じ ensureLoad の読み込みを待つ（やり直しの間隔の中・読めなければ {}）。資格情報が空なら credentials を入れない
 */
export async function credentialsForResource(
  ctx: Context, resource: ResourceMeta, origin: string, loaded?: LoadedTable,
): Promise<{ credentials?: Credentials; credentialSourceId?: string }> {
  let table = loaded ?? ctx.table.current;
  if (!table) {
    const p = ensureLoad(ctx, Date.now());
    if (!p) return {};
    try {
      table = await p;
    } catch (_e) {
      return {};
    }
  }
  const credentialSourceId = table.credentialSources.get(resource.id)?.get(origin);
  if (credentialSourceId === undefined) return {};
  const c = await (await ctx.store()).getCredentials(credentialSourceId);
  return hasCredentials(c) ? { credentials: c, credentialSourceId } : { credentialSourceId };
}

/** Resource の provider の提供元（評価の順で最初に id が同じもの）。登録表に無ければ undefined（汎用の足し方。m3-t5） */
const providerOf = (ctx: Context, resource: ResourceMeta): WeiwudiProvider | undefined =>
  resource.provider === undefined ? undefined : ctx.providers().find((p) => p.id === resource.provider);

/** serveResource の任意の指定 */
export interface ServeResourceOptions {
  /** §6 の 2（hit）を飛ばして上流へ出す（update() の取り直し。R4） */
  revalidate?: boolean;
  /**
   * この Resource に資格情報を持つ Source の id（照合表の credentialSources が要求のオリジンで選んだもの）。
   * style・tilejson の本体の除去の親をここから引く（O-N3）。無ければ sourceIds の Source を登録順に見て、資格情報を持つ最初のもの
   */
  credentialSourceId?: string;
  /**
   * 本体の除去の親を直接渡す（m3-t7・O-N2。スタイルの登録時の取得）。あれば store を読まずに、この親の URL のオリジンと
   * 提供元・policy で除去の規則を作る。除くのは credentials（足す資格情報）があるときだけ（保存した資格情報を見ないので、
   * update() でスタイルの URL が変わって Resource に当たらないときも、新しい正規化の値で除ける）
   */
  parent?: { url: string; provider?: string; policy: Pick<ResourcePolicy, 'credentialParams'> };
  /** グリフの束ね書き（範囲取得の 1 fontstack の単位。m4-t4・L4・第 1 回 M4）。glyph の範囲の要求だけに渡す */
  collect?: GlyphCollector;
}

const byOrder = (a: SourceRecord, b: SourceRecord): number => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 資格情報を持つ Source（指定が無ければ sourceIds を登録順に見て最初のもの。credentialSourceFor と同じ順。O-N3） */
const credentialOwnerOf = async (ctx: Context, resource: ResourceMeta, given: string | undefined): Promise<SourceRecord | undefined> => {
  const store = await ctx.store();
  if (given !== undefined) return store.getSource(given);
  const recs = (await Promise.all(resource.sourceIds.map((id) => store.getSource(id))))
    .filter((r): r is SourceRecord => r !== undefined)
    .sort(byOrder);
  for (const rec of recs) {
    if (hasCredentials(await store.getCredentials(rec.id))) return rec;
  }
  return undefined;
};

/**
 * 本体の資格情報の除去の規則（R32）。資格情報を持つ Source の親（スタイル）の URL のオリジンと、親の提供元の matches で
 * credentialTargetOf を作る（t7 の子の資格情報の配り先と同じ関数。R5）。除く値はその Source の credentials（§10 R32）。
 * 資格情報を持つ Source が無い・親が引けなければ除かない
 */
const stripRuleOf = async (ctx: Context, resource: ResourceMeta, credentialSourceId: string | undefined): Promise<StripRule | undefined> => {
  const owner = await credentialOwnerOf(ctx, resource, credentialSourceId);
  if (!owner || owner.parentId === undefined) return undefined;
  const credentials = await (await ctx.store()).getCredentials(owner.id);
  if (!hasCredentials(credentials)) return undefined;
  const parentRec = await (await ctx.store()).getSource(owner.parentId);
  const parent = parentRec ? styleSpecOf(parentRec) : undefined;
  return parent ? ruleOfParent(ctx, resource, parent, credentials) : undefined;
};

/**
 * 親（スタイルの URL・提供元・policy）と資格情報から作る除去の規則。accepts は親の credentialParams で判定する
 * （子作りと同じ。m3-t7）。除く値は credentials.query（同じ値の項目だけを除き、違う値＝子の固有の値は残す。§10 R32）。
 * credentials は、登録時の取得では直接渡された資格情報、照合ルートでは資格情報を持つ Source のもの。
 * 親の URL が読めなければ除かない
 */
const ruleOfParent = (
  ctx: Context, resource: ResourceMeta, parent: NonNullable<ServeResourceOptions['parent']>, credentials: Credentials,
): StripRule | undefined => {
  let styleOrigin: string;
  try {
    styleOrigin = new URL(parent.url).origin;
  } catch (_e) {
    return undefined;
  }
  const provider = parent.provider === undefined ? undefined : ctx.providers().find((p) => p.id === parent.provider);
  const credentialParams = resource.policy.credentialParams;
  const acceptsMember = ctx.acceptsMember;
  return {
    credentialParams,
    credentialValues: credentials.query ?? {},
    shouldStrip: credentialTargetOf({ styleOrigin, ...(provider ? { providerMatches: (u: string) => provider.matches(u) } : {}) }),
    ...(acceptsMember ? { accepts: (type: ResourceType, templates: string[]) => acceptsMember(type, templates, parent.policy.credentialParams) } : {}),
  };
};

/**
 * style・tilejson の本体の書き換え（R28）。base は要求の URL（相対 URL の解決）。style には Resource の提供元の rewriteStyle を当てる。
 * 除去の規則は transform の中で初めて計算する（hit では transform が呼ばれず、IndexedDB を読まない。L1 Minor-4）。
 * 読めない本体は style_body が投げ、core が上流の失敗として扱う（保存しない。C-S4）。規則の計算の失敗も同じ扱い
 */
const bodyTransformOf = (
  type: 'style' | 'tilejson', base: string, rewriteStyle: ((s: unknown) => unknown) | undefined,
  stripOf: () => Promise<StripRule | undefined>,
): NonNullable<ServeInput['transform']> => async (blob) => {
  const strip = await stripOf();
  const text = await blob.text();
  const out = type === 'style'
    ? rewriteStyleBody(text, base, { ...(rewriteStyle ? { rewriteStyle } : {}), ...(strip ? { strip } : {}) })
    : rewriteTileJsonBody(text, base, strip ? { strip } : {});
  return out === text ? blob : new Blob([out], { type: blob.type });
};

/**
 * ServeInput を作って core.serve へ渡す唯一の関数（照合ルート・門番・t7 の登録時の取得が共有する。C-O12）。
 * credentials は足す資格情報（認証付きの要求では渡さない）。store などの失敗は reject で返す（照合ルートは素通しへ直す）
 */
export async function serveResource(
  ctx: Context, resource: ResourceMeta, request: Request, url: URL, m: MatchResult,
  credentials: Credentials | undefined, opts: ServeResourceOptions = {},
): Promise<Response> {
  const now = () => Date.now();
  const provider = providerOf(ctx, resource);
  let styleLike: Pick<ServeInput, 'isStyleLike' | 'transform'> = {};
  if (resource.type === 'style' || resource.type === 'tilejson') {
    const direct = opts.parent;
    const stripOf = direct
      ? async () => (hasCredentials(credentials) ? ruleOfParent(ctx, resource, direct, credentials) : undefined)
      : () => stripRuleOf(ctx, resource, opts.credentialSourceId);
    const rewriteStyle = resource.type === 'style' && provider?.rewriteStyle
      ? (st: unknown) => provider.rewriteStyle!(st) : undefined;
    styleLike = { isStyleLike: true, transform: bodyTransformOf(resource.type, url.href, rewriteStyle, stripOf) };
  }
  const input: ServeInput = {
    resourceId: resource.id,
    // 鍵は読み直した Resource の credentialParams で作る（資格情報をキーに残さない。§10）。sprite は {spriteSuffix} の値で作る
    key: entryKey(resource.id, resource.type, m, url, resource.policy.credentialParams),
    ...(resource.type === 'tile' && m.z !== undefined && m.x !== undefined && m.y !== undefined
      ? { coord: { z: m.z, x: m.x, y: m.y } } : {}),
    // グリフは範囲を渡す（同じ fontstack の範囲を 1 レコードへ束ねるのは core と store。仕様 §11）
    ...(resource.type === 'glyph' && m.range !== undefined ? { part: m.range, ...(opts.collect ? { collect: opts.collect } : {}) } : {}),
    ...styleLike,
    ...(opts.revalidate === true ? { revalidate: true } : {}),
    request,
    storable: isStorable(request, resource.policy),
    upstream: createUpstream(ctx, { resourceId: resource.id, original: request, credentials, provider, now }),
  };
  return serve(ctx, input, now);
}

/** 照合した要求を配信する。store の失敗などで配信できなければ素通し（要求を止めない） */
const serveHit = async (ctx: Context, request: Request, url: URL, hit: TableHit, loaded: LoadedTable | undefined): Promise<Response> => {
  // Range つきは serve に入れない（範囲外の判定より前。仕様 §11）
  if (request.headers.has('range')) return passThrough(() => fetch(request));
  let resource: ResourceMeta | undefined;
  let credentials: Credentials | undefined;
  let credentialSourceId: string | undefined;
  try {
    const store = await ctx.store();
    resource = await store.getResource(hit.resourceId);
    if (resource) {
      const picked = await credentialsForResource(ctx, resource, url.origin, loaded);
      credentialSourceId = picked.credentialSourceId;
      // 認証付きの要求には足さない（§4.6）
      if (!isAuthenticated(request)) credentials = picked.credentials;
    }
  } catch (_e) {
    return fetch(request);
  }
  // 表が古い（消された Resource）
  if (!resource) return fetch(request);
  try {
    return await serveResource(ctx, resource, request, url, hit.m, credentials, credentialSourceId === undefined ? {} : { credentialSourceId });
  } catch (_e) {
    return fetch(request);
  }
};

export interface HookDeps {
  pickCredentialSource: CredentialSourcePicker;
}

/** workbox-routing の registerRoute（第 1 引数は RegExp か RouteMatchCallback。仕様 §4.3） */
export type RegisterRoute = (capture: RegExp | RouteMatchCallback, handler: RouteHandlerCallback, method?: 'GET' | 'POST') => unknown;

/**
 * 照合ルート（同期）と門番（queueMicrotask。同じ評価中に登録された利用者のルートより後ろ）を登録する（仕様 §4.3）。
 * 旧 API・制御のルートより後に呼ぶ
 */
export function installHook(ctx: Context, registerRoute: RegisterRoute, deps: HookDeps): void {
  ctx.table.pickCredentialSource = deps.pickCredentialSource;
  channelOf(ctx);

  const matchRoute: RouteMatchCallback = ({ url, request }) => {
    const current = ctx.table.current;
    if (!current || !isCandidate(request)) return false;
    return current.table.match(url) ?? false;
  };
  const matchHandler: RouteHandlerCallback = async ({ url, request, params, event }: RouteHandlerCallbackOptions) => {
    const hit = (params as TableHit | undefined) ?? ctx.table.current?.table.match(url) ?? undefined;
    if (!hit) return fetch(request);
    ctx.maintain?.(event);
    return serveHit(ctx, request, url, hit, ctx.table.current);
  };
  registerRoute(matchRoute, matchHandler, 'GET');

  // 門番: 表が無い間の候補。やり直しの間隔の中は受けない（待たずに素通し）
  const gateRoute: RouteMatchCallback = ({ request }) => {
    const s = ctx.table;
    if (s.current || !isCandidate(request)) return false;
    return !!s.loading || Date.now() >= s.retryAt;
  };
  const gateHandler: RouteHandlerCallback = async ({ url, request, event }: RouteHandlerCallbackOptions) => {
    const p = ensureLoad(ctx, Date.now());
    if (!p) return fetch(request);
    let loaded: LoadedTable;
    try {
      loaded = await withTimeout(p, GATE_WAIT_MS);
    } catch (_e) {
      // 上限越え: この要求は素通しし、次の要求で読み込みをやり直す（失敗は startLoad が数える）
      const s = ctx.table;
      if (s.loading === p) {
        s.loading = undefined;
        fail(s, Date.now());
      }
      return fetch(request);
    }
    const hit = loaded.table.match(url);
    if (!hit) return fetch(request);
    ctx.maintain?.(event);
    return serveHit(ctx, request, url, hit, loaded);
  };
  queueMicrotask(() => registerRoute(gateRoute, gateHandler, 'GET'));
}
