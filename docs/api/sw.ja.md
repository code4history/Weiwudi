# サービスワーカーの API（`@c4h/weiwudi/sw`）

[English](sw.md)

サービスワーカーの入口は、import した時点で Weiwudi のルートを登録します。
副作用 import はこれまでどおり動きます。

```js
import '@c4h/weiwudi/sw';
```

あわせて、タイルの取得と保存に処理を差し込むための名前付き export と、URL の提供元を足すための
名前付き export を持ちます。

| export | 種類 |
|---|---|
| `addPlugin(plugin)` | 関数 |
| `addProvider(provider)` | 関数 |
| `WeiwudiPlugin` | 型 |
| `WeiwudiProvider` | 型 |
| `Credentials` | 型 |
| `ResourceInfo` | 型 |
| `ResourceType` | 型 |

UMD 版（`importScripts` で読む `weiwudi-sw.umd.js`）では、同じ関数を
`self.Weiwudi_SW.addPlugin`・`self.Weiwudi_SW.addProvider` として使います。

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

フックはどれも省略できます。これは Weiwudi 独自の API で、フックの名前は Workbox のプラグインから
借りていますが、Workbox のプラグインではなく、Workbox のプラグインを渡すこともできません。
Workbox との違い:

- どのフックにも `event` を渡しません。
- `state` を渡すのは `requestWillFetch`・`fetchDidSucceed`・`fetchDidFail` だけです。
- `cacheWillUpdate`・`cachedResponseWillBeUsed` には、キャッシュのキーではなく元の要求
  （`requestWillFetch` を通す前のもの）を渡します。

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
| `fetchDidSucceed` | 上流から応答が届いた後（HTTP のエラーと opaque の応答を含む） | 別の `Response` を返すと、それを使う。本体を読んで何も返さない（または読んだ応答を返す）と、エラーを残して、フックを呼ぶ前の応答を使う |
| `fetchDidFail` | 上流へ届かなかったとき（ネットワークの失敗） | 使わない |
| `cacheWillUpdate` | Weiwudi が応答の保存を試みる直前 | `null` で保存しない。別の `Response` を返すと、それを保存する（ページへは元の応答を返す）。その本体が読めなければ、保存せずに `x-weiwudi-error: storage` を付けて配る |
| `cachedResponseWillBeUsed` | 保存した応答を配る前（新しいとき、または上流の失敗で古いものを配るとき） | `null` で「保存した応答が無い」として扱う。別の `Response` を返すと、それを配る |

1 つの要求での順:

- 保存済みで新しい: `cachedResponseWillBeUsed`。`null` を返すと、下の「未保存」の順へ進みます。
- 未保存、または古い: `requestWillFetch` → `fetchDidSucceed` → `cacheWillUpdate`（保存するときだけ）
- HTTP のエラー（または opaque の応答、タイルの代わりの `text/html` のページ）で古いものがある:
  `requestWillFetch` → `fetchDidSucceed` → `cachedResponseWillBeUsed`
- ネットワークの失敗: `requestWillFetch` → `fetchDidFail` → `cachedResponseWillBeUsed`（古いものがあるときだけ）
- 資源の登録が無くなった要求と、`Range` ヘッダつきの要求では、どのフックも呼びません（上流へそのまま出します）。

注意:

- `state` はプラグインごと・要求ごとに新しい空の object です。1 つの要求の中では、そのプラグインの
  `requestWillFetch`・`fetchDidSucceed`・`fetchDidFail` に同じ object を渡します。
- `cacheWillUpdate` は、Weiwudi が保存しようとする応答でだけ呼びます。HTTP のエラー、タイルの代わりに
  返された `text/html` のページ、opaque の応答、保存しない認証付きの要求では呼びません。
- 上流の成功（2xx）の応答は `200 OK` として配り、保存します（旧 API と同じ）。
- 旧 API（`Weiwudi.registerMap`）の経路では、Weiwudi は URL の文字列で上流へ取りに行きます。
  `requestWillFetch` が別の `Request` を返したときだけ、その `Request` で取りに行きます。
  フックが受け取る `request` は上流のタイルの URL（ミラーから無作為に 1 つ選び、相対の URL はサービスワーカーの
  場所で解決したもの）で、`weiwudi.example.com` の URL ではありません。
