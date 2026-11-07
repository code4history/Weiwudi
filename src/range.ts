/// <reference lib="webworker" />
// 範囲取得（仕様 §7.2・§4.5-3・§4.6・m4-t3。R1）。control.ts の op（estimate・fetchRange・regions・cancel・job/resume）が呼ぶ。
// 値の依存は hook・core・upstream・registry・context・store・spec・url_pattern・tile_math・style_body・constants・errors だけ（仕様 §3）。
// 持ち主の一覧（ownerIdsOf。スタイルは子の id）は control が作って渡す（style を import しない。R1）。
//
// 決まり:
// - 取得は hook.serveResource だけ（core.serve 1 つ。fetch を直接呼ばない）。no-cors の確かめは upstream.probeNoCors（R4）
// - URL は url_pattern.expandTemplate で作り、同じテンプレートに matchUrl で照合してキーを entryKey で作る（R2）
// - 資格情報は hook.credentialsForResource（照合ルートと同じ選び方。R3）。要求は new Request(url)（cors・same-origin）
// - 固定はバッチの後の store.setPinned 1 本（成功と数えたキー全部・region が有るときだけ。R46・PR #102 M2）。
//   保存と同じ tx で固定する近道（ServeInput.pin）は使わない（途中で region が消えたとき、どの region にも属さない固定を残す）
// - region の終わりの書き込みは patchRegion で「有り・running」のときだけ（R5）。終わりの順は region → ctx.job → postMessage（R45）
// - ジョブは各バッチの前に Source と region の有無を見る（Source が無ければ stop（source-not-found）・region が無ければ canceled。
//   R13・R57）。バッチの後の setPinned の前にも region を見る
// - スタイルの非タイル資源（m4-t4・§7.2・§11）: 型の順に style → tilejson・data → sprite（{spriteSuffix} の 4 値）→ tile → glyph。
//   style は先に別の runJob で取り（hit でよい）、本体から（style_body.collectFonts） fontstack を集めてから glyph の単位を作る。
//   glyph は 1 fontstack を 1 単位にし、範囲を順に取って core.createGlyphCollector で 1 回に書く（finally で flush。L4・R-G）。
//   固定はグリフも onBatch の pinKeys() だけ（flush の後にキーを足す）。total・percent はタイルだけ（R29）
import type { Context, JobState, OpaqueNotice } from './context';
import { createGlyphCollector, evictScopesFor, runJob, sweepOnce, type GlyphCollector } from './core';
import { credentialsForResource, serveResource } from './hook';
import { probeNoCors } from './upstream';
import {
  isChildRecord, storedSpecOf, styleSpecOf, templatesOf, type Credentials, type RegionRecord, type ResourceMeta, type ResourceType,
  type SourceRecord, type Store,
} from './store';
import {
  copyRange, normalizeFetchOptions, normalizeRange, type NormalizedFetchOptions, type NormalizedRange, type RangeSource, type RegionInfo,
  type RegionStatus,
} from './spec';
import { compileTemplate, entryKey, expandTemplate, matchUrl, type CompiledTemplate, type MatchResult } from './url_pattern';
import { scaleTileBox } from './tile_math';
import { collectFonts, parseStyle } from './style_body';
import { WeiwudiError, type TileFailure } from './errors';
import { LEGACY_PREFIX } from './constants';

declare const self: ServiceWorkerGlobalScope;

/** 固定の書き込み（setPinned）の 1 回の件数（R46） */
const PIN_CHUNK = 200;
/** 止める連続数（§4.5-3 の jobOpaqueStreak・§4.6 の 401・403・quota） */
const STREAK_LIMIT = 3;
/** opaque の連続の後に cors で確かめる枚数（§4.5-3） */
const PROBE_TILES = 5;

const emptyErrors = (): Record<TileFailure, number> => ({ network: 0, upstream: 0, quota: 0, storage: 0 });

const isFailure = (v: string | null): v is TileFailure => v === 'network' || v === 'upstream' || v === 'quota' || v === 'storage';

// ---- 列挙（R-tms・第 1 回 L） ----

interface Rect { minX: number; maxX: number; minY: number; maxY: number }
/** x の区間 [minX, maxX] で y の区間の和が同じ列 */
interface Segment { minX: number; maxX: number; ys: [number, number][]; perColumn: number }

/**
 * z での「範囲 ∩ Resource の範囲」の矩形（Resource の scheme の座標）。範囲（XYZ）を Resource の scheme に直してから
 * extents（Resource の scheme の座標。F32）と交差させる。extents が無ければ全域
 */
