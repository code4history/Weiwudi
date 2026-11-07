# m4 実行計画: 範囲取得と解放・保持期間・移行・#41・master への合流

- 日付: 2026-11-07（設計担当の初版）・同日に事前点検 第 1 回（S 4・M 15・L 18）を反映（第 2 版。末尾の「事前点検 第 1 回の反映」）/ サイクル: weiwudi-vector-cache（軽い道）
- 点検の番号は m3 と同じく出どころを付けて書く（「第 1 回 S1」「X1」など）。m3 の番号は「m3-t4 の申し送り」「m3 Ruling R7」のように書く
- 仕様: `docs/superpowers/specs/2026-11-02-new-interface-spec.md`（以下「仕様」）。該当は §4.5-3（範囲取得の CORS）・§4.6（範囲取得の認証）・§7（保持・範囲取得・解放）・§9（エラーと旧 API の既知の変化）・§11（グリフの束ね書き）・§12（`setLimits`・`estimate`・`fetchRange`・`releaseRange`・`regions`・`cancel`・`clean(range)`）・§14（版と移行）・§16
- 起点: m3 の完了後の `vector-cache` の `f6189a0`（m3-t10 と区切りの直し #95・#97・#99 が合流済み。単体試験 1367 passed・Chromium の e2e 46 passed・CI の WebKit 29 passed）。計画を書いた時点は `c5712bf`（m3-t9 まで）。事実の表の行番号は第 1 回の反映で `f6189a0` に合わせ、F25〜F36 を足した。各タスクは 1 PR で `vector-cache` へ入れる
- **`<BASE>`** は、そのタスクの分岐点（`git merge-base HEAD origin/vector-cache`）を指す
- 拘束入力: m3 の計画（書式）・m3 の台帳（`.superpowers/sdd/2026-11-04-m3-vector/progress.md`）の「m4」宛ての申し送り・state の `m4.carried_from_precheck`（m1 第 6 回 O-3・m2 R20・m1 のまとめの「m4 への申し送り」・m2 R13・R15・m2-t2 水準 1 Minor 1）と `m4.carried_from_implementation`（10 項目）・state の `branch_policy.merge_condition`（移行が無い状態で master へ入れない）
- 台帳: `.superpowers/sdd/2026-11-07-m4-range-release-migration/progress.md`（進行役が作る）

## 範囲

| 入れる | 仕様 | Issue・出どころ |
|---|---|---|
| 保持期間（`cacheRetention`）の掃除 | §7.1 | #9 の「キャッシュ期間管理」 |
| 範囲取得 `estimate`・`fetchRange`・`regions`・`cancel`・ジョブの再開（`job/resume`）・イベント（`proceed`・`finish`・`stop`・`canceled`・`opaque`） | §7.2・§4.5-3・§4.6・§12 | #42・m2 R13・R20 |
| ベクタの範囲取得（スタイルの子: スタイル・TileJSON・スプライト 4 種・グリフの束ね書き・タイルの交差） | §7.2・§11 | #39・#42 |
| 解放 `releaseRange`・範囲つき `clean(range, { force })`・`clean()` での regions の削除 | §7.2 | #42・m1 第 6 回 O-3 |
| 全体上限 `setLimits({ maxBytes })`・`QuotaExceededError` の再試行 | §7.1 | m2 R15 |
| 旧 DB（`Weiwudi`・`Weiwudi_<mapID>`）からの移行と削除・移行中の読み通し | §14.2 | state の `merge_condition` |
| 開発用ページ（`index.html`）を新 API に直す | — | #41 |
| m3 の台帳と state の m4 宛ての申し送りの全件（下の表） | — | — |
| 文書の総仕上げと `vector-cache` → `master` の合流 | §14.1・§16 | state の `branch_policy` |

入れないもの: **Issue #78（Range 要求の区画単位のキャッシュ）は m4 の後**。m4 では「#78 を邪魔しないこと」を 1 節で確かめるだけ（下の節）。state の申し送り「Range の素通しに資格情報を足すか（PMTiles・COG と一緒に。#78）」も #78 へ送る。旧 API の非推奨（m3 R12）・`usage()` への `estimate()` の値（m3 U4）・MapLibre を依存に足すこと（m3 R15）も入れない。公開（npm）は合流後の次の月次トレインで、m4 では版番号を変えない（R26）。

## 先に確かめた事実（2026-11-07・設計担当。初版は `c5712bf`、第 1 回の反映で `f6189a0` の src・tests を読み直し、行番号を合わせた）

| # | 事実 | 出どころ |
|---|---|---|
| F1 | `WeiwudiStore` には `regions`（keyPath `id`・索引 `sourceId`）と `kv`（keyPath `key`）のストアが既にあり、`deleteSource` は同じ tx で `credentials` と `regions`（`sourceId`）も消す。`entries` の索引は `[resourceId, pinned, accessedAt]`・`[pinned, accessedAt]`・`[pinned, fetchedAt]`・`[resourceId, z]` の 4 本。`regions` に書く API はまだ無い | `src/store.ts:353-375`・`:614-620` |
| F2 | 固定の競合: `core.save` は上流を待つ前に読んだ `savedPinned` を `meta.pinned` に入れ、`commitEntry` は tx の中で読んだ `old` の `pinned` を見ずに `meta.pinned` を書く。`putGlyphParts` も `...meta` で同じ | `src/core.ts:389-394`・`:476-504`、`src/store.ts:544-603`・`:741-747`（m3-t4 の申し送り） |
| F3 | 上限を超えた結合レコード: `commitEntry` の `willSave = evict.every((e) => e.maxBytes > 0 && newSize <= e.maxBytes)` で、`putGlyphParts` の `newSize` は連結後の `joined.byteLength`。結合レコードが `cacheMaxBytes` を超えると新しい範囲は保存されない | `src/store.ts:555`・`:734-747`（m3-t4 の申し送り） |
| F4 | 退避の候補は要素ごとに `IX_LRU` の `getAll` で全件読む（予算内でも読む）。候補からは `willSave` のとき同じキー（`old`）を除き、前の要素が消した Entry は同じ tx の後の `getAll` に現れない。Resource の数の差分（`deltas`）は最後にまとめて `resources` へ書く | `src/store.ts:561-577`・`:592-601`（m2-t2 水準 1 Minor 1） |
| F5 | 削除期限は配信の時点でだけ見る（`t - live.meta.fetchedAt > retention` なら無いもの）。掃除は無い。グリフは `liveEntryOf` が部分の `fetchedAt` を使い、期限切れの部分は `bytes` に残る | `src/core.ts:386-398`・`:362-371`（m3-t4 の申し送り・m3 R7） |
| F6 | `core.save` は `evictScopesFor` の失敗を reject で返し、`serve` 全体が reject する。照合ルートの `serveHit` は reject を捕まえて `fetch(request)` で素通しするので、上流へ 2 回出る。旧 API は `Error: ${e}` の本文になる | `src/core.ts:512`、`src/hook.ts:366-367`・`:374-375`、`src/legacy.ts:391-393`（state の申し送り 1・§9） |
| F7 | 旧 API の `fetchAll` は `core.runJob`（5 枚ずつ・`isAlive` は `self.clients.get(client.id)`・`isCanceled` は `job.cancel`）で動き、`ctx.job`（`JobState`: `sourceId`・`label`・`total`・`count`・`error`・`failures`・`cancel`）は 1 つ。`ctx.job` の確かめと確保は await を挟まず同期に行う。イベントは開始の `client.postMessage` で `proceed`・`finish`・`stop`・`canceled` を `mapID` 付きで送る。ジョブは `event.waitUntil` に結び付く | `src/legacy.ts:141-208`・`:363-387`（確保は `:369-381`）、`src/core.ts:524-572`、`src/context.ts:9-23` |
| F8 | `WeiwudiSource` はページの `message` を `data.sourceId === this.id` で選び、`data.type` のイベントとして流す。SW からの新 API のイベントは `{ sourceId, type, ... }` を `postMessage` すれば届く。`opaque` を送る所は無い | `src/weiwudi.ts:277-282`、`src/upstream.ts:161-175` |
| F9 | 制御の op は `register`・`source`・`sources`・`stats`・`update`・`clean`・`remove`・`removeResource`・`usage` の 9 つ。`register`・`update`・`clean`・`remove`・`removeResource` が直列の待ち行列。`post` は `event` を受け、送り手を `fromOwnOrigin(event)` で確かめる。`statsOf` の `count` は Resource の `count`（共有の Resource では範囲の外も数える） | `src/control.ts:387-401`・`:409-425`・`:132-150` |
| F10 | 門番の待ちは `GATE_WAIT_MS = 3000`、やり直しは 1 秒から倍々に 30 秒。`refreshTable` → `tableChanged` → `reload` は読み込み中の Promise を上限なしで待つので、読み込みが終わらないと `register` などの op も待ち続ける | `src/hook.ts:33-36`・`:185-202`、`src/control.ts:156-165` |
| F11 | `WeiwudiError.from` は DOMException の `QuotaExceededError` を `quota`、`BlockedError` を `db-blocked`、それ以外を `internal` にする。制御の失敗は `failure(e)` がこれで分類する | `src/errors.ts:148-152`・`:259-265`、`src/control.ts:48-52` |
| F12 | 旧 API の `add` は `mapID` の文字を検査しない。Entry のキーは `map:<mapID>\0<z>_<x>_<y>`、Resource の削除は `[id\0, id\x01)` の半開区間なので、`\0` を含む `mapID` は別の地図の範囲にかぶる | `src/legacy.ts:39-40`・`:240-299`、`src/store.ts:385-386`（m2-t5 の申し送り） |
| F13 | 旧 DB（1.1.1）: `Weiwudi`（store `mapSetting`・keyPath `mapID`。記録は `/api/add` の query そのまま）と `Weiwudi_<mapID>`（store `tileCache`・keyPath `z_x_y`。記録は `{ z_x_y, headers, blob: Blob, epoch, accessedAt? }`。`accessedAt` は無いことがある）。版は固定しない（`indexedDB.open(dbname)`） | `git show 575e018:src/weiwudi_gw_logic.ts`（:30-37・:109-153・:461-467） |
| F14 | `tests/unit/deps.test.ts` の表は `migrate: ['store', 'constants', 'errors']` と `legacy` の `'migrate'` を既に持つ（m4 で足す前提）。`range.ts` の行は無く、`weiwudi_gw_logic` の「上の全部」（`ABOVE_ALL`）にも `range` が無い | `tests/unit/deps.test.ts:17-44` |
| F15 | テンプレートの展開は `tile_math.expandTileTemplate`（7 字句。`{fontstack}`・`{range}`・`{spriteSuffix}` は展開しない）。照合は `url_pattern.compileTemplate`・`matchUrl`、キーは `entryKey(resourceId, type, m, url, credentialParams)`。範囲取得が URL から Entry のキーを作る道はまだ無い | `src/tile_math.ts:110-128`、`src/url_pattern.ts:267`・`:407`・`:465-476` |
| F16 | `StyleSpec.fonts` は保存だけで使う所が無い（文書も「`fonts` is only saved in this version」）。`style_body` は `layout.text-font` を集めない | `src/spec.ts:95`・`:521-542`、`docs/api/weiwudi.md:296`、`grep -c text-font src/style_body.ts` が 0 |
| F17 | 開発用ページ `index.html` は旧 API（`registerSW('./demo-sw.js')`・`registerMap('osm_demo', { type: 'wmts', … })`・`fetchAll()`・`clean()`・`stats()` の 2 秒ごとの表示）で、Leaflet 1.9.4 を unpkg から `integrity` 付きで読む。`public/demo-sw.js` は `./workbox/workbox-sw.js` と `./weiwudi-sw.js` を `importScripts` する。`build:demo` は CI で走る（`vite.config.demo.js` → `dist-demo/`）。README の英日に画面写真は無い（`.png` の参照はテンプレートの例だけ） | `index.html`、`public/demo-sw.js`、`.github/workflows/ci.yml`、`grep -n -E '\.(png|gif|jpg)' README.md` |
| F18 | 単体試験のハーネスは `post(path, body, { client })`・`waitUntilCalls`（偽の `FetchEvent.waitUntil` に渡した Promise）・`listeners`（`self.addEventListener` の種別ごと）・`client.postMessage` の記録を持つ。`legacy-routes.test.ts:60-67` は `self` のリスナが `['activate', 'install']` だけで、`Weiwudi_Internal` の呼び出しで IndexedDB を開かないことに加え、**`/api/ping` を送っても `indexedDB.open` を呼ばない**ことまで固定している（第 1 回 S3） | `tests/unit/sw-harness.ts:83-113`・`:268-280`、`tests/unit/legacy-routes.test.ts:60-67` |
| F19 | WebKit では `context.setOffline` がページの `fetch` を先に止めるので SW の取得を測れない（§2 の 7）。m3-t10 は Chromium だけで成り立つ e2e に `@chromium-only` のタグを付け、WebKit の project を `grepInvert` で分ける方式 | 仕様 §2・m3 計画 t10・`m3-t10-webkit-ci` の枝 |
| F20 | m3 の完了（f6189a0）の実測: 単体試験 1367 passed・Chromium の e2e 46 passed・WebKit 29 passed・Firefox 29 passed（CI） | m3 のまとめ |
| F21 | m3-t10 で、bodies に置く形が `StoredBody`（`data: ArrayBuffer`・`type`）に替わった。Blob との変換は store.ts に閉じ（入口は `readBlob`・読み戻しは `fromStoredBody`）、Store の呼び出し側（`EntryBody.blob`）は Blob のまま。Blob を持つ古い形のレコードは miss として作り直す。`hasEntries` は本体が今の形で読めることまで確かめる（タイルごとに本体を 1 回読む。下の「前提」） | `src/store.ts:10-11`・`:126-149`・`:670-677`・m3 の台帳の t10 の節 |
| F22 | `legacy-store-repair.test.ts` は旧 DB を `fake-indexeddb` の `IDBFactory` で作って残す書き方を持つ（store の無い version 1 の DB・閉じない接続）。移行の試験はこの書き方を使える | `tests/unit/legacy-store-repair.test.ts:19-40` |
| F23 | `latToMercY(90)` は有限の値（m1 のまとめ）。`lngLatBoundsToTileBox` は丸めを持たず、緯度の限界は `spec.ts` の `MERC_MAX_LAT = 85.0511287798066` にある | `src/tile_math.ts:10-26`、`src/spec.ts:109` |
| F24 | 保存と合成で落とす 4 ヘッダ `DROPPED_HEADERS` は `core.ts` のモジュール定数（export していない）。移行（`migrate.ts`）は `core` を import できない（§3） | `src/core.ts:81`・`:96` |
| F25 | `core.serve` は同じキーの同時要求を `ctx.inflight` で 1 本にまとめ、まとめの鍵（`flightKey`）は `key`（グリフは範囲つき）と `revalidate` だけで、`pin` などの差を見ない。相乗りした要求は先の要求の `ServeInput` で保存される。hit（§6 の 2）は `save` を通らない | `src/core.ts:310-329`・`:413-417`（第 1 回 S2） |
| F26 | 疑似ホストの GET のうち `/v2/` は `control.get` へ行き、答えるのは `/v2/ping` だけ（ほかは 404。IndexedDB を開かない）。旧 API の `ping` は `Implemented` を返すだけで store を開かない | `src/weiwudi_gw_logic.ts:42-45`、`src/control.ts:404-407`、`src/legacy.ts:229-231` |
| F27 | `legacy.ts` は `core`（`passThrough`・`runJob`・`serve`）を import する。`registerMap`・`resourceOf` は `legacy.ts` の非公開の関数で、`evictScopesFor` は `core.ts` にある。§3 の表で `migrate` は `store`・`constants`・`errors` だけを import でき、`legacy` が `migrate` を import する側なので、`migrate` から `legacy`・`core` は import できない | `src/legacy.ts:17`・`:55-92`、`src/core.ts:271-301`、`tests/unit/deps.test.ts:39-40`（第 1 回 S4） |
| F28 | `ServeInput` を作るのは `hook.serveResource` だけ。任意の指定 `ServeResourceOptions` は `revalidate`・`credentialSourceId`・`parent` の 3 つで、`pin`・`collect` は無い。資格情報の選び方（`credentialsFor`。照合表の `credentialSources` の Resource × オリジン）は export されておらず、`serveHit` は同じ表から `credentialSourceId` も引いて渡す（style・tilejson の本体の除去の親。O-N3） | `src/hook.ts:218-247`・`:323-354`・`:357-377`（第 1 回 M4） |
| F29 | `putEntry` の `{ saved: false }` は「Resource が無い（書き込みを捨てる）」と「`willSave` が偽（単体で `maxBytes` を超える・`maxBytes` が 0）」の 2 つで、呼び出し側は見分けられない | `src/store.ts:688`・`:555`・`:602`（第 1 回 M5） |
| F30 | `deleteResource` は Resource を読まずに消す（数を差し引く前の値が無い）。`clearEntries` は読んでから 0 にする | `src/store.ts:648-652`・`:653-659`（第 1 回 M13） |
| F31 | スタイルの子の Resource の `sourceIds` は子 Source の id（`registerStyle` が子ごとに `apply` する）。子 Source の記録は `kind: 'child'`・`parentId`（親のスタイルの id）を持ち、`evictScopesFor` は子を親に読み替える。利用者が `fetchRange` を呼ぶのは親（`WeiwudiSource` は子を見せない）なので、region の `sourceId` は親の id になる | `src/style.ts:255-260`、`src/core.ts:283-287`、`src/control.ts:58`（第 1 回 S1） |
| F32 | `matchUrl` は `{-y}` の値を `y = 2^z − 1 − 値` に直して `MatchResult.y` にする（`{y}` は URL の値のまま）。登録の `extent.box` は Source の scheme の座標（`bounds` は XYZ で作り、`tms` なら反転する）で、照合の y と同じ座標。`expandTileTemplate` は `{-y}` を y から作る | `src/url_pattern.ts:375-381`、`src/spec.ts:358-361`、`src/tile_math.ts:117-127`（第 1 回 M9） |
| F33 | 持ち主の一覧（スタイルは子と孤児の子）は `control.ownerIdsOf`（`style.styleChildIds`・`ownersOf`）、排他の判定は `registry.isExclusiveTo`。どちらも `control` が import している | `src/control.ts:89-90`・`:26-28`、`src/style.ts:475-484`、`src/registry.ts:166-171`（第 1 回 M4） |
| F34 | `hook.withTimeout` は export していない | `src/hook.ts:179-182` |
| F35 | 古い形（Blob を持つ）のレコードを前提にした既存の試験は 2 件: `store.test.ts:860-873`（`hasEntries` が `false`）と `legacy-store-repair.test.ts:43-92`（`fetchAll` が古い形を取り直す） | 各ファイル（第 1 回 M3 の 2） |
| F36 | `putGlyphParts` はレコードの `fetchedAt` を最も新しい部分の値にする。グリフの部分の位置と `fetchedAt` は本体（`StoredBody.parts`）にあり、メタには無い | `src/store.ts:741-747`・`:91`（第 1 回 M2） |
| F37 | `runJob` は `isAlive`・`isCanceled` をバッチの前にだけ見て、始めたバッチの `run` は全部終わるまで待つ | `src/core.ts:559-566`（第 1 回 M15） |

## 前提: m3-t10 の後の store の本体

m3-t10 で、bodies に置く形が **`StoredBody`（`data: ArrayBuffer` と `type`）** に替わった（WebKit とプライベートブラウズで IndexedDB に Blob を保存できないため）。Store の呼び出し側の `EntryBody.blob` は Blob のままで、変換は store.ts の中だけで行う。本計画の次の箇所はそれを前提にする。

- t1 の `putGlyphParts` の直し（部分の詰め直しは ArrayBuffer の `slice` と連結で行う。Blob の `slice` ではない）
- t4 のグリフの束ね書き（集めた部分は ArrayBuffer）
- **t7 の移行（§14.2）**: 旧 `tileCache` の `blob`（Blob）は tx の外で `await blob.arrayBuffer()` と `blob.type` に変換してから新 store へ書く（tx の中で IDB 以外の Promise を待たない。m2-t2 の申し送り）。旧 DB を読む tx と新 DB へ書く tx は別の DB なので、もともと 1 つの tx にならない（§14.2「DB をまたぐトランザクションは無い」）。WebKit のプライベートブラウズでは旧 DB の Blob はもともと保存できていなかったので、移す物が無い
- m3-t10 は合流済み（180122b）。`hasEntries` の本体の読み出し（古い形の判定）は、**t1 でメタだけの判定へ戻す**（I12・R43）。古い形（Blob を持つ）のレコードは未公開の `WeiwudiStore` の開発用の DB にしか無い（1.1.1 の利用者は旧 DB だけを持ち、t7 が今の形で新 DB へ書く）。理由は I10・R37 と同じ「未公開」で、t7 の移行（旧 DB → 新 DB）とは関わらない。範囲取得（t3）は既に有るタイルごとに `hasEntries` を引くので、t3 の前に戻す

## 順序と依存

```
t1 保存の土台（固定の競合・退避の走査・結合レコード・store の新しい操作・容量判定の失敗）
 ├─ t2 保持期間の掃除と保守の契機（ctx.maintain）
 │   └─ t7 旧 DB からの移行（§14.2。maintain に乗る）──────────────┐
 ├─ t3 範囲取得の土台とタイルの fetchRange（estimate・regions・cancel・resume・イベント・R13・opaque）
 │   └─ t4 スタイルの範囲取得（子の資源・グリフの束ね書き・fonts）
 │       └─ t5 解放と範囲つき clean（releaseRange・clean(range)・clean() の regions・O-3）
 ├─ t6 全体上限 setLimits と QuotaExceededError の再試行（R15）                │
 └─ t8 制御と門番の堅牢化（申し送りの小さな直しと文書）                      │
                                                                             │
     t9 #41 開発用ページ（t5・t6 の後）                                      │
      └─ t10 範囲取得・解放・移行・全体上限の e2e（t5・t6・t7 の後）◀─────────┘
          └─ t11 文書の総仕上げと master への合流（全部の後）
```

- 並行は 1 本まで。並行してよい組は **t3〜t5 の列と t7**、**t6 と t8** の 2 つ。どちらの組も src の主なファイルは分かれる（t3〜t5 は `range.ts`・`control.ts`・`weiwudi.ts`・`spec.ts`・`url_pattern.ts`・`upstream.ts`・`style_body.ts`・`hook.ts`、t7 は `migrate.ts`・`legacy.ts`。t6 は `store.ts`・`core.ts`・`weiwudi.ts`、t8 は `hook.ts`・`url_pattern.ts`・`spec.ts`・`registry.ts`）が、**次のファイルは両方が触る**: t3 と t7 は `weiwudi_gw_logic.ts`（t3 は `ctx.notify` の 1 行、t7 は `runMaintenance` の `migrateStep` の 1 行）・`context.ts`（t3 は `notify`・`JobState.regionId`、t7 は `maintenance` の項目）・`docs/api` と README の英日（別の節）。t6 と t8 は `control.ts`（t6 は `setLimits` の case 1 つ、t8 は既存の op の直し）・`docs/api` と README の英日。どれも足すだけの差分なので、**後に合流する側が `origin/vector-cache` へ rebase して機械的に解く**（意味の判断が要る衝突になったら並行をやめ、先の PR の合流を待つ）。t3〜t5 と t6・t8 は並行しない（`control.ts`・`weiwudi.ts`・`store.ts` の使い方が重なる）（第 1 回 L）
- t2 は t1 の後（`store` の cursor の操作を使う）。t7 は t2 の後（`ctx.maintain` に移行の 1 バッチを乗せる）
- **公開の外形が変わるのは t2（`cacheRetention` が実際に消すようになる）・t3（`estimate`・`fetchRange`・`regions`・`cancel`・`RangeSpec`・`RegionInfo`・`FetchRangeOptions`・イベント）・t5（`releaseRange`・`clean(range, opts)`・ジョブ中の `clean`・`remove` の `fetch-busy`）・t6（`setLimits`）・t7（旧 DB の移行と `\0` の `mapID` の拒否。旧 API の利用者の見え方）・t8（`warnings` の code 1 つ・`stats` の数え方）・t9（開発用ページ）**。どれも同じ PR で README と `docs/api` の英日を直す（rule-0001）。t9 は rule-0002 の対象になるが、README に画面写真は無い（F17）ので撮り直しは無い
- `deps.test.ts` の表は t1 で m4 の全行（`range` の行・`control` に `range`・`ABOVE_ALL` に `range`）を持たせ、後のタスクは触らない（m3 R27 と同じ）

