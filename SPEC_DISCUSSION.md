# Weiwudi 1.0.0 仕様議論

このドキュメントでは、Weiwudi 1.0.0で未実装の機能について、実装仕様を議論・決定します。

## 重要な設計変更提案：キャッシュ仕様v1

### 背景
現在の`example.com/{mapID}/`形式は：
- ラスタータイル時代の1対1関係を前提とした設計
- 一般的なURLのフックに対するリスク回避

しかし、ベクタータイル対応で以下の問題が発生：
- 同一リソースが複数IDで重複管理される
- スタイルとタイルセットの多対多関係に対応困難

### キャッシュ仕様v1提案

#### 基本コンセプト
1. **URLベースのリソース管理**
   - IDを廃止し、実際のURLをリソース識別子として使用
   - example.comプロキシを廃止

2. **選択的URLフック**
   - 登録されたURLのみをService Workerでインターセプト
   - 意図的に導入されるため、セキュリティリスクは限定的

#### 実装例
```javascript
// キャッシュ仕様v0（現行）
await Weiwudi.registerMap("my-map", {
  url: "https://example.com/style.json"
});
// → http://example.com/my-map/definition

// キャッシュ仕様v1（提案）
await Weiwudi.register({
  urls: [
    "https://example.com/style.json",
    "https://api.mapbox.com/v4/mapbox.streets/{z}/{x}/{y}.mvt",
    "https://example.com/fonts/{fontstack}/{range}.pbf"
  ]
});
// → 実際のURLをそのままフック
```

#### 利点
1. **重複の自動解決**: 同一URLは自動的に同一キャッシュ
2. **シンプルな実装**: URL変換層が不要
3. **標準準拠**: 一般的なService Worker実装パターン
4. **デバッグ容易**: 実際のURLが見える

#### 課題と解決案
1. **URL変更への対応**
   - 解決案：URL別名（エイリアス）機能の提供

2. **統計情報の管理**
   - 解決案：URL単位での使用統計を記録

3. **後方互換性**
   - 解決案：v0 APIをv1上にラッパーとして実装

### 決定事項
**Weiwudi 1.0.0でキャッシュ仕様v1を採用する**

### 実装方針
1. 既存のIDベース実装（v0）を削除し、URLベース（v1）で再実装
2. APIの後方互換性は不要（クリーンな再設計）
3. example.comプロキシを廃止し、実URLをフック
4. v0キャッシュの自動マイグレーション機能を実装

### キャッシュ仕様v1のデータ構造

#### IndexedDBスキーマ
```typescript
// データベース名: weiwudi-cache-v1（v0は weiwudi-cache）

// resourcesテーブル：リソース管理
interface Resource {
  url: string;                    // プライマリキー（実際のURL）
  urlTemplate?: string;           // テンプレート形式のURL（タイル用）
  type: "style" | "tile" | "sprite" | "font" | "geojson";
  metadata?: {
    styleId?: string;             // どのスタイルに属するか
    tileset?: string;             // タイルセット識別子
    bounds?: [number, number, number, number];  // [west, south, east, north]
    minzoom?: number;
    maxzoom?: number;
  };
  lastAccessed: number;           // LRU用
  size: number;                   // キャッシュサイズ
  headers?: Record<string, string>;
}

// cacheテーブル：実際のキャッシュデータ
interface CacheEntry {
  url: string;                    // プライマリキー（展開済みURL）
  resourceUrl: string;            // 所属するリソースURL
  data: Blob;                     // 実データ
  headers: Record<string, string>;
  etag?: string;
  expires?: number;
  lastModified?: string;
  created: number;
  size: number;
}

// settingsテーブル：グローバル設定
interface Settings {
  key: string;                    // プライマリキー
  value: any;
  // 例：quotaLimit, defaultExpiry, mapboxToken等
}
```

#### v0からv1への変換ロジック
```typescript
// v0のmapSetting → v1のresources
// v0: {mapID: "my-map", url: "https://example.com/tiles/{z}/{x}/{y}"}
// v1: {url: "https://example.com/tiles/{z}/{x}/{y}", type: "tile", ...}

// v0のtileCache → v1のcache
// v0: {key: "my-map/10/512/340", data: Blob}
// v1: {url: "https://example.com/tiles/10/512/340", data: Blob, ...}
```

### v0からv1への自動マイグレーション

