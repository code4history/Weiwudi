// スタイルの芋づる登録（仕様 §5.5・§5.6・§10。m3-t7・R1〜R5・R10・R30・R33〜R35）。control の直列の待ち行列の中で呼ぶ。
// 値の依存は hook・registry・spec・style_body・url_pattern・store・errors だけ（仕様 §3 の許可は core・context・constants も含む）。
//
// 決まり:
// - モジュール変数を持たない
// - 取得は hook.serveResource だけ（core.serve → upstream。fetch を直に呼ばない。C-O12）
// - 子は registry.apply（{ throwOnConflict: false }。update は resetCors: true）。親の記録は子を 1 つ書くたびに書き直す
//   （途中で止まっても、作った子が親の children に載り、remove() で外せる。t2 の申し送り「子を書いてから children を
//   更新するまでの間、その子は退避の範囲に入らない」を 1 子分に縮める）
// - 資格情報は親（スタイルの id）と子（子の id）の両方に持つ。親のものは登録の正本（update() で配り直す）、子のものは捕捉で
//   照合表が使う。子には、子の全テンプレートが credentialTargetOf で真のときだけ親のものを配る（R5・X2）。
//   子のテンプレートに載っていた同じ名前の値は、子のものが勝つ（t6 の申し送り。上流がその URL に付けた値を上書きしない）
// - 子にする組の判定は spec.acceptsMember（本体の除去の組と同じ。t6 の申し送り）
// - warnings に資格情報を出さない（subject は Resource.id・クエリを落とした URL・sources.<名前>）
import type { Context } from './context';
import { serveResource } from './hook';
import { apply, applyRemove, childLogicalName, childSourceId, type ChildSlot, type RegisterResult } from './registry';
import {
  acceptsMember, hasSecretPathSegment, normalizeMember,
  type NormalizedSpec, type NormalizedStyle, type StoredSpec, type StyleChild, type StyleSpec,
} from './spec';
import { collectStyleRefs, collectTileJson, credentialTargetOf, parseStyle } from './style_body';
import { MAX_TILE_ZOOM, compileTemplate, matchUrl, spriteTemplateOf, type MatchResult } from './url_pattern';
import { nextOrder, styleSpecOf, type Credentials, type ResourceMeta, type ResourceType, type SourceRecord, type Store } from './store';
import { WeiwudiError } from './errors';

/** 取れたものとして本体を使う x-weiwudi-status（C-S5。stale の古い本体も使う） */
const USABLE: readonly string[] = ['hit', 'miss', 'refresh', 'stale'];

/** warnings の書式（仕様 §12 の "<code>: <subject>"。R20） */
export const fetchFailedWarning = (subject: string): string => `fetch-failed: ${subject}`;
export const sameOriginSkippedWarning = (subject: string): string => `same-origin-skipped: ${subject}`;
export const unsupportedSourceWarning = (subject: string): string => `unsupported-source: ${subject}`;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const hasCredentials = (c: Credentials | undefined): c is Credentials =>
  !!c && (Object.keys(c.query ?? {}).length > 0 || Object.keys(c.headers ?? {}).length > 0);

const unique = <T>(xs: readonly T[]): T[] => xs.filter((x, i) => xs.indexOf(x) === i);

/** テンプレートでもよい URL のオリジン（読めなければ undefined） */
const originOf = (url: string): string | undefined => {
  try {
    const o = new URL(url.replace(/\{[^{}]*\}/g, '0')).origin;
    return o === 'null' ? undefined : o;
  } catch (_e) {
    return undefined;
  }
};

/** URL（テンプレートでよい）が userinfo（user:pass@）を持つか。読めなければ持つものとして扱う（subject に出さない） */
const hasUserInfo = (url: string): boolean => {
  try {
    const u = new URL(url.replace(/\{[^{}]*\}/g, '0'));
    return u.username !== '' || u.password !== '';
  } catch (_e) {
    return true;
  }
};

/**
 * 子にしない URL の subject（C-S6・X3・R36）: クエリとフラグメントを落とした URL。パスに秘密（sk.eyJ）があるか、
 * userinfo を持てば label（sources.<名前> など。L2 A）
 */
const subjectOf = (url: string, label: string): string => {
  if (hasSecretPathSegment(url) || hasUserInfo(url)) return label;
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
};

