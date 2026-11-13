// 旧 DB（1.1.x の Weiwudi・Weiwudi_<mapID>）からの移行（仕様 §14.2・m4-t7・R17〜R19・R50・R51・R59・R60）。
// 旧 DB を触るのはこのファイルだけ（legacy.ts は IndexedDB を直接触らない）。値の依存は store・constants・errors だけ
// （仕様 §3。legacy・core は import できない。F27）。地図の登録と退避の範囲は MigrateDeps で受ける（R50）。
//
// 1.1.x の形:
// - Weiwudi.mapSetting（keyPath: mapID）: /api/add の MapSetting
// - Weiwudi_<mapID>.tileCache（keyPath: z_x_y）: { z_x_y, headers, blob, epoch, accessedAt? }
//
// 状態は kv の migration（MigrationState）。maps は配列（mapID を項目名にしない。__proto__ で壊れない）。
// 旧 DB は使うたびに開いて閉じ、onversionchange でも閉じる。deleteDatabase の前に必ず自分の接続を閉じる。
import type { Context } from './context';
import type { EntryBody, EntryMeta, EvictionScope, MapSetting, ResourceMeta, Store } from './store';
import { DROPPED_HEADERS, LEGACY_PREFIX, OWN_PREFIX } from './constants';

/** 移行が受ける依存（legacy.migrationDeps が渡す。写して持たない） */
export interface MigrateDeps {
  /** legacy.registerMap（Resource は legacy.resourceOf。登録の形は legacy に 1 つ） */
  registerMap(store: Store, setting: MapSetting, t: number): Promise<void>;
  /** core.evictScopesFor */
  evictScopesFor(store: Store, resource: ResourceMeta): Promise<EvictionScope[]>;
}

export type MigrationStage = 'pending' | 'settings' | 'tiles' | 'done';
export type MigrationMapStatus = 'pending' | 'copying' | 'done' | 'failed';

export interface MigrationMap {
  mapID: string;
  status: MigrationMapStatus;
  /** そのバッチで読んだ最後の旧キー（z_x_y）。次のバッチはこの次から読む */
  lastKey?: string;
  /** 飛ばしたレコードの数（数えるだけ） */
  recordFailures: number;
  /** 続けて失敗したバッチの数（開始の失敗・Resource の無い停止・書き込みの例外。成功したバッチで 0。MAX_BATCH_FAILURES で failed） */
  batchFailures: number;
}

export interface MigrationState {
  stage: MigrationStage;
  maps: MigrationMap[];
  /** blocked などで消せなかった旧 DB の名前（SW の起動後の最初の契機で消し直す） */
  pendingDelete: string[];
  startedAt: number;
  updatedAt: number;
}

const KV_KEY = 'migration';
const SETTINGS_DB = 'Weiwudi';
const MAP_DB_PREFIX = 'Weiwudi_';
const SETTING_STORE = 'mapSetting';
const TILE_STORE = 'tileCache';
/** 1 回の契機で読む旧レコードの数 */
const BATCH = 200;
/** この数のバッチの開始の失敗で failed */
const MAX_BATCH_FAILURES = 3;
/**
 * deleteDatabase の success・blocked を待つ上限（R51）。超えたら blocked と同じ扱い（blockedDeletes に入れ、呼び出し側が
 * pendingDelete に足す）。前の削除・開く要求の後ろに並んだ要求は blocked も来ず返らないので、旧 API の clean・delete
 * （進行中の migrateStep を待つ）が止まらないように切る。値は門番が読み込みを待つ上限（hook.GATE_WAIT_MS）とそろえる
 */
export const DELETE_WAIT_MS = 3000;
const STAGES: readonly MigrationStage[] = ['pending', 'settings', 'tiles', 'done'];
const STATUSES: readonly MigrationMapStatus[] = ['pending', 'copying', 'done', 'failed'];

const mapDbName = (mapID: string): string => `${MAP_DB_PREFIX}${mapID}`;
const resourceIdOf = (mapID: string): string => `${LEGACY_PREFIX}${mapID}`;
/** 新 DB の Entry のキー（legacy.keyOf と同じ形。旧キー z_x_y は新 DB のタイルのキーの suffix と同じ形なので、そのまま使う。仕様 §5.3） */
const entryKeyOf = (mapID: string, oldKey: string): string => `${resourceIdOf(mapID)}\0${oldKey}`;
const isLegacyDbName = (name: string): boolean => name === SETTINGS_DB || name.startsWith(MAP_DB_PREFIX);
const isActive = (m: MigrationMap): boolean => m.status === 'pending' || m.status === 'copying';
const isFinite_ = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ---- 状態（kv） ----