const rectsAt = (resource: ResourceMeta, normalized: NormalizedRange, z: number): Rect[] => {
  const last = Math.pow(2, z) - 1;
  const full: Rect = { minX: 0, maxX: last, minY: 0, maxY: last };
  const extents = resource.extents && resource.extents.length > 0
    ? resource.extents.filter((e) => z >= e.minZoom && z <= e.maxZoom).map((e) => (e.box ? scaleTileBox(e.box, e.maxZoom, z) : full))
    : [full];
  const out: Rect[] = [];
  for (const box of normalized.boxes) {
    const b = scaleTileBox(box, normalized.maxZoom, z);
    const r = resource.scheme === 'tms' ? { minX: b.minX, maxX: b.maxX, minY: last - b.maxY, maxY: last - b.minY } : b;
    for (const e of extents) {
      const i = {
        minX: Math.max(r.minX, e.minX, 0), maxX: Math.min(r.maxX, e.maxX, last),
        minY: Math.max(r.minY, e.minY, 0), maxY: Math.min(r.maxY, e.maxY, last),
      };
      if (i.minX <= i.maxX && i.minY <= i.maxY) out.push(i);
    }
  }
  return out;
};

/** 矩形の和を、y の区間の和が同じ x の列に分ける（重なりを数えない） */
const segmentsOf = (rects: readonly Rect[]): Segment[] => {
  const cuts = [...new Set(rects.flatMap((r) => [r.minX, r.maxX + 1]))].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const minX = cuts[i];
    const maxX = cuts[i + 1] - 1;
    const ys = rects.filter((r) => r.minX <= minX && minX <= r.maxX).map((r): [number, number] => [r.minY, r.maxY])
      .sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [lo, hi] of ys) {
      const top = merged[merged.length - 1];
      if (top && lo <= top[1] + 1) top[1] = Math.max(top[1], hi);
      else merged.push([lo, hi]);
    }
    if (merged.length === 0) continue;
    out.push({ minX, maxX, ys: merged, perColumn: merged.reduce((n, [lo, hi]) => n + hi - lo + 1, 0) });
  }
  return out;
};

const countAt = (segments: readonly Segment[]): number => segments.reduce((n, s) => n + (s.maxX - s.minX + 1) * s.perColumn, 0);

/**
 * 範囲と Resource の範囲の交差のタイル（z 昇順 → x 昇順 → y 昇順。重ならない）。y は Resource の scheme の座標で、
 * そのまま expandTemplate に渡す（{-y} は expandTileTemplate が y から作る。2 回反転しない。R-tms）。配列を作らない
 */
export function* enumerate(resource: ResourceMeta, normalized: NormalizedRange): Generator<[z: number, x: number, y: number]> {
  for (let z = normalized.minZoom; z <= normalized.maxZoom; z++) {
    for (const s of segmentsOf(rectsAt(resource, normalized, z))) {
      for (let x = s.minX; x <= s.maxX; x++) {
        for (const [lo, hi] of s.ys) for (let y = lo; y <= hi; y++) yield [z, x, y];
      }
    }
  }
}

/** タイルの枚数（enumerate と同じ数え方） */
export const countRange = (resource: ResourceMeta, normalized: NormalizedRange): number => {
  let n = 0;
  for (let z = normalized.minZoom; z <= normalized.maxZoom; z++) n += countAt(segmentsOf(rectsAt(resource, normalized, z)));
  return n;
};

/** enumerate と同じ順の n 番目のタイル（z ごとの枚数を引いていく。生成器を n 回回さない）。無ければ undefined */
export function tileAt(resource: ResourceMeta, normalized: NormalizedRange, n: number): [number, number, number] | undefined {
  if (!(n >= 0) || !Number.isInteger(n)) return undefined;
  let rest = n;
  for (let z = normalized.minZoom; z <= normalized.maxZoom; z++) {
    for (const s of segmentsOf(rectsAt(resource, normalized, z))) {
      const size = (s.maxX - s.minX + 1) * s.perColumn;
      if (rest >= size) {
        rest -= size;
        continue;
      }
      const x = s.minX + Math.floor(rest / s.perColumn);
      let r = rest % s.perColumn;
      for (const [lo, hi] of s.ys) {
        if (r <= hi - lo) return [z, x, lo + r];
        r -= hi - lo + 1;
      }
    }
  }
  return undefined;
}

// ---- Source の資源と範囲 ----

const notFound = (id: string): WeiwudiError => new WeiwudiError('source-not-found', `Source "${id}" not found`, { sourceId: id });

const invalidRegion = (): WeiwudiError =>
  new WeiwudiError('attribute-invalid', 'Attribute "regionId" does not name a region of the source', { attribute: 'regionId' });

/**
 * 持ち主の一覧の Resource（sourceIds・rangeOnlySourceIds。重ねない・登録の順）。タイルは extents をその持ち主の分に絞った写し
 * （共有の Resource の他の Source の範囲は取らない。計画「Resource の extents（Source の分）」）
 */
const resourcesOf = async (store: Store, owners: readonly string[]): Promise<ResourceMeta[]> => {
  const own: string[] = [];
  for (const id of owners) {
    const rec = await store.getSource(id);
    if (rec) own.push(...templatesOf(rec));
  }
  const out: ResourceMeta[] = [];
  for (const id of owners) {
    for (const r of [...await store.resourcesBySource(id), ...await store.resourcesByRangeOnlySource(id)]) {
      if (out.some((o) => o.id === r.id)) continue;
      // ミラーは持ち主が登録したテンプレートから選ぶ（共有の Resource の他の Source のミラーへ出さない。R-t3-6）。無ければ全部
      const mine = r.templates.filter((t) => own.indexOf(t) >= 0);
      const view: ResourceMeta = { ...r, templates: mine.length > 0 ? mine : r.templates.slice() };
      if (r.type === 'tile' && r.extents) view.extents = r.extents.filter((e) => owners.indexOf(e.sourceId) >= 0);
      out.push(view);
    }
  }
  return out;
};

