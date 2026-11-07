// 差し込み口（#36・仕様 §8）。SW 側だけ。`@c4h/weiwudi/sw` の名前付き export（UMD は self.Weiwudi_SW）。
// 提供元の登録表（#40・仕様 §10。m3-t5）もここに置く。
// 値の依存は errors だけ（仕様 §3）。ResourceInfo・Credentials は store.ts の型を import type で使う。
//
// 決まり:
// - モジュール変数はこのファイルの登録表だけ（計画「実行中の状態」）。試験用の _resetPluginsForTest で空にする
// - 同じオブジェクトの 2 回目の addPlugin・addProvider は無視する（冪等。第 2 回 D4）
// - addPlugin は以後に始まる要求にだけ効く。core は要求の始めに getPlugins() の写しを取り、それで進める
// - 標準の提供元（providers/mapbox.ts）はこのファイルからは import できない（§3）。配線が context に渡し、
//   利用者の提供元（getProviders()）を先に評価する（R13）
import type { Credentials, ResourceInfo } from './store';

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

/**
 * 提供元（仕様 §10）。独自スキーム（mapbox:// など）を登録の時点で https へ解決し、上流へ出す直前に資格情報を足す。
 * - 登録の URL が matches に当たれば resolve してから検査する。先に登録したもの（利用者の提供元は標準より先）が勝つ
 * - resolve が解決できない形は WeiwudiError('unsupported-template') を投げる
 */
export interface WeiwudiProvider {
  /** Resource の provider に入る id（'mapbox' など） */
  id: string;
  /** 独自スキームと、その提供元の https の URL の両方に当たる */
  matches(url: string): boolean;
  /**
   * https の URL（https はそのまま返す）。資格情報を新たに足さない。入力のクエリは残してよい。
   * credentialParams に挙げた名前は登録の検査が取り除く。それ以外の名前の資格情報は残る
   */
  resolve(url: string): string;
  /** 上流へ出す直前にだけ呼ぶ。url を直に書き換える（オリジンを替えた結果は使わない） */
  applyCredentials(url: URL, c: Credentials): void;
  /** スタイルの中の独自スキームを https へ直した新しい object を返す（入力を書き換えない） */
  rewriteStyle?(style: unknown): unknown;
  /** 不正なら WeiwudiError('credential-rejected') を投げる */
  validateCredentials?(c: Credentials): void;
  /** 資格情報として扱うクエリの名前（登録の credentialParams に足す） */
  credentialParams?: string[];
}

// 登録表（このファイルだけがモジュール変数を持つ）
const registered: WeiwudiPlugin[] = [];
const providers: WeiwudiProvider[] = [];

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

/**
 * 提供元を登録する。SW スクリプトの先頭で呼ぶ前提で、永続化しない。同じオブジェクトの 2 回目は無視し、別のオブジェクトで id が同じなら TypeError。
 * object でない値・id が空・matches・resolve・applyCredentials が関数でない値は TypeError
 */
export function addProvider(provider: WeiwudiProvider): void {
  if (typeof provider !== 'object' || provider === null) {
    throw new TypeError('addProvider: provider must be an object');
  }
  if (typeof provider.id !== 'string' || provider.id === ''
    || typeof provider.matches !== 'function' || typeof provider.resolve !== 'function'
    || typeof provider.applyCredentials !== 'function') {
    throw new TypeError('addProvider: provider needs id, matches, resolve and applyCredentials');
  }
  if (providers.indexOf(provider) >= 0) return;
  // id は登録表の中で一意（Resource の provider から 1 つに引くため）。標準の 'mapbox' は登録表に無いので、
  // 同じ id の利用者の提供元は標準の差し替えになる（評価が先なので find でも先に当たる）
  if (providers.some((p) => p.id === provider.id)) {
    throw new TypeError('addProvider: another provider with the same id is already added');
  }
  providers.push(provider);
}

/** 登録順の写し */
export function getProviders(): readonly WeiwudiProvider[] {
  return providers.slice();
}

/** 試験用。登録表（差し込み口と提供元）を空にする */
export function _resetPluginsForTest(): void {
  registered.length = 0;
  providers.length = 0;
}