const freshState = (now: number): MigrationState =>
  ({ stage: 'pending', maps: [], pendingDelete: [], startedAt: now, updatedAt: now });

const normalizeMap = (v: unknown): MigrationMap | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Partial<MigrationMap>;
  if (typeof o.mapID !== 'string' || STATUSES.indexOf(o.status as MigrationMapStatus) < 0) return undefined;
  const m: MigrationMap = {
    mapID: o.mapID,
    status: o.status as MigrationMapStatus,
    recordFailures: isFinite_(o.recordFailures) ? o.recordFailures : 0,
    batchFailures: isFinite_(o.batchFailures) ? o.batchFailures : 0,
  };
  if (typeof o.lastKey === 'string') m.lastKey = o.lastKey;
  return m;
};

const normalizeState = (v: unknown): MigrationState => {
  const now = Date.now();
  if (!v || typeof v !== 'object') return freshState(now);
  const o = v as Partial<MigrationState>;
  return {
    stage: STAGES.indexOf(o.stage as MigrationStage) >= 0 ? o.stage as MigrationStage : 'pending',
    maps: Array.isArray(o.maps) ? o.maps.map(normalizeMap).filter((m): m is MigrationMap => m !== undefined) : [],
    pendingDelete: Array.isArray(o.pendingDelete) ? o.pendingDelete.filter((n): n is string => typeof n === 'string') : [],
    startedAt: isFinite_(o.startedAt) ? o.startedAt : now,
    updatedAt: isFinite_(o.updatedAt) ? o.updatedAt : now,
  };
};

const readState = async (store: Store): Promise<MigrationState> => normalizeState(await store.kvGet(KV_KEY));

/**
 * 状態の読み直しと書き込みを直列にする（第 2 段・読み通し・clean の書き込みが追い越して消し合わない）。
 * fn が false を返せば書かない。fn の中で別の updateState を呼ばない
 */
const updateState = (
  ctx: Context, store: Store, fn: (s: MigrationState) => void | false,
): Promise<MigrationState> => {
  const m = ctx.maintenance;
  const run = async () => {
    const s = await readState(store);
    if (fn(s) === false) return s;
    s.updatedAt = Date.now();
    await store.kvPut(KV_KEY, s);
    return s;
  };
  const p = (m.migrationLock ?? Promise.resolve()).then(run, run);
  m.migrationLock = p.then(() => undefined, () => undefined);
  return p;
};

const addPending = (s: MigrationState, name: string): void => {
  if (s.pendingDelete.indexOf(name) < 0) s.pendingDelete.push(name);
};

const isForgotten = (ctx: Context, mapID: string): boolean => ctx.maintenance.forgotten?.has(mapID) === true;

/** その地図の項目を直す（忘れた地図は書かない。clean・delete の後に戻さない） */
const patchMap = (ctx: Context, store: Store, mapID: string, fn: (e: MigrationMap, s: MigrationState) => void) =>
  updateState(ctx, store, (s) => {
    if (isForgotten(ctx, mapID)) return false;
    const e = s.maps.find((x) => x.mapID === mapID);
    if (!e) return false;
    fn(e, s);
  });

const remember = (ctx: Context, s: MigrationState): void => {
  const m = ctx.maintenance;
  m.settingsDone = s.stage === 'tiles' || s.stage === 'done';
  if (s.stage === 'done') {
    m.migrated = true;
    m.failedMaps = new Set(s.maps.filter((x) => x.status === 'failed').map((x) => x.mapID));
  }
};

// ---- 旧 DB ----

/** 旧 DB の名前の一覧。indexedDB.databases() が無い環境（古い Firefox）では undefined（R17） */
const listLegacyDbs = async (): Promise<string[] | undefined> => {
  if (typeof indexedDB.databases !== 'function') return undefined;
  try {
    const list = await indexedDB.databases();
    return list.map((d) => d.name).filter((n): n is string => typeof n === 'string' && isLegacyDbName(n));
  } catch (_e) {
    return undefined;
  }
};

/**
 * 旧 DB を消す。blocked・失敗なら待たずに返す（呼び出し側が pendingDelete に足す）。success も blocked も
 * DELETE_WAIT_MS のうちに来なければ blocked として返す。自分の接続は閉じてから呼ぶ
 */
