# Weiwudi 新インタフェース仕様（#42）

- 日付: 2026-11-02 / サイクル: weiwudi-vector-cache（軽い道）/ 里程: m1
- 出発点: `vector-cache` の `575e018`（公開版 1.1.1）
- 対象 Issue: #42（本体）・#36・#37・#38・#39・#40（#9 の後継）
- 本書の決定は m2〜m4 の実装の入力である。実装中に変えるときは台帳に Ruling を残し、本書を直す

## 1. 要約

| 問い | 決定 |
|---|---|
| フック方式 | **データは実 URL を Service Worker で直接捕捉する**。制御（登録・統計・範囲取得）は従来どおり `weiwudi.example.com` 宛てに残す |
| 捕捉の判定 | メモリ上の照合表で同期判定する。SW 再起動直後は照合表が空なので、**最後に評価される「門番ルート」**が表の読み込みを待って振り分ける（§4.3、実測済み） |
| 資源モデル | `Source`（登録の単位）→ `Resource`（URL パターン 1 つ）→ `Entry`（応答 1 件）の 3 層。単一 DB `WeiwudiStore` に統合する |
| 範囲外 | ラスタは透明 PNG、ベクタは 200 の空本体。既定を選択可能。旧 API は現行どおり（広がり外は透明 PNG、ズーム外は 404） |
| 保持 | `cacheTtl`＝鮮度、`cacheRetention`＝削除期限（新設）、`cacheMaxBytes`＝容量（LRU）、`fetchRange` の既定＝固定（LRU と期限の対象外） |
| 旧 API | **残す。新コアの上の薄い層にし、実装は 1 つ**。例外は `weiwudi.example.com/api/cache/…` の経路だけ（§13） |
| 版 | **minor で足す**（`feat:`）。major は要らない。既存キャッシュはオフライン利用者の資産なので、捨てずに移行する（§14） |
| PMTiles | **本サイクルの対象外**。Range 要求は素通しし、206 は保存しない。後で足せる形にしておく（§11） |
| 第一の利用経路 | **MapLibre GL JS ＋ style.json**。MaplatCore の `maplibre` 型と MaplatCorePro の土台が同じもので、今は `registerMapToSW` がキャッシュを素通りしている |

## 2. 仕様の土台にした実測（2026-11-02）

使い捨ての計測（ローカルの 2 オリジン＋Playwright 1.62.1）で確かめた。計測コードは残していない。

| # | 確かめたこと | Chromium | WebKit | Firefox |
|---|---|---|---|---|
| 1 | ページの `fetch` の別オリジン要求が SW に届く | 届く | 届く | 未測定 |
| 2 | **blob URL の Worker** の `fetch` が SW に届く（MapLibre が別オリジン配信時に使う形） | 届く | 届く | 未測定 |
| 3 | 同一オリジンの Worker の `fetch` が SW に届く | 届く | 届く | 未測定 |
| 4 | `<img>` の要求は `mode: no-cors`・`credentials: include` で届く | その通り | その通り | 未測定 |
| 5 | `no-cors` の要求を SW が `mode: cors` で取り直し、合成した応答で返せる（CORS 対応サーバ） | 可 | 可 | 未測定 |
| 6 | CORS 非対応サーバでは 5 が `TypeError`。元の要求の取り直しは opaque・本体 0 バイトで読めない | その通り | その通り | 未測定 |
| 7 | `context.setOffline(true)` が SW の `fetch` まで切る | 切る | ページの `fetch` が先に失敗（SW 到達を測れない） | 未測定 |
| 8 | SW 停止（CDP `ServiceWorker.stopAllWorkers`）後の最初の要求より先に IndexedDB は読めない（照合表は空） | 確認 | — | — |
| 9 | Workbox 7.4.1 で、`queueMicrotask` で登録したルートは利用者のルートより後ろに付き、§4.3 の振り分けが成立する | 確認 | — | — |

Firefox は Playwright 組み込みの Firefox で SW の準備完了が返らず、測れなかった。m2 の先頭で別の手段（`firefox` の実機か Selenium）を試し、測れなければ「未確認」のまま README に書く。

コードで確かめた事実:

- `RegExpRoute` は別オリジンでは URL 先頭からの一致だけを受ける（`workbox-routing/RegExpRoute.js`）。`match` は同期でなければならず、Promise を返すと開発ビルドで警告される（`Router.js`）。ルートは登録順に評価する
- `@c4h/weiwudi/sw` は副作用 import で使われる（`Maplat/src/service-worker/index.ts`・`MaplatCorePro/weiwudi-sw.ts`）。後者は `@c4h/weiwudi` を `1.0.0` に固定している
- MapLibre 6.9.0 の `makeRequest` は `http(s)` なら Worker 内で `fetch` する。ベクタタイルの 404 は `err.status !== 404` の判定で黙って空タイルになる（`vector_tile_source.ts:254`）。`mapbox://` は解釈しない
- MLT の復号器は `while (offset < tile.length)` なので、0 バイトの本体でも落ちない（`@maplibre/mlt` 1.2.1）
- 現行の範囲外は「広がりの外＝透明 PNG／ズームの外＝404」である。#42 の「範囲外は 404」はズームの側だけを指す（`src/weiwudi_gw_logic.ts:425-438`）。ズームの 404 は `0cd978f` で意図して変えられたが、理由の記録は無い

## 3. 全体構成

```
ページ                             Service Worker
┌───────────────────┐              ┌───────────────────────────────────────┐
│ Weiwudi（旧 API）  │ GET /api/*   │ legacy.ts   旧 API の翻訳だけ          │
│ WeiwudiSource     │─────────────▶│   ↓                                   │
│                   │ POST /v2/*   │ control.ts  登録・統計・範囲取得        │
│ 地図ライブラリ     │              │   ↓                                   │
│  実 URL の要求 ───┼─────────────▶│ hook.ts     照合表と 2 つのルート       │
└───────────────────┘              │   ↓                                   │
                                   │ core.ts     serve()：配信の決定（§6）   │
                                   │   ↓            ↓                      │
                                   │ store.ts    plugins.ts・providers/     │
                                   └───────────────────────────────────────┘
                                         IndexedDB: WeiwudiStore
```