/**
 * 子の資格情報（R5・X2・t6 の申し送り）: given（親のもの。配る相手でなければ undefined）に、子のテンプレートに載っていた値
 * （own）を重ねる。同じ名前（大文字小文字を問わない）は own が勝つ
 */
const mergeCredentials = (given: Credentials | undefined, own: Credentials | undefined): Credentials | undefined => {
  if (!given) return own;
  const query: Record<string, string> = { ...(given.query ?? {}) };
  for (const [name, value] of Object.entries(own?.query ?? {})) {
    for (const k of Object.keys(query)) if (k.toLowerCase() === name.toLowerCase()) delete query[k];
    query[name] = value;
  }
  const headers: Record<string, string> = { ...(given.headers ?? {}), ...(own?.headers ?? {}) };
  const out: Credentials = {};
  if (Object.keys(query).length > 0) out.query = query;
  if (Object.keys(headers).length > 0) out.headers = headers;
  return out;
};

/** スタイルの子（論理名 style）の指定。親の正規化の値をそのまま使う（子は cacheMaxBytes を持たない） */
const styleChildOf = (parent: StyleSpec, credentials: Credentials | undefined): NormalizedSpec => {
  const logicalName = childLogicalName('style');
  const spec: StoredSpec = {
    kind: 'child',
    type: 'style',
    id: childSourceId(parent.id, 'style', logicalName),
    url: parent.url,
    templates: parent.templates.slice(),
    policy: parent.policy,
    logicalName,
  };
  if (parent.provider !== undefined) spec.provider = parent.provider;
  return credentials ? { spec, credentials } : { spec };
};

/** 範囲の項目（TileJSON とスタイルの source）。形の合うものだけ */
interface RangeIn {
  scheme?: 'xyz' | 'tms';
  bounds?: number[];
  minzoom?: number;
  maxzoom?: number;
}

const rangeIn = (o: Obj | undefined): RangeIn => {
  const out: RangeIn = {};
  if (!o) return out;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (o.scheme === 'xyz' || o.scheme === 'tms') out.scheme = o.scheme;
  if (Array.isArray(o.bounds) && o.bounds.length === 4 && o.bounds.every(finite)) out.bounds = (o.bounds as number[]).slice();
  if (finite(o.minzoom)) out.minzoom = o.minzoom;
  if (finite(o.maxzoom)) out.maxzoom = o.maxzoom;
  return out;
};

const clampZoom = (z: number): number => Math.min(MAX_TILE_ZOOM, Math.max(0, z));

/**
 * 範囲の項目を normalizeMember の入力（bounds・minZoom・maxZoom・scheme）へ直す。ズームは整数へ丸めて 0〜30 に収め、
 * bounds があって maxzoom が無ければ 30（U1・TileJSON 3.0 の既定）。形の合わない bounds（東西の逆転・範囲外）は捨てて全域にする
 * （範囲は地図ライブラリの要求の外を範囲外にするだけで、捨てても捕捉は変わらない）
 */
const rangeCommon = (r: RangeIn): Obj => {
  const out: Obj = {};
  if (r.scheme) out.scheme = r.scheme;
  const minZoom = r.minzoom === undefined ? undefined : clampZoom(Math.floor(r.minzoom));
  let maxZoom = r.maxzoom === undefined ? undefined : clampZoom(Math.ceil(r.maxzoom));
  const b = r.bounds;
  const boundsOk = !!b && b[0] >= -180 && b[2] <= 180 && b[1] >= -90 && b[3] <= 90 && b[0] <= b[2] && b[1] <= b[3];
  if (boundsOk && maxZoom === undefined) maxZoom = MAX_TILE_ZOOM;
  if (minZoom !== undefined && maxZoom !== undefined && minZoom > maxZoom) return out;
  if (minZoom !== undefined) out.minZoom = minZoom;
  if (maxZoom !== undefined) out.maxZoom = maxZoom;
  if (boundsOk) out.bounds = b!.slice();
  return out;
};

const TILE_ENCODING: Readonly<Record<string, 'raster' | 'vector'>> = Object.freeze({
  vector: 'vector', raster: 'raster', 'raster-dem': 'raster',
});

export interface StyleRegisterOptions {
  /** 'register' は通常の順の取得、'update' は revalidate と resetCors（R4） */
  mode: 'register' | 'update';
  /** SW のオリジン（self.location.origin）。無ければ同じオリジンの検査をしない（§5.5-5） */
  swOrigin?: string;
}