const deleteLegacyDb = (ctx: Context, name: string): Promise<'deleted' | 'blocked' | 'failed'> =>
  new Promise((resolve) => {
    const m = ctx.maintenance;
    // 同じ名前の削除が待ちのまま: 新しい要求はその後ろに並んで blocked も来ないので出さない
    if (m.blockedDeletes?.has(name)) {
      resolve('blocked');
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.deleteDatabase(name);
    } catch (_e) {
      resolve('failed');
      return;
    }
    // 待ちの削除は後で通る。その間に同じ名前を開くと削除の後ろに並んで止まるので、開かない印にする
    const pend = () => {
      (m.blockedDeletes ??= new Set()).add(name);
      resolve('blocked');
    };
    const timer = setTimeout(pend, DELETE_WAIT_MS);
    req.onsuccess = () => {
      clearTimeout(timer);
      m.blockedDeletes?.delete(name);
      resolve('deleted');
    };
    req.onerror = () => {
      clearTimeout(timer);
      // 上限の後に失敗が来たら、もう待ちではない（印を外す。pendingDelete は残り、次の起動で消し直す）
      m.blockedDeletes?.delete(name);
      resolve('failed');
    };
    req.onblocked = () => {
      clearTimeout(timer);
      pend();
    };
  });

/**
 * 旧 DB を版なしで開く。無かった（自分で作った）ら閉じて消し、undefined を返す（R17）。
 * 削除が待ちになっている名前は開かない（削除の後ろに並んで止まる）
 */
const openExisting = (ctx: Context, name: string): Promise<IDBDatabase | undefined> => {
  if (ctx.maintenance.blockedDeletes?.has(name)) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let created = false;
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(name);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = (ev) => {
      if (ev.oldVersion === 0) created = true;
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      if (!created) {
        resolve(db);
        return;
      }
      db.close();
      void deleteLegacyDb(ctx, name).then(() => resolve(undefined));
    };
    req.onerror = () => reject(req.error);
  });
};

const getAllSettings = (db: IDBDatabase): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const t = db.transaction([SETTING_STORE], 'readonly');
    const req = t.objectStore(SETTING_STORE).getAll();
    t.oncomplete = () => resolve(req.result as unknown[]);
    t.onabort = () => reject(t.error ?? req.error);
  });

interface OldRecord {
  key: string;
  value: unknown;
}

/** after の次から limit 件を読む（lowerBound(after, true)）。尽きたら exhausted */
const readBatch = (db: IDBDatabase, after: string | undefined, limit: number) =>
  new Promise<{ records: OldRecord[]; exhausted: boolean }>((resolve, reject) => {
    const t = db.transaction([TILE_STORE], 'readonly');
    const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
    const req = t.objectStore(TILE_STORE).openCursor(range);
    const records: OldRecord[] = [];
    let exhausted = false;
    req.onsuccess = () => {
      const c = req.result;
      if (!c) {
        exhausted = true;
        return;
      }
      records.push({ key: String(c.primaryKey), value: c.value });
      if (records.length < limit) c.continue();
    };
    t.oncomplete = () => resolve({ records, exhausted });
    t.onabort = () => reject(t.error ?? req.error);
  });

const getOld = (db: IDBDatabase, key: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const t = db.transaction([TILE_STORE], 'readonly');
    const req = t.objectStore(TILE_STORE).get(key);
    t.oncomplete = () => resolve(req.result);
    t.onabort = () => reject(t.error ?? req.error);
  });

/** 旧レコードを消す（新 DB への書き込みとは別の tx） */
const deleteOld = (db: IDBDatabase, keys: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    if (keys.length === 0) {
      resolve();
      return;
    }
    const t = db.transaction([TILE_STORE], 'readwrite');
    const s = t.objectStore(TILE_STORE);
    for (const k of keys) s.delete(k);
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error);
  });

// ---- 変換 ----

/** 名前を小文字にし、DROPPED_HEADERS と x-weiwudi-* を落とす（core.copyHeaders と同じ規則） */
const migrateHeaders = (h: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!h || typeof h !== 'object') return out;
  for (const [name, value] of Object.entries(h as Record<string, unknown>)) {
    const n = name.toLowerCase();
    if (typeof value !== 'string' || n === '__proto__') continue;
    if (DROPPED_HEADERS.indexOf(n) >= 0 || n.startsWith(OWN_PREFIX)) continue;
    out[n] = value;
  }
  return out;
};

const TILE_KEY = /^(\d+)_(\d+)_(\d+)$/;

/**
 * 旧レコード → 新 DB の Entry。blob が無い・キーや epoch が読めない・arrayBuffer() の失敗は undefined
 * （1 レコードの失敗。数えて飛ばす）。本体は tx の外で ArrayBuffer にする
 */
