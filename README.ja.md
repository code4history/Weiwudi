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
- 全 Source を合わせたキャッシュ容量上限（`Weiwudi.setLimits({ maxBytes })`）と、ブラウザの容量超過のときの 10% の LRU 退避と 1 回の再試行
- 一括取得 (`fetchAll`) と進捗イベント (`proceed` / `finish` / `stop`)
- URL テンプレート経由で Leaflet・OpenLayers など任意のマップライブラリと連携
- 地図ライブラリが要求する実際のラスタ・ベクタタイルの URL をそのままキャッシュする Source の API（`Weiwudi.register`）
- スタイルと参照先の TileJSON・タイル・グリフ・スプライト・GeoJSON・画像の登録
- オフライン向けの範囲取得と固定（`estimate`・`fetchRange`・`regions`・`cancel`）、範囲の解放（`releaseRange`）と掃除（`clean`）
- キャッシュの保持期間（`cacheRetention`）。固定した Entry は期限切れの掃除から保護
- 既存タイルキャッシュの段階的な移行と、移行中のオフラインでの読み出し
- 標準の `mapbox://` URL 解決と独自の提供元の追加（`addProvider`）
- 要求・キャッシュの読み出し・保存に差し込む Service Worker プラグイン（`addPlugin`）
- MIT ライセンスのオープンソース・peer dependency は `workbox-routing`

<!-- SECTION 5: Quick Start -->
## クイックスタート

