# Weiwudi

`@c4h/weiwudi` のメインクラスです。インスタンスは `Weiwudi.registerMap` 経由で作成され、登録されたマップのタイルキャッシュ操作を提供します。

Source の API（`Weiwudi.register` と `WeiwudiSource`）は、地図ライブラリが使う実際のタイルの URL をそのままキャッシュします。[Source の API](#source-の-api) を参照してください。

## 静的メソッド

### `Weiwudi.registerSW(sw, swOptions?)`

サービスワーカーを登録します。

**パラメータ:**
- `sw` (string | URL): サービスワーカーファイルへのパス
- `swOptions` (RegistrationOptions, オプション): サービスワーカー登録オプション

**戻り値:** `Promise<ServiceWorkerRegistration>`

**解決条件:** 登録したサービスワーカーがアクティベートされ、現在のページを制御下に
置いた時点で解決します。ワーカーは install で `skipWaiting`、activate で
`clients.claim()` を呼ぶため、初回アクセスからページのリロードなしで制御されます。

**例外:**
- `"Error: Service worker is not supported"`: ブラウザがサービスワーカーをサポートしていない場合
- `"Error: Service worker registration failed with {error}"`: 登録に失敗した場合
- `"Error: Service worker did not control this page within 10000 ms"`: 10000 ms 以内にページが制御下に入らなかった場合（例: ページ URL が登録スコープ外）

**例:**
```js
await Weiwudi.registerSW('./sw.js', {scope: './'});
```

---

### `Weiwudi.registerMap(mapID, options)`

マップ設定を登録してWeiwudiインスタンスを作成します。

**パラメータ:**
- `mapID` (string): マップの一意識別子
- `options` (WeiwudiOptions): マップ設定オブジェクト

**戻り値:** `Promise<Weiwudi>` - 登録されたマップのWeiwudiインスタンス

**例外:**
- `"Weiwudi service worker is not implemented."`: サービスワーカーがアクティブでない場合
- `"Error: {message}"`: マップ登録に失敗した場合

**例:**
```js
const map = await Weiwudi.registerMap('my_map', {
    type: 'xyz',
    width: 10000,
    height: 6000,
    url: 'https://example.com/{z}/{x}/{y}.jpg'
});
```

---

### `Weiwudi.retrieveMap(mapID)`

既存の登録済みマップ設定を取得します。

**パラメータ:**
- `mapID` (string): マップの一意識別子

**戻り値:** `Promise<Weiwudi>` - 取得されたマップのWeiwudiインスタンス

**例外:**
- `"Weiwudi service worker is not implemented."`: サービスワーカーがアクティブでない場合
- `"Error: {message}"`: マップ取得に失敗した場合

---

### `Weiwudi.removeMap(mapID)`

登録されたマップ設定を削除します。

**パラメータ:**
- `mapID` (string): 削除するマップの一意識別子

**戻り値:** `Promise<void>`

**例外:**
- `"Weiwudi service worker is not implemented."`: サービスワーカーがアクティブでない場合
- `"Error: {message}"`: マップ削除に失敗した場合

---

## インスタンスメソッド

### `stats()`

このマップの現在のキャッシュ統計を取得します。

**戻り値:** `Promise<{count: number, size: number, total?: number, percent?: number}>`

**例外:**
- `"This instance is already released."`: 解放済みのインスタンスで呼び出された場合
- `"Error: {message}"`: 統計取得に失敗した場合

**例:**
```js
const stats = await map.stats();
console.log(`キャッシュ済みタイル: ${stats.count}, サイズ: ${stats.size} バイト`);
```

---

### `clean()`

このマップのキャッシュされたすべてのタイルをクリアします。

**戻り値:** `Promise<void>`

**例外:**
- `"This instance is already released."`: 解放済みのインスタンスで呼び出された場合
- `"Error: {message}"`: キャッシュクリアに失敗した場合

---

### `fetchAll()`

このマップのすべてのタイルを取得してキャッシュします(オフライン使用向け)。

**戻り値:** `Promise<void>`

**例外:**
- `"This instance is already released."`: 解放済みのインスタンスで呼び出された場合
- `"Error: {message}"`: 取得処理に失敗した場合

**イベント:** 取得処理中に `proceed`、`finish`、`stop` イベントをディスパッチします。

**例:**
```js
map.addEventListener('proceed', (e) => {
    console.log('タイル取得中...', e.detail);
});
map.addEventListener('finish', (e) => {
    console.log('すべてのタイル取得完了!');
});
await map.fetchAll();
```

---

### `cancel()`

実行中の `fetchAll()` 操作をキャンセルします。

**戻り値:** `Promise<void>`

**例外:**
- `"This instance is already released."`: 解放済みのインスタンスで呼び出された場合
- `"Error: {message}"`: キャンセルに失敗した場合

---

### `remove()`

マップ登録を削除してこのインスタンスを解放します。このメソッド呼び出し後、インスタンスは使用できません。

**戻り値:** `Promise<void>`

**例外:**
- `"This instance is already released."`: 解放済みのインスタンスで呼び出された場合

---

## インスタンスプロパティ

### `url`

**型:** `string`

キャッシュされたタイルにアクセスするためのURLテンプレート。マップライブラリ(例: Leaflet、OpenLayers)でこのURLを使用します。

**例:**
```js
const map = await Weiwudi.registerMap('my_map', {...});
L.tileLayer(map.url).addTo(leafletMap);
```

---

## イベント

Weiwudiインスタンスは `WeiwudiEventTarget` を継承し、以下のイベントをサポートします:

### `proceed`

`fetchAll()` 操作中に定期的に発火され、進行状況を報告します。

**イベント詳細:**
- `mapID` (string): マップ識別子
- `error` (number): それまでに失敗したタイルの数（合計）
- `errors` (object): それまでに失敗したタイルの種類別の数 `{ network, upstream, quota, storage }`。
  その `fetchAll()` が取得したタイルの失敗だけを数えます
- 追加の進行状況情報

---

### `finish`

`fetchAll()` 操作が正常に完了したときに発火されます。

**イベント詳細:**
- `mapID` (string): マップ識別子
- `error` (number): 失敗したタイルの数（合計）
- `errors` (object): 失敗したタイルの種類別の数 `{ network, upstream, quota, storage }`。
  その `fetchAll()` が取得したタイルの失敗だけを数えます

---

### `stop`

`fetchAll()` 操作がエラーまたはキャンセルにより停止したときに発火されます。

**イベント詳細:**
- `mapID` (string): マップ識別子
- `reason`: 停止の原因となったエラー
- `code` (string): `WeiwudiError.from(reason).code`（[エラー](#エラー) を参照）

## Source の API

地図ライブラリが要求する URL テンプレートを登録します。サービスワーカーがその実 URL を直接捕捉するので、地図ライブラリには
`weiwudi.example.com` の URL ではなく元の URL を渡します。

```typescript
import Weiwudi from '@c4h/weiwudi';

await Weiwudi.registerSW('./sw.js', { scope: './' });
const source = await Weiwudi.register({
  kind: 'raster',
  url: 'https://tile.example.com/{z}/{x}/{y}.png',
  bounds: [139.7, 35.6, 139.8, 35.7], minZoom: 0, maxZoom: 16,
});
// register() の完了を待ってから地図を作る（先に出た要求はキャッシュされない）
L.tileLayer(source.url as string).addTo(leafletMap);
```

試験しているのは Chromium だけです。WebKit・Firefox は未確認です。

### `Weiwudi.register(spec)`

Source を登録します。同じ内容で何度呼んでも結果は同じです（冪等）。

**パラメータ:** `spec`（`SourceSpec`）

```typescript
type SourceSpec = CommonPolicy & (
  | { kind: 'raster' | 'vector'; id?: string; url: string | string[];
      bounds?: [west: number, south: number, east: number, north: number];
      box?: TileBox;  // maxZoom のタイル座標。この Source の scheme の座標（'tms' なら y は南から数える）
      minZoom?: number; maxZoom?: number; scheme?: 'xyz' | 'tms'; tileSize?: number;
      outOfRange?: { extent?: OutOfRange; zoom?: OutOfRange } }
  | { kind: 'style'; id?: string; url: string; fonts?: string[] }
  | { kind: 'asset'; id?: string; url: string | string[] }
);
interface CommonPolicy {
  cacheTtl?: number;          // 鮮度（ms。既定 24 時間）
  cacheRetention?: number;    // 削除期限（ms。既定なし）
  cacheMaxBytes?: number;     // この Source の容量（byte）
  cachePrivate?: boolean;     // 認証付きの要求も保存する（既定 false）
  credentials?: Credentials;  // サービスワーカーが足す。credentials ストアの外には残さない
  credentialParams?: string[];// キャッシュのキーから落とすクエリの名前（既定の名前と credentials.query の名前に足す）
}
type Credentials = { query?: Record<string, string>; headers?: Record<string, string> };
type OutOfRange = 'transparent' | 'empty' | 'not-found';
interface TileBox { minX: number; maxX: number; minY: number; maxY: number }
```

- `url`: テンプレート 1 つか、ミラーの配列。字句は `{z}` `{x}` `{y}` `{-y}` `{quadkey}` `{ratio}` `{prefix}`。
  相対 URL はページの場所で解決します
- `id`: 既定は先頭のテンプレートを正規化したもの。明示の `id` は公開の値です（`source()` の鍵・`sources()` の `id`・
  `warnings`）。**資格情報を入れないでください。** 空でない・`\0` を含まない文字列で、`map:` で始めてはいけません
  （`registerMap` で登録した地図のための予約）
- **`kind: 'style'` と `kind: 'asset'` は、この版では `unsupported-kind` で拒否します。**
- 範囲外のタイルは、既定でラスタは透明 PNG、ベクタは 200 の空本体です。ズームの外を 404 にしたいときは
  `outOfRange: { zoom: 'not-found' }` を指定します

**戻り値:** `Promise<WeiwudiSource>`

**`WeiwudiError` で reject するとき:**
- `attribute-invalid`: 項目の形の誤り・`map:` で始まる／空の／`\0` を含む `id`・userinfo（`user:pass@`）を含むテンプレート
- `unsupported-template`: 未対応の字句・解決できないか `http:`・`https:` でない URL（相対 URL は先にページの場所で絶対化する）・`weiwudi.example.com` のテンプレート
- `unsupported-kind`: `style`・`asset`（この版では扱わない）
- `credential-rejected`: `credentials` かテンプレートの秘密トークン（`sk.`）
- `sw-not-controlling`・`sw-outdated`: [呼び出しの前の確認](#呼び出しの前の確認) を参照

既存の資源と合流できない資源があっても `register()` は**失敗しません**。Source を保存し、`warnings` に
`resource-conflict: <資源の id>` を書きます。

### `Weiwudi.source(id)`

**戻り値:** `Promise<WeiwudiSource>`。その id の Source が無ければ `source-not-found` で reject します
（`registerMap` で登録した地図は出ません）。

### `Weiwudi.sources()`

**戻り値:** 登録順の `Promise<SourceInfo[]>`。

```typescript
interface SourceInfo {
  id: string;
  kind: SourceSpec['kind'];
  url: string | string[];      // 資格情報を除いた実 URL
  resources: ResourceInfo[];   // 呼び出し時点の写し
  warnings: string[];          // register()・update() の時点の写し
}
interface ResourceInfo {
  id: string; type: ResourceType; templates: string[];
  count: number; bytes: number;
  rangeOnly?: true;            // この Source の範囲だけを足した資源（resource-conflict）
  corsless?: true;             // いまは CORS 非対応のサーバとして扱っている
}
type ResourceType = 'style' | 'tilejson' | 'tile' | 'glyph' | 'sprite' | 'data';
```

### `WeiwudiSource`

| メンバ | 説明 |
|---|---|
| `id` | Source の id |
| `url` | 地図ライブラリへ渡す実 URL（資格情報なし） |
| `resources` | `ResourceInfo[]`。呼び出し時点の写しで、後の変化は `stats()` か `Weiwudi.source()` で読み直す |
| `warnings` | `string[]`。`register()`・`update()` の時点の写し（後で変わらない） |
| `stats()` | `Promise<SourceStats>` |
| `update()` | 保存した登録内容で合流と方針を作り直し、CORS の判定をやり直す。自分の資源が衝突すると `resource-conflict` で reject し、何も変えない |
| `clean()` | 保存した Entry を消す。他の Source と共有する資源の Entry は残す |
| `remove()` | 登録と Entry を消し、`release()` を呼ぶ。他の Source が `sourceIds` に持つ資源の Entry は残す。`sourceIds` が空になった資源は、範囲だけ（`rangeOnly`）で参照している Source があっても Entry ごと消す |
| `release()` | ページ側のリスナを外す。以後のメソッドは `instance-released` で reject |

```typescript
interface SourceStats {
  count: number;
  size: number;
  total?: number;      // 範囲（bounds か box）が決まるときだけ
  percent?: number;    // 同上
  byResource: Record<string, { count: number; bytes: number }>;
}
```

### `warnings`

各要素は `"<code>: <subject>"` です。subject は資源の id（資格情報は除いてある）です。

| code | 意味 |
|---|---|
| `resource-conflict` | 既存の資源と合流できなかった（`type`・`scheme`・符号化の違い、Entry があるのに `credentialParams` が広がる、2 つの資源に重なる）。既存の方針のままで、この Source の範囲だけを足す。その資源に既に属していた Source を同じ `id` で登録し直したときは範囲も足さず、資源は古い方針と、この Source の古い範囲のまま残る |
| `template-shadowed` | 同じ要求に当たる別のテンプレートが先に評価されるので、この資源は捕捉されない |

知らない code は無視してください。code は minor の版で増えることがあります。

### 呼び出しの前の確認

Source の API は、まずページがこの API を持つサービスワーカーの制御下にあるかを確かめます
（`GET https://weiwudi.example.com/v2/ping` が `{ api: 2, version }` を返すか）。失敗したら何も送りません。

- `sw-not-controlling`: 制御下に無い・確認がサービスワーカーに届かない・確認の間に controller が替わった
- `sw-outdated`: 制御しているのはこの API の無い古い Weiwudi（`/v2/ping` が 404）か、200 でも本文が `{ api: 2, version: 空でない文字列 }` の形でない（新しい版が有効になってから読み込み直す）

確認の成功は、制御しているワーカーごとに `controllerchange` まで覚えます。制御の要求は
`Content-Type: text/plain;charset=UTF-8` の `POST` で、preflight を出しません。

### タイルの応答: `x-weiwudi-status`

サービスワーカーが捕捉した URL（と `map.url`）に作る応答には `x-weiwudi-status` が付き、失敗したときは
`x-weiwudi-error` も付きます。`access-control-expose-headers` に載せるので、ページから読めます。

| `x-weiwudi-status` | 意味 |
|---|---|
| `out-of-range` | 登録した範囲の外 |
| `hit` | 新しい Entry |
| `miss` | 上流から取得した（保存できれば保存） |
| `refresh` | 古い Entry を上流の新しい応答で置き換えた |
| `stale` | 上流が失敗したので保存した Entry を返した |
| `upstream-error` | 上流が HTTP で失敗し、Entry も無い（上流の状態をそのまま渡す） |
| `offline-miss` | 通信の失敗で、Entry も無い（404） |

`x-weiwudi-error` は `network`・`upstream`・`quota`・`storage` のどれかです。CORS 非対応のサーバへの `<img>` の
要求（opaque の応答）は保存しません。保存した Entry が無ければ、opaque の応答をそのまま渡すので、ヘッダは付きません。
古い Entry があれば、その Entry を `x-weiwudi-status: stale`・`x-weiwudi-error: upstream` を付けて返します。
値は minor の版で増えることがあります。

---

## エラー

### reject は文字列のまま

既存の API（`registerSW`・`registerMap`・`retrieveMap`・`removeMap` とインスタンスの
メソッド）は **これまでどおり文字列で reject します**。下の表の文面は minor の版では
変えないので、`typeof e === 'string'` や `e.match(...)` での分岐はそのまま動きます。
原因で分岐したいときは `WeiwudiError.from` で文字列から変換します。

### `WeiwudiError.from(value)`

```typescript
import Weiwudi, { WeiwudiError } from '@c4h/weiwudi';

try {
    await Weiwudi.registerMap('my_map', options);
} catch (e) {
    const err = WeiwudiError.from(e); // e は文字列のまま
    if (err.code === 'map-busy') { /* 先に cancel する */ }
    console.log(err.code, err.message, err.detail);
}
```

- `code`・`message`・`detail` を持つ `WeiwudiError`（`Error` の派生）を返します。
  どんな値を渡しても throw しません。
- **そのまま返すのは、本物の `Error` で既知の `code` を持つものだけです**（別のコピーの
  Weiwudi が作った `WeiwudiError` や、`name` が `'WeiwudiError'` の `Error` を含む）。
  それ以外は新しい `WeiwudiError` に作り直します。`Error.isError` の無い環境（Node 22
  など）では、本物の `Error` かどうかを `instanceof` でしか確かめられないので、
  `Object.create(WeiwudiError.prototype)` などでプロトタイプを継いで作り、既知の `code` と、
  印（列挙されない自前のデータプロパティ）か `name: 'WeiwudiError'` を自前で付けた
  object は、そのまま返ることがあります（`code` だけでは作り直します）。偽装した object を渡せるのは呼び出し側自身だけで、
  これは安全上の境界ではありません。
- 表にある文面なら `code` は表のとおりで、差し込み値は文字列のまま `detail` に
  入ります（例: `map-not-found` → `{ mapID: 'x' }`）。差し込み値が別の文面を含み、
  同じ文字列が複数の文面から作れるときは、先頭の固定部分（最初の差し込みより前）が
  長い文面の code になります。差し込みが複数ある文面は、各区切りの最後の出現で分けます。
  この場合、`detail` への分け方は保証しません。
- それ以外の `"Error: {message}"`（IndexedDB の例外などを包んだもの）は、`Error: ` の
  後ろの例外名で分類します。`QuotaExceededError` → `quota`、`BlockedError` →
  `db-blocked`、それ以外 → `internal`。これらは `Error: ` で始まることとこの分類だけを
  保証し、残りの文は変わることがあります。たとえば `registerMap` で地図の設定の保存が
  容量超過になると、実ブラウザでは `Error: QuotaExceededError`（後ろに `: ` と説明が
  付くことがあります）で reject します。
- `Error`・`DOMException` は `name` で同じように分類します。それ以外の値（`name` を
  持つだけの object を含む）は `String(value)` を文面にして `internal` になります
  （文字列にできない値は `[unprintable]`）。読み取りの途中で throw する値も `internal`
  です。

**文面が決まっているコード:**

| code | 文面（変更なし） |
|---|---|
| `sw-unsupported` | `Error: Service worker is not supported` |
| `sw-register-failed` | `Error: Service worker registration failed with {error}` |
| `sw-not-controlling` | `Error: Service worker did not control this page within 10000 ms` |
| `sw-not-implemented` | `Weiwudi service worker is not implemented.` |
| `map-id-required` | `MapID is necessary.` |
| `instance-released` | `This instance is already released.` |
| `attribute-missing` | `Error: Attribute "{target}" is missing` |
| `attribute-invalid` | `Error: Attribute "cacheMaxBytes" is not a valid non-negative integer` |
| `unknown-type` | `Error: Unknown "type" value` |
| `map-not-found` | `Error: MapID "{mapID}" not found` |
| `map-busy` | `Error: {mapID} is under fetching process. Please cancel it first` |
| `no-fetch-process` | `Error: There are no fetching process of {mapID}` |
| `cache-path-invalid` | `Error: "cache" api needs mapID, zoom, x, y settings` |
| `cannot-fetch-all` | `Error: Map "{mapID}" cannot fetch all tiles` |
| `fetch-busy` | `Error: Another fetching process is running: "{mapID}" ({count} / {total})` |
| `api-not-found` | `Error: API {apiName} not found` |

**ほかのコード:** `db-blocked`・`quota`・`internal`（包んだ例外から。上を参照）と、
`network`・`upstream`・`storage`（タイルの失敗。下を参照）。

**Source の API のコード**（`WeiwudiError` で reject します。[Source の API](#source-の-api) を参照）:
`unsupported-template`・`credential-rejected`（`register`）、
`unsupported-kind`（この版の `register` で `kind: 'style'`・`'asset'`）、
`sw-outdated`（制御しているサービスワーカーに Source の API が無い）、
`source-not-found`（`source()` と `WeiwudiSource` のメソッドで、無い id）、
`resource-conflict`（`update()` だけ。`register()` は `warnings` に書く）。
Source の API は上の表の `attribute-invalid`・`sw-not-controlling`・`instance-released`・`api-not-found` も、
独自の文面で使います。

**今後の API のために予約したコード:** `invalid-style`・`opaque`。`WeiwudiErrorCode` の
型には入っていますが、まだ作られません。

**code は今後の minor で増えることがあります。** `code` で `switch` するときは、
必ず `default` を置いてください。

### タイルの応答: `x-weiwudi-error`

`map.url` から配るタイルは、状態と本体を変えずに、取得や保存に失敗したときは応答ヘッダ
`x-weiwudi-error` を付けます。上流が成功した応答（2xx のどれでも）は、旧 API と同じく
`200 OK` にして返します（本体は変えません）。

| 場面 | 応答 | `x-weiwudi-error` |
|---|---|---|
| 通信の失敗・保存なし | 404 | `network` |
| 通信の失敗・保存あり | 200・保存したタイル | `network` |
| 上流が OK でない状態・保存なし | 上流の状態 | `upstream` |
| 上流が OK でない状態・保存あり | 200・保存したタイル | `upstream` |
| 取得できたが保存が容量超過 | 200・取得したタイル | `quota` |
| 取得できたが保存がそれ以外で失敗 | 200・取得したタイル | `storage` |

ふつうに配って保存できたときは、このヘッダは付きません。

---

## WeiwudiOptions インターフェース

マップ登録用の設定オプション。

### XYZタイルマップ用

```typescript
{
    type: 'xyz',
    url: string,           // {z}, {x}, {y} プレースホルダーを含むURLテンプレート
    width: number,         // マップ幅(ピクセル)
    height: number,        // マップ高さ(ピクセル)
    tileSize?: number,     // タイルサイズ(デフォルト: 256)
    cacheTtl?: number      // タイルキャッシュ有効期間(ms、デフォルト: 86400000 = 24時間)
    cacheMaxBytes?: number // キャッシュ容量の上限(byte、省略時は上限なし)
}
```

### WMTSタイルマップ用

```typescript
{
    type: 'wmts',
    url: string,           // {z}, {x}, {y} プレースホルダーを含むURLテンプレート
    minLat: number,        // 最小緯度
    maxLat: number,        // 最大緯度
    minLng: number,        // 最小経度
    maxLng: number,        // 最大経度
    minZoom: number,       // 最小ズームレベル
    maxZoom?: number,      // 最大ズームレベル(省略時は無制限)
    cacheTtl?: number      // タイルキャッシュ有効期間(ms、デフォルト: 86400000 = 24時間)
    cacheMaxBytes?: number // キャッシュ容量の上限(byte、省略時は上限なし)
}
```

**補足:**
- `maxZoom`: 省略した場合、どのズームレベルでもタイルリクエストが拒否
  されません(無制限として扱われます)。最大ズームが定まらない地図では
  未指定のままにしてください。
- `cacheTtl`: キャッシュ済みタイルを配信し続ける期間を制御し、超過後は
  `url` から再取得します。再取得に成功してもキャッシュへの書き込みが
  失敗した場合(ストレージ容量超過など)、取得済みのタイルはそのまま
  呼び出し元へ配信されます。
- `cacheMaxBytes`: このマップのキャッシュ済みタイルの合計サイズ(byte)を
  制限します。上限に達すると最も使われていないタイルから自動削除
  (LRU)します。`cacheMaxBytes` が `0` の場合、または単一タイルが上限を
  超える場合は、タイル応答は呼び出し元へ配信されますがキャッシュされ
  ません。省略時は容量上限なしです。0 以上の整数でなければ `registerMap` は
  `Error: Attribute "cacheMaxBytes" is not a valid non-negative integer` で
  reject し、地図は登録されません。

---

## 関連

- [API インデックス](README.ja.md) — インストール / クイックスタート / エコシステム
- [メイン README](../README.ja.md) — インストール / クイックスタート / エコシステム
