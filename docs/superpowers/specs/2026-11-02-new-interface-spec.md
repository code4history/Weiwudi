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
| 10 | 登録したテンプレートと同じ URL の `<script>` と iframe の navigate に照合ルートが触らない（m3-t10・`engines.spec.js`） | 確認 | 確認（ArrayBuffer に替えた版の CI で通った） | 確認 |
| 11 | sandbox（`allow-scripts allow-same-origin`）の srcdoc の iframe が controller を継ぎ、新 API が使える（m3-t10・`engines.spec.js`） | 継ぐ | 継ぐ | 継がない（中の呼び出しは `sw-not-controlling`） |

**未確認として残す点**:

- Firefox は Playwright 組み込みの Firefox で SW の準備完了が返らず、測れなかった。**m2 でも測らず**、「未確認」のまま README に書く（m2 計画の R14）。m3-t10 から CI の `e2e-engines` の job で 1 回走らせ（`continue-on-error`）、結果を記録する。結果（PR #94 の CI）: SW は準備でき、WebKit と同じ試験（診断を含め 30 件）がすべて通った。必須の検査にはしない
- 上の表の WebKit の列は Playwright 1.62.1 と webkit-2336 のものである。lock の Playwright 1.64 が要求する webkit-2370（Firefox は 1555）は手元に無く、共有キャッシュを触らないため手元では `playwright install` をしない
- m3-t10 から、WebKit は CI（GitHub の ubuntu・lock の Playwright・毎回 install）の `e2e-engines` の job で e2e を流す（R14'）。Chromium でしか成り立たない試験（CDP で SW を止めるもの・`context.setOffline` を使うもの（表の 7）・SW の要求を `context.route` で数えたり受けたりするもの（Mapbox の試験を含む））はタグ `@chromium-only` で外す。結果（PR #94 の CI）: 初回は 29 件のうち 9 件が落ちた。どれも SW は要求を受ける（`miss`）が保存されず（`x-weiwudi-error: storage`）、WebKit の非永続の保存領域が IndexedDB に Blob を put できない（`UnknownError`）ためと診断で確かめた。Blob を保存できない WebKit の制約（プライベートブラウズを含む）に合わせ、本体を ArrayBuffer で保存する（§5.2）。ArrayBuffer に替えた版の CI では WebKit の 29 件がすべて通った（Firefox も同じ 29 件がすべて通った）。Linux の WebKit と iOS の Safari の差は残る
- 本書の設計は実装では未走行である（走らせたのは §2 の計測だけ）

コードで確かめた事実:

- `RegExpRoute` は別オリジンでは URL 先頭からの一致だけを受ける（`workbox-routing/RegExpRoute.js`）。`match` は同期でなければならず、Promise を返すと開発ビルドで警告される（`Router.js`）。ルートは登録順に評価する
- `@c4h/weiwudi/sw` は副作用 import で使われる（`Maplat/src/service-worker/index.ts`・`MaplatCorePro/weiwudi-sw.ts`）。後者は `@c4h/weiwudi` を `1.0.0` に固定している
- MapLibre 6.9.0 の `makeRequest` は `http(s)` なら Worker 内で `fetch` する。ベクタタイルの 404 は `err.status !== 404` の判定で黙って空タイルになる（`vector_tile_source.ts:254`）。`mapbox://` は解釈しない
- MLT の復号器は `while (offset < tile.length)` なので、0 バイトの本体でも落ちない（読んだのは `@maplibre/mlt` 1.2.1。MaplatCorePro の宣言は下限で、実体の 1.3.0 も `dist/mltDecoder.js:32` が `while (offset.get() < tile.length)` で同じことを m3 で確かめた。m3 計画 F1）
- 現行の範囲外は「広がりの外＝透明 PNG／ズームの外＝404」である。#42 の「範囲外は 404」はズームの側だけを指す（`src/weiwudi_gw_logic.ts:425-438`）。ズームの 404 は `0cd978f` で意図して変えられたが、理由の記録は無い

## 3. 全体構成

```
ページ                             Service Worker
┌───────────────────┐              ┌───────────────────────────────────────┐
│ Weiwudi（旧 API）  │ GET /api/*   │ legacy.ts   旧 API の翻訳だけ          │
│ WeiwudiSource     │─────────────▶│   ↓                                   │
│                   │ POST /v2/*   │ control.ts  登録・統計・範囲取得        │
│ 地図ライブラリ     │              │   ↓                                   │
│  実 URL の要求 ───┼─────────────▶│ hook.ts     照合表とルート              │
└───────────────────┘              │   ↓                                   │
                                   │ core.ts     serve()：配信の決定（§6）   │
                                   │   ↓            ↓                      │
                                   │ store.ts    plugins.ts・providers/     │
                                   └───────────────────────────────────────┘
                                         IndexedDB: WeiwudiStore
```

`src/` の最終形（名前は旧ファイルの流儀に合わせる）:

| ファイル | 役割 | 値を import してよいもの |
|---|---|---|
| `constants.ts` | 疑似ホスト・旧 API の前置き・既定の時間（m3）・保存と合成で落とすヘッダと自前のヘッダの接頭辞（m4） | なし（全ファイルが import してよい） |
| `tile_math.ts` | 座標・タイル計算（#34。m1）・テンプレートの展開・タイルのキーの suffix（`tileKeySuffix`。新旧で 1 つ） | なし |
| `errors.ts` | `WeiwudiError` と旧文面の表（#33。m1） | なし |
| `url_pattern.ts` | テンプレートの解析・照合・正規化・キー | `tile_math`・`constants`・`errors` |
| `spec.ts` | 登録内容（`SourceSpec`）の検査と正規化 | `url_pattern`・`tile_math`・`constants`・`errors` |
| `style_body.ts` | スタイル・TileJSON の本体の解析と書き換え（純粋。m3） | `url_pattern`・`constants`・`errors` |
| `plugins.ts` | 差し込み口（#36）・提供元の登録表（m3） | `constants`・`errors` |
| `providers/` | 提供元（`mapbox.ts`。#40。m3） | `errors`・`constants`・`providers/` どうし |
| `store.ts` | IndexedDB の全操作。型 `ResourceMeta` などの正本（#37）。`SourceRecord` を読む小さな補助の唯一の置き場 | `constants`・`errors` |
| `context.ts` | 実行中の状態（接続・照合表・同時要求・連続数・ジョブ）の入れ物。`Weiwudi_Internal` の呼び出しごとに 1 つ | `store`・`constants`・`errors` |
| `registry.ts` | 合流と実効方針（§5.6） | `store`・`spec`・`url_pattern`・`tile_math`・`constants`・`errors` |
| `upstream.ts` | 上流の取得と CORS・認証付きの要求（§4.5・§4.6） | `context`・`store`・`url_pattern`・`constants`・`errors` |
| `core.ts` | `serve()`・退避・ジョブ | `context`・`store`・`plugins`・`url_pattern`・`tile_math`・`constants`・`errors` |
| `hook.ts` | 照合表・ルート登録 | `core`・`upstream`・`context`・`store`・`url_pattern`・`style_body`・`constants`・`errors` |
| `style.ts` | スタイルの芋づる登録の段取り（§5.5。m3） | `hook`・`core`・`registry`・`spec`・`style_body`・`url_pattern`・`context`・`store`・`constants`・`errors` |
| `range.ts` | 範囲の正規化・列挙・ジョブ・region・解放（m4） | `hook`・`core`・`upstream`・`registry`・`context`・`store`・`spec`・`url_pattern`・`tile_math`・`style_body`・`constants`・`errors` |
| `control.ts` | `/v2/*` の処理 | `hook`・`core`・`registry`・`spec`・`style`・`range`・`context`・`store`・`tile_math`・`constants`・`errors` |
| `legacy.ts` | `/api/*` の翻訳と `MapSetting` の変換 | `core`・`context`・`store`・`tile_math`・`constants`・`errors`（m4 で `migrate`） |
| `migrate.ts` | 旧 DB からの移行（m4） | `store`・`constants`・`errors` |
| `weiwudi_gw_logic.ts` | 配線だけ（`Weiwudi_Internal`） | 上の全部 |
| `weiwudi_gw.ts`・`weiwudi_sw.ts` | SW の入口（ES・UMD） | `weiwudi_gw_logic`・`plugins`・`constants` |
| `weiwudi.ts` | ページ側 API | `errors`・`url_pattern`・`constants` |

注: `constants` は `tile_math`・`errors` を除く全ファイルが import してよい（`constants.ts` 自身は何も import しない）。

**依存の決まりはこの表 1 つだけ**（m2 計画は表を写さずここを指す）。値の依存は、`import … from` と `export … from` のどちらも、表の許可先だけにする（複数行の文も同じ）。`core` は `legacy` を知らない。型だけの `import type` は制限しない（`store.ts` が `TileBox` を、`weiwudi.ts` が `ResourceInfo` を使う）。`/v2/` の GET（`ping`）の振り分けは配線の `weiwudi_gw_logic.ts` で行う（`legacy` から `control` を呼ばない）。配布の `weiwudi.d.ts` に型が届くよう、m2 で `vite.config.lib.js` の `dts` の `include` を直す。

## 4. 実 URL の捕捉

### 4.1 データと制御を分ける

| | データ（タイル・スタイル等） | 制御（登録・統計・範囲取得） |
|---|---|---|
| 新 API | 実 URL をそのまま使う | `weiwudi.example.com/v2/*`（POST・JSON） |
| 旧 API | `weiwudi.example.com/api/cache/…` | `weiwudi.example.com/api/*`（GET） |

制御に疑似ホストを残す理由: 試作の `postMessage` 案（`sw-entry.ts` の `message` 処理は未実装のまま）と違い、経路が 1 本で済み、`sw-harness.ts` でそのまま試験でき、ページが SW の制御下に無ければ失敗で分かる。POST にするのは資格情報を URL に載せないため（§10）。

**送信の前に `navigator.serviceWorker.controller` を確かめる。** 制御下に無いページで POST すると、資格情報の入った本文が SW を通らず実ホスト宛てに出る。無ければ何も送らず `sw-not-controlling` で失敗させる。

**controller があっても Weiwudi の新しい SW とは限らない**（旧版の SW は `weiwudi.example.com` の GET しか受けず、POST は実ホストへ出る）。そこで新 API は、最初の POST の前に `GET /v2/ping` の成功（`{ api: 2, version }`）を必ず確かめる。成功は「200 で、JSON が `{ api: 2, version: 文字列 }`」のときだけで、**その controller の実体に結び付けて記憶し、`controllerchange` で捨てる**。それ以外はすべて失敗とし、記憶しない（fail-closed。次の呼び出しで確かめ直す）: 404 と、200 でも JSON が違うものは `sw-outdated`、ネットワーク失敗とその他の状態は `sw-not-controlling`。ping の前と後で controller の実体を比べ、違えば 1 回だけ確かめ直し、なお違えば `sw-not-controlling` で止める。同時の呼び出しは進行中の ping 1 本にまとめる。`version` は空でない文字列であること。この確認は旧 API の `swCheck` と別の関数にする（`swCheck` は旧 API が共有し、結果を大域に固定するので、`/v2/ping` に変えると旧 SW の上で旧 API が壊れる）。

**POST は preflight の要らない単純要求にする**: `Content-Type: text/plain;charset=UTF-8` で、本文は JSON の文字列。別オリジンへの JSON の POST は preflight（`OPTIONS`）を生み、それが SW に渡るかはブラウザに依る。単純要求なら preflight に依存しない。

実 URL 方式の利点: ページが SW の制御下に無くても**要求はそのまま上流へ出る**（キャッシュされないだけ）。疑似ホスト方式では同じ状況で失敗する。

### 4.2 URL パターンの登録

