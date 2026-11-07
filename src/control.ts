/// <reference lib="webworker" />
// 制御（https://weiwudi.example.com/v2/*。仕様 §4.1・§5.6・§12。m2-t8）。ページ側の Weiwudi.register などの相手。
// 値の依存は hook・registry・spec・context・store・tile_math・constants・errors だけ（仕様 §3 の許可は core も含む）。
//
// 決まり:
// - POST の本文は text/plain;charset=UTF-8 の JSON 文字列（第 1 回 C1）。応答は HTTP 200 の
//   { ok: true, result } か { ok: false, error: { code, message, detail } }。GET は /v2/ping だけ（{ api: 2, version }）
// - 範囲取得（m4-t3・range.ts）: fetchRange の ctx.job の確保と region の書き込み、job/resume のジョブを作り直す分岐は直列の中。
//   estimate・regions・cancel と job/resume の今の RegionInfo を返す分岐は直列の外（第 2 回 M3）。ジョブは event.waitUntil に結ぶ
// - register・update・clean・remove・releaseRange は 1 本の直列の待ち行列に通す（registry の apply は複数の tx に分かれるので、
//   同時の register で createResource が 2 回走り得る。m2-t6 の申し送り）。待ち行列は createControl の呼び出しごと
// - 旧 API の記録（kind: 'legacy'・id が map:）は見せない・触らない（source-not-found。第 1 回 S6）
// - register・update・remove の後に照合表を作り直す（hook.tableChanged）。作り直しが失敗しても登録は成功させ、
//   表を捨てて門番に読み直させる（古い表のまま固まらない。Ruling）
// - 照合表の影（template-shadowed）は、その Source が参照する Resource のものだけを warnings に足して保存する
// - スタイル（kind: 'style'）の register・update は style.ts。Resource の絞り込みは「持ち主の id の一覧」（ownerIdsOf）で行う。
//   スタイルは親の単位（親の children の子と、parentId が親の id の孤児。remove() が外す範囲と同じ。style.styleChildIds）、
//   ほかは自分（style.ownersOf）。source()・stats()・clean()・removeResource()・照合表の影で同じ単位を使う（m3-t7・m3-t8・L1 Minor-1）
// - removeResource は Entry だけを消す（Resource の記録と捕捉は残す。共有・範囲だけの参照でも消す。R18）。
//   スタイルの子の Resource は親の id で名指す（m3-t8）
// - usage は全 Resource（旧 API の map: も）を 1 つずつ数える。子の Resource も 1 回だけ（Source ごとに数えない。R19）
// - POST は送り手（event.clientId の client）の URL のオリジン（blob: は中のオリジン）が SW と同じときだけ受ける。
//   違う・見つからないときは sw-not-controlling で何もしない（I6・R25）。URL が about:srcdoc・about:blank の client は受ける。
//   GET の /v2/ping は見ない
import type { RouteHandlerCallbackOptions } from 'workbox-core';
import type { Context } from './context';
import { GATE_WAIT_MS, tableChanged, withTimeout } from './hook';
import { applyRegister, applyRemove, applyUpdate, isExclusiveTo } from './registry';
import { isNormalizedStyle, normalizeSpec, undeclaredCredentialWarnings, type NormalizedSpec } from './spec';
import { ownersOf, registerStyle, removeStyleChildren, styleChildIds } from './style';
import { isChildRecord, isLegacyRecord, storedSpecOf, styleSpecOf, toResourceInfo, type ResourceMeta, type SourceRecord, type Store } from './store';
import { KV_LIMITS } from './store';
import { countTiles, isInTileBox, scaleTileBox, type TileBox } from './tile_math';
import { assertSourceIdle, cancelRange, cleanRange, estimate, listRegionInfos, releaseAllOf, releaseRange, resumeRange, resumeState, startFetchRange, type JobClient } from './range';
import { WeiwudiError } from './errors';
import { V2_PREFIX } from './constants';
import type { SourceInfo, SourceStats, UsageReport } from './weiwudi';

