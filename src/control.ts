/// <reference lib="webworker" />
// 制御（https://weiwudi.example.com/v2/*。仕様 §4.1・§5.6・§12。m2-t8）。ページ側の Weiwudi.register などの相手。
// 値の依存は hook・registry・spec・context・store・tile_math・constants・errors だけ（仕様 §3 の許可は core も含む）。
//
// 決まり:
// - POST の本文は text/plain;charset=UTF-8 の JSON 文字列（第 1 回 C1）。応答は HTTP 200 の
//   { ok: true, result } か { ok: false, error: { code, message, detail } }。GET は /v2/ping だけ（{ api: 2, version }）
// - register・update・clean・remove は 1 本の直列の待ち行列に通す（registry の apply は複数の tx に分かれるので、
//   同時の register で createResource が 2 回走り得る。m2-t6 の申し送り）。待ち行列は createControl の呼び出しごと
// - 旧 API の記録（kind: 'legacy'・id が map:）は見せない・触らない（source-not-found。第 1 回 S6）
// - register・update・remove の後に照合表を作り直す（hook.tableChanged）。作り直しが失敗しても登録は成功させ、
//   表を捨てて門番に読み直させる（古い表のまま固まらない。Ruling）
// - 照合表の影（template-shadowed）は、その Source が参照する Resource のものだけを warnings に足して保存する
// - スタイル（kind: 'style'）の register・update は style.ts。Resource の絞り込みは「持ち主の id の一覧」（スタイルは子の id、
//   ほかは自分。style.ownersOf）で行う（m3-t7・I3 の後半）
import type { RouteHandlerCallbackOptions } from 'workbox-core';
import type { Context } from './context';
import { tableChanged } from './hook';
import { applyRegister, applyRemove, applyUpdate, isExclusiveTo } from './registry';
import { isNormalizedStyle, normalizeSpec, type NormalizedSpec } from './spec';
import { ownersOf, registerStyle } from './style';
import { isChildRecord, isLegacyRecord, storedSpecOf, styleSpecOf, toResourceInfo, type ResourceMeta, type SourceRecord, type Store } from './store';
import { countTiles } from './tile_math';
import { WeiwudiError } from './errors';
import { V2_PREFIX } from './constants';
import type { SourceInfo, SourceStats } from './weiwudi';

/** package.json の版（vite の define と vitest の define で埋める。第 1 回 S13） */
declare const __WEIWUDI_VERSION__: string;

/** /v2/ping の api の値（仕様 §4.1） */
export const CONTROL_API = 2;

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

const success = (result: unknown): Response => json({ ok: true, result: result ?? null });