- 登録は `Weiwudi.register()`（§12）。`url`（文字列か配列）にテンプレートを渡す
- テンプレートの字句: `{z}` `{x}` `{y}` `{-y}` `{quadkey}` `{ratio}` `{prefix}` `{fontstack}` `{range}`。これ以外（`{bbox-epsg-3857}` など）は `unsupported-template` で拒否する。座標を逆算できないと範囲判定も範囲取得もできないため
- 相対 URL はページ側で絶対化してから送る。`new URL()` は `{z}` を `%7Bz%7D` へ符号化するので、**字句を `__WEIWUDI_0__` のような退避名へ置き換えてから解決し、解決後に戻す**
- ワイルドカードのホストは無い。`http:` `https:` だけ
- 照合は `origin + pathname` と、**テンプレートに書かれたクエリ項目**で行う。値全体が 1 字句の項目（WMTS KVP の `TileCol={x}` など）はそこから座標を取り、固定値の項目は一致を求める（同じパスで `layer=a` と `layer=b` を分けるため）。テンプレートに無いクエリ項目は照合に使わず、キーの生成で扱う（§5.3）。値の一部だけが字句の項目は `unsupported-template`
- 照合表は `Map<origin, 照合規則[]>` にする。全要求が通る経路なので、無関係なオリジンは 1 回の Map 引きで抜ける

### 4.3 どの要求を、どのルートで受けるか

`match` は同期でなければならず、SW は使われないと止まる。止まった SW を起こす要求の時点では IndexedDB を読めない（§2 の 8）。かといって表が空のときに見逃すと、**オフラインで地図へ戻った最初のタイル群が失敗する**。これがオフライン用途の中心の場面である。試作は全要求を `respondWith` して `fetch(request)` へ流すことで避けたが、利用者の Workbox ルート（プリキャッシュなど）を奪う。

そこで実 URL 用に 2 本のルートを置く。登録するルートは全部で次の 4 本になる。

| ルート | 捕捉 | 方式 | 登録の時期 |
|---|---|---|---|
| 旧 API | `weiwudi.example.com` への GET（現行の正規表現のまま。`/v2/ping` もここで受けて振り分ける） | GET | 同期 |
| 制御 | `weiwudi.example.com` への POST（`/v2/*`） | POST | 同期 |
| 照合 | `table.loaded && table.match(url)` | GET | 同期 |
| 門番 | `!table.loaded && 候補()` | GET | `queueMicrotask`（スクリプトの評価が終わった直後で、同じ評価中に登録された利用者のルートより後ろになる） |

門番のハンドラは読み込み完了を待ち、一致すれば `serve()`、外れれば `fetch(request)` で素通しする。

**読み込みの失敗と停止**: 門番の待ちは上限 3 秒とする。読み込みが失敗するか上限を越えたら、その要求は素通しし、次の要求で読み込みをやり直す（`loaded` は立てない）。失敗が続くときは、やり直しの間隔を 1 秒から倍々に 30 秒まで延ばす（その間の要求は待たずに素通し）。やり直しは読み込み中の `Promise` を 1 つだけ持って共有し、同時に来た要求がそれぞれ読み込みを起こさないようにする。要求を止めるほうが、キャッシュされないより悪い。

候補の条件: `GET` かつ `mode !== 'navigate'` かつ `destination` が `''` か `'image'`。スクリプト・CSS・文書には触らない。**この条件は照合ルートにも当てる**（1 つの関数）。登録したテンプレートがページや script の URL に重なっても、それらを捕捉しない。

- 表の読み込みは最初の候補の要求で始める（`Weiwudi_Internal` の呼び出しでは IndexedDB を開かない。m2-t7 の Ruling）。読み込み後は門番は何も受けない
- 利用者のルートは SW スクリプトの評価中に同期で登録する前提である（Workbox の通常の書き方）。評価の後で登録したルートは門番より後ろになる
- 利用者のルートが門番より先に評価されるので、プリキャッシュは表が空の間も奪われない（§2 の 9）。利用者が `/.*/` のような全捕捉ルートを持つ場合は、`@c4h/weiwudi/sw` の import より後に登録すればこの窓の間だけ負け、前に登録すれば常に負ける。README に「import を先に書く」と書く
- 表の更新は登録を処理した SW のメモリに即時反映し、同じオリジンの別スコープの SW へは `BroadcastChannel('weiwudi')` で再読込を伝える
- `Weiwudi_Internal` が受ける `registerRoute` の第 1 引数の型を `RegExp | RouteMatchCallback`（`workbox-core`）にする。呼び方は変えない
- `sw-harness.ts` は「`registerRoute` の呼び出しは 1 回」を前提にしている。m2 で複数ルートに合わせて直す

### 4.4 SW のスコープ

スコープが決めるのは**どのページを制御するか**であり、どの URL を捕捉できるかではない。制御下のページとその Worker が出す要求なら、別オリジンでも `fetch` イベントが来る（§2 の 1〜3）。MapLibre を別オリジンの CDN から読む場合の blob Worker も同じ。

`registerSW` はそのまま使う。スコープ外のページでは現行どおり 10000 ms で reject し、新 API も `sw-not-controlling` で失敗する。ただしアプリは実 URL を持っているので、握りつぶせばキャッシュ無しで動く。

### 4.5 上流の取得と CORS

上流への要求の形は、要求の種類で分ける。

| 要求 | 上流へ出す形 |
|---|---|
| 匿名の要求 | 組み替える: **`mode: 'cors'`・`credentials: 'same-origin'`**。ページの要求が `no-cors`（`<img>`）でも同じ（§2 の 5）。別オリジンへ Cookie を送らない点は `omit` と同じで、同一オリジンの Cookie で守られたタイル（Cloudflare Access など）は取れ続ける |
| §4.6 の認証付きの要求 | **元の `Request` のまま**。組み替えない。下の 2〜4 も通らない |
| テンプレートから作る要求（範囲取得） | **`new Request(URL の文字列)`**（`mode: 'cors'`・`credentials: 'same-origin'` の既定）を `hook.serveResource` に渡し、上の匿名の要求と同じく `createUpstream` が組み替える（資格情報は照合ルートと同じ `credentialsForResource` で選ぶ。m4-t3・R3）。元の要求が `cors` なので 2 の取り直しは行わず、範囲取得の no-cors の確かめは 3 の規則でジョブが行う（R4） |
| テンプレートから作る要求（旧 API） | **`fetch(URL の文字列)` の 1 引数のまま**（現行の `getImage` と同じ。第 2 引数を足すと、`undefined` でも :228・:239 が落ちることを実走で確認済み（第 3 回の再点検）。既定で `mode: 'cors'`・`credentials: 'same-origin'` なので組み替えた形と一致する）。`tests/unit/weiwudi-gw-logic.test.ts` の :228・:239（`toHaveBeenCalledWith(文字列)`）を差分なしで通すため |

以下は匿名の要求の手順である。上流の取得は Entry の有無（`hasEntry`）を受け取る（下の 3 と S-F の規則が Entry の有無で分かれるため）。`corsOk`・`corslessUntil` は判定のたびに store から読み直し、書き換えは 1 つのトランザクションで読み・直し・書きを行う（同時の要求で互いの書き込みを消さないため）。

1. 組み替えた形で取得する
2. `TypeError` になり、元の要求が `no-cors` なら、元の要求で 1 回取り直す。opaque ならページへ渡すが**保存しない**。理由: 本体が読めず（§2 の 6）IndexedDB に入らない。状態も大きさも分からない。Cache Storage へ入れても容量の水増しで集計が壊れる
3. CORS の拒否とネットワーク失敗はどちらも `TypeError` で区別できない。また CORS の検査は状態コードに関係なく行われるので、404・403・502・504 に `Access-Control-Allow-Origin` を付けない CORS 対応サーバ（nginx の `add_header` を `always` なしで書いたもの。海を 404 にする疎なタイル集合など）でも、cors は `TypeError`・取り直しは opaque になる。そこで判定を `Resource` の状態に結び付ける
   - **`Resource.corsOk`** は「CORS を通った応答を 1 度でも受けた」印である（状態コードは問わない。CORS ヘッダ付きの 404 も含む）。初めて受けたときに保存する
   - **CORS 対応の実績が無い**とは `count === 0` かつ `corsOk` が無いことを言う。実行ごとの数ではなく `Resource` の状態なので、範囲取得の再実行（＝再開、§7.2）でも同じ判定になる
   - 実績が無いうちに 2 の取り直しが opaque で成功したときだけ、CORS 非対応の候補として数える。両方失敗（オフライン）は数えない。この連続数を **`corslessStreak`** と呼ぶ。`ResourceMeta.count`（Entry の件数）とは別物で、SW のメモリだけに持ち、保存しない（SW の再起動で 0 に戻ってよい。判定の結果は `corslessUntil` が保存する）。CORS を通った応答を受けたら `corslessStreak` を 0 に戻し、`corslessUntil` も消す
   - `corslessStreak` が 3 で `Resource.corslessUntil = now + 24 時間` を保存する。その間は 1 を省いて元の要求を出す。`stats` で見え、このとき 1 回だけ `opaque` イベントを出す。期限を過ぎたら 1 に戻す
   - **実績がある `Resource`** で 1 が `TypeError` になったときは、上流の失敗（`upstream`）として §6 に従う: Entry があれば §6 の 4（古い本体）、無ければ 2 の取り直しの opaque をそのまま渡す（§6 の 5 に当たる。保存しない）。数えない。取り直しも `TypeError`（オフライン）なら §6 の 7（404・`x-weiwudi-error: network`）
   - `source.update()` は `corslessUntil`・`corsOk`・`corslessStreak` を消す（`count` には触らない）。ただし `count > 0` の `Resource` は「実績あり」のままなので、サーバが CORS をやめた場合は候補にならない。このとき Entry が無いタイルを元の要求が `no-cors` で求めると、cors と no-cors の 2 回の要求を出し続ける（Entry があれば §6 の 4 で古い本体を返す。元の要求が `cors` なら 2 は行わない）。この場合に判定をやり直すには `clean()` で Entry を消す
   - 範囲取得は `corslessUntil` を見ずに 1 で取る。`TypeError` のタイルは `mode: 'no-cors'` で確かめる。実績が無いうちに、そのジョブの中で opaque が 3 回続いたら（ジョブごとの連続数 `jobOpaqueStreak`。`corslessStreak` とは別で、範囲取得は `corslessStreak` を増やさない）、止める前に**範囲の中から無作為に 5 枚（範囲が 5 枚未満なら全部）を cors で確かめる**。確かめで取れた 200 は通常どおり保存し、進捗にも数える（後で同じタイルを取り直さない）。1 枚でも CORS を通れば `corsOk` を立てて続ける。1 枚も通らず opaque が 1 枚でもあれば `opaque` で止め、全部が両方失敗（cors も no-cors も `TypeError`）なら `network` で止める（範囲の最初が CORS ヘッダの無い 404 の海でも、再実行のたびに同じ所で止まらないため）。それ以外の opaque は `upstream` として数えて進む。両方失敗は `network` として数え、`jobOpaqueStreak` を増やさない
   - 元の要求が `no-cors` で、1 が 401・403 を返したとき: **Entry があれば §6 の 4（古い本体）とし、取り直さない**（トークン失効などで、opaque が 401 を隠した壊れた画像を渡さないため）。Entry が無いときだけ元の要求で 1 回取り直す（同じサイトの別オリジンで Cookie で認証し、401 に CORS ヘッダを付けるサーバのため。組み替えた形は別オリジンへ Cookie を送らない）。opaque ならページへ渡し、保存しない。取り直しが `TypeError` なら 1 の 401・403 をそのまま返す（§6 の 5）。取り直しが CORS を通った・同一オリジンの応答（`basic`・`cors`）で返ったときは、状態が 200 なら通常どおり扱い（§4.6 により保存の可否を決める）、401・403 などなら保存せずそのまま返す（§6 の 5）。どれも数えない