declare const self: ServiceWorkerGlobalScope;

/** package.json の版（vite の define と vitest の define で埋める。第 1 回 S13） */
declare const __WEIWUDI_VERSION__: string;

/** /v2/ping の api の値（仕様 §4.1） */
export const CONTROL_API = 2;

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

const success = (result: unknown): Response => json({ ok: true, result: result ?? null });

/**
 * 失敗の形（仕様 §9）。WeiwudiError でない例外（IndexedDB など）は from で分類する。
 * from が internal にする DOMException（IndexedDB の例外）だけを storage（detail: { name }）にする。quota・db-blocked は from のまま、
 * DOMException でない例外（TypeError など。Weiwudi の不具合）は internal のまま（m4-t8・I4a・R39）
 */
const failure = (e: unknown): Response => {
  let err = WeiwudiError.from(e);
  if (err.code === 'internal' && e !== err && typeof DOMException !== 'undefined' && e instanceof DOMException) {
    err = new WeiwudiError('storage', err.message, { name: e.name });
  }
  return json({ ok: false, error: { code: err.code, message: err.message, detail: err.detail ?? {} } });
};

const notFound = (id: string): WeiwudiError =>
  new WeiwudiError('source-not-found', `Source "${id}" not found`, { sourceId: id });

/** 利用者が見る記録か（旧 API の記録とスタイルの子 Source は見せない。m3-t2） */
const isVisible = (rec: SourceRecord): boolean => !isLegacyRecord(rec) && !isChildRecord(rec);

/** 新 API の Source。無い・旧 API の記録・子 Source なら source-not-found */
const getOwn = async (store: Store, id: string): Promise<SourceRecord> => {
  const rec = await store.getSource(id);
  if (!rec || !isVisible(rec)) throw notFound(id);
  return rec;
};

/** 本文の id（register 以外の op）。文字列でなければ attribute-invalid */
const idOf = (body: unknown): string => {
  const id = body !== null && typeof body === 'object' ? (body as { id?: unknown }).id : undefined;
  if (typeof id !== 'string' || id === '') {
    throw new WeiwudiError('attribute-invalid', 'Attribute "id" must be a non-empty string', { attribute: 'id' });
  }
  return id;
};

/** 本文の resourceId（removeResource）。文字列でなければ attribute-invalid */
const resourceIdOf = (body: unknown): string => {
  const id = body !== null && typeof body === 'object' ? (body as { resourceId?: unknown }).resourceId : undefined;
  if (typeof id !== 'string' || id === '') {
    throw new WeiwudiError('attribute-invalid', 'Attribute "resourceId" must be a non-empty string', { attribute: 'resourceId' });
  }
  return id;
};

/**
 * Resource の絞り込みに使う持ち主の id の一覧。スタイルは親の単位（親の children の子と、parentId が親の id の孤児。
 * remove()・update() が外す範囲と同じ。style.styleChildIds）、ほかは自分（style.ownersOf）。子を集める処理は styleChildIds だけ
 */
const ownerIdsOf = async (store: Store, rec: SourceRecord): Promise<string[]> =>
  styleSpecOf(rec) ? styleChildIds(store, rec.id, ownersOf(rec)) : ownersOf(rec);

/**
 * 持ち主の id の一覧（ownerIdsOf）が参照する Resource（sourceIds のもの・範囲だけのもの。重ねない。
 * sourceIds のものを先に、登録の順）
 */
const resourcesOf = async (store: Store, owners: readonly string[]): Promise<ResourceMeta[]> => {
  const own: ResourceMeta[] = [];
  const rangeOnly: ResourceMeta[] = [];
  for (const id of owners) {
    for (const r of await store.resourcesBySource(id)) if (!own.some((o) => o.id === r.id)) own.push(r);
    for (const r of await store.resourcesByRangeOnlySource(id)) if (!rangeOnly.some((o) => o.id === r.id)) rangeOnly.push(r);
  }
  return [...own, ...rangeOnly.filter((r) => !own.some((o) => o.id === r.id))];
};

