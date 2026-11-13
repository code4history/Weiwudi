// IndexedDB の全操作と、保存の型の正本（#37・仕様 §5.2・§5.4）。
// 単一 DB WeiwudiStore（version 1）。旧 DB には触らない（移行は m4 の migrate.ts）。
//
// 決まり:
// - モジュール変数を持たない。接続などの状態は openStore() が返す Store の中に閉じる（context が 1 つ持つ）
// - reject する値は tx.error・req.error・投げられた DOMException（Event を reject しない。仕様 §9）
// - Entry の増減と同じ tx で Resource の count・bytes・pinnedBytes を直す
// - 本体は ArrayBuffer で保存し、型は type に分けて持つ（StoredBody）。WebKit の非永続の保存領域（Safari の
//   プライベートブラウズと Playwright の WebKit）は IndexedDB に Blob を put できない（UnknownError。m3-t10）。
//   Blob との変換はここに閉じる（Blob → ArrayBuffer の入口は readBlob 1 つで、toStoredBody と putGlyphParts の
//   部分の変換が使う。読み戻しは fromStoredBody）。Store の呼び出し側は Blob のまま使う。
//   Blob を持つ古いレコード（開発の途中の形）は読めないものとして miss にする（t4 の parts の無いレコードと同じ考え方）
import type { TileBox } from './tile_math';
import type { NormalizedFetchOptions, NormalizedRange, RegionInfo, StoredSpec, StyleSpec } from './spec';
import { LEGACY_PREFIX } from './constants';

export const STORE_DB_NAME = 'WeiwudiStore';
export const STORE_DB_VERSION = 1;

// ---- 型（仕様 §5.2） ----

export type ResourceType = 'style' | 'tilejson' | 'tile' | 'glyph' | 'sprite' | 'data';

/** 範囲外の応答（仕様 §6） */
export type OutOfRange = 'transparent' | 'empty' | 'not-found';

export interface TileExtent {
  minZoom: number;
  maxZoom: number;
  /** maxZoom での x/y の範囲 */
  box?: TileBox;
  sourceId: string;
}

export interface ResourcePolicy {
  cacheTtl: number;
  /** undefined は無期限 */
  cacheRetention?: number;
  /** false なら認証付きの要求を保存しない */
  store: boolean;
  outOfRange: { extent: OutOfRange; zoom: OutOfRange };
  credentialParams: string[];
}

export interface ResourceMeta {
  id: string;
  type: ResourceType;
  /** 資格情報を除いた URL テンプレート */
  templates: string[];
  /** 多対多。旧 API の Resource は mapID 1 つ */
  sourceIds: string[];
  /** 'mapbox' など。#38 の提供元別集計の鍵（無ければ origin） */
  provider?: string;
  /** type === 'tile' のときの範囲。Source ごとの和（§5.6） */
  extents?: TileExtent[];
  scheme?: 'xyz' | 'tms';
  encoding?: 'raster' | 'vector';
  /** 実効方針（§5.6） */
  policy: ResourcePolicy;
  /** §4.5 */
  corslessUntil?: number;
  /** §4.5。CORS を通った応答を 1 度でも受けた印（状態コードは問わない） */
  corsOk?: boolean;
  /** §5.6。合流を拒否したが範囲だけ足した Source */
  rangeOnlySourceIds?: string[];
  /** Entry の件数（Entry の増減と同じ tx で直す。store だけが書く） */
  count: number;
  /** Entry の大きさの和（同上） */
  bytes: number;
  /** 固定（pinned = 1）の Entry の大きさの和（同上） */
  pinnedBytes: number;
}

export interface EntryMeta {
  key: string;
  resourceId: string;
  /** 範囲の解放に使う */
  z?: number;
  x?: number;
  y?: number;
  size: number;
  /** 旧 epoch */
  fetchedAt: number;
  /** 旧 accessedAt */
  accessedAt: number;
  pinned: 0 | 1;
  contentType?: string;
}

/** §11 の結合保存の部分の索引（範囲 → 連結した本体の中の位置） */
export type GlyphPartIndex = Record<string, { offset: number; length: number; fetchedAt: number }>;

/** putGlyphParts の 1 要素（範囲・本体・取得の時刻） */
export interface GlyphPartInput {
  part: string;
  blob: Blob;
  fetchedAt: number;
}

export interface EntryBody {
  key: string;
  blob: Blob;
  headers: Record<string, string>;
  /** §11 の結合保存 */
  parts?: GlyphPartIndex;
}

/** bodies に置く形（m3-t10）。本体は ArrayBuffer、Blob の型は type。EntryBody との変換は toStoredBody・fromStoredBody */
export interface StoredBody {
  key: string;
  data: ArrayBuffer;
  type: string;
  headers: Record<string, string>;
  parts?: GlyphPartIndex;
}

const isArrayBuffer = (x: unknown): x is ArrayBuffer => Object.prototype.toString.call(x) === '[object ArrayBuffer]';

/** bodies のレコードが今の形か（Blob を持つ古いレコード・壊れたレコードは false） */
export const isStoredBody = (x: unknown): x is StoredBody => {
  const r = x as Partial<StoredBody> | null | undefined;
  return !!r && typeof r === 'object' && typeof r.key === 'string' && isArrayBuffer(r.data)
    && typeof r.type === 'string' && !!r.headers && typeof r.headers === 'object';
};

/** Blob → ArrayBuffer と型の変換の入口（非同期。tx の外で行う。toStoredBody と putGlyphParts の部分の変換が使う） */
const readBlob = async (blob: Blob): Promise<{ data: ArrayBuffer; type: string }> => ({
  data: await blob.arrayBuffer(),
  type: blob.type,
});

/** 書く前に EntryBody を保存の形にする */
const toStoredBody = async (body: EntryBody): Promise<StoredBody> => ({
  key: body.key,
  ...(await readBlob(body.blob)),
  headers: body.headers,
  ...(body.parts ? { parts: body.parts } : {}),
});

/** 読んだレコードを EntryBody に戻す。今の形でなければ undefined（呼び出し側は miss として作り直す） */
const fromStoredBody = (x: unknown): EntryBody | undefined => {
  if (!isStoredBody(x)) return undefined;
  return {
    key: x.key,
    blob: new Blob([x.data], x.type ? { type: x.type } : undefined),
    headers: x.headers,
    ...(x.parts ? { parts: x.parts } : {}),
  };
};

/** ページ側の API と差し込み口へ渡す射影（保存の型は渡さない） */
export interface ResourceInfo {
  id: string;
  type: ResourceType;
  templates: string[];
  count: number;
  bytes: number;
  /** §5.6 */
  rangeOnly?: true;
  /** corslessUntil が今より先のとき（§4.5） */
  corsless?: true;
}

