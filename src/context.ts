// 実行中の状態の入れ物（仕様 §3・計画「実行中の状態」・第 1 回 S1）。Weiwudi_Internal の呼び出しごとに 1 つ作る。
// モジュール変数を置かないので、1 試験 1 SW（同じプロセスに複数の SW の実行文脈が同居しても混ざらない）。
// 値の依存は store・user_agent・errors だけ（仕様 §3）。照合表と連続数は t7、ジョブは t5 で足した。
// 上流への取得（upstreamFetch）もここに置く。upstream・legacy・hook が同じ 1 つの関数を通す（User-Agent）
import { KV_USER_AGENT, openStore, type ResourceMeta, type ResourceType, type SourceRecord, type Store } from './store';
import { composeUserAgent, shouldAttachUserAgent, withUserAgent } from './user_agent';
import type { TileFailure } from './errors';
import type { MatchTable } from './url_pattern';
import type { WeiwudiProvider } from './plugins';

/** 動いているジョブ（1 度に 1 つ。現行の fetchAllBlocker。仕様 §7.2） */
export interface JobState {
  /** ジョブの Source の id（旧 API は map:<mapID>） */
  sourceId: string;
  /** 旧 API の文面に出す名前（旧 API は mapID） */
  label: string;
  total: number;
  /** 処理した数（バッチの後に直す） */
  count: number;
  /** 失敗の合計 */
  error: number;
  /** 失敗の種類ごとの数（#33） */
  failures: Record<TileFailure, number>;
  cancel: boolean;
  /** 範囲取得のジョブの region（m4-t3・R23。旧 API の fetchAll は持たない） */
  regionId?: string;
}

/** opaque イベントの知らせ（m4-t3・R20。upstream と範囲取得が呼び、配線が range.createNotifier を入れる） */
export interface OpaqueNotice {
  type: 'opaque';
  resourceId: string;
  sourceIds: string[];
}

/**
 * 資格情報を使う Source を選ぶ（registry.credentialSourceFor。hook は registry を import できないので配線が渡す。仕様 §3）
 */
export type CredentialSourcePicker = (
  resource: ResourceMeta, sources: readonly SourceRecord[], withCredentials: readonly string[],
) => string | undefined;

/** 読み込んだ照合表（仕様 §4.2・§4.3。hook.ts が作る） */
export interface LoadedTable {
  table: MatchTable;
  /** Resource の id → 要求のオリジン → 資格情報を足す Source の id（足さないものは入れない。I2） */
  credentialSources: Map<string, Map<string, string>>;
  /** 照合表の作成時に見つけた注意（"<code>: <Resource.id>"） */
  warnings: string[];
}

/** 照合表の状態（仕様 §4.3 の読み込み・失敗と停止） */
export interface TableState {
  /** 読み込み済みの表。これがあれば loaded */
  current?: LoadedTable;
  /** 読み込み中の Promise（1 つだけ持って共有する） */
  loading?: Promise<LoadedTable>;
  /** 表の世代。作り直しの契機で増やし、古い世代で読んだ結果は捨てて読み直す */
  generation: number;
  /** 続けて失敗した数（成功で 0） */
  failures: number;
  /** これより前は読み込みをやり直さない（Date.now の値） */
  retryAt: number;
  /** 配線が渡す（installHook） */
  pickCredentialSource?: CredentialSourcePicker;
  /** BroadcastChannel('weiwudi')。無い環境では undefined */
  channel?: BroadcastChannel;
  /** 表の更新の通知をまとめるタイマ（hook.tableChanged。m4-t8・I8b・R34） */
  notifyTimer?: ReturnType<typeof setTimeout>;
}

