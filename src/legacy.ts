/// <reference lib="webworker" />
// 旧 API（https://weiwudi.example.com/api/*）の翻訳（仕様 §13）。現行の apiFunc の分岐と検査の順をそのまま移し、
// 保存と取得を store・core に置き換えた。キャッシュの処理（範囲外・鮮度・上流・保存・退避）は core.serve() だけが持つ。
// 値の依存は core・context・store・tile_math・errors だけ（仕様 §3。m4 で migrate）。
//
// 決まり:
// - Source と Resource の id はどちらも map:<mapID>（第 1 回 S6）。Source.legacy に現行の設定（query）をそのまま持つ
// - Entry のキーは map:<mapID>\0<tileKeySuffix>（R2・第 2 回 O12）。照合表には入れない
// - 上流は fetch(URL の文字列) の 1 引数。差し込み口が別の Request を返したときだけ fetch(その Request)（第 1 回 S8）
// - 差し込み口へは選んだミラーを展開した URL の Request を渡す（疑似ホストの URL を渡さない。第 2 回 S-5）
// - Range つきの要求は serve() に入れず、上流のタイルの URL へそのまま素通しする（仕様 §11）
// - fetchAll のジョブは開始の FetchEvent の waitUntil に渡す（R11・第 1 回 S11）。1 度に 1 ジョブ（context.job）
// - serve() の reject（store の読み出しの失敗。容量の判定の evictScopesFor を含む）は、包括の `Error: ${e}` の文にする。
//   現行の getImage の読み出し（設定と Entry）の失敗と同じ経路・同じ形（m2-t5 の Ruling）
import type { RouteHandlerCallbackOptions } from 'workbox-core';
import type { Context, JobState } from './context';
import { runJob, serve } from './core';
import type { MapSetting, ResourceMeta, Store, TileExtent } from './store';
import {
  lngLatBoundsToTileBox, countTiles, enumerateTiles, maxZoomForPixelSize, pixelSizeToTileBox,
  expandTileTemplate, tileKeySuffix, type TileBox,
} from './tile_math';
import { WeiwudiError, legacyMessage, type TileFailure } from './errors';

declare const self: ServiceWorkerGlobalScope;

interface DBCountResult {
  count: number;
  size: number;
  total?: number;
  percent?: number;
}

/** 既定の鮮度（24 時間。#2） */
const DEFAULT_TTL = 86400000;

const sourceIdOf = (mapID: unknown): string => `map:${mapID}`;
const keyOf = (id: string, z: number, x: number, y: number): string => `${id}\0${tileKeySuffix(z, x, y)}`;
const emptyFailures = (): Record<TileFailure, number> => ({ network: 0, upstream: 0, quota: 0, storage: 0 });
const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: new Headers({ 'content-type': 'application/json' }) });

/** 登録した地図の設定。無ければ undefined */
const getSetting = async (store: Store, mapID: unknown): Promise<MapSetting | undefined> => {
  const rec = await store.getSource(sourceIdOf(mapID));
  return rec && rec.kind === 'legacy' ? rec.legacy : undefined;
};

/** maxZoom での範囲（現行の範囲外の判定と fetchAll の列挙と同じ `|| 0` の既定） */
const boxOf = (s: MapSetting): TileBox => ({ minX: s.minX || 0, maxX: s.maxX || 0, minY: s.minY || 0, maxY: s.maxY || 0 });

/** MapSetting → Resource（仕様 §13。範囲外の方針は固定、cacheTtl は登録値か 24 時間、storable は常に真） */
const resourceOf = (s: MapSetting): ResourceMeta => {
  const id = sourceIdOf(s.mapID);
  // 現行の判定: z < (minZoom || 0) か z > (maxZoom ?? Infinity) がズームの外。範囲は maxZoom と 4 辺が揃うときだけ
  const extent: TileExtent = { minZoom: s.minZoom || 0, maxZoom: s.maxZoom ?? Infinity, sourceId: id };
  if (s.maxZoom !== undefined && s.minX !== undefined && s.maxX !== undefined && s.minY !== undefined && s.maxY !== undefined) {
    extent.box = boxOf(s);
  }
  const ttl = s.cacheTtl ?? DEFAULT_TTL;
  return {
    id,
    type: 'tile',
    templates: Array.isArray(s.url) ? s.url.slice() : typeof s.url === 'string' ? [s.url] : [],
    sourceIds: [id],
    extents: [extent],
    encoding: 'raster',
    policy: {
      // 現行は数でない cacheTtl（parseInt の NaN）で期限切れにならない
      cacheTtl: Number.isNaN(ttl) ? Infinity : ttl,
      store: true,
      outOfRange: { extent: 'transparent', zoom: 'not-found' },
      credentialParams: [],
    },
    count: 0,
    bytes: 0,
    pinnedBytes: 0,
  };
};