<!-- release-pinned:start -->
> **現在のリリース: `1.1.1`**。下のインストール手順と旧 API の例はこのリリース向けです
> （ADR-0012）。機能一覧と API 文書には、このブランチで実装済みの変更も記載しています。
> [Unreleased](CHANGELOG.md#unreleased) に載せた変更は、現在の npm リリースには含まれません。
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

### 1.1.x からの更新

- 1.1.x のキャッシュは、更新後の最初の要求から順に引き継ぎます（数 GB でも止まりません。移行中もオフラインで読めます）。
- 1.1.x へ戻しても壊れません（キャッシュは取り直しになります）。`indexedDB.databases()` の無い環境（古い Firefox）では、1.1.x に戻している間に作り直されたキャッシュは、もう一度は移しません。
- 移行の途中の `fetchAll` と `stats` は、移し終えたタイルだけを数えます（`fetchAll` はまだ移していないタイルをオンラインなら取り直し、`stats` の `percent` は一時的に低く出ます）。

### 上流へ送る User-Agent

サービスワーカーがタイルを上流から取るとき、ブラウザの User-Agent の後ろに `Weiwudi/<版>` を足します。
利用者の名前（`Maplat/2.0` など）も足したいときは、`registerSW` の `userAgent` で指定します。

```typescript
await Weiwudi.registerSW('./sw.js', { scope: './', userAgent: 'Maplat/2.0' });
// 上流が受け取る値: "<ブラウザの User-Agent> Maplat/2.0 Weiwudi/<版>"
// 指定しないとき:   "<ブラウザの User-Agent> Weiwudi/<版>"
```

- 値はサービスワーカー全体で 1 つです（サービスワーカーに保存し、後から指定した値が勝ちます）。`registerSW` を `userAgent`
  なしで呼ぶと、前に指定した値を外します。
- 空白だけ・制御文字を含む・印字できる ASCII 以外を含む・200 文字を超える値は、登録の前に `WeiwudiError`
  （`attribute-invalid`）で reject します。前後の空白は除きます。
- サービスワーカーのスクリプトで指定するときは `setUserAgent('Maplat/2.0')`（UMD 版は `self.Weiwudi_SW.setUserAgent`）を
  先頭で呼びます。`registerSW` の指定があれば、そちらを使います。
- **付けるのは、サービスワーカーと同じオリジンの上流への要求だけです**（mode が `cors` か `same-origin` のもの）。
  別オリジンの上流と `no-cors` の要求には付けません。
- **Chromium 系のブラウザは、サービスワーカーの要求に付けた User-Agent を捨てます**（同じオリジンでも送られません。
  取得は成功します）。Safari（WebKit）は送ります。
- 別オリジンの上流に付けると、Safari は事前確認（preflight の `OPTIONS`）を出し、それを受けないタイル配信では取得が
  失敗します。そのため Weiwudi は別オリジンには付けません。
- 別オリジンのタイル配信に利用者を名乗りたいときは、ページと同じオリジンに中継（リバースプロキシ）を置き、
  その URL を登録してください。中継から先の要求の User-Agent は中継の側で決めます。

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

- Chromium は手元と CI で試験しています。**WebKit**（Linux の Playwright の WebKit）は CI で試験しています。
  ただし Chromium でしか成り立たない試験は除きます: オフライン（`context.setOffline`）・Service Worker の停止（CDP）・
  実際の保存容量の上限・Mapbox の試験（WebKit では Service Worker の要求を Playwright が横取りできないため）。
  Linux の WebKit は iOS の Safari と同じではありません。CI の WebKit の非永続セッションでは、旧 IndexedDB キャッシュの種となる
  `Blob` の保存が失敗します。Weiwudi の新キャッシュの本体は `ArrayBuffer` で保存します。
  CI で選ぶ 37 件のうち WebKit は 35 件が成功し、旧 `Blob` を必要とする移行の 2 件をスキップします。
  そのため、その WebKit セッションでの当該移行は未確認です。Firefox は CI で 37 件すべてが成功していますが、必須の検査にはしていません。
- sandbox（`allow-scripts allow-same-origin`）の `srcdoc` の iframe は、Chromium と WebKit ではページの
  Service Worker を継ぐので、その中でも API を使えます。Firefox では継がず、中での呼び出しは `sw-not-controlling` で失敗します。
- `kind` は `'raster'`・`'vector'`・`'style'`・`'asset'` です。スタイルは参照する資源（TileJSON・タイル・グリフ・
  スプライト・GeoJSON・画像）をすべて登録します。`register()` の完了を待ってから `source.url` を MapLibre に渡します:

  ```typescript
  const style = await Weiwudi.register({ kind: 'style', url: 'https://example.com/style.json' });
  const map = new maplibregl.Map({ container, style: style.url as string });
  ```

  スタイルの資格情報を送るのはスタイルと同じオリジンとその提供元だけで、別オリジンのスタイルはページと同じオリジンの
  URL を捕捉させられません。`update()` はスタイルを取り直します
  （[スタイル](docs/api/weiwudi.ja.md#スタイルkind-style)）。
- 明示の `id` は公開の値です（`sources()` と `warnings` に出ます）。資格情報を入れず、`credentials` で渡してください。
- サービスワーカーが `credentials` を足すのはページの要求と同じオリジンの要求だけで、ヘッダの資格情報を足した要求は
  `redirect: 'error'` で出します。秘密トークン（クエリの `sk.`・`sk.eyJ…` のパスの区画）は拒否し、同じ資格情報の項目に
  違う値を持つミラーは `attribute-invalid` で拒否します。
- 署名つき URL（`X-Amz-Signature` を持つ S3 の署名つき URL など）は、署名のクエリ項目を `credentialParams` に挙げてください。
  キャッシュのキーに残らず、同じタイルが 1 つの Entry になります。サービスワーカーは署名を作れないので、`credentials` で
  足すことはできません。
- `mapbox://` の URL は標準で `https://api.mapbox.com/…` へ解決します（アクセストークンは
  `credentials: { query: { access_token } }` で渡します）。オフライン保存の可否を含め、提供元の利用規約の確認は
  利用者の責任です。**第三者のスタイルの中の `mapbox://` は対象外です**。解決するのは、利用者が `mapbox://` か
  Mapbox の `https` の URL で登録したスタイルの中だけです（第三者のスタイルへ利用者の Mapbox のトークンを使わせません）。
  ほかの提供元は、サービスワーカーで `addProvider` を使って足せます
  （[サービスワーカーの API](docs/api/sw.ja.md#addproviderprovider-weiwudiprovider-void)）。
- `source.removeResource(resourceId)` は資源 1 つの Entry を、他の Source と共有していても消します（`clean()` は共有を
  残します）。資源の登録は残ります。`Weiwudi.usage()` は保存した量の合計と提供元別の内訳（`byProvider`。鍵は提供元か
  origin）を返します。
- 失敗は `WeiwudiError`（`sw-not-controlling`・`sw-outdated`・`source-not-found`・`resource-not-found` など）で reject します。
  既存の資源と合流できない資源があっても `register()` は失敗せず、`source.warnings` に書きます。
- サービスワーカーでは **Weiwudi の import を先に書き**（`import '@c4h/weiwudi/sw'` か `importScripts` の行）、
  自分の Workbox のルートはその後に登録してください。Weiwudi より前に登録した全捕捉のルート（`/.*/` など）は、
  タイルの要求をすべて先に取ります。
- Weiwudi の門番のルート（サービスワーカーの起動後、URL の表を読み込む間のタイルの要求を受けます）は、サービスワーカーの
  スクリプトの評価の直後に登録されます。評価の後に登録したルート（イベントのハンドラの中や `await` の後）と既定のハンドラ
  （`setDefaultHandler`）より先に、それらの要求を受けます。

`cacheRetention` は `fetchedAt` からの削除期限をミリ秒で指定します（既定は無期限）。
期限を過ぎた Entry は配信で無いものとして扱い、SW の起動後の最初の store を使う Weiwudi の要求と、
ジョブの完了時にまとめて消します。この掃除では固定した Entry は消さない仕様です。グリフは保存した範囲ごとに期限を判定します。
掃除 1 回で走査するのは最大 2,000 件で、残りは次の対象要求で続けます。ジョブの実行中は掃除を止めます。
両方の ping と `fetchAll` の dispatch は掃除の契機から除き、`fetchAll` はジョブの終了時に掃除します。

範囲をオフラインで使えるようにするには `fetchRange()` で取ります。タイルは捕捉した要求と同じ形で取って固定します
（退避も期限切れの掃除もされません）:

```typescript
await Weiwudi.registerSW('./sw.js', { scope: './' });
const style = await Weiwudi.register({ kind: 'style', url: 'https://example.com/style.json' });
const map = new maplibregl.Map({ container, style: style.url as string });
await style.fetchRange({ bounds: [139.7, 35.6, 139.8, 35.7], minZoom: 10, maxZoom: 14 });
```

先に `estimate(range)` で枚数を確かめられ、`regions()` は取った region の一覧、`cancel()` は取得を止めます。同時に動く取得は
1 つで（`fetch-busy`）、途中で止まった取得はページを開いている間に自動で再開します。要求は `mode: 'cors'`・
`credentials: 'same-origin'` で出すので、別オリジンで Cookie だけで認証するサーバはこの方法では取れません。
この版のスタイルはタイルの資源のタイルを取ります（[範囲取得](docs/api/weiwudi.ja.md#範囲取得)）。

`await source.releaseRange(regionId)` は取得済みの region を解放し、残る固定つき region が必要としない Entry を排他の資源から
消します。`{ keep: true }` なら本体は残します。共有資源の本体は残し、参照する全 Source（スタイルの子は親に読み替え）の
固定つき region が必要とする固定を保ちます。非タイル資源の固定は最後の固定つき region を解放するまで保ちます。
`clean(range)` は排他の資源の固定されていないタイルだけ消し、`clean(range, { force: true })` は固定も消して自分の重なる
region を `partial` にします。共有の Entry と他の Source の region は変更しません。`clean()` は全 region を解放してから
排他の資源を空にします。自分のジョブ中の `clean`・`remove`・`releaseRange` は `fetch-busy` なので、先に
`await source.cancel()` してください。始めたバッチ（最大 `concurrency` 枚、またはグリフの 1 fontstack。
`glyphRanges: 'all'` なら最大 256 範囲）の終わりを待ちます。
[範囲の解放と掃除](docs/api/weiwudi.ja.md#範囲の解放と掃除) を参照してください。

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

ブラウザで `http://localhost:5173/` にアクセスしてください。最初にデモの入口（`index.html`）が開き、3 つのデモへ進みます:

- **ラスタのデモ**（`demo/raster.html`）: OSM のラスタタイルを `Weiwudi.register({ kind: 'raster' })` で捕捉する Leaflet の地図。統計（`stats()`・`usage()`・`regions()`）、表示範囲の一括取得（`estimate()` で見積もってから `fetchRange()`）と region ごとの解放、キャッシュの消去（`clean()`）と全体上限の入力（`Weiwudi.setLimits()`）
- **ベクタのデモ**（`demo/vector.html`）: OpenFreeMap の Liberty スタイルを `Weiwudi.register({ kind: 'style' })` で捕捉する MapLibre GL JS の地図。スタイル・TileJSON・タイル・グリフ・スプライトをまとめてキャッシュし、資源の種類ごとの統計を表示します
- **移行のデモ**（`demo/migration.html`）: 1.1.x のキャッシュ（IndexedDB `Weiwudi` / `Weiwudi_<mapID>`）を現在のストアへ移します。移行の進み具合を表示し、移したタイルを地図に描きます

各デモは同じオリジンの Service Worker（スコープはデモの配信元の直下）と Weiwudi の IndexedDB（`Weiwudi`・`Weiwudi_*`・`WeiwudiStore`）だけを使い、他のプロジェクトのサービスワーカーやデータには触れません。デモをオフラインで読み込むには、先にオンラインで 1 回読み直してください（ページを SW の制御下に入れるため）。

OSM のタイルでの範囲取得は動作確認の最小限にしてください（デモは 50 枚を超える範囲を断ります）。まとめての取得は [OSM のタイルの利用規約](https://operations.osmfoundation.org/policies/tiles/)で禁じられています。本番では自前のタイルか、規約で許された上流を使ってください。ベクタのデモの OpenFreeMap も [利用規約](https://openfreemap.org/tos/)（1 回あたり 3,000 タイルか 50 MB・並行 4 要求まで）に従い、50 枚と 50 MB までにとどめています。

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

E2E のページは既定で 5173 番で開きます。5173 番が使われているときは `WEIWUDI_E2E_PORT=5183` のように替えられます。

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