/** 資格情報（§10）。credentials ストアだけに入れる */
export interface Credentials {
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

/** 旧 API の地図の設定（/api/add が作るもの）。Source の legacy にそのまま持つ */
export interface MapSetting {
  mapID: string;
  type?: string;
  url?: string | string[];
  minZoom?: number;
  maxZoom?: number;
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
  totalTile?: number;
  minLat?: number;
  minLng?: number;
  maxLat?: number;
  maxLng?: number;
  width?: number;
  height?: number;
  tileSize?: number;
  /** タイルキャッシュの有効期間(ms)。未指定は24時間 (#2) */
  cacheTtl?: number;
  /** キャッシュ容量の上限(byte)。未指定は上限なし (#29) */
  cacheMaxBytes?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** child はスタイルの下位資源ごとの内部の Source（m3-t2。利用者には見せない） */
export type SourceKind = 'style' | 'raster' | 'vector' | 'asset' | 'legacy' | 'child';

export interface SourceRecord {
  id: string;
  kind: SourceKind;
  /**
   * 登録内容（資格情報を除く）。raster・vector・asset・child は spec.ts の normalizeMember が作る StoredSpec（m2-t2 の R8）、
   * style は StyleSpec。旧 API（kind === 'legacy'）は空の object（設定は legacy に持つ）。読むのは storedSpecOf・styleSpecOf だけ
   */
  spec: StoredSpec | StyleSpec | Record<string, never>;
  /** 登録順の連番（呼び出し側が振る） */
  order: number;
  /** §12 */
  warnings: string[];
  createdAt: number;
  /** 旧 API の MapSetting（kind === 'legacy'） */
  legacy?: MapSetting;
  /** 子 Source（kind === 'child'）の親（スタイルの Source）の id */
  parentId?: string;
}

// ---- SourceRecord を読む補助（唯一の置き場。m3-t1・I5・R27） ----

/** 旧 API の記録（kind: 'legacy' か id が map: で始まる） */
export const isLegacyRecord = (rec: SourceRecord): boolean => rec.kind === 'legacy' || rec.id.startsWith(LEGACY_PREFIX);

/** スタイルの下位資源の内部の Source（kind: 'child' か parentId を持つ）。子の判定はこれだけで行う */
export const isChildRecord = (rec: SourceRecord): boolean => rec.kind === 'child' || rec.parentId !== undefined;

/**
 * raster・vector・asset・child の Source の登録内容。旧 API（spec: {}）と style（StyleSpec）は undefined（m3-t2 の Ruling）。
 * m2 で作った記録は type を持たないので 'tile' として読む（開発中のブラウザの DB を壊さない）
 */
export const storedSpecOf = (rec: SourceRecord): StoredSpec | undefined => {
  if (rec.kind === 'legacy' || rec.kind === 'style' || !('templates' in rec.spec)) return undefined;
  const spec = rec.spec as StoredSpec;
  return spec.type === undefined ? { ...spec, type: 'tile' } : spec;
};

/** style の Source（親）の登録内容。children の無い記録は空の配列として読む */
export const styleSpecOf = (rec: SourceRecord): StyleSpec | undefined => {
  if (rec.kind !== 'style' || !('templates' in rec.spec)) return undefined;
  const spec = rec.spec as StyleSpec;
  return Array.isArray(spec.children) ? spec : { ...spec, children: [] };
};

/**
 * 合流に加わる Source のテンプレート（storedSpecOf の分だけ。旧 API・style の親は空）。
 * style のテンプレートは style の子が持つので、親を照合と資格情報の候補に入れない
 */
export const templatesOf = (rec: SourceRecord): readonly string[] => storedSpecOf(rec)?.templates ?? [];

/** 新しく登録する Source の order（登録済みの最大 + 1。無ければ 1） */
export const nextOrder = async (store: Pick<Store, 'listSources'>): Promise<number> =>
  (await store.listSources()).reduce((n, r) => Math.max(n, r.order), 0) + 1;

/** Resource の射影。rangeOnly は sourceId を渡し、それが rangeOnlySourceIds にあるときだけ出す */
export const toResourceInfo = (meta: ResourceMeta, now: number, sourceId?: string): ResourceInfo => {
  const info: ResourceInfo = {
    id: meta.id,
    type: meta.type,
    templates: meta.templates.slice(),
    count: meta.count,
    bytes: meta.bytes,
  };
  if (sourceId !== undefined && (meta.rangeOnlySourceIds ?? []).indexOf(sourceId) >= 0) info.rangeOnly = true;
  if (meta.corslessUntil !== undefined && meta.corslessUntil > now) info.corsless = true;
  return info;
};

// ---- Store ----

/**
 * 範囲取得の region（regions ストア。keyPath id・索引 sourceId）。deleteSource が同じ tx で sourceId の region を消す（m4-t1）。
 * 項目は RegionInfo（公開の形）に、取得のときの範囲（normalized。'all' も固める）と検査済みの指定（options。再開で使う）を
 * 足したもの（m4-t3・R5・R-t3-3）。進捗の位置は持たない
 */
export interface RegionRecord extends RegionInfo {
  normalized: NormalizedRange;
  options: NormalizedFetchOptions;
}

/**
 * putEntry の退避の 1 要素。cacheMaxBytes を持つ Source 1 つ分（§7.1）。resourceIds の無い要素は全体上限
 * （setLimits。m4-t6）で、全 Resource の固定でない Entry を [pinned, accessedAt] の索引で古い順に消す
 */
export interface EvictionScope {
  resourceIds?: string[];
  maxBytes: number;
}

/** kv の totals（全 Resource の count・bytes・pinnedBytes の和。Entry の増減と同じ tx で直す。m4-t6・R15） */
export interface Totals {
  bytes: number;
  pinnedBytes: number;
  count: number;
}

/** kv の鍵: 全体の数（Totals） */
export const KV_TOTALS = 'totals';
/** kv の鍵: 全体上限（{ maxBytes?: number }。setLimits が書き、core の evictScopesFor が読む。m4-t6） */
export const KV_LIMITS = 'limits';
/** kv の鍵: ページ（registerSW）が指定した User-Agent（{ userAgent?: string }。control の setUserAgent が書き、context が読む） */
export const KV_USER_AGENT = 'userAgent';

const isTotals = (x: unknown): x is Totals => {
  const t = x as Partial<Totals> | null | undefined;
  return !!t && typeof t === 'object' && typeof t.bytes === 'number' && typeof t.pinnedBytes === 'number' && typeof t.count === 'number';
};

export interface Store {
  getSource(id: string): Promise<SourceRecord | undefined>;
  putSource(record: SourceRecord): Promise<void>;
  /** order の昇順 */
  listSources(): Promise<SourceRecord[]>;
  /** credentials と regions（sourceId）も同じ tx で消す */
  deleteSource(id: string): Promise<void>;

  getResource(id: string): Promise<ResourceMeta | undefined>;
  listResources(): Promise<ResourceMeta[]>;
  resourcesBySource(sourceId: string): Promise<ResourceMeta[]>;
  resourcesByRangeOnlySource(sourceId: string): Promise<ResourceMeta[]>;
  /** 無いときだけ作る（あれば ConstraintError で reject）。count・bytes・pinnedBytes は 0 で始める */
  createResource(meta: ResourceMeta): Promise<void>;
  /** 同じ tx で count・bytes・pinnedBytes は保存済みの値を引き継ぐ。無ければ NotFoundError で reject */
  replaceResource(meta: ResourceMeta): Promise<void>;
  /**
   * 1 tx で読み・直し・書く。無い Resource では fn を呼ばず undefined。fn が undefined を返せば書かずに undefined。
   * id と count・bytes・pinnedBytes は保存済みの値のまま（fn の値を使わない）。書いた値を返す
   */
  patchResource(id: string, fn: (m: ResourceMeta) => ResourceMeta | undefined): Promise<ResourceMeta | undefined>;
  /** 同じ tx で entries と bodies をキーの範囲で消す */
  deleteResource(id: string): Promise<void>;
  /** 同じ tx で count・bytes・pinnedBytes を 0 に */
  clearEntries(resourceId: string): Promise<void>;