/** 地図を登録する（登録し直しでは Entry と数を引き継ぐ）。Resource を先に書き、Source で登録を見えるようにする */
const registerMap = async (store: Store, s: MapSetting, t: number): Promise<void> => {
  const id = sourceIdOf(s.mapID);
  const existing = await store.getSource(id);
  const meta = resourceOf(s);
  if (await store.getResource(id)) await store.replaceResource(meta);
  else await store.createResource(meta);
  const order = existing ? existing.order : (await store.listSources()).reduce((n, r) => Math.max(n, r.order), 0) + 1;
  await store.putSource({ id, kind: 'legacy', spec: {}, order, warnings: [], createdAt: existing?.createdAt ?? t, legacy: s });
};

/** 現行どおりミラーから無作為に 1 つ選んで展開する */
const tileUrl = (s: MapSetting, z: number, x: number, y: number): string => {
  let template = '';
  if (s.url instanceof Array) template = s.url[Math.floor(Math.random() * s.url.length)];
  else if (typeof s.url === 'string') template = s.url;
  return expandTileTemplate(template, z, x, y);
};

/** 差し込み口へ渡す要求。相対の URL は SW の場所で解決する（SW 内の fetch と同じ）。作れない URL は about:blank */
const requestOf = (url: string, init?: RequestInit): Request => {
  try {
    return new Request(new URL(url, self.location.href).href, init);
  } catch (_e) {
    return new Request('about:blank', init);
  }
};

/** 1 枚のタイルを serve() で返す */
const serveTile = (ctx: Context, s: MapSetting, z: number, x: number, y: number): Promise<Response> => {
  const id = sourceIdOf(s.mapID);
  const url = tileUrl(s, z, x, y);
  return serve(ctx, {
    resourceId: id,
    key: keyOf(id, z, x, y),
    coord: { z, x, y },
    request: requestOf(url),
    storable: true,
    upstream: async (request, { requestChanged }) =>
      ({ kind: 'response', response: await (requestChanged ? fetch(request) : fetch(url)) }),
  }, () => Date.now());
};

/** Range つきの要求の素通し（serve に入れない。保存しない）。ネットワーク失敗は 404 */
const passRange = async (s: MapSetting, z: number, x: number, y: number, range: string): Promise<Response> => {
  try {
    return await fetch(requestOf(tileUrl(s, z, x, y), { headers: { range } }));
  } catch (_e) {
    return new Response(null, { status: 404, statusText: 'Not Found' });
  }
};

const getImage = async (ctx: Context, mapID: string, z: number, x: number, y: number, range: string | null) => {
  const store = await ctx.store();
  const setting = await getSetting(store, mapID);
  if (!setting) return legacyMessage('map-not-found', { mapID });
  if (range !== null) return passRange(setting, z, x, y, range);
  return serveTile(ctx, setting, z, x, y);
};