## 水準 2（別ベンダーの AI）のレビューが要るタスク

| タスク | 理由 | 見る範囲（Codex に渡す。30 分で切り上げ、同じ確認を Claude にも並べて出す。m2・m3 のまとめの学び） |
|---|---|---|
| t3 | `fetchRange`・`estimate`・`regions`・`cancel`（公開）・範囲取得の資格情報と CORS の規則（§4.5-3・§4.6）・ジョブの再開 | `src/range.ts`・`src/upstream.ts` の差分・`src/hook.ts` の差分（`credentialsForResource`・`pin`）・`src/control.ts` の差分・`src/weiwudi.ts` の差分・`docs/api/weiwudi*.md`・仕様 §4.5-3・§4.6・§7.2 |
| t5 | `releaseRange`・`clean(range, { force })`（公開）・固定を外す幾何の判定・`clean()` の regions | `src/range.ts` の差分・`src/store.ts` の差分・`docs/api/weiwudi*.md`・仕様 §7.2 の解放 |
| t6 | `setLimits`（公開）・全体 LRU・`QuotaExceededError` の再試行が旧 API の挙動を変える | `src/store.ts`・`src/core.ts` の差分・`docs/api/weiwudi*.md`・仕様 §7.1・§9 |
| t7 | 旧 DB の移行（オフライン利用者の資産。失っても壊れても気づきにくい） | `src/migrate.ts`・`src/legacy.ts` の差分（`migrationDeps`・第 1 段の待ち・`clean`／`delete`）・仕様 §14.2・`tests/unit/migrate.test.ts` |
| m4 の区切り | 公開 API の差分全体（m3 の区切りの commit から head）と、master への合流の差分（`master..vector-cache`） | README・`docs/api`・`dist/*.d.ts`・CHANGELOG |

t4（スタイルの範囲取得）は t3 と同じ公開 API の続きで、資格情報の配り先は m3-t7 で水準 2 を通した規則をそのまま使うので、区切りの水準 2 で見る。

## 申し送りの拾い先

state の `m4.carried_from_precheck`（P1〜P7）と `m4.carried_from_implementation`（I1〜I13。複合の項目は枝番で分ける）、m3 の台帳の「m4」宛て（L1〜L8）の全件（**38 件**）。後へ送るものは理由を書く。I11〜I13 は m3 を閉じたときに足した 3 件（m3 のまとめの「m4 への申し送り」・state の `milestones[2].carried_from_implementation[10]〜[12]`）で、初版の表から抜けていた（第 1 回 M3）

| ID | 内容（要旨） | 出どころ | 拾い先 | 決めたこと |
|---|---|---|---|---|
| P1 | O-3: 持ち主の Source の削除で範囲だけの region が残る（region は範囲取得と一緒に作る） | m1 第 6 回・state | t3（region の形）・t5 | region は Source に属し、`deleteSource` が同じ tx で消す（F1）。`remove()` と範囲なしの `clean()` は、消す前に `range.releaseAllOf` でその Source の全 region を Resource ごとに R12 の規則で解放する（共有の Resource は固定を外すだけ。範囲だけの Resource に限らない）（R12・R47。第 1 回 M12） |
| P2 | m2 R20: `opaque` イベント | m2 計画・state | t3 | `corslessUntil` を書いた所（照合ルート経由の `countCorsless` と、範囲取得の 5 枚の確かめ）から `ctx.notify` で 1 回だけ送る（R20） |
| P3 | m1 のまとめ: `latToMercY(90)` が有限 | state | t3 | `bounds` の緯度は `MERC_MAX_LAT` に丸めてから `lngLatBoundsToTileBox` に渡す（仕様 §7.2。R28） |
| P4 | m1 のまとめ: master への合流で dist の 4 点を確かめる | state | t11 | 受け入れ条件に 4 つの grep を置く |
| P5 | m1 のまとめ・state の `merge_condition`: 移行の無いまま master へ入れない | state | t7・t11 | t11 の受け入れ条件に「t7 が合流済み」を置く |
| P6 | m2 R13: 範囲取得側の CORS・認証の規則（`jobOpaqueStreak`・5 枚の確かめ・401／403 が 3 回で止める） | m2 計画・state | t3 | `range.ts` のジョブの側で、serve の応答の `x-weiwudi-error` と `upstream.probeNoCors` で判定する（R4） |
| P7 | m2 R15: `QuotaExceededError` の再試行と全体上限／m2-t2 Minor 1: 上限つきの `putEntry` が保存のたびに全件 `getAll` する | m2 計画・m2 台帳・state | t6（再試行・全体上限）・t1（走査の省略） | `bytes − pinnedBytes` で予算内なら走査を省き、超えるときだけ `IX_LRU` の cursor で古い順に引く（R7'）。再試行は全体 LRU で 10% 退避して 1 回（R16） |
| I1a | `serve` が reject すると上流へ 2 回出る（`evictScopesFor` の読み出しの失敗） | m2-t7・state | t1 | `save` が `evictScopesFor` の失敗を `storage` として返し、配信を続ける（§9 に記録済みの形。R-I1） |
| I1b | 容量の判定の読み出しの失敗を `storage` として配信を続ける | m2-t8・state | t1 | I1a と同じ直し |
| I2a | IndexedDB の `open` が終わらないと門番が毎回 3 秒待つ | m2-t7・state | t8（記録のみ） | 直さない。上限越えのたびに `fail()` で間隔が 1→30 秒に延びるので「毎回」ではなく、最悪 30 秒に 1 回 3 秒待つ（F10）。実害の実績なし（m2 台帳）。README の制約には書かない（利用者が制御できない）（R38） |
| I2b | 照合表の読み込みが終わらないと変更の op も待ち続ける | m2-t8・state | t8 | `refreshTable` に門番と同じ上限（`GATE_WAIT_MS`）を置き、超えたら表を捨てて登録は成功にする（今の失敗時と同じ扱い）（R38） |
| I3 | `stats` の `count`・`percent` を「その Source の範囲の中の Entry」で数える | m2-t8・state | t8 | 範囲（`box`）が決まる Source だけ。その Source だけが参照する Resource は範囲外の要求を保存しないので Resource の `count` のまま、共有の Resource と範囲だけの Resource だけを `[resourceId, z]` の索引で z ごとに読んで `box` の中を数える。`percent` は 100 で止める（R41。第 1 回 M14） |
| I4a | control の IndexedDB の失敗を `storage` に分類する | m2-t8・state | t8 | `control.post` の `failure` で、`WeiwudiError` でない **DOMException**（IndexedDB の例外。`QuotaExceededError`・`BlockedError` を除く）を `storage` にする。`TypeError` などは `internal` のまま。`from` 自体は変えない（旧 API の分類を変えない）（R39。第 1 回 L） |
| I4b | `register` の途中で store が失敗したときも照合表を作り直す | m2-t8・state | t8 | `register`・`update`・`remove` が例外で終わるときも `refreshTable(ctx, [])` を 1 回呼んでから投げ直す（R40） |
| I5a | 範囲つきの `clean`・regions の削除 | m2-t8・state | t5 | 仕様 §7.2 の表どおり |
| I5b | `persist()` | m2-t8・state | t3 | ページ側の `fetchRange` が制御の要求の前に `navigator.storage.persist()` を試す（失敗は無視） |
| I5c | ジョブのイベントは `WeiwudiSource` の `message` の受け口を使う | m2-t8・state | t3 | `{ sourceId, type, regionId, … }` を `postMessage`（F8）。終わりの順は「region を書く → `ctx.job` を外す → `postMessage`」で、ページは再開の応答が終わりの `status` ならそれで解決する（R22・R45。第 1 回 M7） |
| I5d | `opaque` イベントと `jobOpaqueStreak` | m2-t8・state | t3 | P2・P6 と同じ |
| I6 | 直列の待ち行列は 1 つの SW の中だけ（同じオリジンの別スコープの SW の同時の登録） | m2-t8・state | t8（文書） | 直さない。`docs/api` の英日に「別スコープの SW からの同時の登録は直列にならない。1 つのスコープで登録すること」を書く（R-I6） |
| I7a | 旧 DB（`Weiwudi`・`Weiwudi_<mapID>`）の移行と削除 | m2-t5・state | t7 | §14.2 のとおり |
| I7b | `QuotaExceededError` の再試行（R15） | m2-t5・state | t6 | P7 と同じ |
| I7c | 旧 API の `mapID` に `\0` が入るとキーの範囲が他の地図にかぶる | m2-t5・state | t7 | `add` で拒否する（新しい文字列 `Error: MapID must not contain a NUL character`。§9 の既知の変化に足す）（R19） |
| I8a | 署名つき URL のクエリ（`X-Amz-Signature` など）の扱い（セキュリティ L-3） | m2 区切り・state | t8（文書） | 直さない。署名の項目は `credentialParams` に挙げなければキーに残り、挙げれば要求ごとに違うキーにならない。README の英日に「署名つき URL は署名の項目を `credentialParams` に挙げる（キーに残さない・同じタイルを 1 つにする）。SW は署名を作れないので、`credentials` で足すことはできない」を書く（R-I8） |
| I8b | `BroadcastChannel` の通知を短い間隔でまとめる（L-5） | m2 区切り・state | t8 | `tableChanged` の `postMessage` を 100 ms でまとめる（R34） |
| I8c | 門番が既定のハンドラより先に受けることを §4.3 と README に書く | m2 区切り・state | t8（文書） | §4.3 と README の英日に 1 文 |
| I9 | Range の素通しに資格情報を足すか（PMTiles・COG と一緒に。Issue #78） | m3-t? 区切り・state | **#78 へ送る** | m4 では素通しのまま。理由: Range 要求の保存の形（区画のキー・ETag）と一緒に決めないと、資格情報だけ足しても素通しの 206 は保存されず、#78 の設計で付け方が変わりうる |
| I10 | 保存済みの `Resource.templates` は合成し直すまで古いまま（PR #83 の L-1 の直しは合成のときだけ） | state | t8（記録のみ） | 作業なし。`WeiwudiStore` は未公開で、1.1.1 の利用者には存在しない。公開前の開発用の DB にだけ残り、`update()`（`applyUpdate` → `recompose`）で直る。台帳に書く（R37） |
| I11 | m3 区切りのセキュリティ点検 L1: スタイルの「同じオリジン」の判定は登録 URL で行い、リダイレクト先（`Response.url`）を見ない | m3 のまとめ・state `[10]` | t8（文書と Ruling） | コードは直さない。資格情報を足す相手は登録 URL のオリジンと提供元に限られ、リダイレクト先には足さない（クエリの資格情報は `Location` に引き継がれず、ヘッダの資格情報は `redirect: 'error'`。m3 R21）。SW が合成した応答の URL は要求の URL なので、ページの地図ライブラリも本体の相対 URL を登録 URL で解決し、SW の子作りと揃う。`docs/api` の英日の資格情報の節に「リダイレクト先が返した本体の中の、登録 URL のオリジンの URL にも資格情報を足す。信頼できない上流へリダイレクトするスタイルの URL を登録しない」を書く（R44） |
| I12 | m3-t10: `hasEntries` は保存済みのタイルごとに本体を 1 回読む（古い形の判定） | m3 のまとめ・state `[11]` | t1 | メタだけの判定（`entries.getKey`）に戻す。古い形は未公開の開発用の DB にしか無い。既存の試験 2 件（F35）は書き換え、台帳に書く。古い形のレコードは、範囲取得・`fetchAll` では「有る」と数えて飛ばし、表示の要求（`getEntry` が miss）で取り直す（R43） |
| I13 | m3 区切りの L2 推奨: `docs/api/sw.md` の `applyCredentials` の説明の整理と、`credentialParams` の既定値の列挙 | m3 のまとめ・state `[12]` | t11 | `docs/api/sw.md`・`sw.ja.md` の `applyCredentials` の節を「いつ呼ばれ・何を足し・何を足さないか」の 3 段に整え、`credentialParams` の既定値（`url_pattern.DEFAULT_CREDENTIAL_PARAMS` の `access_token`・`token`・`key`・`api_key`・`apikey`・`sku`。`src/url_pattern.ts:12-13`）を表にする。受け入れ条件に grep を置く |
| L1 | 固定の値が上流を待つ間に戻る競合（`commitEntry` で `old.pinned` を引き継ぐ） | m3-t4 の台帳 | t1 | `commitEntry` が tx の中で読んだ `old.pinned` と `meta.pinned` の論理和を書く。`core.save` は `savedPinned` を読まない（R6） |
| L2 | 期限切れの部分は `bytes` に残る（R7） | m3-t4 の台帳 | t2 | グリフの Resource（`type: 'glyph'` で `cacheRetention` を持つもの）は `[pinned, fetchedAt]` の cursor に入れず、Resource のキーの範囲で別に回し、`store.pruneGlyphParts(key, before)` が tx の中で部分ごとに期限を見て落とす（全部落ちればレコードを消す）。レコードの `fetchedAt` は最も新しい部分の値なので（F36）、索引の cursor では拾えない（R8・R10。第 1 回 M2） |
| L3 | 上限を超えた結合レコードでは、新しい範囲を保存できない | m3-t4 の台帳 | t1 | `putGlyphParts` は予算を超えるとき古い部分（`fetchedAt` の昇順）から落として収める。新しい部分だけで超えるときだけ保存しない（R7） |
| L4 | 範囲取得のグリフは `putGlyphParts` を使い、同じ範囲が 2 つあるときの後勝ちを試験する | m3-t7 の台帳 | t4 | `core` の `GlyphCollector` が 1 fontstack 分を集め、`putGlyphParts` で 1 回書く（R-G） |
| L5 | 直列の待ち行列で上流を待つので取得の上限を検討（R34） | m3-t7 の台帳 | t8（Ruling と文書） | 上限を置かない（R14）。`docs/api` の英日の R34 の文に理由を 1 文足す |
| L6 | 取り直しと除去で `credentialParams` がずれる件（L1 i-2）と R3 で残した子の資格情報（L1 i-3）は実害なしとして記録 | m3-t7 の台帳 | t8（記録のみ） | 作業なし。台帳に「m3-t7 の記録どおり実害なし」と書く |
| L7 | `Bearer` の剥がしの不一致（`spec.isSecretToken` は `Bearer`・`Token`・`Basic` を剥がして `sk.` を見るが、`url_pattern.restQuery` の `isSecretPair` は剥がさない） | m3-t3 の台帳（L2 推奨） | t8 | 判定を `url_pattern` の 1 関数にし、`spec` が import する（`spec` は `url_pattern` を import できる。§3）（R35） |
| L8 | 独自名の資格情報に警告を出す | m3-t3 の台帳（L2 推奨） | t8 | テンプレートのクエリで、`credentialParams` に無い名前の値がトークンの形（`^(pk|sk|tk)\.`）なら `warnings` に `credential-undeclared: <名前>`（値は書かない）。公開の code を 1 つ足す（minor）（R36） |

m4 の後へ送るもの: I9（#78）だけ。38 件のうち作業なしで台帳に書くだけのものは I2a・I10・L6 の 3 件。

## 全タスク共通

**環境**: m1〜m3 で用意したもの（`node_modules`・除外済みの `pnpm-workspace.yaml`）を使う。`pnpm-workspace.yaml` は消さない。**手元では `playwright install` をしない**（共有キャッシュを触らない。手元の e2e は Chromium だけ。WebKit は CI の `e2e-engines`）。

**試験のコマンド（合否判定に rtk を使わない）**

```
pnpm -C /Users/kochizufan/zcode/weiwudi-work/Weiwudi run test:unit
pnpm -C /Users/kochizufan/zcode/weiwudi-work/Weiwudi run typecheck
pnpm -C /Users/kochizufan/zcode/weiwudi-work/Weiwudi run build
pnpm -C /Users/kochizufan/zcode/weiwudi-work/Weiwudi exec playwright test --project=chromium --reporter=list
cd /Users/kochizufan/zcode/weiwudi-work/Weiwudi && node_modules/.bin/eslint "src/**/*.ts"
```

（e2e は `build` の後に走らせる。`public/weiwudi-sw.js` は build で作られ、commit されている版は古い。m3 の台帳の運用の記録）

**全タスクの受け入れ条件に含むもの**

- 上の 5 コマンドがすべて exit 0
- `git diff --name-only <BASE>..` に、タスクの「対象ファイル」以外が無い（文書の直しは対象ファイルに書いたものだけ）
- `git diff --quiet <BASE>.. -- pnpm-lock.yaml package.json` が exit 0（依存を足さない。m3 R15。t11 の CHANGELOG は `package.json` を触らない）
- `grep -rnE '\.(skip|only|todo)\(' tests/unit tests/e2e` が 0 件（Chromium 限定は m3-t10 のタグ `@chromium-only`）
- `dist/` と `public/weiwudi-sw.js` は PR に含めない（commit の前に `git restore dist public/weiwudi-sw.js && git clean -fdq dist`）
- 依存の決まりは仕様 §3 の表だけが正本。`tests/unit/deps.test.ts`（t1 で m4 の行を足す）と `tests/unit/module-state.test.ts`（モジュール変数は `plugins.ts` だけ。ページ側の `weiwudi.ts` は除外済み）が exit 0
- **二重実装を作らない**: 配信は `core.serve()` 1 つ（範囲取得のタイル・スタイル・TileJSON・スプライト・グリフも通る）、`ServeInput` を作るのは `hook.serveResource` 1 つ（範囲取得も使う）、資格情報の選び方は `hook.credentialsForResource` 1 つ（照合ルートと範囲取得が共有。t3）、地図の登録は `legacy.registerMap` 1 つ（移行は `MigrateDeps` で受ける。t7）、上流へ出すのは `upstream.ts`（範囲取得の no-cors の確かめもここ）、Entry のキーを作るのは `url_pattern.entryKey` 1 つ（範囲取得は展開した URL を同じテンプレートに照合して `MatchResult` を得る。R2）、素通しは `core.passThrough` 1 つ、Entry の退避は `store.commitEntry` 1 つ（全体上限も同じ関数の要素）、旧 API（`legacy.ts`）のキャッシュの処理は増やさない（移行の読み通しは `migrate.ts` の 1 関数を `serveTile` の前に呼ぶだけ）
- 既存の試験を書き換えた行は台帳に書く（m3 と同じ）

**実装担当への申し送り（事前点検 第 1 回。指摘とは別）**

- t1 の cursor の併合は tx の中で IDB の要求以外を await しない形で書く。`req2p` は 1 回で解決する Promise なので、cursor は `continue()` のたびに同じ要求の次の `success` を待つ小さな補助（`cursorStep(req)`）を store.ts の中に置く
- 移行の旧 DB の接続は `deleteDatabase` の前に必ず閉じる（`onversionchange` でも閉じる）。旧 DB の `headers` は名前を小文字にしてから `DROPPED_HEADERS` と `x-weiwudi-*` を落とす（`core.copyHeaders`・`isDropped` と同じ規則。t1 で `constants.ts` へ移した `DROPPED_HEADERS`・`OWN_PREFIX` を使う）
- `upstream.probeNoCors` は資格情報を付けずに出す（区切りのセキュリティ点検の項目）。no-cors の結果は保存しない
- `/v2/job/resume` は `url.pathname.slice(V2_PREFIX.length)` で `job/resume` になるので、`run` の `case` はその文字列で書く
- t10 の `ServiceWorker.stopAllWorkers` の試験は Chromium だけ（`@chromium-only`）。WebKit の `setOffline` の制約（F19）にも当たる
- 手元で `playwright install` をしない・合否判定に rtk を使わない（上の共通の規則）は、委任の文にも書く

---

## m4-t1: 保存の土台の直し（L1・L3・P7 の走査・I1a・I1b・I12・store の新しい操作）

コミット種別: `fix:`（内部。公開の挙動が変わるのは I1 の `storage` の配信だけで、§9 に記録済み）

### 対象ファイル

`src/store.ts`・`src/core.ts`・`src/constants.ts`（`DROPPED_HEADERS`・`OWN_PREFIX` を移す）・`tests/unit/store.test.ts`・`tests/unit/core.test.ts`・`tests/unit/glyph.test.ts`・`tests/unit/constants.test.ts`（追記のみ）・`tests/unit/deps.test.ts`（m4 の全行）・`tests/unit/legacy-storage-failure.test.ts`（I1 で結果が変わる行があれば書き換え、台帳に書く）・`tests/unit/legacy-store-repair.test.ts`（I12 の書き換え 1 件。台帳に書く）・仕様 §3（表に `range.ts` の行）・§9（I1 の既知の変化を「m4 で直した」に）

### 作るもの

**固定の競合（L1・R6）**: `commitEntry` は `pinned: meta.pinned === 1 || old?.pinned === 1 ? 1 : 0` で書き、`count`・`bytes`・`pinnedBytes` の差分もその値で数える。`core.save` は `savedPinned` を読まず、`meta.pinned` は `input.pin === true ? 1 : 0`（`ServeInput.pin?: boolean` を足す。t3 の範囲取得が `serveResource` の指定から真を渡す。通常の配信は偽）。`putGlyphParts` も同じ規則（`next.pinned` を `commitEntry` に任せる）。`ServeInput.pin` は「保存と同じ tx で固定する近道」で、固定の正本はジョブ側の `setPinned`（t3 の手順 4。`ctx.inflight` の相乗りと hit では `save` を通らないため。F25・第 1 回 S2）。

**上限を超えた結合レコード（L3・R7）**: `putGlyphParts` は、連結後の大きさが要素のどれかの `maxBytes` を超えるとき、**残す部分を `fetchedAt` の昇順に落として**収める（新しい部分は落とさない）。新しい部分だけで超えるときだけ `{ saved: false }`。退避の規則そのもの（`commitEntry`）は変えない。

**退避の走査の省略（P7・R7'・第 1 回 M1）**: `commitEntry` は要素ごとに、まず予算の見積もり `total` を次の式で作る（tx の中で `resources.get`）:

```
total = Σ_{id ∈ resourceIds}(Resource.bytes − Resource.pinnedBytes)   // 保存済みの固定でない大きさ
      + Σ_{id ∈ resourceIds} deltas[id].bytes                         // この tx で前の要素が消した分（負の値）
      − (willSave && old && old.pinned === 0 ? old.size : 0)          // 置き換える同じキーの古い Entry（今の候補から除く分。F4）
```

（`deltas` の `bytes` は前の要素の退避では固定でない Entry だけを引くので、そのまま足せる。`old` の Resource は `meta.resourceId` で、`evictScopesFor` は要素に必ず入れる。）`total + (willSave ? newSize : 0) <= maxBytes` なら走査しない。超えるときだけ、`IX_LRU` を Resource ごとに `openCursor`（`[id, 0]` から昇順）で開き、**全 Resource の cursor の先頭のうち `accessedAt` が最小（同値はキー昇順）のものを 1 件ずつ消す**（併合。全件を配列にしない）。cursor でも `willSave` のとき同じキー（`meta.key`）は飛ばす（今の `filter` と同じ）。前の要素が消した Entry は同じ tx の cursor に現れない（今の `getAll` と同じ）。消した分は今のとおり `deltas` で数える。t6 の全体上限（`resourceIds` 無し）も同じ関数で、索引を `[pinned, accessedAt]` に替え、`total` の初めの値を `kv.totals` から作るだけ。

