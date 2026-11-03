// 実行中の状態の入れ物（仕様 §3・計画「実行中の状態」・第 1 回 S1）。Weiwudi_Internal の呼び出しごとに 1 つ作る。
// モジュール変数を置かないので、1 試験 1 SW（同じプロセスに複数の SW の実行文脈が同居しても混ざらない）。
// 値の依存は store・errors だけ（仕様 §3）。照合表と連続数は t7、ジョブは t5 で足した。
import { openStore, type ResourceMeta, type SourceRecord, type Store } from './store';
import type { TileFailure } from './errors';
import type { MatchTable } from './url_pattern';

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
  /** 動いているジョブ。無ければ undefined */
  job?: JobState;
  /** 照合表（t7） */
  table: TableState;
  /** Resource の id → CORS 非対応の候補の連続数（仕様 §4.5-3。メモリだけ・保存しない） */
  corslessStreak: Map<string, number>;
}

/** open は試験の差し替え用。既定は store.openStore */
export function createContext(open: () => Promise<Store> = openStore): Context {
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
    table: { generation: 0, failures: 0, retryAt: 0 },
    corslessStreak: new Map(),
  };
}
