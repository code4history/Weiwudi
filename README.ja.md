# Weiwudi (魏武帝:TileCacheServiceWorker)

ベクタータイル（MVT）対応のタイルキャッシュ用サービスワーカー。  
プロジェクト名は、元々曹操（Cao Cao）という名前で知られ、東漢時代の中国の武将だった[魏武帝(Weiwudi)](https://zh.wikipedia.org/wiki/%E6%9B%B9%E6%93%8D)に由来しています。

## 機能

- **ラスター＆ベクタータイル対応**: 従来のラスタータイルとMapbox Vector Tiles (MVT)の両方をキャッシュ
- **複数タイル形式**: XYZおよびWMTSタイルスキームに対応
- **オフライン機能**: IndexedDBキャッシングによる完全なオフラインマップサポート
- **選択的キャッシング**: 地理的境界とズームレベルによるタイルキャッシュ
- **ストレージ管理**: クオータ管理とキャッシュクリーンアップ機能内蔵
- **ページリロード不要**: Service Workerは即座にアクティブ化（ページリロード不要）
- **アセットキャッシング**: ベクタータイルアセット（スタイル、フォント、スプライト）のキャッシュ

## インストール

### npm

```sh
npm install @c4h/weiwudi@1.0.0
```

### ブラウザ (CDN)

```html
<script src="https://unpkg.com/@c4h/weiwudi@1.0.0/dist/weiwudi.umd.js"></script>
```

## 使用方法

### Service Workerのセットアップ

サービスワーカーファイル（`sw.js`）を作成：

```js
importScripts("https://storage.googleapis.com/workbox-cdn/releases/7.3.0/workbox-sw.js");
importScripts("https://unpkg.com/@c4h/weiwudi@1.0.0/dist/weiwudi_sw.js");
```

### クライアントサイドの実装

```typescript
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

    // マップAPIが上記のURLテンプレートを使用してタイルにアクセスすると、
    // タイル画像は自動的にIndexedDBにキャッシュされます。

    // 現在のキャッシュ状態を取得
    const status = await map1.stats();

    // すべてのタイルをフェッチ
    map2.addEventListener('progress', (e) => {
        console.log(`進行状況: ${e.detail.success}/${e.detail.total} タイル`);
    });
    map2.addEventListener('finished', (e) => {
        console.log('フェッチ完了');
    });
    
    // すべてのタイルをフェッチ（XYZのみ）
    await map1.fetchAll();
    
    // 特定範囲のタイルをフェッチ（WMTS）
    await map2.fetchAll({
        minZoom: 17,
        maxZoom: 18,
        minLng: 135.0,
        maxLng: 135.05,
        minLat: 35.0,
        maxLat: 35.05
    });

    // すべてのキャッシュタイル画像をクリーン
    await map2.clean();
    
    // 特定範囲のタイルをクリーン（WMTSのみ）
    await map2.clean({
        minZoom: 17,
        maxZoom: 18,
        minLng: 135.0,
        maxLng: 135.05,
        minLat: 35.0,
        maxLat: 35.05
    });

    // 登録されたマップ設定を削除
    await map2.remove();

    // ベクタータイル対応（MVT）
    const vectorMap = await Weiwudi.registerMap('vector_map', {
        type: 'wmts',
        minLat: 35.0,
        maxLat: 36.0,
        minLng: 135.0,
        maxLng: 136.0,
        minZoom: 0,
        maxZoom: 14,
        url: 'https://example.com/tiles/{z}/{x}/{y}.mvt'
    });
    
    // ベクタータイルアセットを登録
    await vectorMap.registerVectorTileAssets({
        definition: 'https://example.com/style.json',
        styles: 'https://example.com/styles',
        fonts: 'https://example.com/fonts/{fontstack}/{range}.pbf',
        icons: 'https://example.com/sprite'
    });
    
    // キャッシュされたアセットURLを取得
    const definitionUrl = vectorMap.getDefinitionUrl();
    const stylesUrl = vectorMap.getStylesUrl();
    const fontsUrl = vectorMap.getFontsUrl();
    const iconsUrl = vectorMap.getIconsUrl();

} catch(e) {
    console.error('エラー:', e);
}
```

## APIリファレンス

### 静的メソッド

#### `Weiwudi.registerSW(scriptURL, options?)`
サービスワーカーを登録します。

#### `Weiwudi.registerMap(mapID, options)`
新しいマップ設定を登録します。

#### `Weiwudi.retrieveMap(mapID)`
既存のマップ設定を取得します。

#### `Weiwudi.removeMap(mapID)`
マップ設定を削除します。

### インスタンスメソッド

#### `map.stats()`
タイル数とストレージサイズを含むキャッシュ統計を取得します。

#### `map.clean(range?)`
キャッシュされたタイルをクリーンします。WMTSマップ用のオプションの範囲パラメータ。

#### `map.fetchAll(range?)`
すべてのタイルをフェッチします。WMTSマップには範囲パラメータが必須。

#### `map.cancel()`
進行中のフェッチ操作をキャンセルします。

#### `map.registerVectorTileAssets(options)`
ベクタータイルアセット（定義、スタイル、フォント、アイコン）のURLを登録します。

#### `map.release()`
マップインスタンスを解放し、イベントリスナーをクリーンアップします。

## ストレージクオータ

Weiwudiは自動的にストレージクオータを管理します：
- デフォルトクオータ: オリジンごとに500MB
- キャッシング前の自動クオータチェック
- クオータ超過時はキャッシュされたタイルにフォールバック

## ブラウザサポート

- Chrome/Edge: 完全サポート
- Firefox: 完全サポート  
- Safari: iOS 11.3+ / macOS 10.13.4+ が必要

## ライセンス

MIT License

## 貢献

貢献を歓迎します！お気軽にPull Requestを送信してください。

## 謝辞

Googleの[Workbox](https://developers.google.com/web/tools/workbox)を使用して構築されています。