4. 元の要求が `cors` なら 2 は行わない。opaque は返せない（ネットワークエラーになる）

テンプレートから URL を作るとき（範囲取得と旧 API）は、現行どおりミラーから無作為に 1 つ選ぶ。実 URL の捕捉では要求の URL をそのまま使う。

`If-None-Match` などの条件付き要求はしない。CORS の preflight を誘発し、preflight に応えないタイルサーバで失敗に変わるから。

### 4.6 認証付きの要求

- 要求に `Authorization` がある、または `mode: 'cors'` で `credentials: 'include'` のときは、**捕捉しても保存しない**。元の `Request` のまま上流へ出して配信する（§4.5）。`<img>` の `credentials: include` は既定値なので対象にしない（§2 の 4）
- 保存したい場合は登録に `cachePrivate: true` を付ける。上流へは同じく元の `Request` のまま出す。IndexedDB は同じオリジンのスクリプトから読めるので、既定を「保存しない」にする。キーは利用者を区別しないので、1 つのブラウザプロファイルを 1 人が使う前提である。同じ前提で、同じキーへ同時に来た要求（認証付きと匿名を含む）も 1 本の上流の取得にまとめる
- 登録の `credentials`（§10）で SW が足した資格情報は、ここで言う認証付きに当たらない。登録した者が共有を意図したものとして保存する
- 同一オリジンの Cookie は SW から見えないので、保存の判定に使えない。同一オリジンの既定（`credentials: 'same-origin'`）の要求は匿名の要求として扱い、保存する（現行の旧 API と同じ扱い）
- 範囲取得には元の要求が無い。`credentials` ストアの内容と同一オリジンの Cookie で取る。**別オリジンで Cookie だけで認証するサーバは対象外**である（`upstream` で数える）。`Resource` の `count === 0` のときに 401・403 が 3 回続いたら `upstream` で止める（判定は §4.5 の 3 と同じく `Resource` の状態に結び付け、再実行でも同じになる）（認証の無いまま全タイルを取りに行き続けないため）
- 上流が 200 でも `content-type` が `text/html` の応答は保存せず `upstream` として扱う（ログイン画面へのリダイレクトがタイルとして固定されないため）。スタイル・TileJSON 以外の型に適用する
- `Range` ヘッダ付きの要求は素通しする（§11）

## 5. 資源モデルと IndexedDB

### 5.1 3 層

| 層 | 意味 | 例 | 同定 |
|---|---|---|---|
| `Source` | 利用者が登録する単位 | スタイル 1 つ、ラスタ地図 1 つ | `id`（既定は先頭のテンプレートを正規化したもの）。旧 API は `map:<mapID>` |
| `Resource` | URL パターン 1 つ（ミラー込み） | ベクタタイル集合、グリフ、スプライト | `id`（下記） |
| `Entry` | 応答 1 件 | タイル 1 枚 | `key`（§5.3） |

`Source` と `Resource` は多対多である。2 つのスタイルが同じタイル集合を参照すれば `Resource` は 1 つになる。試作の「同じ URL は自動で共有」はこれで保つ。試作は共有の結果として「片方の削除がもう片方を壊す」問題を持っていた（`deleteResource` が無条件に消す）ので、参照元（`sourceIds`）を持たせる。

`Resource.id`:

- **正規化**（`url_pattern.normalizeTemplate`。id の唯一の作り方）: 絶対化・`credentialParams` に当たるクエリ項目を除く・残りのクエリを名前順に並べる・スキームとホストを小文字にする、の 4 つだけ。**資格情報を除いた後から id を作る**ので、`?access_token=` は id にも IndexedDB にも公開の値にも残らない。重なりの判定（`templatesOverlap`）も正規化した形で比べる
- 新 API: 先頭のテンプレートの正規化を `Resource.id` にする。URL 配列（ミラー）は 1 つの `Resource` にまとめ、既存の `Resource` のテンプレートと 1 つでも重なれば合流する。合流したときは既存の id を変えない（ミラーの順を入れ替えて登録し直しても id は同じ）。**タイルのキーに URL を使わず座標を使う**ので、`a.tile…`・`b.tile…` のどれで取っても同じ Entry になる（試作の URL キーでは 3 重に保存される）
- 旧 API: Source の id も Resource の id も `map:<mapID>`。新 API で `map:` から始まる id は拒否する（同じ `sources` ストアで旧 API の記録と衝突させないため）。**新 API の合流の候補に旧 API の Resource を入れない**（同じ URL でも別の Resource になる。合流すると旧 API の Resource は照合表に入らないので捕捉されなくなる）。新 API の `source()`・`sources()` は旧 API の記録を見せない（`source-not-found`）。旧 API の地図は互いに共有しない。旧 API では同じ URL の 2 地図は別のキャッシュで、`clean` も片方だけに効く。この挙動を変えない
- **Resource の id は書き換えない**。`credentialParams` を宣言しない Source が先に作った Resource の id には、その項目が残る。資格情報のクエリ項目は先に登録する Source で宣言する（m3-t3 I8）
- 明示の `credentials.query` を持つ Source を、Entry のある Resource へ後から登録すると `resource-conflict` になる（キーの形が変わるため。m3-t3 I8）

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
  extents?: TileExtent[];     // type === 'tile' のときの範囲。Source ごとの和（§5.6）
  scheme?: 'xyz' | 'tms';
  encoding?: 'raster' | 'vector';
  policy: ResourcePolicy;     // 実効方針（§5.6）
  corslessUntil?: number;     // §4.5
  corsOk?: boolean;           // §4.5。CORS を通った応答を 1 度でも受けた印（状態コードは問わない）
  rangeOnlySourceIds?: string[]; // §5.6。合流を拒否したが範囲だけ足した Source
  count: number;              // Entry の件数（同じトランザクションで更新）
  bytes: number;              // 同じ
  pinnedBytes: number;        // 固定分
}

export interface TileExtent {
  minZoom: number; maxZoom: number;
  box?: TileBox;              // maxZoom での x/y の範囲（tile_math.ts の型）。Source の scheme の座標（bounds から作るときは tms なら y を反転する）
  sourceId: string;
}