`src/` の最終形（名前は旧ファイルの流儀に合わせる）:

| ファイル | 役割 | 依存してよいもの |
|---|---|---|
| `tile_math.ts` | 座標・タイル計算（#34。m1） | なし |
| `errors.ts` | `WeiwudiError` と旧文面の表（#33。m1） | なし |
| `url_pattern.ts` | テンプレートの解析・照合・キーの正規化 | `tile_math` |
| `store.ts` | IndexedDB の全操作。型 `ResourceMeta` などの正本（#37） | `errors` |
| `core.ts` | `serve()`・退避・保持・範囲取得 | `store`・`plugins`・`tile_math`・`errors` |
| `hook.ts` | 照合表・ルート登録 | `core`・`url_pattern` |
| `control.ts` | `/v2/*` の処理 | `core`・`store` |
| `legacy.ts` | `/api/*` の翻訳と `MapSetting` の変換 | `core`・`control` |
| `migrate.ts` | 旧 DB からの移行 | `store` |
| `plugins.ts`・`providers/` | 差し込み口（#36）・提供元（#40） | なし（型は `store`） |
| `weiwudi.ts` | ページ側 API | `errors` |
| `weiwudi_gw_logic.ts` | 配線だけ（`Weiwudi_Internal`） | 上の全部 |

依存は上から下への一方向にする。`core` は `legacy` を知らない。

## 4. 実 URL の捕捉

### 4.1 データと制御を分ける

| | データ（タイル・スタイル等） | 制御（登録・統計・範囲取得） |
|---|---|---|
| 新 API | 実 URL をそのまま使う | `weiwudi.example.com/v2/*`（POST・JSON） |
| 旧 API | `weiwudi.example.com/api/cache/…` | `weiwudi.example.com/api/*`（GET） |

制御に疑似ホストを残す理由: 試作の `postMessage` 案（`sw-entry.ts` の `message` 処理は未実装のまま）と違い、経路が 1 本で済み、`sw-harness.ts` でそのまま試験でき、ページが SW の制御下に無ければ失敗で分かる。POST にするのは資格情報を URL に載せないため（§10）。

実 URL 方式の利点: ページが SW の制御下に無くても**要求はそのまま上流へ出る**（キャッシュされないだけ）。疑似ホスト方式では同じ状況で失敗する。

### 4.2 URL パターンの登録

- 登録は `Weiwudi.register()`（§12）。`url`（文字列か配列）にテンプレートを渡す
- テンプレートの字句: `{z}` `{x}` `{y}` `{-y}` `{quadkey}` `{ratio}` `{prefix}` `{fontstack}` `{range}`。これ以外（`{bbox-epsg-3857}` など）は `unsupported-template` で拒否する。座標を逆算できないと範囲判定も範囲取得もできないため
- 相対 URL はページ側で `new URL(url, location.href)` により絶対化してから送る
- ワイルドカードのホストは無い。`http:` `https:` だけ
- 照合は `origin + pathname` だけで行い、クエリは照合に使わない。クエリはキーの生成で扱う（§5.3）
- 照合表は `Map<origin, 照合規則[]>` にする。全要求が通る経路なので、無関係なオリジンは 1 回の Map 引きで抜ける

### 4.3 どの要求を、どのルートで受けるか

`match` は同期でなければならず、SW は使われないと止まる。止まった SW を起こす要求の時点では IndexedDB を読めない（§2 の 8）。かといって表が空のときに見逃すと、**オフラインで地図へ戻った最初のタイル群が失敗する**。これがオフライン用途の中心の場面である。試作は全要求を `respondWith` して `fetch(request)` へ流すことで避けたが、利用者の Workbox ルート（プリキャッシュなど）を奪う。

そこで 2 本のルートにする。

1. **照合ルート**（`Weiwudi_Internal` の実行中に同期で登録）: `table.loaded && table.match(url)` のときだけ受ける
2. **門番ルート**（`queueMicrotask` で登録＝SW スクリプトの評価が終わった直後で、利用者のルートより後ろになる）: `!table.loaded && 候補()` のときだけ受ける。ハンドラは読み込み完了を待ち、一致すれば `serve()`、外れれば `fetch(request)` で素通しする

候補の条件: `GET` かつ `mode !== 'navigate'` かつ `destination` が `''` か `'image'`。スクリプト・CSS・文書には触らない。

- 表の読み込みは SW の起動時に始める。読み込み後は門番は何も受けない
- 利用者のルートが門番より先に評価されるので、プリキャッシュは表が空の間も奪われない（§2 の 9）。利用者が `/.*/` のような全捕捉ルートを持つ場合だけ、この窓の間は負ける。README に書く
- 表の更新は登録を処理した SW のメモリに即時反映し、同じオリジンの別スコープの SW へは `BroadcastChannel('weiwudi')` で再読込を伝える
- `Weiwudi_Internal` の引数の型は `RegExp | MatchCallback` へ広げる。呼び方は変えない
- `sw-harness.ts` は「`registerRoute` の呼び出しは 1 回」を前提にしている。m2 で複数ルートに合わせて直す

### 4.4 SW のスコープ

スコープが決めるのは**どのページを制御するか**であり、どの URL を捕捉できるかではない。制御下のページとその Worker が出す要求なら、別オリジンでも `fetch` イベントが来る（§2 の 1〜3）。MapLibre を別オリジンの CDN から読む場合の blob Worker も同じ。

`registerSW` はそのまま使う。スコープ外のページでは現行どおり 10000 ms で reject し、新 API も `sw-not-controlling` で失敗する。ただしアプリは実 URL を持っているので、握りつぶせばキャッシュ無しで動く。

### 4.5 上流の取得と CORS

`Request` の形を次のように決める。