/** 範囲だけで参照している Resource か（持ち主のどれも sourceIds に無く、どれかが rangeOnlySourceIds にある） */
const isRangeOnlyFor = (m: ResourceMeta, owners: readonly string[]): boolean =>
  !owners.some((id) => m.sourceIds.indexOf(id) >= 0) && owners.some((id) => (m.rangeOnlySourceIds ?? []).indexOf(id) >= 0);

/** SourceInfo（仕様 §12）。resources は toResourceInfo の射影に、持ち主の一覧で決めた rangeOnly を付ける（第 3 回 O7） */
const infoOf = async (store: Store, rec: SourceRecord): Promise<SourceInfo> => {
  // 読み方は store の補助だけ（m2 の記録の type を補う。L1 M1）
  const spec = storedSpecOf(rec) ?? styleSpecOf(rec);
  if (!spec) throw notFound(rec.id);
  const now = Date.now();
  const owners = await ownerIdsOf(store, rec);
  return {
    id: rec.id,
    // getOwn・sources が旧 API の記録と子を除くので、kind は利用者の kind
    kind: rec.kind as SourceInfo['kind'],
    url: Array.isArray(spec.url) ? spec.url.slice() : spec.url,
    resources: (await resourcesOf(store, owners)).map((m) => {
      const info = toResourceInfo(m, now);
      if (isRangeOnlyFor(m, owners)) info.rangeOnly = true;
      return info;
    }),
    warnings: rec.warnings.slice(),
  };
};

/** 範囲（box と zoom）。Resource の座標（Resource の scheme）で持つ */
type BoxRange = { box: TileBox; minZoom: number; maxZoom: number };

/**
 * Resource の Entry のうち、範囲のどれかの中にあるものの数。z ごとに entriesAtZoom を読む（共有・範囲だけの Resource だけ。m4-t8・I3）。
 * 範囲は Resource の座標のもの（ResourceMeta.extents。registry.extentOf が scheme の違いを直した値。PR #106 M1）
 */
const countInBox = async (store: Store, resourceId: string, ranges: readonly BoxRange[]): Promise<number> => {
  let n = 0;
  const minZoom = Math.min(...ranges.map((r) => r.minZoom));
  const maxZoom = Math.max(...ranges.map((r) => r.maxZoom));
  for (let z = minZoom; z <= maxZoom; z++) {
    const boxes = ranges.filter((r) => z >= r.minZoom && z <= r.maxZoom).map((r) => scaleTileBox(r.box, r.maxZoom, z));
    if (boxes.length === 0) continue;
    for (const e of await store.entriesAtZoom(resourceId, z)) {
      if (e.x !== undefined && e.y !== undefined && boxes.some((b) => isInTileBox(b, e.x!, e.y!))) n++;
    }
  }
  return n;
};

/** Resource の extents のうち、持ち主の Source のもの（box のあるもの）。無ければ Source の範囲（同じ座標とみなす） */
const rangesOf = (m: ResourceMeta, owners: readonly string[], fallback: BoxRange): BoxRange[] => {
  const own = (m.extents ?? []).filter((e) => owners.indexOf(e.sourceId) >= 0 && e.box !== undefined)
    .map((e) => ({ box: e.box!, minZoom: e.minZoom, maxZoom: e.maxZoom }));
  return own.length > 0 ? own : [fallback];
};