const convert = async (mapID: string, oldKey: string, value: unknown): Promise<{ meta: EntryMeta; body: EntryBody } | undefined> => {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { blob?: unknown; epoch?: unknown; accessedAt?: unknown; headers?: unknown };
  const coord = TILE_KEY.exec(oldKey);
  if (!coord || !(v.blob instanceof Blob) || !isFinite_(v.epoch)) return undefined;
  const blob = v.blob;
  let data: ArrayBuffer;
  try {
    data = await blob.arrayBuffer();
  } catch (_e) {
    return undefined;
  }
  const headers = migrateHeaders(v.headers);
  const key = entryKeyOf(mapID, oldKey);
  const meta: EntryMeta = {
    key,
    resourceId: resourceIdOf(mapID),
    z: Number(coord[1]),
    x: Number(coord[2]),
    y: Number(coord[3]),
    size: blob.size,
    fetchedAt: v.epoch,
    accessedAt: isFinite_(v.accessedAt) ? v.accessedAt : v.epoch,
    pinned: 0,
  };
  if (headers['content-type'] !== undefined) meta.contentType = headers['content-type'];
  return { meta, body: { key, blob: new Blob([data], { type: blob.type }), headers } };
};

// ---- 第 1 段（settings） ----

const copySettings = async (ctx: Context, deps: MigrateDeps): Promise<void> => {
  const store = await ctx.store();
  // 起動後の点検（R59。やり直すかの判定だけ）を先に済ませる。旧 API の最初の要求は契機（runMaintenance）より先に
  // ここへ来るので、done のまま読むと現れた旧 DB の mapSetting を見ずに migrated にしてしまう
  await ensureBooted(ctx, store);
  const prev = await readState(store);
  if (prev.stage === 'tiles' || prev.stage === 'done') {
    remember(ctx, prev);
    return;
  }
  const names = await listLegacyDbs();
  // pendingDelete の名前（消し終えた後の残り）は開かず、消し直し（retryPendingDeletes）に任せる。やり直し（R59）では
  // 前の SW の削除が裏で並んだままのことがあり、開く・消すとその後ろに並んで旧 API の最初の要求が止まる
  const pending = (name: string) => prev.pendingDelete.indexOf(name) >= 0;
  let settings: unknown[] = [];
  let hadSettingsDb = false;
  if ((!names || names.indexOf(SETTINGS_DB) >= 0) && !pending(SETTINGS_DB)) {
    const db = await openExisting(ctx, SETTINGS_DB);
    if (db) {
      hadSettingsDb = true;
      try {
        // store の無い Weiwudi（#47 の壊れた DB）は空
        if (db.objectStoreNames.contains(SETTING_STORE)) settings = await getAllSettings(db);
      } finally {
        db.close();
      }
    }
  }
  if (hadSettingsDb) await updateState(ctx, store, (s) => { s.stage = 'settings'; });

  const t = Date.now();
  const ids: string[] = [];
  for (const raw of settings) {
    const s = raw as MapSetting | undefined;
    if (!s || typeof s.mapID !== 'string' || ids.indexOf(s.mapID) >= 0) continue;
    ids.push(s.mapID);
    // NUL を含む mapID は add が拒否する名前なので登録しない（failed にして旧 DB に残す。R19）
    if (s.mapID.indexOf('\0') >= 0) continue;
    // 既に sources にあれば触らない（新しい版で先に add した地図を上書きしない）
    if (!(await store.getSource(resourceIdOf(s.mapID)))) await deps.registerMap(store, s, t);
  }

  // やり直し（R59）でも failed の地図は failed のまま残す（その地図だけ読み通しを続ける）
  const failed = prev.maps.filter((x) => x.status === 'failed');
  const maps: MigrationMap[] = ids.map((mapID) => {
    const kept = failed.find((x) => x.mapID === mapID);
    if (kept) return kept;
    let status: MigrationMapStatus = 'pending';
    if (mapID.indexOf('\0') >= 0) status = 'failed';
    else if (isForgotten(ctx, mapID) || pending(mapDbName(mapID)) || (names && names.indexOf(mapDbName(mapID)) < 0)) status = 'done';
    return { mapID, status, recordFailures: 0, batchFailures: 0 };
  });
  for (const f of failed) if (ids.indexOf(f.mapID) < 0) maps.push(f);

  // mapSetting に無い Weiwudi_<mapID> のうち、sources に地図があるもの（移行の後に Weiwudi_<mapID> だけが残った・
  // 作り直された）は移す。sources にも無いもの（孤児）は配信できないのでその場で消す（PR #103 L2）
  const blocked: string[] = [];
  for (const name of names ?? []) {
    if (name === SETTINGS_DB || pending(name)) continue;
    const mapID = name.slice(MAP_DB_PREFIX.length);
    if (maps.some((x) => x.mapID === mapID)) continue;
    if (mapID.indexOf('\0') < 0 && !isForgotten(ctx, mapID) && (await store.getSource(resourceIdOf(mapID)))) {
      maps.push({ mapID, status: 'pending', recordFailures: 0, batchFailures: 0 });
      continue;
    }
    if ((await deleteLegacyDb(ctx, name)) !== 'deleted') blocked.push(name);
  }

  // 旧 DB が 1 つも無ければ（新しく入れた利用者）、kv に書かずにメモリだけで完了する（消すものが無い。次の SW も
  // databases() を 1 回見るだけ。R-t7-3）
  if (!hadSettingsDb && maps.length === 0 && blocked.length === 0 && prev.pendingDelete.length === 0) {
    remember(ctx, { ...prev, stage: 'done' });
    return;
  }
  const s = await updateState(ctx, store, (st) => {
    st.maps = maps;
    for (const name of blocked) addPending(st, name);
    // 旧 DB が無く地図も無ければ、ここで完了（消すものが無い）
    st.stage = !hadSettingsDb && maps.length === 0 ? 'done' : 'tiles';
  });
  remember(ctx, s);
};