- 同じタイルへの匿名の同時の要求は 1 本にまとめます。フックは 1 回だけ、最初の要求が始まったときの登録で走ります。
  認証付きの要求はまとめません。
- 認証付きの要求（Weiwudi が保存しない要求）は、新しい保存済みの応答があっても必ず上流へ出します。
  保存済みの応答を使うのは、上流が失敗したとき（HTTP のエラー・ネットワークの失敗）の古いものとしてだけです。

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

## `addProvider(provider: WeiwudiProvider): void`

URL の提供元を登録します。提供元は、自分の独自スキーム（`mapbox://` など）を Source の登録の時点で
`https` の URL へ解決し、上流へ要求を出す直前に登録の資格情報を足します。`addPlugin` と同じく
サービスワーカーのスクリプトの先頭で呼んでください。登録は保存しません。

- 同じオブジェクトを 2 回登録しても効果はありません（2 回目は無視します）。
- object でない値や、`id`・`matches`・`resolve`・`applyCredentials` を持たない値は `TypeError` を投げます。
- 呼んだ後に登録する Source に効きます。Source は登録したときの提供元の `id` を持ち続けます。要求を処理する
  時点でその `id` の提供元が登録されていなければ（サービスワーカーが起動し直し、スクリプトが `addProvider` を
  呼ばなかったときなど）、資格情報は汎用の方法で足します。

**評価の順。** 利用者が足した提供元を先に、足した順に試します。標準の `mapbox` は最後です。URL に対して
`matches` が最初に `true` を返した提供元を使うので、利用者の提供元で、同じ URL の標準の提供元を差し替えられます。

**`id`。** 同じ `id` は 1 度だけ登録できます。すでに登録した `id` を別のオブジェクトで登録すると `TypeError` です。
`id` が `'mapbox'` の提供元を登録すると、標準のものの差し替えになります（利用者のものを先に試し、`provider: 'mapbox'`
の Resource も利用者のものを使います）。サービスワーカーが起動し直し、スクリプトがそれを登録し直さなかったときは、
その Resource には標準の `mapbox` を使います。提供元の違う Source は、URL が同じテンプレートに解決しても
1 つの Resource へ合流させません（`resource-conflict` の警告になります）。
1 つの Source のミラーは、すべて同じ提供元に当たる（またはすべて当たらない）必要があります。混ざると
`attribute-invalid` です。

```js
import { addProvider } from '@c4h/weiwudi/sw';

addProvider({
  id: 'example',
  matches: (url) => url.startsWith('example://') || url.startsWith('https://tiles.example.com/'),
  resolve: (url) => url.replace(/^example:\/\//, 'https://tiles.example.com/'),
  applyCredentials: (url, c) => {
    const key = c.query?.key;
    if (key !== undefined && !url.searchParams.has('key')) url.searchParams.set('key', key);
  },
  credentialParams: ['key'],
});
```

## `WeiwudiProvider`

```ts
type Credentials = { query?: Record<string, string>; headers?: Record<string, string> };

interface WeiwudiProvider {
  id: string;                                         // Resource に保存する
  matches(url: string): boolean;                      // 独自スキームと、その提供元の https の URL
  resolve(url: string): string;                       // https の URL。資格情報を新たに足さない（下の注）
  applyCredentials(url: URL, c: Credentials): void;   // 上流へ出す直前にだけ呼ぶ
  rewriteStyle?(style: unknown): unknown;             // スタイルの中の独自スキームを https へ
  validateCredentials?(c: Credentials): void;         // 投げると登録を拒否する
  credentialParams?: string[];                        // 資格情報として扱うクエリの名前
}
```

- `matches` はスタイルの子に親の資格情報を配るかの判定（R5）にも使うため、`https` の URL はその提供元自身のホストだけに当ててください。
- `resolve` は Source の登録の時点で呼びます。返した URL はほかの URL テンプレートと同じく検査し、Source の
  `url` と Resource のテンプレートになります。`https` の URL はそのまま返してください。解決できない形には
  例外を投げてください。登録は `unsupported-template` で失敗し、文面は固定です
  （`cannot be resolved by the provider "<id>"`。投げた例外の文面は外へ出しません）。
- `resolve` は資格情報を新たに足さないでください。入力のクエリは残してかまいません。`credentialParams` に
  挙げた名前は登録の検査が取り除きます。それ以外の名前の資格情報は URL に残ります。