1. 上流へは **`mode: 'cors'`・`credentials: 'omit'`** で取りに行く。ページの要求が `no-cors`（`<img>`）でも同じ（§2 の 5）
2. `TypeError` になり、元の要求が `no-cors` なら、元の要求で 1 回取り直す。opaque ならページへ渡すが**保存しない**。理由: 本体が読めず（§2 の 6）IndexedDB に入らない。状態も大きさも分からない。Cache Storage へ入れても容量の水増しで集計が壊れる
3. 2 が起きた `Resource` は `corsless: true` にしてメモリと store に残し、次から 1 を省く。`stats` で見え、最初の 1 回だけ `opaque` イベントを出す。`fetchRange` は `opaque` エラーで止まる
4. 元の要求が `cors` なら 2 は行わない。opaque は返せない（ネットワークエラーになる）

テンプレートから URL を作るとき（範囲取得と旧 API）は、現行どおりミラーから無作為に 1 つ選ぶ。実 URL の捕捉では要求の URL をそのまま使う。

`If-None-Match` などの条件付き要求はしない。CORS の preflight を誘発し、preflight に応えないタイルサーバで失敗に変わるから。

### 4.6 認証付きの要求

- 要求に `Authorization` がある、または `mode: 'cors'` で `credentials: 'include'` のときは、**捕捉しても保存しない**（配信だけ）。`<img>` の `credentials: include` は既定値なので対象にしない（§2 の 4）
- 保存したい場合は登録に `cachePrivate: true` を付ける。IndexedDB は同じオリジンのスクリプトから読めるので、既定を「保存しない」にする
- `Range` ヘッダ付きの要求は素通しする（§11）

## 5. 資源モデルと IndexedDB

### 5.1 3 層

| 層 | 意味 | 例 | 同定 |
|---|---|---|---|
| `Source` | 利用者が登録する単位 | スタイル 1 つ、ラスタ地図 1 つ | `id`（既定は正規化した URL）。旧 API は `mapID` |
| `Resource` | URL パターン 1 つ（ミラー込み） | ベクタタイル集合、グリフ、スプライト | `id`（下記） |
| `Entry` | 応答 1 件 | タイル 1 枚 | `key`（§5.3） |

`Source` と `Resource` は多対多である。2 つのスタイルが同じタイル集合を参照すれば `Resource` は 1 つになる。試作の「同じ URL は自動で共有」はこれで保つ。試作は共有の結果として「片方の削除がもう片方を壊す」問題を持っていた（`deleteResource` が無条件に消す）ので、参照元（`sourceIds`）を持たせる。

`Resource.id`:

- 新 API: テンプレートを正規化した文字列。URL 配列（ミラー）は 1 つの `Resource` にまとめ、既存の `Resource` のテンプレートと 1 つでも重なれば合流する。**タイルのキーに URL を使わず座標を使う**ので、`a.tile…`・`b.tile…` のどれで取っても同じ Entry になる（試作の URL キーでは 3 重に保存される）
- 旧 API: `map:<mapID>`。旧 API の地図は互いに共有しない。旧 API では同じ URL の 2 地図は別のキャッシュで、`clean` も片方だけに効く。この挙動を変えない

### 5.2 型（#37）

`store.ts` に置き、保存と読み出しで同じ型を使う。`stats()` と `sources()` が返すものもこの型から作る。

```ts
export type ResourceType = 'style' | 'tilejson' | 'tile' | 'glyph' | 'sprite' | 'data';

export interface ResourceMeta {
  id: string;
  type: ResourceType;
  templates: string[];        // 資格情報を除いた URL テンプレート
  sourceIds: string[];        // 多対多。旧 API の Resource は mapID 1 つ
  provider?: string;          // 'mapbox' など。#38 の提供元別集計の鍵（無ければ origin）
  tile?: TileExtent;          // type === 'tile' のときの範囲
  encoding?: 'raster' | 'vector';
  corsless?: boolean;
  count: number;              // Entry の件数（同じトランザクションで更新）
  bytes: number;              // 同じ
  pinnedBytes: number;        // 固定分
}

export interface TileExtent {
  minZoom: number; maxZoom: number;
  box?: TileBox;              // maxZoom での x/y の範囲（tile_math.ts の型）
  scheme: 'xyz' | 'tms';
}

export interface EntryMeta {
  key: string;
  resourceId: string;
  z?: number; x?: number; y?: number;   // 範囲の解放に使う
  size: number;
  fetchedAt: number;          // 旧 epoch
  accessedAt: number;         // 旧 accessedAt
  pinned: 0 | 1;
  contentType?: string;
}

export interface EntryBody {
  key: string;
  blob: Blob;
  headers: Record<string, string>;
  parts?: GlyphPartIndex;     // §11 の結合保存
}
```

#37 の注記「参照元の URL を扱う項目は URL 処理の後」に従い、上流 URL の項目は `ResourceMeta` に置かない。`templates` が資格情報抜きの URL を持つので足りる（#14 の `httpUrl` に当たるものは m3 で要否を判定する）。

### 5.3 キー

`key = <resourceId> + '\0' + <suffix>`

| 型 | suffix |
|---|---|
| tile | `z/x/y`（`{ratio}` があれば `z/x/y@2x`）＋残りのクエリ |
| glyph | `<fontstack>`（範囲は §11 で 1 レコードに束ねる） |
| sprite・style・tilejson・data | 残りのパス＋残りのクエリ。無ければ空 |

クエリの正規化: `credentialParams`（既定 `access_token`・`token`・`key`・`api_key`・`apikey`・`sku`。登録で足せる）を除き、残りを名前順に並べる。`sku` を含むのは Mapbox GL が要求ごとに変えるから。

### 5.4 ストア

単一 DB `WeiwudiStore`（`version: 1`）。旧 DB `Weiwudi`・`Weiwudi_<mapID>` は移行後に消す。

| ストア | keyPath | 索引 | 備考 |
|---|---|---|---|
| `sources` | `id` | | 登録内容。旧 API は `MapSetting` をそのまま `legacy` に持つ |
| `resources` | `id` | `sourceIds`（multiEntry） | |
| `entries` | `key` | `[resourceId, accessedAt]`・`accessedAt`・`fetchedAt`・`[resourceId, z]` | `EntryMeta`。本体を持たない |
| `bodies` | `key` | | `EntryBody` |
| `regions` | `id` | `sourceId` | §7.2 |
| `credentials` | `sourceId` | | §10 |
| `kv` | `key` | | スキーマ・移行状態・全体上限 |