**容量判定の読み出しの失敗（I1a・I1b・R-I1）**: `core.save` は `evictScopesFor` を `try` で囲み、失敗したら `'storage'` を返す（保存しない・配信は続ける・`x-weiwudi-error: storage`）。`serve` が reject する道は store の `getResource`・`getEntry` の失敗だけになる（m2 R3 のまま）。仕様 §9 の「保存の前の容量の判定…包括の `Error: ${e}` の本文を返す」の項を「m4 で `storage` として配信を続ける形にした」に直す。

**`hasEntries` をメタだけに戻す（I12・R43）**: `hasEntries` は `entries.getKey` だけで判定し、`bodies` を読まない（m3-t10 より前の形）。古い形（Blob を持つ）のレコードは未公開の開発用の DB にしか無く、範囲取得・`fetchAll` では「有る」として飛ばし、表示の要求で `getEntry` が miss にして取り直す。既存の試験 2 件（F35）を書き換える: `store.test.ts:860-873` の `hasEntries` の期待を `[true, false]` に、`legacy-store-repair.test.ts:43-92` を「`fetchAll` は古い形を飛ばし（上流 0 回）、表示の要求 `/api/cache/x/0/0/0` が取り直して今の形で保存し直す」に。どちらも台帳に書く。

**store の新しい操作**（t2〜t7 が使う。ここで型と試験を決める）

```ts
/**
 * 複数の Entry を同じ tx で消し、Resource の数を直す（200 件ずつ呼ぶ）。tx の中で読んだメタで条件を見直してから消す
 * （unpinnedOnly: pinned === 1 なら残す。fetchedBefore: fetchedAt >= fetchedBefore なら残す）。消した数を返す（第 1 回 M11）
 */
deleteEntries(keys: readonly string[], opts?: { unpinnedOnly?: boolean; fetchedBefore?: number }): Promise<number>;
/** 固定を付ける・外す（同じ tx で pinnedBytes を直す）。無いキーは飛ばす。付けた・外した数を返す */
setPinned(keys: readonly string[], pinned: 0 | 1): Promise<number>;
/** [pinned, fetchedAt] の索引を pinned = 0・fetchedAt < before で古い順に最大 limit 件読む（メタだけ。cursor） */
listUnpinnedBefore(before: number, limit: number, after?: IDBValidKey): Promise<{ metas: EntryMeta[]; next?: IDBValidKey }>;
/** Resource のキーの範囲（entryRange）のメタを最大 limit 件読む（グリフの掃除。t2） */
entriesOf(resourceId: string, limit: number, after?: string): Promise<{ metas: EntryMeta[]; next?: string }>;
/** [resourceId, z] の索引で z の Entry のメタを読む（stats の範囲の数え上げ・解放の幾何） */
entriesAtZoom(resourceId: string, z: number): Promise<EntryMeta[]>;
/**
 * グリフのレコードから fetchedAt < before の部分を tx の中で落として書き直す（空になれば消す。固定のレコードは触らない）。
 * putGlyphParts と詰め直しを共有する（第 1 回 M2・M11）。落とした部分の数を返す
 */
pruneGlyphParts(key: string, before: number): Promise<number>;
/** regions */
getRegion(id: string): Promise<RegionRecord | undefined>;
putRegion(r: RegionRecord): Promise<void>;
/** 1 tx で読み・直し・書き。無ければ何もしない。fn が undefined を返せば書かない（t3 の終わりの書き込み。第 1 回 M7） */
patchRegion(id: string, fn: (r: RegionRecord) => RegionRecord | undefined): Promise<RegionRecord | undefined>;
listRegions(sourceId: string): Promise<RegionRecord[]>;
deleteRegion(id: string): Promise<void>;
```

`RegionRecord` の形は t3 で決める（ここでは `{ id: string; sourceId: string; status: string }` を含む型として置く）。`deleteEntries`・`setPinned`・`pruneGlyphParts` は Resource の `count`・`bytes`・`pinnedBytes` を同じ tx で直す（`commitEntry` の `deltas` の処理を関数に切り出して共有する。C-O7 と同じ考え）。`putEntry` の `{ saved: false }` の 2 つの理由（F29）は戻り値で分けない（既存の試験が `toEqual({ saved: false })` で固定している）。t7 の移行は書く前に `getResource` で Resource の有無を見て分ける（R50）。

**`DROPPED_HEADERS` の置き場（F24）**: `core.ts` の 4 ヘッダの一覧と、自前のヘッダの接頭辞 `OWN_PREFIX`（`x-weiwudi-`。`src/core.ts:89`）を `constants.ts`（import を持たない）へ移し、`core` が import する。t7 の移行が旧レコードの `headers` から同じ 4 つと `x-weiwudi-*` を落とすのに使う（`migrate` は `core` を import できない。§3）。ふるまいは変えない。

**`deps.test.ts`（第 1 回 M4）**: 表に `range: ['hook', 'core', 'upstream', 'registry', 'context', 'store', 'spec', 'url_pattern', 'tile_math', 'style_body', 'constants', 'errors']` を足し、`control` の許可に `'range'` を足し、`ABOVE_ALL` に `'range'` を足す（配線が `range.createNotifier` を import するため）（まだ無いファイルは m2・m3 と同じく飛ばす）。`registry` は `clean(range)` と解放の `isExclusiveTo` に使う。持ち主の一覧（`ownerIdsOf`。スタイルは孤児の子を含む。F33）は `control` が作って `range` の関数に引数で渡すので、`range` は `style` を import しない（R1）。仕様 §3 の表にも同じ行を足す（役割: 範囲の正規化・列挙・ジョブ・region・解放）。`control.ts` の行に `range` を足す。

### 試験

`store.test.ts` への追記（表で書く）:

- 固定の競合（L1）: `putEntry` を `pinned: 0` で呼ぶ前に、同じキーを `setPinned([key], 1)` しておく → 書いた後も `pinned === 1`・`pinnedBytes` が本体の大きさ。逆に `putEntry` を `pinned: 1` で呼ぶと `old.pinned === 0` でも 1
- 結合レコードの上限（L3）: `maxBytes` が 2 範囲分のとき、3 つ目の範囲を足すと最も古い範囲が落ちて `saved: true`・`parts` が 2 つ・`size <= maxBytes`。新しい部分 1 つで `maxBytes` を超えるときは `saved: false`
- 走査の省略（P7）: `IDBIndex.prototype.getAll` の spy が、予算内の保存で呼ばれない。予算を超える保存で候補が `accessedAt` 昇順・同値はキー昇順で消え、今の試験（`退避（putItemWithEviction と同じ規則）`）が差分なしで通る
- 見積もりの式（第 1 回 M1）: (a) 予算いっぱいの Resource で、固定していない同じキーの大きい Entry を小さい本体で置き換える → 何も消えない（古い大きさを引く）。(b) **2 つの要素が同じ Resource を共有する**（2 つの Source が上限つきで同じ Resource を参照）→ 1 つ目の要素が消した分を 2 つ目が二重に消さず、結果が今の `getAll` の実装と同じ Entry の集合（種を固定した 100 回で、今の実装を写した参照の関数と突き合わせる）
- 2 つの Resource をまたぐ要素で、cursor の併合が `accessedAt` の順を守る（A の古い Entry → B の古い Entry → A の新しい Entry）
- `deleteEntries`・`setPinned`・`pruneGlyphParts` が `count`・`bytes`・`pinnedBytes` を全件の集計と一致させる（種を固定した 100 回）
- 条件の見直し（第 1 回 M11）: 一覧を読んだ後に `setPinned([k], 1)` した Entry は `deleteEntries([k], { unpinnedOnly: true })` で残る。一覧の後に取り直して `fetchedAt` が新しくなった Entry は `deleteEntries([k], { fetchedBefore })` で残る。戻り値が消した数
- `pruneGlyphParts(key, before)`: 古い部分だけ落ちて `size` が減る・全部落ちればレコードが消える・固定のレコードは触らない
- `listUnpinnedBefore` が固定を含めず、`before` 未満だけを古い順に `limit` 件、`next` で続きが読める。`entriesOf` が Resource のキーの範囲だけを `limit` 件ずつ読む
- `entriesAtZoom` が z の Entry だけを返す
- regions の 5 操作と、`patchRegion` が無い id で何もしない・`fn` が `undefined` なら書かないこと、`deleteSource` が regions を消すこと（既存の試験の確認）
- `hasEntries`（I12）: 古い形の本体を持つキーで `true`（書き換えた 1 件）・本体を読まない（`bodies` の `get` の spy が 0 回）

`core.test.ts` への追記: `evictScopesFor` の読み出し（`store.getSource` の spy の reject）で `x-weiwudi-error: storage`・配信は上流の本体・`entries` が増えない・**上流の `fetch` が 1 回**（I1a。直す前は reject で `serveHit` が素通しし 2 回）。`ServeInput.pin: true` の miss で `pinned === 1`。

`glyph.test.ts` への追記: 固定の競合のグリフ版（`putGlyphParts` で `old.pinned` を保つ）。

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0。`core.test.ts`・`glyph.test.ts` は追記だけ（`git diff --numstat <BASE>.. -- tests/unit/core.test.ts tests/unit/glyph.test.ts` の削除数が 0）。`store.test.ts` の削除は I12 の 1 行だけ（`git diff <BASE>.. -- tests/unit/store.test.ts | grep -c '^-[^-]'` が 1）。`legacy-store-repair.test.ts` は I12 の 1 件だけを書き換える（台帳に書く）
- `grep -c 'savedPinned' src/core.ts` が 0
- `grep -c 'getAll(IDBKeyRange.bound(\[id, 0\]' src/store.ts` が 0（走査は cursor）
- `grep -n 'hasEntries' -A8 src/store.ts | grep -c 'bodies'` が 0（I12）

---

## m4-t2: 保持期間の掃除と保守の契機（仕様 §7.1・L2）

コミット種別: `feat:`（`cacheRetention` が実際に消すようになる。公開の項目の意味が「配信の時点で無いもの」から「消す」に揃う）

### 対象ファイル

`src/core.ts`（`sweepOnce`）・`src/context.ts`（`maintain`・`maintenance`）・`src/hook.ts`・`src/legacy.ts`・`src/control.ts`（handler の先頭で `ctx.maintain?.(event)` を呼ぶ 1 行ずつ）・`src/weiwudi_gw_logic.ts`（配線）・`tests/unit/retention.test.ts`（新規）・`tests/unit/legacy-routes.test.ts`（追記のみ）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・README の英日（`cacheRetention` の説明）・仕様 §7.1

### 作るもの

**保守の契機（R9・第 1 回 S3）**: `Context.maintain?: (event: ExtendableEvent) => void` と、保守の状態 `Context.maintenance: { swept: boolean; running?: Promise<void>; migrated?: boolean }`（メモリだけ。`migrated` は t7 が使う）。配線（`weiwudi_gw_logic.ts`）が `ctx.maintain = (event) => event.waitUntil(runMaintenance(ctx))` を設定する。`runMaintenance` は配線が組む（t2 では `sweepOnce(ctx)` だけ。t7 が `migrateStep` を足す）。進行中の `runMaintenance` は `maintenance.running` で 1 つにまとめる（同時の契機で 2 本走らせない）。呼ぶのは **Weiwudi が扱う fetch のうち store を使うハンドラの先頭**:

- `legacy.handleLegacy`: API 名が `ping` **でない**とき（`matched[1] !== 'ping'`。`/api/ping` は IndexedDB を開かない。F18・F26）
- `control.post`: 送り手の検査（`fromOwnOrigin`）を通った後
- `hook` の照合ルート（`matchHandler`）と門番（`gateHandler`）: 照合に当たったとき（`serveHit` の前）
- `control.get` は呼ばない（答えるのは `/v2/ping` だけで、死活確認で IndexedDB を開かない。F26）

新しい `fetch` のリスナは足さない（`legacy-routes.test.ts:60-67` の「リスナは install・activate だけ」「`Weiwudi_Internal` で IndexedDB を開かない」「`/api/ping` で IndexedDB を開かない」を差分なしで保つ）。`event` に `waitUntil` の関数が無いとき（試験の直接呼び出しなど）は何もしない。`maintain` の例外は `waitUntil` の Promise の中で捕まえて `console.error`（配信を止めない）。

**掃除（R10・第 1 回 M2・M11）**: `core.sweepOnce(ctx, opts?: { force?: boolean })` は SW の起動後 1 回だけ（`ctx.maintenance.swept` の印。メモリだけ）と、ジョブの完了時（t3 が `{ force: true }` で呼ぶ。印を見ずに走り、印も立てる）に走る。手順:

1. `listResources` で `policy.cacheRetention` を持つ Resource を集め、無ければ終わり。グリフかどうかは **Resource の `type`**（`'glyph'`）で決める（本体を読まない）
2. **グリフでない Resource**: `before = now − min(cacheRetention)`（グリフでないものの最短）で `store.listUnpinnedBefore(before, 200, next)` を繰り返す。各 Entry について、その Resource が `type !== 'glyph'` で `cacheRetention` が定義され `now − fetchedAt > retention` なら消す候補。それ以外（retention が無い・グリフ）は飛ばす。候補は `deleteEntries(keys, { unpinnedOnly: true, fetchedBefore: now − retention })`（Resource ごとの `retention` で 200 件ずつ。一覧の後に固定・取り直しされた Entry は tx の中の見直しで残る。M11）
3. **グリフの Resource**（`type === 'glyph'` で `cacheRetention` を持つもの）: Resource ごとに `store.entriesOf(resourceId, 200, next)` でレコード（fontstack ごと。数は少ない）を回し、固定でないものに `pruneGlyphParts(key, now − retention)`（tx の中で部分ごとに期限を見て落とし、全部落ちればレコードを消す。L2・R8）。レコードの `fetchedAt` は最も新しい部分の値なので（F36）、2 の索引では拾えない
4. 1 回の `sweepOnce` は 2 と 3 を合わせて最大 2,000 件まで（残りは次の契機）。`stale` の配信の判定（`core.serve` の `retention` の分岐）はそのまま残す（掃除の前に当たる Entry のため）

掃除は `ctx.job` が動いている間は走らせない（ジョブの完了時に `force` で走る）。

**文書**: `cacheRetention` の説明を「期限を過ぎた Entry は配信で無いものとして扱い、SW の起動後の最初の要求とジョブの完了時にまとめて消す。固定した Entry は消さない」に直す（英日）。仕様 §7.1 の「掃除は m4」を事実に。

### 試験

`retention.test.ts`（fake-indexeddb の上の実物の store・core・ハーネス）:

- `cacheRetention` を持つ Source の Entry 3 件（期限内 1・期限切れ 2）と、持たない Source の古い Entry 1 件 → `sweepOnce` の後に期限切れ 2 件だけが消え、`count`・`bytes` が合う。持たない Source の Entry は残る
- 固定（`pinned: 1`）の期限切れは残る
- グリフ（第 1 回 M2）: 範囲 2 つのうち **古い 1 つが期限切れ・新しい 1 つが期限内**（レコードの `fetchedAt` は期限内）→ レコードは残り `parts` が 1 つ・`size` が減る（L2）。両方期限切れ → レコードが消える。固定のグリフのレコードは触らない
- 2,001 件の期限切れで 1 回目は 2,000 件、2 回目で残り（`listUnpinnedBefore` の `next`）
- 条件の見直し（M11）: `listUnpinnedBefore` の後・`deleteEntries` の前に同じキーを取り直す（`fetchedAt` が新しくなる）→ 残る
- 契機（第 1 回 S3）: ハーネスで `/api/info?mapID=x`（登録済みの地図）を 2 回 dispatch すると `waitUntilCalls` が増え、掃除は 1 回だけ走る（spy）。`/api/ping` と `/v2/ping` の dispatch では `waitUntilCalls` が増えず、`indexedDB.open` も呼ばれない。`sweepOnce(ctx, { force: true })` は印があっても走る
- `maintain` の中の例外（`listResources` の reject）で配信の応答は変わらず、`console.error` が 1 回

`legacy-routes.test.ts` への追記: `self` のリスナが `['activate', 'install']` のまま（既存の行の確認）と、照合ルート・門番・制御の POST の dispatch で `waitUntilCalls` が増えること。既存の `:60-67` の試験は変えない。

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0。`legacy-routes.test.ts` は追記だけ（削除数 0）
- `grep -c "addEventListener('fetch'" src/*.ts` が 0
- `grep -c 'ctx.maintain' src/hook.ts src/legacy.ts src/control.ts` がそれぞれ 1 以上
- `grep -c 'cacheRetention' docs/api/weiwudi.md docs/api/weiwudi.ja.md` がどちらも 1 以上で、「掃除は m4」の文が無い（`grep -c 'm4' docs/api/weiwudi.md docs/api/weiwudi.ja.md` は t11 で 0 にする。ここでは `cacheRetention` の段落に無いこと）

---

## m4-t3: 範囲取得の土台とタイルの `fetchRange`（仕様 §7.2・§4.5-3・§4.6・P2・P3・P6・I5b・I5c・I5d）

コミット種別: `feat:`（`estimate`・`fetchRange`・`regions`・`cancel` と型 `RangeSpec`・`FetchRangeOptions`・`RegionInfo`。`opaque` イベント）。**水準 2 のレビュー**

### 対象ファイル

`src/range.ts`（新規）・`src/spec.ts`（`RangeSpec`・`FetchRangeOptions`・`RegionInfo` の型と `normalizeRange`）・`src/url_pattern.ts`（`expandTemplate`）・`src/upstream.ts`（`probeNoCors`・`ctx.notify` の呼び出し）・`src/hook.ts`（`ServeResourceOptions.pin`・資格情報の選び方の export。第 1 回 M4）・`src/context.ts`（`notify`・`JobState.regionId`）・`src/core.ts`（`ServeInput.pin` は t1 で足した。`sweepOnce` をジョブの完了時に呼ぶ口）・`src/control.ts`（op `estimate`・`fetchRange`・`regions`・`cancel`・`job/resume`）・`src/weiwudi.ts`（ページ側）・`src/weiwudi_gw_logic.ts`（`ctx.notify`）・`tests/unit/range.test.ts`・`tests/unit/range-cors.test.ts`（新規）・`tests/unit/url-pattern.test.ts`・`tests/unit/spec.test.ts`・`tests/unit/client.test.ts`・`tests/unit/upstream.test.ts`・`tests/unit/hook.test.ts`（追記のみ）・`tests/dts/page-consumer.ts`（追記）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・`README.md`・`README.ja.md`・仕様 §4.5（表の「テンプレートから作る要求」の行）・§7.2・§12

### 作るもの

**型（`spec.ts`。公開。`dist/weiwudi.d.ts` に届く）**

```ts
export type RangeSpec =
  | { bounds: [west: number, south: number, east: number, north: number]; minZoom: number; maxZoom: number }
  // box は maxZoom での x/y の範囲で、Source の scheme の座標（登録の box と同じ。F32）
  | { box: TileBox; minZoom: number; maxZoom: number }
  | 'all';
export interface FetchRangeOptions {
  pin?: boolean;                               // 既定 true
  concurrency?: number;                        // 既定 5（1〜20）
  glyphRanges?: 'common' | 'all' | string[];   // 既定 'common'（t4）
  fonts?: string[];                            // 追加の fontstack（t4。R53）
  ratio?: '' | '@2x';                          // {ratio} の値。ページ側の既定は devicePixelRatio > 1 なら '@2x'（R-ratio）
}
export interface RegionInfo {
  id: string; sourceId: string; range: RangeSpec;
  status: 'running' | 'complete' | 'partial' | 'canceled' | 'stopped';
  pinned: boolean; total: number;
  error: number; errors: { network: number; upstream: number; quota: number; storage: number };
  code?: WeiwudiErrorCode;                     // stopped のとき
  createdAt: number; updatedAt: number;
}
```

`normalizeRange(input, source: { extent?: TileExtent; scheme?: 'xyz' | 'tms' })` → `{ kind: 'boxes'; boxes: TileBox[]; minZoom; maxZoom }`（**`boxes` は `maxZoom` での XYZ の座標**）。`bounds` は緯度を `±MERC_MAX_LAT` に丸め（P3・R28）、`west > east` は 2 つの `box` に分ける（日付変更線）。`{ box }` は Source の scheme の座標として読み、`tms` なら XYZ に直す（第 1 回 M9）。`'all'` は **取得のときの** Source の範囲（R30）を `boxes` にして返す（後で `update()` が範囲を変えても、region の範囲は取得したときのまま。解放は保存した `normalized` を使う。第 1 回 L）。`minZoom`・`maxZoom` は 0〜`MAX_TILE_ZOOM` の整数で `minZoom <= maxZoom`、外れたら `attribute-invalid`。

`RegionInfo.range` は利用者のオブジェクトをそのまま IndexedDB に入れず、決めた項目（`bounds` の 4 数・`box` の 4 数・`minZoom`・`maxZoom`、または `'all'`）だけを写した値を保存し、返す（第 1 回 L。利用者の任意の項目や関数を構造化複製に通さない）。

**展開（`url_pattern.expandTemplate`。R2）**: `expandTemplate(template, v: { z?; x?; y?; ratio?; fontstack?; range?; spriteSuffix? })`。タイルの 7 字句は `tile_math.expandTileTemplate(…, { all: true, ratio })` に任せ、`{fontstack}` は `encodeURIComponent`、`{range}`・`{spriteSuffix}` はそのまま置く。**範囲取得はこれで URL を作り、同じテンプレートの `compileTemplate` に `matchUrl` で照合して `MatchResult` を得て、`hook.serveResource` に渡す**（キーの作り方を 2 つにしない。照合に外れたら `internal` として `storage` に数える）。

**資格情報の選び方（`hook.ts`。R3・第 1 回 M4）**: `hook.credentialsForResource(ctx, resource, origin): Promise<{ credentials?: Credentials; credentialSourceId?: string }>` を export する。照合表（`ctx.table.current`。無ければ門番と同じ `ensureLoad` の読み込みを待つ。読めなければ両方 `undefined`）の `credentialSources` の Resource × オリジンから Source を選び、その資格情報と id を返す。`serveHit` の今の 2 行（`credentialsFor` と `credentialSources.get(...)`）もこの関数に置き換える（選び方を 1 つにする）。`ServeResourceOptions` に `pin?: boolean` を足し、`ServeInput.pin` へ渡す。範囲取得の style・tilejson は `credentialSourceId` も渡す（本体の除去の親が捕捉と同じ選び方になる。O-N3）。

**`range.ts`**（§3 の表の行は t1 で足した）