/**
 * 第 1 段（mapSetting を sources へ写す）。進行中の Promise は ctx.maintenance.settings に 1 つ持って共有する。
 * 既に済んでいれば何もしない。失敗は reject（次の契機でやり直す）
 */
export function ensureSettings(ctx: Context, deps: MigrateDeps): Promise<void> {
  const m = ctx.maintenance;
  if (m.settingsDone || m.migrated) return Promise.resolve();
  if (m.settings) return m.settings;
  const p = copySettings(ctx, deps).finally(() => {
    if (m.settings === p) m.settings = undefined;
  });
  m.settings = p;
  return p;
}

/** 旧 API のハンドラが待つ第 1 段。失敗は捨てて進む（getSetting が readLegacySetting で補う） */
export async function waitForSettings(ctx: Context, deps: MigrateDeps): Promise<void> {
  try {
    await ensureSettings(ctx, deps);
  } catch (e) {
    console.error(e);
  }
}

/** 第 1 段がまだ済んでいない（旧 API の地図の参照で mapSetting も見る） */
export const settingsPending = (ctx: Context): boolean => !ctx.maintenance.settingsDone && !ctx.maintenance.migrated;

/** 旧 Weiwudi.mapSetting から 1 件読む（第 1 段が失敗したときの補い）。無い・読めないなら undefined */
export async function readLegacySetting(ctx: Context, mapID: string): Promise<MapSetting | undefined> {
  try {
    const names = await listLegacyDbs();
    if (names && names.indexOf(SETTINGS_DB) < 0) return undefined;
    const db = await openExisting(ctx, SETTINGS_DB);
    if (!db) return undefined;
    try {
      if (!db.objectStoreNames.contains(SETTING_STORE)) return undefined;
      const value = await new Promise<unknown>((resolve, reject) => {
        const t = db.transaction([SETTING_STORE], 'readonly');
        const req = t.objectStore(SETTING_STORE).get(mapID);
        t.oncomplete = () => resolve(req.result);
        t.onabort = () => reject(t.error ?? req.error);
      });
      return value && typeof value === 'object' ? value as MapSetting : undefined;
    } finally {
      db.close();
    }
  } catch (_e) {
    return undefined;
  }
}

// ---- 第 2 段（tiles） ----

const batchFailed = (ctx: Context, store: Store, mapID: string, recordFailures = 0) =>
  patchMap(ctx, store, mapID, (e) => {
    e.batchFailures++;
    e.recordFailures += recordFailures;
    e.status = e.batchFailures >= MAX_BATCH_FAILURES ? 'failed' : e.status;
  });

/** 地図を done にし、その場で Weiwudi_<mapID> を消す（blocked なら pendingDelete）。batchFailures は 0 に戻す */
const mapDone = async (ctx: Context, store: Store, mapID: string, lastKey: string | undefined, recordFailures: number) => {
  if (isForgotten(ctx, mapID)) return;
  const r = await deleteLegacyDb(ctx, mapDbName(mapID));
  await patchMap(ctx, store, mapID, (e, s) => {
    e.status = 'done';
    if (lastKey !== undefined) e.lastKey = lastKey;
    e.recordFailures += recordFailures;
    e.batchFailures = 0;
    if (r !== 'deleted') addPending(s, mapDbName(mapID));
  });
};