試作と現行からの変更とその理由（1 件あたりの計算量を下げる。100 万 Entry でも動くため）:

- メタと本体を分ける: 現行は cache hit のたびに Blob ごと `put` し直す（`getImage` の accessedAt 更新）。分ければメタだけで済む
- `count`・`bytes` を `resources` に持ち、Entry の増減と同じトランザクションで更新する: 現行の `stats` は全件走査、`putItemWithEviction` は保存のたびに全件走査で、`fetchAll` 全体が O(N²)
- LRU は `accessedAt` 索引のカーソルで古い順に引く
- 資源の一括削除は `delete(IDBKeyRange.bound(id + '\0', id + '\0￿'))` 1 回で済む（#38）
- `fetchAll` の「既に有るか」は `allKeys.indexOf` をやめ、バッチごとに `getKey` する

`openDatabase` の `onblocked` 処理・`onversionchange` で閉じる処理（#59）は `store.ts` へそのまま移す。`getDB` の「store が無ければ版を上げる」は不要になる。

### 5.5 スタイルからの芋づる式登録

`kind: 'style'` の登録は SW 側で行う。

1. スタイルを `serve()` 経由で取得する（2 回目以降はキャッシュから。**オフラインで同じ登録を繰り返しても失敗しない**）
2. `sources` を走査する。`url` があれば TileJSON を取得して `tiles`・`bounds`・`minzoom`・`maxzoom`・`scheme` を得る。`tiles` があればそのまま。試作は `source.url` を読まないので TileJSON 経由の資源を落としていた
3. `glyphs`・`sprite`（文字列か、MapLibre の `{id, url}[]`）・`geojson` の `data`（URL のとき）・`image` の `url` を登録する。スプライトは `.json`・`.png`・`@2x.json`・`@2x.png` の 4 つを同じ `Resource` の suffix とする
4. 一部の取得に失敗したら、登録は成功させて `warnings[]` に残す。スタイル自体が読めなければ `invalid-style`
5. **別オリジンのスタイルが、ページと同じオリジンの URL を指していたら登録しない**（`warnings` に残す）。第三者のスタイルで同一オリジンの API を捕捉させないため
6. `register()` は冪等である。`source.update()` で取り直し、参照が消えた `Resource` は `sourceIds` から外して空なら削除する

## 6. 配信の決定（`serve()`）

全経路（照合ルート・門番・旧 `/api/cache`・範囲取得）がこの 1 関数を通る。#15 の「キャッシュ確認→取得→保存の共通化」を満たす。

| 順 | 条件 | 応答 | `x-weiwudi-status` |
|---|---|---|---|
| 1 | 範囲外 | 下の表 | `out-of-range` |
| 2 | 新しい Entry がある（`now - fetchedAt <= cacheTtl`） | 保存した本体 | `hit` |
| 3 | 上流が成功 | 上流の本体（保存を試みる） | `miss`／更新なら `refresh` |
| 4 | 上流が失敗（HTTP）・Entry あり | 古い本体 | `stale` |
| 5 | 上流が失敗（HTTP）・Entry なし | 上流の応答をそのまま | `upstream-error` |
| 6 | ネットワーク失敗・Entry あり | 古い本体 | `stale` |
| 7 | ネットワーク失敗・Entry なし | 404 | `offline-miss` |

- これは現行の `getImage` の順序そのものである（既存の試験が契約）。`x-weiwudi-status` だけが増える。実 URL では `access-control-expose-headers` に入れる
- 保存に失敗しても配信は続ける（#22 の現行の決まり）。応答に `x-weiwudi-error`（§9）を付ける
- 7 を透明画像にしないのは、地図ライブラリが親タイルへ戻る動きを止めないため
- 同じ `key` の同時要求は `Map<key, Promise>` で 1 本にまとめる
- 保存時に応答ヘッダから `content-encoding`・`content-length`・`transfer-encoding`・`set-cookie` を落とす。本体は復号済みなので、残すと再生時に矛盾する

### 範囲外の応答

`outOfRange: { extent, zoom }`。値は `'transparent'`（ラスタの既定）・`'empty'`（ベクタの既定）・`'not-found'`。

| 資源 | 広がりの外 | ズームの外 |
|---|---|---|
| ラスタ（新 API の既定） | 透明 PNG・200 | 透明 PNG・200 |
| ベクタ（新 API の既定） | 空本体・200 | 空本体・200 |
| 旧 API（固定） | 透明 PNG・200 | **404**（現行のまま） |
| グリフ・スプライト・スタイル | 範囲の概念なし | 同左 |

- ラスタの透明 PNG は現行の 256×256 の定数を流用する（`tile_math` ではなく `core.ts` の定数）
- ベクタの空本体: 0 バイトは MVT として正しく（レイヤ 0 枚）、MLT も落ちない（§2）。404 でも MapLibre は黙るが、OpenLayers ではタイルが ERROR 状態になり、開発者ツールも赤くなる。`content-type` は登録時に分からなければ `application/vnd.mapbox-vector-tile`
- ズーム外の 404 を残したい利用者（親タイルへの戻りを使う場合）は `outOfRange: { zoom: 'not-found' }` を指定する
- `box` も `minZoom`/`maxZoom` も無い資源に範囲外は無い

## 7. 範囲取得・解放・保持

### 7.1 保持の 4 つの軸

| 軸 | 指定 | 既定 | 効果 | 現行との関係 |
|---|---|---|---|---|
| 鮮度 | `cacheTtl`（ms） | 24 時間 | 越えたら上流へ。失敗なら古いものを返す。**消さない** | 現行のまま |
| 削除期限 | `cacheRetention`（ms） | なし（無期限） | `fetchedAt` から越えたら消す | 新設（#9「キャッシュ期間管理」） |
| 容量 | `cacheMaxBytes`（Source 単位）・`setLimits({maxBytes})`（全体） | なし | 超えたら LRU で退避。単体で上限を超える応答は保存しない | 現行のまま＋全体上限 |
| 固定 | `fetchRange` の `pin`（既定 `true`） | — | 固定した Entry は LRU と削除期限の対象外 | 新設 |