#### マイグレーション戦略
```typescript
class WeiwudiMigration {
  async migrate(): Promise<void> {
    // 1. v0データベースの存在確認
    const v0DB = await this.openV0Database();
    if (!v0DB) return;

    // 2. v0データの読み取り
    const v0Maps = await this.readV0Maps(v0DB);
    const v0Tiles = await this.readV0Tiles(v0DB);
    const v0Assets = await this.readV0Assets(v0DB);

    // 3. v1形式への変換
    const v1Resources = this.convertMapsToResources(v0Maps);
    const v1Cache = this.convertTilesToCache(v0Tiles, v0Maps);

    // 4. v1データベースへの書き込み
    await this.writeV1Data(v1Resources, v1Cache);

    // 5. v0データベースの削除
    await this.deleteV0Database();
  }

  private convertMapsToResources(v0Maps: any[]): Resource[] {
    return v0Maps.map(map => ({
      url: map.url,
      urlTemplate: map.url,
      type: this.detectResourceType(map),
      metadata: {
        bounds: map.bounds,
        minzoom: map.minzoom,
        maxzoom: map.maxzoom
      },
      lastAccessed: Date.now(),
      size: 0
    }));
  }

  private convertTilesToCache(v0Tiles: any[], v0Maps: any[]): CacheEntry[] {
    return v0Tiles.map(tile => {
      const map = v0Maps.find(m => tile.key.startsWith(m.mapID));
      const expandedUrl = this.expandTileUrl(map.url, tile.key);
      
      return {
        url: expandedUrl,
        resourceUrl: map.url,
        data: tile.data,
        headers: tile.headers || {},
        created: tile.epoch || Date.now(),
        size: tile.data.size
      };
    });
  }
}
```

#### マイグレーションのタイミング
1. Service Worker登録時に実行
2. バックグラウンドで非同期実行
3. プログレスをユーザーに通知（オプション）
4. 失敗時は旧データを削除（キャッシュなので再取得可能）

#### マイグレーション失敗時の処理
```typescript
async migrate(): Promise<void> {
  try {
    const v0DB = await this.openV0Database();
    if (!v0DB) return;
    
    // マイグレーション実行
    await this.performMigration(v0DB);
    
  } catch (error) {
    console.warn('Weiwudi v0 cache migration failed, cleaning up old data', error);
    // マイグレーション失敗時もv0データを削除
    await this.deleteV0Database().catch(() => {});
    // v1で新規開始
  }
}
```

---

## 議論項目一覧

### 1. mapbox:スキーマの解決機能

**現状**: mapbox:スキーマ（例：`mapbox://styles/mapbox/streets-v11`）からHTTPS URLへの解決が未実装

**議論ポイント**:
- mapbox:スキーマの解決ロジックをどこに実装するか
- アクセストークンの管理方法
- 解決したURLのキャッシュ戦略

### 2. 定義ファイルからの芋づる式アセット登録

**現状**: 定義ファイル取得時に、その中に含まれる他のアセットURLを自動登録する機能が未実装

**議論ポイント**:
- 自動登録のタイミング（定義ファイル取得時？初回使用時？）
- 既存の手動登録との競合解決
- 部分的な登録失敗時の処理

### 3. 1タイルセットに対する複数スタイル管理

**現状**: 1つのタイルセットに対して1つのスタイルのみ対応

**議論ポイント**:
- 複数スタイルの識別方法（番号付き？名前付き？）
- デフォルトスタイルの決定方法
- APIインターフェースの設計

### 4. フォントの動的URLテンプレート処理

**現状**: `{fontstack}/{range}.pbf`形式のテンプレート処理が不完全

**議論ポイント**:
- テンプレート変数の展開タイミング
- 複数フォントスタックの管理
- キャッシュキーの生成方法

### 5. スプライトの解像度別処理

**現状**: `@2x.png`等の解像度別スプライト処理が不完全

**議論ポイント**:
- 解像度の判定方法（デバイス？リクエスト？）
- サポートする解像度の種類（1x, 2x, 3x?）
- フォールバック戦略

### 6. ユーザー設定可能なクオータ制限

**現状**: 固定500MBのクオータのみ

**議論ポイント**:
- クオータ設定のAPIインターフェース
- マップごとの個別クオータ vs 全体クオータ
- 設定の永続化方法

### 7. 古いキャッシュの自動削除（LRU等）

**現状**: クオータ超過時の自動削除機能なし

**議論ポイント**:
- 削除アルゴリズム（LRU？LFU？時間ベース？）
- 削除単位（タイル単位？マップ単位？）
- 削除時の通知機能

## 各項目の詳細仕様（順次追加）