/**
 * 1 つの地図の 1 バッチ（limit 件まで）。地図が終われば { done: true, read }、まだ続くか止めたら { done: false }
 */
const copyBatch = async (
  ctx: Context, deps: MigrateDeps, store: Store, map: MigrationMap, limit: number,
): Promise<{ done: true; read: number } | { done: false }> => {
  const { mapID } = map;
  const resourceId = resourceIdOf(mapID);
  if (mapID.indexOf('\0') >= 0) {
    await patchMap(ctx, store, mapID, (e) => { e.status = 'failed'; });
    return { done: true, read: 0 };
  }
  // Resource の無い書き込みは捨てられる（F29）。バッチを止め、旧レコードは残す（第 2 回 L2）
  const resource = await store.getResource(resourceId);
  if (!resource) {
    await batchFailed(ctx, store, mapID);
    return { done: false };
  }
  let db: IDBDatabase | undefined;
  try {
    let batch: { records: OldRecord[]; exhausted: boolean } | undefined;
    try {
      db = await openExisting(ctx, mapDbName(mapID));
      if (db && db.objectStoreNames.contains(TILE_STORE)) batch = await readBatch(db, map.lastKey, limit);
    } catch (e) {
      console.error(e);
      await batchFailed(ctx, store, mapID);
      return { done: false };
    }
    if (!batch) {
      // DB が無い・tileCache が無い: そのまま done
      db?.close();
      db = undefined;
      await mapDone(ctx, store, mapID, undefined, 0);
      return { done: true, read: 0 };
    }
    const { records, exhausted } = batch;
    const has = await store.hasEntries(records.map((r) => entryKeyOf(mapID, r.key)));
    const evict = await deps.evictScopesFor(store, resource);
    const drop: string[] = [];
    let failures = 0;
    let resourceGone = false;
    let putFailed = false;
    for (let i = 0; i < records.length; i++) {
      const { key, value } = records[i];
      // 読み通しで先に移したもの: 旧レコードを消すだけ
      if (has[i]) {
        drop.push(key);
        continue;
      }
      const entry = await convert(mapID, key, value);
      if (!entry) {
        failures++;
        continue;
      }
      // 変換を待つ間に clean・delete が来たら書かない（第 2 回 M2）
      if (isForgotten(ctx, mapID)) return { done: false };
      let saved: boolean;
      try {
        ({ saved } = await store.putEntry(entry.meta, entry.body, evict));
      } catch (e) {
        // 書き込みの例外（QuotaExceededError など）はバッチの失敗: そこで止め、lastKey を進めず旧レコードを残す
        // （レコードの失敗として飛ばすと、読み尽くしたときに旧 DB ごと消えて移っていないタイルを失う。PR #103 M1）
        console.error(e);
        putFailed = true;
        break;
      }
      if (!saved && !(await store.getResource(resourceId))) {
        resourceGone = true;
        break;
      }
      // saved: false で Resource が有るのは、単体で cacheMaxBytes を超える・maxBytes が 0 のとき（新しい規則でも保存されない）
      drop.push(key);
    }
    if (isForgotten(ctx, mapID)) return { done: false };
    await deleteOld(db!, drop);
    if (resourceGone || putFailed) {
      // lastKey を進めないので、このバッチの飛ばしたレコードは次のバッチで数える（二重に数えない）
      await batchFailed(ctx, store, mapID);
      return { done: false };
    }
    const lastKey = records.length > 0 ? records[records.length - 1].key : map.lastKey;
    if (exhausted) {
      db!.close();
      db = undefined;
      await mapDone(ctx, store, mapID, lastKey, failures);
      return { done: true, read: records.length };
    }
    // 成功したバッチで batchFailures を 0 に戻す（failed は連続 3 回。PR #103 L1）
    await patchMap(ctx, store, mapID, (e) => {
      e.status = 'copying';
      if (lastKey !== undefined) e.lastKey = lastKey;
      e.recordFailures += failures;
      e.batchFailures = 0;
    });
    return { done: false };
  } finally {
    db?.close();
  }
};

