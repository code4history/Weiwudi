<!-- SECTION 1: Header (badges, title) -->
<h1 align="center">Weiwudi</h1>

<p align="center">
  <a href="https://github.com/code4history/Weiwudi/actions/workflows/ci.yml"><img src="https://github.com/code4history/Weiwudi/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@c4h/weiwudi"><img src="https://img.shields.io/npm/v/@c4h/weiwudi" alt="npm version" /></a>
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
- 一括取得 (`fetchAll`) と進捗イベント (`proceed` / `finish` / `stop`)
- URL テンプレート経由で Leaflet・OpenLayers など任意のマップライブラリと連携
- MIT ライセンスのオープンソース・peer dependency は `workbox-routing`

<!-- SECTION 5: Quick Start -->
## クイックスタート

> 特定リリースに紐づく情報（ADR-0012）。下記のバージョン `0.3.0` は現在の
> リリース値です。リリースごとに更新してください。

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

// サービスワーカーを登録
await Weiwudi.registerSW('./sw.js', { scope: './' });

// XYZ タイルマップを登録
const map = await Weiwudi.registerMap('xyz_map', {
  type: 'xyz',
  width: 10000,
  height: 6000,
  url: 'http://example.com/{z}/{x}/{y}.jpg'
});

// キャッシュ済み URL テンプレート経由でタイルを読み込み
L.tileLayer(map.url).addTo(leafletMap);
```

### CDN（jsDelivr）

ビルドツールを使わずにブラウザで利用する場合は、CDN 経由で Weiwudi を読み込みます:

```html
<!-- Weiwudi メインライブラリ -->
<script src="https://cdn.jsdelivr.net/npm/@c4h/weiwudi@0.3.0/dist/weiwudi.umd.js"></script>
```

サービスワーカーファイルでは以下のように使用します:

```js
// サービスワーカー内 (sw.js)
importScripts("https://cdn.jsdelivr.net/npm/workbox-routing@7.4.0/build/workbox-routing.prod.umd.min.js");
importScripts("https://cdn.jsdelivr.net/npm/@c4h/weiwudi@0.3.0/dist/weiwudi-sw.umd.js");
```

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
pnpm run test:e2e
```

テストでは以下を検証します:
- サービスワーカーの登録とアクティベーション
- タイルキャッシュの動作
- キャッシュ統計の取得
- キャッシュクリア機能

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