export interface Context {
  /** store の接続（1 つを使い回す）。開くのに失敗したら次の呼び出しで開き直す */
  store(): Promise<Store>;
  /** 同じキーの同時要求を 1 本にまとめる（core.serve が使う） */
  inflight: Map<string, Promise<Response>>;
  /** store を使う要求が起こす保守。配線が waitUntil と結び付ける（m4-t2・R9） */
  maintain?: (event: ExtendableEvent) => void;
  /** SW の生存期間だけ持つ保守の状態。migrated は m4-t7 が使う */
  maintenance: {
    swept: boolean;
    running?: Promise<void>;
    migrated?: boolean;
    /** 旧 DB の移行（m4-t7・仕様 §14.2）: 第 1 段（mapSetting の写し）の進行中の Promise。旧 API のハンドラが待つ */
    settings?: Promise<void>;
    /** 第 1 段が済んだ（kv の stage が tiles か done） */
    settingsDone?: boolean;
    /** 進行中の migrateStep（同時の契機で 2 バッチ走らせない。clean・delete が待つ） */
    migrating?: Promise<void>;
    /** 起動後の最初の契機の点検（pendingDelete の消し直し・やり直しの判定。R59）が済んだ */
    migrationBooted?: boolean;
    /** 進行中の起動後の点検（第 1 段と契機が共有する。どちらが先でも点検は 1 回） */
    migrationBooting?: Promise<void>;
    /** mapID → 進行中の pullTile（clean・delete が待つ） */
    pulls?: Map<string, Set<Promise<void>>>;
    /** 旧 API の clean・delete で忘れた地図（以後の migrateStep・pullTile が書かない） */
    forgotten?: Set<string>;
    /** stage が done のときの failed の地図（読み通しを続ける地図） */
    failedMaps?: Set<string>;
    /** 削除が blocked で待ちになっている旧 DB の名前（開くと削除の後ろに並んで止まるので開かない） */
    blockedDeletes?: Set<string>;
    /** kv の migration の読み直しと書き込みの直列化 */
    migrationLock?: Promise<void>;
    /** ジョブ完了時の直接呼び出しとも掃除を共有する */
    sweeping?: Promise<void>;
    /** 2,000 件で区切った走査の続き。時刻と Resource の方針は走査中に変えない */
    sweep?: {
      now: number;
      resources: ResourceMeta[];
      tilesDone: boolean;
      after?: IDBValidKey;
      glyphIndex: number;
      glyphAfter?: string;
    };
  };
  /**
   * opaque イベントを送る（m4-t3・R20）。配線（weiwudi_gw_logic）が range.createNotifier(ctx) を入れる。
   * 子 Source は親に読み替えて、全 window の client へ { type: 'opaque', sourceId, resourceId } を送る。無ければ送らない
   */
  notify?: (m: OpaqueNotice) => void;
  /** 動いているジョブ。無ければ undefined */
  job?: JobState;
  /** 照合表（t7） */
  table: TableState;
  /** Resource の id → CORS 非対応の候補の連続数（仕様 §4.5-3。メモリだけ・保存しない） */
  corslessStreak: Map<string, number>;
  /**
   * 提供元の一覧（評価の順。利用者の提供元が先、標準の mapbox が後。m3-t5・R13）。呼ぶたびに今の登録表から作る。
   * 配線（weiwudi_gw_logic）が渡す。渡さなければ空
   */
  providers(): readonly WeiwudiProvider[];
  /**
   * 子の URL の組を normalizeMember が受けるか（spec.acceptsMember。m3-t7）。hook は spec を import できないので配線が渡す。
   * 本体の資格情報の除去（style_body）が、子作り（style.ts）と同じ組だけを除くのに使う。無ければ字句の許可だけで見る
   */
  acceptsMember?: MemberAcceptorWithParams;
  /**
   * 上流への取得（引数は fetch と同じ）。SW と同じオリジンで mode が cors か same-origin の要求にだけ User-Agent を足す。
   * それ以外は fetch(input, init) をそのまま呼ぶ
   */
  upstreamFetch(input: Request | string, init?: RequestInit): Promise<Response>;
  /**
   * ページ（registerSW）が指定した User-Agent の読み込み。setUserAgent の op が loaded を書き換える。
   * stalledOn は上限の時間を越えた読み込み（それが loaded の間は待たない）
   */
  userAgent: { loaded?: Promise<string | undefined>; stalledOn?: Promise<string | undefined> };
}

/** 子の URL の組を受けるか（type・テンプレート・credentialParams） */
export type MemberAcceptorWithParams = (type: ResourceType, templates: string[], credentialParams: readonly string[]) => boolean;

export interface ContextOptions {
  /** 試験の差し替え用。既定は store.openStore */
  open?: () => Promise<Store>;
  /** 提供元の一覧を返す関数（既定は空） */
  providers?: () => readonly WeiwudiProvider[];
  /** 子の URL の組の判定（既定は無し） */
  acceptsMember?: MemberAcceptorWithParams;
  /** SW のスクリプトが指定した User-Agent（plugins.getUserAgent。ページの指定が無いときに使う） */
  userAgent?: () => string | undefined;
}

/** ページの指定値を kv から読むのを待つ上限（store が開けないときに素通しを止めない） */
export const USER_AGENT_LOAD_MS = 1000;

/** kv の userAgent の値（{ userAgent?: string }）から指定値を取り出す */
export const storedUserAgentOf = (v: unknown): string | undefined => {
  const u = v !== null && typeof v === 'object' ? (v as { userAgent?: unknown }).userAgent : undefined;
  return typeof u === 'string' && u !== '' ? u : undefined;
};