/** 全地図が done か failed: Weiwudi を消して stage を done にする（blocked なら pendingDelete に足す） */
const finish = async (ctx: Context, store: Store): Promise<void> => {
  const r = await deleteLegacyDb(ctx, SETTINGS_DB);
  const s = await updateState(ctx, store, (st) => {
    if (r !== 'deleted') addPending(st, SETTINGS_DB);
    st.stage = 'done';
  });
  remember(ctx, s);
};

/**
 * 起動後の点検（R59）: stage が done でも、旧 DB（pendingDelete と failed の地図のものを除く）があれば移行をやり直す
 * （1.1.x に戻している間に作り直された旧 DB）。旧 DB を消さないので、旧 API の要求が待っても止まらない
 */
const boot = async (ctx: Context, store: Store): Promise<void> => {
  const m = ctx.maintenance;
  const prev = await readState(store);
  if (prev.stage !== 'done') return;
  const names = await listLegacyDbs();
  if (!names) return;
  const kept = prev.maps.filter((x) => x.status === 'failed').map((x) => mapDbName(x.mapID));
  if (!names.some((n) => prev.pendingDelete.indexOf(n) < 0 && kept.indexOf(n) < 0)) return;
  await updateState(ctx, store, (s) => { s.stage = 'pending'; });
  m.migrated = false;
  m.settingsDone = false;
  m.failedMaps = undefined;
};

/**
 * 起動後の点検（boot）を 1 回だけ走らせる。旧 API の要求（ping を除く。第 1 段が待つ）と契機の両方が呼び、進行中の
 * Promise を共有する（どちらが先に来ても、done の印より先に旧 DB の有無を見る）。失敗は reject（次の呼び出しでやり直す）
 */
const ensureBooted = (ctx: Context, store: Store): Promise<void> => {
  const m = ctx.maintenance;
  if (m.migrationBooted) return Promise.resolve();
  if (m.migrationBooting) return m.migrationBooting;
  const p = boot(ctx, store).then(() => { m.migrationBooted = true; }).finally(() => {
    if (m.migrationBooting === p) m.migrationBooting = undefined;
  });
  m.migrationBooting = p;
  return p;
};

/**
 * pendingDelete の消し直し（R51）。起動後の最初の契機（waitUntil）だけが行う。同じ名前の削除が待ちのままだと
 * deleteDatabase が返らないことがあるので、旧 API の要求には待たせない。返らない削除は DELETE_WAIT_MS で切って
 * pendingDelete に残す（次の起動で消し直す）。名前ごとの削除は並べて出す（待つのは上限 1 回ぶん）
 */
const retryPendingDeletes = async (ctx: Context, store: Store): Promise<void> => {
  const m = ctx.maintenance;
  if (m.pendingDeletesRetried) return;
  const prev = await readState(store);
  const results = await Promise.all(prev.pendingDelete.map((name) => deleteLegacyDb(ctx, name)));
  const deleted = prev.pendingDelete.filter((_n, i) => results[i] === 'deleted');
  if (deleted.length > 0) {
    await updateState(ctx, store, (s) => {
      s.pendingDelete = s.pendingDelete.filter((n) => deleted.indexOf(n) < 0);
    });
  }
  m.pendingDeletesRetried = true;
};

const stepOnce = async (ctx: Context, deps: MigrateDeps): Promise<void> => {
  const m = ctx.maintenance;
  const store = await ctx.store();
  await ensureBooted(ctx, store);
  await retryPendingDeletes(ctx, store);
  if (m.migrated) return;
  const state = await readState(store);
  if (state.stage === 'done') {
    remember(ctx, state);
    return;
  }
  if (state.stage === 'pending' || state.stage === 'settings') {
    await ensureSettings(ctx, deps);
    return;
  }
  m.settingsDone = true;
  // 200 件の枠を、地図が終わるたびに次の地図へ回す（読み終えた地図・空の地図で契機を余らせない）
  let budget = BATCH;
  while (budget > 0) {
    const s = await readState(store);
    const map = s.maps.find((x) => isActive(x) && !isForgotten(ctx, x.mapID));
    if (!map) {
      await finish(ctx, store);
      return;
    }
    const r = await copyBatch(ctx, deps, store, map, budget);
    if (!r.done) return;
    budget -= r.read;
  }
};

/**
 * 移行の契機（runMaintenance の中。仕様 §14.2）。第 1 段が終わっていなければ第 1 段、終わっていれば 1 バッチ（200 件）
 * だけ進める。進行中の Promise は 1 つ（ctx.maintenance.migrating。同時の契機で 2 バッチ走らせない）
 */
