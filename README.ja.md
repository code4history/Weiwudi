# Weiwudi (魏武帝:TileCacheServiceWorker)
[![CI](https://github.com/code4history/Weiwudi/actions/workflows/ci.yml/badge.svg)](https://github.com/code4history/Weiwudi/actions/workflows/ci.yml)
タイルキャッシュ用のサービスワーカー。  
プロジェクト名は、曹操(Cao Cao)の名でも知られる中国後漢時代の武将[魏武帝(Weiwudi)](https://zh.wikipedia.org/wiki/%E6%9B%B9%E6%93%8D)に由来しています。

English README is [here](./README.md).

## 動作要件

- **Node.js**: >= 20.0.0
- **パッケージマネージャー**: pnpm >= 9.0.0 (推奨) または npm

## ライブデモ

Weiwudiの動作を確認するには、以下のコマンドでインタラクティブデモを起動してください:

```bash
pnpm install
pnpm dev
```

その後、ブラウザで `http://localhost:5173/` を開いてください。デモには以下の機能があります:
- 🗺️ WeiwudiでキャッシュされるOSMタイルを使用したLeafletマップ
- 📊 リアルタイムキャッシュ統計(タイル数、キャッシュサイズ)
- 🔄 すべてのタイルを取得するボタン
- 🗑️ キャッシュクリア機能

## テスト

Playwrightを使用したE2Eテストスイートを実行:

```bash
pnpm run test:e2e
```

テストでは以下を検証します:
- サービスワーカーの登録とアクティベーション
- タイルキャッシュの動作
- キャッシュ統計の取得
- キャッシュクリア機能

## インストール

### NPMパッケージ

**pnpm** を使用してインストール (推奨):

```bash
pnpm add @c4h/weiwudi
```

または npm を使用:

```bash
npm install @c4h/weiwudi
```

### ピア依存関係

Weiwudiは `workbox-routing` をピア依存関係として必要とします。以下のように併せてインストールしてください:

```bash
pnpm add workbox-routing
```

### ブラウザ (CDN)

ビルドツールを使わずにブラウザで使用する場合は、CDN経由でWeiwudiを読み込むことができます:

```html
<!-- Weiwudiメインライブラリを読み込む -->
<script src="https://cdn.jsdelivr.net/npm/@c4h/weiwudi@0.2.0/dist/weiwudi.umd.js"></script>
```

サービスワーカーファイルでは、以下のように使用します:

```js
// サービスワーカー内 (sw.js)
importScripts("https://cdn.jsdelivr.net/npm/workbox-routing@7.4.0/build/workbox-routing.prod.umd.min.js");
importScripts("https://cdn.jsdelivr.net/npm/@c4h/weiwudi@0.2.0/dist/weiwudi-sw.umd.js");
```

## 使い方

### サービスワーカー側

サービスワーカー内でworkboxと共にこのJSを呼び出します。
```js
importScripts("https://cdn.jsdelivr.net/npm/workbox-routing@7.4.0/build/workbox-routing.prod.umd.min.js");
importScripts("https://cdn.jsdelivr.net/npm/@c4h/weiwudi@0.2.0/dist/weiwudi-sw.umd.js");
```

### フロントロジック側
```js
import Weiwudi from '@c4h/weiwudi';

try {
    // サービスワーカーを登録
    await Weiwudi.registerSW('./sw.js', {scope: './'});
    // マップ設定をサービスワーカーに登録
    // XYZマップの場合
    const map1 = await Weiwudi.registerMap('xyz_map', {
        type: 'xyz',
        width: 10000,
        height: 6000,
        url: 'http://example.com/{z}/{x}/{y}.jpg'
    });
    // WMTSマップの場合
    const map2 = await Weiwudi.registerMap('wmts_map', {
        type: 'wmts',
        minLat: 35.0,
        maxLat: 35.1,
        minLng: 135.0,
        maxLng: 135.1,
        minZoom: 17,
        maxZoom: 18,
        url: 'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png'
    });

    // キャッシュされたマップのURLテンプレートを取得
    const map1_url = map1.url;
    const map2_url = map2.url;

    // マップAPIが上記のURLテンプレートを使用してマップタイルにアクセスすると、
    // タイル画像は自動的にindexedDBにキャッシュされます。

    // 現在のキャッシュ状況を取得
    const status = await map1.stats();

    // すべてのタイルを取得
    map2.addEventListener('proceed', (e) => {
        // タイル取得の進行状況を処理するコードを記述
    });
    map2.addEventListener('finish', (e) => {
        // タイル取得の完了を処理するコードを記述
    });
    map2.addEventListener('stop', (e) => {
        // エラーによるタイル取得の停止を処理するコードを記述
    });
    // 取得を開始 
    await map2.fetchAll();

    // キャッシュされたすべてのタイル画像をクリア
    await map2.clean();

    // 登録されたマップ設定を削除
    await map2.remove();


} catch(e) {
    // エラーの場合(例: ブラウザがサービスワーカーをサポートしていない) 
    ...
}
```

## API リファレンス

### 静的メソッド

#### `Weiwudi.registerSW(sw, swOptions?)`

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

#### `Weiwudi.registerMap(mapID, options)`

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

#### `Weiwudi.retrieveMap(mapID)`

既存の登録済みマップ設定を取得します。

**パラメータ:**
- `mapID` (string): マップの一意識別子

**戻り値:** `Promise<Weiwudi>` - 取得されたマップのWeiwudiインスタンス

**例外:** 
- `"Weiwudi service worker is not implemented."`: サービスワーカーがアクティブでない場合
- `"Error: {message}"`: マップ取得に失敗した場合

---

#### `Weiwudi.removeMap(mapID)`

登録されたマップ設定を削除します。

**パラメータ:**
- `mapID` (string): 削除するマップの一意識別子

**戻り値:** `Promise<void>`

**例外:** 
- `"Weiwudi service worker is not implemented."`: サービスワーカーがアクティブでない場合
- `"Error: {message}"`: マップ削除に失敗した場合

---

### インスタンスメソッド

#### `stats()`

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

#### `clean()`

このマップのキャッシュされたすべてのタイルをクリアします。

**戻り値:** `Promise<void>`

**例外:** 
- `"This instance is already released."`: 解放済みのインスタンスで呼び出された場合
- `"Error: {message}"`: キャッシュクリアに失敗した場合

---

#### `fetchAll()`

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

#### `cancel()`

実行中の `fetchAll()` 操作をキャンセルします。

**戻り値:** `Promise<void>`

**例外:** 
- `"This instance is already released."`: 解放済みのインスタンスで呼び出された場合
- `"Error: {message}"`: キャンセルに失敗した場合

---

#### `remove()`

マップ登録を削除してこのインスタンスを解放します。このメソッド呼び出し後、インスタンスは使用できません。

**戻り値:** `Promise<void>`

**例外:** 
- `"This instance is already released."`: 解放済みのインスタンスで呼び出された場合

---

### インスタンスプロパティ

#### `url`

**型:** `string`

キャッシュされたタイルにアクセスするためのURLテンプレート。マップライブラリ(例: Leaflet、OpenLayers)でこのURLを使用します。

**例:**
```js
const map = await Weiwudi.registerMap('my_map', {...});
L.tileLayer(map.url).addTo(leafletMap);
```

---

### イベント

Weiwudiインスタンスは `WeiwudiEventTarget` を継承し、以下のイベントをサポートします:

#### `proceed`

`fetchAll()` 操作中に定期的に発火され、進行状況を報告します。

**イベント詳細:**
- `mapID` (string): マップ識別子
- 追加の進行状況情報

---

#### `finish`

`fetchAll()` 操作が正常に完了したときに発火されます。

**イベント詳細:**
- `mapID` (string): マップ識別子

---

#### `stop`

`fetchAll()` 操作がエラーまたはキャンセルにより停止したときに発火されます。

**イベント詳細:**
- `mapID` (string): マップ識別子
- エラー情報

---

### WeiwudiOptions インターフェース

マップ登録用の設定オプション。

#### XYZタイルマップ用

```typescript
{
    type: 'xyz',
    url: string,           // {z}, {x}, {y} プレースホルダーを含むURLテンプレート
    width: number,         // マップ幅(ピクセル)
    height: number,        // マップ高さ(ピクセル)
    tileSize?: number      // タイルサイズ(デフォルト: 256)
}
```

#### WMTSタイルマップ用

```typescript
{
    type: 'wmts',
    url: string,           // {z}, {x}, {y} プレースホルダーを含むURLテンプレート
    minLat: number,        // 最小緯度
    maxLat: number,        // 最大緯度
    minLng: number,        // 最小経度
    maxLng: number,        // 最大経度
    minZoom: number,       // 最小ズームレベル
    maxZoom: number        // 最大ズームレベル
}
```

---

## ビルド

### 開発

ホットリロード付きで開発サーバーを実行:

```bash
pnpm dev
```

### プロダクションビルド

本番環境用にライブラリをビルド:

```bash
pnpm build
```

これにより以下が生成されます:
- `dist/weiwudi.es.js` - モダンバンドラー用ESモジュール
- `dist/weiwudi.umd.js` - ブラウザ用UMDバンドル
- `dist/weiwudi-sw.es.js` - サービスワーカー用ESモジュール
- `dist/weiwudi-sw.umd.js` - サービスワーカー用UMDバンドル
- `dist/weiwudi.d.ts` - TypeScript型定義

---

## ライセンス

Copyright (c) 2020-2026 Code for History

[MIT License](LICENSE) でライセンスされています。