/** 照合する Resource（候補のテンプレートに当たる最初のもの）と MatchResult */
const matchIn = (candidates: readonly ResourceMeta[], url: URL): { resource: ResourceMeta; m: MatchResult } | undefined => {
  for (const r of candidates) {
    for (const t of r.templates) {
      let m: MatchResult | null = null;
      try {
        m = matchUrl(compileTemplate(t), url);
      } catch (_e) {
        m = null;
      }
      if (m) return { resource: r, m };
    }
  }
  return undefined;
};

/**
 * 保存しない仮の Resource（O-N2）。id は新しい正規化のテンプレートで、同じ id の Resource が store にあれば当たらない id にする
 * （serve は Resource が無ければ保存も差し込み口も使わない）
 */
const tempResource = async (store: Store, spec: StoredSpec): Promise<ResourceMeta> => {
  let id = spec.templates[0];
  for (let n = 2; await store.getResource(id); n++) id = `${spec.templates[0]}#weiwudi-unsaved-${n}`;
  const r: ResourceMeta = {
    id, type: spec.type, templates: spec.templates.slice(), sourceIds: [], policy: spec.policy, count: 0, bytes: 0, pinnedBytes: 0,
  };
  if (spec.provider !== undefined) r.provider = spec.provider;
  return r;
};

/** 1 回の取得の結果。本体が使えなければ undefined。serveResource の reject（store の失敗）は投げ直す */
const fetchBody = async (
  ctx: Context, store: Store, candidates: readonly ResourceMeta[], spec: StoredSpec, credentials: Credentials | undefined,
  opts: Parameters<typeof serveResource>[6],
): Promise<{ text: string; resourceId: string } | undefined> => {
  const urlText = Array.isArray(spec.url) ? spec.url[0] : spec.url;
  const url = new URL(urlText);
  const hit = matchIn(candidates, url);
  const resource = hit?.resource ?? await tempResource(store, spec);
  const m: MatchResult = hit?.m ?? { queryParams: [] };
  const res = await serveResource(ctx, resource, new Request(url.href), url, m, hasCredentials(credentials) ? credentials : undefined, opts);
  const status = res.headers.get('x-weiwudi-status') ?? '';
  if (USABLE.indexOf(status) < 0) return undefined;
  return { text: await res.text(), resourceId: resource.id };
};

/**
 * スタイルの登録・再登録・update()（仕様 §5.5・R1〜R5・R10・R30・R33〜R35）。保存した親の記録を返す
 * （照合表の作り直しと template-shadowed の追記は control が行う）。
 * - 新しい登録: 段 A〜C のどこかで失敗したら、作った子を外してから親を外して、元の例外で reject する（R30）
 * - 既存の登録: 段 A（スタイルの取得と解析）が成功するまで何も書かない。段 A の後の失敗は巻き戻さない（R33）
 * 同じ id の style でない Source があれば attribute-invalid（C-O5・R37）
 */