- `validateCredentials` は登録の資格情報（`credentials` の指定と、URL のクエリから移したもの）を受け取ります。
  投げると登録は `credential-rejected` で失敗し、文面は固定です（投げた例外の文面は外へ出しません）。
  秘密トークン（`sk.`）の汎用の検査も行います。
- `credentialParams` は Source の `credentialParams` に足します。
- `rewriteStyle` は新しい object を返し、入力を書き換えないでください。

### `applyCredentials`: いつ呼び、何を足すか

1. **いつ呼ぶか:** `requestWillFetch` の後、上流への要求を組み立てる直前に、Resource の提供元が登録され、
   要求のオリジンに対応する資格情報が選ばれているときに呼びます。捕捉と範囲取得は同じ選択処理を使います。
   スタイルの登録と `update()` で資源を取るときも、この上流の経路を通ります。再試行では再び呼ばれることがあり、
   キャッシュの hit では呼びません。
2. **何を足すか:** `c` の提供元のクエリ資格情報を `url` に直接足します。既存の資格情報の項目は残してください
   （名前は大文字小文字を区別せず比較します）。標準の Mapbox と汎用のクエリ処理は、無い名前だけを足し、既存の
   クエリの符号化を保ちます。ヘッダの資格情報は別の汎用処理で、要求にそのヘッダが無いときだけ足します。
   ヘッダの資格情報を足した要求は `redirect: 'error'` で出します。ただし `no-cors` の再試行は除き、
   ブラウザのヘッダ制限が適用されます。
3. **何を足さないか:** 元の要求に `Authorization` があるか、`mode: 'cors'` かつ `credentials: 'include'` なら、
   登録の資格情報を足しません。`requestWillFetch` がオリジンを替えた場合、Range の素通し、範囲取得の
   `probeNoCors` の確認でも足しません。コールバックが投げるか URL のオリジンを替えたときは、その URL の変更を
   捨てますが、ヘッダの汎用処理は行います。投げた場合のログは提供元の `id` と例外の `name` だけです。
   署名は自動生成しません。このコールバックはキャッシュのキーを変えず、クエリ資格情報の追加だけに使ってください。

### `credentialParams` の既定値

`url_pattern.DEFAULT_CREDENTIAL_PARAMS` の実値は次の 6 つで、名前は大文字小文字を区別しません。
登録時に、この既定値と Source・提供元の `credentialParams`、明示した `credentials.query` の名前を合わせます。
これらの項目はキャッシュのキーではなく資格情報として扱います。名前を宣言しても値や署名を生成するわけではありません。

| 既定のクエリ項目名 |
|---|
| `access_token` |
| `token` |
| `key` |
| `api_key` |
| `apikey` |
| `sku` |

### 標準の提供元 `mapbox`

`mapbox://` の URL は、何も設定しなくても解決します。`mapbox://` の URL と、`api.mapbox.com`・
`*.tiles.mapbox.com` の `https` の URL に当たります。

| 登録の URL | 解決した URL |
|---|---|
| `mapbox://styles/{user}/{style}`（`…/draft` も） | `https://api.mapbox.com/styles/v1/{user}/{style}` |
| `mapbox://sprites/{user}/{style}`（`…/{hash}` も） | `https://api.mapbox.com/styles/v1/{user}/{style}/sprite` |
| `mapbox://fonts/{user}/{fontstack}/{range}.pbf` | `https://api.mapbox.com/fonts/v1/{user}/{fontstack}/{range}.pbf` |
| `mapbox://tiles/{id}/{z}/{x}/{y}[@2x].{format}` | `https://api.mapbox.com/v4/{id}/{z}/{x}/{y}[@2x].{format}` |
| `mapbox://{id}[,{id}…]`（ソースの `url`） | `https://api.mapbox.com/v4/{ids}.json?secure` |

タイルの URL は字句のまま写します（Mapbox GL JS が行う `@2x`・`webp` への置き換えは行いません）。スプライトは
基底の URL へ解決し、形式と拡張子は地図ライブラリが付けます。

アクセストークンは `credentials: { query: { access_token } }` で登録してください（URL のクエリに書いても
移します）。秘密トークン（`sk.`）は `credential-rejected` で拒否します。オフライン保存の可否を含め、
提供元の利用規約の確認は利用者の責任です。