export interface ResourcePolicy {
  cacheTtl: number;
  cacheRetention?: number;    // undefined は無期限
  store: boolean;             // false なら認証付きの要求を保存しない
  outOfRange: { extent: OutOfRange; zoom: OutOfRange };
  credentialParams: string[];
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

// bodies に置く形（m3-t10）。EntryBody は Store の呼び出し側の形で、保存は本体を ArrayBuffer・型を type に分ける
export interface StoredBody {
  key: string;
  data: ArrayBuffer;
  type: string;
  headers: Record<string, string>;
  parts?: GlyphPartIndex;
}
```

本体を Blob のまま保存しない。WebKit の非永続の保存領域（Safari のプライベートブラウズ・Playwright の WebKit）は IndexedDB に Blob を put できない（`UnknownError: Error preparing Blob/File data to be stored in object store`。m3-t10 の CI で実測）。Blob との変換は `store.ts` に閉じ、Blob → ArrayBuffer の入口は 1 つ（`readBlob`。`toStoredBody` と `putGlyphParts` の部分の変換が使う）。Blob を持つ古いレコード（開発の途中の形）は miss として作り直す。

`ResourceMeta` は保存の型で、公開しない。ページ側の API（`WeiwudiSource.resources`・`stats().byResource`）と差し込み口（§8）へは、射影した `ResourceInfo` だけを渡す。

```ts
export interface ResourceInfo {
  id: string; type: ResourceType; templates: string[];
  count: number; bytes: number;
  rangeOnly?: true;            // §5.6
  corsless?: true;             // corslessUntil が今より先のとき（§4.5）
}
```

`Source` の保存の型（`store.ts` の `SourceRecord`）は、登録内容（資格情報を除く）・登録順の連番・`warnings`（§12）・旧 API の `legacy`（`MapSetting`）を持つ。

#37 の注記「参照元の URL を扱う項目は URL 処理の後」に従い、上流 URL の項目は `ResourceMeta` に置かない。`templates` が資格情報抜きの URL を持つので足りる（#14 の `httpUrl` に当たるものは要らない（m3 計画 R16）。提供元の URL は登録の時点で https に解決し、`templates` が資格情報なしの URL を持つ）。

### 5.3 キー

`key = <resourceId> + '\0' + <suffix>`

| 型 | suffix |
|---|---|
| tile | `z_x_y`（`{ratio}` が `@2x` なら `z_x_y@2x`）＋残りのクエリ。旧キー（`z_x_y`）と同じ形にして、m4 の移行で旧キーの suffix を解析し直さずにそのまま使えるようにする。あわせて `accessedAt` が同じときの退避の順（キー昇順）も旧 API と揃う（m2 計画の R2） |
| glyph | `<fontstack>`（範囲は §11 で 1 レコードに束ねる） |
| sprite・style・tilejson・data | 残りのパス＋残りのクエリ。無ければ空 |

クエリの正規化: `credentialParams`（既定 `access_token`・`token`・`key`・`api_key`・`apikey`・`sku`。登録で足せる。明示の `credentials.query` の名前は大文字小文字を問わずに自動で足す）を除き、残りを名前順に並べる。`sku` を含むのは Mapbox GL が要求ごとに変えるから。

### 5.4 ストア

単一 DB `WeiwudiStore`（`version: 1`）。旧 DB `Weiwudi`・`Weiwudi_<mapID>` は移行後に消す。

| ストア | keyPath | 索引 | 備考 |
|---|---|---|---|
| `sources` | `id` | | 登録内容。旧 API は `MapSetting` をそのまま `legacy` に持つ |
| `resources` | `id` | `sourceIds`（multiEntry）・`rangeOnlySourceIds`（multiEntry） | |
| `entries` | `key` | `[resourceId, pinned, accessedAt]`・`[pinned, accessedAt]`・`[pinned, fetchedAt]`・`[resourceId, z]` | `EntryMeta`。本体を持たない |
| `bodies` | `key` | | `EntryBody` |
| `regions` | `id` | `sourceId` | §7.2 |
| `credentials` | `sourceId` | | §10 |
| `kv` | `key` | | スキーマ・移行状態・全体上限 |

試作と現行からの変更とその理由（1 件あたりの計算量を下げる。100 万 Entry でも動くため）:

- メタと本体を分ける: 現行は cache hit のたびに Blob ごと `put` し直す（`getImage` の accessedAt 更新）。分ければメタだけで済む
- `count`・`bytes` を `resources` に持ち、Entry の増減と同じトランザクションで更新する: 現行の `stats` は全件走査、`putItemWithEviction` は保存のたびに全件走査で、`fetchAll` 全体が O(N²)
- LRU と期限の掃除は `pinned = 0` の範囲を索引で引く。固定が多くても読み飛ばさない
- 資源の一括削除は `delete(IDBKeyRange.bound(id + '\0', id + '\x01', false, true))` 1 回で済む（#38。id に `\0` は入らないので、この半開区間で漏れなく取れる。`id + '\0￿'` を上端にすると U+FFFF で始まる suffix を取りこぼす。m2-t2 の Ruling R6）
- `fetchAll` の「既に有るか」は `allKeys.indexOf` をやめ、バッチごとに `getKey` する

`openDatabase` の `onblocked` 処理・`onversionchange` で閉じる処理（#59）は `store.ts` へそのまま移す。`getDB` の「store が無ければ版を上げる」は不要になる。

### 5.5 スタイルからの芋づる式登録

`kind: 'style'` の登録は SW 側で行う。

1. スタイルを `serve()` 経由で取得する（2 回目以降はキャッシュから。**オフラインで同じ登録を繰り返しても失敗しない**）
2. `sources` を走査する。`url` があれば TileJSON を取得して `tiles`・`bounds`・`minzoom`・`maxzoom`・`scheme` を得る。`tiles` があればそのまま。試作は `source.url` を読まないので TileJSON 経由の資源を落としていた
3. `glyphs`・`sprite`（文字列か、MapLibre の `{id, url}[]`）・`geojson` の `data`（URL のとき）・`image` の `url` を登録する。スプライトは `.json`・`.png`・`@2x.json`・`@2x.png` の 4 つを同じ `Resource` の suffix とする
4. 一部の取得に失敗したら、登録は成功させて `warnings[]` に残す。下位資源が `resource-conflict`（§5.6）になったときも同じで、スタイル全体は登録する（`kind: 'raster' | 'vector' | 'asset'` の登録も同じ扱い。§5.6）。その資源の URL は既存の `Resource` に当たるので、捕捉とキャッシュは**既存の `Resource` の方針のまま**行われる。ただし範囲だけは §5.6 の規則で既存の `Resource` に足されるので、このスタイルの地図でも範囲外として透明画像・空本体にはならない。範囲以外の指定（`cacheTtl`・`cachePrivate` など）は効かない。これを `warnings` に書く。スタイル自体が読めなければ `invalid-style`
5. **別オリジンのスタイルが、ページと同じオリジンの URL を指していたら登録しない**（`warnings` に残す）。第三者のスタイルで同一オリジンの API を捕捉させないため
6. `register()` は冪等である。`source.update()` で取り直し、参照が消えた `Resource` は `sourceIds` から外して空なら削除する

**m3-t7 で決めたこと**（計画 `docs/superpowers/plans/2026-11-04-m3-vector.md` の R1〜R5・R10・R30・R33〜R35）:

- 子 Source（R1）: 下位資源ごとに内部の Source（`kind: 'child'`・`parentId`・id は `${parentId}\0${type}:${論理名}`）を作り、§5.6 の規則を子ごとに当てる。子は `source()`・`sources()` に出さない。親（`kind: 'style'`）は `children`（`from` は TileJSON から作った子の出どころ）を持ち、`clean`・`remove`・`stats`・`source.resources` は子の id の一覧で Resource を集める。`stats` のスタイルは `total`・`percent` を出さない
- 段取り（R2）: 段 A（スタイル）→ 段 B（TileJSON）→ 段 C（残り）の順に子を重ね、前の子は最後の段の後にだけ外す。取得は `hook.serveResource`（`core.serve`）だけ。新しい登録は段 A〜C のどこかで失敗したら子を外してから親を外す（R30）。既存の登録の `update()`・同じ id の再登録は、段 A（スタイルの取得と解析）が成功するまで何も書かない。段 A より後の IndexedDB の失敗は巻き戻さない（R33）
- 取れない TileJSON（R3）: `fetch-failed` になるのは Entry が無く上流も失敗したとき（`x-weiwudi-status` が `offline-miss`・`upstream-error`）だけ。`stale` の古い本体は取れたものとして使う。取れなかった TileJSON から前回作った子は前回のまま残す
- `update()` の取得は `revalidate`（hit を飛ばして上流へ。失敗なら古い本体）、`register()` は通常の順（R4）。`update()` は子を `resetCors: true` で合流させる
- 資格情報（R5）: 親の資格情報は、子の全テンプレート（ミラーを含む）がスタイルの URL と同じオリジンか親の提供元の `matches` に当たるときだけ、その子に配る（`style_body.credentialTargetOf`）。資格情報は親（登録の正本。`update()` で配り直す）と子（照合表が使う）の両方の id で持つ。子のテンプレートに載っていた同じ名前の値は、子のものが勝つ。子にする組の判定（`spec.acceptsMember`。R22 のミラーの値の食い違い・userinfo・`sk.` なども）は本体の資格情報の除去（§10）と同じ
- 衝突（R10）: スタイルの子の登録は `{ throwOnConflict: false }`。新しく現れた子の衝突は新しい登録として扱い（範囲だけ＋`warnings`）、前からある子の衝突は keep。スタイルの `update()` は下位資源の衝突で例外にならない
- 同じオリジンの検査（R35）: スタイルの参照と、TileJSON の `tiles`（スタイルか TileJSON のどちらかが SW と別オリジンのとき）に当てる
- Mapbox の `imports` は辿らない（`unsupported-source: imports`）。タイルの URL の `@2x`・`webp`・`raster/` の書き換え（Mapbox GL JS の `normalizeTileURL`）は行わない（MapLibre は書かれた URL をそのまま要求する）

### 5.6 合流と実効方針

捕捉した要求から決まるのは `Resource` だけで、どの `Source` の要求かは分からない。そこで `Resource` に実効方針を持たせる。`sourceIds` か `rangeOnlySourceIds` が変わるたびに、参照している全 `Source` の指定から計算し直して `resources` に保存する。`extents` は `sourceIds` と `rangeOnlySourceIds` の両方の `Source` の範囲の和から作り、その他の項目は `sourceIds` の `Source` だけから作る。**ただし `credentialParams` は Entry がある間は縮めない**（`count === 0` のときだけ計算し直す。Source の削除でも、自分自身の `update()` で減る場合でも同じ）。縮めると §5.3 の正規化で資格情報がキーに残り（§10 に反する）、既存の Entry にも当たらなくなる。

| 項目 | 合成の規則 | 理由 |
|---|---|---|
| 範囲（`extents`） | 和集合。範囲の指定が無い `Source` が 1 つでもあれば、広がりの制限なし | 東京の A と大阪の B が同じ URL を登録しても、片方が透明画像にならない |
| ズーム | 同上（`Source` ごとに `TileExtent` を持つので自動で和になる） | 同上 |
| `cacheTtl` | 最短 | 新しさを求める側に合わせる |
| `cacheRetention` | 最長。指定なしの `Source` があれば無期限 | 残したい側のデータを消さない |
| `outOfRange` | 全 `Source` で同じならその値、違えば型の既定（§6） | どちらかに寄せる根拠が無い |
| `store`（`cachePrivate`） | 全 `Source` が `true` のときだけ認証付きの要求を保存する | 保存を望まない登録を優先する |
| 資格情報 | `sourceIds` の登録順で、持っている最初の `Source` のもの | 1 つに決める必要がある。`Source` を消せば次へ移る |
| `credentialParams` | 和集合 | 漏らさない側に倒す |

`cacheMaxBytes` は `Source` の方針のまま（§7.1）。`fetchRange` の `'all'` も `Source` 自身の範囲を指す。

**合流を拒否する場合**（`resource-conflict`）。`key` の形が変わるのに、既存の Entry を書き換えないため。

- `credentialParams` の和が広がり、その `Resource` に Entry が既にあるとき（Entry が無ければ合流する）。別の Source の登録でも、自分自身の `update()` で広がる場合でも同じ。縮む場合は拒否せず縮めない（上）。自分自身の `update()` で拒否になったときは、`update()` 全体が `resource-conflict` で失敗し何も変えない（`corsOk` などの消去もしない）。スタイルの下位資源のときは、その資源だけ古い方針（範囲も含む）のまま `warnings` に書き、スタイルの残りは更新する。自分自身の `update()` の拒否には下の「拒否しても範囲だけは足す」を当てない。その `Source` は `sourceIds` に残り、古い範囲のままである
- `type`・`encoding`・`scheme` が違うとき
- URL 配列が **2 つ以上の既存 `Resource`** に重なるとき。`Resource` の統合はキーの書き換えを伴うので行わない。利用者が片方を消して登録し直す

**新しい登録の拒否は登録の失敗にしない**。`register()` は `kind` によらず（`style`・`raster`・`vector`・`asset`）、衝突した資源があっても**成功して `Source` を保存する**。衝突した資源は合流させず、`warnings` に `resource-conflict` と `Resource.id` を書く。`Source` が保存されるので、利用者は `remove()` で外せる（存在しない `Source` の id が残ることはない）。`resource-conflict` を例外として投げるのは、自分自身の `update()` だけである（上）。

**既存の id への `register()`**（同じ id の Source を方針を変えて登録し直したとき）は、その Source が既に属している `Resource` については自分自身の `update()` の規則に従う。古い方針と古い範囲のまま `sourceIds` に残す。ただし例外にはせず、`warnings` に `resource-conflict` を書く。`sourceIds` から `rangeOnlySourceIds` へは移さない（外すと `sourceIds` が空になった `Resource` と Entry が消え、両方に入れると方針の合成が二重になるため）。

**拒否しても範囲だけは足す**（新しい id の登録か、その Source がまだ属していない `Resource` との衝突のときに限る）。範囲（`TileExtent`）はキーを変えないので、拒否の理由に当たらない。拒否した `Source` を重なった各 `Resource` の `rangeOnlySourceIds` に入れ、その `Source` の `TileExtent` を `extents` の和に加える（他の方針の合成には入れない）。`scheme` の違いで拒否したときは、y を反転して（`maxZoom` での `box` を `minY' = 2^maxZoom − 1 − maxY`・`maxY' = 2^maxZoom − 1 − minY`）既存の `Resource` の `scheme` に読み替えて加える。ズームは `scheme` に関係なくそのまま使う。これで §6 の 1 の範囲外判定が、拒否された `Source` の地図を透明画像・空本体にしない（上の表の範囲の行と同じ理由）。

`rangeOnlySourceIds` の保守:

- 同じ `Source` の再登録・`update()` では、その `Source` の分を置き換える（重ねて入れない）
- その `Source` が通常の合流（`sourceIds`）に変わったら `rangeOnlySourceIds` から外す
- `Source` を消すときは、`resources` の `rangeOnlySourceIds`（multiEntry 索引。§5.4）で引いて外し、和を計算し直す
- `sourceIds` が空になった `Resource` は、`rangeOnlySourceIds` が残っていても削除する（範囲だけの `Source` は捕捉の対象を持たないので、`Resource` が消えた後はその URL を捕捉しない。`warnings` に書いた衝突の相手が消えた状態で、`update()` すれば通常の合流になる）

範囲だけの `Resource` の扱い:

- `source.resources`・`stats().byResource` に `rangeOnly: true` を付けて含める（地図が使う URL を利用者が見られるように）
- 範囲取得（§7.2）の対象に含める。保存は既存の `Resource` の方針で行い、固定は region に結び付く（解放の規則は §7.2 のまま）
- `source.clean()` では、他の `Source` が参照する共有の `Resource` と同じく Entry を消さない。`clean(range)` も同じ

拒否はキャッシュの整合のためで、地図は動かせる（別の URL か、`Source` の削除で解決できる）。旧 API の `Resource` は合流しないので、この節の対象外である。

## 6. 配信の決定（`serve()`）

全経路（照合ルート・門番・旧 `/api/cache`・範囲取得）がこの 1 関数を通る。#15 の「キャッシュ確認→取得→保存の共通化」を満たす。

| 順 | 条件 | 応答 | `x-weiwudi-status` |
|---|---|---|---|
| 1 | 範囲外（`extents` の和の外。§5.6。全 extent でズームの外なら「ズームの外」、それ以外は「広がりの外」として下の表を引く） | 下の表 | `out-of-range` |
| 2 | 新しい Entry がある（`now - fetchedAt <= cacheTtl`） | 保存した本体 | `hit` |
| 3 | 上流が成功 | 上流の本体（保存を試みる） | `miss`／更新なら `refresh` |
| 4 | 上流が失敗（HTTP）・Entry あり | 古い本体 | `stale` |
| 5 | 上流が失敗（HTTP）・Entry なし | 上流の `status`・`statusText`・本体・ヘッダを写した合成応答に `x-weiwudi-*` を足す（旧 API の経路の値は golden に従う） | `upstream-error` |
| 6 | ネットワーク失敗・Entry あり | 古い本体 | `stale` |
| 7 | ネットワーク失敗・Entry なし | 404 | `offline-miss` |

- 「上流が失敗（HTTP）」は `!response.ok` に加え、**スタイル・TileJSON 以外で 200 の `text/html`**（§4.6。ログイン画面）を含む。Entry があれば 4 の古い本体、無ければ 5 の合成応答（上流の `status`・`statusText`・本体・ヘッダを写して `x-weiwudi-status: upstream-error`・`x-weiwudi-error: upstream` を足す。写すときに保存時と同じ `content-encoding`・`content-length`・`transfer-encoding`・`set-cookie` を落とす。新旧どちらの経路も同じで、旧 API での変化は §9 に書く）
- **公開の契約**: `x-weiwudi-status` の値は表の 7 つ（`out-of-range`・`hit`・`miss`・`refresh`・`stale`・`upstream-error`・`offline-miss`）、`x-weiwudi-error` の値は 4 つ（`network`・`upstream`・`quota`・`storage`）、`access-control-expose-headers` は `x-weiwudi-status, x-weiwudi-error` で、合成した応答すべてに付ける（上流の同名のヘッダに足さず上書きする）。表の 5 では `x-weiwudi-error: upstream` を付ける。値を増やすときは minor で文書に足す
- 配信の時点で削除期限（§7.1 の `cacheRetention`）を過ぎた Entry は「無いもの」として扱う（掃除の前に当たる Entry のため。掃除は §7.1）
- これは現行の `getImage` の順序そのものである（既存の試験が契約）。増えるのは §9 の既知の変化（`x-weiwudi-status` など）だけである。SW が合成した応答はページから見て `basic` なので、別オリジンの URL でもこのヘッダを読める（§2 の計測で確認）。ただし opaque の応答（§4.5 の 2）は SW が合成した応答ではないので `x-weiwudi-status` を付けられず、ページからも読めない
- 保存に失敗しても配信は続ける（#22 の現行の決まり）。応答に `x-weiwudi-error`（§9）を付ける
- 7 を透明画像にしないのは、地図ライブラリが親タイルへ戻る動きを止めないため
- 同じ `key` の同時要求は `Map<key, Promise>` で 1 本にまとめる
- 保存時に応答ヘッダから `content-encoding`・`content-length`・`transfer-encoding`・`set-cookie` を落とす。本体は復号済みなので、残すと再生時に矛盾する

### 範囲外の応答

`outOfRange: { extent, zoom }`。`Resource` の実効方針（§5.6）を使う。値は `'transparent'`（ラスタの既定）・`'empty'`（ベクタの既定）・`'not-found'`。

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
| 鮮度 | `cacheTtl`（ms。§5.6 の実効値） | 24 時間 | 越えたら上流へ。失敗なら古いものを返す。**消さない** | 現行のまま |
| 削除期限 | `cacheRetention`（ms。§5.6 の実効値） | なし（無期限） | `fetchedAt` から越えたら消す | 新設（#9「キャッシュ期間管理」） |
| 容量 | `cacheMaxBytes`（Source 単位）・`setLimits({maxBytes})`（全体） | なし | 超えたら LRU で退避。単体で上限を超える応答は保存しない | 現行のまま＋全体上限 |
| 固定 | `fetchRange` の `pin`（既定 `true`） | — | 固定した Entry は LRU と削除期限の対象外 | 新設 |

- `cacheRetention` の掃除は、SW の起動後の最初の store を使う Weiwudi の要求とジョブの完了時に行う（タイマは使わない）。旧 API の `ping`・`fetchAll` の dispatch と `control.get`（`/v2/ping`）は契機から外し、`fetchAll` はジョブの終了時に掃除する。制御 POST は送り手の検査後、照合ルート・門番は照合に当たったときだけ `waitUntil` に結び付ける。新しい fetch リスナは足さない。保守の失敗は記録し、配信は続ける
- グリフ以外は `[pinned, fetchedAt]` 索引を 200 件ずつ読み、Resource ごとの期限で削除する。削除の tx で固定・取り直しの有無を見直す。グリフは Resource のキー範囲を 200 件ずつ読み、部分ごとの期限で本体を詰め直す。固定した Entry は消さない。配信時にも期限切れは「無いもの」として扱う
- 1 回の掃除は両方の走査を合わせて最大 2,000 件の訪問まで（対象外のメタも数える）。未完なら時刻・方針・続きの位置をメモリに残し、次の対象要求で続ける。全走査が終わったら SW の生存期間中の完了印を立てる。ジョブ中は走らせず、終了時の `force` は未完の走査があれば続け、完了済みなら新たに始める。同時の掃除は 1 本にまとめる
- `cacheMaxBytes` の範囲は Source。保存のとき、その `Resource` を `sourceIds` に持ち `cacheMaxBytes` を指定した **Source ごとに**、その Source の `Resource` 群の `[resourceId, 0, accessedAt]` を併合して古い順に消す（上限が 2 つあれば両方を満たす）。`rangeOnlySourceIds` の Source の上限は数えない。共有 `Resource` の Entry も消える（キャッシュなので許容し、固定で守れる）
- 固定分だけで `cacheMaxBytes` を超えるときは `fetchRange` が `quota` で止まる
- （m4）`QuotaExceededError` のときは、固定以外を全体 LRU で 10% 退避して 1 回だけ再試行する。旧 API の「保存の abort → 保存されない」の試験の結果を変えるので、m4 の全体上限と一緒に旧 API での扱いを決めて入れる（m2 計画の R15）。全体上限の既定が無いので、これが無いとブラウザの上限に当たった後はキャッシュが自力で回復しない
- ページ側の `fetchRange` が、制御の要求を送る前に `navigator.storage.persist()` を試す（失敗は無視）。`persist` はページの API で SW には無い（`estimate` は SW でも使える）。ブラウザの自動削除に対する唯一の手段
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

**範囲取得の実装の決め（m4-t3）**:

- URL は `url_pattern.expandTemplate` で作り、同じテンプレートに `matchUrl` で照合した `MatchResult` を `hook.serveResource` に渡す。キーは `entryKey` 1 つ（捕捉と 1 字もずれない。R2）。ミラーは持ち主の Source が登録したテンプレートから無作為に 1 つ
- 要求は `new Request(url)`（§4.5 の表）。資格情報は照合表の `credentialSources`（Resource × オリジン）から `hook.credentialsForResource` で選ぶ（照合ルートと同じ相手にだけ送る。R3）。CORS・認証の規則（§4.5-3・§4.6）はジョブが serve の応答の `x-weiwudi-error` と `upstream.probeNoCors`（`mode: 'no-cors'`・`credentials: 'omit'` の 1 回。保存しない）で判定する（R4）
- region は `{ id, sourceId, range, normalized, options, status, pinned, total, error, errors, code?, createdAt, updatedAt }`。`range` は決めた項目だけの写し、`normalized` は取得のときの XYZ の範囲（`'all'` も固める）、`options` は検査済みの指定（再開で使う）。進捗の位置は持たない。終わりの書き込みは `patchRegion` で「有り・`running`」のときだけ。`regions()` は `running` で `ctx.job` が無いか `ctx.job.regionId` が違うものを `partial` と見せる。ページが閉じた（`gone`）ジョブは `partial`（R5）
- ジョブは直列の待ち行列の外で動く。各バッチの前に Source の有無を見て、無ければ `stop`（`source-not-found`）。region が無ければ（`clean()` などが消した）固定を付けずに `canceled` で終える。バッチの後の固定の前にも region を見る（R13・R57）
- `opaque` イベント（`{ type: 'opaque', sourceId, resourceId }`）は、照合ルートが `corslessUntil` を書いたときと、ジョブが `opaque` で止めたときに、`clients.matchAll({ type: 'window' })` の全 client へ 1 回送る。子 Source は親に読み替える（R20）
- ページ側の `fetchRange` は POST の応答（`running`）の後、その `regionId` の `finish`・`stop`・`canceled` を待つ（`canceled` も解決、`stop` は reject）。30 秒来なければ `job/resume` を送り、応答が終わりの `status` ならそれで解決する（`stopped` は reject）。`cancel()` は取り消したジョブの `canceled`（か終わりのイベント）を受けてから解決する（30 秒来なければ `regions()` を読んで解決。R22・R58）
- `'all'` は Source の範囲（スタイルは子の tile の範囲の和）。`box` の無い Source の `'all'` は `cannot-fetch-all`（R30）
- 終わりの順は「region を書く → `ctx.job` を外す → `postMessage`」。`job/resume` は、同じ region のジョブ中なら今の `RegionInfo`、別の region のジョブ中なら `fetch-busy`、region が終わっていればその `RegionInfo`。ジョブを作り直す分岐だけは直列の中で行う（R45・R57）
- 固定は、成功と数えたキー全部へのバッチの後の `setPinned(keys, 1)`（200 件ずつ）の 1 本で、region が有るときだけ付ける。保存と同じ tx で付ける近道（`ServeInput.pin`）は使わない（同時要求のまとめと hit は保存を通らず、近道は途中で region が消えたときにどの region にも属さない固定を残す。R46・PR #102 M2）。確かめが止めたバッチでも、取れた分は固定する。確かめで取れたタイルが列挙で失敗と数えたものなら、その場で成功に数え直す
- 固定した Entry の和が Source の `cacheMaxBytes` に達したら `stop`（`quota`）。開始のときと各バッチの後に見る（R55）

**スタイルの範囲取得（m4-t4）**:

- 型の順に取る: スタイル（hit でよい）→ TileJSON・データ（1 件ずつ）→ スプライト（`{spriteSuffix}` の `.json`・`.png`・`@2x.json`・`@2x.png`）→ タイル（TileJSON の下の子も。同じ `Resource` は 1 回）→ グリフ。どれも `hook.serveResource` を通し、固定は他と同じバッチの後の `setPinned`（region が有るときだけ）。スタイルは先に別の段で取り、本体（`style_body.parseStyle`）から fontstack を集めてからグリフの単位を作る。読めないスタイル（HTML は配信の段で `upstream-error`）はスタイルの単位だけ `upstream` に数えて続ける
- fontstack は `FetchRangeOptions.fonts` ∪ `StyleSpec.fonts` ∪ `collectFonts(style)` の和（重ねない）。要素は `{fontstack}` に入る値（フォント名を `,` で結んだもの。名前 1 つもそのまま 1 つ。R53）。`collectFonts` は `layers[*].layout['text-font']` の文字列の配列と `["literal", [文字列…]]` を `,` で結ぶ。先頭が式の演算子の配列と関数の object は飛ばす
- `glyphRanges` の `'common'` は上の 5 つ、`'all'` は `0-255` から `65280-65535` の 256 個、配列はそのまま（重複も残し、後勝ち。R32）
- `estimate`・`RegionInfo.total`・`percent` はタイルだけ。非タイルの単位は `processed` に入れる（R29）
- 非タイル資源の固定は、その `Resource` を参照する全 Source（子は親に読み替え）の固定つきの region が 1 つでも残る間は保つ（R11。外すのは m4-t5 の解放）

## 8. 差し込み口（#36）

容量超過で保存しない部分は `putItemWithEviction`（#29）で済んでいる。残りは差し込み口である。

差し込みは SW 側に限る。関数はページから SW へ送れない。`@c4h/weiwudi/sw` の名前付き export として足す（副作用 import はそのまま動く）。UMD は `self.Weiwudi_SW` から使う。

```ts
export interface WeiwudiPlugin {
  // Workbox のプラグインと同じ名前・同じ意味
  requestWillFetch?(p: { request: Request; resource: ResourceInfo; state: unknown }): Promise<Request | void>;
  fetchDidSucceed?(p: { request: Request; response: Response; resource: ResourceInfo; state: unknown }): Promise<Response | void>;
  fetchDidFail?(p: { request: Request; error: unknown; resource: ResourceInfo; state: unknown }): Promise<void>;
  cacheWillUpdate?(p: { request: Request; response: Response; resource: ResourceInfo }): Promise<Response | null | void>; // null で保存しない
  cachedResponseWillBeUsed?(p: { request: Request; cachedResponse: Response; resource: ResourceInfo }): Promise<Response | null | void>;
}
export function addPlugin(plugin: WeiwudiPlugin): void;
export function addProvider(provider: WeiwudiProvider): void;   // §10
```

- 同じオブジェクトの 2 回目の `addPlugin` は無視する（冪等）。`addPlugin` は以後に始まる要求にだけ効く。`state` はプラグインごと・要求ごとに新しい object
- 登録順に実行する。プラグインの例外は `console.error` に残し、そのプラグインを飛ばして続ける。地図を止めない
- 旧 API の経路にも効く（`serve()` が 1 つだから）。旧 API の上流は `fetch(URL の文字列)` の 1 引数（§4.5）だが、`requestWillFetch` が別の `Request` を返したときだけ `fetch(その Request)` にする
- 差し込み口に渡す資源は `ResourceInfo`（§5.2）。保存の型は渡さない
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
| 旧 API | **文字列で reject し続ける**。文面の保証は下。`WeiwudiError.from(e)` で `code` を得られる |
| タイルの応答 | 応答ヘッダ `x-weiwudi-error: network｜upstream｜quota｜storage` |
| 範囲取得のイベント | `stop` に `code`。`proceed`・`finish` に `errors: { network, upstream, quota, storage }`。`error`（合計）は残す |

文字列を `Error` に置き換えない理由: 公開文書が `"Error: {message}"` を約束しており（`docs/api/weiwudi.md`）、`typeof e === 'string'` や `e.match()` で分岐する利用者を壊す。リリースポリシー §5.3・§9.1 では major と非推奨の手順が要る。`from` なら 0 件の破壊で #33 の「原因に応じて分岐できる」を満たす。利用側（MaplatCore・MaplatCorePro）は握りつぶしているので影響を受けない。

**旧 API の文面の保証**:

- m1-t3 の表にある 16 行の文面は 1 字も変えない
- `from` が文面から差し込み値を取り出すとき、区切りは各区切りの最後の出現で分ける。差し込みが複数ある文面の `detail` の分け方は保証しない（`code` と、文面を作り直せることだけを保証する）
- 包括の `Error: ${e}`（IndexedDB の例外などをそのまま文にしたもの）は、`Error: ` で始まることと `from` の分類（§9 の表と例外名）だけを保証する。中身は内部の都合で変わる。既知の変化は次のとおり
  - `Error: [object Event]`: IndexedDB の補助関数（`putItem`・`countDB`・`cleanDB`・`getItem`・`deleteItem`・`getAllKeys` ほか）が `Event` を reject していたため。m1-t3 は `putItem`・`putItemWithEviction` だけを `tx.error`・`req.error` に直し、残りは m2 の `store.ts` で揃える
  - 未登録の地図の `clean` の `Error: NotFoundError: …`: m2 の載せ替えで `Error: MapID "x" not found`（`stats` と同じ。16 行の側）にする
  - 旧 API のタイルも、200 で `content-type` が `text/html` の応答を上流の失敗として扱う（§6）。保存せず、Entry があれば古い本体、無ければ §6 の 5 の合成応答を返す。ログイン画面がタイルとして固定されるのを防ぐため
  - 保存した応答を返すとき、`content-encoding`・`content-length`・`transfer-encoding`・`set-cookie` を返さなくなる（§6。保存時に落とす。現行は上流のヘッダをすべて保存して返していた）
  - 合成した応答に `x-weiwudi-status` と `access-control-expose-headers` が付く（§6 の公開の契約）
  - 上流の HTTP 失敗で Entry が無いときの合成応答（§6 の 5）から `content-encoding`・`content-length`・`transfer-encoding`・`set-cookie` が落ちる。本体は復号済みなので、写すと矛盾する
  - `add` は `mapID` に NUL 文字（`\0`）を含むと `Error: MapID must not contain a NUL character` で拒否する（m4-t7・R19。Entry のキーの区切りなので、これまでは黙って他の地図の範囲にかぶっていた）
  - `blocked` の文面の DB 名は `Weiwudi` から `WeiwudiStore` に変わる。旧 DB が `blocked` でも `delete` は失敗せず成功する（§14.2。旧 DB の削除は次の起動へ回す）
  - `fetchAll` の `proceed`・`finish` の `error`・`errors` は、そのジョブの要求の失敗だけを数える（現行は動いている間の他のタイルの要求の失敗も数えていた。m2-t5 の Ruling）
  - `Range` ヘッダつきの `/api/cache` の要求は、保存も範囲外の判定もせず上流のタイルの URL へ素通しし、206 をそのまま返す（§11）。素通しのネットワーク失敗は §6 の 7 の形（404・`x-weiwudi-status: offline-miss`・`x-weiwudi-error: network`・`access-control-expose-headers`）で返す
  - 保存の前の容量の判定（`cacheMaxBytes` の退避の範囲を決める IndexedDB の読み出し）の失敗は、m2 では包括の `Error: ${e}` の本文を返していた（照合ルートは上流へ 2 回出していた）。m4 で直し、現行と同じく保存の失敗として取得したタイルを `x-weiwudi-error: storage` で配信を続ける（保存しない・上流へは 1 回）

文字列の reject は次の major で `WeiwudiError` へ変える。非推奨の予告は §13 の時期に合わせる。

新 API で増えるコード: `unsupported-template`・`invalid-style`（スタイル自体が取れない・読めない。§5.5。m3-t7）・`opaque`・`sw-outdated`・`credential-rejected`・`source-not-found`・`resource-conflict`・`unsupported-kind`（その版がまだ扱わない `kind`。m2 では `style`・`asset`。m3-t7 で全 kind を扱うので作られなくなった。union には残す）。`resource-not-found`（`removeResource()` の id がその Source（スタイルは子）の Resource でない。m3-t8）。`resource-conflict` は自分自身の `update()` でだけ例外として投げ、`register()` では `warnings` に書く（§5.6）。

`WeiwudiErrorCode` と `ResourceType` は閉じた union のまま、minor で値が増える（文書に「switch には default を置く」を書く）。`from` は、印（`Symbol.for('@c4h/weiwudi/error')`）のある `WeiwudiError` なら、未知の `code` でも `/^[a-z][a-z0-9-]*$/` に合えばそのまま返す（新しい SW の code を `internal` に潰さない。m3-t8・I4・R24）。印の無い `name: 'WeiwudiError'` だけの救済は既知の `code` に限る。`quota`・`network`・`upstream`・`storage`・`fetch-busy` などは m1 の表にあるものを使う。

## 10. 提供元の URL と資格情報（#40）

**`mapbox://` は SW に届かない。** `fetch` イベントは `http(s)` だけで、Mapbox GL は自分で解決してから要求を出し、MapLibre は解釈しない。試作の `handleRequest` の `url.startsWith('mapbox://')` は到達しない。解決は**登録の時点**の仕事である。

```ts
export interface WeiwudiProvider {
  id: string;
  matches(url: string): boolean;
  resolve(url: string): string;                       // https URL。資格情報を新たに足さない。入力のクエリは残してよい
                                                      // （credentialParams に挙げた名前は登録の検査が取り除く。それ以外の名前の資格情報は残る）
  applyCredentials(url: URL, c: Credentials): void;   // 上流へ出す直前にだけ呼ぶ
  rewriteStyle?(style: unknown): unknown;             // スタイル中の独自スキームを https へ
  validateCredentials?(c: Credentials): void;         // 不正なら credential-rejected
  credentialParams?: string[];
}
```

- 標準で `providers/mapbox.ts` を持つ。形は 4 つ（スタイル・タイルセット・スプライト・フォント）
- `@c4h/beatbox` には依存しない。SW 側で必要な変換が小さい表で済み、これのために実行時依存（現在 0 件）を増やさない。BeatBox 0.1.1 の変換表は m3 で突き合わせて写す
- `sk.` で始まる秘密トークンは `credential-rejected` で拒否する（試作の決定を継承）。この検査は提供元に依らない文字列の検査として、汎用の資格情報と同じ m2 に入れる。対象は `credentials` の `query`・`headers` の各値と、テンプレートの全クエリ値（名前も）と、パスの各区画（`sk.eyJ` で始まる区画。大文字小文字を問わず、percent-decode した後も見る。`sk.osm` のような区画名は通す。m3-t3 I9）で、先頭の `Bearer `・`Token `・`Basic `（大文字小文字を問わない）と空白を剥がしてから `sk.` で始まるかを見る。クエリ値は percent-decode した後の値も見る（`%73k.` を通さない）。保存する前に止める
- URL の userinfo（`user:pass@`）を含むテンプレートは登録で拒否する（`attribute-invalid`。判定は `new URL()` の `username`・`password` が空であること）。取り除くと照合が合わず、残すと id・テンプレート・`warnings` に出る
- 明示の `id` は公開の値（`source()` の鍵・`sources()` の `id`・`warnings`）である。資格情報を入れないことを利用者との契約にする（任意の文字列から資格情報を見分ける規則は作れないので検査はしない）。形だけは検査する: 文字列・空でない・`\0` を含まない（`\0` は保存のキーの区切りに使う文字なので、公開の値から締め出しておく）。外れたら `attribute-invalid`

**資格情報の分離**

```ts
type Credentials = { query?: Record<string, string>; headers?: Record<string, string> };
```

- 登録の `credentials` は `credentials` ストアだけに入れる。`sources`・`resources`・`entries`・イベント・エラー文面・`stats` には現れない
- 要求の URL に載っている資格情報は、`credentialParams` によりキーから落ちる（§5.3）
- `templates` は登録時に資格情報の項目を除いて保存する。TileJSON の `tiles` に載っているものも同様
- **`bodies` のスタイル・TileJSON の本体**: `credentials` を登録した `Source` では、保存の前に本体内の URL から `credentialParams` を除く（SW が上流で足せるので失うものが無い）。除くのは、子として捕捉され、R5 で親の資格情報を受け取る組（1 つの子になる URL の全部。スタイルの `sources.<キー>.tiles` の全体・TileJSON の `tiles` の全体など）の URL だけで、組の中に 1 つでも対象外の URL があれば、その組は除かない。別ホストの子・子にならない URL のトークンは本体に残す（R32）。組の中でも、除くのは登録した資格情報（`credentials.query`）と同じ値の項目だけで、違う値（子の固有のトークン）・登録の無い名前の項目は残す（子を作るときにそのテンプレートの値が子の資格情報になる。§5.5 の「子のテンプレートの値が勝つ」）。除くと地図ライブラリの要求にトークンが載らず、上流が拒否する。その場合のトークンは配信元がページへ渡したもので、ページの JS からもともと見える。`credentials` の登録が無いときは本体を変えない
- 上流へ出す直前に、要求に資格情報が無ければ `applyCredentials` で足す。これで `source.url`（資格情報なし）をページに渡せる
- 足すのは、差し込み口を通した後の要求の URL のオリジンが、ページから届いた要求のオリジンと同じときだけ（違えば足さない。m3-t3 I1）。ヘッダの資格情報を足した要求は `redirect: 'error'` で出す（別オリジンへのリダイレクトに `Authorization` 以外のヘッダが付いて行くのを止める。no-cors の要求を除く（ヘッダが送られないため。follow 以外の `redirect` は no-cors では network error になる））。リダイレクトはネットワークの失敗として §6 の 6・7 になる。クエリの資格情報だけを足した要求は元の `redirect` のまま。クエリの資格情報だけを足した要求はリダイレクトを辿る。リダイレクト先の URL は上流が `Location` で決めるもので、元の要求のクエリは引き継がれない（上流自身が書き込む場合を除き、上流は信頼する前提）
- テンプレートのクエリから資格情報を移すとき、同じ名前（大文字小文字を問わない）に違う値がミラーの間にあれば `attribute-invalid`（`URL templates carry different values for credential "<名前>"; register each mirror as its own source`。値は文面に入れない）。明示の `credentials.query` にある名前はテンプレートの値を見ない（明示が勝つ。m3-t3 I2）
- Entry のキーの残りのクエリ（§5.3）からは、名前か値が `sk.` で始まる項目も除く（decode した後の形で見る。m3-t3 I9）
- エラー文面と `warnings` に URL を入れるときは、クエリを落とす。`Resource.id`（§5.1 の正規化で資格情報を除いた形）は URL ではなく id としてそのまま書く（§5.6・§12。クエリを落とすと `layer=a` と `layer=b` の Resource を区別できない）
- `credentials` を IndexedDB に置くのは、ページが閉じた後の再開と SW 再起動のため。同じオリジンのスクリプトからは読めるが、そのトークンはもともとページの JS が持っている

**MapLibre で `mapbox://` を使う流れ**: `register({ kind: 'style', url: 'mapbox://styles/u/s', credentials })` → SW が解決して取得し、`rewriteStyle` で `https` に直して保存 → `source.url`（`https://api.mapbox.com/styles/v1/u/s`）を MapLibre に渡す。

## 11. 分割要求の結合保存（#39）と Range 要求

**#39 の対象はグリフである。** 元の #12 は「フォントの範囲ファイルを結合キャッシュへ」であり、HTTP の Range とは別の話である。

- `{fontstack}/{range}.pbf` を、fontstack ごとに **1 レコード**へ束ねる。Entry の `key` は fontstack までで、`parts` に `{ '<range>': { offset, length, fetchedAt } }`、本体に連結したバイト列を持つ（保存は ArrayBuffer。§5.2）
- 再生は `blob.slice(offset, offset + length)`（読み出した本体の Blob から）
- 保存は同じトランザクションで読み、残す部分の切り出しと新しい分を 1 つの ArrayBuffer に連結し直して書く（新しい分は tx の前に ArrayBuffer にする）。古い部分の差し替えで空きが残らない
- 範囲取得のときは 1 fontstack 分を溜めてから 1 回で書く。逐次に書くと fontstack の大きさ × 範囲数の書き込みになる。実装は `core.createGlyphCollector(ctx, resource, key)`: `ServeInput.collect`（`ServeResourceOptions.collect` から渡す）があると、`save` は `putGlyphPart` も `evictScopesFor` も呼ばずに部分を集め、配信は通常どおり返す。範囲取得は 1 fontstack を 1 単位にし、`try … finally` で `flush`（`evictScopesFor` を 1 回・`store.putGlyphParts` を 1 回）する。取り消しは範囲の間で見て、取れた範囲は書く。既に有る範囲は `getEntry` の `parts` で見て（fontstack ごとに 1 回）取らない。`flush` の失敗は fontstack ごとに 1 件（`quota`・`storage`）（m4-t4・L4）
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
  static register(spec: SourceSpec): Promise<WeiwudiSource>;   // 資源の衝突では失敗せず warnings に書く（§5.6）
  static source(id: string): Promise<WeiwudiSource>;       // 無ければ source-not-found
  static sources(): Promise<SourceInfo[]>;
  static usage(): Promise<UsageReport>;                    // 全体と提供元別（#38。m3）
  static setLimits(limits: { maxBytes?: number }): Promise<void>;   // m4
}

