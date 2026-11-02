# Weiwudi

`@c4h/weiwudi` のメインクラスです。インスタンスは `Weiwudi.registerMap` 経由で作成され、登録されたマップのタイルキャッシュ操作を提供します。

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
  `fetchAll()` の実行中に配った他のタイルの取得の失敗も含みます
- 追加の進行状況情報

---

### `finish`

`fetchAll()` 操作が正常に完了したときに発火されます。

**イベント詳細:**
- `mapID` (string): マップ識別子
- `error` (number): 失敗したタイルの数（合計）
- `errors` (object): 失敗したタイルの種類別の数 `{ network, upstream, quota, storage }`。
  `fetchAll()` の実行中に配った他のタイルの取得の失敗も含みます

---

### `stop`

`fetchAll()` 操作がエラーまたはキャンセルにより停止したときに発火されます。

**イベント詳細:**
- `mapID` (string): マップ識別子
- `reason`: 停止の原因となったエラー
- `code` (string): `WeiwudiError.from(reason).code`（[エラー](#エラー) を参照）

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
  `WeiwudiError` を渡すとそのまま返します。
- 表にある文面なら `code` は表のとおりで、差し込み値は文字列のまま `detail` に
  入ります（例: `map-not-found` → `{ mapID: 'x' }`）。
- それ以外の `"Error: {message}"`（IndexedDB の例外などを包んだもの）は、`Error: ` の
  後ろの例外名で分類します。`QuotaExceededError` → `quota`、`BlockedError` →
  `db-blocked`、それ以外 → `internal`。これらは `Error: ` で始まることとこの分類だけを
  保証し、残りの文は変わることがあります。たとえば `registerMap` で地図の設定の保存が
  容量超過になると、実ブラウザでは `Error: QuotaExceededError`（後ろに `: ` と説明が
  付くことがあります）で reject します。
- `Error`・`DOMException` は `name` で同じように分類します。それ以外の値は
  `String(value)` を文面にして `internal` になります。

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

**今後の API のために予約したコード:** `unsupported-template`・`invalid-style`・
`opaque`・`sw-outdated`・`credential-rejected`・`source-not-found`・
`resource-conflict`。`WeiwudiErrorCode` の型には入っていますが、まだ作られません。

**code は今後の minor で増えることがあります。** `code` で `switch` するときは、
必ず `default` を置いてください。

### タイルの応答: `x-weiwudi-error`

`map.url` から配るタイルは、状態と本体を変えずに、取得や保存に失敗したときは応答ヘッダ
`x-weiwudi-error` を付けます。

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