- `enumerate(resource, normalized, ratio)`: 生成器。`normalized` の XYZ の `boxes` を z ごとに縮め（`scaleTileBox`）、**Resource の scheme の座標に直してから**（`tms` なら `2^z − 1 − y`）Resource の `extents`（Source の分。Resource の scheme の座標。F32）と交差させ、`z` 昇順に `[z, x, y]` を出す。出た y は**そのまま** `expandTemplate` に渡す（`{-y}` は `expandTileTemplate` が y から作る。照合の y と同じ座標なので、2 回反転しない。R-tms・第 1 回 M9）
- `tileAt(resource, normalized, n)`: `enumerate` と同じ順の n 番目のタイル（z ごとの枚数を引いていく。生成器を n 回回さない）。5 枚の無作為の確かめに使う（第 1 回 L）
- `estimate(store, rec, range)`: Source の tile の Resource（スタイルは子の）ごとに `countTiles` の交差で数え、同じ Resource は 1 回。`{ tiles }` を返す。`'all'` で範囲（`box`）の無い Source は `cannot-fetch-all`（m1 の表にある code。新 API では `WeiwudiError`）（R30）。`kind: 'asset'` の Source は `{ tiles: 0 }`（R52）
- **ジョブ**（`startRangeJob(ctx, rec, region, client, opts)`）: `core.runJob` を使う（`batchSize = concurrency`）。`isAlive` は `self.clients.get(client.id)`、`isCanceled` は `ctx.job.cancel`。各バッチの前に Source がまだあるかを見て、無ければ `stop`（`source-not-found`）（R13）。1 単位の処理:
  1. キー（`entryKey`）で `hasEntries`（t1 でメタだけ）を見て、有れば上流へ出さず成功と数える
  2. 無ければ `serveResource(ctx, resource, new Request(url), new URL(url), m, credentials, { pin, credentialSourceId })`。`credentials`・`credentialSourceId` は `hook.credentialsForResource`（捕捉と同じ選び方。R3）。要求は `new Request(url)`（`mode: 'cors'`・`credentials: 'same-origin'` の既定。§4.5 の「テンプレートから作る要求」と同じ形）
  3. 応答の `x-weiwudi-status`・`x-weiwudi-error` で数える。`hit`・`miss`・`refresh` は成功。`stale`・`offline-miss`・`upstream-error` は `x-weiwudi-error` の種類で `errors` に数える。本体は読み切る（`arrayBuffer()`）
  4. **固定（第 1 回 S2・R46）**: `pin` なら、1 と 3 で**成功と数えたキーは全部**、バッチの後に `setPinned(keys, 1)` で固定する（200 件ずつ。バッチの中で集めて 1 回）。`ServeInput.pin` は保存と同じ tx で付ける近道として残すが、`ctx.inflight` の相乗り（ページの `pin` の無い要求に乗る）・`hasEntries` の後に別の要求が保存して serve が hit を返す、のどちらでも `save` を通らないので（F25）、固定の正本はこの `setPinned` にする
  5. **CORS・認証の規則（P6・R4）**: `x-weiwudi-error: network` のとき、Resource に実績（`count > 0 || corsOk`）が無ければ `upstream.probeNoCors(url)`（`fetch(url, { mode: 'no-cors' })` 1 回。資格情報を付けない・保存しない）。`opaque` なら `jobOpaqueStreak++`・`upstream` に数え直す、`TypeError` なら `network` のまま。`jobOpaqueStreak` が 3 で、範囲から無作為に 5 枚（`tileAt` に無作為の n を 5 つ。5 枚未満なら全部）を cors で確かめ（`serveResource` で通常どおり。取れた 200 は保存し進捗にも数える）、1 枚でも通れば `corsOk` が立つ（`markCors` が書く）ので続ける。1 枚も通らず opaque が 1 枚でもあれば `stop`（`opaque`）、全部が両方失敗なら `stop`（`network`）。`upstream-error` で状態が 401・403 かつ `count === 0` が 3 回続いたら `stop`（`upstream`）（§4.6）
  6. **固定分の上限（§7.1・第 1 回 M8）**: 開始のときと**各バッチの後**に、その Resource の `evictScopesFor` の要素ごとに `Σ pinnedBytes`（要素の `resourceIds` の Resource を読み直す）を見て、どれかが `maxBytes` 以上なら `stop`（`quota`）。`commitEntry` は固定していない Entry だけを予算に数えるので、`x-weiwudi-error: quota` は `cacheMaxBytes` からは出ない（ブラウザの上限だけ）。`quota` が 3 回続いたときの `stop`（`quota`）も残す
- **region（R5・第 1 回 M7）**: 開始時に `RegionRecord`（`RegionInfo` の項目＋`normalized`）を `status: 'running'` で `putRegion`。進捗の位置は書かない。**終わりの書き込みは `patchRegion` で、region が有り `status` が `running` のときだけ**書き換える（その間に `clean()`・`remove()`・`clean(range, { force })` が region を消した・`partial` に書き換えたときは書かない。持ち主の消えた region を書き戻さない）。値は `finish` で `error === 0` なら `complete`、あれば `partial`、取り消しは `canceled`、`stop` は `stopped`（`code`）、**`gone`（ページが閉じた）は `partial`**。`error`・`errors`・`updatedAt` も書く。id は `crypto.randomUUID()`（無ければ `Date.now()` と乱数）。`regions()` は `listRegions(sourceId)` を `RegionInfo` にして返し、**`status: 'running'` で `ctx.job` が無いか `ctx.job.regionId` が違う（SW が止まった・別の region のジョブが動いている）ものは `partial` として見せる**（記録は書き換えない。R5）
- **イベント（I5c）**: 開始の client に `postMessage` する。`proceed`（バッチごと: `{ type, sourceId, regionId, percent, processed, total, error, errors }`）・`finish`（`{ …, error, errors }`）・`stop`（`{ …, code, message, processed, total }`）・`canceled`。旧 API の `fetchAll` の形に `sourceId`・`regionId`・`errors` を足したもの（§7.2）。`percent` は **タイルだけ**で数える（`floor(processedTiles × 100 / total)`。非タイルの資源は `processed` に入るが `percent` には入れない。第 1 回 L）。終わりの順は **「region を書く → `ctx.job` を外す → `postMessage`」**（ページが `finish` を受けて `regions()` を読んだときに、もう `running` でない。R45）。その後に `core.sweepOnce(ctx, { force: true })`（t2）
- **1 度に 1 ジョブ（R23・第 1 回 M7）**: `JobState` に `regionId?: string` を足す（旧 API の `fetchAll` は持たない）。`ctx.job` の確かめと確保は **await を挟まず同期に**行う（旧 API の `fetchAll` と同じ。F7）。`fetchRange` は直列の中で、まず同期に `ctx.job` を確保してから region を書き、書き込みが失敗したら `ctx.job` を外して投げる。`ctx.job` があれば `fetch-busy`（m1 の表の code。旧 API の `fetchAll` と共有する）。`cancel()` は自分の Source のジョブだけ止める（`ctx.job.cancel = true`）。無ければ `no-fetch-process`
- **再開（§7.2・R45）**: op `job/resume`（`{ id, regionId }`）。直列の外。region が無い・他の Source の region なら `attribute-invalid`（`regionId`。新しい code を足さない）。`ctx.job` が動いていて `regionId` が同じなら何もせず今の `RegionInfo`（`running`）を返す。**別の region のジョブが動いていれば `fetch-busy`**（ページは reject。30 秒ごとに送り続けない）。`ctx.job` が無く region が `running` なら、`fetchRange` と同じ手順（同期に確保 → 失敗なら外す）で、その record の `normalized` からジョブを作り直して開始する（既に有るタイルは飛ぶので再実行が再開）。region が終わりの `status`（`complete`・`partial`・`canceled`・`stopped`）ならそのまま返す（`finish` を送る前に SW が止まった場合。ページはこれで解決する）
- `kind: 'asset'` の Source（R52）: `range` は `'all'` だけを受け（ほかは `attribute-invalid`（`range`））、Source の Resource（非タイル）を 1 件ずつ取って固定する。`total` は 0、`percent` は終わりに 100

**`opaque` イベント（P2・I5d・R20）**: `Context.notify?: (m: { type: 'opaque'; resourceId: string; sourceIds: string[] }) => void`。`upstream.countCorsless` が `corslessUntil` を書いた（`patchResource` が値を返した）ときと、ジョブが `opaque` で止めたときに呼ぶ。配線は `range.createNotifier(ctx)` を設定する: 子 Source は親に読み替え（`store.getSource`）、`self.clients.matchAll({ type: 'window' })` の各 client に `{ type: 'opaque', sourceId, resourceId }` を送る。

**制御（`control.ts`）**: op `estimate`（`{ id, range }`）・`fetchRange`（`{ id, range, options }`。`event` と `event.clientId` の client が要る。無ければ `sw-not-controlling`）・`regions`（`{ id }`）・`cancel`（`{ id }`）・`job/resume`。`fetchRange` は region を書いて **応答を先に返し**、ジョブは `event.waitUntil` に結び付ける（F7 と同じ）。`estimate`・`regions`・`cancel`・`job/resume` は直列の外。`fetchRange` の `ctx.job` の確保と region の書き込みは直列の中（同時の 2 つの `fetchRange` が両方始まらない。旧 API の `fetchAll` とは同期の確保で排他）。

**ページ側（`weiwudi.ts`）**: `WeiwudiSource.estimate(range)`・`fetchRange(range, opts)`・`regions()`・`cancel()`。`fetchRange` は `navigator.storage?.persist?.()` を試し（失敗は無視。I5b）、`opts.ratio` が無ければ `devicePixelRatio > 1 ? '@2x' : ''` を入れて送る（R-ratio・第 1 回 M10）。POST の応答の `RegionInfo`（`running`）を受けたら、**その `regionId` の `finish`・`stop`・`canceled` を `message` で待つ**。30 秒イベントが来なければ `job/resume` を POST し、応答が `running` ならまた待つ。**応答が終わりの `status` ならそれで解決する**（`complete`・`partial`・`canceled` は resolve、`stopped` は `WeiwudiError(code)` で reject）。`job/resume` が `fetch-busy` などで失敗したら reject（R22・R45）。`finish` で `regions()` から該当の `RegionInfo` を読んで resolve、`canceled` も resolve（`status: 'canceled'`）、`stop` は `WeiwudiError(code, message)` で reject（R22）。`release()` で待ちを `instance-released` で reject する。

**文書**: `docs/api` の英日に 4 メソッド・3 型・イベントの形・`opaque` イベント・`fetch-busy`・`cannot-fetch-all`・再開の動き・`ratio` の既定・`RangeSpec.box` の座標・「`fetchRange` の要求は `cors`・`same-origin` で出す。別オリジンで Cookie だけで認証するサーバは対象外（§4.6）」。README の英日に MapLibre の例（§12 の 4 行）を足す。仕様 §7.2 に R2〜R5・R13・R20・R22・R30・R45・R46 を書く。**仕様 §4.5 の表の「テンプレートから作る要求（範囲取得・旧 API）」の行を、範囲取得は R3（`new Request(url)` を `createUpstream` が組み替える）・旧 API は `fetch(URL の文字列)` のまま、の 2 つに分けて直す**（第 1 回 L）。

### 試験

`url-pattern.test.ts` への追記: `expandTemplate` の全字句（`{z}/{x}/{-y}`・`{quadkey}`・`{ratio}` の 2 値・`{fontstack}` の encode・`{range}`・`{spriteSuffix}`）と、展開した URL が同じテンプレートに `matchUrl` で当たり、`entryKey` が捕捉した要求と同じキーになる（tile・glyph・sprite の 3 型）。

`spec.test.ts` への追記: `normalizeRange` の表（`bounds` の丸め・日付変更線で 2 つ・ズームの検査・`'all'` が取得のときの範囲になる・`{ box }` が `tms` の Source で XYZ に直る・不正な形）。

`hook.test.ts` への追記: `credentialsForResource` が照合ルートと同じ Source を選ぶ（オリジン違いでは `undefined`）。`serveHit` の振る舞いは既存の試験のまま。

`range.test.ts`（ハーネスと偽の上流。仕様の文 1 つにつき 1 件）:

- `estimate` が `countTiles` の交差と一致し、同じ Resource を共有する 2 つの子で 1 回
- `fetchRange` が範囲のタイルを全部取り、`pinned === 1`・`pinnedBytes === bytes`。`pin: false` なら 0
- 既に有るタイルは上流へ出ずに固定だけ付く
- **固定の抜け（第 1 回 S2）**: (a) ページの要求（`pin` なし）が上流を待っている最中に、ジョブが同じキーを取る（`ctx.inflight` に相乗り）→ ジョブの後に `pinned === 1`。(b) `hasEntries` が偽を返した直後に別の要求が同じキーを保存し、ジョブの `serve` が hit になる → `pinned === 1`
- **tms の座標（第 1 回 M9）**: `{y}`＋`scheme: 'tms'`・`{-y}`＋`xyz`・`{-y}`＋`tms` の 3 通りで、範囲取得の URL とキーが、同じタイルを捕捉したときと同じ（y を 2 回反転しない）
- `ratio: '@2x'` で `@2x` の URL とキー
- イベント: `proceed` が `concurrency` ごと、`finish` に `error`・`errors`・`regionId`・`sourceId`。`cancel()` で `canceled`。`stop` に `code`。`finish` を受けた時点で `regions()` の `status` が `running` でない（終わりの順）
- `regions()` が `complete`／`partial`（失敗あり）／`canceled`、`running` で `ctx.job` が無ければ `partial`、**別の region のジョブが動いていても `partial`**。ページが閉じた（`isAlive` が偽）ジョブの region が `partial`
- **終わりの書き込み（第 1 回 M7）**: ジョブの途中で region を消す（`deleteRegion`）→ 終わりに region が書き戻されない。途中で `partial` に書き換える → 終わりに `complete` で上書きしない
- `job/resume`: ジョブの途中で `ctx.job` を消して（SW の再起動の模造）`job/resume` → 残りだけ取る（上流の回数）。別の region のジョブ中の `job/resume` は `fetch-busy`。終わった region の `job/resume` はその `RegionInfo` を返す。同時の `job/resume` 2 つでジョブは 1 つ
- `fetch-busy`（別の Source のジョブ中・旧 API の `fetchAll` 中）・`no-fetch-process`・`cannot-fetch-all`（範囲の無い `'all'`）
- 固定分の上限（第 1 回 M8）: `cacheMaxBytes` が 3 枚分の Source で 10 枚の範囲 → 3〜4 枚目のバッチの後で `stop`（`quota`）
- Source を `remove()` すると次のバッチで `stop`（`source-not-found`）（R13。t5 の後は自分の Source の `remove()` が `fetch-busy` になるので、試験は別スコープの SW を模した直接の `deleteSource` で行う）
- `estimate`・`regions` が直列の外（`register` を待たない）
- `RegionInfo.range` に利用者のオブジェクトの余分な項目が入らない
- `kind: 'asset'` の `fetchRange('all')` で Resource が固定され、`'all'` 以外は `attribute-invalid`
- 資格情報: `credentials` を登録した Source の範囲取得で上流の URL に `access_token` が付き、キーと `regions()` と イベントに無い。別オリジンのミラーが混ざる子（m3 R5 で `{}`）には付かない

`range-cors.test.ts`（P6・R4。仕様 §4.5-3 の文ごとに）:

- 実績の無い Resource で cors が `TypeError`・no-cors が opaque を 3 枚 → 5 枚の確かめ → 全部 opaque → `stop`（`opaque`）・`opaque` イベントが 1 回（`clients.matchAll` の偽物）
- 確かめの 1 枚が cors を通る → `corsOk` が立ち続行、確かめで取れた 200 が保存され `processed` に入る
- 全部が両方失敗 → `stop`（`network`）
- 実績のある Resource では opaque を数えず `upstream` として進む
- `count === 0` で 401 が 3 回 → `stop`（`upstream`）。`count > 0` なら止まらない
- `corslessStreak`（照合ルート）が範囲取得で増えない
- `probeNoCors` の要求に資格情報（クエリ・ヘッダ）が無い
- `tileAt` が `enumerate` の n 番目と同じ（種を固定した 100 回）

`upstream.test.ts` への追記: `countCorsless` が `corslessUntil` を書いたとき `ctx.notify` が 1 回、書かなかった（実績あり）とき 0 回。`probeNoCors` の 2 値。

`client.test.ts` への追記: 4 メソッドの POST の形・`persist` を試すこと・`ratio` の既定（`devicePixelRatio` の 1 と 2）・30 秒で `job/resume`（偽のタイマ）・再開の応答が `complete` で resolve／`stopped` で reject・`job/resume` の `fetch-busy` で reject・`stop` の reject・`release()` 後の reject。

`tests/dts/page-consumer.ts`: `RangeSpec`・`FetchRangeOptions`・`RegionInfo` の全項目と 4 メソッド。

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0
- `build` の後、`node tests/dts/check-dts.mjs dist/weiwudi.d.ts` と `node_modules/.bin/tsc -p tests/dts/tsconfig.json` が exit 0。`grep -c 'fetchRange(' dist/weiwudi.d.ts` が 1 以上
- `grep -c 'fetch(' src/range.ts` が 0（取得は `serveResource`、確かめは `upstream.probeNoCors`）
- `grep -c 'tileKeySuffix' src/range.ts` が 0（キーは照合の結果から `entryKey` で作る）
- `grep -c 'credentialsFor(' src/hook.ts` が 0（選び方は `credentialsForResource` 1 つ）
- `grep -c 'fetchRange' docs/api/weiwudi.md docs/api/weiwudi.ja.md README.md README.ja.md` がいずれも 1 以上
- 水準 2 のレビューの記録が台帳にある

---

## m4-t4: スタイルの範囲取得（仕様 §7.2・§11・L4）

コミット種別: `feat:`（`kind: 'style'` の `fetchRange`）

### 対象ファイル

`src/range.ts`・`src/core.ts`（`GlyphCollector`）・`src/hook.ts`（`ServeResourceOptions.collect`。第 1 回 M4）・`src/style_body.ts`（`collectFonts`）・`tests/unit/range-style.test.ts`（新規）・`tests/unit/style-body.test.ts`・`tests/unit/glyph.test.ts`（追記のみ）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・仕様 §7.2・§11

### 作るもの

スタイルの Source の `fetchRange` は、子の Resource を型ごとに次の順で取る（全部 `serveResource` 経由・`pin` は同じ。style・tilejson は t3 の `credentialsForResource` の `credentialSourceId` も渡す）:

1. **スタイル**（子 `style`）: 通常の取得（`hit` でよい）。応答の本体を `style_body.parseStyle` で読み、`collectFonts(style)`（新規）で fontstack の候補を作る。読めなければ（`invalid-style` の形）スタイルの子だけ `upstream` に数えて続ける
2. **TileJSON**（子 `tilejson`）・**データ**（`data`）: 1 件ずつ
3. **スプライト**（子 `sprite`）: `{spriteSuffix}` の 4 値（`.json`・`.png`・`@2x.json`・`@2x.png`）
4. **タイル**（子 `tile`。TileJSON の下の子も）: t3 の `enumerate` で各 Resource の範囲（`extents` の Source の分）との交差。同じ Resource は 1 回
5. **グリフ**（子 `glyph`）: fontstack は `opts.fonts` ∪ `StyleSpec.fonts` ∪ `collectFonts` の和。範囲は `glyphRanges`: `'common'` は `0-255`・`256-511`・`8192-8447`・`12288-12543`・`65280-65535`、`'all'` は `0-255` から `65280-65535` の 256 個、配列はそのまま（`^\d+-\d+$` の検査）（R32）

**fontstack の意味（R53・第 1 回 L）**: `FetchRangeOptions.fonts` と `StyleSpec.fonts` の要素は **fontstack**（`{fontstack}` に入る文字列。フォント名を `,` で結んだもの。例 `"Open Sans Regular,Arial Unicode MS Regular"`）で、フォント名 1 つでもそのまま 1 つの fontstack になる。`collectFonts` は `layers[*].layout['text-font']` のうち、文字列の配列と `["literal", [文字列…]]` を集め、配列を `,` で結んで 1 つの fontstack にする（MapLibre の要求と同じ形）。それ以外の式（先頭が演算子の配列）は飛ばす。

**グリフの束ね書き（L4・R-G・第 1 回 M15）**: `core.createGlyphCollector(ctx, resource, key)` を足す。`ServeInput.collect?: GlyphCollector`（`ServeResourceOptions.collect` から渡す）。`core.save` は `input.part !== undefined && input.collect` のとき `putGlyphPart` を呼ばず、`evictScopesFor` も読まずに `collect.add({ part, body, fetchedAt, headers })` に渡して `undefined` を返す（配信は通常どおり。`serve`・`cacheWillUpdate`・まとめの経路は変わらない）。**1 fontstack を `runJob` の 1 単位にする**: 単位の中で範囲を順に取り、`try … finally` で `collect.flush()`（`evictScopesFor` を 1 回だけ読み、`store.putGlyphParts(meta, parts, headers, evict)` を 1 回）。`runJob` は始めた単位を終わりまで待つので（F37）、取り消し・`gone`・`stop` でも途中の部分を捨てない。例外で単位が終わるときも `finally` で書く。`flush` の失敗は **fontstack ごとに 1 件**として `quota`／`storage` に数える。既に有る範囲（`hasEntries` では分からないので `getEntry` の `parts` で見る。fontstack ごとに 1 回）は飛ばす。固定は t3 の手順 4 と同じく、`flush` の成功の後に fontstack のレコードのキーを `setPinned` する（既に有る範囲だけのレコードも）。同じ範囲が並びに 2 つあれば後勝ち（`putGlyphParts` の規則。試験する）。

`estimate` はタイルだけを数える（§7.2「タイル枚数」）。`RegionInfo.total` も同じ。非タイルの資源は `processed` に入れるが `total` にも `percent` にも入れない（t3 の `processedTiles`。R29）。

**非タイル資源の固定（R11・第 1 回 S1）**: スタイル・TileJSON・スプライト・データ・グリフの Entry は region に幾何で結び付かないので、固定は **「その Resource を参照する全 Source（`sourceIds` ∪ `rangeOnlySourceIds`。子は `parentId` の親に読み替える）の、固定つき（`pinned: true`）の region が 1 つでも残っている間」** 維持する（t5 の解放が外す規則）。2 つのスタイルが同じグリフ・スプライトの Resource を共有し、両方が region を持つとき、片方の最後の region を解放しても、もう片方の region がある間は外さない。

**文書**: `docs/api` の英日に「スタイルの `fetchRange`」の節（取る物・`glyphRanges`・`fonts` が fontstack であること・`text-font` の式からは取れない・非タイル資源の固定は参照する全 Source の region で決まること）。仕様 §7.2・§11 を事実に。

### 試験

`style-body.test.ts` への追記: `collectFonts`（リテラルの配列・`["literal", [...]]`・式は飛ばす・重複を除く・`layout` の無い layer・`,` で結ぶ）。

`range-style.test.ts`（m3-t7 の `style.test.ts` の偽の上流を使う）:

- スタイルの `fetchRange` で style・tilejson・tile・glyph・sprite（4 つ）・data が全部 Entry になり、固定される
- グリフ: fontstack 1 つ・`'common'` の 5 範囲で `putGlyphParts` が **1 回**（spy）、`evictScopesFor` も fontstack ごとに 1 回、`parts` が 5 つ、各範囲の再生が上流の本体と同じ。`'all'` で 256。配列の指定。並びに同じ範囲を 2 つ入れた `glyphRanges` で後勝ち（L4）
- 途中の取り消し（第 1 回 M15）: グリフの単位の途中で `cancel()` → その fontstack の取れた範囲は書かれ（`flush`）、次の単位から止まる。`flush` が `QuotaExceededError` で失敗すると `errors.quota` が 1 増える（範囲の数ではない）
- fontstack の集め方: `text-font` のリテラルと `fonts`・`StyleSpec.fonts` の和。式の `text-font` は飛ぶ。`fonts: ['Noto Sans Regular']`（名前 1 つ）がそのまま 1 つの fontstack になる
- 既に有る範囲は上流へ出ない。無い範囲だけ足す（`parts` が増える）。既に有る範囲だけのレコードも固定される
- `estimate` と `total` がタイルだけ。タイルが残っている間は `percent` が 100 にならず、100 を超えない
- TileJSON の下のタイルの子も範囲の交差で取る。同じ Resource の子 2 つは 1 回
- スタイルが読めない（HTML）とき、スタイルの子だけ `upstream` に数えて他は取れる