### 1. mapbox:スキーマの解決機能

#### 仕様案

##### 1.1 対応するmapbox:スキーマ形式

以下の形式に対応する：
- スタイル: `mapbox://styles/{username}/{style_id}`
- タイルセット: `mapbox://mapbox.{tileset_id}` または `mapbox://{username}.{tileset_id}`
- スプライト: `mapbox://sprites/{username}/{style_id}`
- フォント: `mapbox://fonts/{username}/{fontstack}/{range}.pbf`

##### 1.2 URL変換の実装

**@c4h/beatboxモジュールを使用**
- URL変換ロジックは@c4h/beatboxに委譲
- Weiwudiは変換後のURLをプロキシ/キャッシュ処理

```typescript
import { BeatBox } from '@c4h/beatbox';

// BeatBoxを使用したURL変換
const beatbox = new BeatBox({ accessToken });
const httpUrl = await beatbox.toHttpUrl(mapboxUrl);
```

##### 1.3 アクセストークンの管理

```typescript
interface MapboxConfig {
  accessToken?: string;  // Mapboxアクセストークン（pk.*のみ）
  transformMapboxUrls?: boolean;  // mapbox:スキーマの自動変換を有効化（デフォルト: true）
}

// 登録時にアクセストークンを指定
const map = await Weiwudi.registerMap("my-map", {
  url: "mapbox://styles/mapbox/streets-v11",  // mapbox:スキーマで指定可能
  mapboxConfig: {
    accessToken: "pk.xxx...",  // publicトークンのみ
    transformMapboxUrls: true
  }
});
```

**トークンの保存**
- IndexedDBに平文で保存（publicトークンのため暗号化不要）
- Service Worker内でのみ使用

##### 1.4 実装場所

1. **依存関係の追加**
   - package.jsonに`@c4h/beatbox`を追加

2. **Service Worker内での処理**
   - `weiwudi_gw_logic.ts`にインポートと初期化
   - `getAsset`関数内でBeatBoxを使用してURL変換
   - 定義ファイル内のmapbox:スキーマも自動変換

3. **クライアントAPI**
   - `registerMap`メソッドで`mapboxConfig`オプションを受け付け
   - アクセストークンをmapSettingテーブルに保存

##### 1.5 セキュリティ考慮事項

- publicトークン（pk.）のみサポート
- secretトークン（sk.）は受け付け拒否（エラーを返す）
- アクセストークンはIndexedDBに平文で保存（publicトークンのみのため）
- Service Worker内でのみ使用し、クライアントAPIには露出しない

##### 1.6 キャッシュデータの管理

**内部的なキャッシュ管理**
- mapSettingテーブルには元のmapbox:スキーマURLを保存
- キャッシュキーも元のmapbox:スキーマを基に生成
- Service Worker内で動的にHTTP URLに変換してフェッチ

**プロキシURL形式（変更なし）**
```
// スタイル定義
http://example.com/{mapID}/definition

// タイル
http://example.com/{mapID}/{z}/{x}/{y}

// その他のアセット
// ※動的URLテンプレートに対応
http://example.com/{mapID}/fonts/{fontstack}/{range}
http://example.com/{mapID}/icons[@2x]
```

##### 1.7 @c4h/beatboxへのフィードバック

現時点では特にフィードバック事項はありません。@c4h/beatboxの現在のインターフェースがWeiwudiの要件に適合しています。

### 2. スタイルファイルからの芋づる式アセット登録

#### 仕様案（キャッシュ仕様v1版）

##### 2.1 基本コンセプト
スタイルファイル（style.json）を登録すると、その中で参照されているすべてのリソースを自動的に登録する。

##### 2.2 実装方法
```typescript
interface WeiwudiOptions {
  autoRegisterAssets?: boolean;  // デフォルト: true
  mapboxAccessToken?: string;
}

// 使用例
await weiwudi.register({
  url: "https://example.com/style.json",
  options: {
    autoRegisterAssets: true,
    mapboxAccessToken: "pk.xxx..."
  }
});
```