- `cacheRetention` の掃除は SW の起動時とジョブの完了時に、`fetchedAt` 索引をバッチで走査する（タイマは SW で信用できない）。配信時にも期限切れは「無いもの」として扱う
- `cacheMaxBytes` の範囲は Source。Source の `Resource` 群の `[resourceId, accessedAt]` を併合して古い順に消す。共有 `Resource` の Entry も消える（キャッシュなので許容し、固定で守れる）
- 固定分だけで `cacheMaxBytes` を超えるときは `fetchRange` が `quota` で止まる
- `QuotaExceededError` のときは、固定以外を全体 LRU で 10% 退避して 1 回だけ再試行する。全体上限の既定が無いので、これが無いとブラウザの上限に当たった後はキャッシュが自力で回復しない
- `fetchRange` の開始時に `navigator.storage.persist()` を試す（失敗は無視）。ブラウザの自動削除に対する唯一の手段
- 旧 API の `cacheTtl`・`cacheMaxBytes` は Source の同名の項目へそのまま写す

### 7.2 範囲取得と解放

```ts
type RangeSpec =
  | { bounds: [west: number, south: number, east: number, north: number]; minZoom: number; maxZoom: number }
  | { box: TileBox; minZoom: number; maxZoom: number }   // ピクセル座標の地図（Maplat の xyz 型）用
  | 'all';                                               // 登録した範囲全部（旧 fetchAll）
```

- `bounds` は `tile_math` でタイル範囲へ変換する。緯度は ±85.0511° に丸める。`west > east` は日付変更線またぎとして 2 分割する
- `box` はピクセル座標の地図のため。測地系を持たない地図にも同じ操作を提供する
- `estimate(range)` がタイル枚数を返す。`enumerateTiles` は生成器で、配列を作らない（現行の `allTasks` は枚数分のメモリを使う）
- ベクタの範囲取得: スタイル・TileJSON・スプライト 4 種・グリフに加え、各タイル `Resource` の範囲との交差を取得する。グリフは `glyphRanges` で指定し、既定は `'common'`（`0-255`・`256-511`・`8192-8447`・`12288-12543`・`65280-65535`）、`'all'` で全 256 範囲。フォント名は `layout.text-font` のリテラルから集める。式からは取れないので `fonts` でも渡せる
- 1 度に動かすジョブは 1 つ（現行の `fetchAllBlocker` と同じ。同時は `fetch-busy`）。同時実行数は `concurrency`（既定 5。現行のバッチと同じ）

**SW の停止への対策**: 現行の `fetchAll` は `setTimeout` から走り、どのイベントにも結び付かないので、SW が止まると黙って消える。次のようにする。

- ジョブは開始の `fetch` イベントの `event.waitUntil` に結び付ける
- `regions` にジョブの状態を残す。進捗の位置は持たない。**再実行は既に有るタイルを飛ばすだけなので、やり直しが再開になる**
- ページ側は 30 秒イベントが来なければ `POST /v2/job/resume` を送る。ページが閉じれば再開しない（現行の生存確認と同じ）

**解放**:

| 操作 | 効果 |
|---|---|
| `source.releaseRange(regionId)` | その region を消し、他の region に入らないタイルの固定を外す。既定で本体も消す。`{ keep: true }` なら固定だけ外す |
| `source.clean()` | Source の Entry を全部消す（共有 `Resource` は他の Source が参照していれば残す）。regions も消す |
| `source.clean(range)` | 範囲内の固定されていない Entry を消す。`{ force: true }` で固定も消し、重なる region を `partial` にする |

重なる region の判定は幾何で行う（Entry 側に参照カウントを持たない）。解放のときだけの計算で、配信の経路を太らせないため。

イベントは現行の `proceed`・`finish`・`stop`・`canceled` を同じ形で使い、`regionId`・`errors`（§9）を足す。

## 8. 差し込み口（#36）

容量超過で保存しない部分は `putItemWithEviction`（#29）で済んでいる。残りは差し込み口である。

差し込みは SW 側に限る。関数はページから SW へ送れない。`@c4h/weiwudi/sw` の名前付き export として足す（副作用 import はそのまま動く）。UMD は `self.Weiwudi_SW` から使う。

```ts
export interface WeiwudiPlugin {
  // Workbox のプラグインと同じ名前・同じ意味
  requestWillFetch?(p: { request: Request; resource: ResourceMeta; state: unknown }): Promise<Request | void>;
  fetchDidSucceed?(p: { request: Request; response: Response; resource: ResourceMeta; state: unknown }): Promise<Response | void>;
  fetchDidFail?(p: { request: Request; error: unknown; resource: ResourceMeta; state: unknown }): Promise<void>;
  cacheWillUpdate?(p: { request: Request; response: Response; resource: ResourceMeta }): Promise<Response | null | void>; // null で保存しない
  cachedResponseWillBeUsed?(p: { request: Request; cachedResponse: Response; resource: ResourceMeta }): Promise<Response | null | void>;
}
export function addPlugin(plugin: WeiwudiPlugin): void;
export function addProvider(provider: WeiwudiProvider): void;   // §10
```

- 登録順に実行する。プラグインの例外は `console.error` に残し、そのプラグインを飛ばして続ける。地図を止めない
- 旧 API の経路にも効く（`serve()` が 1 つだから）
- SW が再起動しても再登録される。SW スクリプトの先頭で呼ぶ前提なので、永続化しない
- 試作の `resourceWillRegister`・`cacheWillClean` は採らない。使い道が示されていない

## 9. エラー（#33）

`src/errors.ts` の形は m1 で作る（計画の m1-t3）。

```ts
export class WeiwudiError extends Error {
  readonly code: WeiwudiErrorCode;
  readonly detail?: Record<string, unknown>;
  static from(value: unknown): WeiwudiError;
}
```