/** SourceStats（仕様 §12）。byResource は null プロトタイプ（id が __proto__ などでも壊れない。第 3 回 推奨） */
const statsOf = async (store: Store, rec: SourceRecord): Promise<SourceStats> => {
  const byResource: Record<string, { count: number; bytes: number }> = Object.create(null);
  let count = 0;
  let size = 0;
  const owners = await ownerIdsOf(store, rec);
  const resources = await resourcesOf(store, owners);
  for (const m of resources) {
    byResource[m.id] = { count: m.count, bytes: m.bytes };
    count += m.count;
    size += m.bytes;
  }
  const stats: SourceStats = { count, size, byResource };
  // スタイルは範囲が 1 つに決まらないので total・percent を出さない（storedSpecOf は style の親で undefined）
  const extent = storedSpecOf(rec)?.extent;
  const box = extent?.box;
  if (extent && box) {
    // 範囲が決まるときだけ（仕様 §12）。count は box の中の Entry（m4-t8・I3・R41）。その Source だけが参照する Resource は
    // 範囲外を保存しない（§6 の 1）ので Resource の count を使い、共有・範囲だけの Resource だけ z ごとに数える（2 秒ごとの stats() で
    // 全 Entry のメタを読まない。第 1 回 M14）。byResource と size は Resource の数のまま
    let inBox = 0;
    for (const m of resources) {
      inBox += isExclusiveTo(m, owners) && !isRangeOnlyFor(m, owners)
        ? m.count : await countInBox(store, m.id, rangesOf(m, owners, { box, minZoom: extent.minZoom, maxZoom: extent.maxZoom }));
    }
    stats.count = inBox;
    stats.total = countTiles(box, extent.minZoom, extent.maxZoom);
    // update() で範囲を狭めた後の排他の Resource の範囲外の Entry も数えるので 100 で止める
    stats.percent = Math.min(100, Math.floor(inBox * 100 / (stats.total || 1)));
  }
  return stats;
};

/**
 * 照合表を作り直し、その Source の Resource の影（"template-shadowed: <Resource.id>"）を返す。
 * 作り直しが失敗したら表を捨てる（門番が次の候補の要求で読み直す。やり直しの間隔は hook の規則のまま）
 */
const refreshTable = async (ctx: Context, resourceIds: readonly string[]): Promise<string[]> => {
  let warnings: string[];
  try {
    // 上限は門番と同じ GATE_WAIT_MS。超えたら失敗と同じ扱い（登録は成功。m4-t8・I2b・R38）
    warnings = await withTimeout(tableChanged(ctx), GATE_WAIT_MS);
  } catch (_e) {
    ctx.table.current = undefined;
    return [];
  }
  return warnings.filter((w) => resourceIds.some((id) => w === `template-shadowed: ${id}`));
};

/**
 * 影の warnings を Source の warnings に足して保存する（source()・sources() でも同じ写しが見える）。
 * 保存の失敗は登録の失敗にしない（照合表の作り直しの失敗と同じ扱い。戻り値には影を含める。PR #80）
 */
const withShadows = async (store: Store, rec: SourceRecord, shadows: readonly string[]): Promise<SourceRecord> => {
  const extra = shadows.filter((w) => rec.warnings.indexOf(w) < 0);
  if (extra.length === 0) return rec;
  const next: SourceRecord = { ...rec, warnings: [...rec.warnings, ...extra] };
  try {
    await store.putSource(next);
  } catch (_e) {
    // 保存した warnings は影を含まないまま（次の register・update で書き直す）
  }
  return next;
};

/** SW のオリジン（同じオリジンの検査。§5.5-5）。SW の外（単体試験）で読めなければ undefined */
const swOrigin = (): string | undefined => {
  try {
    const o = self.location.origin;
    return typeof o === 'string' && o !== '' && o !== 'null' ? o : undefined;
  } catch (_e) {
    return undefined;
  }
};

/**
 * usage の鍵（R19）: ResourceMeta.provider、無ければ先頭のテンプレートの origin（旧 API の相対の URL は SW の場所で解決する）。
 * テンプレートが無い・解決できない・origin を持たない（data: など）ときは 'unknown'（Ruling）
 */
const providerKeyOf = (m: ResourceMeta): string => {
  if (typeof m.provider === 'string' && m.provider !== '') return m.provider;
  const t = m.templates[0];
  if (typeof t !== 'string') return 'unknown';
  let base: string | undefined;
  try {
    base = self.location.href;
  } catch (_e) {
    base = undefined;
  }
  try {
    const o = new URL(t, base).origin;
    return o === 'null' ? 'unknown' : o;
  } catch (_e) {
    return 'unknown';
  }
};