##### 2.3 自動登録フロー
```typescript
async registerStyleWithAssets(styleUrl: string, options: WeiwudiOptions) {
  // 1. スタイルファイルを取得
  const style = await fetch(styleUrl).then(r => r.json());
  
  // 2. BeatBoxを使ってスタイル内のURLを解析・変換
  const beatbox = new BeatBox({ accessToken: options.mapboxAccessToken });
  const resolvedStyle = await beatbox.translateStyle(styleUrl);
  
  // 3. リソースを抽出して登録
  const resources = await beatbox.getStyleResources(styleUrl);
  
  // 4. 各リソースをresourcesテーブルに登録
  await this.registerResources([
    // スタイル自体
    { url: styleUrl, type: "style" },
    
    // タイルソース
    ...resources.tiles.map(tileUrl => ({
      url: tileUrl,
      urlTemplate: tileUrl,
      type: "tile" as const,
      metadata: { styleId: styleUrl }
    })),
    
    // スプライト
    ...resources.sprites.map(spriteUrl => ({
      url: spriteUrl,
      type: "sprite" as const,
      metadata: { styleId: styleUrl }
    })),
    
    // フォント（URLテンプレート）
    {
      url: resources.glyphs,
      urlTemplate: resources.glyphs,
      type: "font" as const,
      metadata: { styleId: styleUrl }
    }
  ]);
}
```

##### 2.4 競合解決
- 同じURLのリソースが既に登録されている場合は、metadataのstyleIdに追加
- 異なるスタイルから同じタイルセットが参照される場合も自動的に共有

### 3. 1タイルセットに対する複数スタイル管理

#### 仕様案（キャッシュ仕様v1版）

##### 3.1 キャッシュ仕様v1での簡素化
キャッシュ仕様v1では、URLベースの管理により複数スタイル管理が自動的に実現される：

- 異なるスタイルURL = 異なるリソース
- 同じタイルセットURL = 自動的に共有
- IDによる管理が不要

##### 3.2 実装
```typescript
// 複数スタイルの登録（それぞれ独立したリソースとして管理）
await weiwudi.register({
  url: "https://api.mapbox.com/styles/v1/mapbox/streets-v11",
  options: { mapboxAccessToken: "pk.xxx..." }
});

await weiwudi.register({
  url: "https://api.mapbox.com/styles/v1/mapbox/dark-v10",
  options: { mapboxAccessToken: "pk.xxx..." }
});

// 両スタイルが同じタイルセットを参照していても、
// タイルURLが同じなら自動的に共有される
```

##### 3.3 スタイル切り替えの実装
アプリケーション側で管理：
```typescript
// アプリケーション側でスタイルURLを管理
const styles = {
  streets: "https://api.mapbox.com/styles/v1/mapbox/streets-v11",
  dark: "https://api.mapbox.com/styles/v1/mapbox/dark-v10",
  satellite: "https://api.mapbox.com/styles/v1/mapbox/satellite-v11"
};

// スタイル切り替え
map.setStyle(styles.dark);

### 4. フォントの動的URLテンプレート処理

#### 仕様案（キャッシュ仕様v1版）

##### 4.1 フォントURLテンプレートの形式
```
https://api.mapbox.com/fonts/v1/{username}/{fontstack}/{range}.pbf
```
- `{fontstack}`: フォント名（カンマ区切りで複数可）
- `{range}`: Unicode範囲（例: "0-255", "256-511"）

##### 4.2 Service Workerでの処理
```typescript
// Service Worker内でのフェッチハンドラ
async function handleFontRequest(request: Request): Response {
  const url = new URL(request.url);
  
  // resourcesテーブルからフォントテンプレートを検索
  const fontResource = await findFontTemplate(url);
  if (!fontResource) return fetch(request);
  
  // 実際のフォントURLを構築
  const actualUrl = expandFontUrl(fontResource.urlTemplate, url);
  
  // キャッシュチェック
  const cached = await getCacheEntry(actualUrl);
  if (cached) return new Response(cached.data, { headers: cached.headers });
  
  // フェッチしてキャッシュ
  const response = await fetch(actualUrl);
  if (response.ok) {
    await saveCacheEntry({
      url: actualUrl,
      resourceUrl: fontResource.url,
      data: await response.blob(),
      headers: response.headers
    });
  }
  
  return response;
}

