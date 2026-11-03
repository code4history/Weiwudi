# サービスワーカーの API（`@c4h/weiwudi/sw`）

[English](sw.md)

サービスワーカーの入口は、import した時点で Weiwudi のルートを登録します。
副作用 import はこれまでどおり動きます。

```js
import '@c4h/weiwudi/sw';
```

あわせて、タイルの取得と保存に処理を差し込むための名前付き export を持ちます。

| export | 種類 |
|---|---|
| `addPlugin(plugin)` | 関数 |
| `WeiwudiPlugin` | 型 |
| `ResourceInfo` | 型 |
| `ResourceType` | 型 |

UMD 版（`importScripts` で読む `weiwudi-sw.umd.js`）では、同じ関数を
`self.Weiwudi_SW.addPlugin` として使います。

## `addPlugin(plugin: WeiwudiPlugin): void`

差し込み口（プラグイン）を登録します。サービスワーカーのスクリプトの先頭で呼んでください。
登録は保存しません。ブラウザがサービスワーカーを起動し直すとスクリプトがもう一度走り、
そこで登録し直されます。

- 登録順に実行します。
- 同じオブジェクトを 2 回登録しても効果はありません（2 回目は無視します）。
- `addPlugin` が戻った後に始まる要求にだけ効きます。処理中の要求は、始まったときの登録のまま進みます。
- フックが例外を投げる・reject すると、`console.error` に残し、その段ではそのプラグインを飛ばして
  処理を続けます。プラグインが地図を止めることはありません。
- object でない値を渡すと `TypeError` を投げます。

```js
import { addPlugin } from '@c4h/weiwudi/sw';

addPlugin({
  async requestWillFetch({ request, resource }) {
    // 別の URL から取る。何も返さなければ要求はそのまま
    if (resource.type === 'tile') return new Request(request.url.replace('http:', 'https:'));
  },
  async cacheWillUpdate({ response }) {
    // null: 配信はするが保存しない
    return response.headers.get('content-type')?.startsWith('image/') ? response : null;
  },
});
```

UMD:

```js
importScripts('https://cdn.jsdelivr.net/npm/workbox-core@7.4.0/build/workbox-core.prod.js');
importScripts('https://cdn.jsdelivr.net/npm/workbox-routing@7.4.0/build/workbox-routing.prod.js');
importScripts('https://cdn.jsdelivr.net/npm/@c4h/weiwudi@<version>/dist/weiwudi-sw.umd.js');

self.Weiwudi_SW.addPlugin({ /* フック */ });
```

## `WeiwudiPlugin`

フックはどれも省略できます。名前と意味は Workbox のプラグインと同じです。

```ts
interface WeiwudiPlugin {
  requestWillFetch?(p: { request: Request; resource: ResourceInfo; state: unknown }): Promise<Request | void>;
  fetchDidSucceed?(p: { request: Request; response: Response; resource: ResourceInfo; state: unknown }): Promise<Response | void>;
  fetchDidFail?(p: { request: Request; error: unknown; resource: ResourceInfo; state: unknown }): Promise<void>;
  cacheWillUpdate?(p: { request: Request; response: Response; resource: ResourceInfo }): Promise<Response | null | void>;
  cachedResponseWillBeUsed?(p: { request: Request; cachedResponse: Response; resource: ResourceInfo }): Promise<Response | null | void>;
}
```

| フック | 呼ぶとき | 戻り値 |
|---|---|---|
| `requestWillFetch` | 上流へ要求を出す前 | 別の `Request` を返すと、それで取りに行く。何も返さなければそのまま。次のプラグインは結果を受け取る |
| `fetchDidSucceed` | 上流から応答が届いた後（HTTP のエラーを含む） | 別の `Response` を返すと、それを使う |
| `fetchDidFail` | 上流へ届かなかったとき（ネットワークの失敗） | 使わない |
| `cacheWillUpdate` | 応答を保存する前 | `null` で保存しない。別の `Response` を返すと、それを保存する（ページへは元の応答を返す） |
| `cachedResponseWillBeUsed` | 保存した応答を配る前（新しいとき、または上流の失敗で古いものを配るとき） | `null` で「保存した応答が無い」として扱う。別の `Response` を返すと、それを配る |

1 つの要求での順:

- 保存済みで新しい: `cachedResponseWillBeUsed`
- 未保存、または古い: `requestWillFetch` → `fetchDidSucceed` → `cacheWillUpdate`（保存するときだけ）
- ネットワークの失敗: `requestWillFetch` → `fetchDidFail` → `cachedResponseWillBeUsed`（古いものがあるときだけ）

注意:

- `state` はプラグインごと・要求ごとに新しい空の object です。1 つの要求の中では、そのプラグインの
  `requestWillFetch`・`fetchDidSucceed`・`fetchDidFail` に同じ object を渡します。
- `cacheWillUpdate` は、Weiwudi が保存しようとする応答でだけ呼びます。HTTP のエラー、タイルの代わりに
  返された `text/html` のページ、opaque の応答、保存しない認証付きの要求では呼びません。
- 旧 API（`Weiwudi.registerMap`）の経路では、Weiwudi は URL の文字列で上流へ取りに行きます。
  `requestWillFetch` が別の `Request` を返したときだけ、その `Request` で取りに行きます。
- 同じタイルへの同時の要求は 1 本にまとめます。まとめた要求に対してフックは 1 回だけ走ります。

## `ResourceInfo`

プラグインが `resource` として受け取るもの。要求の始めに取った読み取り用の写しで、
書き換えても Weiwudi の記録は変わりません。

```ts
type ResourceType = 'style' | 'tilejson' | 'tile' | 'glyph' | 'sprite' | 'data';

interface ResourceInfo {
  id: string;            // 資源の id
  type: ResourceType;
  templates: string[];   // 資格情報を除いた URL テンプレート
  count: number;         // 保存した件数
  bytes: number;         // 保存した大きさの和
  rangeOnly?: true;      // プラグインへは渡さない
  corsless?: true;       // 上流を今は CORS 非対応として扱っている
}
```

`ResourceType` の値と `ResourceInfo` の項目は minor で増えることがあります。`type` で `switch` するときは
`default` を置いてください。