export async function registerStyle(ctx: Context, input: NormalizedStyle, o: StyleRegisterOptions): Promise<SourceRecord> {
  const store = await ctx.store();
  const base: StyleSpec = { ...input.spec, children: [] };
  const id = base.id;
  const existing = await store.getSource(id);
  if (existing && existing.kind !== 'style') {
    throw new WeiwudiError('attribute-invalid', 'Attribute "kind" must not change for the same id (remove() it first)',
      { attribute: 'kind' });
  }
  const prevChildren = existing ? styleSpecOf(existing)?.children ?? [] : [];
  const creds = hasCredentials(input.credentials) ? input.credentials : undefined;
  const update = o.mode === 'update';
  const order = existing?.order ?? await nextOrder(store);
  const createdAt = existing?.createdAt ?? Date.now();
  const providers = ctx.providers();
  const provider = base.provider === undefined ? undefined : providers.find((p) => p.id === base.provider);
  const fetchOpts = { ...(update ? { revalidate: true } : {}) };

  /** この回に作った子（登録の順。論理名の id で重ねない） */
  const next: StyleChild[] = [];
  /** この回に書き始めた子の id（apply の前に入れる。apply の途中で投げた子も巻き戻す。L1 M-1） */
  const touched: string[] = [];
  const warnings: string[] = [];
  /** 親の記録（children は前の子と今回の子の和。最後だけ今回の子） */
  const saveParent = async (children: StyleChild[], w: string[]): Promise<SourceRecord> => {
    const rec: SourceRecord = { id, kind: 'style', spec: { ...base, children }, order, warnings: w, createdAt };
    await store.putSource(rec);
    return rec;
  };
  const midChildren = (): StyleChild[] => [
    ...prevChildren.filter((c) => !next.some((n) => n.id === c.id)),
    ...next,
  ];

  const styleChild = styleChildOf(base, creds);
  const styleUrl = base.url;
  const stageAOpts = { ...fetchOpts, parent: { url: styleUrl, ...(base.provider !== undefined ? { provider: base.provider } : {}) } };

  /** 子を 1 つ合流させて保存し、親の children に載せる */
  const applyChild = async (n: NormalizedSpec, from?: string): Promise<RegisterResult> => {
    const before = await store.getSource(n.spec.id);
    // 子の内部の id に子でない記録（か別の親の子）があれば止める。新規として上書きしない（巻き戻しの対象にも入れない。L2 D）
    if (before && (before.kind !== 'child' || before.parentId !== id)) {
      throw new WeiwudiError('internal', 'A record that is not a child of this style holds the id of a style resource');
    }
    if (touched.indexOf(n.spec.id) < 0) touched.push(n.spec.id);
    const r = await apply(store, n, before,
      { throwOnConflict: false, resetCors: update, order, parentId: id });
    const child: StyleChild = { id: n.spec.id, logicalName: n.spec.logicalName ?? '', type: n.spec.type };
    if (from !== undefined) child.from = from;
    const at = next.findIndex((c) => c.id === child.id);
    if (at >= 0) next[at] = child;
    else next.push(child);
    await saveParent(midChildren(), existing?.warnings.slice() ?? []);
    return r;
  };

  /** 段 3・B・C と、前の子の除去・親の保存 */
  const stagesBC = async (style: unknown): Promise<SourceRecord> => {
    const swOrigin = o.swOrigin;
    const styleOrigin = originOf(styleUrl);
    const credentialParams = base.policy.credentialParams;
    const accepts = (type: ResourceType, templates: string[]) => acceptsMember(type, templates, credentialParams, providers);
    const target = credentialTargetOf({
      styleOrigin: styleOrigin ?? '',
      ...(provider ? { providerMatches: (u: string) => provider.matches(u) } : {}),
    });
    const common: Obj = {
      cacheTtl: base.policy.cacheTtl,
      cachePrivate: base.policy.store,
      credentialParams,
      ...(base.policy.cacheRetention !== undefined ? { cacheRetention: base.policy.cacheRetention } : {}),
    };
    const sources = isObj(style) && isObj(style.sources) ? style.sources : {};
    const refs = collectStyleRefs(style, styleUrl, accepts);

    /** 同じオリジンの検査（§5.5-5・R35）。crossOrigin が真なら SW と同じオリジンの URL を子にしない */
    const sameOriginHit = (urls: readonly string[], crossOrigin: boolean): string | undefined =>
      swOrigin !== undefined && crossOrigin ? urls.find((u) => originOf(u) === swOrigin) : undefined;
    const styleIsCross = swOrigin !== undefined && styleOrigin !== swOrigin;

    /** 子を 1 つ作る。作らなければ undefined（warnings に理由） */
    const makeChild = async (
      type: ResourceType, slot: ChildSlot, key: string | undefined, urls: string[], extra: Obj, label: string,
      crossOrigin: boolean, encoding?: 'raster' | 'vector', from?: string,
    ): Promise<{ r: RegisterResult; n: NormalizedSpec } | undefined> => {
      const same = sameOriginHit(urls, crossOrigin);
      if (same !== undefined) {
        warnings.push(sameOriginSkippedWarning(subjectOf(same, label)));
        return undefined;
      }
      const logicalName = childLogicalName(slot, key);
      let n: NormalizedSpec;
      try {
        n = normalizeMember(type, urls, { ...common, ...extra }, {
          kind: 'child', internalId: childSourceId(id, type, logicalName), logicalName, single: urls.length === 1,
          ...(encoding ? { encoding } : {}),
        }, providers);
      } catch (_e) {
        // 拒否の理由（テンプレートの値を含みうる）は文面に入れない
        warnings.push(unsupportedSourceWarning(label));
        return undefined;
      }
      // 親の資格情報は、子の全テンプレート（ミラーを含む）が配る相手のときだけ（R5・X2）
      const given = creds && urls.every((u) => target(u)) ? creds : undefined;
      const merged = mergeCredentials(given, n.credentials);
      n = hasCredentials(merged) ? { spec: n.spec, credentials: merged } : { spec: n.spec };
      const r = await applyChild(n, from);
      return { r, n };
    };

    // 段 B: TileJSON（前の子は外さない。R2）
    const failedTileJson: string[] = [];
    for (const tj of refs.tilejson) {
      const src = isObj(sources[tj.name]) ? sources[tj.name] as Obj : undefined;
      const encoding = src && typeof src.type === 'string' ? TILE_ENCODING[src.type] : undefined;
      const label = `sources.${tj.name}`;
      const made = await makeChild('tilejson', 'source', tj.name, [tj.url], {}, label, styleIsCross);
      if (!made) continue;
      const tjId = made.n.spec.id;
      const got = await fetchBody(ctx, store, made.r.resources, made.n.spec, made.n.credentials,
        { ...fetchOpts, credentialSourceId: tjId });
      const tileJson = got ? collectTileJson(got.text, made.n.spec.url as string) : undefined;
      if (!got || !tileJson) {
        // Entry が無く上流も失敗した（C-S5）。前回この TileJSON から作った子は前回のまま残す（R3）
        const rid = made.r.resources.find((m) => m.type === 'tilejson')?.id ?? made.n.spec.templates[0];
        warnings.push(fetchFailedWarning(rid));
        failedTileJson.push(tjId);
        continue;
      }
      if (!encoding || tileJson.urls.length === 0) continue;
      // TileJSON の tiles にも同じオリジンの検査を当てる（スタイルか TileJSON のどちらかが別オリジンなら。C-S2・R35）
      const tjCross = styleIsCross || (swOrigin !== undefined && originOf(tj.url) !== swOrigin);
      // 範囲はスタイルの source の値が TileJSON の値に勝つ（MapLibre と同じ）
      const range = rangeCommon({ ...rangeIn(tileJson as unknown as Obj), ...rangeIn(src) });
      await makeChild('tile', 'tilejson-tiles', tj.name, tileJson.urls, range, label, tjCross, encoding, tjId);
    }

    // 段 C: 残りの子
    for (const t of refs.tiles) {
      await makeChild('tile', 'source', t.name, t.urls, rangeCommon(t), `sources.${t.name}`, styleIsCross, t.encoding);
    }
    if (refs.glyphs !== undefined) {
      await makeChild('glyph', 'glyphs', undefined, [refs.glyphs], {}, 'glyphs', styleIsCross);
    }
    for (let i = 0; i < refs.sprites.length; i++) {
      const sid = refs.spriteIds[i];
      await makeChild('sprite', 'sprite', sid, [spriteTemplateOf(refs.sprites[i])], {},
        sid === undefined ? 'sprite' : `sprite.${sid}`, styleIsCross);
    }
    for (const d of refs.data) {
      await makeChild('data', 'data', d.name, [d.url], {}, `sources.${d.name}`, styleIsCross);
    }
    for (const s of refs.skipped) warnings.push(unsupportedSourceWarning(`sources.${s.name}`));
    // Mapbox の imports（Standard スタイル）は辿らない（MapLibre は扱わない。台帳の t5 の申し送り）
    if (isObj(style) && Array.isArray(style.imports) && style.imports.length > 0) warnings.push(unsupportedSourceWarning('imports'));

    // 取れなかった TileJSON から前回作った子は残す（R3）
    for (const c of prevChildren) {
      if (c.from !== undefined && failedTileJson.indexOf(c.from) >= 0 && !next.some((n) => n.id === c.id)) next.push(c);
    }
    // 前の子のうち今回の子に無いものを外す。親の children だけでなく、parentId が親の id の孤児（前の update() が段 A の後で
    // 止まって残した子。R33）も同じ単位で外す（照合表と資格情報を持ったまま残らない。L1 Minor-1）
    for (const cid of await styleChildIds(store, id, prevChildren.map((c) => c.id))) {
      if (next.some((n) => n.id === cid)) continue;
      try {
        await applyRemove(store, cid);
      } catch (e) {
        if (!(e instanceof WeiwudiError && e.code === 'source-not-found')) throw e;
      }
    }
    // 親の warnings: 全子の warnings（resource-conflict）と段の warnings（template-shadowed は control が足す。C-O11）
    const childWarnings: string[] = [];
    for (const c of next) {
      const rec = await store.getSource(c.id);
      if (rec) childWarnings.push(...rec.warnings);
    }
    return saveParent(next.slice(), unique([...childWarnings, ...warnings]));
  };

  if (!existing) {
    // 新しい登録: 親と資格情報を先に保存する（段 A の取得の除去の規則と退避の範囲が親を読む）
    try {
      await saveParent([], []);
      if (creds) await store.putCredentials(id, creds);
      const r = await applyChild(styleChild);
      const body = await fetchBody(ctx, store, r.resources, styleChild.spec, creds, stageAOpts);
      if (!body) throw invalidStyle();
      const style = parseStyle(body.text);
      return await stagesBC(style);
    } catch (e) {
      // 巻き戻し（R30）: 作った子を外してから親を外す。巻き戻しの失敗は飲み込む（R33）
      await removeStyleChildren(store, id, touched);
      await removeQuietly(store, id);
      throw e;
    }
  }

  // 既存の登録: 段 A は前の style 子の Resource（あれば）で取る。何も書かない（R30）
  const prevStyleResources = await store.resourcesBySource(styleChild.spec.id);
  const body = await fetchBody(ctx, store, prevStyleResources, styleChild.spec, creds, stageAOpts);
  if (!body) throw invalidStyle();
  const style = parseStyle(body.text);
  // 段 A の後で初めて書く
  await saveParent(prevChildren.slice(), existing.warnings.slice());
  await store.putCredentials(id, creds ?? {});
  await applyChild(styleChild);
  return stagesBC(style);

}