// URLテンプレートの展開
function expandFontUrl(template: string, requestUrl: URL): string {
  // requestUrlからfontstack, rangeを抽出して展開
  const pathParts = requestUrl.pathname.split('/');
  const fontstack = pathParts[pathParts.length - 2];
  const range = pathParts[pathParts.length - 1].replace('.pbf', '');
  
  return template
    .replace('{fontstack}', fontstack)
    .replace('{range}', range);
}
```

##### 4.3 複数フォントスタックの管理
- カンマ区切りのフォントスタック（例: "Noto Sans,Arial"）もそのままキャッシュキーとして使用
- 各組み合わせが独立したキャッシュエントリとなる

### 5. スプライトの解像度別処理

#### 仕様案（キャッシュ仕様v1版）

##### 5.1 スプライトファイルの種類
1つのスプライトURLから4つのファイルが派生：
- `sprite.json`: メタデータ（1x）
- `sprite.png`: 画像（1x）
- `sprite@2x.json`: メタデータ（2x）
- `sprite@2x.png`: 画像（2x）

##### 5.2 Service Workerでの処理
```typescript
async function handleSpriteRequest(request: Request): Response {
  const url = new URL(request.url);
  
  // スプライトリソースを検索
  const spriteResource = await findSpriteResource(url);
  if (!spriteResource) return fetch(request);
  
  // リクエストされたファイルの種類を判定
  const spriteType = detectSpriteType(url.pathname);
  const actualUrl = buildSpriteUrl(spriteResource.url, spriteType);
  
  // キャッシュ処理（フォントと同様）
  const cached = await getCacheEntry(actualUrl);
  if (cached) return new Response(cached.data, { headers: cached.headers });
  
  const response = await fetch(actualUrl);
  if (response.ok) {
    await saveCacheEntry({
      url: actualUrl,
      resourceUrl: spriteResource.url,
      data: await response.blob(),
      headers: response.headers
    });
  }
  
  return response;
}

function detectSpriteType(pathname: string): SpriteType {
  if (pathname.endsWith('@2x.json')) return { resolution: '2x', format: 'json' };
  if (pathname.endsWith('@2x.png')) return { resolution: '2x', format: 'png' };
  if (pathname.endsWith('.json')) return { resolution: '1x', format: 'json' };
  if (pathname.endsWith('.png')) return { resolution: '1x', format: 'png' };
}

function buildSpriteUrl(baseUrl: string, type: SpriteType): string {
  const suffix = type.resolution === '2x' ? '@2x' : '';
  return `${baseUrl}${suffix}.${type.format}`;
}
```

##### 5.3 解像度の自動選択
- クライアントが要求した解像度をそのまま使用
- フォールバックは地図ライブラリ側で処理（Weiwudiは関与しない）

### 6. ユーザー設定可能なクオータ制限

#### 仕様案（キャッシュ仕様v1版）

##### 6.1 API設計
```typescript
interface QuotaOptions {
  maxCacheSize?: number;      // バイト単位（デフォルト: 500MB）
  maxResourceSize?: number;   // リソース単位の最大サイズ（デフォルト: 50MB）
  alertThreshold?: number;    // 警告閾値（デフォルト: 0.9 = 90%）
}

// グローバル設定
await weiwudi.setQuota({
  maxCacheSize: 1024 * 1024 * 1024,  // 1GB
  alertThreshold: 0.8                 // 80%で警告
});

// 現在の使用状況取得
const usage = await weiwudi.getStorageUsage();
// {
//   used: 423456789,
//   quota: 1073741824,
//   percentage: 0.394,
//   resources: 1234
// }
```

##### 6.2 実装
```typescript
// settingsテーブルに保存
await saveSettings({
  key: 'quotaLimit',
  value: options.maxCacheSize
});

// キャッシュ追加前のチェック
async function checkQuotaBeforeSave(size: number): Promise<boolean> {
  const settings = await getSettings();
  const usage = await calculateTotalCacheSize();
  const quotaLimit = settings.quotaLimit || DEFAULT_QUOTA;
  
  if (usage + size > quotaLimit * 0.9) {
    // イベント発火
    self.dispatchEvent(new CustomEvent('quotawarning', {
      detail: { used: usage, limit: quotaLimit }
    }));
  }
  
  return usage + size <= quotaLimit;
}
```

##### 6.3 クオータ超過時の動作
- 新規キャッシュの保存を拒否
- 警告イベントを発火
- 自動削除は次項（LRU）で対応

### 7. 古いキャッシュの自動削除（LRU等）

#### 仕様案（キャッシュ仕様v1版）

##### 7.1 削除戦略
**LRU（Least Recently Used）を採用**
- resourcesテーブルのlastAccessedフィールドを使用
- リソース単位で削除（関連するキャッシュエントリも削除）

##### 7.2 自動削除のトリガー
```typescript
interface AutoCleanupOptions {
  enabled?: boolean;           // デフォルト: false
  strategy?: 'lru' | 'lfu';   // デフォルト: 'lru'
  targetPercentage?: number;   // クリーンアップ後の目標使用率（デフォルト: 0.7 = 70%）
}