  getEntry(key: string): Promise<{ meta: EntryMeta; body: EntryBody } | undefined>;
  /**
   * メタ（entries）があるものを true。本体は読まない（m4-t1・I12・R43）。古い形（Blob を持つ）の本体のキーも true で、
   * 範囲取得・fetchAll は「有る」として飛ばし、表示の要求で getEntry が miss にして取り直す
   */
  hasEntries(keys: string[]): Promise<boolean[]>;
  /** entries だけ。接続があれば tx は呼び出しの中で同期に作る */
  touch(key: string, accessedAt: number): Promise<void>;
  putEntry(meta: EntryMeta, body: EntryBody, evict: EvictionScope[]): Promise<{ saved: boolean }>;
  /**
   * グリフの範囲 1 つを fontstack のレコードへ足す（仕様 §11）。1 つの readwrite tx で既存の本体を読み、
   * 残す部分の slice と新しい部分から本体と parts を作り直して書く。同じ範囲の古い部分は落とす。
   * meta の size は使わず新しい本体の大きさにし、fetchedAt は最も新しい部分の値にする（meta.fetchedAt はこの部分の値）。
   * 退避と Resource の数の更新は putEntry と同じ
   */
  putGlyphPart(meta: EntryMeta, part: string, blob: Blob, headers: Record<string, string>, evict: EvictionScope[]): Promise<{ saved: boolean }>;
  /**
   * グリフの範囲を複数まとめて fontstack のレコードへ足す（仕様 §11 の「1 fontstack 分を溜めてから 1 回で書く」。m3-t7。
   * 範囲取得（m4）が使う）。putGlyphPart はこれに 1 つだけ渡す形（実装は 1 つ）。同じ範囲が並びに 2 つあれば後のものが勝つ。
   * 部分ごとの fetchedAt は parts のもの。meta.fetchedAt は使わない（最も新しい部分の値にする）。parts が空なら何も書かない
   */
  putGlyphParts(
    meta: EntryMeta, parts: readonly GlyphPartInput[], headers: Record<string, string>, evict: EvictionScope[],
  ): Promise<{ saved: boolean }>;

  /**
   * 複数の Entry を同じ tx で消し、Resource の数を直す（呼び出し側が 200 件ずつ呼ぶ）。tx の中で読んだメタで条件を見直してから消す
   * （unpinnedOnly: pinned === 1 なら残す。fetchedBefore: fetchedAt >= fetchedBefore なら残す）。消した数を返す（m4-t1）
   */
  deleteEntries(keys: readonly string[], opts?: { unpinnedOnly?: boolean; fetchedBefore?: number }): Promise<number>;
  /** 固定を付ける・外す（同じ tx で pinnedBytes を直す）。無いキーと既にその値のキーは飛ばす。付けた・外した数を返す（m4-t1） */
  setPinned(keys: readonly string[], pinned: 0 | 1): Promise<number>;
  /**
   * [pinned, fetchedAt] の索引を pinned = 0・fetchedAt < before で古い順（同値はキー昇順）に最大 limit 件読む（メタだけ。cursor）。
   * next は limit 件読めたときの続きの位置（[fetchedAt, key]）で、after に渡すとその次から読む（m4-t1。t2 の掃除）
   */
  listUnpinnedBefore(before: number, limit: number, after?: IDBValidKey): Promise<{ metas: EntryMeta[]; next?: IDBValidKey }>;
  /** Resource のキーの範囲のメタをキー昇順に最大 limit 件読む。next は limit 件読めたときの最後のキーで、after はその次から（m4-t1。t2 のグリフの掃除） */
  entriesOf(resourceId: string, limit: number, after?: string): Promise<{ metas: EntryMeta[]; next?: string }>;
  /** [resourceId, z] の索引で z の Entry のメタを読む（stats の範囲の数え上げ・解放の幾何。m4-t1） */
  entriesAtZoom(resourceId: string, z: number): Promise<EntryMeta[]>;
  /**
   * グリフのレコードから fetchedAt < before の部分を tx の中で落として書き直す（空になれば消す。固定のレコード・部分の索引の無い
   * レコード・古い形の本体は触らない）。詰め直しは putGlyphParts と共有する。落とした部分の数を返す（m4-t1。t2 の掃除）
   */
  pruneGlyphParts(key: string, before: number): Promise<number>;

  getRegion(id: string): Promise<RegionRecord | undefined>;
  putRegion(r: RegionRecord): Promise<void>;
  /** 1 tx で読み・直し・書き。無ければ fn を呼ばず undefined。fn が undefined を返せば書かずに undefined。書いた値を返す（m4-t1） */
  patchRegion(id: string, fn: (r: RegionRecord) => RegionRecord | undefined): Promise<RegionRecord | undefined>;
  listRegions(sourceId: string): Promise<RegionRecord[]>;
  deleteRegion(id: string): Promise<void>;

  getCredentials(sourceId: string): Promise<Credentials | undefined>;
  putCredentials(sourceId: string, c: Credentials): Promise<void>;

  kvGet(key: string): Promise<unknown>;
  kvPut(key: string, value: unknown): Promise<void>;

  /** 全体の数（kv の totals）。無ければ resources の和を返す（読むだけ。書かない。m4-t6） */
  getTotals(): Promise<Totals>;
  /**
   * 固定でない Entry を全体 LRU（[pinned, accessedAt] の索引。同値はキー昇順）で古い順に、消した大きさが bytes 以上になるまで
   * 消す（1 つの tx。Resource の数と totals も直す）。bytes が 0 以下なら何もしない。消した数を返す（m4-t6・R16）
   */
  evictGlobal(bytes: number): Promise<number>;