/** 全 Resource の使用量（R19）。byProvider は null プロトタイプ（鍵が __proto__ でも壊れない） */
const usageOf = async (store: Store): Promise<UsageReport> => {
  const byProvider: Record<string, { count: number; bytes: number }> = Object.create(null);
  let count = 0;
  let bytes = 0;
  for (const m of await store.listResources()) {
    count += m.count;
    bytes += m.bytes;
    const key = providerKeyOf(m);
    const slot = byProvider[key] ?? (byProvider[key] = { count: 0, bytes: 0 });
    slot.count += m.count;
    slot.bytes += m.bytes;
  }
  return { count, bytes, byProvider };
};

/** URL のオリジン（blob: は中のオリジン。WHATWG URL の origin がそう返す）。読めなければ undefined */
const originOf = (url: unknown): string | undefined => {
  if (typeof url !== 'string') return undefined;
  try {
    const o = new URL(url).origin;
    return o === 'null' ? undefined : o;
  } catch (_e) {
    return undefined;
  }
};

/**
 * 制御の POST の送り手が SW と同じオリジンの client か（I6・R25）。event.clientId の client を self.clients.get で引き、
 * その URL のオリジンを比べる。client・clientId・SW のオリジンのどれかが無ければ偽（fail-closed）
 */
const fromOwnOrigin = async (event: unknown): Promise<boolean> => {
  const own = swOrigin();
  if (own === undefined) return false;
  const clientId = event !== null && typeof event === 'object' ? (event as { clientId?: unknown }).clientId : undefined;
  if (typeof clientId !== 'string' || clientId === '') return false;
  let client: { url?: unknown } | undefined | null;
  try {
    client = await self.clients.get(clientId);
  } catch (_e) {
    return false;
  }
  if (!client) return false;
  // 同じオリジンの srcdoc・about:blank の iframe は URL に origin を持たない（clients.get が返すのは SW の制御下の client だけで、
  // sandbox の opaque な iframe は制御下に入らない。レビュー担当が Chromium で確認。m3-t8 L1 m-1）。ほかの null の origin は受けない
  if (client.url === 'about:srcdoc' || client.url === 'about:blank') return true;
  return originOf(client.url) === own;
};

export interface Control {
  /** 疑似ホストの GET のうち /v2/ で始まるもの（ping。ほかは 404） */
  get(options: RouteHandlerCallbackOptions): Promise<Response>;
  /** 疑似ホストの POST /v2/<op> */
  post(options: RouteHandlerCallbackOptions): Promise<Response>;
}