/**
 * 1 つの Source を外す（source-not-found を含め、失敗は飲み込む）。applyRemove が投げたら記録と資格情報だけでも消す
 * （書きかけの子の資格情報を残さない。L1 M-1）
 */
const removeQuietly = async (store: Store, sourceId: string): Promise<void> => {
  try {
    await applyRemove(store, sourceId);
  } catch (_e) {
    try { await store.deleteSource(sourceId); } catch (_e2) { /* 部分的な状態が残りうる（R33） */ }
  }
};

/**
 * スタイルの子を全部外す（巻き戻しと control の remove。L1 M-1）。対象は ids（親の children・この回に書き始めた子）と、
 * listSources() のうち parentId が親の id の記録（親の children に載る前に途中で止まった孤児。R33 の経路も含む）。
 * strict（control の remove）は source-not-found 以外の失敗を投げ直す（親を消す前に止め、remove() をやり直せるようにする）。
 * strict でなければ（巻き戻し）失敗を飲み込み、記録と資格情報だけでも消す
 */
export async function removeStyleChildren(
  store: Store, parentId: string, ids: readonly string[], opts: { strict?: boolean } = {},
): Promise<void> {
  let targets: string[] = unique(ids);
  try {
    targets = await styleChildIds(store, parentId, ids);
  } catch (e) {
    if (opts.strict) throw e;
  }
  for (const cid of targets) {
    if (!opts.strict) {
      await removeQuietly(store, cid);
      continue;
    }
    try {
      await applyRemove(store, cid);
    } catch (e) {
      if (!(e instanceof WeiwudiError && e.code === 'source-not-found')) throw e;
    }
  }
}

const invalidStyle = (): WeiwudiError => new WeiwudiError('invalid-style', 'The style is not readable', { type: 'style' });

/**
 * removeStyleChildren が外す子の id（ids と、listSources() のうち parentId が親の id の孤児。重ねない・ids を先に）。
 * control の removeResource も、親の単位の持ち主の一覧としてこれを使う（remove() が外す範囲の Resource を名指しできる。m3-t8）。
 * listSources() の失敗はそのまま投げる
 */
export async function styleChildIds(store: Store, parentId: string, ids: readonly string[]): Promise<string[]> {
  const orphans = (await store.listSources()).filter((r) => r.parentId === parentId).map((r) => r.id);
  return unique([...ids, ...orphans]);
}

/** 親の全子の id（control の絞り込み。スタイルでなければ自分の id だけ） */
export const ownersOf = (rec: SourceRecord): string[] => {
  const style = styleSpecOf(rec);
  return style ? style.children.map((c) => c.id) : [rec.id];
};