/** 範囲の Source の側。スタイルは子の tile の範囲を並べる（'all' の和。R-t3-2）。box は xyz として読む */
const rangeSourceOf = async (store: Store, rec: SourceRecord, owners: readonly string[]): Promise<RangeSource> => {
  if (!styleSpecOf(rec)) {
    const spec = storedSpecOf(rec);
    return { extent: spec?.extent, scheme: spec?.scheme };
  }
  const all: { extent?: RangeSource['extent']; scheme?: 'xyz' | 'tms' }[] = [];
  for (const id of owners) {
    const child = await store.getSource(id);
    const spec = child ? storedSpecOf(child) : undefined;
    if (spec?.type === 'tile') all.push({ extent: spec.extent, scheme: spec.scheme });
  }
  return { scheme: 'xyz', all };
};

const isAsset = (rec: SourceRecord): boolean => rec.kind === 'asset';

/** 取得の計画（検査済みの範囲と、取る資源） */
interface RangePlan {
  range: RegionInfo['range'];
  normalized: NormalizedRange;
  options: NormalizedFetchOptions;
  /** 取る Resource（タイルと非タイル。asset は非タイルだけ）。total はタイルだけで数える */
  resources: ResourceMeta[];
  total: number;
}

/** asset の region の範囲（タイルを持たない。モジュール変数を置かないので関数で作る） */
const assetRange = (): NormalizedRange => ({ kind: 'boxes', boxes: [], minZoom: 0, maxZoom: 0 });

const planOf = async (
  store: Store, rec: SourceRecord, owners: readonly string[], range: unknown, normalized?: NormalizedRange,
): Promise<Omit<RangePlan, 'options'>> => {
  const copy = copyRange(range);
  const resources = await resourcesOf(store, owners);
  if (isAsset(rec)) {
    // asset は 'all' だけ（R52）
    if (copy !== 'all') {
      throw new WeiwudiError('attribute-invalid', 'Attribute "range" must be "all" for an asset source', { attribute: 'range' });
    }
    return { range: copy, normalized: assetRange(), resources: resources.filter((r) => r.type !== 'tile'), total: 0 };
  }
  const n = normalized ?? normalizeRange(copy, await rangeSourceOf(store, rec, owners));
  // スタイルの非タイル資源も取る（m4-t4）。枚数はタイルだけ（§7.2・R29）
  const tiles = resources.filter((r) => r.type === 'tile');
  return { range: copy, normalized: n, resources, total: tiles.reduce((t, r) => t + countRange(r, n), 0) };
};

/** estimate（§7.2・R29）。タイルの枚数だけ（同じ Resource は 1 回）。asset は 0（R52） */
export async function estimate(store: Store, rec: SourceRecord, range: unknown, owners: readonly string[]): Promise<{ tiles: number }> {
  return { tiles: (await planOf(store, rec, owners, range)).total };
}

// ---- region ----

