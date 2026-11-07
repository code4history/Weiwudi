// 実行中の状態の入れ物（仕様 §3・計画「実行中の状態」・第 1 回 S1）。Weiwudi_Internal の呼び出しごとに 1 つ作る。
// モジュール変数を置かないので、1 試験 1 SW（同じプロセスに複数の SW の実行文脈が同居しても混ざらない）。
// 値の依存は store・errors だけ（仕様 §3）。照合表と連続数は t7、ジョブは t5 で足した。
import { openStore, type ResourceMeta, type ResourceType, type SourceRecord, type Store } from './store';
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
}

/** 引数は open の関数（試験の差し替え用）か ContextOptions */
export function createContext(options: ContextOptions | (() => Promise<Store>) = {}): Context {
  const opts: ContextOptions = typeof options === 'function' ? { open: options } : options;
  const open = opts.open ?? openStore;
  const providers = opts.providers ?? (() => []);
  let opening: Promise<Store> | undefined;
  return {
    store: () => {
      if (!opening) {
        const p = open();
        opening = p;
        // 失敗は覚えない（次の呼び出しで開き直す）。呼び出し側には reject のまま返す
        p.catch(() => {
          if (opening === p) opening = undefined;
        });
      }
      return opening;
    },
    inflight: new Map(),
    maintenance: { swept: false },
    table: { generation: 0, failures: 0, retryAt: 0 },
    corslessStreak: new Map(),
    providers: () => providers(),
    ...(opts.acceptsMember ? { acceptsMember: opts.acceptsMember } : {}),
  };
}