| 経路 | 形 |
|---|---|
| 新 API | `WeiwudiError` で reject。`/v2/*` は `{ ok: false, error: { code, message, detail } }` を返す |
| 旧 API | **現行と 1 字も違わない文字列で reject し続ける**。`WeiwudiError.from(e)` で `code` を得られる |
| タイルの応答 | 応答ヘッダ `x-weiwudi-error: network｜upstream｜quota｜storage` |
| 範囲取得のイベント | `stop` に `code`。`proceed`・`finish` に `errors: { network, upstream, quota, storage }`。`error`（合計）は残す |

文字列を `Error` に置き換えない理由: 公開文書が `"Error: {message}"` を約束しており（`docs/api/weiwudi.md`）、`typeof e === 'string'` や `e.match()` で分岐する利用者を壊す。リリースポリシー §5.3・§9.1 では major と非推奨の手順が要る。`from` なら 0 件の破壊で #33 の「原因に応じて分岐できる」を満たす。利用側（MaplatCore・MaplatCorePro）は握りつぶしているので影響を受けない。

文字列の reject は次の major で `WeiwudiError` へ変える。非推奨の予告は §13 の時期に合わせる。

新 API で増えるコード: `unsupported-template`・`invalid-style`・`opaque`・`sw-outdated`・`credential-rejected`・`source-not-found`。`quota`・`network`・`upstream`・`storage`・`fetch-busy` などは m1 の表にあるものを使う。

## 10. 提供元の URL と資格情報（#40）

**`mapbox://` は SW に届かない。** `fetch` イベントは `http(s)` だけで、Mapbox GL は自分で解決してから要求を出し、MapLibre は解釈しない。試作の `handleRequest` の `url.startsWith('mapbox://')` は到達しない。解決は**登録の時点**の仕事である。

```ts
export interface WeiwudiProvider {
  id: string;
  matches(url: string): boolean;
  resolve(url: string): string;                       // 資格情報を含まない https URL
  applyCredentials(url: URL, c: Credentials): void;   // 上流へ出す直前にだけ呼ぶ
  rewriteStyle?(style: unknown): unknown;             // スタイル中の独自スキームを https へ
  validateCredentials?(c: Credentials): void;         // 不正なら credential-rejected
  credentialParams?: string[];
}
```

- 標準で `providers/mapbox.ts` を持つ。形は 4 つ（スタイル・タイルセット・スプライト・フォント）
- `@c4h/beatbox` には依存しない。SW 側で必要な変換が小さい表で済み、これのために実行時依存（現在 0 件）を増やさない。BeatBox 0.1.1 の変換表は m3 で突き合わせて写す
- `sk.` で始まる秘密トークンは `credential-rejected` で拒否する（試作の決定を継承）

**資格情報の分離**

```ts
type Credentials = { query?: Record<string, string>; headers?: Record<string, string> };
```

- 登録の `credentials` は `credentials` ストアだけに入れる。`sources`・`resources`・`entries`・イベント・エラー文面・`stats` には現れない
- 要求の URL に載っている資格情報は、`credentialParams` によりキーから落ちる（§5.3）
- `templates` は登録時に資格情報の項目を除いて保存する。TileJSON の `tiles` に載っているものも同様
- 上流へ出す直前に、要求に資格情報が無ければ `applyCredentials` で足す。これで `source.url`（資格情報なし）をページに渡せる
- エラー文面と `warnings` に URL を入れるときは、クエリを落とす
- `credentials` を IndexedDB に置くのは、ページが閉じた後の再開と SW 再起動のため。同じオリジンのスクリプトからは読めるが、そのトークンはもともとページの JS が持っている

**MapLibre で `mapbox://` を使う流れ**: `register({ kind: 'style', url: 'mapbox://styles/u/s', credentials })` → SW が解決して取得し、`rewriteStyle` で `https` に直して保存 → `source.url`（`https://api.mapbox.com/styles/v1/u/s`）を MapLibre に渡す。

## 11. 分割要求の結合保存（#39）と Range 要求

**#39 の対象はグリフである。** 元の #12 は「フォントの範囲ファイルを結合キャッシュへ」であり、HTTP の Range とは別の話である。

- `{fontstack}/{range}.pbf` を、fontstack ごとに **1 レコード**へ束ねる。Entry の `key` は fontstack までで、`EntryBody.parts` に `{ '<range>': { offset, length, fetchedAt } }`、`blob` に連結した本体を持つ
- 再生は `blob.slice(offset, offset + length)`
- 保存は同じトランザクションで読み、`new Blob(parts の slice 群と新しい分)` を作り直して書く。古い部分の差し替えで空きが残らない
- 範囲取得のときは 1 fontstack 分を溜めてから 1 回で書く。逐次に書くと fontstack の大きさ × 範囲数の書き込みになる
- 削除と LRU と統計は fontstack 単位。鮮度は部分ごと（`fetchedAt`）に見る
- 試作は `consolidated.pbf` の実装を持たない（`handleFontRequest` は範囲ごとに保存）

**Range 要求（PMTiles など）は本サイクルの対象外とする。**

- `Range` ヘッダ付きの要求は `serve()` に入れず素通しする。206 を全体として保存すると壊れるので、これは必須の動作
- 対象外の理由: #42 の必須に無い（#9 の「できれば」）。範囲取得にはアーカイブのディレクトリ解釈が要り、規模が別である。現在の利用者に需要が無い
- 後から足す道: キーの suffix に `bytes=a-b` を入れれば Entry の形はそのままで足せる（移行不要）。ETag の変化で全部を無効にする処理だけが増える

## 12. 公開 API（ページ側）

`@c4h/weiwudi` の既定 export `Weiwudi` に足す。旧 API のメンバは変えない。