await weiwudi.setAutoCleanup({
  enabled: true,
  strategy: 'lru',
  targetPercentage: 0.7
});
```

##### 7.3 実装
```typescript
async function autoCleanup(): Promise<void> {
  const settings = await getSettings();
  if (!settings.autoCleanupEnabled) return;
  
  const usage = await calculateTotalCacheSize();
  const quotaLimit = settings.quotaLimit || DEFAULT_QUOTA;
  
  if (usage > quotaLimit) {
    const targetSize = quotaLimit * (settings.targetPercentage || 0.7);
    const toDelete = usage - targetSize;
    
    // LRUでリソースを取得
    const resources = await getResourcesSortedByLastAccess();
    let deleted = 0;
    
    for (const resource of resources) {
      if (deleted >= toDelete) break;
      
      // リソースとその関連キャッシュを削除
      const size = await deleteResourceAndCache(resource.url);
      deleted += size;
      
      // 削除通知
      self.dispatchEvent(new CustomEvent('resourcedeleted', {
        detail: { url: resource.url, size, reason: 'lru' }
      }));
    }
  }
}

// キャッシュヒット時にlastAccessedを更新
async function updateLastAccessed(resourceUrl: string): Promise<void> {
  await updateResource(resourceUrl, {
    lastAccessed: Date.now()
  });
}
```

##### 7.4 削除の粒度
- **リソース単位**: スタイル、タイルセット単位で削除
- **保護機能**: 特定のリソースを削除対象外に設定可能
```typescript
await weiwudi.protectResource(url, true);  // 削除対象外に設定
```

### 8. Workboxプラグイン互換性とユーザー拡張機能

#### 仕様案

##### 8.1 Weiwudiプラグインインターフェース
Workboxのプラグインインターフェースに準拠した独自のプラグインシステムを実装：

```typescript
interface WeiwudiPlugin {
  // Workbox互換のライフサイクルフック
  requestWillFetch?: (params: {
    request: Request;
    event: FetchEvent;
    state: any;
  }) => Promise<Request | void>;
  
  fetchDidSucceed?: (params: {
    request: Request;
    response: Response;
    event: FetchEvent;
    state: any;
  }) => Promise<Response | void>;
  
  fetchDidFail?: (params: {
    error: Error;
    request: Request;
    event: FetchEvent;
    state: any;
  }) => Promise<Response | void>;
  
  // Weiwudi独自のフック
  resourceWillRegister?: (params: {
    resource: Resource;
  }) => Promise<Resource | void>;
  
  cacheWillClean?: (params: {
    resources: Resource[];
    reason: 'manual' | 'lru' | 'quota';
  }) => Promise<Resource[] | void>;
}
```

##### 8.2 プラグインの登録と使用
```typescript
// プラグインの登録
await weiwudi.registerPlugin({
  requestWillFetch: async ({ request, state }) => {
    // 独自のヘッダーを追加
    const modifiedRequest = new Request(request, {
      headers: {
        ...request.headers,
        'X-Custom-Header': 'value'
      }
    });
    return modifiedRequest;
  },
  
  fetchDidSucceed: async ({ response, state }) => {
    // レスポンスの加工
    if (response.headers.get('content-type')?.includes('application/json')) {
      const data = await response.json();
      const modified = { ...data, timestamp: Date.now() };
      return new Response(JSON.stringify(modified), {
        headers: response.headers
      });
    }
    return response;
  }
});
```

##### 8.3 Workboxとの統合
```typescript
// Service Worker内での統合例
import { registerRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';

// Weiwudiが管理するURL以外はWorkboxで処理
registerRoute(
  ({ url }) => !weiwudi.isManaged(url),
  new NetworkFirst({
    cacheName: 'other-resources',
    plugins: [
      // Workboxプラグイン
      {
        requestWillFetch: async ({ request }) => {
          console.log('Workbox handling:', request.url);
          return request;
        }
      }
    ]
  })
);

// WeiwudiはWorkboxのルーターと共存
self.addEventListener('fetch', (event) => {
  if (weiwudi.isManaged(event.request.url)) {
    event.respondWith(weiwudi.handle(event));
  }
  // それ以外はWorkboxのルーターが処理
});
```

##### 8.4 実装上の考慮事項
1. **プラグインの実行順序**: 登録順に実行
2. **エラーハンドリング**: プラグインのエラーは握りつぶさず、ログに記録
3. **パフォーマンス**: プラグインの処理時間を監視
4. **Workbox互換性**: 可能な限りWorkboxのプラグインAPIに準拠