`glyph.test.ts` への追記: `collect` のある `serve` が `putGlyphPart` も `evictScopesFor` も呼ばず、`flush` で 1 回書く。

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0
- `grep -n 'putEntry\|putGlyphPart' src/*.ts | grep -v '^src/store.ts' | grep -v '^src/core.ts'` が 0 件（m3 の区切りの grep のまま。`range.ts` は `GlyphCollector` 経由）
- `grep -c 'text-font' src/style_body.ts` が 1 以上、`grep -c 'text-font' src/range.ts` が 0

---

## m4-t5: 解放と範囲つき `clean`（仕様 §7.2 の解放・I5a・P1）

コミット種別: `feat:`（`releaseRange`・`clean(range, { force })`・ジョブ中の `clean`・`remove` の `fetch-busy`）。**水準 2 のレビュー**

### 対象ファイル

`src/range.ts`・`src/control.ts`（op `releaseRange`・`clean` の引数・`remove` の前の解放・ジョブ中の `fetch-busy`。P1）・`src/weiwudi.ts`・`tests/unit/release.test.ts`（新規）・`tests/unit/control.test.ts`・`tests/unit/client.test.ts`（追記のみ）・`tests/dts/page-consumer.ts`（追記）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・README の英日・仕様 §7.2

### 作るもの

**region を持つ Source の集め方（R12・第 1 回 S1）**: `range.holdersOf(store, resource)` は、その Resource を参照する全 Source（`sourceIds` ∪ `rangeOnlySourceIds`）を、**子 Source なら `parentId` の親に読み替えて**重ねずに返す（スタイルの子の Resource の `sourceIds` は子の id で、region は親の id で保存されるので、子の id のまま `listRegions` を引くと 0 件になる。F31）。`range.remainingRegions(store, resource, exceptId)` は `holdersOf` の各 Source の `listRegions` のうち **`pinned: true`** で、`id !== exceptId` の region（`status` は問わない。`partial`・`canceled` も固定を持つ）。

**`releaseRange(regionId, { keep })`**: region を消し、**他の region に入らないタイルの固定を外す**。既定で Entry も消す（その Source だけが参照する Resource に限る）。`{ keep: true }` なら固定だけ外す。手順（直列の中。持ち主の一覧 `owners` は `control` が `ownerIdsOf` で作って渡す。R1）:

1. region を読む（無ければ `attribute-invalid`（`regionId`）。他の Source の region なら同じ）。その Source のジョブが動いていれば（`ctx.job?.sourceId === id`）`fetch-busy`（R48）
2. **タイルの Resource**（`owners` の Resource のうち `type: 'tile'`）ごとに、`remainingRegions(store, resource, regionId)` の `normalized` を集める
3. region の範囲を `enumerate` し（t3 と同じ生成器。座標の直しも同じ。残る region の範囲も同じ関数で Resource の座標に直す）、`entriesAtZoom(resourceId, z)` の中から box に入るキーを選び、残る region のどれにも入らないキーを、`keep` か **共有の Resource**（`!isExclusiveTo(resource, owners)`）なら `setPinned(keys, 0)`、そうでなければ `deleteEntries(keys)`。200 件ずつ
4. **非タイル資源（R11）**: `owners` の Resource のうち `type !== 'tile'` のものごとに、`remainingRegions(store, resource, regionId)` が 0 件のときだけ、その Resource の Entry（`entriesOf`）の固定を外す（`keep` でなく排他の Resource なら消す）。2 つのスタイルが同じグリフを共有して両方が region を持つとき、片方の最後の region の解放では外れない
5. `deleteRegion`

**`clean(range?, { force? })`**（`WeiwudiSource.clean` の引数を足す）: その Source のジョブが動いていれば `fetch-busy`（R48。旧 API の `clean` の `map-busy` と同じ考え）。

- **範囲あり**: `normalizeRange` で範囲を作り、**その Source だけが参照するタイルの Resource**（`isExclusiveTo(resource, owners)`）について、範囲の中のキーを `deleteEntries(keys, { unpinnedOnly: true })`（固定は tx の中で見直して残す。第 1 回 M11）。`{ force: true }` なら `deleteEntries(keys)` で固定も消し、範囲に重なるその Source の region を `patchRegion` で `partial` にする（完了済みの region の一部が無くなったため）。**共有の Resource の Entry は `force` でも触らず、他の Source の region も書き換えない**（他の Source のオフラインを壊さない。R49・第 1 回 L）
- **範囲なし**: 今の動き（排他の Resource の `clearEntries`）の前に `releaseAllOf(store, id, owners, { keep: true })` を呼ぶ（全 region を消し、共有の Resource の固定を R12 の規則で外す。第 1 回 M12）

**`releaseAllOf(store, sourceId, owners, { keep })`（P1・O-3・R47・第 1 回 M12）**: その Source の全 region を、1 つずつ上の `releaseRange` の手順 2〜5 で解放する（共有の Resource は固定を外すだけ。範囲だけで参照する Resource に限らない）。`remove()` と範囲なしの `clean()` の両方から `keep: true` で呼ぶ（排他の Resource の Entry は、その後の `applyRemove`／`clearEntries` が消す）。`remove()` の順: ジョブ中なら `fetch-busy` → `releaseAllOf` → 子を外す → `applyRemove`（`deleteSource` が残りの region を同じ tx で消す。F1）。`registry` は触らない。

**文書**: `docs/api` の英日に `releaseRange`・`clean(range, opts)`・`force` と region の `partial`・「共有の資源の Entry は `releaseRange` の既定でも `force` でも消さず固定だけ外す」・解放の幾何は Resource を参照する全 Source（スタイルは親）の固定つきの region で見ること・非タイル資源の固定の規則（R11）・**ジョブ中の `clean`・`remove`・`releaseRange` は `fetch-busy`（先に `cancel()` する）**。仕様 §7.2 の解放の表に R11・R12・R47〜R49 を書く。

### 試験

`release.test.ts`:

- 重なる 2 つの region A・B（同じ Source）: A を解放 → A だけに入るタイルが消え、重なりは固定のまま残る。`keep: true` では固定だけ外れて本体が残る
- 別の Source が同じ Resource に持つ region C と重なる A を解放 → 重なりは残る（R12）。共有の Resource の A だけのタイルは固定が外れるだけで本体は残る
- **共有の子の Resource（第 1 回 S1）**: 2 つのスタイル S・T が同じタイルの Resource を子として共有し（`sourceIds` は子の id）、両方が region を持つ → S の region を解放しても、T の region に入るタイルは固定のまま（子の id を親に読み替えて T の region を数える）
- **共有のグリフ（第 1 回 S1）**: S・T が同じグリフの Resource を共有し、両方が region を持つ → S の最後の region を解放してもグリフの固定は残る。T の最後の region も解放すると外れる
- 非タイル資源: region が 2 つあるうち 1 つを解放 → スタイル・グリフの固定は残る。最後の region を解放 → 外れる（R11）。`pin: false` の region は固定を持つ region に数えない
- `clean(range)` が範囲の中の固定されていない Entry だけ消し、固定は残る。`force: true` で固定も消え、重なる region が `partial`。共有の Resource の Entry は `force` でも残り、他の Source の region は `complete` のまま
- `clean()` が regions を消し、共有の Resource の固定が外れる（M12）
- `remove()` で、その Source の region のために付けた固定が、共有の Resource（`sourceIds` の共有と範囲だけの参照の両方）で外れ、他の Source の region の分は残る（P1・M12）
- ジョブ中の自分の Source の `releaseRange`・`clean()`・`clean(range)`・`remove()` が `fetch-busy`。別の Source のジョブ中は通る
- `count`・`bytes`・`pinnedBytes` が全件の集計と一致（種を固定した 100 回の取得・解放・clean）

`control.test.ts`・`client.test.ts` への追記: op の形・直列に通ること・`regionId` の検査・`fetch-busy`。

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0
- `build` の後、`node_modules/.bin/tsc -p tests/dts/tsconfig.json` が exit 0（`releaseRange`・`clean` の引数）
- `grep -c 'releaseRange' docs/api/weiwudi.md docs/api/weiwudi.ja.md README.md README.ja.md` がいずれも 1 以上
- `grep -c 'parentId' src/range.ts` が 1 以上（子を親に読み替える。S1）
- 水準 2 のレビューの記録が台帳にある

---

## m4-t6: 全体上限 `setLimits` と `QuotaExceededError` の再試行（仕様 §7.1・P7・I7b）

コミット種別: `feat:`（`setLimits`。旧 API の挙動が §9 の既知の変化として変わる）。**水準 2 のレビュー**

### 対象ファイル

`src/store.ts`・`src/core.ts`・`src/control.ts`（op `setLimits`）・`src/weiwudi.ts`・`tests/unit/limits.test.ts`（新規）・`tests/unit/store.test.ts`・`tests/unit/core.test.ts`・`tests/unit/client.test.ts`（追記のみ）・`tests/unit/legacy-storage-failure.test.ts`・`tests/e2e/quota.spec.js`（結果が変わる行の書き換え。台帳に書く）・`tests/dts/page-consumer.ts`（追記）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・README の英日・仕様 §7.1・§9

### 作るもの

**全体の数（R15・第 1 回 M13）**: `kv` の `totals`（`{ bytes, pinnedBytes, count }`）を、Entry を増減する全操作（`commitEntry`・`clearEntries`・`deleteResource`・`deleteEntries`・`setPinned`・`pruneGlyphParts`・`evictGlobal`）が **同じ tx** で直す（`S_KV` を tx に足す。`deltas` の処理を共有する関数で）。`deleteResource` は今は Resource を読まずに消すので（F30）、同じ tx で消す前に Resource を読み、その `count`・`bytes`・`pinnedBytes` を差し引く。`totals` が無い（既存の開発用 DB）ときは、**その書き込みの tx の中で** `resources` の `getAll` の和から作ってから差分を足す（tx の外で作ると同時の書き込みとずれる。`resources` は全操作の tx に入っている）。移行（t7）の `putEntry` は `commitEntry` を通るので、ここで足りる。

**`setLimits({ maxBytes })`**: `kv` の `limits` に保存。`undefined` で外す。`maxBytes` は 0 以上の有限の整数（外れたら `attribute-invalid`）。`maxBytes: 0` は「何も保存しない」の意味になる（`commitEntry` の `maxBytes > 0` の規則のまま。`cacheMaxBytes: 0` と同じ）ことを文書に書く（第 1 回 L）。`evictScopesFor` は `limits.maxBytes` があれば **`resourceIds` を持たない要素**（全体）を 1 つ足す。`commitEntry` はその要素を `[pinned, accessedAt]` の索引（`[0]` から昇順）で退避する（t1 の cursor の併合と同じ関数。索引が違うだけ）。予算は `totals.bytes − totals.pinnedBytes`。

**再試行（R16）**: `core.save` は `putEntry`／`putGlyphParts`／`flush` が `quota`（`WeiwudiError.from(err).code === 'quota'`）で失敗したとき、`store.evictGlobal(ceil((totals.bytes − totals.pinnedBytes) × 0.1))`（固定以外を全体 LRU で古い順に消す。`[pinned, accessedAt]` の cursor）を 1 回行い、**1 回だけ再試行**する。再試行も失敗したら `quota`。旧 API も同じ経路（`serve` が 1 つ）。仕様 §9 の既知の変化に「容量超過のとき、固定以外を全体の 10% 退避して 1 回再試行する（1.1.x は保存しなかった）」を足す。

**文書**: `docs/api` の英日に `setLimits`・全体上限と `cacheMaxBytes` の関係（両方を満たす）・`maxBytes: 0` は何も保存しないこと・再試行。README の英日の機能一覧に 1 行。

### 試験

`limits.test.ts`:

- `setLimits({ maxBytes })` の後、2 つの Source の Entry の和が上限を超えると、Source をまたいで `accessedAt` の古い順に消える。固定は消えない
- `cacheMaxBytes` と全体上限の両方があるとき、両方を満たす
- `totals` が全件の集計と一致（種を固定した 100 回。`evictGlobal`・`deleteResource` を含む全操作を混ぜる）
- `totals` の無い DB で最初の保存が、同じ tx の `resources` の和から作る（作る途中に別の保存を挟んでもずれない）
- `deleteResource` の後に `totals` から消した Resource の分が引かれている
- `setLimits({ maxBytes: 0 })` の後は何も保存されない（配信は続く）
- `setLimits({})` で外れる。不正な値は `attribute-invalid`

`core.test.ts`・`store.test.ts` への追記: 保存の abort（`QuotaExceededError`）を 1 回だけ起こす偽物で、退避が走り再試行が成功し `x-weiwudi-error` が無い。2 回起こすと `quota`。固定だけで 10% に足りないとき退避は 0 件で再試行だけ。

`legacy-storage-failure.test.ts` の「保存の abort → 保存されない」は、abort が 2 回続く形に書き換え（結果の `quota` は変わらない）、「1 回なら再試行で保存される」を 1 件足す（台帳に書く。m2 R15）。`quota.spec.js`（実ブラウザ）は上限 1 byte なので再試行も失敗し `quota` のまま（確かめて記録。変わらなければ触らない）。

`client.test.ts`・`page-consumer.ts`: `Weiwudi.setLimits`。

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0。`quota.spec.js` が passed
- `build` の後、`grep -c 'static setLimits(' dist/weiwudi.d.ts` が 1 以上
- `grep -c 'setLimits' docs/api/weiwudi.md docs/api/weiwudi.ja.md README.md README.ja.md` がいずれも 1 以上
- `grep -c '10%' docs/api/weiwudi.md docs/api/weiwudi.ja.md` がどちらも 1 以上（再試行の説明。C-O8 と同じ考えで文のまま grep する）
- 水準 2 のレビューの記録が台帳にある

---

## m4-t7: 旧 DB からの移行（仕様 §14.2・I7a・I7c・P5）

コミット種別: `feat:`（旧 API の利用者のキャッシュを引き継ぐ）。**水準 2 のレビュー**

### 対象ファイル

`src/migrate.ts`（新規）・`src/legacy.ts`（第 1 段の待ち・読み通し・`clean`／`delete` の旧 DB の始末・`migrationDeps` の export・`\0` の拒否。文面は包括の `Error: …` の文字列で `legacy.ts` に置き、`errors.ts` の表の 16 行は触らない）・`src/context.ts`（`maintenance` の項目）・`src/weiwudi_gw_logic.ts`（`runMaintenance` に `migrateStep`）・`tests/unit/migrate.test.ts`（新規）・`tests/unit/legacy-store-repair.test.ts`（§13 の表の「移す」3 件を足す。追記のみ）・`tests/unit/legacy-changes.test.ts`（`\0` の拒否。追記のみ）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・README の英日・CHANGELOG は t11・仕様 §9・§14.2（`kv.settingsCopied` を `migration.stage` に直す。第 1 回 L）

### 作るもの

**依存の注入（第 1 回 S4・R50）**: `migrate.ts` は §3 の表どおり `store`・`constants`・`errors` だけを import する（`legacy`・`core` は import できない。F27）。地図の登録と退避の範囲は関数で受ける:

```ts
export interface MigrateDeps {
  /** legacy.registerMap（Resource は legacy.resourceOf。登録の形は legacy に 1 つ） */
  registerMap(store: Store, setting: MapSetting, t: number): Promise<void>;
  /** core.evictScopesFor */
  evictScopesFor(store: Store, resource: ResourceMeta): Promise<EvictionScope[]>;
}
```

`legacy.ts` が `export const migrationDeps: MigrateDeps = { registerMap, evictScopesFor }`（`registerMap` は今の非公開の関数のまま中身を変えない。`evictScopesFor` は `core` から）を持ち、`legacy` の中の呼び出し（第 1 段の待ち・読み通し）と、配線（`weiwudi_gw_logic` が `migrateStep(ctx, migrationDeps)` を `runMaintenance` に足す）が同じものを渡す（hook の `pickCredentialSource` と同じやり方。写して持たない）。`Context` は型だけを import する。

**状態（`kv` の `migration`）**: `{ stage: 'pending' | 'settings' | 'tiles' | 'done'; maps: { mapID: string; status: 'pending' | 'copying' | 'done' | 'failed'; lastKey?: string; recordFailures: number; batchFailures: number }[]; pendingDelete: string[]; startedAt; updatedAt }`。無ければ `pending`。`maps` は配列（`mapID` を項目名にしない。`__proto__` などの名前で壊れない）。`pendingDelete` は `migration` の直下（第 1 回 M6 の 6）。`stage` が `done` になったらメモリにも覚え（`ctx.maintenance.migrated`）、以後の契機で IndexedDB を読まない（`failed` の地図の一覧もメモリに写す）。

**旧 DB の有無（R17）**: `indexedDB.databases()` があれば、名前が `Weiwudi` か `Weiwudi_` で始まるものを集める。無い環境（古い Firefox）では `Weiwudi` を `indexedDB.open('Weiwudi')`（版なし）で開き、`mapSetting` が無ければ空で完了して **自分で作った空の DB は消す**（接続を閉じてから `deleteDatabase`）。

**旧 DB の接続（第 1 回 M6）**: 旧 DB は使うたびに開いて閉じる。`onversionchange` で閉じる。`deleteDatabase` の前に必ず自分の接続を閉じる（閉じないと自分で `blocked` になる）。

**第 1 段（`settings`。第 1 回 M5）**: `migrate.ensureSettings(ctx, deps)` は、`Weiwudi.mapSetting` の全件を `getAll` 1 回で読み、地図ごとに `sources` に無ければ `deps.registerMap` で書く（**既に `sources` にあれば触らない**。新しい版で先に `add` した地図を上書きしない）。`mapSetting` が無い（#47 の壊れた DB）・DB が無いなら空で完了。`maps` に `tileCache` を持つ `mapID` を `pending` で並べる。`databases()` で見つかった `Weiwudi_<mapID>` のうち `mapSetting` に無い孤児は、配信できないのでその場で `deleteDatabase` する（`blocked` なら `pendingDelete`）。進行中の Promise は `ctx.maintenance.settings` に 1 つ持って共有する。**旧 API のハンドラ（`handleLegacy`。`ping` を除く）は、`stage` が `pending`・`settings` の間はこの Promise を待ってから進む**（SW の更新直後の最初の要求でも地図が `sources` にあり、読み通しが効く）。第 1 段が失敗したら待ちは捨てて進み、`getSetting` は `sources` に無ければ `migrate.readLegacySetting(mapID)` で `mapSetting` を見る（次の契機で第 1 段をやり直す）。

**第 2 段（`tiles`。第 1 回 M5・M6）**: `migrateStep(ctx, deps)` は `maps` の `pending`／`copying` を 1 つ選び（並びの順）、`Weiwudi_<mapID>.tileCache` を **`IDBKeyRange.lowerBound(lastKey, true)`**（`lastKey` が無ければ先頭）から `openCursor` で **200 件**読む（1 バッチ）。tx の外で `blob.arrayBuffer()` に変換し、レコードごとに:

1. 新 DB に同じキー（`map:<mapID>\0<z_x_y>`）があれば（読み通しで先に移したもの）旧レコードを消すだけ
2. `store.getResource('map:<mapID>')` が無ければ、このバッチをここで止める（`lastKey` を進めない。旧レコードは残して次の契機で。Resource の無い書き込みは捨てられるため。F29）
3. `store.putEntry`（`key`・`fetchedAt = epoch`・`accessedAt = accessedAt ?? epoch`・`z, x, y` は `z_x_y` を分解・`size = blob.size`・`pinned: 0`・`contentType = headers['content-type']`・`headers` は名前を小文字にして `constants.DROPPED_HEADERS` の 4 つと `x-weiwudi-*` を落とす（t1 で移した一覧。`core.copyHeaders` と同じ規則）・`evict` は `deps.evictScopesFor`）。**`saved: true` のときだけ旧レコードを消す**（別 tx）。`saved: false` で Resource が有る（2 で確かめた）のは単体で `cacheMaxBytes` を超える・`maxBytes` が 0 の場合で、新しい規則でも保存されないので旧レコードも消す（落とす）
4. 1 レコードの失敗（`blob` が無い・変換の失敗）は飛ばして続け、`recordFailures++`（数えるだけ。旧レコードは残す）

バッチの最後に `lastKey` をそのバッチで読んだ最後のキーにして `kv` に書く（飛ばしたレコードが先頭に溜まっても、毎回同じ 200 件を読み直さない）。cursor が尽きたらその地図は `done` で、**その場で `Weiwudi_<mapID>` を `deleteDatabase`**（`blocked` なら `pendingDelete`）。`Weiwudi_<mapID>` に `tileCache` が無ければ `done`。バッチの開始の失敗（`open` の失敗など）は `batchFailures++` で、**3 回で `failed`**（読み通しのまま残す）。

**契機**: `migrateStep` は `runMaintenance` の中（t2 の `ctx.maintain`）で、第 1 段が終わっていなければ第 1 段、終わっていれば 1 バッチだけ進める。進行中の Promise は 1 つ（同時の契機で 2 バッチ走らせない）。`activate` は待たせない。`pendingDelete` があれば、SW の起動後の最初の契機で消し直す（§9「旧 DB の削除は次の起動へ回す」）。

**読み通し（R18・第 1 回 M5）**: `legacy.getImage` は、その `mapID` が `done` でないとき（`stage` が `done` なら `failed` の地図だけ）、`serveTile` の前に `migrate.pullTile(ctx, deps, mapID, z, x, y)` を呼ぶ: 新 DB にキーが無く、`Weiwudi_<mapID>.tileCache` に `z_x_y` があれば、第 2 段の 2〜3 と同じ規則で `putEntry` し、`saved: true` のときだけ旧レコードを消す。その後は `serve` が通常どおり Entry を見る（配信の経路は 1 つのまま）。`pullTile` の失敗は飲み込んで `serve` に進む。

**旧 API の `clean`・`delete` との順（第 1 回 M6）**: 移行の途中で旧 API の `clean` が来たら、新 DB の `clearEntries` の後に `migrate.forgetLegacyTiles(mapID)` で `Weiwudi_<mapID>` を `deleteDatabase` し、その地図を `done` にする（後のバッチが消したタイルを戻さない）。`delete` も同じで、さらに `maps` からその地図を外す（1.1.1 の `delete` も `Weiwudi_<mapID>` を消していた。F13）。`legacy.ts` は IndexedDB を直接触らない（`migrate` の関数を呼ぶ）。

**完了**: 全地図が `done` か `failed` になったら `Weiwudi`（`mapSetting`。第 1 段で写し終えている）を `deleteDatabase` し、`stage` を `done` にする（`blocked` なら `pendingDelete` に足し、`stage` は `done` にする）。`failed` の地図の `Weiwudi_<mapID>` は残し、その地図だけ読み通しを続ける。

**`\0` の `mapID`（I7c・R19）**: `add` で `mapID` に `\0` が含まれていれば `Error: MapID must not contain a NUL character` の文字列で拒否する（新しい文面。包括の形。§9 の既知の変化に足す）。移行でも `\0` を含む `mapID` の地図は `failed` にして飛ばす（旧 DB にも残す）。

**文書**: README の英日に「1.1.x のキャッシュは最初の要求から順に引き継ぐ（数 GB でも止まらない。移行中もオフラインで読める）。1.1.x へ戻しても壊れない（取り直しになる）」。`docs/api` の英日の旧 API の節に同じ 2 文。仕様 §14.2 に R17〜R19・R50・R51 を書き、`kv.settingsCopied` を `migration.stage` に直し、§9 の既知の変化に `\0` の拒否を足す。

### 試験

`migrate.test.ts`（`fake-indexeddb` の `IDBFactory` に旧 DB を作る。F22 の書き方。旧レコードの `epoch` は**試験の今の時刻**にする（24 時間を過ぎると `stale`・`refresh` になり「hit」を確かめられない。第 1 回 L））:

- 旧 `Weiwudi`（`mapSetting` 2 件）と `Weiwudi_a`（`tileCache` 450 件）・`Weiwudi_b`（0 件）→ 契機 1 回で第 1 段が終わり `sources` に 2 件。続く契機 3 回で `a` の 450 件が新 DB に入り（200・200・50）、`b` は `done`、`Weiwudi_a`・`Weiwudi_b` は地図が `done` になった契機で消え、最後に `Weiwudi` も消えている。`count`・`bytes` が合う
- 変換: `epoch`→`fetchedAt`・`accessedAt` が無ければ `epoch`・`z_x_y`→`z, x, y`・`size`・`contentType`・本体のバイト列が同じ（ArrayBuffer）・`Set-Cookie` と `X-Weiwudi-Status` が落ちる（大文字の名前でも）
- 途中で止める（契機を 1 回）→ 旧にも新にも残る → 続きの契機で冪等に完了（二重に数えない）
- **最初の要求（第 1 回 M5）**: 旧 DB だけがある状態で SW を起動し、契機を待たずに `/api/cache/a/z/x/y` を 1 回 → 第 1 段を待ってから読み通しで `hit`。オフラインでも 200
- 読み通し: 第 2 段の途中で `/api/cache/a/z/x/y`（新に無く旧にある）→ `hit` で配信され、新 DB に移り旧から消える。オフラインでも配信される
- **`saved` を見る（M5）**: `cacheMaxBytes` を単体より小さくした地図では、旧レコードは移らずに消える。Resource を消した直後の契機では旧レコードが残る
- 第 1 段が失敗した（`mapSetting` の読み出しの reject）とき、`/api/info?mapID=a` が `mapSetting` から読める
- `sources` に既にある `mapID` は上書きしない
- **飛ばしたレコード（第 1 回 M6）**: 先頭の 250 件が壊れた記録（`blob` が無い）の地図でも、契機を重ねると最後まで進み（`lastKey`）、`recordFailures` が 250・`batchFailures` が 0。`open` が 3 回失敗する地図が `failed` になり、その `Weiwudi_a` は消えず読み通しが続き、他の `done` の地図の DB は消えている
- **旧 API の操作（M6）**: 第 2 段の途中で旧 API の `clean` → 以後の契機で消したタイルが新 DB に戻らない。`delete` → `Weiwudi_a` が消え、`maps` から外れる
- 孤児の `Weiwudi_c`（`mapSetting` に無い）は第 1 段で消える
- `blocked`（閉じない接続）で `deleteDatabase` が待ちになっても契機は終わり、`pendingDelete` に残り、次の SW の最初の契機で消える。自分の接続は `deleteDatabase` の前に閉じている（自分で `blocked` にならない）
- `indexedDB.databases` が無い factory で、旧 DB が無ければ空で完了し、自分で作った `Weiwudi` が残らない
- `\0` を含む `mapID` の `add` が文字列で拒否され、移行では `failed`
- `mapID` が `__proto__` の地図も移る（`maps` が配列）

`legacy-store-repair.test.ts` への追記（§13 の表の「移す」）: 旧 `Weiwudi` が store を持たなくても移行が空で完了して `add` が通る／旧 DB が `blocked` でも `delete` は成功し、旧 DB の削除は次の起動へ回る。

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0。`legacy-store-repair.test.ts`・`legacy-changes.test.ts` は追記だけ
- `grep -c 'fetch(' src/migrate.ts` が 0、`grep -c 'indexedDB' src/legacy.ts` が 0（旧 DB を触るのは `migrate.ts` だけ）
- `grep -n "from './" src/migrate.ts | grep -v "import type" | grep -vc "'./store'\|'./constants'\|'./errors'"` が 0（S4。`deps.test.ts` でも落ちる）
- `grep -c 'MapID must not contain a NUL character' src/legacy.ts docs/api/weiwudi.md docs/api/weiwudi.ja.md` がいずれも 1 以上
- `grep -c 'settingsCopied' docs/superpowers/specs/2026-11-02-new-interface-spec.md` が 0
- 水準 2 のレビューの記録が台帳にある

---

## m4-t8: 制御と門番の堅牢化（I2・I3・I4・I6・I8・I10・I11・L5〜L8）

コミット種別: `fix:`（`warnings` の code 1 つを足す）

### 対象ファイル

`src/hook.ts`・`src/control.ts`・`src/url_pattern.ts`・`src/spec.ts`・`src/store.ts`（`entriesAtZoom` は t1 で足した。触らない）・`tests/unit/control.test.ts`・`tests/unit/hook.test.ts`・`tests/unit/spec.test.ts`・`tests/unit/url-pattern.test.ts`・`tests/unit/m3-credentials.test.ts`（追記のみ）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・`README.md`・`README.ja.md`・仕様 §4.3・§10・§12

### 作るもの

- **I2b（R38）**: `control.refreshTable` は `tableChanged` を `GATE_WAIT_MS` の `withTimeout`（`hook` から export する。今は非公開。F34）で待ち、超えたら今の失敗時と同じ（表を捨て、`[]` を返す。登録は成功）。I2a は直さず台帳に記録
- **I3（R41・第 1 回 M14）**: `statsOf` は `total` が決まる Source だけ、`count` を「`box` の中の Entry」で数える。**その Source だけが参照する Resource**（`isExclusiveTo(m, owners)` で範囲だけの参照でもないもの）は範囲外の要求を保存しない（範囲外は §6 の 1 で保存しない）ので Resource の `count` をそのまま使い、**共有の Resource と範囲だけの Resource だけ**、z ごとに `entriesAtZoom` を読んで `scaleTileBox(box, maxZoom, z)` に入るものを数える（t9 の 2 秒ごとの `stats()` で全 Entry のメタを読まない）。`update()` で範囲を狭めた後に残る範囲外の Entry は排他の Resource では数えてしまうが、`percent` を 100 で止めるので表示は壊れない。`percent = min(100, floor(count × 100 / total))`。`byResource` と `size` は今のまま（Resource の数）
- **I4a（R39・第 1 回 L）**: `control.post` の `failure(e)` で、`e` が `WeiwudiError`（印あり）でなく **DOMException**（`e instanceof DOMException`。IndexedDB の例外）で `from` が `internal` にするものだけを `storage`（`detail: { name }`）にする。`quota`・`db-blocked` は `from` のまま。`TypeError` など DOMException でない例外は `internal` のまま（Weiwudi の不具合を `storage` に紛れさせない）
- **I4b（R40）**: `register`・`update`・`remove`・`removeResource` の `serial` の中で例外が出たら `refreshTable(ctx, [])` を 1 回呼んでから投げ直す（表を古いまま固めない）
- **I8b（R34）**: `hook.tableChanged` の `postMessage` を 100 ms でまとめる（`ctx.table.notifyTimer`。最後の変更から 100 ms 後に 1 回）。受け手の `reload` は今のまま
- **L7（R35）**: `url_pattern` に `isSecretValue(v)`（`Bearer`・`Token`・`Basic` と空白を剥がして `sk.` で始まる。decode した値も見るのは呼び出し側）を置き、`spec.isSecretToken` と `url_pattern.isSecretPair` の両方がそれを使う。挙動の違いは「キーの残りのクエリから `Bearer sk.…` の値の項目も除く」だけ
- **L8（R36）**: `spec.normalizeMember` で、テンプレートのクエリのうち `credentialParams`（既定＋宣言）に無い名前の値が `^(pk|sk|tk)\.` に当たるとき、`warnings` に `credential-undeclared: <名前>` を足す（値は書かない。`sk.` は今のとおり拒否が先）。登録は成功。公開の code を §12・`docs/api` の表に足す
- **文書**: I6（別スコープの SW からの同時の登録は直列にならない）・I8a（署名つき URL は署名の項目を `credentialParams` に挙げる。SW は署名を作れない）・I8c（門番は利用者が評価の後に登録したルートより先に受ける。§4.3 と README）・L5（R34 の文に「上限は置かない。遅い上流を失敗にすると登録そのものが失敗するため」）・**I11（スタイルの URL がリダイレクトしても、資格情報を足す相手は登録 URL のオリジンと提供元だけ。リダイレクト先が返した本体の中の、登録 URL のオリジンの URL にも足すので、信頼できない上流へリダイレクトするスタイルの URL を登録しない。R44）**を英日に書く。I10・L6・I2a は台帳に記録だけ

### 試験

- `control.test.ts` への追記: `tableChanged` が解決しない（`buildTable` を止める）とき `register` が `GATE_WAIT_MS` 後に成功し `ctx.table.current` が消える／`stats` の `count`・`percent` が範囲の中だけ（共有の Resource に範囲の外の Entry を入れて 100 を超えない）／排他の Resource だけの Source の `stats` が `entriesAtZoom` を呼ばない（spy。M14）／DOMException の失敗が `storage`、`TypeError` は `internal`／`register` の途中の store の失敗の後に `tableChanged` が呼ばれている（spy）
- `hook.test.ts` への追記: 3 回の `tableChanged` で `postMessage` が 1 回（偽のタイマ）
- `url-pattern.test.ts`・`spec.test.ts`・`m3-credentials.test.ts` への追記: `?auth=Bearer%20sk.eyJ…` がキーから除かれる／`?mytoken=pk.abc` で `credential-undeclared: mytoken` が `warnings` にあり値が無い／`credentialParams: ['mytoken']` なら出ない／`sk.` は `credential-rejected` のまま

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0
- `grep -c 'isSecretValue' src/spec.ts src/url_pattern.ts` がどちらも 1 以上、`grep -ci 'bearer' src/spec.ts` が 0（判定も注記も `url_pattern` へ移す。1 か所）
- `grep -c 'credential-undeclared' docs/api/weiwudi.md docs/api/weiwudi.ja.md` がどちらも 1 以上
- `grep -c 'X-Amz-Signature' README.md README.ja.md` がどちらも 1 以上（I8a の例として）
- 文書の grep（第 1 回 L）: I6 は `grep -c -i 'scope' docs/api/weiwudi.md` の該当の文と `grep -c 'スコープ' docs/api/weiwudi.ja.md` が 1 以上、I8c は `grep -c -i 'gate' README.md` と `grep -c '門番' README.ja.md` が 1 以上、L5 は `grep -c -i 'no timeout\|no upper limit' docs/api/weiwudi.md` と `grep -c '上限は置かない\|上限を置かない' docs/api/weiwudi.ja.md` が 1 以上、I11 は `grep -c -i 'redirect' docs/api/weiwudi.md` と `grep -c 'リダイレクト' docs/api/weiwudi.ja.md` が t8 の前より 1 以上増える（実装担当は書いた文に合わせて grep の語を台帳に記録してよい。語を変えたら台帳に書く）

---

## m4-t9: 開発用ページを新 API に直す（#41）

コミット種別: `feat:`（開発用ページ。配布物ではない）

### 対象ファイル

`index.html`・`public/demo-sw.js`（変えない見込み。変えるなら対象に足す）・`README.md`・`README.ja.md`（開発サーバの節の機能一覧）・`tests/unit/demo-third-party.test.ts`（`index.html` の外部の読み込みに `integrity` があることの既存の試験。通ることを確かめる）

### 作るもの

#41 の完了条件は「現行の設計に合わない操作が残っていない」「開発用ページから基本動作を確認できる」。`index.html` を新 API で書き直す（R25）:

- `Weiwudi.registerSW('./demo-sw.js', { scope: './' })` のまま。登録は `Weiwudi.register({ kind: 'raster', id: 'osm_demo', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', bounds: [139.71, 35.63, 139.81, 35.73], minZoom: 14, maxZoom: 17 })` にし、Leaflet には `source.url` を渡す（実 URL の捕捉。旧 API の `map.url` を使わない）
- **OSM のタイルの利用規約（第 1 回 L・R54）**: tile.openstreetmap.org の規約はまとめての取得（範囲取得そのもの）を禁じる。開発用ページの「表示範囲を取得」は `estimate` が **50 枚を超えたら取得せずに断り**、画面と README の英日に「OSM のタイルでの範囲取得は動作確認の最小限に。まとめての取得は利用規約で禁じられている。本番は自前か規約で許された上流を使う」を書く
- 操作: **「表示範囲を取得」**（Leaflet の `getBounds()`・現在のズーム〜17 で `estimate` を見せてから `fetchRange`。進捗は `proceed`、完了で `regions()` を表示）・**「region を解放」**（一覧から選んで `releaseRange`）・**「キャッシュを消す」**（`clean()`）・**「全体上限」**（`setLimits` の入力）。旧 API の `fetchAll` のボタンは消す
- 表示: `stats()`（`count`・`size`・`percent`）・`usage()`（`byProvider`）・`regions()` の一覧・`warnings`・`opaque` イベントの通知。2 秒ごとの `stats()` の更新は残す
- 外部の読み込みは Leaflet のまま（`integrity` 付き。既存の試験が見る）。MapLibre は足さない（m3 R15。デモの対象はラスタの捕捉と範囲取得）
- README の英日の「The demo features」の 4 項目を新しい操作に直す。画面写真は無い（F17）ので rule-0002 の撮り直しは無い

### 試験

- `pnpm -C <clone> run build:demo` が exit 0（CI と同じ）
- `demo-third-party.test.ts` が exit 0（`integrity` の検査）
- 実ブラウザの確認（実装担当が手元の `pnpm dev` で Chromium で開き、登録 → 表示範囲の取得 → オフライン（DevTools）で表示 → 解放、の 4 手順の結果を台帳に書く。自動化は t10 の e2e が別のページで行う）

### 受け入れ条件

- `grep -c 'registerMap\|fetchAll' index.html` が 0
- `grep -c 'fetchRange' index.html` が 1 以上、`grep -c 'Fetch all tiles' README.md` が 0
- `grep -c -i 'tile usage policy\|usage policy' index.html README.md` と `grep -c '利用規約' README.ja.md` が 1 以上（R54）
- 上の試験と既存の単体試験が exit 0

---

## m4-t10: 範囲取得・解放・移行・全体上限の e2e

コミット種別: `test:`

### 対象ファイル

`tests/e2e/range.spec.js`・`tests/e2e/migrate.spec.js`・`tests/e2e/fixtures/range-page.html`・`tests/e2e/fixtures/legacy-seed.html`（新規）・`tests/e2e/fixtures/tile-server.mjs`（端点を足すときだけ）・`tests/e2e/offline.spec.js`（追記のみ）

### 作るもの

m3-t9・m2-t9 の形（固定の端点・`route` で実ネットワークへ出ないことの計数・`@chromium-only` のタグ）に合わせる。

`range.spec.js`（`localhost:5174` の `/tiles/{z}/{x}/{y}.png` と `/style/*` を使う。テスト名はこの文字列のまま）:

| テスト名 | 期待 | タグ |
|---|---|---|
| `fetches a range and serves it offline` | `fetchRange({ bounds, minZoom: 0, maxZoom: 2 })` の `finish` の後、オフラインで 21 枚が 200・`stats().percent` が 100・`regions()` が `complete` 1 つ | `@chromium-only`（`setOffline`） |
| `pins fetched tiles against cacheMaxBytes` | 固定した範囲の後、`cacheMaxBytes` を超える通常の取得で固定が消えない（`byResource` の `count` が範囲の枚数以上） | — |
| `releases a range and frees entries` | `releaseRange(id)` の後、`regions()` が空・`stats().count` が 0・次の要求が `miss` | — |
| `keeps overlapping tiles on release` | 重なる 2 つの region の片方を解放 → 重なりが `hit` | — |
| `fetches a style range with glyphs` | スタイルの `fetchRange` の後、オフラインで スタイル・TileJSON・タイル・`{fontstack}/0-255.pbf`・`sprite@2x.json` が 200 | `@chromium-only` |
| `resumes a job after the service worker restarts` | ジョブの途中で CDP `ServiceWorker.stopAllWorkers` → ページ側が 30 秒以内に `job/resume` → `finish`（偽のタイマは使わず、`fetchRange` の Promise が解決することで見る。`test.slow()`） | `@chromium-only`（CDP） |
| `reports an opaque event for a server without cors` | `/nocors/` のテンプレートの `fetchRange` → `stop`（`opaque`）と `opaque` イベント | — |
| `enforces a global limit` | `setLimits({ maxBytes })` の後に 2 つの Source を取ると全体が上限以下 | — |
| `cancels a running job` | `cancel()` → `fetchRange` が `status: 'canceled'` で解決 | — |

`migrate.spec.js`（`legacy-seed.html` が 1.1.1 の形の旧 DB（`Weiwudi.mapSetting` と `Weiwudi_x.tileCache` に Blob）を IndexedDB に直接作る。**`epoch` はページを開いた時刻**（24 時間を過ぎると `stale`・`refresh` になる。第 1 回 L）。SW を登録してから `/api/cache/x/z/x/y` を読む）:

| テスト名 | 期待 | タグ |
|---|---|---|
| `serves legacy tiles through the new store` | 旧 DB のタイルが `hit` で配信され、`Weiwudi.retrieveMap('x')` が読める | — |
| `migrates every legacy tile and drops the old databases` | 要求を繰り返して `indexedDB.databases()` に `Weiwudi_x` も `Weiwudi` も無くなり、`usage()` の `count` が旧の件数 | — |
| `serves migrated tiles offline during migration` | 移行の途中でオフライン → 旧 DB にだけあるタイルも 200（読み通し） | `@chromium-only` |

`offline.spec.js` への追記: `serves every tile offline after fetchAll` の後に `usage()` の `count` が 21（旧 API の地図が `usage` に入る。既存の形の確認）。

### 受け入れ条件

- `pnpm -C <clone> exec playwright test tests/e2e/range.spec.js tests/e2e/migrate.spec.js --project=chromium --reporter=list` が exit 0（12 件 passed）。3 回続けて揺れなし（m3-t9 と同じ）
- 既存の e2e がすべて passed
- 実ネットワークへ出ない: m3-t9 と同じ計数（`localhost:5173`・`5174` 以外が 0 件・`weiwudi.example.com` が 0 件）を各テストの最後に `expect`（Chromium の project だけ）
- `grep -rn '127\.0\.0\.1' tests/e2e/range.spec.js tests/e2e/migrate.spec.js tests/e2e/fixtures/range-page.html tests/e2e/fixtures/legacy-seed.html` が 0 件
- CI の `e2e-engines`（WebKit）が緑（タグの外した分だけ走る）

---

## m4-t11: 文書の総仕上げと `master` への合流（P4・P5・§14.1・§16）

コミット種別: `docs:`（文書の直し）と、合流の merge commit

### 対象ファイル

`README.md`・`README.ja.md`・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・`docs/api/sw.md`・`docs/api/sw.ja.md`・`CHANGELOG.md`・仕様 §12・§14・§16・state（進行役）

### 作るもの

- 文書から「m4」「m4 で」「upcoming」の予告を全部消し、事実にする（`docs/api` の「Codes reserved for the upcoming API: `opaque`」など）。README の英日の機能一覧（範囲取得・解放・保持期間・全体上限・移行・`mapbox://`・提供元・差し込み口・スタイル）を揃える
- `CHANGELOG.md` に `## [Unreleased]` の節を足し、新 API の追加（`Added`）と §9 の既知の変化（`Changed`。`text/html` の扱い・4 ヘッダ・`x-weiwudi-status`・`blocked` の文面・`fetchAll` の数え方・Range の素通し・容量超過の再試行・`\0` の拒否・旧 DB の移行）を 1 行ずつ書く。**版番号は変えない**（1.1.1 のまま。次の月次トレインが 1.2.0 にする。R26）
- 仕様 §14.1・§16 を事実に（「m4 の移行までの間、vector-cache は既存キャッシュを読まない」→ 移行済み）
- **I13**: `docs/api/sw.md`・`sw.ja.md` の `applyCredentials` の節を「いつ呼ばれ・何を足し・何を足さないか」の 3 段に整え、`credentialParams` の既定値（`url_pattern.DEFAULT_CREDENTIAL_PARAMS`）を表にする
- **合流**: `vector-cache` → `master` の PR を 1 つ（squash しない。merge commit）。本文に CHANGELOG の `Unreleased` の要約・移行の有無・水準 2 の記録を書く。合流の後、`vector-cache` は残す（次のトレインまでの直しの枝）

### 試験

- 5 コマンドが exit 0。`build` の後、**dist の 4 点（P4）**: `test -f dist/errors.d.ts`・`grep -c 'class WeiwudiError' dist/weiwudi.d.ts` が 1 以上・`grep -c 'export' dist/weiwudi.es.js` が 1 以上かつ `grep -c 'WeiwudiError' dist/weiwudi.umd.js` が 1 以上・`grep -c 'x-weiwudi-error' public/weiwudi-sw.js` が 1 以上（確かめた後で `git restore`）
- `node tests/dts/check-dts.mjs dist/weiwudi.d.ts`・`node tests/dts/check-dts.mjs dist/weiwudi_gw.d.ts`・`node_modules/.bin/tsc -p tests/dts/tsconfig.json` が exit 0

### 受け入れ条件

- `grep -c -E '\bm4\b|upcoming' README.md README.ja.md docs/api/weiwudi.md docs/api/weiwudi.ja.md docs/api/sw.md docs/api/sw.ja.md` がすべて 0
- `grep -c 'Unreleased' CHANGELOG.md` が 1、`git diff --quiet <BASE>.. -- package.json` が exit 0（版番号を変えない）
- I13: `grep -c 'api_key' docs/api/sw.md docs/api/sw.ja.md` がどちらも 1 以上（既定値の表）
- **t7 が合流済み**（`git log --oneline origin/vector-cache | grep -c 'm4-t7'` が 1 以上。P5・state の `merge_condition`）
- m4 の区切り（下）の全体レビュー・セキュリティ点検・水準 2 が終わり、台帳に記録がある
- `master` への PR の CI（`test` の Node 22・24 と `e2e-engines`）が緑

---

## m4 の区切りで確かめること

- 軽い道 §6 の全体のレビュー（水準 1 と、公開 API の差分に水準 2）・セキュリティ点検・要約
- セキュリティ点検で特に見るもの: 範囲取得の要求に付く資格情報が捕捉と同じ相手（オリジン・提供元）に限られ、選び方が `hook.credentialsForResource` 1 つであること（R3）・I11 の文書（R44）・`regions()`・イベント・`RegionInfo`・`stop` の文面に資格情報と URL のクエリが出ないこと（§10）・`job/resume` と `releaseRange` が他の Source の region を触れないこと・制御の送り手の検査（m3 R25）が新しい op にも効くこと・移行が旧 DB の `headers` から `set-cookie` などの 4 ヘッダを落とすこと・`probeNoCors` が資格情報を付けないこと
- 二重実装が無いこと: m3 の区切りの grep に加え、`grep -n 'fetch(' src/range.ts src/migrate.ts` が 0 件、`grep -n 'putEntry\|putGlyphPart' src/*.ts | grep -v '^src/store.ts' | grep -v '^src/core.ts'` が 0 件（`migrate.ts` は `store.putEntry` を呼ぶので、この grep の除外に `src/migrate.ts` を足す。移行は配信ではない）、`grep -n 'tileKeySuffix' src/range.ts src/migrate.ts` が 0 件（`migrate.ts` は旧キー `z_x_y` をそのまま使う。仕様 §5.3）
- 仕様 §7・§9・§11・§12・§14 を通して、t2〜t8 の試験の表と突き合わせる

## `master` への合流の条件（state の `branch_policy` と §16）

1. t7（移行）が `vector-cache` に合流済み（`merge_condition`）
2. m4 の区切りのレビュー・セキュリティ点検・水準 2 が合格
3. dist の 4 点（P4）と `tests/dts` が exit 0
4. CHANGELOG の `Unreleased` があり、版番号を変えていない（R26）
5. `master` への PR の CI が緑。合流は merge commit（履歴に各タスクの PR を残す）
6. 公開（npm の publish・1.2.0）は次の月次トレインの作業で、m4 では行わない