```ts
export type SourceSpec = CommonPolicy & (
  | { kind: 'raster' | 'vector'; id?: string; url: string | string[];
      bounds?: [number, number, number, number]; box?: TileBox;
      minZoom?: number; maxZoom?: number; scheme?: 'xyz' | 'tms'; tileSize?: number;
      outOfRange?: { extent?: OutOfRange; zoom?: OutOfRange } }
  | { kind: 'style'; id?: string; url: string; fonts?: string[] }
  | { kind: 'asset'; id?: string; url: string | string[] }
);

export interface CommonPolicy {
  cacheTtl?: number;
  cacheRetention?: number;
  cacheMaxBytes?: number;
  cachePrivate?: boolean;
  credentials?: Credentials;
  credentialParams?: string[];
}

class Weiwudi {
  static register(spec: SourceSpec): Promise<WeiwudiSource>;
  static source(id: string): Promise<WeiwudiSource>;       // 無ければ source-not-found
  static sources(): Promise<SourceInfo[]>;
  static usage(): Promise<UsageReport>;                    // 全体と提供元別（#38）
  static setLimits(limits: { maxBytes?: number }): Promise<void>;
}

export class WeiwudiSource extends WeiwudiEventTarget {
  readonly id: string;
  readonly url: string | string[];          // 地図ライブラリへ渡す実 URL（資格情報なし）
  readonly resources: ResourceMeta[];
  readonly warnings: string[];
  stats(): Promise<SourceStats>;            // { count, size, total?, percent?, byResource }
  update(): Promise<void>;
  estimate(range: RangeSpec): Promise<{ tiles: number }>;
  fetchRange(range: RangeSpec, opts?: FetchRangeOptions): Promise<RegionInfo>;
  releaseRange(regionId: string, opts?: { keep?: boolean }): Promise<void>;
  regions(): Promise<RegionInfo[]>;
  cancel(): Promise<void>;
  clean(range?: RangeSpec, opts?: { force?: boolean }): Promise<void>;
  removeResource(resourceId: string): Promise<void>;   // 資源単位の削除（#38）
  remove(): Promise<void>;                  // 登録と Entry を消す
  release(): void;                          // ページ側のリスナを外す
}
```

- 提供元別の使用量（#38）は `usage().byProvider`。鍵は `ResourceMeta.provider`、無ければ origin
- `/v2/ping` が `{ api: 2, version }` を返す。古い SW（更新待ち）に当たると 404 になるので、ページ側は `sw-outdated` を投げる。旧 `/api/ping` の `Implemented` は変えない

**利用側の使い方**（MapLibre・第一の経路）

```ts
await Weiwudi.registerSW('./sw.js', { scope: './' });
const style = await Weiwudi.register({ kind: 'style', url: 'https://example.com/style.json' });
const map = new maplibregl.Map({ container, style: style.url as string });
await style.fetchRange({ bounds: [139.7, 35.6, 139.8, 35.7], minZoom: 10, maxZoom: 14 });
```

`register` の完了を待ってから地図を作る。先に作ると最初の要求が捕捉されない。

## 13. 旧 API との関係

**既定どおり「新コアの上の薄い層」とする。** 試作の「後方互換は不要」は採らない。

| 旧 API | 新コアでの実現 |
|---|---|
| `registerSW`・`waitForController`・`swCheck` | そのまま |
| `registerMap` → `/api/add` | `legacy.ts` が `MapSetting` を作り（現行の計算を `tile_math` で）、Source＋`map:<mapID>` の Resource にする。**照合表には入れない** |
| `/api/cache/<id>/z/x/y` | `serve(resource, {z,x,y})` |
| `/api/stats` | `resources` の `count`・`bytes` から現行の形（`count`・`size`・`total`・`percent`）で返す |
| `/api/clean`・`/api/delete`・`/api/info` | Entry の削除・`sources` の操作 |
| `/api/fetchAll`・`/api/cancel` | ジョブ（`range: 'all'`・`pin: false`）。固定しないので `cacheMaxBytes` との関係が現行と変わらない |
| `proceed`・`finish`・`stop`・`canceled` | 同じ形（項目の追加のみ） |
| `map.url` | `https://weiwudi.example.com/api/cache/<id>/{z}/{x}/{y}` のまま |
| 相対の `url`（Maplat の `tiles/…`） | 現行どおり SW の場所を基準に解決する（SW 内の `fetch` の動き）。新 API はページ側で絶対化する |
| エラー文字列 | 1 字も変えない（§9） |

**例外（理由つき）**: 疑似ホストのルート自体は残る。旧 API の利用者は `map.url` を地図ライブラリへ渡しており、これをインタフェース上消せない。ただしそのハンドラは翻訳だけで、キャッシュの処理を持たない。旧 API の範囲外の応答（ズーム外 404）は `serve()` の引数の値の差で、分岐したコードではない。

既存の `tests/unit/` は**旧 API の契約試験**としてそのまま通し続ける（`sw-harness.ts` の起動部分だけ直す）。`tests/e2e/cache.spec.js` の `should evict…` は IndexedDB の `tileCache` を直接読むので、公開 API の確認へ書き換える（内部の形は公開の約束ではない）。

**載せ替えの時期**: state は「旧 IF の上乗せ」を m4 に置いているが、**載せ替え自体を m2 の最後へ前倒しする**（§16）。旧 API の試験 595 行が新コアの最良の検証になり、二重実装の期間も短くなる。

**非推奨**: 本サイクルでは旧 API を非推奨にしない。利用側 3 製品がまだ `registerMap` を呼んでおり、Maplat#254 の対応前に実行時警告を出すと、利用者のコンソールに対処できない警告が並ぶ。Maplat#254 の完了後のトレインでリリースポリシー §9.1 の手順に入り、次の major（2.0）で消す。

## 14. 版と移行

### 14.1 版

**minor（`feat:`）で足す。** 公開 API は追加だけで、旧 API の入出力は変わらない。リリースポリシー §5.3 の「新機能はマイナーで先行投入」に当たる。`next` ブランチも `feat!` も使わない。

- `Weiwudi_Internal` の型は広がるだけ（§4.3）
- `peerDependencies`（`workbox-routing`）は変えない。実行時依存も増やさない
- MaplatCorePro の `1.0.0` 固定は影響を受けない
- SW の差し替えは `skipWaiting`＋`clients.claim` なので、旧ページが新 SW に当たる。旧 API を残すので動く。新ページが旧 SW に当たる窓は `sw-outdated`（§12）