/** SW 自身の場所（self.location）。無い環境では undefined */
const selfLocation = (): { origin: string; href: string } | undefined => {
  const loc = typeof self !== 'undefined' ? (self as { location?: { origin?: unknown; href?: unknown } }).location : undefined;
  return loc && typeof loc.origin === 'string' && typeof loc.href === 'string' ? { origin: loc.origin, href: loc.href } : undefined;
};

/** ブラウザの User-Agent（WorkerNavigator）。無い環境では undefined */
const browserUserAgent = (): string | undefined =>
  typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' ? navigator.userAgent : undefined;

/** 引数は open の関数（試験の差し替え用）か ContextOptions */
export function createContext(options: ContextOptions | (() => Promise<Store>) = {}): Context {
  const opts: ContextOptions = typeof options === 'function' ? { open: options } : options;
  const open = opts.open ?? openStore;
  const providers = opts.providers ?? (() => []);
  const swUserAgent = opts.userAgent ?? (() => undefined);
  let opening: Promise<Store> | undefined;
  const store = (): Promise<Store> => {
    if (!opening) {
      const p = open();
      opening = p;
      // 失敗は覚えない（次の呼び出しで開き直す）。呼び出し側には reject のまま返す
      p.catch(() => {
        if (opening === p) opening = undefined;
      });
    }
    return opening;
  };
  const userAgent: Context['userAgent'] = {};
  /**
   * ページの指定値。読めない・上限を越えたときは undefined。上限を一度越えた読み込み（stalledOn）は、以後は待たずに
   * undefined を返し、背景で読み続ける（終われば次の取得から使う。IndexedDB が blocked でも毎回は待たない）
   */
  const pageUserAgent = async (): Promise<string | undefined> => {
    if (!userAgent.loaded) {
      const p = store().then((s) => s.kvGet(KV_USER_AGENT)).then(storedUserAgentOf);
      userAgent.loaded = p;
      const settle = () => {
        if (userAgent.stalledOn === p) userAgent.stalledOn = undefined;
      };
      p.then(settle, () => {
        settle();
        // 失敗は覚えない（次の取得で読み直す）
        if (userAgent.loaded === p) userAgent.loaded = undefined;
      });
    }
    const loaded = userAgent.loaded;
    if (userAgent.stalledOn === loaded) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const TIMEOUT = Symbol('timeout');
    try {
      const r = await Promise.race([
        loaded,
        new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), USER_AGENT_LOAD_MS); }),
      ]);
      if (r === TIMEOUT) {
        if (userAgent.loaded === loaded) userAgent.stalledOn = loaded;
        return undefined;
      }
      return r;
    } catch (_e) {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const plain = (input: Request | string, init?: RequestInit): Promise<Response> =>
    init === undefined ? fetch(input) : fetch(input, init);
  const upstreamFetch = async (input: Request | string, init?: RequestInit): Promise<Response> => {
    if (!shouldAttachUserAgent(input, init, selfLocation())) return plain(input, init);
    let custom = await pageUserAgent();
    if (custom === undefined) {
      try {
        custom = swUserAgent();
      } catch (_e) {
        custom = undefined;
      }
    }
    const request = withUserAgent(input, init, composeUserAgent(browserUserAgent(), custom));
    if (!request) return plain(input, init);
    try {
      return await fetch(request);
    } catch (error) {
      // 同じオリジンの上流が別オリジンへ redirect すると、redirect 先で User-Agent のための preflight が要り、
      // 答えない相手では TypeError になる（WebKit・Firefox）。元の引数のまま 1 回だけ取り直す（オフラインなら同じく失敗する）。
      // 取り消された要求（AbortError・signal が abort 済み）と、本文を持ちうる要求（GET・HEAD 以外。本文は使い終わっている）は
      // 取り直さずにそのまま投げる
      const aborted = (error as { name?: unknown } | null)?.name === 'AbortError' || request.signal?.aborted === true;
      if (aborted || (request.method !== 'GET' && request.method !== 'HEAD')) throw error;
      return plain(input, init);
    }
  };
  return {
    store,
    upstreamFetch,
    userAgent,
    inflight: new Map(),
    maintenance: { swept: false },
    table: { generation: 0, failures: 0, retryAt: 0 },
    corslessStreak: new Map(),
    providers: () => providers(),
    ...(opts.acceptsMember ? { acceptsMember: opts.acceptsMember } : {}),
  };
}