  /** 接続を閉じる（以後の呼び出しは開き直す） */
  close(): void;
}

const S_SOURCES = 'sources';
const S_RESOURCES = 'resources';
const S_ENTRIES = 'entries';
const S_BODIES = 'bodies';
const S_REGIONS = 'regions';
const S_CREDENTIALS = 'credentials';
const S_KV = 'kv';

const IX_SOURCE_IDS = 'sourceIds';
const IX_RANGE_ONLY = 'rangeOnlySourceIds';
const IX_LRU = 'resourceId_pinned_accessedAt';
const IX_GLOBAL_LRU = 'pinned_accessedAt';
const IX_FETCHED = 'pinned_fetchedAt';
const IX_ZOOM = 'resourceId_z';
const IX_REGION_SOURCE = 'sourceId';

const blockedError = (): Error => {
  const error = new Error(`Opening database "${STORE_DB_NAME}" is blocked by another connection`);
  error.name = 'BlockedError';
  return error;
};

const createSchema = (db: IDBDatabase): void => {
  const has = (n: string) => db.objectStoreNames.contains(n);
  if (!has(S_SOURCES)) db.createObjectStore(S_SOURCES, { keyPath: 'id' });
  if (!has(S_RESOURCES)) {
    const s = db.createObjectStore(S_RESOURCES, { keyPath: 'id' });
    s.createIndex(IX_SOURCE_IDS, 'sourceIds', { multiEntry: true });
    s.createIndex(IX_RANGE_ONLY, 'rangeOnlySourceIds', { multiEntry: true });
  }
  if (!has(S_ENTRIES)) {
    const s = db.createObjectStore(S_ENTRIES, { keyPath: 'key' });
    s.createIndex(IX_LRU, ['resourceId', 'pinned', 'accessedAt']);
    s.createIndex(IX_GLOBAL_LRU, ['pinned', 'accessedAt']);
    s.createIndex(IX_FETCHED, ['pinned', 'fetchedAt']);
    s.createIndex(IX_ZOOM, ['resourceId', 'z']);
  }
  if (!has(S_BODIES)) db.createObjectStore(S_BODIES, { keyPath: 'key' });
  if (!has(S_REGIONS)) {
    const s = db.createObjectStore(S_REGIONS, { keyPath: 'id' });
    s.createIndex(IX_REGION_SOURCE, 'sourceId');
  }
  if (!has(S_CREDENTIALS)) db.createObjectStore(S_CREDENTIALS, { keyPath: 'sourceId' });
  if (!has(S_KV)) db.createObjectStore(S_KV, { keyPath: 'key' });
};

/** 要求の結果を Promise にする。失敗は req.error（DOMException） */
const req2p = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * cursor の要求の次の success を待つ（m4-t1）。req2p は 1 回で解決するので、cursor は continue() の前にこれを呼んで
 * 同じ要求の次の結果を待つ。tx の中で IDB の要求以外を待たない
 */
const cursorStep = <C extends IDBCursor>(req: IDBRequest<C | null>): Promise<C | null> =>
  new Promise<C | null>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** 2 つの Entry のメタの退避の順（accessedAt 昇順・同値はキー昇順） */
const lruOrder = (a: EntryMeta, b: EntryMeta): number =>
  a.accessedAt - b.accessedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** 部分の索引を作り直した結合の本体（putGlyphParts と pruneGlyphParts が共有する。m4-t1） */
interface PackedGlyph { data: ArrayBuffer; parts: GlyphPartIndex }

/**
 * 残す部分（保存済みの本体の中の位置）と新しい部分を、残す部分は本体の中の順に、新しい部分は並びの順に詰めて連結する
 * （空きを残さない）。ArrayBuffer の切り出しと連結は同期なので、tx の中で IDB 以外の Promise を待たない
 */
const packGlyph = (
  source: ArrayBuffer | undefined,
  kept: readonly [string, { offset: number; length: number; fetchedAt: number }][],
  fresh: readonly { part: string; data: ArrayBuffer; fetchedAt: number }[],
): PackedGlyph => {
  const pieces: Uint8Array[] = [];
  const parts: GlyphPartIndex = {};
  let offset = 0;
  for (const [name, p] of [...kept].sort((a, b) => a[1].offset - b[1].offset)) {
    pieces.push(new Uint8Array(source!, p.offset, p.length));
    parts[name] = { offset, length: p.length, fetchedAt: p.fetchedAt };
    offset += p.length;
  }
  for (const p of fresh) {
    pieces.push(new Uint8Array(p.data));
    parts[p.part] = { offset, length: p.data.byteLength, fetchedAt: p.fetchedAt };
    offset += p.data.byteLength;
  }
  const joined = new Uint8Array(offset);
  let at = 0;
  for (const piece of pieces) {
    joined.set(piece, at);
    at += piece.byteLength;
  }
  return { data: joined.buffer, parts };
};

/** 部分の索引のうち最も新しい fetchedAt（レコードの fetchedAt。R7） */
const newestPart = (parts: GlyphPartIndex): number =>
  Object.values(parts).reduce((m, p) => Math.max(m, p.fetchedAt), -Infinity);

/** Resource の Entry のキーの範囲（key = resourceId + '\0' + suffix。id は \0 を含まない） */
const entryRange = (resourceId: string): IDBKeyRange =>
  IDBKeyRange.bound(`${resourceId}\0`, `${resourceId}\x01`, false, true);

/**
 * putEntry のキーの形の守り（m2-t2 水準 1 Info 1）。key が `resourceId + '\0'` で始まらない Entry は
 * deleteResource・clearEntries のキーの範囲から外れて数が合わなくなるので、tx を作る前に止める（何も書かない）。
 * 本体の key がメタの key と違うときも同じ。問題が無ければ undefined
 */
const entryKeyError = (meta: EntryMeta, bodyKey: string): Promise<never> | undefined => {
  if (!meta.key.startsWith(`${meta.resourceId}\0`)) {
    return Promise.reject(new DOMException(`Entry key does not start with the id of resource "${meta.resourceId}"`, 'DataError'));
  }
  if (bodyKey !== meta.key) {
    return Promise.reject(new DOMException('Entry body key does not match the entry key', 'DataError'));
  }
  return undefined;
};

/**
 * tx を作り、fn を同期に呼ぶ。fn の値は tx の complete の後に返す。
 * fn が投げたら（要求の失敗を含む）tx を abort して、その例外で reject する。
 * tx.error がある abort（容量超過の QuotaExceededError・要求の失敗）は tx.error で reject する
 */
const runTx = <T>(
  db: IDBDatabase,
  names: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => T | Promise<T>,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const tx = db.transaction(names, mode);
    let result: T;
    let failed = false;
    let failure: unknown;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      failure = err;
      try {
        tx.abort();
      } catch (_ignored) {
        // 既に終わった tx は abort できない。下の oncomplete・onabort が結果を返す
      }
    };
    tx.oncomplete = () => {
      if (failed) reject(failure);
      else resolve(result);
    };
    // tx.error を先に見る: 外からの abort（容量超過など）で待っていた要求が AbortError になっても、
    // 原因の QuotaExceededError を返す。自分で abort したとき tx.error は null なので fn の例外を返す
    tx.onabort = () => {
      reject(tx.error ?? (failed ? failure : new DOMException('Transaction was aborted', 'AbortError')));
    };
    try {
      Promise.resolve(fn(tx)).then((r) => { result = r; }, fail);
    } catch (err) {
      fail(err);
    }
  });

/**
 * Store を作り、接続を 1 度試す。開くのが blocked（他の接続が版の更新を止めている）でも止まらずに返す。
 * そのあいだの呼び出しは BlockedError で reject し、相手が閉じれば止まっていた open が完了して以後は成功する。
 * それ以外の open の失敗は reject する
 */