### 14.2 既存キャッシュの移行

**捨てない。** `fetchAll` で地図を落としてオフラインで使っている利用者には、キャッシュが資産である。試作の「失敗したら旧データを消す」は採らない。

- 移行の単位は地図で、`kv` に地図ごとの状態（`pending`・`copying`・`done`）を持つ
- 旧 DB を開いて `tileCache` を 200 件ずつ読み、新 DB へ書いてから旧レコードを消す。DB をまたぐトランザクションは無いので、途中で止まると両方に残るが、キーが同じなので再実行は冪等である。容量は 2 倍にならない
- 実行は SW の起動時に始め、`event.waitUntil` の届く範囲で進む。止まれば次の起動で続く。`activate` を待たせない（数 GB あるとブラウザに打ち切られる）
- **移行中の配信は読み通しにする**: 旧 API の地図で新 DB に無ければ、`Weiwudi_<mapID>` を見て、あれば配信して新 DB へ移す。移行の途中でオフラインになっても地図が欠けない
- `epoch`→`fetchedAt`・`accessedAt`（無ければ `epoch`）・`z_x_y`→`z,x,y`・`blob.size`→`size`。`pinned` は 0
- `mapSetting` は `sources` へ写す
- 全地図が `done` になったら `Weiwudi_<mapID>` と `Weiwudi` を消す。`onblocked` は次の起動へ回す
- 1 レコードの失敗は飛ばして続ける。地図単位で 3 回失敗したら `failed` にして読み通しのまま残す

**戻した場合**（1.1.x へ）: 旧版は空の DB から動く。キャッシュは取り直しになるが壊れない。

`Blob` の保存を続けるので、iOS Safari の扱いは現行と変わらない。

## 15. 試作（`origin/v1_dev`）の扱い

merge はしない（分岐点が 0.x）。読んで個別に移す。

| ファイル | 扱い | 理由 |
|---|---|---|
| `SPEC_DISCUSSION.md` | 資料 | 「URL を識別子に」「芋づる式」「プラグイン」の発想は採る。「後方互換は不要」「実装の削除」「v0 を失敗時に消す」は採らない |
| `src/cache-v1/types.ts` | 一部流用 | `Resource`・`CacheEntry` の項目名は参考。`WeiwudiPlugin` の Workbox 互換の 3 フックを継承し、`resourceWillRegister`・`cacheWillClean` を落とす。`QuotaOptions`・`AutoCleanupOptions` は捨てる（`cacheMaxBytes` と `setLimits` に統一） |
| `src/cache-v1/database.ts` | 捨てる | `await store.put()` は IDBRequest を待てていない。トランザクションの完了も `onblocked` も扱わない。キーが URL、本体とメタが同じ。ストアの構成の発想だけ参考 |
| `src/cache-v1/service-worker.ts` | 捨てる（小片だけ流用） | 全要求を `respondWith` する。型ごとに同じ処理が 5 回ある（#15）。例外で 404 が失敗に化ける。流用: `matchesTemplate` の字句置換の手順、`detectSpriteType` の判定 |
| `src/cache-v1/client.ts` | 捨てる（`registerStyleWithAssets` の流れだけ参考） | 登録の処理がページ側にあり、SW の照合表に届かない。`fetchAll` は `console.log` のみ。`detectResourceType` の URL 文字列からの型推定はやめて `kind` で明示する |
| `src/cache-v1/index.ts` | 捨てる | `registerSW`（#30 の待ち方を持つ現行）が勝っている |
| `src/cache-v1/sw-entry.ts` | 捨てる | 全要求の捕捉、未実装の `message` 処理、`install` での移行（打ち切られる） |
| `src/cache-v1/migration.ts` | 捨てる（変換の対応だけ参考） | 全件を一度に読む、`onblocked` なし、失敗時に消す、`resourceUrl` の URL 展開が新キーと合わない |
| `tests/cache-v1/*` | 捨てる | 対象の実装に結び付いている。#16 の教訓は `store.ts` の試験へ |

## 16. 里程への割り当て

state の題名からの変更点は太字（進行役が state を直す）。

| 里程 | 内容 |
|---|---|
| m1 | 本書・#34・#33・#32 |
| m2 | `store.ts`（#37）・`url_pattern.ts`・`core.ts` の `serve()`・`hook.ts`（2 ルート）・`control.ts`・`plugins.ts`（#36）・`raster` の登録・**旧 API の載せ替え（§13）**。先頭で Firefox の測定を試す |
| m3 | スタイルの芋づる登録（§5.5）・ベクタの範囲外・グリフの結合（#39）・`providers/mapbox.ts`（#40）・資源単位の削除と提供元別の使用量（#38） |
| m4 | 範囲取得と解放・保持（§7）・**旧 DB からの移行（§14.2）**・#41・文書・master への合流 |

m2 の最後から m4 の移行までの間、`vector-cache` は既存キャッシュを読まない。公開前のブランチなので問題にならないが、**移行の無い状態で master へ入れてはならない**（m4 の合流の条件にする）。

外へ出る API なので、m2 と m3 の区切りのレビューに水準 2（別ベンダーの AI）を含める（軽い道 §4）。

## 17. 人間の判断

好みと方針でしか決まらない点だけを挙げる。どちらも止まらずに推奨案で進められる。

1. **`mapbox://` の扱いを標準で載せるか**
   - Mapbox の利用規約はオフライン保存を制限している可能性があり、規約の確認なしに断定できない
   - 推奨: #40 の完了条件どおり標準で載せる。範囲取得も止めず、README に「提供元の規約の確認は利用者の責任」と書く
   - 別案: `providers/mapbox.ts` を配布物から外し、`addProvider` の例として文書にだけ載せる
2. **旧 API を非推奨にする時期**
   - 推奨: §13 のとおり Maplat#254 の完了後のトレイン。それまで 2.0 の予定を立てない
   - 別案: 新 API の公開と同時に JSDoc の `@deprecated` だけ付ける（実行時の警告は出さない）。ただしリリースポリシー §9.1 は 3 点セットなので、ポリシーの例外になる