## #78 を邪魔しないこと（Range 要求の区画単位のキャッシュ。m4 の後）

#78 は Range 要求を固定の大きさの区画に分け、区画ごとに 1 件の Entry として保存する案（キーの suffix は「版（ETag）＋区画番号」、`fetchRange` は PMTiles の目次から範囲を求める）。m4 の設計は次の点でこれを塞がない。

- **Entry のキーの suffix は型ごとに自由な文字列**（`entryKey` が決める。tile は座標、glyph は fontstack、ほかは残りのパスとクエリ）。m4 の固定・解放・掃除は `EntryMeta` の `pinned`・`fetchedAt`・`accessedAt`・`z/x/y`（任意）だけを見て、suffix を解釈しない。区画の Entry を足しても t1〜t2・t6 はそのまま効く
- **region は `RangeSpec`（タイルの範囲）か `'all'` を持ち、タイルの Resource だけを幾何で解放する**（R11・R12）。#78 が「PMTiles の範囲取得」を足すときは、region の `normalized` に `kind: 'blocks'`（区画の列）を足し、`releaseRange` の分岐を 1 つ足せばよい。非タイル資源の固定の規則（R11）は区画にも使える
- **素通しは `core.passThrough` 1 つ**（hook・legacy・serve の守り）。#78 はこの 1 か所を「区画から 206 を組み立て、足りない区画だけ上流へ」に替える。m4 では素通しに資格情報を足さない（I9。#78 の設計で付け方が変わるため）
- 移行（t7）は旧 API の `tileCache` だけを扱い、新 store のスキーマ（`version: 1`）を変えない。#78 が区画の索引を足すなら版を上げるだけでよい
- `usage()` は Resource の `count`・`bytes` で数えるので、区画の Entry も自然に入る。`stats()` の `count`（t8 の I3 の後）は、範囲が決まる Source の共有・範囲だけの Resource だけを座標（`z/x/y`）で数え、ほかは Resource の `count` なので、座標を持たない区画の Entry は排他の Resource では `count` に入り、共有の Resource では範囲の中に数えない（`percent` はタイルの Source だけの値で、PMTiles の Source には `total` が無い）。#78 は区画の Source の `stats` を Resource の数で返せばよい（第 1 回 L）

## 事前点検で見てほしい範囲（第 2 回）

第 1 回の範囲（固定の規則・範囲取得の経路・ジョブの再開・グリフの束ね書き・全体上限と再試行・移行・申し送り・#78）は、末尾の反映の表のとおり直した。第 2 回は通して見たうえで、特に次を見てほしい。

1. **固定の規則の全体（R6・R11・R12・R46〜R49）**: 子を親に読み替える `holdersOf`・固定つきの region だけを数えること・共有の Resource は既定の解放でも消さないこと・成功のキー全部への `setPinned` が、`clean(range, { force })`・`remove()`・`clean()`・2 つのスタイルの共有で矛盾しないか
2. **退避の見積もりの式（R42）**: `deltas` と `old` の扱いが今の `getAll` の実装と同じ集合を消すか。全体上限（t6）の `totals` との組み合わせ
3. **ジョブの排他と終わり方（R5・R23・R45・R48）**: 同期の確保・`patchRegion` の条件・`gone` の `partial`・`job/resume` の 3 つの応答・自分の Source の操作の `fetch-busy` に、旧 API の `fetchAll` と並んだときの抜けが無いか
4. **移行（R50・R51）**: 第 1 段の待ち・`lastKey`・`saved` と `getResource` による判定・旧 API の `clean`・`delete` の順・地図ごとの DB の削除で、§14.2「移行の途中でも地図が欠けない」と「1.1.x へ戻しても壊れない」が保たれるか
5. **`hasEntries` をメタだけに戻す決定（R43）** と既存の試験 2 件の書き換え
6. **保守の契機（R9）**: `ping` を外した契機で、Weiwudi を使うページで掃除と移行が確実に進むか
7. 申し送りの表の 38 件が拾い先の「作るもの」と「試験」に入っているか

## Ruling

- R1: 範囲取得・解放は新しい `range.ts` に置き、`control.ts` が呼ぶ。依存は `hook`・`core`・`upstream`・`registry`・`context`・`store`・`spec`・`url_pattern`・`tile_math`・`style_body`・`constants`・`errors`。持ち主の一覧（`ownerIdsOf`）は `control` が作って引数で渡し、`range` は `style` を import しない。`weiwudi_gw_logic` の `ABOVE_ALL` に `range` を足す（第 1 回 M4） — `control.ts` は `url_pattern` を import できず（§3）、範囲取得は展開・照合・配信・store を使う。`registry.isExclusiveTo` は排他の判定の 1 か所。持ち主の一覧は `control` に既にあり（F33）、写すと二重実装になる。m3 の `style.ts` と同じ切り方 — 誤りなら `control.ts` が太るか、`range` の行に `style` を足す
- R2: 範囲取得の URL は `expandTemplate` で作り、同じテンプレートに `matchUrl` で照合して `MatchResult` を得て `serveResource` に渡す。キーは `entryKey` 1 つ — 展開からキーを直接組むと、捕捉のキー（`restQuery`・`{spriteSuffix}`・`tms`）と 1 字ずれただけで二重保存になる — 誤りなら照合の 1 回分だけ遅い
- R3: 範囲取得の要求は `new Request(url)`（`cors`・`same-origin` の既定）で `serveResource` を通し、資格情報は照合表の `credentialSources`（Resource × オリジン）から選ぶ — §4.5 の「テンプレートから作る要求」と同じ形で、捕捉と同じ相手にだけ資格情報を送る（m3 R5・m2 I2） — 誤りなら範囲取得だけ資格情報が付かない相手が出る（README に書く）
- R4: 範囲取得の CORS・認証の規則（§4.5-3・§4.6）は `range.ts` のジョブの側で、serve の応答の `x-weiwudi-error` と `upstream.probeNoCors`（`fetch(url, { mode: 'no-cors' })` 1 回。保存しない）で判定する — `createUpstream` は元の要求が `cors` のとき取り直さない（§4.5 の 4）ので、ジョブが確かめる。上流へ出す関数は `upstream.ts` に置いて「fetch は upstream だけ」を保つ — 誤りなら `createUpstream` に範囲取得の分岐を足す
- R5: region は `{ id, sourceId, range, normalized, status, pinned, total, error, errors, code?, createdAt, updatedAt }` を `regions` に持ち、進捗の位置は書かない。`range` は決めた項目だけを写し、`normalized` は取得のときの XYZ の範囲（`'all'` も取得のときの Source の範囲を固める）。`running` で `ctx.job` が無いか `ctx.job.regionId` が違うものは `regions()` で `partial` として見せる。終わりの書き込みは `patchRegion` で「有り・`running` のときだけ」。ページが閉じた（`gone`）ジョブは `partial`（第 1 回 M7・L） — §7.2「進捗の位置は持たない。再実行が再開」。SW が止まった region を `running` のまま見せると利用者が待ち続ける。終わりの書き込みを無条件にすると、途中の `clean()`・`remove()`・`force` の後に持ち主の消えた region を書き戻す（O-3 と同じ形）。`update()` で範囲が変わった後に解放すると、今の範囲で読み直したのでは取得した分の固定が残る — 誤りなら `interrupted` の値を足す（minor）
- R6（L1）: `commitEntry` は tx の中で読んだ `old.pinned` と `meta.pinned` の論理和を書き、`core.save` は `savedPinned` を読まない。`ServeInput.pin` が真のときだけ `meta.pinned = 1` — 上流を待つ間に `setPinned` が入っても固定が戻らない。外す側（`releaseRange`）と足す側が同時のときは足す側が勝つ（キャッシュなので安全側）。`ServeInput.pin` は近道で、範囲取得の固定の正本は R46 の `setPinned` — 誤りなら解放の直後の取得で固定が残る（次の解放で外れる）
- R7（L3）: `putGlyphParts` は連結後の大きさが予算を超えるとき、残す部分を `fetchedAt` の昇順に落として収める。新しい部分だけで超えるときだけ保存しない — 結合レコードは 1 Entry なので LRU では丸ごとしか消えず、新しい範囲が永久に入らない — 誤りなら古い範囲の再取得が増えるだけ
- R7'（P7・第 1 回 M1）: 退避は「Resource の `bytes − pinnedBytes` の和 ＋ この tx の `deltas` − 置き換える固定でない `old` の大きさ」で予算内なら走査せず、cursor でも同じキーを飛ばす。超えるときだけ `IX_LRU`（全体上限は `[pinned, accessedAt]`）の cursor を Resource ごとに開いて併合し、1 件ずつ消す — 上限つきの保存のたびに全件 `getAll` するのは 100 万 Entry で効かない（§5.4 の狙い） — 誤りなら cursor の数だけ要求が増える（Resource の数は少ない）
- R8（L2・第 1 回 M2）: 期限切れの部分は掃除のときに `pruneGlyphParts(key, before)` が tx の中で部分ごとに期限を見て落とし、レコードを書き直す。グリフの Resource は `[pinned, fetchedAt]` の cursor ではなく Resource のキーの範囲で回す（レコードの `fetchedAt` は最も新しい部分の値で、索引では拾えない。F36）。グリフかどうかは Resource の `type` で決める。配信の経路は変えない — 配信のたびに書き直すと hit が書き込みになる。掃除は起動後 1 回とジョブの完了時なので回数が少ない — 誤りなら期限切れの部分が次の掃除まで `bytes` に残る
- R9（第 1 回 S3）: 掃除と移行の契機は `ctx.maintain`（Weiwudi が扱う fetch のうち store を使うハンドラの先頭で `event.waitUntil`。旧 API の `ping` と `control.get`（`/v2/ping`）は除く）。新しい `fetch` のリスナを足さない — 利用者の要求（プリキャッシュなど）で IndexedDB を開かない。`legacy-routes.test.ts:60-67` の固定（リスナは install・activate だけ・起動で IndexedDB を開かない・`/api/ping` で IndexedDB を開かない）を差分なしで保つ。死活確認は store を使わない操作のままにする — 誤りなら Weiwudi の要求が無いページで移行が進まない（その利用者はキャッシュも使っていない）。ping を契機に含めたくなったら、既存の試験の書き換えを台帳に記録し、この Ruling を直す
- R10（第 1 回 M2・M11）: 掃除は、グリフでない Resource を `[pinned, fetchedAt]` の 1 本の cursor（`pinned = 0`・`fetchedAt < now − 最短の retention`）で読み、Resource ごとの retention で判定する。消すのは `deleteEntries(keys, { unpinnedOnly, fetchedBefore })` で、tx の中で条件を見直す（一覧の後の固定・取り直しを消さない）。グリフは R8。1 回 2,000 件まで — Resource ごとの索引を足すと版を上げる。上限を最短の retention で切るので、retention の無い Resource の Entry は訪れない（`fetchedAt` が上限より新しいものも訪れない） — 誤りなら retention の無い Source の古い Entry を読み飛ばす分だけ遅い
- R11（第 1 回 S1）: 非タイル資源（スタイル・TileJSON・スプライト・データ・グリフ）の固定は region に幾何で結び付けず、**その Resource を参照する全 Source（`sourceIds` ∪ `rangeOnlySourceIds`。子は `parentId` の親に読み替える）の固定つきの region が 1 つでも残る間**は維持する。その数が 0 になる解放で外す — 非タイル資源は範囲を持たないが、どの region のためにも要る。2 つのスタイルが同じグリフ・スプライトを共有すると、「その Source の region」で見ると片方の最後の解放でもう片方の固定が外れる（範囲 1 の問い）。スタイル 1 枚のために region ごとの参照カウントを Entry に持たない（§7.2「Entry 側に参照カウントを持たない」） — 誤りなら region ごとにスタイルを取り直すだけ
- R12（第 1 回 S1）: 解放の幾何の判定は、その Resource を参照する全 Source（`sourceIds` ∪ `rangeOnlySourceIds`。**子 Source は `parentId` の親に読み替える**）の固定つきの region（`status` は問わない）で見る。既定の解放でも、共有の Resource は固定を外すだけで Entry を消さない — Entry は Resource 単位で共有されるので、別の Source の region のタイルを消すと、その Source のオフラインが壊れる。スタイルの子の Resource の `sourceIds` は子の id で、region は親の id で保存されるので（F31）、読み替えないと別のスタイルの region を 0 件と数える — 誤りなら他の Source の region を数え忘れた分だけ余計に消える（キャッシュなので取り直せる）
- R13: ジョブは直列の待ち行列の外で動く（旧 `fetchAll` と同じ）。各バッチの前に Source の有無を見て、無ければ `stop`（`source-not-found`）。t5 の後は自分の Source の `remove()` はジョブ中 `fetch-busy`（R48）なので、この守りが効くのは別スコープの SW から消されたときだけ。Resource が消えていれば `serve` が保存せず上流を配信するので続けてよい — 長いジョブで `register`・`update` を待たせない。`remove()` された Source のために取り続けない — 誤りなら 1 バッチ分の取得が無駄になるだけ
- R14（L5）: スタイルの登録の上流待ち（m3 R34）に上限を置かない — 遅い上流を失敗にすると登録そのものが `invalid-style`／`fetch-failed` になり、オフライン中心の用途で悪化する。待たされるのは書き換えの op だけで、読み取りと配信は待たない。`AbortSignal` は `upstream.rebuild` が写さない（m2-t7 の Info）ので、上限を効かせるには別の直しが要る — 誤りなら `rebuild` に `signal` を写してから段ごとの上限（60 秒）を足す
- R15: 全体の `bytes`・`pinnedBytes`・`count` は `kv` の `totals` に持ち、Entry を増減する全操作の同じ tx で直す。全体上限は `kv` の `limits` — 保存のたびに全 Resource を読まない。`totals` が無い DB は `listResources` の和で作る — 誤りなら `totals` がずれた分だけ全体上限が早く・遅く効く（`usage()` は Resource の和なので正しいまま）
- R16（P7・I7b）: `QuotaExceededError` のとき、固定以外を全体 LRU で `(bytes − pinnedBytes) × 10%` 退避して 1 回だけ再試行する。旧 API も同じ — §7.1 の決め。全体上限の既定が無いので、これが無いとブラウザの上限に当たった後は自力で回復しない。旧 API の試験の結果が変わる点は §9 に書く — 誤りなら 10% を変えるだけ
- R17: 旧 DB の有無は `indexedDB.databases()` で見る。無い環境では `Weiwudi` を版なしで開き、`mapSetting` が無ければ空で完了して自分で作った空の DB を消す — §14.2「open は無い DB を新しく作ってしまう」。古い Firefox でも移行を飛ばさない — 誤りなら空の `Weiwudi` が 1 つ残る（1.1.x が作る形と同じで害は無い）
- R18: 移行中の読み通しは `legacy.getImage` が `serveTile` の前に `migrate.pullTile` を呼ぶ形（旧にあれば新へ移してから `serve`）。配信の経路は `core.serve` 1 つのまま — `serve` に旧 DB の分岐を足すと core が legacy を知る（§3 に反する） — 誤りなら読み通しの 1 件ごとに新 DB の `hasEntries` が 1 回増えるだけ（移行中だけ）
- R19（I7c）: `mapID` に `\0` があれば `add` で `Error: MapID must not contain a NUL character` の文字列で拒否する。移行では `failed` にして旧 DB に残す — 16 行の文面は変えられず、既存の `attribute-invalid` の文面は `cacheMaxBytes` 固定。これまでは黙って他の地図の範囲にかぶっていた — 誤りなら id を符号化する形へ（キーの形が変わるので m4 の中では採らない）
- R20（P2・I5d）: `opaque` イベントは `corslessUntil` を書いた所（照合ルート経由の `countCorsless`・ジョブの 5 枚の確かめの失敗）から `ctx.notify` で 1 回送る。配線が `clients.matchAll({ type: 'window' })` の全 client に `{ type: 'opaque', sourceId, resourceId }` を送り、子 Source は親に読み替える — 照合ルートには client の文脈が無い（要求を出した client は分かるが、ページの `WeiwudiSource` はどの client にもいる）。`WeiwudiSource` は `sourceId` で選ぶ（F8） — 誤りなら他のページにも届く（`sourceId` が違えば無視される）
- R21（I5c）: ジョブのイベントは開始した client（`fetchRange` の POST の `event.clientId`）に `postMessage` し、`{ type, sourceId, regionId, … }` の形で旧 `fetchAll` の項目を保つ — §7.2「同じ形で使い regionId・errors を足す」。F8 の受け口にそのまま乗る — 誤りなら `clients.matchAll` へ替える（再開は別の client から来うるので、`job/resume` の client にも送る）
- R22: ページ側の `fetchRange` は POST の応答（`running` の `RegionInfo`）を受けた後、その `regionId` の `finish`・`stop`・`canceled` を待って解決する（`canceled` も解決。`stop` だけ reject）。30 秒イベントが来なければ `job/resume` を POST し、応答が終わりの `status` ならそれで解決する（`stopped` は reject）。`job/resume` の失敗（`fetch-busy` など）は reject — §7.2 のとおり。`canceled` は利用者の意図なので失敗にしない。`finish` を送る前に SW が止まった region をページが待ち続けない（第 1 回 M7） — 誤りなら `canceled` を reject に替える（新しい code が要る）
- R23（第 1 回 M7）: 1 度に 1 ジョブ（`ctx.job`）を旧 API の `fetchAll` と共有し、同時は `fetch-busy`。`ctx.job` の確かめと確保は await を挟まず同期に行い（`fetchRange`・`job/resume` とも。確保の後の書き込みが失敗したら外す）、`JobState.regionId` で region と結ぶ。`cancel()` は自分の Source のジョブだけ止め、無ければ `no-fetch-process` — §7.2「現行の `fetchAllBlocker` と同じ」。旧 `fetchAll` は同期に確保するので（F7）、新しい側も同期でないと region の書き込みの間に旧 API が入る。m1 の表の code を使い新しい code を足さない — 誤りなら Source ごとのジョブに広げる
- R24: 「取れた」は `x-weiwudi-status` が `hit`・`miss`・`refresh`（と `hasEntries` が真のもの）。`stale`・`offline-miss`・`upstream-error` は `x-weiwudi-error` の種類で数える。既に有る Entry は上流へ出さず固定だけ付ける（R46） — 旧 `fetchAll` と同じ数え方（m2-t5 の Ruling）。固定は region のために要る — 誤りなら `stale` を成功に数える
- R25（#41）: 開発用ページは新 API（`register`・`fetchRange`・`releaseRange`・`clean`・`setLimits`・`stats`・`usage`・`regions`）で書き直し、Leaflet のラスタの例のまま。旧 API の操作は残さない — #41 の完了条件「現行の設計に合わない操作が残っていない」「基本動作を確認できる」。MapLibre は足さない（m3 R15） — 誤りならスタイルの例を別のページとして足す
- R26: m4 では版番号を変えず、`CHANGELOG.md` に `Unreleased` を足す。公開は次の月次トレイン — state の `branch_policy`「公開は合流後の次の月次トレイン」。版は公開の作業で決める（minor。§14.1） — 誤りならトレインで `Unreleased` を版に書き換えるだけ
- R27（#78）: m4 の固定・解放・掃除は Entry の suffix を解釈せず、素通しは `core.passThrough` 1 つのまま、region の `normalized` は `kind` で分岐できる形にする — #78 の区画のキーと PMTiles の範囲取得を後から足せる — 誤りなら #78 で region の形に版を足す
- R28（P3）: `bounds` の緯度は `±MERC_MAX_LAT` に丸めてから `lngLatBoundsToTileBox` に渡し、`west > east` は 2 つの `box` に分ける — §7.2 のとおり。`latToMercY(90)` は有限だが丸めなければ y が範囲の外になる — 誤りなら丸めの値を変えるだけ
- R29（`estimate`）: タイルの枚数だけを数え、非タイルの資源は `total` に入れない。`percent` は 100 で止める — §7.2「`estimate(range)` がタイル枚数を返す」。非タイルは数が小さく範囲で変わらない — 誤りなら `estimate` に `resources` の内訳を足す（minor）
- R30: `'all'` は Source の範囲（`raster`・`vector` は自分の `extent`、スタイルは子の tile の Resource の `extents` のその子の分）。範囲（`box`）の無い Source の `'all'` は `cannot-fetch-all` — 旧 `fetchAll` の `cannot-fetch-all` と同じ意味。全域の列挙は無限 — 誤りなら `minZoom`〜`maxZoom` の全域を許す（枚数の上限が要る）
- R31: `concurrency` は `runJob` の `batchSize`（既定 5・1〜20） — §7.2「同時実行数は concurrency（既定 5）」。`runJob` はバッチの中を並行にするので同じ意味 — 誤りなら上限を変える
- R32: `glyphRanges` の `'common'` は `0-255`・`256-511`・`8192-8447`・`12288-12543`・`65280-65535`、`'all'` は 256 個、配列は `^\d+-\d+$` — §7.2 のとおり — 誤りなら既定の一覧を変える（minor）
- R33: `master` への合流は 1 つの PR の merge commit（squash しない）。`vector-cache` は合流後も残す — 各タスクの PR の履歴と CI の記録を残す。次のトレインまでの直しの枝が要る — 誤りなら枝を消すだけ
- R34（I8b）: `tableChanged` の `BroadcastChannel` の通知を 100 ms でまとめる — スタイルの登録は段ごとに `tableChanged` を呼ぶので、別スコープの SW が 1 回の登録で何度も表を作り直す（L-5） — 誤りなら間隔を変えるだけ
- R35（L7）: `sk.` の判定（前置きの剥がしを含む）は `url_pattern.isSecretValue` 1 つにし、`spec` と `restQuery` が使う — 同じ秘密が検査では拒否されキーには残る不揃いを消す（m3-t3 L2） — 誤りなら `Bearer sk.…` の値を持つ正当なクエリ項目がキーから落ちる（知られていない）
- R36（L8）: `credentialParams` に無い名前の値がトークンの形（`^(pk|sk|tk)\.`）なら `warnings` に `credential-undeclared: <名前>`。登録は成功 — 宣言しないと id・キー・`resources` にトークンが残る（§10）。拒否にすると正当な値（`pk.` は公開トークン）を止める — 誤りなら形の表を広げるか、警告を消すだけ（code は §12「知らない code は無視」）
- R37（I10）: 保存済みの `Resource.templates` が古いままの件は作業なし（台帳に記録） — `WeiwudiStore` は未公開で 1.1.1 の利用者に存在しない。開発用の DB は `update()` で直る — 誤りなら t7 の移行に「新 store の記録の再合成」を足す
- R38（I2a・I2b）: 門番の 3 秒待ちは直さず、`refreshTable` だけに `GATE_WAIT_MS` の上限を置く — 門番は `fail()` の間隔で守られている（F10）。制御の op は上限なしで待つので、読み込みが止まると直列の待ち行列が固まる — 誤りなら op が表の作り直しを待たずに成功する回数が増えるだけ（門番が読み直す）
- R39（I4a・第 1 回 L）: `control.post` は `WeiwudiError` でない DOMException（`quota`・`db-blocked` を除く）を `storage`（`detail.name`）にする。`TypeError` など DOMException でない例外は `internal` のまま。`WeiwudiError.from` は変えない — `from` は旧 API の文面の分類を担うので変えない。制御の失敗で `internal` と `storage` を分けると利用者が「容量・ブラウザの状態」と「Weiwudi の不具合」を見分けられる — 誤りなら `from` に DOMException → `storage` の規則を足す
- R40（I4b）: `register`・`update`・`remove`・`removeResource` が例外で終わるときも `refreshTable(ctx, [])` を 1 回呼ぶ — 途中まで書いた Resource が照合表に無いと、次の要求で表が古いまま固まる（門番は `current` があれば読み直さない） — 誤りなら失敗のたびに表を 1 回作り直すだけ
- R41（I3・第 1 回 M14）: `stats` の `count`・`percent` は、範囲（`box`）が決まる Source だけ、共有の Resource と範囲だけの Resource を `[resourceId, z]` の索引で `box` の中を数え（排他の Resource は範囲外を保存しないので Resource の `count`）、`percent` は 100 で止める。`byResource`・`size` は Resource の数のまま — 共有の Resource で 100 を超える `percent` は利用者を迷わせる。`size` は範囲で分けられない（Entry の大きさは座標で分けられるが、`stats` のたびに読むのは重い） — 誤りなら `count` も Resource の数に戻し `percent` だけ止める
- R-I1（I1a・I1b）: `evictScopesFor` の失敗は `storage` として配信を続ける — §9 に記録済みの形。`serve` の reject を照合ルートが素通しにして上流へ 2 回出るのを止める — 誤りなら保存されない応答が増えるだけ
- R-I6（I6）: 同じオリジンの別スコープの SW からの同時の登録は直列にならないことを文書に書き、直さない — SW をまたぐ鎖（Web Locks）は Safari の対応が限られ、1 つのスコープで登録するのが普通 — 誤りなら Web Locks を使えるときだけ使う形を足す
- R-I8（I8a）: 署名つき URL は、署名の項目を `credentialParams` に挙げる使い方を文書に書く。SW が署名を作る口は足さない — 署名は要求ごとに変わるのでキーに残すと同じタイルが別の Entry になる。署名を作るのは利用者の鍵が要り SW の役ではない — 誤りなら `requestWillFetch` の差し込み口で利用者が署名する例を文書に足す
- R-G（L4・第 1 回 M15）: グリフの束ね書きは `core.createGlyphCollector` が保存だけを遅らせ（`save` が `putGlyphPart` と `evictScopesFor` の代わりに `collect.add`）、1 fontstack を `runJob` の 1 単位にして、単位の `finally` で `flush`（`evictScopesFor` 1 回・`putGlyphParts` 1 回）する。`flush` の失敗は fontstack ごとに 1 件。配信の経路は変えない — §11「1 fontstack 分を溜めてから 1 回で書く」を `core.serve` 1 つのまま満たす。`runJob` は始めた単位を終わりまで待つので（F37）、1 単位にすれば取り消し・`gone`・`stop` でも集めた部分を捨てない — 誤りなら範囲ごとに書く（fontstack の大きさ × 範囲数の書き込み。動くが遅い）
- R-ratio（第 1 回 M10）: `{ratio}` のテンプレートの範囲取得は `FetchRangeOptions.ratio` の値で展開する。ページ側の `fetchRange` は指定が無ければ `devicePixelRatio > 1 ? '@2x' : ''` を入れて送る（SW に直接 POST したときの既定は `''`） — 捕捉のキーは要求の `@2x` を含むので、高解像度の端末の地図ライブラリが `@2x` を求めるのに `''` で取るとオフラインで当たらない。端末を知っているのはページで、SW は知らない。両方を取ると 2 倍になる — 誤りなら両方を取る指定を足す
- R-tms（第 1 回 M9）: 正規化した範囲（XYZ）を Resource の scheme の座標に直してから `extents`（Resource の scheme の座標）と交差を取り、出た (z, x, y) を**そのまま** `expandTemplate` に渡す（`{-y}` は `expandTileTemplate` が y から作る）。`RangeSpec.box` は `maxZoom` での Source の scheme の座標（登録の `box` と同じ） — 照合の y は `{y}` なら URL の値、`{-y}` なら反転した値で、`extents.box` と同じ座標（F32）。交差の後でさらに反転すると 2 回反転になり、別の Entry を取る — 誤りなら 3 通りの試験（`{y}`＋tms・`{-y}`＋xyz・`{-y}`＋tms のキーが捕捉と同じ）が落ちる
- R42（P7・第 1 回 M1）: R7' の予算の見積もりは、要素の `resourceIds` の Resource の `bytes − pinnedBytes` の和に、この tx の `deltas` の `bytes`（前の要素が消した分）を足し、`willSave` のとき固定でない `old` の大きさを引いて始める。cursor でも同じキーを飛ばす — 今の `getAll` の実装は同じキーを候補から外し（F4）、前の要素が消した Entry は同じ tx の後の読み出しに現れない。Resource の値は `deltas` を最後に書くまで古いので、足さないと消しすぎる — 誤りなら今の退避の試験が差分ありになって落ちる（参照の実装との突き合わせの試験で見つかる）
- R43（I12・第 1 回 M3）: `hasEntries` は t1 でメタだけの判定に戻す。既存の試験 2 件（F35）を書き換えて台帳に書く — 古い形のレコードは未公開の `WeiwudiStore` の開発用の DB にしか無く（I10・R37 と同じ「未公開」）、t7 の移行（旧 DB → 新 DB）では直らないので「t7 の後」を待つ理由は無い。範囲取得は既に有るタイルごとに `hasEntries` を引くので、本体を読むと取得が遅くなる — 誤りなら開発用の DB の古い形のタイルが範囲取得で取り直されず、オフラインで欠ける（表示で取り直せば直る）
- R44（I11）: スタイルの「同じオリジン」の判定は登録 URL のまま（`Response.url` を見ない）。文書に書き、コードは直さない — 資格情報を足す相手は登録 URL のオリジンと提供元に限られ、リダイレクト先には足さない（クエリは `Location` に引き継がれず、ヘッダは `redirect: 'error'`。m3 R21）。SW が合成した応答の URL は要求の URL なので、ページの地図ライブラリも本体の相対 URL を登録 URL で解決し、SW の子作りと揃う。`Response.url` を見るには `core.serve` の合成に上流の URL を通す形の変更が要る — 誤りなら（リダイレクト先が書いた本体が登録 URL のオリジンの別のパスへ資格情報を向けることが問題になれば）`ServeInput.transform` に上流の `Response.url` を渡し、別オリジンへのリダイレクトなら子に資格情報を配らない
- R45（I5c・第 1 回 M7）: ジョブの終わりの順は「region を書く → `ctx.job` を外す → `postMessage`」。`job/resume` は、同じ region のジョブ中なら今の `RegionInfo`、別の region のジョブ中なら `fetch-busy`、region が終わっていればその `RegionInfo` を返す — ページが `finish` を受けて `regions()` を読んだときに `running` が見えない。別の Source のジョブ中に 30 秒ごとの再開が解決しないまま続かない — 誤りなら再開の応答に `busy` の印を足してページが待ち続ける形にする
- R46（第 1 回 S2）: 範囲取得の固定の正本は、成功と数えたキー全部への `setPinned(keys, 1)`（バッチの後に 200 件ずつ）。`ServeInput.pin` は保存と同じ tx で付ける近道として残す — `core.serve` の同時要求のまとめ（`flightKey` は `pin` を見ない）と hit は `save` を通らないので（F25）、`pin` だけでは「表示範囲を取得」で普通に固定が漏れ、漏れた Entry は LRU・保持期間で消える — 誤りなら `setPinned` の書き込みが 1 バッチに 1 回増えるだけ
- R47（P1・第 1 回 M12）: `remove()` と範囲なしの `clean()` は、消す前に `releaseAllOf` でその Source の全 region を R12 の規則で解放する（`keep: true`。共有の Resource は固定を外すだけ） — 範囲だけで参照する Resource に限ると、`sourceIds` を他の Source と共有する Resource に、消した Source の region のための固定が持ち主の無いまま残る — 誤りなら解放の 1 回分だけ `remove()` が遅い
- R48（第 1 回 M7）: 自分の Source のジョブが動いている間の `clean()`・`clean(range)`・`remove()`・`releaseRange` は `fetch-busy`（先に `cancel()` する）。`update()`・`removeResource` は止めない — 旧 API の `clean`・`delete` の `map-busy` と同じ考え。ジョブと消す操作を並べると、ジョブが消した直後の範囲を取り戻す・region を書き戻す（R5 の条件つきの書き込みで後者は防げるが、前者は防げない）。取り消してから進める形は、取り消しの完了を待つ仕組みが要る — 誤りなら「取り消してから進める」に替える（ジョブの完了の Promise を `ctx.job` に持つ）
- R49（第 1 回 L）: `clean(range, { force })` は、その Source だけが参照する Resource の Entry だけを消し、重なるその Source の region を `partial` にする。共有の Resource の Entry と、他の Source の region は触らない — 他の Source のオフラインを壊さない。範囲なしの `clean()` の「共有の Resource は残す」（m2）と揃う — 誤りなら共有の Resource の範囲の Entry も消す指定を足す
- R50（第 1 回 S4・M5）: `migrate.ts` は §3 のとおり `store`・`constants`・`errors` だけを import し、地図の登録（`legacy.registerMap`）と退避の範囲（`core.evictScopesFor`）は `MigrateDeps` として受ける（`legacy` が `migrationDeps` を持ち、配線と `legacy` の中の呼び出しが同じものを渡す）。旧レコードを消すのは `putEntry` が `saved: true` のときだけで、書く前に `getResource` で Resource の有無を見て、無ければ残す・有って `saved: false` なら落とす — `migrate` が `legacy`・`core` を import すると循環し、写して持つと二重実装になる。`putEntry` の `{ saved: false }` は理由を返さず（F29）、既存の試験が形を固定している。Resource の無い書き込みは捨てられるので、見ずに消すと旧の本体を失う — 誤りなら `putEntry` の戻り値に理由を足す（既存の試験の書き換えが要る）
- R51（第 1 回 M5・M6）: 移行は、第 1 段（`mapSetting` の `getAll` 1 回）を共有の Promise にして旧 API のハンドラが待ち、第 2 段は地図ごとの `lastKey` から読み、失敗はレコードの数（`recordFailures`。数えるだけ）とバッチの開始の数（`batchFailures`。3 で `failed`）に分ける。地図が `done` になったらその場で `Weiwudi_<mapID>` を消し、`Weiwudi` は全地図が `done` か `failed` になってから消す。旧 API の `clean`・`delete` はその地図の旧 DB を消す。`maps` は配列・`pendingDelete` は `migration` の直下 — `maintain` は `waitUntil` に渡すだけで待たないので、SW の更新直後の最初の要求では新 DB に Resource が無く、オフラインで 404 になる（§14.2「移行の途中でも地図が欠けない」）。cursor を先頭から開くと飛ばしたレコードが溜まって進まない。旧 API の操作との順を決めないと、利用者が消したタイルが戻る。`failed` が 1 つあるだけで全部の旧 DB を残す理由は無い — 誤りなら第 1 段の待ちに上限（`GATE_WAIT_MS`）を置く
- R52（第 1 回 L）: `kind: 'asset'` の Source の `fetchRange` は `'all'` だけを受け、Source の Resource（非タイル）を取って固定する。`estimate` は `{ tiles: 0 }` — asset は範囲を持たないが、オフラインに置きたい用途はある。範囲の指定は意味を持たないので拒む — 誤りなら asset の `fetchRange` を `attribute-invalid` で拒む
- R53（第 1 回 L）: `FetchRangeOptions.fonts`・`StyleSpec.fonts` の要素は fontstack（`{fontstack}` の値。フォント名を `,` で結んだもの）。`collectFonts` は文字列の配列と `["literal", [...]]` を `,` で結ぶ — MapLibre が要求する `{fontstack}` の形そのもので、範囲取得のキーが捕捉と同じになる。名前 1 つの指定もそのまま 1 つの fontstack として扱えるので、意味を分けない — 誤りなら名前の配列を受けて結ぶ指定を別に足す
- R54（第 1 回 L）: 開発用ページの範囲取得は `estimate` が 50 枚を超えたら断り、OSM のタイルの利用規約（まとめての取得の禁止）を画面と README に書く — 開発用ページは OSM のタイルを使うが、範囲取得は規約が禁じる使い方そのもの。動作確認は数十枚で足りる — 誤りなら開発用ページの上流を規約の許すものに替える
- R55（第 1 回 M8）: 固定分の上限の `stop`（`quota`）は、開始のときと各バッチの後に、要素ごとの `Σ pinnedBytes` を読み直して判定する — `commitEntry` は固定していない Entry だけを予算に数え、単体の大きさしか拒まないので、`cacheMaxBytes` から `x-weiwudi-error: quota` は出ない。開始のときだけだと上限を大きく超えて固定し続ける — 誤りなら 1 バッチ分（`concurrency` 枚）だけ上限を超えて止まる