export function migrateStep(ctx: Context, deps: MigrateDeps): Promise<void> {
  const m = ctx.maintenance;
  if (m.migrating) return m.migrating;
  const p = stepOnce(ctx, deps).finally(() => {
    if (m.migrating === p) m.migrating = undefined;
  });
  m.migrating = p;
  return p;
}

// ---- 読み通し（R18） ----

const pullOnce = async (ctx: Context, deps: MigrateDeps, mapID: string, oldKey: string): Promise<void> => {
  const store = await ctx.store();
  const state = await readState(store);
  const e = state.maps.find((x) => x.mapID === mapID);
  if (!e || e.status === 'done' || mapID.indexOf('\0') >= 0) return;
  const key = entryKeyOf(mapID, oldKey);
  const [has] = await store.hasEntries([key]);
  if (has) return;
  const resource = await store.getResource(resourceIdOf(mapID));
  if (!resource) return;
  const db = await openExisting(ctx, mapDbName(mapID));
  if (!db) return;
  try {
    if (!db.objectStoreNames.contains(TILE_STORE)) return;
    const value = await getOld(db, oldKey);
    if (value === undefined) return;
    const entry = await convert(mapID, oldKey, value);
    if (!entry || isForgotten(ctx, mapID)) return;
    const { saved } = await store.putEntry(entry.meta, entry.body, await deps.evictScopesFor(store, resource));
    if (!saved && !(await store.getResource(resourceIdOf(mapID)))) return;
    await deleteOld(db, [oldKey]);
  } finally {
    db.close();
  }
};

/**
 * 旧 API のタイルの読み通し（legacy.getImage が serveTile の前に呼ぶ）。新 DB に無く旧 tileCache にあれば、
 * 第 2 段と同じ規則で putEntry し、saved のときだけ旧レコードを消す。失敗は飲み込む（配信は serve のまま）
 */
export async function pullTile(ctx: Context, deps: MigrateDeps, mapID: string, z: number, x: number, y: number): Promise<void> {
  const m = ctx.maintenance;
  if (m.migrated && !m.failedMaps?.has(mapID)) return;
  if (isForgotten(ctx, mapID)) return;
  const pulls = (m.pulls ??= new Map());
  let set = pulls.get(mapID);
  if (!set) {
    set = new Set();
    pulls.set(mapID, set);
  }
  const p = pullOnce(ctx, deps, mapID, `${z}_${x}_${y}`).catch((e) => { console.error(e); });
  set.add(p);
  try {
    await p;
  } finally {
    set.delete(p);
    if (set.size === 0 && pulls.get(mapID) === set) pulls.delete(mapID);
  }
}

// ---- 旧 API の clean・delete（第 1 回 M6・第 2 回 M2） ----

/**
 * 旧 API の clean（remove: false）・delete（remove: true）の前に呼ぶ。(1) 忘れた地図に入れて kv を done にする
 * （delete は maps から外す）、(2) 進行中の migrateStep と、その地図の進行中の pullTile を待つ、(3) clean なら新 DB の
 * clearEntries（delete は呼び出し側が deleteResource で消す）、(4) Weiwudi_<mapID> を消す（blocked なら pendingDelete）。
 * 状態の書き込みと旧 DB の削除の失敗は飲み込む。clearEntries の失敗は reject。待つ migrateStep の中の削除も (4) の削除も
 * DELETE_WAIT_MS で切るので、別の地図の旧 DB の削除が返らなくても止まらない
 */
export async function forgetLegacyTiles(ctx: Context, mapID: string, opts: { remove?: boolean } = {}): Promise<void> {
  const m = ctx.maintenance;
  (m.forgotten ??= new Set()).add(mapID);
  m.failedMaps?.delete(mapID);
  const store = await ctx.store();
  try {
    await updateState(ctx, store, (s) => {
      const i = s.maps.findIndex((x) => x.mapID === mapID);
      if (i < 0) return false;
      if (opts.remove) s.maps.splice(i, 1);
      else s.maps[i].status = 'done';
    });
  } catch (e) {
    console.error(e);
  }
  const waits: Promise<unknown>[] = [];
  if (m.running) waits.push(m.running);
  if (m.migrating) waits.push(m.migrating);
  for (const p of m.pulls?.get(mapID) ?? []) waits.push(p);
  await Promise.allSettled(waits);
  if (!opts.remove) await store.clearEntries(resourceIdOf(mapID));
  const name = mapDbName(mapID);
  if ((await deleteLegacyDb(ctx, name)) !== 'deleted') {
    try {
      await updateState(ctx, store, (s) => addPending(s, name));
    } catch (e) {
      console.error(e);
    }
  }
}
