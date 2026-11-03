// 実行中の状態の入れ物（仕様 §3・計画「実行中の状態」・第 1 回 S1）。Weiwudi_Internal の呼び出しごとに 1 つ作る。
// モジュール変数を置かないので、1 試験 1 SW（同じプロセスに複数の SW の実行文脈が同居しても混ざらない）。
// 値の依存は store・errors だけ（仕様 §3）。t7 で照合表・連続数、t5 でジョブを足す。
import { openStore, type Store } from './store';

export interface Context {
  /** store の接続（1 つを使い回す）。開くのに失敗したら次の呼び出しで開き直す */
  store(): Promise<Store>;
  /** 同じキーの同時要求を 1 本にまとめる（core.serve が使う） */
  inflight: Map<string, Promise<Response>>;
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
  };
}