## 未決の点（事前点検と実装で決める）

- U1: `credential-undeclared`（R36）の形の表 `^(pk|sk|tk)\.` は Mapbox の形から決めた。他の配信元の公開トークンの形（例が集まれば）を足してよい。m3-t3 L2 の「独自名の資格情報に警告」の意図がこれと違えば、t8 の実装の前に進行役が台帳の記録を読み直して直す
- U2: 掃除の 1 回の上限 2,000 件（R10）と移行の 1 バッチ 200 件（§14.2）は、実測なしの値。t2・t7 の e2e で Chromium の 1 バッチの時間を記録し、1 秒を超えるなら下げる
- U3: `job/resume` の 30 秒（§7.2）は、`proceed` がバッチごとに出るので、上流が 1 バッチに 30 秒以上かかる（5 枚で 6 秒/枚）と再開を送ってしまう。`ctx.job` が動いていれば `job/resume` は何もしないので害は無い。t10 の実測で揺れるなら 60 秒にする
- U4: `RegionInfo.range` は利用者が渡した `RangeSpec` の決めた項目だけを写して返す（正規化した `box` ではない。R5）。`'all'` のときに実際の範囲を知りたい要望が出れば `normalized` を公開する（minor）
- U5: 全体上限の退避（`[pinned, accessedAt]` の cursor）は旧 API の Resource の Entry も消す（全体なので）。旧 API の利用者には `setLimits` を呼ばなければ効かないので変化は無い。再試行（R16）は旧 API にも効く（§9 に書く）

## 事前点検 第 1 回の反映

点検の報告（設計レビュー・Claude。対象 c554a28・src f6189a0）の指摘ごとに、どこをどう直したか。コードの事実は f6189a0 の src・tests を読み直して確かめ、事実の表に F25〜F37 を足した。

| 指摘 | 直した所 | 直し方 |
|---|---|---|
| S1 固定の規則と親・共有 | R11・R12・t4「非タイル資源の固定」・t5「region を持つ Source の集め方」と手順 2〜4・試験・受け入れ条件・F31 | 「その Resource を参照する全 Source（`sourceIds` ∪ `rangeOnlySourceIds`。子は `parentId` の親に読み替え）の固定つきの region」で判定する `holdersOf`・`remainingRegions` を置いた。非タイル資源は参照する全 Source の region が 0 のときだけ外す。共有の Resource は既定の解放でも固定を外すだけ。試験に「2 つのスタイルが同じグリフを共有」「子の Resource を共有」 |
| S2 inflight と hit の固定の抜け | t3 の手順 4・R46・R6・R24・t1 の固定の段落・試験・F25 | 成功と数えたキー全部にバッチの後で `setPinned(keys, 1)`（200 件ずつ）。`ServeInput.pin` は近道として残す。試験に「ページの要求が飛んでいる最中」「`hasEntries` の後に別の要求が保存」 |
| S3 ping の契機と既存の試験 | t2 の保守の契機・試験・受け入れ条件・R9・F18・F26 | 契機から `/api/ping` と `control.get`（`/v2/ping`）を外し、試験の契機を `/api/info` に。F18 に ping の固定を書き足した。`legacy-routes.test.ts` は追記だけのまま |
| S4 migrate の依存 | t7 の「依存の注入」・第 1 段・第 2 段・受け入れ条件・R50・F27 | `MigrateDeps`（`registerMap`・`evictScopesFor`）を `legacy.migrationDeps` から注入。`resourceOf` は legacy に 1 つ。migrate の import の grep を受け入れ条件に |
| M1 退避の見積もり | t1 の「退避の走査の省略」・試験・R7'・R42・F4 | 式を「`bytes − pinnedBytes` の和 ＋ この tx の `deltas` − 固定でない `old`」と明記し、cursor でも同じキーを飛ばす。2 つの要素が同じ Resource を共有する試験と、今の実装との突き合わせ |
| M2 グリフの期限切れの部分 | t2 の掃除の手順 1〜3・試験・t1 の `entriesOf`・`pruneGlyphParts(key, before)`・R8・R10・L2 の行・F36 | グリフの Resource は Resource のキーの範囲で別に回し、tx の中で部分ごとに落とす。グリフかどうかは Resource の `type` |
| M3 申し送り 3 件の抜け | 申し送りの表（I11〜I13・38 件）・前提の `hasEntries` の段落・t1・t8・t11・R43・R44・F35 | I11 は t8（文書と R44）、I12 は t1（メタだけに戻し既存の試験 2 件を書き換え）、I13 は t11。前提の理由を「古い形は未公開の開発用の DB にしか無い」に直した |
| M4 hook.ts と依存の行 | t1 の `deps.test.ts`・t3・t4 の対象ファイル・`credentialsForResource`・`ServeResourceOptions.pin`／`collect`・R1・F14・F28・F33 | hook.ts を t3・t4 の対象に足し、資格情報の選び方を export して `serveHit` と共有。range の行に `registry`。持ち主の一覧は control が渡す（`style` は足さない）。`ABOVE_ALL` に `range` |
| M5 移行の第 1 段の前の要求 | t7 の第 1 段・第 2 段の 2〜3・読み通し・試験・R50・R51・F29 | 旧 API のハンドラが第 1 段の共有の Promise を待つ。旧レコードは `saved: true` のときだけ消し、`getResource` で Resource の有無を見て「残す／落とす」を分ける |
| M6 第 2 段の停滞と旧 API の順 | t7 の状態・旧 DB の接続・第 2 段・旧 API の `clean`・`delete`・完了・試験・R51 | `lastKey` から読む・`recordFailures` と `batchFailures` に分ける・`clean`／`delete` は旧 DB を消す・`done` の地図の DB はその場で消す・孤児の DB を消す・`maps` は配列で `pendingDelete` は直下・接続を閉じてから `deleteDatabase` |
| M7 ジョブの終わり方と再開 | t3 の region・イベント・1 度に 1 ジョブ・再開・ページ側・試験・t5 の `fetch-busy`・R5・R22・R23・R45・R48 | 終わりの書き込みは `patchRegion` で「有り・`running`」のときだけ。`gone` は `partial`。`JobState.regionId`。別の region の再開は `fetch-busy`。同期の確保。再開の応答が終わりなら解決。終わりの順を固定。自分の Source のジョブ中の `clean`・`remove`・`releaseRange` は `fetch-busy` |
| M8 固定分の `quota` | t3 の手順 6・試験・R55 | 各バッチの後に要素ごとの `Σ pinnedBytes` を読み直して `stop`（`quota`） |
| M9 tms の 2 回反転と `box` の座標 | t3 の型・`normalizeRange`・`enumerate`・試験・R-tms・F32 | 正規化は XYZ、Resource の scheme の座標に直して交差、出た y をそのまま展開。`RangeSpec.box` は `maxZoom` での Source の scheme の座標。試験を 3 通りに |
| M10 `{ratio}` の既定 | t3 の型・ページ側・試験・R-ratio | ページ側の既定を `devicePixelRatio > 1 ? '@2x' : ''` に |
| M11 tx の中の条件の見直し | t1 の `deleteEntries(keys, { unpinnedOnly, fetchedBefore })`・`pruneGlyphParts`・試験・t2・t5・R10 | 消す操作は tx の中で読んだメタで条件を見直す。掃除・`clean(range)` が使う |
| M12 `remove()`・`clean()` の共有の固定 | t5 の `releaseAllOf`・`clean()`・試験・P1 の行・R47 | 全 region を Resource ごとに S1 の規則で解放し、共有の Resource は固定を外すだけ。`remove()` と範囲なしの `clean()` の両方から呼ぶ |
| M13 totals の抜け | t6 の全体の数・試験・F30 | `evictGlobal` を足し、`totals` が無ければ書き込みの tx の中で作り、`deleteResource` は消す前に読んで差し引く |
| M14 `stats` の重さ | t8 の I3・試験・I3 の行・R41 | 排他の Resource は Resource の `count`、共有と範囲だけの Resource だけ走査 |
| M15 GlyphCollector の書き出し | t4 のグリフの束ね書き・試験・R-G・F37 | 1 fontstack を `runJob` の 1 単位にし、`finally` で `flush`。`evictScopesFor` は `flush` で 1 回、`collect` のときは `save` で読まない。`flush` の失敗は fontstack ごとに 1 件 |
| L 事実の表の行番号 | 事前に確かめた事実 F1〜F24 | f6189a0 に合わせた（`joined.byteLength` も） |
| L 並行の組 | 順序と依存の並行の段落 | 両方が触るファイル（`weiwudi_gw_logic.ts`・`context.ts`・`control.ts`・文書）を挙げ、後に合流する側が rebase して機械的に解くと書き直した |
| L 仕様 §4.5 の表 | t3 の対象ファイルと文書 | 「テンプレートから作る要求」の行を範囲取得（R3）と旧 API に分けて t3 で直す |
| L #78 の節の `stats()` | #78 を邪魔しないことの 5 点目 | t8 の I3 の後の数え方に合わせて書き直した |
| L `'all'` の region | t3 の `normalizeRange`・R5 | 取得のときの Source の範囲を `normalized` に保存し、解放はそれを使う |
| L `RegionInfo.range` | t3 の型の段落・試験・R5・U4 | 決めた項目だけを写す |
| L `percent` | t3 のイベント・t4・試験 | タイルだけ（`processedTiles`）で数える |
| L `fonts` の意味 | t4 の fontstack の意味・型・R53 | fontstack（`,` で結んだ文字列）と決め、`["literal", [...]]` も拾う |
| L asset の `fetchRange` | t3 の `estimate`・ジョブ・試験・R52 | `'all'` だけを受けて Resource を固定する |
| L 掃除の印 | t2 の `sweepOnce(ctx, { force })`・t3 のジョブの終わり | ジョブの終わりは `force` で印を飛ばす |
| L `maxBytes: 0` | t6 の `setLimits`・文書・試験 | 何も保存しない意味を文書に書く |
| L 5 枚の無作為の確かめ | t3 の `tileAt`・試験 | n 番目のタイルを返す関数を置いた |
| L `clean(range, { force })` の共有 | t5 の `clean`・試験・R49 | 排他の Resource だけを消し、共有の Resource と他の Source の region は触らない |
| L I4a | t8 の I4a・I4a の行・試験・R39 | `storage` は DOMException だけ。`TypeError` は `internal` |
| L t7 の試験の hit | t7 の試験・t10 の `legacy-seed.html` | `epoch` を今の時刻に |
| L 仕様 §14.2 の `kv.settingsCopied` | t7 の対象ファイル・文書・受け入れ条件 | t7 で `migration.stage` に直し、grep を置く |
| L t9 の OSM の規約 | t9 の作るもの・受け入れ条件・R54 | 50 枚を超える範囲は断り、規約を画面と README に書く（旧 `fetchAll` のデモは t9 で消える） |
| L 文書の grep | t8 の受け入れ条件 | I6・I8c・L5・I11 の文書の grep を足した |
| 実装担当への申し送り（指摘とは別） | 全タスク共通の「実装担当への申し送り」 | 7 項目のうち `hasEntries` の項は R43 の決定に置き換わり、残り 6 項目を書いた |

反映しないと決めた指摘は無い。点検の直し方の案と違う形にしたものは次の 3 つで、理由は各 Ruling に書いた: M4 の「range の行に `style` を足す」は採らず control が持ち主の一覧を渡す（R1）、M5 の「`saved: false` の理由を分ける」は戻り値を変えず `getResource` で分ける（R50）、M7 の「取り消してから進めるか」は `fetch-busy` に決めた（R48）。

