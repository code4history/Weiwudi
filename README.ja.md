<!-- SECTION 1: Header (badges, title) -->
<h1 align="center">Weiwudi</h1>

<p align="center">
  <a href="https://github.com/code4history/Weiwudi/actions/workflows/ci.yml"><img src="https://github.com/code4history/Weiwudi/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@c4h/weiwudi" alt="License" /></a>
</p>

<!-- SECTION 2: Elevator Pitch -->
## Weiwudi について

Weiwudi はタイルキャッシュ用のサービスワーカーです。マップ設定を登録するとタイル画像が IndexedDB にキャッシュされ、Leaflet・OpenLayers などのマップライブラリはキャッシュ済みの URL テンプレートを通じて修正なしにタイルを読み込めます。
プロジェクト名は、曹操 (Cao Cao) の名でも知られる中国後漢時代の武将
[魏武帝 (Weiwudi)](https://zh.wikipedia.org/wiki/%E6%9B%B9%E6%93%8D) に由来しています。

Weiwudi は MIT License のオープンソースソフトウェアです。

<!-- SECTION 3: Language switch link -->
**[英語版はこちら / Read this document in English](README.md)**

<!-- SECTION 4: Key Features -->
## 主な特徴

- Service Worker ベースの XYZ・WMTS タイルマップ向けタイルキャッシュ
- キャッシュ済み URL テンプレート経由の IndexedDB 自動タイルキャッシュ
- ページリロードなしの初回プロキシ有効化（`skipWaiting` + `clients.claim`）
- マップ単位のキャッシュ容量上限（`cacheMaxBytes`）と LRU 自動削除
- 一括取得 (`fetchAll`) と進捗イベント (`proceed` / `finish` / `stop`)
- URL テンプレート経由で Leaflet・OpenLayers など任意のマップライブラリと連携
- 地図ライブラリが要求する実際のタイルの URL をそのままキャッシュする Source の API（`Weiwudi.register`）
- MIT ライセンスのオープンソース・peer dependency は `workbox-routing`

<!-- SECTION 5: Quick Start -->
## クイックスタート

<!-- release-pinned:start -->
> **現在のリリース: `1.1.1`**。このブロックは本リポジトリで唯一
> リリース版数を持つ場所です（ADR-0012）。ブロックの外はすべて 1.0 正式版を前提に
> 書かれています。
> npm: [`@c4h/weiwudi`](https://www.npmjs.com/package/@c4h/weiwudi)
> [![npm](https://img.shields.io/npm/v/@c4h/weiwudi)](https://www.npmjs.com/package/@c4h/weiwudi)

### インストール

```bash
# pnpm（推奨）
pnpm add @c4h/weiwudi

# npm
npm install @c4h/weiwudi
```

### 最小利用例

```typescript
import Weiwudi from '@c4h/weiwudi';

// サービスワーカーを登録（ページが制御下に入った時点で解決。
// 初回アクセスからリロードなしで制御されます）
await Weiwudi.registerSW('./sw.js', { scope: './' });

// XYZ タイルマップを登録
const map = await Weiwudi.registerMap('xyz_map', {
  type: 'xyz',
  width: 10000,
  height: 6000,
  url: 'http://example.com/{z}/{x}/{y}.jpg',
  cacheMaxBytes: 500 * 1024 * 1024 // キャッシュ容量の上限(byte、省略可)
});

// キャッシュ済み URL テンプレート経由でタイルを読み込み
L.tileLayer(map.url).addTo(leafletMap);
```

`registerSW` はサービスワーカーが現在のページを制御下に置いた時点で解決します
（初回アクセスでもリロードなし）。制御できない場合（ページ URL が登録スコープ外
など）は `"Error: Service worker did not control this page within 10000 ms"` で
reject します。`cacheMaxBytes` はマップごとのキャッシュ合計サイズを制限し、
最も使われていないタイルから自動削除します。省略すると容量上限なしです。

reject は文字列のままなので、これまでの `e.match(...)` での分岐はそのまま動きます。
原因で分岐したいときは `WeiwudiError.from` で変換します（コードと文面は
[エラー](docs/api/weiwudi.ja.md#エラー) を参照）:

```typescript
import Weiwudi, { WeiwudiError } from '@c4h/weiwudi';

try {
  await map.fetchAll();
} catch (e) {
  if (WeiwudiError.from(e).code === 'fetch-busy') { /* 別の取得が走っている */ }
}
```

`map.url` から配るタイルは、取得や保存に失敗したとき応答ヘッダ `x-weiwudi-error`
（`network`・`upstream`・`quota`・`storage`）を付けます。

### CDN（jsDelivr）

ビルドツールを使わずにブラウザで利用する場合は、CDN 経由で Weiwudi を読み込みます:

```html
<!-- Weiwudi メインライブラリ -->
<script src="https://cdn.jsdelivr.net/npm/@c4h/weiwudi@1.1.1/dist/weiwudi.umd.js"></script>
```

サービスワーカーファイルでは以下のように使用します:

```js
// サービスワーカー内 (sw.js)
importScripts("https://cdn.jsdelivr.net/npm/workbox-core@7.4.0/build/workbox-core.prod.js");
importScripts("https://cdn.jsdelivr.net/npm/workbox-routing@7.4.0/build/workbox-routing.prod.js");
importScripts("https://cdn.jsdelivr.net/npm/@c4h/weiwudi@1.1.1/dist/weiwudi-sw.umd.js");
```

### サービスワーカーの差し込み口

`@c4h/weiwudi/sw` は、タイルの取得と保存に処理を差し込む `addPlugin` を export します。
Workbox のプラグインのフック名を借りた Weiwudi 独自の API です。サービスワーカーのスクリプトの
先頭で呼びます。UMD 版では `self.Weiwudi_SW.addPlugin` を使います。

```js
// sw.js（ES モジュールのサービスワーカー）
import { addPlugin } from '@c4h/weiwudi/sw';

addPlugin({
  async requestWillFetch({ request }) {
    return new Request(request, { headers: { 'x-api-key': 'public-key' } });
  },
  async cacheWillUpdate({ response }) {
    return response.headers.get('content-type')?.startsWith('image/') ? response : null; // null は保存しない
  },
});
```

`requestWillFetch` で足したヘッダは、要求が `no-cors`（`<img>` 要素のタイルなど）のとき
ブラウザが捨てます。上流が必要とするなら `mode: 'cors'` の `Request` を作り直してください。

詳しくは [サービスワーカーの API](docs/api/sw.ja.md) を参照してください。

### 実際のタイルの URL をキャッシュする（Source の API）

`Weiwudi.register` に地図ライブラリが要求する URL テンプレートを登録すると、サービスワーカーがその実 URL を
直接キャッシュします。地図ライブラリには元の URL をそのまま渡します。

```typescript
import Weiwudi from '@c4h/weiwudi';

await Weiwudi.registerSW('./sw.js', { scope: './' });
const source = await Weiwudi.register({
  kind: 'raster', // または 'vector'
  url: 'https://tile.example.com/{z}/{x}/{y}.png',
});
// register() の完了を待ってから地図を作る（先に出た要求はキャッシュされない）
L.tileLayer(source.url as string).addTo(leafletMap);

console.log(source.warnings, await source.stats());
```

- 試験しているのは Chromium だけです。**WebKit・Firefox は未確認です。**
- この版の `kind` は `'raster'` と `'vector'` です。`'style'`・`'asset'` は `unsupported-kind` で拒否します。
- 明示の `id` は公開の値です（`sources()` と `warnings` に出ます）。資格情報を入れず、`credentials` で渡してください。
- サービスワーカーが `credentials` を足すのはページの要求と同じオリジンの要求だけで、ヘッダの資格情報を足した要求は
  `redirect: 'error'` で出します。秘密トークン（クエリの `sk.`・`sk.eyJ…` のパスの区画）は拒否し、同じ資格情報の項目に
  違う値を持つミラーは `attribute-invalid` で拒否します。
- `mapbox://` の URL は標準で `https://api.mapbox.com/…` へ解決します（アクセストークンは
  `credentials: { query: { access_token } }` で渡します）。オフライン保存の可否を含め、提供元の利用規約の確認は
  利用者の責任です。**第三者のスタイルの中の `mapbox://` は対象外です**。解決するのは、利用者が `mapbox://` か
  Mapbox の `https` の URL で登録したスタイルの中だけです（第三者のスタイルへ利用者の Mapbox のトークンを使わせません）。
  ほかの提供元は、サービスワーカーで `addProvider` を使って足せます
  （[サービスワーカーの API](docs/api/sw.ja.md#addproviderprovider-weiwudiprovider-void)）。
- 失敗は `WeiwudiError`（`sw-not-controlling`・`sw-outdated`・`source-not-found` など）で reject します。
  既存の資源と合流できない資源があっても `register()` は失敗せず、`source.warnings` に書きます。
- サービスワーカーでは **Weiwudi の import を先に書き**（`import '@c4h/weiwudi/sw'` か `importScripts` の行）、
  自分の Workbox のルートはその後に登録してください。Weiwudi より前に登録した全捕捉のルート（`/.*/` など）は、
  タイルの要求をすべて先に取ります。

詳しくは [Source の API](docs/api/weiwudi.ja.md#source-の-api) を参照してください。

### API リファレンス

- **API シグネチャ**（リリース依存）: [`docs/api/`](docs/api/) を参照

### 開発

#### 準備
リポジトリをクローンし、依存関係をインストールします。

```bash
git clone https://github.com/code4history/Weiwudi.git
cd Weiwudi
pnpm install
```

#### 開発サーバー
ホットリロード対応の開発サーバーを起動します。

```bash
pnpm dev
```

ブラウザで `http://localhost:5173/` にアクセスしてください。デモには以下の機能があります:
- Weiwudi でキャッシュされる OSM タイルを使用した Leaflet マップ
- リアルタイムキャッシュ統計（タイル数・キャッシュサイズ）
- すべてのタイルを取得するボタン
- キャッシュクリア機能

#### ビルド

```bash
pnpm build
```

これにより以下が生成されます:
- `dist/weiwudi.es.js` - モダンバンドラー用 ES モジュール
- `dist/weiwudi.umd.js` - ブラウザ用 UMD バンドル
- `dist/weiwudi-sw.es.js` - サービスワーカー用 ES モジュール
- `dist/weiwudi-sw.umd.js` - サービスワーカー用 UMD バンドル
- `dist/weiwudi.d.ts` - TypeScript 型定義

#### テスト

```bash
pnpm run test:unit   # ユニットテスト（Vitest・tests/unit/）
pnpm test            # E2E テスト（Playwright・tests/e2e/）
```

ユニットテストは Service Worker のゲートウェイロジック（`src/weiwudi_gw_logic.ts`）の API の分岐・タイルの取得とキャッシュ・容量上限を検証します。

E2E テストでは以下を検証します:
- サービスワーカーの登録とアクティベーション
- タイルキャッシュの動作
- キャッシュ統計の取得
- キャッシュクリア機能
<!-- release-pinned:end -->

<!-- SECTION 6: Prerequisites -->
## 動作環境

> `package.json` の `engines` フィールドから自動抽出（ADR-0012: 特定リリースに紐づく）。

- Node.js: `>= 20.0.0`
- pnpm: `>= 9.0.0`（推奨・npm も可）

<!-- SECTION 7: Peer Dependencies -->
## Peer Dependencies

Weiwudi は `workbox-routing` を peer dependency として要求します。併せてインストールしてください:

```bash
pnpm add workbox-routing
```

<!-- SECTION 8: Ecosystem / Related Repositories -->
## エコシステム

Weiwudi は [Code for History](https://github.com/code4history) が運営する
Maplat エコシステムの一部です。全容は下記エコシステム図を参照してください。

📖 **エコシステム図** — *（図は現在外部非公開の計画リポジトリにあります。
公開ビューアからは下記の姉妹リポジトリ表で代替します）*

### 姉妹リポジトリ

| リポジトリ | ライセンス | npm | 役割 |
|---|---|---|---|
| [Maplat](https://github.com/code4history/Maplat) | Apache 2.0 | `@maplat/ui` | メインビューア |
| [MaplatCore](https://github.com/code4history/MaplatCore) | Apache 2.0 | `@maplat/core` | コアライブラリ |
| [MaplatTin](https://github.com/code4history/MaplatTin) | Apache 2.0 | `@maplat/tin` | TIN 変換 |
| [MaplatTransform](https://github.com/code4history/MaplatTransform) | Apache 2.0 | `@maplat/transform` | 座標変換 |
| [MaplatEditor](https://github.com/code4history/MaplatEditor) | Apache 2.0 | — | データ作成ツール（デスクトップ） |
| [Chuci](https://github.com/code4history/Chuci) | MIT | `@c4h/chuci` | マルチメディアスワイパー/ビューア Web Components |
| [Quyuan](https://github.com/code4history/Quyuan) | MIT | `@c4h/quyuan` | GeoJSON テンプレートエンジン＋マルチメディアビューア Web Components |
| [Weiwudi](https://github.com/code4history/Weiwudi) | MIT | `@c4h/weiwudi` | タイルキャッシュ用 Service Worker |

> MaplatEditor は上記ビューアライブラリが描画する地図・POI を作成する
> データ作成ツールです。Maplat エコシステムはエンドツーエンド:
> MaplatEditor で作成し、いずれかのビューアライブラリで公開、という流れになります。

<!-- SECTION 9: Nayuta links -->
<!-- MIT ライセンスのリポジトリ（Weiwudi / Quyuan / Chuci）へは那由多社リンクを置きません（ADR-0012）。 -->

<!-- SECTION 10: License -->
## License

MIT License — 詳細は [LICENSE](LICENSE) を参照。

```
Copyright (c) 2020-2026 Code for History

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

<!-- SECTION 11: Contributors / Sponsors (optional) -->
<!-- Weiwudi には Contributors / Sponsors 節はありません。 -->
