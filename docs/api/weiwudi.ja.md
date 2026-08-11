# Weiwudi

`@c4h/weiwudi` のメインクラスです。インスタンスは `Weiwudi.registerMap` 経由で作成され、登録されたマップのタイルキャッシュ操作を提供します。

## 静的メソッド

### `Weiwudi.registerSW(sw, swOptions?)`

サービスワーカーを登録します。

**パラメータ:**
- `sw` (string | URL): サービスワーカーファイルへのパス
- `swOptions` (RegistrationOptions, オプション): サービスワーカー登録オプション

**戻り値:** `Promise<ServiceWorkerRegistration>`

**例外:**
- `"Error: Service worker is not supported"`: ブラウザがサービスワーカーをサポートしていない場合
- `"Error: Service worker registration failed with {error}"`: 登録に失敗した場合

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
- 追加の進行状況情報

---

### `finish`

`fetchAll()` 操作が正常に完了したときに発火されます。

**イベント詳細:**
- `mapID` (string): マップ識別子

---

### `stop`

`fetchAll()` 操作がエラーまたはキャンセルにより停止したときに発火されます。

**イベント詳細:**
- `mapID` (string): マップ識別子
- エラー情報

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

---

## 関連

- [API インデックス](README.ja.md) — インストール / クイックスタート / エコシステム
- [メイン README](../README.ja.md) — インストール / クイックスタート / エコシステム