export const openStore = async (): Promise<Store> => {
  let db: IDBDatabase | undefined;
  let opening: Promise<IDBDatabase> | undefined;
  let blocked = false;

  const connect = (): Promise<IDBDatabase> => {
    if (db) return Promise.resolve(db);
    // 止まっている open の後ろに並ぶと、次の open は blocked も通知されずに待ち続ける
    if (blocked) return Promise.reject(blockedError());
    if (opening) return opening;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(STORE_DB_NAME, STORE_DB_VERSION);
      req.onupgradeneeded = () => createSchema(req.result);
      req.onsuccess = () => {
        const conn = req.result;
        blocked = false;
        opening = undefined;
        // 他の接続が版を上げる・DB を消すときは、こちらが閉じないと相手が進めない。次の呼び出しで開き直す
        conn.onversionchange = () => {
          conn.close();
          if (db === conn) db = undefined;
        };
        conn.onclose = () => {
          if (db === conn) db = undefined;
        };
        db = conn;
        resolve(conn);
      };
      req.onerror = () => {
        blocked = false;
        opening = undefined;
        reject(req.error);
      };
      // 閉じない接続が残ると open は完了しない。要求は生きているので、閉じられれば onsuccess が走る
      req.onblocked = () => {
        blocked = true;
        reject(blockedError());
      };
    });
    opening = p;
    return p;
  };

  /** 接続があれば tx を同期に作る。無ければ開いてから作る */
  const txNow = <T>(names: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => T | Promise<T>): Promise<T> => {
    if (db) return runTx(db, names, mode, fn);
    return connect().then((conn) => runTx(conn, names, mode, fn));
  };

  // 本体の変換（Blob → ArrayBuffer）は非同期なので、それを待つ書き込みは tx を後で作る。そのあいだに来た呼び出しも
  // 後ろに並べ、tx を作る順を呼び出しの順に保つ（同じキーの書き込みや clearEntries が追い越さない）。並ぶものが無ければ同期に作る。
  // 変換の成否は値として受け止める: Promise.all の reject で伝えると先の order を待たずに抜け、後続の呼び出しが
  // 先の書き込みを追い越す（prep が失敗しても先の order を待ってから進む）
  let order: Promise<void> = Promise.resolve();
  let queued = 0;
  const txAfter = <P, T>(
    prep: Promise<P>, names: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction, p: P) => T | Promise<T>,
  ): Promise<T> => {
    queued++;
    // 成否を値にする（outcome・turn は reject しない。失敗は result だけが返す）
    const outcome = prep.then(
      (p): { ok: true; value: P } => ({ ok: true, value: p }),
      (err: unknown): { ok: false; error: unknown } => ({ ok: false, error: err }),
    );
    const turn = order.then(() => outcome);
    // turn の後の callback は登録順に走る: この tx を作ってから order が進む
    const result = turn.then((o) => {
      queued--;
      if (!o.ok) throw o.error;
      return txNow(names, mode, (t) => fn(t, o.value));
    });
    order = turn.then(() => undefined, () => undefined);
    return result;
  };
  const tx = <T>(names: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => T | Promise<T>): Promise<T> =>
    queued === 0 ? txNow(names, mode, fn) : txAfter(Promise.resolve(undefined), names, mode, (t) => fn(t));

  /** [pinned, accessedAt] の索引の固定でない範囲（[0, *]）。IDBKeyRange は試験が差し替えるので openStore の中で作る */
  const GLOBAL_UNPINNED = IDBKeyRange.bound([0], [0, []]);

  const getOne = <T>(name: string, key: IDBValidKey): Promise<T | undefined> =>
    tx([name], 'readonly', (t) => req2p(t.objectStore(name).get(key)) as Promise<T | undefined>);

  /** 退避と Entry の増減に伴う Resource の数の差分 */
  interface Delta { count: number; bytes: number; pinnedBytes: number }
  const addDelta = (deltas: Map<string, Delta>, id: string, count: number, bytes: number, pinnedBytes: number) => {
    const d = deltas.get(id) ?? { count: 0, bytes: 0, pinnedBytes: 0 };
    d.count += count;
    d.bytes += bytes;
    d.pinnedBytes += pinnedBytes;
    deltas.set(id, d);
  };

  const ZERO: Delta = { count: 0, bytes: 0, pinnedBytes: 0 };

  /**
   * kv の totals を同じ tx で読む（m4-t6・R15）。無い（既存の開発用 DB）・形が違うときは、この tx の resources の和から作る
   * （tx の外で作ると同時の書き込みとずれる。resources は Entry を増減する全操作の tx に入っている）。
   * 和は Resource を書く前に読むこと（呼び出し側は tx の始めに呼ぶ）。getAll ではなく cursor で数える（照合表の読み込みの
   * getAll を数える試験と混ざらない）
   */
  const loadTotals = async (t: IDBTransaction): Promise<Totals> => {
    const rec = (await req2p(t.objectStore(S_KV).get(KV_TOTALS))) as { key: string; value: unknown } | undefined;
    if (rec && isTotals(rec.value)) return { bytes: rec.value.bytes, pinnedBytes: rec.value.pinnedBytes, count: rec.value.count };
    const sum: Totals = { bytes: 0, pinnedBytes: 0, count: 0 };
    const req = t.objectStore(S_RESOURCES).openCursor();
    let cursor = await cursorStep(req);
    while (cursor) {
      const r = cursor.value as ResourceMeta;
      sum.bytes += r.bytes;
      sum.pinnedBytes += r.pinnedBytes;
      sum.count += r.count;
      const next = cursorStep(req);
      cursor.continue();
      cursor = await next;
    }
    return sum;
  };

  /** totals に d を足して書く（同じ tx。loadTotals の値に） */
  const saveTotals = (t: IDBTransaction, base: Totals, d: Delta): void => {
    t.objectStore(S_KV).put({
      key: KV_TOTALS,
      value: { bytes: base.bytes + d.bytes, pinnedBytes: base.pinnedBytes + d.pinnedBytes, count: base.count + d.count },
    });
  };

  /**
   * Entry の増減と同じ tx で各 Resource の count・bytes・pinnedBytes と kv の totals を直す（commitEntry・deleteEntries・
   * setPinned・pruneGlyphParts・evictGlobal が共有する。C-O7・m4-t6）。known は同じ tx で読んだ Resource（読み直さない）。
   * 無い Resource は飛ばす（totals にも足さない）。totals は同じ tx で先に読んだ値（無ければここで読む。Resource を書く前）
   */
  const applyDeltas = async (
    t: IDBTransaction, deltas: Map<string, Delta>, known: readonly ResourceMeta[] = [], totals?: Totals,
  ): Promise<void> => {
    const base = totals ?? await loadTotals(t);
    const resources = t.objectStore(S_RESOURCES);
    const applied: Delta = { count: 0, bytes: 0, pinnedBytes: 0 };
    for (const [id, d] of deltas) {
      const saved = known.find((r) => r.id === id) ?? ((await req2p(resources.get(id))) as ResourceMeta | undefined);
      if (!saved) continue;
      resources.put({
        ...saved,
        count: saved.count + d.count,
        bytes: saved.bytes + d.bytes,
        pinnedBytes: saved.pinnedBytes + d.pinnedBytes,
      });
      applied.count += d.count;
      applied.bytes += d.bytes;
      applied.pinnedBytes += d.pinnedBytes;
    }
    saveTotals(t, base, applied);
  };

  /**
   * 固定でない Entry を、cursors（索引と範囲。Source の要素は Resource ごとの IX_LRU、全体の要素は IX_GLOBAL_LRU の 1 つ）で
   * 開いて併合し（accessedAt 昇順・同値はキー昇順）、total が budget に収まるまで 1 件ずつ消す（m4-t1・P7・R7'・m4-t6）。
   * skipKey は候補から外す（保存する同じキー）。前の要素が消した Entry は同じ tx の後の cursor に現れない。
   * 消した分は deltas に数え、残りの total を返す
   */
  const evictByCursor = async (
    t: IDBTransaction, cursors: readonly { index: string; range: IDBKeyRange }[], total: number, budget: number,
    skipKey: string | undefined, deltas: Map<string, Delta>,
  ): Promise<number> => {
    const entries = t.objectStore(S_ENTRIES);
    const bodies = t.objectStore(S_BODIES);
    const heads = await Promise.all(cursors.map(async (c) => {
      const req = entries.index(c.index).openCursor(c.range);
      return { req, cursor: await cursorStep(req) };
    }));
    const advance = async (h: (typeof heads)[number]) => {
      const next = cursorStep(h.req);
      h.cursor!.continue();
      h.cursor = await next;
    };
    // 同じキーは飛ばす（今の getAll の実装の filter と同じ）
    const skipSame = async () => {
      for (const h of heads) {
        while (h.cursor && skipKey !== undefined && (h.cursor.value as EntryMeta).key === skipKey) await advance(h);
      }
    };
    await skipSame();
    while (total > budget) {
      let best: (typeof heads)[number] | undefined;
      for (const h of heads) {
        if (h.cursor && (!best || lruOrder(h.cursor.value as EntryMeta, best.cursor!.value as EntryMeta) < 0)) best = h;
      }
      if (!best) break;
      const victim = best.cursor!.value as EntryMeta;
      entries.delete(victim.key);
      bodies.delete(victim.key);
      addDelta(deltas, victim.resourceId, -1, -victim.size, 0); // 候補は pinned = 0 だけ
      total -= victim.size;
      await advance(best);
      await skipSame();
    }
    return total;
  };

  /**
   * putEntry と putGlyphPart の共通の後半（C-O7）。同じ tx の中で、退避・Entry の書き込み・Resource の数の更新を行う。
   * target は meta.resourceId の Resource、old は同じキーの保存済みの Entry（どちらも同じ tx で読んだもの）。
   * 書く pinned は meta.pinned と old.pinned の論理和（m4-t1・L1・R6。上流を待つ間の setPinned を戻さない）
   */
  const commitEntry = async (
    t: IDBTransaction, target: ResourceMeta, old: EntryMeta | undefined,
    meta: EntryMeta, body: StoredBody, evict: EvictionScope[],
  ): Promise<{ saved: boolean }> => {
    const resources = t.objectStore(S_RESOURCES);
    const entries = t.objectStore(S_ENTRIES);
    const bodies = t.objectStore(S_BODIES);

    const newSize = meta.size;
    const pinned: 0 | 1 = meta.pinned === 1 || old?.pinned === 1 ? 1 : 0;
    // 旧 putItemWithEviction と同じ: maxBytes が 0、または単体で maxBytes を超える応答は保存しない。
    // どれか 1 要素でも「保存しない」なら保存しない
    const willSave = evict.every((e) => e.maxBytes > 0 && newSize <= e.maxBytes);
    const deltas = new Map<string, Delta>();
    const known: ResourceMeta[] = [target];
    // totals は Resource を書く前（applyDeltas の前）に読む。全体の要素の見積もりにも使う（m4-t6）
    const totals = await loadTotals(t);

    // 退避は要素ごと（第 1 回 S4）。まず予算の見積もり（R42）: 保存済みの固定でない大きさの和 ＋ この tx で前の要素が消した分
    // － 置き換える同じキーの固定でない古い Entry（候補から外す分）。予算内なら走査しない（P7・R7'）。
    // 超えるときだけ cursor を併合して古い順に消す（今の getAll の実装と同じ集合を消す）
    for (const scope of evict) {
      if (scope.resourceIds === undefined) {
        // 全体の要素（m4-t6・第 2 回 M1）: totals.bytes − totals.pinnedBytes ＋ この tx の全 Resource の deltas.bytes の和
        // −（保存し、old が固定でないなら old.size）。cursor でも同じキーを飛ばす
        let total = totals.bytes - totals.pinnedBytes;
        for (const d of deltas.values()) total += d.bytes;
        if (willSave && old && old.pinned === 0) total -= old.size;
        const budget = willSave ? scope.maxBytes - newSize : scope.maxBytes;
        if (total <= budget) continue;
        await evictByCursor(t, [{ index: IX_GLOBAL_LRU, range: GLOBAL_UNPINNED }], total, budget,
          willSave ? meta.key : undefined, deltas);
        continue;
      }
      const ids = scope.resourceIds.filter((id, i, xs) => xs.indexOf(id) === i);
      let total = 0;
      for (const id of ids) {
        let r = known.find((x) => x.id === id);
        if (!r) {
          r = (await req2p(resources.get(id))) as ResourceMeta | undefined;
          if (r) known.push(r);
        }
        if (r) total += r.bytes - r.pinnedBytes;
        total += deltas.get(id)?.bytes ?? 0;
      }
      if (willSave && old && old.pinned === 0 && ids.indexOf(old.resourceId) >= 0) total -= old.size;
      const budget = willSave ? scope.maxBytes - newSize : scope.maxBytes;
      if (total <= budget) continue;
      await evictByCursor(t, ids.map((id) => ({ index: IX_LRU, range: IDBKeyRange.bound([id, 0], [id, 0, []]) })), total, budget,
        willSave ? meta.key : undefined, deltas);
    }

    if (willSave) {
      // 保存するときは同じキーを候補から外したので、old は消えていない
      if (old) {
        addDelta(deltas, meta.resourceId, 0, newSize - old.size,
          (pinned === 1 ? newSize : 0) - (old.pinned === 1 ? old.size : 0));
      } else {
        addDelta(deltas, meta.resourceId, 1, newSize, pinned === 1 ? newSize : 0);
      }
      entries.put({ ...meta, pinned });
      bodies.put(body);
    }

    await applyDeltas(t, deltas, known, totals);
    return { saved: willSave };
  };

  const store: Store = {
    getSource: (id) => getOne<SourceRecord>(S_SOURCES, id),
    putSource: (record) => tx([S_SOURCES], 'readwrite', (t) => {
      t.objectStore(S_SOURCES).put(record);
    }),
    listSources: () => tx([S_SOURCES], 'readonly', async (t) => {
      const all = (await req2p(t.objectStore(S_SOURCES).getAll())) as SourceRecord[];
      return all.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }),
    deleteSource: (id) => tx([S_SOURCES, S_CREDENTIALS, S_REGIONS], 'readwrite', async (t) => {
      t.objectStore(S_SOURCES).delete(id);
      t.objectStore(S_CREDENTIALS).delete(id);
      const regions = t.objectStore(S_REGIONS);
      const keys = await req2p(regions.index(IX_REGION_SOURCE).getAllKeys(id));
      for (const k of keys) regions.delete(k);
    }),

    getResource: (id) => getOne<ResourceMeta>(S_RESOURCES, id),
    listResources: () => tx([S_RESOURCES], 'readonly', (t) =>
      req2p(t.objectStore(S_RESOURCES).getAll()) as Promise<ResourceMeta[]>),
    resourcesBySource: (sourceId) => tx([S_RESOURCES], 'readonly', (t) =>
      req2p(t.objectStore(S_RESOURCES).index(IX_SOURCE_IDS).getAll(sourceId)) as Promise<ResourceMeta[]>),
    resourcesByRangeOnlySource: (sourceId) => tx([S_RESOURCES], 'readonly', (t) =>
      req2p(t.objectStore(S_RESOURCES).index(IX_RANGE_ONLY).getAll(sourceId)) as Promise<ResourceMeta[]>),
    createResource: (meta) => tx([S_RESOURCES], 'readwrite', async (t) => {
      await req2p(t.objectStore(S_RESOURCES).add({ ...meta, count: 0, bytes: 0, pinnedBytes: 0 }));
    }),
    replaceResource: (meta) => tx([S_RESOURCES], 'readwrite', async (t) => {
      const s = t.objectStore(S_RESOURCES);
      const saved = (await req2p(s.get(meta.id))) as ResourceMeta | undefined;
      if (!saved) throw new DOMException(`Resource "${meta.id}" not found`, 'NotFoundError');
      s.put({ ...meta, count: saved.count, bytes: saved.bytes, pinnedBytes: saved.pinnedBytes });
    }),
    patchResource: (id, fn) => tx([S_RESOURCES], 'readwrite', async (t) => {
      const s = t.objectStore(S_RESOURCES);
      const saved = (await req2p(s.get(id))) as ResourceMeta | undefined;
      if (!saved) return undefined;
      const next = fn(saved);
      if (!next) return undefined;
      const out: ResourceMeta = { ...next, id: saved.id, count: saved.count, bytes: saved.bytes, pinnedBytes: saved.pinnedBytes };
      s.put(out);
      return out;
    }),
    // 消す前に同じ tx で Resource を読み、その数を totals から引く（F30・m4-t6）
    deleteResource: (id) => tx([S_RESOURCES, S_ENTRIES, S_BODIES, S_KV], 'readwrite', async (t) => {
      const totals = await loadTotals(t);
      const saved = (await req2p(t.objectStore(S_RESOURCES).get(id))) as ResourceMeta | undefined;
      t.objectStore(S_RESOURCES).delete(id);
      t.objectStore(S_ENTRIES).delete(entryRange(id));
      t.objectStore(S_BODIES).delete(entryRange(id));
      saveTotals(t, totals, saved ? { count: -saved.count, bytes: -saved.bytes, pinnedBytes: -saved.pinnedBytes } : ZERO);
    }),
    clearEntries: (resourceId) => tx([S_RESOURCES, S_ENTRIES, S_BODIES, S_KV], 'readwrite', async (t) => {
      // totals は Resource を書く前に読む（無いときの resources の和を、この tx の書き込みの前の値で作る）
      const totals = await loadTotals(t);
      t.objectStore(S_ENTRIES).delete(entryRange(resourceId));
      t.objectStore(S_BODIES).delete(entryRange(resourceId));
      const s = t.objectStore(S_RESOURCES);
      const saved = (await req2p(s.get(resourceId))) as ResourceMeta | undefined;
      if (saved) s.put({ ...saved, count: 0, bytes: 0, pinnedBytes: 0 });
      saveTotals(t, totals, saved ? { count: -saved.count, bytes: -saved.bytes, pinnedBytes: -saved.pinnedBytes } : ZERO);
    }),

    getEntry: (key) => tx([S_ENTRIES, S_BODIES], 'readonly', async (t) => {
      const [meta, body] = await Promise.all([
        req2p(t.objectStore(S_ENTRIES).get(key)) as Promise<EntryMeta | undefined>,
        req2p(t.objectStore(S_BODIES).get(key)),
      ]);
      // 古い形（Blob を持つ）の本体は読めないので miss（次の取得で作り直す）
      const entryBody = fromStoredBody(body);
      return meta && entryBody ? { meta, body: entryBody } : undefined;
    }),
    hasEntries: (keys) => tx([S_ENTRIES], 'readonly', (t) => {
      const entries = t.objectStore(S_ENTRIES);
      // メタだけで判定する（m4-t1・I12・R43）。古い形の本体は表示の要求の getEntry が miss にして取り直す
      return Promise.all(keys.map(async (k) => (await req2p(entries.getKey(k))) !== undefined));
    }),
    touch: (key, accessedAt) => tx([S_ENTRIES], 'readwrite', async (t) => {
      const s = t.objectStore(S_ENTRIES);
      const meta = (await req2p(s.get(key))) as EntryMeta | undefined;
      if (meta) s.put({ ...meta, accessedAt });
    }),
    putEntry: (meta, body, evict) => entryKeyError(meta, body.key)
    ?? txAfter(toStoredBody(body), [S_RESOURCES, S_ENTRIES, S_BODIES, S_KV], 'readwrite', async (t, stored) => {
      const target = (await req2p(t.objectStore(S_RESOURCES).get(meta.resourceId))) as ResourceMeta | undefined;
      // 消された Resource へ書き込みを残さない（第 1 回 O-7）
      if (!target) return { saved: false };
      const old = (await req2p(t.objectStore(S_ENTRIES).get(meta.key))) as EntryMeta | undefined;
      return commitEntry(t, target, old, meta, stored, evict);
    }),
    putGlyphPart: (meta, part, blob, headers, evict) => store.putGlyphParts(meta, [{ part, blob, fetchedAt: meta.fetchedAt }], headers, evict),
    putGlyphParts: (meta, input, headers, evict) => {
      // 同じ範囲は後のものが勝つ（並びは最後に現れた順）
      const fresh = input.filter((p, i) => input.findIndex((q, j) => j > i && q.part === p.part) < 0);
      if (fresh.length === 0) return Promise.resolve({ saved: false });
      // キーの検査を先に: 通ったときだけ Blob の変換（prep）を始める
      const keyError = entryKeyError(meta, meta.key);
      if (keyError) return keyError;
      // 新しい部分は tx の前に ArrayBuffer にする（同じ範囲は後のものが勝つ並びのまま）
      const prep = Promise.all(fresh.map(async (p) => ({ ...p, ...(await readBlob(p.blob)) })));
      return txAfter(prep, [S_RESOURCES, S_ENTRIES, S_BODIES, S_KV], 'readwrite', async (t, freshData) => {
        const target = (await req2p(t.objectStore(S_RESOURCES).get(meta.resourceId))) as ResourceMeta | undefined;
        if (!target) return { saved: false };
        const [old, oldRaw] = await Promise.all([
          req2p(t.objectStore(S_ENTRIES).get(meta.key)) as Promise<EntryMeta | undefined>,
          req2p(t.objectStore(S_BODIES).get(meta.key)),
        ]);
        // 残す部分を本体の中の順に詰め直し、新しい部分を最後に足す（同じ範囲の古い部分は落とす。空きを残さない）。
        // 古い形（Blob を持つ）の本体は読めないので、その部分は残さない（作り直す）
        const oldBody = isStoredBody(oldRaw) ? oldRaw : undefined;
        const replaced = new Set(freshData.map((p) => p.part));
        const oldParts = oldBody?.parts && old
          ? Object.entries(oldBody.parts).filter(([name]) => !replaced.has(name))
          : [];
        // 本体を超える部分が 1 つでもあれば全体を読めないものとして kept を空にし、新しい部分だけで作り直す（例外にしない）
        let kept = oldParts.every(([, p]) => p.offset + p.length <= oldBody!.data.byteLength) ? oldParts : [];
        // 上限を超える結合レコード（m4-t1・L3・R7）: 連結後の大きさが要素のどれかの maxBytes を超えるとき、残す部分を
        // fetchedAt の昇順（同値は本体の中の順）に落として収める。新しい部分だけで超えるときは落とさない（commitEntry が保存しない）
        const limit = evict.reduce((m, e) => Math.min(m, e.maxBytes), Infinity);
        const freshSize = freshData.reduce((n, p) => n + p.data.byteLength, 0);
        let keptSize = kept.reduce((n, [, p]) => n + p.length, 0);
        if (freshSize + keptSize > limit && freshSize <= limit) {
          const byAge = [...kept].sort((x, y) => x[1].fetchedAt - y[1].fetchedAt || x[1].offset - y[1].offset);
          while (freshSize + keptSize > limit && byAge.length > 0) keptSize -= byAge.shift()![1].length;
          kept = byAge;
        }
        const packed = packGlyph(oldBody?.data, kept, freshData);
        const type = freshData[freshData.length - 1].type;
        const next: EntryMeta = {
          ...meta,
          size: packed.data.byteLength,
          // 最も新しい部分の fetchedAt（R7。新しい部分がある間はレコードを掃除の対象にしない）
          fetchedAt: newestPart(packed.parts),
        };
        return commitEntry(t, target, old, next, { key: meta.key, data: packed.data, type, headers, parts: packed.parts }, evict);
      });
    },

    deleteEntries: (keys, opts = {}) => tx([S_RESOURCES, S_ENTRIES, S_BODIES, S_KV], 'readwrite', async (t) => {
      const entries = t.objectStore(S_ENTRIES);
      const bodies = t.objectStore(S_BODIES);
      const deltas = new Map<string, Delta>();
      let n = 0;
      const unique = keys.filter((k, i, xs) => xs.indexOf(k) === i);
      const metas = await Promise.all(unique.map((k) => req2p(entries.get(k)) as Promise<EntryMeta | undefined>));
      for (const m of metas) {
        if (!m) continue;
        // tx の中で読んだメタで条件を見直す（一覧の後の固定・取り直しを消さない。第 1 回 M11）
        if (opts.unpinnedOnly && m.pinned === 1) continue;
        if (opts.fetchedBefore !== undefined && m.fetchedAt >= opts.fetchedBefore) continue;
        entries.delete(m.key);
        bodies.delete(m.key);
        addDelta(deltas, m.resourceId, -1, -m.size, m.pinned === 1 ? -m.size : 0);
        n++;
      }
      await applyDeltas(t, deltas);
      return n;
    }),
    setPinned: (keys, pinned) => tx([S_RESOURCES, S_ENTRIES, S_KV], 'readwrite', async (t) => {
      const entries = t.objectStore(S_ENTRIES);
      const deltas = new Map<string, Delta>();
      let n = 0;
      const unique = keys.filter((k, i, xs) => xs.indexOf(k) === i);
      const metas = await Promise.all(unique.map((k) => req2p(entries.get(k)) as Promise<EntryMeta | undefined>));
      for (const m of metas) {
        if (!m || m.pinned === pinned) continue;
        entries.put({ ...m, pinned });
        addDelta(deltas, m.resourceId, 0, 0, pinned === 1 ? m.size : -m.size);
        n++;
      }
      await applyDeltas(t, deltas);
      return n;
    }),
    listUnpinnedBefore: (before, limit, after) => tx([S_ENTRIES], 'readonly', async (t) => {
      const metas: EntryMeta[] = [];
      if (limit <= 0) return { metas };
      const pos = Array.isArray(after) ? (after as [number, string]) : undefined;
      const lower = pos ? [0, pos[0]] : [0, -Infinity];
      const req = t.objectStore(S_ENTRIES).index(IX_FETCHED).openCursor(IDBKeyRange.bound(lower, [0, before], false, true));
      let cursor = await cursorStep(req);
      // 続きの位置（[fetchedAt, key]）まで飛ばす。同じ fetchedAt で key が後のものから読む
      while (cursor && pos && (cursor.value as EntryMeta).fetchedAt === pos[0] && String(cursor.primaryKey) <= pos[1]) {
        const next = cursorStep(req);
        if (String(cursor.primaryKey) === pos[1]) cursor.continue();
        else cursor.continuePrimaryKey([0, pos[0]], pos[1]);
        cursor = await next;
      }
      while (cursor && metas.length < limit) {
        metas.push(cursor.value as EntryMeta);
        if (metas.length >= limit) break;
        const next = cursorStep(req);
        cursor.continue();
        cursor = await next;
      }
      const last = metas[metas.length - 1];
      return metas.length >= limit && last ? { metas, next: [last.fetchedAt, last.key] } : { metas };
    }),
    entriesOf: (resourceId, limit, after) => tx([S_ENTRIES], 'readonly', async (t) => {
      if (limit <= 0) return { metas: [] };
      const range = after === undefined
        ? entryRange(resourceId)
        : IDBKeyRange.bound(after, `${resourceId}\x01`, true, true);
      const metas = (await req2p(t.objectStore(S_ENTRIES).getAll(range, limit))) as EntryMeta[];
      return metas.length >= limit ? { metas, next: metas[metas.length - 1].key } : { metas };
    }),
    entriesAtZoom: (resourceId, z) => tx([S_ENTRIES], 'readonly', (t) =>
      req2p(t.objectStore(S_ENTRIES).index(IX_ZOOM).getAll([resourceId, z])) as Promise<EntryMeta[]>),
    pruneGlyphParts: (key, before) => tx([S_RESOURCES, S_ENTRIES, S_BODIES, S_KV], 'readwrite', async (t) => {
      const entries = t.objectStore(S_ENTRIES);
      const bodies = t.objectStore(S_BODIES);
      const [meta, raw] = await Promise.all([
        req2p(entries.get(key)) as Promise<EntryMeta | undefined>,
        req2p(bodies.get(key)),
      ]);
      if (!meta || meta.pinned === 1 || !isStoredBody(raw) || !raw.parts) return 0;
      const all = Object.entries(raw.parts);
      // 本体を超える部分を持つレコードは読めないので触らない（次の putGlyphParts が作り直す）
      if (!all.every(([, p]) => p.offset + p.length <= raw.data.byteLength)) return 0;
      const kept = all.filter(([, p]) => p.fetchedAt >= before);
      const dropped = all.length - kept.length;
      if (dropped === 0) return 0;
      const deltas = new Map<string, Delta>();
      if (kept.length === 0) {
        entries.delete(key);
        bodies.delete(key);
        addDelta(deltas, meta.resourceId, -1, -meta.size, 0);
      } else {
        const packed = packGlyph(raw.data, kept, []);
        const size = packed.data.byteLength;
        entries.put({ ...meta, size, fetchedAt: newestPart(packed.parts) });
        bodies.put({ ...raw, data: packed.data, parts: packed.parts });
        addDelta(deltas, meta.resourceId, 0, size - meta.size, 0);
      }
      await applyDeltas(t, deltas);
      return dropped;
    }),

    getRegion: (id) => getOne<RegionRecord>(S_REGIONS, id),
    putRegion: (r) => tx([S_REGIONS], 'readwrite', (t) => {
      t.objectStore(S_REGIONS).put(r);
    }),
    patchRegion: (id, fn) => tx([S_REGIONS], 'readwrite', async (t) => {
      const s = t.objectStore(S_REGIONS);
      const saved = (await req2p(s.get(id))) as RegionRecord | undefined;
      if (!saved) return undefined;
      const next = fn(saved);
      if (!next) return undefined;
      // id は保存済みの値のまま（patchResource と同じ）
      const out: RegionRecord = { ...next, id: saved.id };
      s.put(out);
      return out;
    }),
    listRegions: (sourceId) => tx([S_REGIONS], 'readonly', (t) =>
      req2p(t.objectStore(S_REGIONS).index(IX_REGION_SOURCE).getAll(sourceId)) as Promise<RegionRecord[]>),
    deleteRegion: (id) => tx([S_REGIONS], 'readwrite', (t) => {
      t.objectStore(S_REGIONS).delete(id);
    }),

    getCredentials: (sourceId) => tx([S_CREDENTIALS], 'readonly', async (t) => {
      const rec = (await req2p(t.objectStore(S_CREDENTIALS).get(sourceId))) as (Credentials & { sourceId: string }) | undefined;
      if (!rec) return undefined;
      const c: Credentials = {};
      if (rec.query) c.query = rec.query;
      if (rec.headers) c.headers = rec.headers;
      return c;
    }),
    putCredentials: (sourceId, c) => tx([S_CREDENTIALS], 'readwrite', (t) => {
      t.objectStore(S_CREDENTIALS).put({ ...c, sourceId });
    }),

    kvGet: (key) => tx([S_KV], 'readonly', async (t) => {
      const rec = (await req2p(t.objectStore(S_KV).get(key))) as { key: string; value: unknown } | undefined;
      return rec?.value;
    }),
    kvPut: (key, value) => tx([S_KV], 'readwrite', (t) => {
      t.objectStore(S_KV).put({ key, value });
    }),

    getTotals: () => tx([S_RESOURCES, S_KV], 'readonly', (t) => loadTotals(t)),
    evictGlobal: (bytes) => {
      if (!(bytes > 0)) return Promise.resolve(0);
      return tx([S_RESOURCES, S_ENTRIES, S_BODIES, S_KV], 'readwrite', async (t) => {
        const totals = await loadTotals(t);
        const deltas = new Map<string, Delta>();
        const req = t.objectStore(S_ENTRIES).index(IX_GLOBAL_LRU).openCursor(GLOBAL_UNPINNED);
        let cursor = await cursorStep(req);
        let freed = 0;
        let n = 0;
        while (cursor && freed < bytes) {
          const victim = cursor.value as EntryMeta;
          t.objectStore(S_ENTRIES).delete(victim.key);
          t.objectStore(S_BODIES).delete(victim.key);
          addDelta(deltas, victim.resourceId, -1, -victim.size, 0);
          freed += victim.size;
          n++;
          const next = cursorStep(req);
          cursor.continue();
          cursor = await next;
        }
        await applyDeltas(t, deltas, [], totals);
        return n;
      });
    },

    close: () => {
      if (db) db.close();
      db = undefined;
    },
  };

  try {
    await connect();
  } catch (err) {
    // blocked は止まらずに返す（以後の呼び出しが BlockedError を返し、相手が閉じれば成功する）
    if (!blocked) throw err;
  }
  return store;
};