/** 制御のハンドラを作る。直列の待ち行列は呼び出しごと（Weiwudi_Internal の呼び出しごと） */
export function createControl(ctx: Context): Control {
  let tail: Promise<unknown> = Promise.resolve();
  /** 書き換えの op を 1 本ずつ通す。前の op の失敗は次へ持ち越さない */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  /**
   * 書き換えの op を直列に通し、途中で例外が出たら照合表を 1 回作り直してから投げ直す（表を古いまま固めない。m4-t8・I4b・R40）
   */
  const serialRefresh = <T>(fn: () => Promise<T>): Promise<T> => serial(async () => {
    try {
      return await fn();
    } catch (e) {
      await refreshTable(ctx, []);
      throw e;
    }
  });

  /**
   * 保存の後: 照合表を作り直し、持ち主の Resource の影を warnings に足して SourceInfo を返す。
   * extra は正規化の warnings（credential-undeclared。m4-t8・L8）で、影の前に足す
   */
  const finish = async (store: Store, rec: SourceRecord, extra: readonly string[] = []): Promise<SourceInfo> => {
    const ids = (await resourcesOf(store, await ownerIdsOf(store, rec))).map((m) => m.id);
    return infoOf(store, await withShadows(store, rec, [...extra, ...(await refreshTable(ctx, ids))]));
  };

  const register = (body: unknown) => serialRefresh(async () => {
    // 提供元の評価の順（利用者が先・標準の mapbox が後）で解決してから検査する（m3-t5・X8）
    const spec = normalizeSpec(body, ctx.providers());
    const store = await ctx.store();
    if (isNormalizedStyle(spec)) return finish(store, await registerStyle(ctx, spec, { mode: 'register', swOrigin: swOrigin() }), spec.warnings);
    const r = await applyRegister(store, spec);
    return finish(store, r.source, spec.warnings);
  });

  const update = (id: string) => serialRefresh(async () => {
    const store = await ctx.store();
    const rec = await getOwn(store, id);
    const credentials = await store.getCredentials(id);
    const style = styleSpecOf(rec);
    if (style) {
      // スタイルは取り直して芋づるを作り直す（下位資源の衝突で例外にしない。P2・R10）
      const before = (await resourcesOf(store, await ownerIdsOf(store, rec))).map((m) => m.id);
      const out = await registerStyle(ctx, credentials ? { spec: style, credentials } : { spec: style },
        { mode: 'update', swOrigin: swOrigin() });
      for (const rid of [...before, ...(await resourcesOf(store, await ownerIdsOf(store, out))).map((m) => m.id)]) ctx.corslessStreak.delete(rid);
      return finish(store, out, undeclaredCredentialWarnings([style.url], style.policy.credentialParams));
    }
    // 保存した登録内容で合流と方針を作り直す（資格情報は credentials ストアのものを持ち越す）
    // 保存した登録内容は storedSpecOf で読む（m2 の記録は type が無く、生のまま渡すと型違いの衝突になる。L1 M1）
    const stored = storedSpecOf(rec);
    if (!stored) throw notFound(id);
    const spec: NormalizedSpec = credentials ? { spec: stored, credentials } : { spec: stored };
    const r = await applyUpdate(store, id, spec);
    // CORS の判定をやり直す（仕様 §4.5。corsOk・corslessUntil は registry が消す）
    for (const m of r.resources) ctx.corslessStreak.delete(m.id);
    // 正規化の warnings（credential-undeclared）は保存した登録内容から作り直す（applyUpdate が warnings を書き直すため。m4-t8・L8）
    return finish(store, r.source, undeclaredCredentialWarnings(Array.isArray(stored.url) ? stored.url : [stored.url], stored.policy.credentialParams));
  });

  const clean = (body: unknown) => serial(async () => {
    const id = idOf(body);
    const store = await ctx.store();
    const rec = await getOwn(store, id);
    assertSourceIdle(ctx, id);
    const owners = await ownerIdsOf(store, rec);
    const range = field(body, 'range');
    if (range !== undefined) {
      await cleanRange(store, rec, owners, range, { force: field(field(body, 'options'), 'force') === true });
    } else {
      await releaseAllOf(store, id, owners, { keep: true });
      // 共有の Entry は残す（範囲だけの参照を含めて排他を判定。R47・M12）
      for (const resource of await resourcesOf(store, owners)) {
        if (isExclusiveTo(resource, owners)) await store.clearEntries(resource.id);
      }
    }
    return null;
  });

  const releaseRangeOp = (body: unknown) => serial(async () => {
    const id = idOf(body);
    const regionId = regionIdOf(body);
    const store = await ctx.store();
    const rec = await getOwn(store, id);
    await releaseRange(ctx, store, id, await ownerIdsOf(store, rec), regionId,
      { keep: field(field(body, 'options'), 'keep') === true });
    return null;
  });

  const remove = (id: string) => serialRefresh(async () => {
    const store = await ctx.store();
    const rec = await getOwn(store, id);
    assertSourceIdle(ctx, id);
    const owners = await ownerIdsOf(store, rec);
    const before = (await resourcesOf(store, owners)).map((m) => m.id);
    await releaseAllOf(store, id, owners, { keep: true });
    // スタイルは子を全部外してから親を消す（親の記録が残っていれば、途中で止まっても remove() をやり直せる）
    // parentId が親の id の孤児（段の途中で止まった子。R33）も外す（L1 M-1）
    if (styleSpecOf(rec)) await removeStyleChildren(store, id, ownersOf(rec), { strict: true });
    await applyRemove(store, id);
    for (const rid of before) {
      if (!(await store.getResource(rid))) ctx.corslessStreak.delete(rid);
    }
    await refreshTable(ctx, []);
    return null;
  });

  const removeResource = (body: unknown) => serialRefresh(async () => {
    const id = idOf(body);
    const resourceId = resourceIdOf(body);
    const store = await ctx.store();
    const rec = await getOwn(store, id);
    // スタイルは親の単位（子と孤児の子。remove() が外す範囲と同じ）で、ほかは自分で判定する（m3-t8）
    const owners = await ownerIdsOf(store, rec);
    const m = await store.getResource(resourceId);
    // sourceIds か rangeOnlySourceIds にあれば、共有でも範囲だけの参照でも消す（利用者が名指ししたため。R18・C-O13）
    const refers = !!m && owners.some((o) => m.sourceIds.indexOf(o) >= 0 || (m.rangeOnlySourceIds ?? []).indexOf(o) >= 0);
    if (!refers) {
      throw new WeiwudiError('resource-not-found', `Resource "${resourceId}" not found in source "${id}"`, { sourceId: id, resourceId });
    }
    // グリフは fontstack ごとのレコード（<id>\0<fontstack>）がキーの範囲に入るので、全部消える（#38）
    await store.clearEntries(resourceId);
    return null;
  });

  /** 範囲取得の本文の regionId（job/resume）。文字列でなければ attribute-invalid */
  const regionIdOf = (body: unknown): string => {
    const v = body !== null && typeof body === 'object' ? (body as { regionId?: unknown }).regionId : undefined;
    if (typeof v !== 'string' || v === '') {
      throw new WeiwudiError('attribute-invalid', 'Attribute "regionId" must be a non-empty string', { attribute: 'regionId' });
    }
    return v;
  };

  const field = (body: unknown, name: string): unknown =>
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;

  /** ジョブの client（開始の POST の event.clientId。I5c・R21）。無ければ sw-not-controlling */
  const jobClientOf = async (event: unknown): Promise<{ client: JobClient; waitUntil: (p: Promise<void>) => void }> => {
    const e = event as { clientId?: unknown; waitUntil?: unknown } | null | undefined;
    const clientId = e?.clientId;
    const client = typeof clientId === 'string' && clientId !== '' ? await self.clients.get(clientId) : undefined;
    if (!client || typeof e?.waitUntil !== 'function') {
      throw new WeiwudiError('sw-not-controlling', 'The request did not come from a client of the service worker');
    }
    const id = clientId as string;
    return {
      client: { id, postMessage: (m: unknown) => client.postMessage(m) },
      waitUntil: (p) => (e.waitUntil as (p: Promise<void>) => void).call(e, p),
    };
  };

  const estimateOp = async (body: unknown) => {
    const id = idOf(body);
    const store = await ctx.store();
    const rec = await getOwn(store, id);
    return estimate(store, rec, field(body, 'range'), await ownerIdsOf(store, rec));
  };

  const fetchRange = (body: unknown, event: unknown) => serial(async () => {
    const id = idOf(body);
    const store = await ctx.store();
    const rec = await getOwn(store, id);
    const { client, waitUntil } = await jobClientOf(event);
    const started = await startFetchRange(ctx, store, rec, await ownerIdsOf(store, rec), client, field(body, 'range'), field(body, 'options'));
    // 応答を先に返し、ジョブは開始の FetchEvent に結び付ける（SW が止まっても黙って消えない。F7・§7.2）
    waitUntil(started.job);
    return started.info;
  });

  const regions = async (body: unknown) => {
    const id = idOf(body);
    const store = await ctx.store();
    await getOwn(store, id);
    return listRegionInfos(ctx, store, id);
  };

  const cancel = async (body: unknown) => {
    const id = idOf(body);
    await getOwn(await ctx.store(), id);
    return cancelRange(ctx, id);
  };

  const resume = async (body: unknown, event: unknown) => {
    const id = idOf(body);
    const regionId = regionIdOf(body);
    const store = await ctx.store();
    await getOwn(store, id);
    const now = await resumeState(ctx, store, id, regionId);
    if (now) return now;
    // ジョブを作り直す分岐だけは直列の中（clean()・remove() と並ばない。R57・第 2 回 M3）
    return serial(async () => {
      const rec = await getOwn(store, id);
      const { client, waitUntil } = await jobClientOf(event);
      const r = await resumeRange(ctx, store, rec, await ownerIdsOf(store, rec), client, regionId);
      if (r.job) waitUntil(r.job);
      return r.info;
    });
  };

  const usage = async () => usageOf(await ctx.store());

  // 全体上限（m4-t6・仕様 §7.1）。kv の limits に保存し、maxBytes が無ければ外す。次の保存から効く（今あるものはすぐには消さない）
  const setLimits = async (body: unknown) => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new WeiwudiError('attribute-invalid', 'Request body must be an object', { attribute: 'limits' });
    }
    const maxBytes = (body as { maxBytes?: unknown }).maxBytes;
    if (maxBytes !== undefined && !(typeof maxBytes === 'number' && Number.isInteger(maxBytes) && maxBytes >= 0)) {
      throw new WeiwudiError('attribute-invalid', 'Attribute "maxBytes" must be a non-negative integer', { attribute: 'maxBytes' });
    }
    await (await ctx.store()).kvPut(KV_LIMITS, maxBytes === undefined ? {} : { maxBytes });
    return null;
  };

  const source = async (id: string) => {
    const store = await ctx.store();
    return infoOf(store, await getOwn(store, id));
  };

  const sources = async () => {
    const store = await ctx.store();
    const recs = (await store.listSources()).filter(isVisible);
    return Promise.all(recs.map((r) => infoOf(store, r)));
  };

  const stats = async (id: string) => {
    const store = await ctx.store();
    return statsOf(store, await getOwn(store, id));
  };

  const run = async (op: string, body: unknown, event: unknown): Promise<unknown> => {
    switch (op) {
      case 'estimate': return estimateOp(body);
      case 'fetchRange': return fetchRange(body, event);
      case 'regions': return regions(body);
      case 'cancel': return cancel(body);
      // /v2/job/resume は url.pathname.slice(V2_PREFIX.length) で 'job/resume'（計画の申し送り）
      case 'job/resume': return resume(body, event);
      case 'register': return register(body);
      case 'source': return source(idOf(body));
      case 'sources': return sources();
      case 'stats': return stats(idOf(body));
      case 'update': return update(idOf(body));
      case 'clean': return clean(body);
      case 'releaseRange': return releaseRangeOp(body);
      case 'remove': return remove(idOf(body));
      case 'removeResource': return removeResource(body);
      case 'usage': return usage();
      case 'setLimits': return setLimits(body);
      default:
        throw new WeiwudiError('api-not-found', `Operation "${op}" not found`, { op });
    }
  };

  return {
    get: async ({ url }) => {
      if (url.pathname === `${V2_PREFIX}ping`) return json({ api: CONTROL_API, version: __WEIWUDI_VERSION__ });
      return new Response('Not Found', { status: 404 });
    },
    post: async ({ url, request, event }) => {
      try {
        // 送り手の検査は本文を読む前（別オリジンの client の要求では何もしない。I6・R25）
        if (!(await fromOwnOrigin(event))) {
          throw new WeiwudiError('sw-not-controlling', 'The request did not come from a client of the service worker origin');
        }
        ctx.maintain?.(event);
        const op = url.pathname.slice(V2_PREFIX.length);
        let body: unknown;
        try {
          const text = await request.text();
          body = text === '' ? {} : JSON.parse(text);
        } catch (_e) {
          throw new WeiwudiError('attribute-invalid', 'Request body must be a JSON text', { attribute: 'body' });
        }
        return success(await run(op, body, event));
      } catch (e) {
        return failure(e);
      }
    },
  };
}