const regionIdOf = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (_e) {
    // 下の形にする
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

/**
 * 公開の形（R5）。running で ctx.job が無いか ctx.job.regionId が違う（SW が止まった・別の region のジョブ）ものは partial と見せる
 * （記録は書き換えない）。内部の項目（normalized・options）は出さない
 */
export const regionInfoOf = (ctx: Context, r: RegionRecord): RegionInfo => {
  const status: RegionStatus = r.status === 'running' && ctx.job?.regionId !== r.id ? 'partial' : r.status;
  const info: RegionInfo = {
    id: r.id, sourceId: r.sourceId, range: r.range, status, pinned: r.pinned, total: r.total,
    error: r.error, errors: { ...emptyErrors(), ...r.errors }, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
  if (r.code !== undefined) info.code = r.code;
  return info;
};

/** regions()（§12） */
export async function listRegionInfos(ctx: Context, store: Store, sourceId: string): Promise<RegionInfo[]> {
  return (await store.listRegions(sourceId)).map((r) => regionInfoOf(ctx, r));
}

const busy = (job: JobState): WeiwudiError => new WeiwudiError('fetch-busy',
  `Another fetching process is running: "${job.label}" (${job.count} / ${job.total})`,
  { sourceId: job.sourceId, ...(job.regionId !== undefined ? { regionId: job.regionId } : {}) });

/** ctx.job を同期に確保する（await を挟まない。旧 API の fetchAll と同じ。R23）。あれば fetch-busy */
const claim = (ctx: Context, rec: SourceRecord, region: RegionRecord): JobState => {
  if (ctx.job) throw busy(ctx.job);
  const job: JobState = {
    sourceId: rec.id, label: rec.id, total: region.total, count: 0, error: 0, failures: emptyErrors(), cancel: false, regionId: region.id,
  };
  ctx.job = job;
  return job;
};

/** ジョブの client（開始の POST の event.clientId。I5c・R21） */
export interface JobClient {
  id: string;
  postMessage(message: unknown): void;
}

/**
 * fetchRange（§7.2）。直列の中で呼ぶ（control）。範囲と指定を検査し、同期に ctx.job を確保してから region を書く
 * （書き込みが失敗したら外して投げる。R23）。ジョブの Promise は呼び出し側が event.waitUntil に結び付ける
 */
export async function startFetchRange(
  ctx: Context, store: Store, rec: SourceRecord, owners: readonly string[], client: JobClient, range: unknown, options: unknown,
): Promise<{ info: RegionInfo; job: Promise<void> }> {
  const opts = normalizeFetchOptions(options);
  const plan = { ...await planOf(store, rec, owners, range), options: opts };
  const t = Date.now();
  const region: RegionRecord = {
    id: regionIdOf(), sourceId: rec.id, range: plan.range, status: 'running', pinned: opts.pin, total: plan.total,
    error: 0, errors: emptyErrors(), createdAt: t, updatedAt: t, normalized: plan.normalized, options: opts,
  };
  const job = claim(ctx, rec, region);
  try {
    await store.putRegion(region);
  } catch (e) {
    if (ctx.job === job) ctx.job = undefined;
    throw e;
  }
  return { info: regionInfoOf(ctx, region), job: runRangeJob(ctx, store, rec, region, plan, job, client) };
}

/**
 * job/resume の今の状態（直列の外。§7.2・R45）。region が無い・他の Source なら attribute-invalid。
 * 同じ region のジョブ中なら running の RegionInfo、別の region のジョブ中なら fetch-busy、終わりの status ならその RegionInfo。
 * ジョブを作り直す要るとき（ctx.job が無く running）は undefined（呼び出し側が直列の中で resumeRange を呼ぶ）
 */
export async function resumeState(ctx: Context, store: Store, sourceId: string, regionId: string): Promise<RegionInfo | undefined> {
  const region = await store.getRegion(regionId);
  if (!region || region.sourceId !== sourceId) throw invalidRegion();
  if (ctx.job) {
    if (ctx.job.regionId === regionId) return regionInfoOf(ctx, region);
    throw busy(ctx.job);
  }
  return region.status === 'running' ? undefined : regionInfoOf(ctx, region);
}

/**
 * job/resume のジョブを作り直す分岐（直列の中。R57・第 2 回 M3）。region を読み直し、まだ running なら保存した
 * normalized・options から fetchRange と同じ手順（同期に確保）でジョブを始める。既に有るタイルは飛ぶので再実行が再開
 */
export async function resumeRange(
  ctx: Context, store: Store, rec: SourceRecord, owners: readonly string[], client: JobClient, regionId: string,
): Promise<{ info: RegionInfo; job?: Promise<void> }> {
  const state = await resumeState(ctx, store, rec.id, regionId);
  if (state) return { info: state };
  const region = await store.getRegion(regionId);
  if (!region || region.sourceId !== rec.id) throw invalidRegion();
  const plan = { ...await planOf(store, rec, owners, region.range, region.normalized), options: region.options };
  // 計画の読み出しの間に別の op が消した・終えたなら始めない。読み直しの後は await を挟まずに確保する（R23）
  const again = await store.getRegion(regionId);
  if (!again || again.sourceId !== rec.id) throw invalidRegion();
  if (again.status !== 'running') return { info: regionInfoOf(ctx, again) };
  if (ctx.job?.regionId === regionId) return { info: regionInfoOf(ctx, again) };
  const job = claim(ctx, rec, again);
  return { info: regionInfoOf(ctx, again), job: runRangeJob(ctx, store, rec, again, plan, job, client) };
}

/** cancel()（§7.2・R23・R58）。自分の Source のジョブだけ止める。取り消したジョブの regionId を返す（旧 API のジョブなら null） */
export function cancelRange(ctx: Context, sourceId: string): { regionId: string | null } {
  const job = ctx.job;
  if (!job || job.sourceId !== sourceId) {
    throw new WeiwudiError('no-fetch-process', `There are no fetching process of "${sourceId}"`, { sourceId });
  }
  job.cancel = true;
  return { regionId: job.regionId ?? null };
}

// ---- opaque イベント（P2・I5d・R20） ----

/**
 * ctx.notify の配線。子 Source は親に読み替え（旧 API の記録は除く）、全 window の client に
 * { type: 'opaque', sourceId, resourceId } を送る。送れなくても何もしない（配信を止めない）
 */
export const createNotifier = (ctx: Context) => (m: OpaqueNotice): void => {
  void (async () => {
    const store = await ctx.store();
    const ids: string[] = [];
    for (const id of m.sourceIds) {
      const rec = await store.getSource(id);
      if (!rec) continue;
      const owner = isChildRecord(rec) ? rec.parentId : rec.id;
      if (owner === undefined || owner.startsWith(LEGACY_PREFIX) || ids.indexOf(owner) >= 0) continue;
      ids.push(owner);
    }
    if (ids.length === 0) return;
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) {
      for (const sourceId of ids) c.postMessage({ type: 'opaque', sourceId, resourceId: m.resourceId });
    }
  })().catch(() => undefined);
};

// ---- ジョブ（§7.2・§4.5-3・§4.6） ----

/** 1 単位。tile はタイル、spriteSuffix はスプライトの 4 値の 1 つ、fontstack はグリフ（範囲は単位の中で回す） */
type Unit = { resource: ResourceMeta; tile?: [number, number, number]; spriteSuffix?: string; fontstack?: string };

/** 型の順（§7.2・m4-t4）。style は別の段で先に取る */
const typeRank = (t: ResourceType): number =>
  t === 'style' ? 0 : t === 'tilejson' ? 1 : t === 'data' ? 2 : t === 'sprite' ? 3 : t === 'tile' ? 4 : 5;

/** スプライトの {spriteSuffix} の 4 値 */
const spriteSuffixes = (): string[] => ['.json', '.png', '@2x.json', '@2x.png'];

/** glyphRanges の範囲（R32）。'common' は 5 つ、'all' は 0-255 から 65280-65535 の 256 個、配列はそのまま（重複も残す） */
export const glyphRangesOf = (g: NormalizedFetchOptions['glyphRanges']): string[] => {
  if (g === 'common') return ['0-255', '256-511', '8192-8447', '12288-12543', '65280-65535'];
  if (g === 'all') return Array.from({ length: 256 }, (_v, i) => `${i * 256}-${i * 256 + 255}`);
  return g.slice();
};

/**
 * 段の単位（phase 'style' はスタイルの Resource だけ、'rest' はそれ以外を型の順に）。fontstacks はグリフの単位を作る時に読む
 * （style の段の後なので、スタイルの本体から集めた分が入っている）
 */
function* unitsOf(plan: RangePlan, phase: 'style' | 'rest', fontstacks: () => readonly string[]): Generator<Unit> {
  const list = plan.resources.filter((r) => (phase === 'style') === (r.type === 'style'))
    .map((r, i) => ({ r, i })).sort((a, b) => typeRank(a.r.type) - typeRank(b.r.type) || a.i - b.i).map(({ r }) => r);
  for (const resource of list) {
    if (resource.type === 'tile') {
      for (const tile of enumerate(resource, plan.normalized)) yield { resource, tile };
    } else if (resource.type === 'sprite') {
      for (const spriteSuffix of spriteSuffixes()) yield { resource, spriteSuffix };
    } else if (resource.type === 'glyph') {
      for (const fontstack of fontstacks()) yield { resource, fontstack };
    } else {
      yield { resource };
    }
  }
}

const experienced = (m: ResourceMeta | undefined): boolean => !!m && (m.count > 0 || m.corsOk === true);

/** ジョブの中で 1 単位の URL と照合の結果を作る（R2）。ミラーは無作為に 1 つ（§4.5 末尾） */
const target = (
  compiled: Map<string, CompiledTemplate>, unit: Unit, ratio: string, range?: string,
): { url: URL; m: MatchResult; key: string } | undefined => {
  const { resource, tile } = unit;
  const template = resource.templates[Math.floor(Math.random() * resource.templates.length)] ?? resource.templates[0];
  if (template === undefined) return undefined;
  let c = compiled.get(template);
  if (!c) {
    try {
      c = compileTemplate(template);
    } catch (_e) {
      return undefined;
    }
    compiled.set(template, c);
  }
  try {
    const url = new URL(expandTemplate(template, {
      ...(tile ? { z: tile[0], x: tile[1], y: tile[2] } : {}), ratio,
      ...(unit.spriteSuffix !== undefined ? { spriteSuffix: unit.spriteSuffix } : {}),
      ...(unit.fontstack !== undefined ? { fontstack: unit.fontstack } : {}),
      ...(range !== undefined ? { range } : {}),
    }));
    const m = matchUrl(c, url);
    if (!m) return undefined;
    return { url, m, key: entryKey(resource.id, resource.type, m, url, resource.policy.credentialParams) };
  } catch (_e) {
    return undefined;
  }
};

/** 固定分の上限（§7.1・R55）: 要素ごとの Σ pinnedBytes（要素の Resource を読み直す）が maxBytes 以上か */
const overPinnedLimit = async (store: Store, resources: readonly ResourceMeta[]): Promise<boolean> => {
  for (const r of resources) {
    const fresh = await store.getResource(r.id);
    if (!fresh) continue;
    for (const scope of await evictScopesFor(store, fresh)) {
      let pinned = 0;
      for (const id of scope.resourceIds) pinned += (await store.getResource(id))?.pinnedBytes ?? 0;
      if (pinned >= scope.maxBytes) return true;
    }
  }
  return false;
};

const stopError = (code: 'opaque' | 'network' | 'upstream' | 'quota', message: string): WeiwudiError => new WeiwudiError(code, message);

/** 範囲取得のジョブ（R13・R24・R46・R55・R57・§4.5-3・§4.6）。投げない（失敗は stop のイベントにする） */
const runRangeJob = async (
  ctx: Context, store: Store, rec: SourceRecord, region: RegionRecord, plan: RangePlan, job: JobState, client: JobClient,
): Promise<void> => {
  const { options } = plan;
  const regionId = region.id;
  const compiled = new Map<string, CompiledTemplate>();
  const creds = new Map<string, Promise<{ credentials?: Credentials; credentialSourceId?: string }>>();
  let processed = 0;
  let processedTiles = 0;
  let regionGone = false;
  let stopped: WeiwudiError | undefined;
  const opaqueStreak = new Map<string, number>();
  let authStreak = 0;
  let quotaStreak = 0;
  /** cors の確かめが通った Resource（以後は確かめない） */
  const confirmed = new Set<string>();
  let keys: string[] = [];
  const errors = job.failures;
  /** 失敗と数えたタイルのキーと種類（確かめで取れたら数え直す。PR #102 L2） */
  const failed = new Map<string, TileFailure>();
  /** グリフの fontstack（opts.fonts ∪ StyleSpec.fonts ∪ collectFonts。重ねない。m4-t4・R53） */
  const fontstacks: string[] = [];
  const addFontstack = (f: string) => {
    if (fontstacks.indexOf(f) < 0) fontstacks.push(f);
  };
  for (const f of [...options.fonts, ...(styleSpecOf(rec)?.fonts ?? [])]) addFontstack(f);

  const fail = (kind: TileFailure, key?: string) => {
    job.error++;
    errors[kind]++;
    if (key !== undefined) failed.set(key, kind);
  };

  const credentialsOf = (resource: ResourceMeta, origin: string) => {
    const k = `${resource.id}\0${origin}`;
    let p = creds.get(k);
    if (!p) {
      p = credentialsForResource(ctx, resource, origin).catch(() => ({}));
      creds.set(k, p);
    }
    return p;
  };

  /**
   * 1 単位を serveResource で取る。結果は x-weiwudi-error と状態コード。text なら本体を文字列で返す（スタイル）。
   * collect はグリフの束ね書き（m4-t4）
   */
  const fetchUnit = async (
    unit: Unit, t: { url: URL; m: MatchResult }, extra: { collect?: GlyphCollector; text?: boolean } = {},
  ): Promise<{ error: TileFailure | undefined; status: number; text?: string }> => {
    const picked = await credentialsOf(unit.resource, t.url.origin);
    const res = await serveResource(ctx, unit.resource, new Request(t.url.href), t.url, t.m, picked.credentials, {
      ...(picked.credentialSourceId !== undefined ? { credentialSourceId: picked.credentialSourceId } : {}),
      ...(extra.collect ? { collect: extra.collect } : {}),
    });
    const err = res.headers.get('x-weiwudi-error');
    const status = res.status;
    let text: string | undefined;
    try {
      // 配信しない本体も読み切る
      if (extra.text) text = await res.text();
      else await res.arrayBuffer();
    } catch (_e) {
      // 読めなくても数え方は変えない
    }
    return { error: isFailure(err) ? err : undefined, status, ...(text !== undefined ? { text } : {}) };
  };

  const succeeded = (unit: Unit) => {
    opaqueStreak.delete(unit.resource.id);
    authStreak = 0;
    quotaStreak = 0;
  };

  /**
   * 失敗の数え方（§4.5-3・§4.6）。opaque の連続数はタイルだけで数える（確かめはタイルを選ぶ。非タイルの単位は数が少なく、
   * 範囲の枚数で確かめられない。m4-t4）
   */
  const classify = async (unit: Unit, t: { url: URL; key: string }, error: TileFailure, status: number): Promise<void> => {
    quotaStreak = error === 'quota' ? quotaStreak + 1 : 0;
    if (error === 'network') {
      // §4.5-3: TypeError の単位は no-cors で確かめる。opaque は upstream に数え、実績が無ければ連続数に足す
      const probe = await probeNoCors(t.url.href);
      if (probe === 'opaque') {
        fail('upstream', t.key);
        if (unit.tile && !confirmed.has(unit.resource.id) && !experienced(await store.getResource(unit.resource.id))) {
          opaqueStreak.set(unit.resource.id, (opaqueStreak.get(unit.resource.id) ?? 0) + 1);
        }
        return;
      }
      fail('network', t.key);
      return;
    }
    fail(error, t.key);
    // §4.6: count === 0 の 401・403 が続いたら止める
    if (error === 'upstream' && (status === 401 || status === 403)) {
      const fresh = await store.getResource(unit.resource.id);
      authStreak = fresh && fresh.count === 0 ? authStreak + 1 : 0;
    } else {
      authStreak = 0;
    }
  };

  /**
   * スタイル（m4-t4・§7.2 の 1）。hit でよい（hasEntries で飛ばさない）。本体から collectFonts で fontstack を集める。
   * 読めなければ（invalid-style の形。HTML は core が upstream-error にする）スタイルの単位だけ upstream に数える
   */
  const runStyle = async (unit: Unit, t: { url: URL; m: MatchResult; key: string }): Promise<void> => {
    const { error, status, text } = await fetchUnit(unit, t, { text: true });
    let readable = false;
    if (text !== undefined) {
      try {
        for (const f of collectFonts(parseStyle(text))) addFontstack(f);
        readable = true;
      } catch (_e) {
        // 下で数える
      }
    }
    if (error) {
      // 読めるスタイルの記録が既に有れば（stale）固定の対象に入れてから失敗を数える（R-t4-5 とそろえる。PR #104 L2）
      if (readable && (await store.hasEntries([t.key]))[0]) keys.push(t.key);
      await classify(unit, t, error, status);
      return;
    }
    if (!readable) {
      fail('upstream', t.key);
      return;
    }
    keys.push(t.key);
    succeeded(unit);
  };

  /**
   * グリフの 1 fontstack（m4-t4・§11・L4・R-G・第 1 回 M15）。既に有る範囲は getEntry の parts で見て飛ばし（1 回）、
   * 無い範囲を順に取って collect に集め、finally で 1 回だけ書く（取り消しで途中まででも捨てない）。
   * 失敗は単位ごとに 1 件: flush の失敗（quota・storage）を先に、無ければ最初の範囲の失敗
   */
  const runGlyph = async (unit: Unit): Promise<void> => {
    const targets: { url: URL; m: MatchResult; key: string }[] = [];
    for (const range of glyphRangesOf(options.glyphRanges)) {
      const t = target(compiled, unit, options.ratio, range);
      if (!t) {
        fail('storage');
        return;
      }
      targets.push(t);
    }
    if (targets.length === 0) return;
    const key = targets[0].key;
    let exists: boolean;
    let have: string[];
    try {
      const got = await store.getEntry(key);
      exists = !!got;
      have = Object.keys(got?.body.parts ?? {});
    } catch (_e) {
      fail('storage', key);
      return;
    }
    const missing = targets.filter((t) => have.indexOf(t.m.range ?? '') < 0);
    let first: { error: TileFailure; status: number; t: { url: URL; key: string } } | undefined;
    let got = false;
    if (missing.length > 0) {
      const collect = createGlyphCollector(ctx, unit.resource, key);
      let flushed: 'quota' | 'storage' | undefined;
      try {
        for (const t of missing) {
          // 取り消しは範囲の間で見る（取れた範囲は下の flush で書く）
          if (job.cancel) break;
          const r = await fetchUnit(unit, t, { collect });
          if (r.error) first ??= { error: r.error, status: r.status, t };
          else got = true;
        }
      } finally {
        flushed = await collect.flush();
      }
      if (flushed) {
        quotaStreak = flushed === 'quota' ? quotaStreak + 1 : 0;
        fail(flushed, key);
        if (exists) keys.push(key);
        return;
      }
    }
    if (exists || got) keys.push(key);
    if (first) {
      await classify(unit, { url: first.t.url, key }, first.error, first.status);
      return;
    }
    succeeded(unit);
  };

  const run = async (unit: Unit): Promise<void> => {
    if (unit.resource.type === 'glyph') {
      processed++;
      await runGlyph(unit);
      return;
    }
    const t = target(compiled, unit, options.ratio);
    processed++;
    if (unit.tile) processedTiles++;
    if (t && unit.resource.type === 'style') {
      await runStyle(unit, t);
      return;
    }
    if (!t) {
      // 照合に外れた（展開とテンプレートの食い違い）。internal として storage に数える（計画 R2）
      fail('storage');
      return;
    }
    const [has] = await store.hasEntries([t.key]);
    if (has) {
      keys.push(t.key);
      return;
    }
    const { error, status } = await fetchUnit(unit, t);
    if (!error) {
      keys.push(t.key);
      succeeded(unit);
      return;
    }
    await classify(unit, t, error, status);
  };

  /** §4.5-3: opaque が 3 回続いた Resource を、範囲から無作為に 5 枚 cors で確かめる */
  const confirm = async (resource: ResourceMeta): Promise<void> => {
    const total = countRange(resource, plan.normalized);
    // 重ならない 5 枚（5 枚未満なら全部）。同じ番号を引いたら次の番号にする
    const picks = new Set<number>();
    while (picks.size < Math.min(PROBE_TILES, total)) {
      let n = Math.min(total - 1, Math.floor(Math.random() * total));
      while (picks.has(n)) n = (n + 1) % total;
      picks.add(n);
    }
    let passed = false;
    let sawOpaque = false;
    for (const n of picks) {
      const tile = tileAt(resource, plan.normalized, n);
      const t = tile ? target(compiled, { resource, tile }, options.ratio) : undefined;
      if (!t) continue;
      const { error } = await fetchUnit({ resource, tile }, t);
      if (error !== 'network') {
        // CORS を通った（状態コードを問わない。markCors が corsOk を立てる）。取れた 200 は保存済みで、列挙で成功に数える
        passed = true;
        if (!error) {
          keys.push(t.key);
          // 列挙で既に失敗と数えたタイルなら、その場で成功に数え直す（後で列挙するタイルは hasEntries で成功になる）
          const kind = failed.get(t.key);
          if (kind !== undefined) {
            failed.delete(t.key);
            job.error--;
            errors[kind]--;
          }
        }
        continue;
      }
      if ((await probeNoCors(t.url.href)) === 'opaque') sawOpaque = true;
    }
    opaqueStreak.delete(resource.id);
    if (passed) {
      confirmed.add(resource.id);
      return;
    }
    if (sawOpaque) {
      try {
        ctx.notify?.({ type: 'opaque', resourceId: resource.id, sourceIds: resource.sourceIds.slice() });
      } catch (_e) {
        // 知らせの失敗で止め方を変えない
      }
      throw stopError('opaque', 'The upstream does not support CORS');
    }
    throw stopError('network', 'The upstream is not reachable');
  };

  const pinKeys = async () => {
    const batch = keys;
    keys = [];
    if (!options.pin) return;
    for (let i = 0; i < batch.length; i += PIN_CHUNK) await store.setPinned(batch.slice(i, i + PIN_CHUNK), 1);
  };

  const percent = (done: boolean): number => {
    if (plan.total === 0) return done ? 100 : 0;
    return Math.min(100, Math.floor(processedTiles * 100 / plan.total));
  };

  let result: 'finished' | 'canceled' | 'gone' | 'stopped' = 'finished';
  try {
    if (options.pin && await overPinnedLimit(store, plan.resources)) throw stopError('quota', 'The pinned entries reach cacheMaxBytes');
    // スタイルの段を先に終えてから残りの単位を作る（グリフの fontstack がスタイルの本体に依る。m4-t4）
    const spec = {
      batchSize: options.concurrency,
      isAlive: async () => !!(await self.clients.get(client.id)),
      isCanceled: async () => {
        if (job.cancel) return true;
        // R13: Source が無ければ stop（source-not-found）。R57: region が無ければ固定を付けずに canceled
        if (!(await store.getSource(rec.id))) throw notFound(rec.id);
        if (!(await store.getRegion(regionId))) {
          regionGone = true;
          return true;
        }
        return false;
      },
      run,
      onBatch: async () => {
        // job.total はタイルの枚数なので、count もタイルだけで数える（旧 API の fetch-busy の文面。PR #104 L3）
        job.count = processedTiles;
        if (!(await store.getRegion(regionId))) {
          regionGone = true;
          keys = [];
          return;
        }
        try {
          for (const [rid, n] of opaqueStreak) {
            if (n < STREAK_LIMIT) continue;
            const resource = plan.resources.find((r) => r.id === rid);
            if (resource) await confirm(resource);
          }
        } finally {
          // 確かめが stop を投げても、このバッチで取れた分は固定する（region は上で確かめた。PR #102 L1）
          await pinKeys();
        }
        if (authStreak >= STREAK_LIMIT) throw stopError('upstream', 'The upstream refused the requests (401 / 403)');
        if (quotaStreak >= STREAK_LIMIT) throw stopError('quota', 'The browser storage quota is exceeded');
        if (options.pin && await overPinnedLimit(store, plan.resources)) throw stopError('quota', 'The pinned entries reach cacheMaxBytes');
        try {
          client.postMessage({
            type: 'proceed', sourceId: rec.id, regionId, percent: percent(false), processed, total: plan.total,
            error: job.error, errors: { ...errors },
          });
        } catch (_e) {
          // 送れなくてもジョブは続ける
        }
      },
    };
    result = await runJob<Unit>({ ...spec, tasks: unitsOf(plan, 'style', () => fontstacks) });
    if (result === 'finished') result = await runJob<Unit>({ ...spec, tasks: unitsOf(plan, 'rest', () => fontstacks) });
    if (regionGone && result === 'finished') result = 'canceled';
  } catch (e) {
    result = 'stopped';
    stopped = e instanceof WeiwudiError ? e : WeiwudiError.from(e);
  }

  // 終わりの順: region を書く → ctx.job を外す → postMessage（R45）
  const status: RegionStatus = result === 'finished' ? (job.error === 0 ? 'complete' : 'partial')
    : result === 'canceled' ? 'canceled' : result === 'gone' ? 'partial' : 'stopped';
  if (!regionGone) {
    try {
      await store.patchRegion(regionId, (r) => (r.status !== 'running' ? undefined : {
        ...r, status, error: job.error, errors: { ...errors }, updatedAt: Date.now(),
        ...(stopped ? { code: stopped.code } : {}),
      }));
    } catch (e) {
      console.error(e);
    }
  }
  if (ctx.job === job) ctx.job = undefined;
  try {
    if (result === 'finished') {
      client.postMessage({
        type: 'finish', sourceId: rec.id, regionId, percent: percent(true), processed, total: plan.total,
        error: job.error, errors: { ...errors },
      });
    } else if (result === 'canceled') {
      client.postMessage({ type: 'canceled', sourceId: rec.id, regionId });
    } else if (result === 'stopped') {
      client.postMessage({
        type: 'stop', sourceId: rec.id, regionId, code: stopped!.code, message: stopped!.message, processed, total: plan.total,
      });
    }
  } catch (_e) {
    // ページが閉じた
  }
  try {
    await sweepOnce(ctx, { force: true });
  } catch (e) {
    console.error(e);
  }
};
