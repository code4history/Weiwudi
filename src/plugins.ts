// 差し込み口（#36・仕様 §8）。SW 側だけ。`@c4h/weiwudi/sw` の名前付き export（UMD は self.Weiwudi_SW）。
// 値の依存は errors だけ（仕様 §3）。ResourceInfo は store.ts の型を import type で使う。
//
// 決まり:
// - モジュール変数はこのファイルの登録表だけ（計画「実行中の状態」）。試験用の _resetPluginsForTest で空にする
// - 同じオブジェクトの 2 回目の addPlugin は無視する（冪等。第 2 回 D4）
// - addPlugin は以後に始まる要求にだけ効く。core は要求の始めに getPlugins() の写しを取り、それで進める
import type { ResourceInfo } from './store';

/**
 * Weiwudi の差し込み口。Workbox のプラグインと同じ名前・同じ意味のフックを持つ（すべて省略可）。
 * - 登録順に呼ぶ。フックが投げた例外は console.error に残し、そのプラグインを飛ばして続ける
 * - `state` はプラグインごと・要求ごとに新しい object（同じ要求の requestWillFetch・fetchDidSucceed・fetchDidFail で共有）
 * - `resource` は資源の公開の射影（ResourceInfo）。保存の型は渡さない
 */
export interface WeiwudiPlugin {
  /** 上流へ出す前。別の Request を返すと、それで取りに行く */
  requestWillFetch?(p: { request: Request; resource: ResourceInfo; state: unknown }): Promise<Request | void>;
  /** 上流から応答が届いた後（HTTP の失敗を含む）。別の Response を返すと、それを使う */
  fetchDidSucceed?(p: { request: Request; response: Response; resource: ResourceInfo; state: unknown }): Promise<Response | void>;
  /** 上流へ届かなかったとき（ネットワークの失敗） */
  fetchDidFail?(p: { request: Request; error: unknown; resource: ResourceInfo; state: unknown }): Promise<void>;
  /** 保存の前。null で保存しない。別の Response を返すと、それを保存する（配信は元の応答） */
  cacheWillUpdate?(p: { request: Request; response: Response; resource: ResourceInfo }): Promise<Response | null | void>;
  /** 保存した応答を使う前。null で「保存した応答が無い」として扱う。別の Response を返すと、それを使う */
  cachedResponseWillBeUsed?(p: { request: Request; cachedResponse: Response; resource: ResourceInfo }): Promise<Response | null | void>;
}

// 登録表（このファイルだけがモジュール変数を持つ）
const registered: WeiwudiPlugin[] = [];

/**
 * 差し込み口を登録する。SW スクリプトの先頭で呼ぶ前提で、永続化しない（SW が再起動すれば再び呼ばれる）。
 * 同じオブジェクトの 2 回目は無視する。object でない値は TypeError
 */
export function addPlugin(plugin: WeiwudiPlugin): void {
  if (typeof plugin !== 'object' || plugin === null) {
    throw new TypeError('addPlugin: plugin must be an object');
  }
  if (registered.indexOf(plugin) >= 0) return;
  registered.push(plugin);
}

/** 登録順の写し（要求の始めに取る。後から addPlugin されても、この写しは変わらない） */
export function getPlugins(): readonly WeiwudiPlugin[] {
  return registered.slice();
}

/** 試験用。登録表を空にする */
export function _resetPluginsForTest(): void {
  registered.length = 0;
}
