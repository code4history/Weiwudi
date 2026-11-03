/// <reference lib="webworker" />
// 制御（https://weiwudi.example.com/v2/*。仕様 §4.1・§5.6・§12。m2-t8）。ページ側の Weiwudi.register などの相手。
// 値の依存は hook・registry・spec・context・store・tile_math・errors だけ（仕様 §3 の許可は core も含む）。
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
import type { RouteHandlerCallbackOptions } from 'workbox-core';
import type { Context } from './context';
import { tableChanged } from './hook';
import { applyRegister, applyRemove, applyUpdate, isExclusiveTo } from './registry';
import { normalizeSpec, type NormalizedSpec, type StoredSpec } from './spec';
import { toResourceInfo, type ResourceMeta, type SourceRecord, type Store } from './store';
import { countTiles } from './tile_math';
import { WeiwudiError } from './errors';
import type { SourceInfo, SourceStats } from './weiwudi';

/** package.json の版（vite の define と vitest の define で埋める。第 1 回 S13） */
declare const __WEIWUDI_VERSION__: string;

/** /v2/ping の api の値（仕様 §4.1） */
export const CONTROL_API = 2;

const PREFIX = '/v2/';

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

const isLegacyRecord = (rec: SourceRecord): boolean => rec.kind === 'legacy' || rec.id.startsWith('map:');

/** 新 API の Source。無い・旧 API の記録なら source-not-found */
const getOwn = async (store: Store, id: string): Promise<SourceRecord> => {
  const rec = await store.getSource(id);
  if (!rec || isLegacyRecord(rec)) throw notFound(id);
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

/** その Source が参照する Resource（sourceIds のもの・範囲だけのもの。重ねない） */
const resourcesOf = async (store: Store, id: string): Promise<ResourceMeta[]> => {
  const own = await store.resourcesBySource(id);
  const rangeOnly = (await store.resourcesByRangeOnlySource(id)).filter((r) => !own.some((o) => o.id === r.id));
  return [...own, ...rangeOnly];
};

/** SourceInfo（仕様 §12）。resources は toResourceInfo(meta, now, その Source の id)（rangeOnly を出す。第 3 回 O7） */
const infoOf = async (store: Store, rec: SourceRecord): Promise<SourceInfo> => {
  const spec = rec.spec as StoredSpec;
  const now = Date.now();
  return {
    id: rec.id,
    kind: spec.kind,
    url: Array.isArray(spec.url) ? spec.url.slice() : spec.url,
    resources: (await resourcesOf(store, rec.id)).map((m) => toResourceInfo(m, now, rec.id)),
    warnings: rec.warnings.slice(),
  };
};

/** SourceStats（仕様 §12）。byResource は null プロトタイプ（id が __proto__ などでも壊れない。第 3 回 推奨） */
const statsOf = async (store: Store, rec: SourceRecord): Promise<SourceStats> => {
  const byResource: Record<string, { count: number; bytes: number }> = Object.create(null);
  let count = 0;
  let size = 0;
  for (const m of await resourcesOf(store, rec.id)) {
    byResource[m.id] = { count: m.count, bytes: m.bytes };
    count += m.count;
    size += m.bytes;
  }
  const stats: SourceStats = { count, size, byResource };
  const extent = (rec.spec as StoredSpec).extent;
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

/** 影の warnings を Source の warnings に足して保存する（source()・sources() でも同じ写しが見える） */
const withShadows = async (store: Store, rec: SourceRecord, shadows: readonly string[]): Promise<SourceRecord> => {
  const extra = shadows.filter((w) => rec.warnings.indexOf(w) < 0);
  if (extra.length === 0) return rec;
  const next: SourceRecord = { ...rec, warnings: [...rec.warnings, ...extra] };
  await store.putSource(next);
  return next;
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

  const register = (body: unknown) => serial(async () => {
    const spec = normalizeSpec(body);
    const store = await ctx.store();
    const r = await applyRegister(store, spec);
    const ids = (await resourcesOf(store, r.source.id)).map((m) => m.id);
    const rec = await withShadows(store, r.source, await refreshTable(ctx, ids));
    return infoOf(store, rec);
  });

  const update = (id: string) => serial(async () => {
    const store = await ctx.store();
    const rec = await getOwn(store, id);
    const credentials = await store.getCredentials(id);
    // 保存した登録内容で合流と方針を作り直す（資格情報は credentials ストアのものを持ち越す）
    const spec: NormalizedSpec = credentials ? { spec: rec.spec as StoredSpec, credentials } : { spec: rec.spec as StoredSpec };
    const r = await applyUpdate(store, id, spec);
    // CORS の判定をやり直す（仕様 §4.5。corsOk・corslessUntil は registry が消す）
    for (const m of r.resources) ctx.corslessStreak.delete(m.id);
    const ids = (await resourcesOf(store, id)).map((m) => m.id);
    return infoOf(store, await withShadows(store, r.source, await refreshTable(ctx, ids)));
  });

  const clean = (id: string) => serial(async () => {
    const store = await ctx.store();
    await getOwn(store, id);
    // 範囲なしの clean（m2）。他の Source が参照する共有・範囲だけの Resource の Entry は残す（仕様 §5.6・§7.2）
    for (const m of await store.resourcesBySource(id)) {
      if (isExclusiveTo(m, id)) await store.clearEntries(m.id);
    }
    return null;
  });

  const remove = (id: string) => serial(async () => {
    const store = await ctx.store();
    await getOwn(store, id);
    const before = (await resourcesOf(store, id)).map((m) => m.id);
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
    const recs = (await store.listSources()).filter((r) => !isLegacyRecord(r));
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
      if (url.pathname === `${PREFIX}ping`) return json({ api: CONTROL_API, version: __WEIWUDI_VERSION__ });
      return new Response('Not Found', { status: 404 });
    },
    post: async ({ url, request }) => {
      try {
        const op = url.pathname.slice(PREFIX.length);
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