/** 失敗の形（仕様 §9）。WeiwudiError でない例外（IndexedDB など）は from で分類する */
const failure = (e: unknown): Response => {
  const err = WeiwudiError.from(e);
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

/**
 * 持ち主の id の一覧（スタイルは子の id、ほかは自分）が参照する Resource（sourceIds のもの・範囲だけのもの。重ねない。
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
  const owners = ownersOf(rec);
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

/** SourceStats（仕様 §12）。byResource は null プロトタイプ（id が __proto__ などでも壊れない。第 3 回 推奨） */
const statsOf = async (store: Store, rec: SourceRecord): Promise<SourceStats> => {
  const byResource: Record<string, { count: number; bytes: number }> = Object.create(null);
  let count = 0;
  let size = 0;
  for (const m of await resourcesOf(store, ownersOf(rec))) {
    byResource[m.id] = { count: m.count, bytes: m.bytes };
    count += m.count;
    size += m.bytes;
  }
  const stats: SourceStats = { count, size, byResource };
  // スタイルは範囲が 1 つに決まらないので total・percent を出さない（storedSpecOf は style の親で undefined）
  const extent = storedSpecOf(rec)?.extent;
  if (extent?.box) {
    // 範囲が決まるときだけ（仕様 §12）
    stats.total = countTiles(extent.box, extent.minZoom, extent.maxZoom);
    stats.percent = Math.floor(count * 100 / (stats.total || 1));
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
    warnings = await tableChanged(ctx);
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

  /** 保存の後: 照合表を作り直し、持ち主の Resource の影を warnings に足して SourceInfo を返す */
  const finish = async (store: Store, rec: SourceRecord): Promise<SourceInfo> => {
    const ids = (await resourcesOf(store, ownersOf(rec))).map((m) => m.id);
    return infoOf(store, await withShadows(store, rec, await refreshTable(ctx, ids)));
  };

  const register = (body: unknown) => serial(async () => {
    // 提供元の評価の順（利用者が先・標準の mapbox が後）で解決してから検査する（m3-t5・X8）
    const spec = normalizeSpec(body, ctx.providers());
    const store = await ctx.store();
    if (isNormalizedStyle(spec)) return finish(store, await registerStyle(ctx, spec, { mode: 'register', swOrigin: swOrigin() }));
    const r = await applyRegister(store, spec);
    return finish(store, r.source);
  });

  const update = (id: string) => serial(async () => {
    const store = await ctx.store();
    const rec = await getOwn(store, id);
    const credentials = await store.getCredentials(id);
    const style = styleSpecOf(rec);
    if (style) {
      // スタイルは取り直して芋づるを作り直す（下位資源の衝突で例外にしない。P2・R10）
      const before = (await resourcesOf(store, ownersOf(rec))).map((m) => m.id);
      const out = await registerStyle(ctx, credentials ? { spec: style, credentials } : { spec: style },
        { mode: 'update', swOrigin: swOrigin() });
      for (const rid of [...before, ...(await resourcesOf(store, ownersOf(out))).map((m) => m.id)]) ctx.corslessStreak.delete(rid);
      return finish(store, out);
    }
    // 保存した登録内容で合流と方針を作り直す（資格情報は credentials ストアのものを持ち越す）
    // 保存した登録内容は storedSpecOf で読む（m2 の記録は type が無く、生のまま渡すと型違いの衝突になる。L1 M1）
    const stored = storedSpecOf(rec);
    if (!stored) throw notFound(id);
    const spec: NormalizedSpec = credentials ? { spec: stored, credentials } : { spec: stored };
    const r = await applyUpdate(store, id, spec);
    // CORS の判定をやり直す（仕様 §4.5。corsOk・corslessUntil は registry が消す）
    for (const m of r.resources) ctx.corslessStreak.delete(m.id);
    return finish(store, r.source);
  });

  const clean = (id: string) => serial(async () => {
    const store = await ctx.store();
    const owners = ownersOf(await getOwn(store, id));
    // 範囲なしの clean（m2）。他の Source が参照する共有・範囲だけの Resource の Entry は残す（仕様 §5.6・§7.2）。
    // スタイルは子の Resource を、子の id の一覧で判定する
    const done: string[] = [];
    for (const owner of owners) {
      for (const m of await store.resourcesBySource(owner)) {
        if (done.indexOf(m.id) >= 0) continue;
        done.push(m.id);
        if (isExclusiveTo(m, owners)) await store.clearEntries(m.id);
      }
    }
    return null;
  });

  const remove = (id: string) => serial(async () => {
    const store = await ctx.store();
    const rec = await getOwn(store, id);
    const before = (await resourcesOf(store, ownersOf(rec))).map((m) => m.id);
    // スタイルは子を全部外してから親を消す（親の記録が残っていれば、途中で止まっても remove() をやり直せる）
    if (styleSpecOf(rec)) {
      for (const child of ownersOf(rec)) {
        try {
          await applyRemove(store, child);
        } catch (e) {
          if (!(e instanceof WeiwudiError && e.code === 'source-not-found')) throw e;
        }
      }
    }
    await applyRemove(store, id);
    for (const rid of before) {
      if (!(await store.getResource(rid))) ctx.corslessStreak.delete(rid);
    }
    await refreshTable(ctx, []);
    return null;
  });

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

  const run = async (op: string, body: unknown): Promise<unknown> => {
    switch (op) {
      case 'register': return register(body);
      case 'source': return source(idOf(body));
      case 'sources': return sources();
      case 'stats': return stats(idOf(body));
      case 'update': return update(idOf(body));
      case 'clean': return clean(idOf(body));
      case 'remove': return remove(idOf(body));
      default:
        throw new WeiwudiError('api-not-found', `Operation "${op}" not found`, { op });
    }
  };

  return {
    get: async ({ url }) => {
      if (url.pathname === `${V2_PREFIX}ping`) return json({ api: CONTROL_API, version: __WEIWUDI_VERSION__ });
      return new Response('Not Found', { status: 404 });
    },
    post: async ({ url, request }) => {
      try {
        const op = url.pathname.slice(V2_PREFIX.length);
        let body: unknown;
        try {
          const text = await request.text();
          body = text === '' ? {} : JSON.parse(text);
        } catch (_e) {
          throw new WeiwudiError('attribute-invalid', 'Request body must be a JSON text', { attribute: 'body' });
        }
        return success(await run(op, body));
      } catch (e) {
        return failure(e);
      }
    },
  };
}