/** 現行の fetchAll（5 枚ずつ・各バッチの前に生存確認と cancel）。有るタイルは飛ばし、取得した本体は読み切る */
const fetchAll = async (ctx: Context, job: JobState, client: Client, setting: MapSetting): Promise<void> => {
  const { mapID, totalTile } = setting;
  const id = sourceIdOf(mapID);
  let processed = 0;
  const release = () => {
    if (ctx.job === job) ctx.job = undefined;
  };
  try {
    const store = await ctx.store();
    const result = await runJob({
      tasks: enumerateTiles(boxOf(setting), setting.minZoom || 0, setting.maxZoom || 0),
      isAlive: async () => !!(await self.clients.get(client.id)),
      isCanceled: () => job.cancel,
      run: async ([z, x, y]) => {
        const [has] = await store.hasEntries([keyOf(id, z, x, y)]);
        if (has) return;
        const res = await serveTile(ctx, setting, z, x, y);
        const failure = res.headers.get('x-weiwudi-error') as TileFailure | null;
        if (failure !== null && failure in job.failures) {
          job.error++;
          job.failures[failure]++;
        }
        await res.arrayBuffer(); // noOutput: 配信しない本体も読み切る（t4 の申し送り）
      },
      onBatch: (n) => {
        processed = n;
        job.count = n;
        const percent = Math.floor(processed * 100 / (totalTile || 1));
        client.postMessage({
          type: 'proceed',
          message: `Proceeding the tile fetching: ${mapID} ${percent}% (${processed} / ${totalTile})`,
          percent,
          processed,
          error: job.error,
          errors: { ...job.failures },
          total: totalTile,
          mapID,
        });
      },
    });
    release();
    if (result === 'canceled') {
      client.postMessage({ type: 'canceled', message: `Fetching tile of ${mapID} is canceled`, mapID });
    } else if (result === 'finished') {
      const { error } = job;
      client.postMessage({
        type: 'finish',
        message: `Fetched all tiles of ${mapID}${error ? ` with ${error} error cases` : ''}`,
        total: totalTile,
        mapID,
        error,
        errors: { ...job.failures },
      });
    }
  } catch (e) {
    release();
    client.postMessage({
      type: 'stop',
      message: `Fetching stopped: ${mapID} ${processed} / ${totalTile}`,
      reason: e,
      code: WeiwudiError.from(e).code,
      processed,
      total: totalTile,
      mapID,
    });
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Query = any;

const apiFunc = async (
  ctx: Context, apiName: string, query: Query, restPath: string | undefined,
  request: Request | undefined, event: FetchEvent | undefined, client?: Client,
) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let retVal: any;
  const checkAttributes = (q: Query, targets: string[]) => {
    return targets.reduce((prev: string | undefined, target) => {
      if (prev) return prev;
      if (q[target] === undefined) return legacyMessage('attribute-missing', { target });
      return prev;
    }, undefined);
  };
  const busy = () => ctx.job !== undefined && ctx.job.sourceId === sourceIdOf(query.mapID);
  try {
    switch (apiName) {
      case 'ping':
        retVal = 'Implemented';
        break;
      case 'info':
        retVal = checkAttributes(query, ['mapID']);
        if (!retVal) {
          const setting = await getSetting(await ctx.store(), query.mapID);
          if (!setting) retVal = legacyMessage('map-not-found', { mapID: query.mapID });
          else retVal = json(setting);
        }
        break;
      case 'add': {
        const store = await ctx.store();
        retVal = checkAttributes(query, ['mapID', 'type', 'url']);
        if (!retVal) {
          query.tileSize = parseInt(query.tileSize || 256);
          if (query.cacheTtl !== undefined) query.cacheTtl = parseInt(query.cacheTtl);
          // cacheMaxBytes は有限の 0 以上整数のみ受け付け、無効値は設定を保存しない (#29)
          if (query.cacheMaxBytes !== undefined) {
            const raw = String(query.cacheMaxBytes).trim();
            const parsed = parseInt(raw);
            if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== raw) {
              retVal = legacyMessage('attribute-invalid');
            } else {
              query.cacheMaxBytes = parsed;
            }
          }
          switch (query.type) {
            case 'xyz':
              if (!retVal) retVal = checkAttributes(query, ['width', 'height']); // cacheMaxBytes の誤りを上書きしない（wmts と同じ守り・#44）
              if (!retVal) {
                query.width = parseInt(query.width);
                query.height = parseInt(query.height);
                query.maxZoom = maxZoomForPixelSize(query.width, query.height, query.tileSize);
                query.minZoom = query.minZoom ? parseInt(query.minZoom) : 0;
                const box = pixelSizeToTileBox(query.width, query.height, query.tileSize);
                query.minX = box.minX;
                query.minY = box.minY;
                query.maxX = box.maxX;
                query.maxY = box.maxY;
              }
              break;
            case 'wmts':
              if (!retVal) {
                if (query.maxZoom) query.maxZoom = parseInt(query.maxZoom);
                if (query.minZoom) query.minZoom = parseInt(query.minZoom);
                if (query.maxLng && query.minLng && query.maxLat && query.minLat) {
                  query.maxLng = parseFloat(query.maxLng);
                  query.minLng = parseFloat(query.minLng);
                  query.maxLat = parseFloat(query.maxLat);
                  query.minLat = parseFloat(query.minLat);
                  const box = lngLatBoundsToTileBox(query, query.maxZoom);
                  query.minX = box.minX;
                  query.maxX = box.maxX;
                  query.minY = box.minY;
                  query.maxY = box.maxY;
                }
              }
              break;
            default:
              retVal = legacyMessage('unknown-type');
          }
        }
        if (!retVal) {
          if (!checkAttributes(query, ['maxX', 'minX', 'maxY', 'minY', 'minZoom', 'maxZoom'])) {
            query.totalTile = countTiles(query, query.minZoom, query.maxZoom);
          }
          await registerMap(store, query, Date.now());
          retVal = json(query);
        }
        break;
      }
      case 'clean':
        retVal = checkAttributes(query, ['mapID']);
        if (busy()) {
          retVal = legacyMessage('map-busy', { mapID: query.mapID });
        } else if (!retVal) {
          const store = await ctx.store();
          // 未登録の地図は stats と同じ文面（仕様 §9 の既知の変化）
          if (!(await getSetting(store, query.mapID))) {
            retVal = legacyMessage('map-not-found', { mapID: query.mapID });
          } else {
            await store.clearEntries(sourceIdOf(query.mapID));
            retVal = `Cleaned: ${query.mapID}`;
          }
        }
        break;
      case 'delete':
        retVal = checkAttributes(query, ['mapID']);
        if (busy()) {
          retVal = legacyMessage('map-busy', { mapID: query.mapID });
        } else if (!retVal) {
          const store = await ctx.store();
          await store.deleteResource(sourceIdOf(query.mapID));
          await store.deleteSource(sourceIdOf(query.mapID));
          retVal = `Deleted: ${query.mapID}`;
        }
        break;
      case 'cancel':
        retVal = checkAttributes(query, ['mapID']);
        if (ctx.job && busy()) {
          ctx.job.cancel = true;
          retVal = `Fetching process of ${ctx.job.label} is canceled`;
        } else {
          retVal = legacyMessage('no-fetch-process', { mapID: query.mapID });
        }
        break;
      case 'stats':
        retVal = checkAttributes(query, ['mapID']);
        if (!retVal) {
          const store = await ctx.store();
          const setting = await getSetting(store, query.mapID);
          if (!setting) retVal = legacyMessage('map-not-found', { mapID: query.mapID });
          else {
            const resource = await store.getResource(sourceIdOf(query.mapID));
            const ret: DBCountResult = { count: resource?.count ?? 0, size: resource?.bytes ?? 0 };
            if (setting.totalTile) {
              ret.total = setting.totalTile;
              ret.percent = Math.floor(ret.count / ret.total * 100);
            }
            retVal = json(ret);
          }
        }
        break;
      case 'cache': {
        const matched = restPath?.match(/^([^/]+)\/(\d+)\/(\d+)\/(\d+)$/);
        if (matched) {
          retVal = await getImage(ctx, matched[1], parseInt(matched[2]), parseInt(matched[3]), parseInt(matched[4]),
            request ? request.headers.get('range') : null);
        } else {
          retVal = legacyMessage('cache-path-invalid');
        }
        break;
      }
      case 'fetchAll':
        retVal = checkAttributes(query, ['mapID']);
        if (!retVal && client && event) {
          const setting = await getSetting(await ctx.store(), query.mapID);
          if (!setting) retVal = legacyMessage('map-not-found', { mapID: query.mapID });
          else if (!setting.totalTile) retVal = legacyMessage('cannot-fetch-all', { mapID: query.mapID });
          else if (ctx.job) {
            retVal = legacyMessage('fetch-busy', { mapID: ctx.job.label, count: ctx.job.count, total: ctx.job.total });
          } else {
            const job: JobState = {
              sourceId: sourceIdOf(query.mapID),
              label: String(query.mapID),
              total: setting.totalTile || 0,
              count: 0,
              error: 0,
              failures: emptyFailures(),
              cancel: false,
            };
            ctx.job = job;
            // 応答を先に返し、ジョブは開始の FetchEvent に結び付ける（SW が止まっても黙って消えない。仕様 §7.2）
            event.waitUntil(fetchAll(ctx, job, client, setting));
            retVal = `Fetching task start: ${query.mapID}`;
          }
        }
        break;
      default:
        retVal = legacyMessage('api-not-found', { apiName });
    }
  } catch (e) {
    retVal = `Error: ${e}`;
  }

  if (retVal) return retVal;
};

/** 疑似ホストの GET のハンドラ（/v2/ を除く。振り分けは weiwudi_gw_logic.ts） */
export const handleLegacy = async (ctx: Context, { url, request, event }: RouteHandlerCallbackOptions): Promise<Response> => {
  const fetchEvent = typeof FetchEvent !== 'undefined' && event instanceof FetchEvent ? event : undefined;
  const client = fetchEvent && fetchEvent.clientId ? await self.clients.get(fetchEvent.clientId) : undefined;
  const matched = url.pathname.match(/^\/api\/([\w\d]+)(?:\/(.+))?$/);
  if (matched) {
    const query = [...url.searchParams.entries()].reduce((obj: Query, e) => {
      const values = url.searchParams.getAll(e[0]);
      if (values.length === 1) obj[e[0]] = values[0];
      else obj[e[0]] = values;
      return obj;
    }, {});
    let res = await apiFunc(ctx, matched[1], query, matched[2], request, fetchEvent, client);
    if (res) {
      if (!(res instanceof Response)) res = new Response(res);
      return res;
    }
  }
  return new Response('Not Found', { status: 404 });
};