export class WeiwudiSource extends WeiwudiEventTarget {
  readonly id: string;
  readonly url: string | string[];          // 地図ライブラリへ渡す実 URL（資格情報なし）
  readonly resources: ResourceInfo[];       // §5.2 の射影。呼び出し時点の写し
  readonly warnings: string[];              // 登録・update の時点の写し（snapshot）。後で変わらない
  stats(): Promise<SourceStats>;
  update(): Promise<void>;
  estimate(range: RangeSpec): Promise<{ tiles: number }>;                                   // m4
  fetchRange(range: RangeSpec, opts?: FetchRangeOptions): Promise<RegionInfo>;              // m4
  releaseRange(regionId: string, opts?: { keep?: boolean }): Promise<void>;                 // m4
  regions(): Promise<RegionInfo[]>;                                                         // m4
  cancel(): Promise<void>;                                                                  // m4
  clean(range?: RangeSpec, opts?: { force?: boolean }): Promise<void>;   // 範囲なしは m2、range・opts は m4
  removeResource(resourceId: string): Promise<void>;   // 資源単位の削除（#38。m3）
  remove(): Promise<void>;                  // 登録と Entry を消す
  release(): void;                          // ページ側のリスナを外す
}
```

- 公開する型はすべて名前を付けて export する: `SourceSpec`・`CommonPolicy`・`Credentials`・`OutOfRange`・`TileBox`・`SourceInfo`・`SourceStats`・`ResourceInfo`・`ResourceType`・`UsageReport`（m3-t8）。`SourceInfo` と `SourceStats` は次の完全な形とする

```ts
export interface SourceInfo {
  id: string;
  kind: SourceSpec['kind'];
  url: string | string[];
  resources: ResourceInfo[];   // 呼び出し時点の写し
  warnings: string[];          // 登録・update の時点の写し
}
export interface SourceStats {
  count: number;
  size: number;
  total?: number;              // 範囲が決まるときだけ
  percent?: number;            // 同上
  byResource: Record<string, { count: number; bytes: number }>;
}
```

- `WeiwudiSource.resources` も呼び出し時点の写しで、後の変化は `stats()` か `source()` で読み直す
- 上の `class` の宣言のうち、各版の d.ts と文書には、その版で入るメンバだけを書く（m2 は `register`・`source`・`sources` と、`WeiwudiSource` の `id`・`url`・`resources`・`warnings`・`stats`・`update`・`clean`（範囲なし）・`remove`・`release`。m3 は `usage` と `removeResource` を足す。m4-t3 は `estimate`・`fetchRange`・`regions`・`cancel` と型 `RangeSpec`・`FetchRangeOptions`・`RegionInfo` を足す（§7.2））
- `warnings` の書式は `"<code>: <subject>"`（`subject` は `Resource.id`。利用者は知らない `code` を無視する）。`code` は次の 5 つ（m3-t7・R20）
  - `resource-conflict`（§5.6）
  - `template-shadowed`（同じ要求に当たる別の照合の形が先に評価され、その Resource が捕捉されない。その Source が参照する Resource のものだけを書く。スタイルは子の Resource のもの。I10・R26: 警告のまま）
  - `fetch-failed`（スタイル: 段 A 以外の取得の失敗。subject は取れなかった子の `Resource.id`）
  - `same-origin-skipped`（スタイル: §5.5-5。subject はクエリを落とした URL（オリジン＋パス）。パスの区画に秘密（`sk.eyJ`）があるか userinfo を持てば、スタイルの中の名前（`sources.<名前>`・`glyphs`・`sprite`・`sprite.<id>`））
  - `unsupported-source`（スタイル: video・知らない type・子として受けられない URL の source。subject は `sources.<名前>`・`glyphs`・`sprite`・`sprite.<id>`（`sprite` の配列の要素）・`imports`）
- 登録を拒否するもの: `map:` から始まる `id`・空の `id`・`\0` を含む `id`（§5.1・§10。`attribute-invalid`）・userinfo を含むテンプレート（§10。`attribute-invalid`）・`weiwudi.example.com` のテンプレート（`unsupported-template`）・その版が扱わない `kind`（`unsupported-kind`。m2 では `style`・`asset`。m3 では作られない）・`sk.` の資格情報（`credential-rejected`）・同じ id で違う `kind`（`attribute-invalid`。R37）・読めないスタイル（`invalid-style`）
- 提供元別の使用量（#38）は `usage().byProvider`。鍵は `ResourceMeta.provider`、無ければ先頭のテンプレートの origin（旧 API の相対の URL は SW の場所で解決する。origin が無ければ `'unknown'`）。全 Resource（旧 API の `map:` も、スタイルの子も）を 1 回ずつ数える。`byProvider` は null プロトタイプ（m3-t8・R19）

```ts
export interface UsageReport {
  count: number; bytes: number;
  byProvider: Record<string, { count: number; bytes: number }>;
}
```

- `removeResource(resourceId)`（m3-t8・R18）: その Source の `sourceIds` か `rangeOnlySourceIds` にある Resource の Entry を消す（`clearEntries`）。スタイルは親の単位で判定する（持ち主は子の id と、`parentId` が親の孤児の子。`remove()` が外す範囲と同じ）。Resource の記録と捕捉は残る。他の Source と共有していても、範囲だけで参照していても消す（利用者が名指ししたため。`clean()` は共有を残す）。グリフは fontstack ごとのレコードを全部消す。無ければ `resource-not-found`。control の直列の待ち行列に通す
- 制御の POST は、`event.clientId` の client（`self.clients.get`）の URL のオリジン（`blob:` は中のオリジン）が `self.location.origin` と同じときだけ受ける。違う・見つからないときは `{ ok: false, error: { code: 'sw-not-controlling' } }` で何もしない（m3-t8・I6・R25）。URL が `about:srcdoc`・`about:blank` の client（同じオリジンの iframe）は受ける。ほかの origin の無い client は受けない。ページ側は書式（`/^[a-z][a-z0-9-]*$/`）に合わない code を `internal` にする。GET の `/v2/ping` は見ない
- `/v2/*` の要求の前に制御下かを確かめる（§4.1）
- `/v2/ping` が `{ api: 2, version }` を返す。最初の POST の前に必ず確かめる（§4.1）。古い SW（更新待ち）に当たると 404 になるので、ページ側は `sw-outdated` を投げる。旧 `/api/ping` の `Implemented` は変えない
- `/v2/*` の POST は `Content-Type: text/plain;charset=UTF-8`（§4.1）

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
| `registerMap` → `/api/add` | `legacy.ts` が `MapSetting` を作り（現行の計算を `tile_math` で）、id がどちらも `map:<mapID>` の Source と Resource にする。**照合表には入れない** |
| `/api/cache/<id>/z/x/y` | `serve(resource, {z,x,y})` |
| `/api/stats` | `resources` の `count`・`bytes` から現行の形（`count`・`size`・`total`・`percent`）で返す |
| `/api/clean`・`/api/delete`・`/api/info` | Entry の削除・`sources` の操作 |
| `/api/fetchAll`・`/api/cancel` | ジョブ（`range: 'all'`・`pin: false`）。固定しないので `cacheMaxBytes` との関係が現行と変わらない |
| `proceed`・`finish`・`stop`・`canceled` | 同じ形（項目の追加のみ） |
| `map.url` | `https://weiwudi.example.com/api/cache/<id>/{z}/{x}/{y}` のまま |
| 相対の `url`（Maplat の `tiles/…`） | 現行どおり SW の場所を基準に解決する（SW 内の `fetch` の動き）。新 API はページ側で絶対化する |
| エラー文字列 | 1 字も変えない（§9） |

**例外（理由つき）**: 疑似ホストのルート自体は残る。旧 API の利用者は `map.url` を地図ライブラリへ渡しており、これをインタフェース上消せない。ただしそのハンドラは翻訳だけで、キャッシュの処理を持たない。旧 API の範囲外の応答（ズーム外 404）は `serve()` の引数の値の差で、分岐したコードではない。

**試験の扱い**。`tests/unit/` の大半は旧 API の契約試験としてそのまま通し続けるが、内部を固定している試験は次のように分ける（`tests/unit/weiwudi-gw-logic.test.ts` の describe 単位）。

| 扱い | 対象 | 内容 |
|---|---|---|
| 残す | `handlerCb`・`checkAttributes`・`add xyz`・`add wmts`・`add cacheMaxBytes`・`info`・`getImage` の各群・`putItemWithEviction`・`countDB・stats`・`clean`・`delete`・`cancel`・`cache`・`fetchAll の入口`・`登録の DB を最初に開く API（#47）`・`tests/unit/add-cachemaxbytes.test.ts` | 入出力は変えない。AC は「m2 で差分なし」 |
| 書き換える | `Weiwudi_Internal の初期化` の :40・:48 | `registerRoute` 1 回の前提をやめ、`sw-harness.ts` と一緒に 4 本（§4.3）へ直す。`capture` は旧 API のルートの正規表現を指す。`createSwHarness()` は同期のまま旧 API のハンドラを返す（他の試験を変えない）。門番を試す試験だけが microtask を待ってから `registerRoute` の呼び出しを見る |
| 書き換える | :56・:67 の install・activate のリスナ | リスナを増やさないので通るはず。`BroadcastChannel` はハーネスで差し替える |
| 書き換える | `store の無い DB の修復` の :553・:563 | 対象を `Weiwudi` から `WeiwudiStore` へ移し、`store.ts` の試験にする（別接続の開き直し・`blocked` で止まらない）。「store が無ければ版を上げる」がなくなるので版の検査は落とす |
| 書き換える | :544 | `clean` の `NotFoundError` は公開の挙動として残さない（§9）。`map-not-found` を確かめ、`add` の後の保存が動くことは残す |
| 移す | :526・:535・:575 | 移行の試験へ。旧 `Weiwudi` が store を持たなくても移行が空で完了して `add` が通ること、旧 DB が `blocked` でも `delete` は成功し、旧 DB の削除は次の起動へ回ること |
| 退役 | 旧 `Weiwudi` の版が 2 であることの検査 | 旧 DB を修復しなくなるので意味を失う |

`前提: fake-indexeddb の Blob の往復` は残す。`tests/e2e/cache.spec.js` の `should evict…` は IndexedDB の `tileCache` を直接読むので、公開 API の確認へ書き換える（内部の形は公開の約束ではない）。

**載せ替えの時期**: state は「旧 IF の上乗せ」を m4 に置いているが、**載せ替え自体を m2 の最後へ前倒しする**（§16）。旧 API の試験 595 行が新コアの最良の検証になり、二重実装の期間も短くなる。

**非推奨**: 本サイクルでは旧 API を非推奨にしない。利用側 3 製品がまだ `registerMap` を呼んでおり、Maplat#254 の対応前に実行時警告を出すと、利用者のコンソールに対処できない警告が並ぶ。Maplat#254 の完了後のトレインでリリースポリシー §9.1 の手順に入り、次の major（2.0）で消す。

## 14. 版と移行

### 14.1 版

**minor（`feat:`）で足す。** 公開 API は追加だけで、旧 API の入出力は §9 の既知の変化を除いて変わらない（文面の保証は §9。上流への取得も `fetch(URL の文字列)` のままで、同一オリジンの Cookie を送る現行の動きを保つ。§4.5）。リリースポリシー §5.3 の「新機能はマイナーで先行投入」に当たる。`next` ブランチも `feat!` も使わない。

- `Weiwudi_Internal` の引数の型は変わる（§4.3）。第 1 引数が広がるので、`(capture: RegExp, …)` の自作関数を渡す TypeScript の利用者には型エラーになる。ただし `package.json` の `exports` は `weiwudi_gw_logic` を公開していないので、公開 API の変更ではない。Workbox の `registerRoute` はそのまま渡せる
- `peerDependencies`（`workbox-routing`）は変えない。実行時依存も増やさない
- MaplatCorePro の `1.0.0` 固定は影響を受けない
- SW の差し替えは `skipWaiting`＋`clients.claim` なので、旧ページが新 SW に当たる。旧 API を残すので動く。新ページが旧 SW に当たる窓は `sw-outdated`（§12）

### 14.2 既存キャッシュの移行

**捨てない。** `fetchAll` で地図を落としてオフラインで使っている利用者には、キャッシュが資産である。試作の「失敗したら旧データを消す」は採らない。

- 移行の単位は地図で、`kv` に地図ごとの状態（`pending`・`copying`・`done`・`failed`）を持つ
- 旧 DB は `indexedDB.databases()` で有無を確かめてから開く。`open` は無い DB を新しく作ってしまう
- **第 1 段**: `Weiwudi` の `mapSetting` を全件 `sources` へ写す（`kv` の `migration.stage`）。旧 `Weiwudi` が無い、または store が無い（#47 の壊れた DB）なら空で完了する。第 1 段が終わるまで、旧 API の地図の参照は `sources` に無ければ `mapSetting` も見る
- **第 2 段**: 地図ごとに `tileCache` を 200 件ずつ読み、新 DB へ書いてから旧レコードを消す。`tileCache` の無い DB はそのまま `done` にする。DB をまたぐトランザクションは無いので、途中で止まると両方に残るが、キーが同じなので再実行は冪等である。容量は 2 倍にならない
- SW の起動そのものには `waitUntil` を呼べるイベントが無い。**`fetch`（制御・旧 API・照合のルート）を受けたときに、移行が動いていなければ 1 バッチを `event.waitUntil` に結び付けて進める**。`activate` は待たせない（数 GB あるとブラウザに打ち切られる）。止まれば次のイベントで続く
- **移行中の配信は読み通しにする**: 旧 API の地図で新 DB に無ければ、`Weiwudi_<mapID>` を見て、あれば配信して新 DB へ移す。移行の途中でオフラインになっても地図が欠けない
- `epoch`→`fetchedAt`・`accessedAt`（無ければ `epoch`）・`z_x_y`→`z,x,y`・`blob.size`→`size`。`pinned` は 0
- 地図が `done` になったらその地図の `Weiwudi_<mapID>` を、全地図が `done` か `failed` になったら `Weiwudi` を消す（R51）。`onblocked` は次の起動へ回す
- 1 レコードの失敗は飛ばして続ける。地図単位で 3 回失敗したら `failed` にして読み通しのまま残す

**m4-t7 で決めたこと**（計画 docs/superpowers/plans/2026-11-07-m4-range-release-migration.md の m4-t7）:

- 状態は `kv` の `migration` 1 つ: `{ stage: 'pending' | 'settings' | 'tiles' | 'done', maps: [{ mapID, status, lastKey?, recordFailures, batchFailures }], pendingDelete, startedAt, updatedAt }`。`maps` は配列（`mapID` を項目名にしない。`__proto__` で壊れない）。`stage` が `done` になったらメモリにも覚え、以後の契機で IndexedDB を読まない
- R17: 旧 DB の有無は `indexedDB.databases()` で見る（名前が `Weiwudi` か `Weiwudi_` で始まるもの）。無い環境（古い Firefox）では版なしで開き、自分で作ってしまった空の DB は閉じてから消す。旧 DB は使うたびに開いて閉じ、`onversionchange` でも閉じる。`deleteDatabase` の前に必ず自分の接続を閉じる
- R18: 移行中の読み通しは `legacy.getImage` が `serveTile` の前に `migrate.pullTile` を呼ぶ形（旧にあれば新へ移してから `serve`）。配信の経路は `core.serve` 1 つのまま
- R19: `mapID` に `\0` があれば `add` で `Error: MapID must not contain a NUL character` の文字列で拒否する（§9 の既知の変化）。移行では `failed` にして旧 DB に残す
- R50: `migrate.ts` は §3 のとおり `store`・`constants`・`errors` だけを import し、地図の登録（`legacy.registerMap`）と退避の範囲（`core.evictScopesFor`）は `MigrateDeps` として受ける（`legacy.migrationDeps`。配線と `legacy` の中の呼び出しが同じものを渡す）。旧レコードを消すのは `putEntry` が `saved: true` のときだけ。`saved: false` のときは Resource の有無を見て、無ければ残す（バッチを止めて `batchFailures` に数える）・有れば落とす（単体で上限を超える・上限が 0 で、新しい規則でも保存されない）
- R51: 第 1 段（`mapSetting` の `getAll` 1 回。既に `sources` にある地図は上書きしない。`mapSetting` に無い `Weiwudi_<mapID>` はその場で消す）は共有の Promise にして、旧 API のハンドラ（`ping` を除く）が待つ。第 1 段が失敗したら待ちは捨てて進み、地図の参照は `mapSetting` も見る。第 2 段は地図ごとの `lastKey` の次から読み（`IDBKeyRange.lowerBound(lastKey, true)`）、失敗はレコードの数（`recordFailures`。数えるだけ）とバッチの開始の数（`batchFailures`。Resource の無いバッチの停止も数える。3 で `failed`）に分ける。地図が `done` になったらその場で `Weiwudi_<mapID>` を消し、`Weiwudi` は全地図が `done` か `failed` になってから消す（`blocked` なら `pendingDelete` に足し、SW の起動後の最初の契機で消し直す）。旧 API の `clean`・`delete` は、その地図を「忘れた地図」に入れて状態を `done` にし（`delete` は `maps` から外す）、進行中の `migrateStep`・その地図の `pullTile` を待ってから新 DB を消し、`Weiwudi_<mapID>` を消す
- R59: `stage` が `done` でも、SW の起動後の最初の契機で 1 回だけ `databases()` を見て、旧 DB（`pendingDelete` と `failed` の地図のものを除く）があれば移行をやり直す（1.1.x に戻している間に作り直された旧 DB）。**既知の制約**: `databases()` の無い環境ではやり直さない
- R60: 移行の途中の旧 API の `fetchAll`・`stats` は新 DB だけを見る（`fetchAll` に読み通しを通さない）。`fetchAll` はまだ移していないタイルをオンラインなら取り直し、`stats` の `percent` は一時的に低く出る

**戻した場合**（1.1.x へ）: 旧版は空の DB から動く。キャッシュは取り直しになるが壊れない。

新 DB は本体を ArrayBuffer で保存する（§5.2。m3-t10）。旧 DB の `Blob` は移すときに ArrayBuffer にして書く。WebKit の非永続の保存領域でも保存できる。

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
| m1 | 本書・#32・#34・#33 |
| m2 | `store.ts`（#37）・`url_pattern.ts`・`core.ts` の `serve()`・`hook.ts`（§4.3 のルート）・`upstream.ts`（§4.5・§4.6）・`control.ts`・`plugins.ts`（#36）・**`registry.ts`（§5.6。m3 から前倒し）**・`raster`・**`vector`**の登録・**汎用の資格情報（§10 のうち提供元を除く）**・**旧 API の載せ替え（§13）**。WebKit・Firefox は測らない（m2 計画の R14）。計画は `docs/superpowers/plans/2026-11-03-m2-core.md` |
| m3 | スタイルの芋づる登録（§5.5）・`asset`・グリフの結合（#39）・`providers/mapbox.ts`（#40）・資源単位の削除と提供元別の使用量（#38） |
| m4 | 範囲取得と解放・保持（§7）・**旧 DB からの移行（§14.2）**・#41・文書・master への合流 |

m2 の最後から m4 の移行までの間、`vector-cache` は既存キャッシュを読まない。公開前のブランチなので問題にならないが、**移行の無い状態で master へ入れてはならない**（m4 の合流の条件にする）。

外へ出る API なので、m1 の t3（`WeiwudiError` の追加）と m2・m3 の区切りのレビューに水準 2（別ベンダーの AI）を含める（軽い道 §4）。

## 17. 人間の判断

好みと方針でしか決まらない点だけを挙げる。どちらも止まらずに推奨案で進められる。

1. **`mapbox://` の扱いを標準で載せるか**
   - Mapbox の利用規約はオフライン保存を制限している可能性があり、規約の確認なしに断定できない
   - 推奨: #40 の完了条件どおり標準で載せる。範囲取得も止めず、README に「提供元の規約の確認は利用者の責任」と書く
   - 別案: `providers/mapbox.ts` を配布物から外し、`addProvider` の例として文書にだけ載せる
2. **旧 API を非推奨にする時期**
   - 推奨: §13 のとおり Maplat#254 の完了後のトレイン。それまで 2.0 の予定を立てない
   - 別案: 新 API の公開と同時に JSDoc の `@deprecated` だけ付ける（実行時の警告は出さない）。ただしリリースポリシー §9.1 は 3 点セットなので、ポリシーの例外になる
