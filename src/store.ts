// IndexedDB の全操作と、保存の型の正本（#37・仕様 §5.2・§5.4）。
// 単一 DB WeiwudiStore（version 1）。旧 DB には触らない（移行は m4 の migrate.ts）。
//
// 決まり:
// - モジュール変数を持たない。接続などの状態は openStore() が返す Store の中に閉じる（context が 1 つ持つ）
// - reject する値は tx.error・req.error・投げられた DOMException（Event を reject しない。仕様 §9）
// - Entry の増減と同じ tx で Resource の count・bytes・pinnedBytes を直す
import type { TileBox } from './tile_math';
import type { StoredSpec, StyleSpec } from './spec';
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

/** putEntry の退避の 1 要素。cacheMaxBytes を持つ Source 1 つ分（§7.1） */
export interface EvictionScope {
  resourceIds: string[];
  maxBytes: number;
}

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
  /** getKey だけ */
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

  getCredentials(sourceId: string): Promise<Credentials | undefined>;
  putCredentials(sourceId: string, c: Credentials): Promise<void>;

  kvGet(key: string): Promise<unknown>;
  kvPut(key: string, value: unknown): Promise<void>;

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
    s.createIndex('pinned_accessedAt', ['pinned', 'accessedAt']);
    s.createIndex('pinned_fetchedAt', ['pinned', 'fetchedAt']);
    s.createIndex('resourceId_z', ['resourceId', 'z']);
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
  const tx = <T>(names: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => T | Promise<T>): Promise<T> => {
    if (db) return runTx(db, names, mode, fn);
    return connect().then((conn) => runTx(conn, names, mode, fn));
  };

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

  /**
   * putEntry と putGlyphPart の共通の後半（C-O7）。同じ tx の中で、退避・Entry の書き込み・Resource の数の更新を行う。
   * target は meta.resourceId の Resource、old は同じキーの保存済みの Entry（どちらも同じ tx で読んだもの）
   */
  const commitEntry = async (
    t: IDBTransaction, target: ResourceMeta, old: EntryMeta | undefined,
    meta: EntryMeta, body: EntryBody, evict: EvictionScope[],
  ): Promise<{ saved: boolean }> => {
    const resources = t.objectStore(S_RESOURCES);
    const entries = t.objectStore(S_ENTRIES);
    const bodies = t.objectStore(S_BODIES);

    const newSize = meta.size;
    // 旧 putItemWithEviction と同じ: maxBytes が 0、または単体で maxBytes を超える応答は保存しない。
    // どれか 1 要素でも「保存しない」なら保存しない
    const willSave = evict.every((e) => e.maxBytes > 0 && newSize <= e.maxBytes);
    const deltas = new Map<string, Delta>();

    // 退避は要素ごと（第 1 回 S4）。各要素の resourceIds の pinned = 0 の Entry を併合し、
    // accessedAt 昇順・同値はキー昇順で、要素の予算に収まるまで消す。前の要素が消した Entry は、同じ tx の
    // 要求が出した順に処理されるので後の getAll には現れない（二重に数えない）
    for (const scope of evict) {
      const ids = scope.resourceIds.filter((id, i, xs) => xs.indexOf(id) === i);
      const lists = await Promise.all(ids.map((id) =>
        req2p(entries.index(IX_LRU).getAll(IDBKeyRange.bound([id, 0], [id, 0, []]))) as Promise<EntryMeta[]>));
      const candidates = ([] as EntryMeta[]).concat(...lists)
        .filter((e) => !(willSave && e.key === meta.key))
        .sort((a, b) => a.accessedAt - b.accessedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      let total = candidates.reduce((sum, e) => sum + e.size, 0);
      const budget = willSave ? scope.maxBytes - newSize : scope.maxBytes;
      for (let i = 0; total > budget && i < candidates.length; i++) {
        const victim = candidates[i];
        entries.delete(victim.key);
        bodies.delete(victim.key);
        addDelta(deltas, victim.resourceId, -1, -victim.size, 0); // 候補は pinned = 0 だけ
        total -= victim.size;
      }
    }

    if (willSave) {
      // 保存するときは同じキーを候補から外したので、old は消えていない
      if (old) {
        addDelta(deltas, meta.resourceId, 0, newSize - old.size,
          (meta.pinned === 1 ? newSize : 0) - (old.pinned === 1 ? old.size : 0));
      } else {
        addDelta(deltas, meta.resourceId, 1, newSize, meta.pinned === 1 ? newSize : 0);
      }
      entries.put(meta);
      bodies.put(body);
    }

    // Entry の増減と同じ tx で各 Resource の count・bytes・pinnedBytes を直す
    for (const [id, d] of deltas) {
      const saved = id === target.id ? target : ((await req2p(resources.get(id))) as ResourceMeta | undefined);
      if (!saved) continue;
      resources.put({
        ...saved,
        count: saved.count + d.count,
        bytes: saved.bytes + d.bytes,
        pinnedBytes: saved.pinnedBytes + d.pinnedBytes,
      });
    }
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
    deleteResource: (id) => tx([S_RESOURCES, S_ENTRIES, S_BODIES], 'readwrite', (t) => {
      t.objectStore(S_RESOURCES).delete(id);
      t.objectStore(S_ENTRIES).delete(entryRange(id));
      t.objectStore(S_BODIES).delete(entryRange(id));
    }),
    clearEntries: (resourceId) => tx([S_RESOURCES, S_ENTRIES, S_BODIES], 'readwrite', async (t) => {
      t.objectStore(S_ENTRIES).delete(entryRange(resourceId));
      t.objectStore(S_BODIES).delete(entryRange(resourceId));
      const s = t.objectStore(S_RESOURCES);
      const saved = (await req2p(s.get(resourceId))) as ResourceMeta | undefined;
      if (saved) s.put({ ...saved, count: 0, bytes: 0, pinnedBytes: 0 });
    }),

    getEntry: (key) => tx([S_ENTRIES, S_BODIES], 'readonly', async (t) => {
      const [meta, body] = await Promise.all([
        req2p(t.objectStore(S_ENTRIES).get(key)) as Promise<EntryMeta | undefined>,
        req2p(t.objectStore(S_BODIES).get(key)) as Promise<EntryBody | undefined>,
      ]);
      return meta && body ? { meta, body } : undefined;
    }),
    hasEntries: (keys) => tx([S_ENTRIES], 'readonly', (t) => {
      const s = t.objectStore(S_ENTRIES);
      return Promise.all(keys.map(async (k) => (await req2p(s.getKey(k))) !== undefined));
    }),
    touch: (key, accessedAt) => tx([S_ENTRIES], 'readwrite', async (t) => {
      const s = t.objectStore(S_ENTRIES);
      const meta = (await req2p(s.get(key))) as EntryMeta | undefined;
      if (meta) s.put({ ...meta, accessedAt });
    }),
    putEntry: (meta, body, evict) => entryKeyError(meta, body.key) ?? tx([S_RESOURCES, S_ENTRIES, S_BODIES], 'readwrite', async (t) => {
      const target = (await req2p(t.objectStore(S_RESOURCES).get(meta.resourceId))) as ResourceMeta | undefined;
      // 消された Resource へ書き込みを残さない（第 1 回 O-7）
      if (!target) return { saved: false };
      const old = (await req2p(t.objectStore(S_ENTRIES).get(meta.key))) as EntryMeta | undefined;
      return commitEntry(t, target, old, meta, body, evict);
    }),
    putGlyphPart: (meta, part, blob, headers, evict) => store.putGlyphParts(meta, [{ part, blob, fetchedAt: meta.fetchedAt }], headers, evict),
    putGlyphParts: (meta, input, headers, evict) => {
      // 同じ範囲は後のものが勝つ（並びは最後に現れた順）
      const fresh = input.filter((p, i) => input.findIndex((q, j) => j > i && q.part === p.part) < 0);
      if (fresh.length === 0) return Promise.resolve({ saved: false });
      return entryKeyError(meta, meta.key)
      ?? tx([S_RESOURCES, S_ENTRIES, S_BODIES], 'readwrite', async (t) => {
        const target = (await req2p(t.objectStore(S_RESOURCES).get(meta.resourceId))) as ResourceMeta | undefined;
        if (!target) return { saved: false };
        const [old, oldBody] = await Promise.all([
          req2p(t.objectStore(S_ENTRIES).get(meta.key)) as Promise<EntryMeta | undefined>,
          req2p(t.objectStore(S_BODIES).get(meta.key)) as Promise<EntryBody | undefined>,
        ]);
        // 残す部分を本体の中の順に詰め直し、新しい部分を最後に足す（同じ範囲の古い部分は落とす。空きを残さない）。
        // Blob の slice と new Blob は同期なので、tx の中で IDB 以外の Promise を待たない
        const replaced = new Set(fresh.map((p) => p.part));
        const kept = oldBody?.parts && old
          ? Object.entries(oldBody.parts).filter(([name]) => !replaced.has(name)).sort((a, b) => a[1].offset - b[1].offset)
          : [];
        const pieces: Blob[] = [];
        const parts: GlyphPartIndex = {};
        let offset = 0;
        for (const [name, p] of kept) {
          pieces.push(oldBody!.blob.slice(p.offset, p.offset + p.length));
          parts[name] = { offset, length: p.length, fetchedAt: p.fetchedAt };
          offset += p.length;
        }
        for (const p of fresh) {
          pieces.push(p.blob);
          parts[p.part] = { offset, length: p.blob.size, fetchedAt: p.fetchedAt };
          offset += p.blob.size;
        }
        const type = fresh[fresh.length - 1].blob.type;
        const joined = new Blob(pieces, type ? { type } : undefined);
        const next: EntryMeta = {
          ...meta,
          size: joined.size,
          // 最も新しい部分の fetchedAt（R7。新しい部分がある間はレコードを掃除の対象にしない）
          fetchedAt: Object.values(parts).reduce((m, p) => Math.max(m, p.fetchedAt), -Infinity),
        };
        return commitEntry(t, target, old, next, { key: meta.key, blob: joined, headers, parts }, evict);
      });
    },

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
