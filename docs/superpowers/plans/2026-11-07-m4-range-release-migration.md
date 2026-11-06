# m4 実行計画: 範囲取得と解放・保持期間・移行・#41・master への合流

- 日付: 2026-11-07（設計担当の初版。事前点検は未実施）/ サイクル: weiwudi-vector-cache（軽い道）
- 点検の番号は m3 と同じく出どころを付けて書く（「第 1 回 S1」「X1」など）。m3 の番号は「m3-t4 の申し送り」「m3 Ruling R7」のように書く
- 仕様: `docs/superpowers/specs/2026-11-02-new-interface-spec.md`（以下「仕様」）。該当は §4.5-3（範囲取得の CORS）・§4.6（範囲取得の認証）・§7（保持・範囲取得・解放）・§9（エラーと旧 API の既知の変化）・§11（グリフの束ね書き）・§12（`setLimits`・`estimate`・`fetchRange`・`releaseRange`・`regions`・`cancel`・`clean(range)`）・§14（版と移行）・§16
- 起点: m3 の区切り（L2）の後の `vector-cache`。計画を書いた時点は `c5712bf`（m3-t9 まで合流）。**m3-t10（WebKit を CI で測る。store の本体を Blob から ArrayBuffer に替える直しを含む）と m3 の区切りの直しが入った commit を、進行役がここに書き直す**。各タスクは 1 PR で `vector-cache` へ入れる
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

## 先に確かめた事実（2026-11-07・設計担当。`c5712bf` の src・tests を読んだ）

| # | 事実 | 出どころ |
|---|---|---|
| F1 | `WeiwudiStore` には `regions`（keyPath `id`・索引 `sourceId`）と `kv`（keyPath `key`）のストアが既にあり、`deleteSource` は同じ tx で `credentials` と `regions`（`sourceId`）も消す。`entries` の索引は `[resourceId, pinned, accessedAt]`・`[pinned, accessedAt]`・`[pinned, fetchedAt]`・`[resourceId, z]` の 4 本。`regions` に書く API はまだ無い | `src/store.ts:305-327`・`:538-544` |
| F2 | 固定の競合: `core.save` は上流を待つ前に読んだ `savedPinned` を `meta.pinned` に入れ、`commitEntry` は tx の中で読んだ `old` の `pinned` を見ずに `meta.pinned` を書く。`putGlyphParts` も `...meta` で同じ | `src/core.ts:390-393`・`:496-504`、`src/store.ts:503-513`・`:642-647`（m3-t4 の申し送り） |
| F3 | 上限を超えた結合レコード: `commitEntry` の `willSave = evict.every((e) => e.maxBytes > 0 && newSize <= e.maxBytes)` で、`putGlyphParts` の `newSize` は連結後の `joined.size`。結合レコードが `cacheMaxBytes` を超えると新しい範囲は保存されない | `src/store.ts:479`・`:644-648`（m3-t4 の申し送り） |
| F4 | 退避の候補は要素ごとに `IX_LRU` の `getAll` で全件読む（予算内でも読む） | `src/store.ts:485-501`（m2-t2 水準 1 Minor 1） |
| F5 | 削除期限は配信の時点でだけ見る（`t - live.meta.fetchedAt > retention` なら無いもの）。掃除は無い。グリフは `liveEntryOf` が部分の `fetchedAt` を使い、期限切れの部分は `bytes` に残る | `src/core.ts:387-399`・`:362-371`（m3-t4 の申し送り・m3 R7） |
| F6 | `core.save` は `evictScopesFor` の失敗を reject で返し、`serve` 全体が reject する。照合ルートの `serveHit` は reject を捕まえて `fetch(request)` で素通しするので、上流へ 2 回出る。旧 API は `Error: ${e}` の本文になる | `src/core.ts:511-512`、`src/hook.ts:365-369`、`src/legacy.ts:391-393`（state の申し送り 1・§9） |
| F7 | 旧 API の `fetchAll` は `core.runJob`（5 枚ずつ・`isAlive` は `self.clients.get(client.id)`・`isCanceled` は `job.cancel`）で動き、`ctx.job`（`JobState`: `sourceId`・`label`・`total`・`count`・`error`・`failures`・`cancel`）は 1 つ。イベントは開始の `client.postMessage` で `proceed`・`finish`・`stop`・`canceled` を `mapID` 付きで送る。ジョブは `event.waitUntil` に結び付く | `src/legacy.ts:141-208`・`:363-387`、`src/core.ts:524-572`、`src/context.ts:10-23` |
| F8 | `WeiwudiSource` はページの `message` を `data.sourceId === this.id` で選び、`data.type` のイベントとして流す。SW からの新 API のイベントは `{ sourceId, type, ... }` を `postMessage` すれば届く。`opaque` を送る所は無い | `src/weiwudi.ts:277-282`、`src/upstream.ts:161-175` |
| F9 | 制御の op は `register`・`source`・`sources`・`stats`・`update`・`clean`・`remove`・`removeResource`・`usage` の 9 つ。`register`・`update`・`clean`・`remove`・`removeResource` が直列の待ち行列。`post` は `event` を受け、送り手を `fromOwnOrigin(event)` で確かめる。`statsOf` の `count` は Resource の `count`（共有の Resource では範囲の外も数える） | `src/control.ts:263-393`・`:123-142` |
| F10 | 門番の待ちは `GATE_WAIT_MS = 3000`、やり直しは 1 秒から倍々に 30 秒。`refreshTable` → `tableChanged` → `reload` は読み込み中の Promise を上限なしで待つので、読み込みが終わらないと `register` などの op も待ち続ける | `src/hook.ts:33-36`・`:184-202`、`src/control.ts:148-157` |
| F11 | `WeiwudiError.from` は DOMException の `QuotaExceededError` を `quota`、`BlockedError` を `db-blocked`、それ以外を `internal` にする。制御の失敗は `failure(e)` がこれで分類する | `src/errors.ts:148-152`、`src/control.ts:47-51` |
| F12 | 旧 API の `add` は `mapID` の文字を検査しない。Entry のキーは `map:<mapID>\0<z>_<x>_<y>`、Resource の削除は `[id\0, id\x01)` の半開区間なので、`\0` を含む `mapID` は別の地図の範囲にかぶる | `src/legacy.ts:39-40`・`:240-299`、`src/store.ts:336-338`（m2-t5 の申し送り） |
| F13 | 旧 DB（1.1.1）: `Weiwudi`（store `mapSetting`・keyPath `mapID`。記録は `/api/add` の query そのまま）と `Weiwudi_<mapID>`（store `tileCache`・keyPath `z_x_y`。記録は `{ z_x_y, headers, blob: Blob, epoch, accessedAt? }`。`accessedAt` は無いことがある）。版は固定しない（`indexedDB.open(dbname)`） | `git show 575e018:src/weiwudi_gw_logic.ts`（:30-37・:109-153・:461-467） |
| F14 | `tests/unit/deps.test.ts` の表は `migrate: ['store', 'constants', 'errors']` と `legacy` の `'migrate'` を既に持つ（m4 で足す前提）。`range.ts` の行は無い | `tests/unit/deps.test.ts:19-44` |
| F15 | テンプレートの展開は `tile_math.expandTileTemplate`（7 字句。`{fontstack}`・`{range}`・`{spriteSuffix}` は展開しない）。照合は `url_pattern.compileTemplate`・`matchUrl`、キーは `entryKey(resourceId, type, m, url, credentialParams)`。範囲取得が URL から Entry のキーを作る道はまだ無い | `src/tile_math.ts:110-128`、`src/url_pattern.ts:247`・`:387`・`:445-456` |
| F16 | `StyleSpec.fonts` は保存だけで使う所が無い。`style_body` は `layout.text-font` を集めない | `src/spec.ts:95`・`:521-542`、`grep -n text-font src/style_body.ts` が 0 件 |
| F17 | 開発用ページ `index.html` は旧 API（`registerSW('./demo-sw.js')`・`registerMap('osm_demo', { type: 'wmts', … })`・`fetchAll()`・`clean()`・`stats()` の 2 秒ごとの表示）で、Leaflet 1.9.4 を unpkg から `integrity` 付きで読む。`public/demo-sw.js` は `./workbox/workbox-sw.js` と `./weiwudi-sw.js` を `importScripts` する。`build:demo` は CI で走る（`vite.config.demo.js` → `dist-demo/`）。README の英日に画面写真は無い（`.png` の参照はテンプレートの例だけ） | `index.html`、`public/demo-sw.js`、`.github/workflows/ci.yml`、`grep -n -E '\.(png|gif|jpg)' README.md` |
| F18 | 単体試験のハーネスは `post(path, body, { client })`・`waitUntilCalls`（偽の `FetchEvent.waitUntil` に渡した Promise）・`listeners`（`self.addEventListener` の種別ごと）・`client.postMessage` の記録を持つ。`legacy-routes.test.ts:60` は `self` のリスナが `['activate', 'install']` だけで、`Weiwudi_Internal` の呼び出しで IndexedDB を開かないことを固定している | `tests/unit/sw-harness.ts:83-113`・`:176`・`:268-280`、`tests/unit/legacy-routes.test.ts:60-67` |
| F19 | WebKit では `context.setOffline` がページの `fetch` を先に止めるので SW の取得を測れない（§2 の 7）。m3-t10 は Chromium だけで成り立つ e2e に `@chromium-only` のタグを付け、WebKit の project を `grepInvert` で分ける方式 | 仕様 §2・m3 計画 t10・`m3-t10-webkit-ci` の枝 |
| F20 | m3-t9 の時点の実測: 単体試験 1338 passed・e2e 44 passed（Chromium）。m3-t10 で増える（進行役が差し替える） | m3 の台帳 |
| F21 | `m3-t10-webkit-ci` の枝（`2a94484`）の差分は tests・ci・文書だけで、store の本体を ArrayBuffer に替える直しはまだ入っていない。本計画は「新 store の本体は ArrayBuffer（＋`type`）」を前提に書く（下の「前提」） | `git diff --stat vector-cache...m3-t10-webkit-ci` |
| F22 | `legacy-store-repair.test.ts` は旧 DB を `fake-indexeddb` の `IDBFactory` で作って残す書き方を持つ（store の無い version 1 の DB・閉じない接続）。移行の試験はこの書き方を使える | `tests/unit/legacy-store-repair.test.ts:19-39` |
| F23 | `latToMercY(90)` は有限の値（m1 のまとめ）。`lngLatBoundsToTileBox` は丸めを持たず、緯度の限界は `spec.ts` の `MERC_MAX_LAT = 85.0511287798066` にある | `src/tile_math.ts:10-26`、`src/spec.ts:109` |
| F24 | 保存と合成で落とす 4 ヘッダ `DROPPED_HEADERS` は `core.ts` のモジュール定数（export していない）。移行（`migrate.ts`）は `core` を import できない（§3） | `src/core.ts:81`・`:96` |

## 前提: m3-t10 の後の store の本体

m3-t10 で `EntryBody.blob: Blob` が **ArrayBuffer と `type`** に替わる（WebKit とプライベートブラウズで IndexedDB に Blob を保存できないため）。本計画の次の箇所はそれを前提にする。項目名（`body`・`type` など）は m3-t10 が決めたものを使い、本計画の `blob` と書いた所はそれに読み替える。

- t1 の `putGlyphParts` の直し（部分の詰め直しは ArrayBuffer の `slice` と連結で行う。Blob の `slice` ではない）
- t4 のグリフの束ね書き（集めた部分は ArrayBuffer）
- **t7 の移行（§14.2）**: 旧 `tileCache` の `blob`（Blob）は tx の外で `await blob.arrayBuffer()` と `blob.type` に変換してから新 store へ書く（tx の中で IDB 以外の Promise を待たない。m2-t2 の申し送り）。旧 DB を読む tx と新 DB へ書く tx は別の DB なので、もともと 1 つの tx にならない（§14.2「DB をまたぐトランザクションは無い」）。WebKit のプライベートブラウズでは旧 DB の Blob はもともと保存できていなかったので、移す物が無い
- m3-t10 が合流する前に m4 を始めない（t1 が `store.ts` を触る）

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

- 並行は 1 本まで。並行してよい組は **t3〜t5 の列と t7**（t3〜t5 は `range.ts`・`control.ts`・`weiwudi.ts`・`spec.ts`・`url_pattern.ts`・`upstream.ts`・`style_body.ts`、t7 は `migrate.ts`・`legacy.ts`・`weiwudi_gw_logic.ts`（`maintain` の 1 行）・`errors.ts`（文面 1 行）。同じファイルを触らない）と、**t6 と t8**（t6 は `store.ts`・`core.ts`・`control.ts` の `setLimits` の op・`weiwudi.ts`、t8 は `hook.ts`・`control.ts` の既存の op・`url_pattern.ts`・`spec.ts`・`registry.ts`。`control.ts` は t6 が `setLimits` の case 1 つを足すだけなので衝突しても機械的に解ける）。t3〜t5 と t6・t8 は並行しない（`control.ts`・`weiwudi.ts` を両方が触る）
- t2 は t1 の後（`store` の cursor の操作を使う）。t7 は t2 の後（`ctx.maintain` に移行の 1 バッチを乗せる）
- **公開の外形が変わるのは t2（`cacheRetention` が実際に消すようになる）・t3（`estimate`・`fetchRange`・`regions`・`cancel`・`RangeSpec`・`RegionInfo`・`FetchRangeOptions`・イベント）・t5（`releaseRange`・`clean(range, opts)`）・t6（`setLimits`）・t7（旧 DB の移行。旧 API の利用者の見え方）・t8（`warnings` の code 1 つ・`\0` の `mapID` の拒否）・t9（開発用ページ）**。どれも同じ PR で README と `docs/api` の英日を直す（rule-0001）。t9 は rule-0002 の対象になるが、README に画面写真は無い（F17）ので撮り直しは無い
- `deps.test.ts` の表は t1 で m4 の全行（`range` の行・`control` に `range`）を持たせ、後のタスクは触らない（m3 R27 と同じ）

## 水準 2（別ベンダーの AI）のレビューが要るタスク

| タスク | 理由 | 見る範囲（Codex に渡す。30 分で切り上げ、同じ確認を Claude にも並べて出す。m2・m3 のまとめの学び） |
|---|---|---|
| t3 | `fetchRange`・`estimate`・`regions`・`cancel`（公開）・範囲取得の資格情報と CORS の規則（§4.5-3・§4.6）・ジョブの再開 | `src/range.ts`・`src/upstream.ts` の差分・`src/control.ts` の差分・`src/weiwudi.ts` の差分・`docs/api/weiwudi*.md`・仕様 §4.5-3・§4.6・§7.2 |
| t5 | `releaseRange`・`clean(range, { force })`（公開）・固定を外す幾何の判定・`clean()` の regions | `src/range.ts` の差分・`src/store.ts` の差分・`docs/api/weiwudi*.md`・仕様 §7.2 の解放 |
| t6 | `setLimits`（公開）・全体 LRU・`QuotaExceededError` の再試行が旧 API の挙動を変える | `src/store.ts`・`src/core.ts` の差分・`docs/api/weiwudi*.md`・仕様 §7.1・§9 |
| t7 | 旧 DB の移行（オフライン利用者の資産。失っても壊れても気づきにくい） | `src/migrate.ts`・`src/legacy.ts` の差分・仕様 §14.2・`tests/unit/migrate.test.ts` |
| m4 の区切り | 公開 API の差分全体（m3 の区切りの commit から head）と、master への合流の差分（`master..vector-cache`） | README・`docs/api`・`dist/*.d.ts`・CHANGELOG |

t4（スタイルの範囲取得）は t3 と同じ公開 API の続きで、資格情報の配り先は m3-t7 で水準 2 を通した規則をそのまま使うので、区切りの水準 2 で見る。

## 申し送りの拾い先

state の `m4.carried_from_precheck`（P1〜P7）と `m4.carried_from_implementation`（I1〜I10。複合の項目は枝番で分ける）、m3 の台帳の「m4」宛て（L1〜L8）の全件。後へ送るものは理由を書く。

| ID | 内容（要旨） | 出どころ | 拾い先 | 決めたこと |
|---|---|---|---|---|
| P1 | O-3: 持ち主の Source の削除で範囲だけの region が残る（region は範囲取得と一緒に作る） | m1 第 6 回・state | t3（region の形）・t5 | region は Source に属し、`deleteSource` が同じ tx で消す（F1）。範囲だけで参照する Resource の Entry の固定は、持ち主の Source を消すときに外す（R12） |
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
| I3 | `stats` の `count`・`percent` を「その Source の範囲の中の Entry」で数える | m2-t8・state | t8 | 範囲（`box`）が決まる Source だけ、`[resourceId, z]` の索引を z ごとに cursor で読んで `box` の中を数える。`percent` は 100 で止める（R41） |
| I4a | control の IndexedDB の失敗を `storage` に分類する | m2-t8・state | t8 | `control.post` の `failure` で、`WeiwudiError` でない例外（DOMException など）を `storage` にする。`from` 自体は変えない（旧 API の分類を変えない）（R39） |
| I4b | `register` の途中で store が失敗したときも照合表を作り直す | m2-t8・state | t8 | `register`・`update`・`remove` が例外で終わるときも `refreshTable(ctx, [])` を 1 回呼んでから投げ直す（R40） |
| I5a | 範囲つきの `clean`・regions の削除 | m2-t8・state | t5 | 仕様 §7.2 の表どおり |
| I5b | `persist()` | m2-t8・state | t3 | ページ側の `fetchRange` が制御の要求の前に `navigator.storage.persist()` を試す（失敗は無視） |
| I5c | ジョブのイベントは `WeiwudiSource` の `message` の受け口を使う | m2-t8・state | t3 | `{ sourceId, type, regionId, … }` を `postMessage`（F8） |
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
| L1 | 固定の値が上流を待つ間に戻る競合（`commitEntry` で `old.pinned` を引き継ぐ） | m3-t4 の台帳 | t1 | `commitEntry` が tx の中で読んだ `old.pinned` と `meta.pinned` の論理和を書く。`core.save` は `savedPinned` を読まない（R6） |
| L2 | 期限切れの部分は `bytes` に残る（R7） | m3-t4 の台帳 | t2 | 掃除がレコードを消さないとき（新しい部分が残るとき）、期限切れの部分を落としてレコードを書き直す `store.pruneGlyphParts`（R8） |
| L3 | 上限を超えた結合レコードでは、新しい範囲を保存できない | m3-t4 の台帳 | t1 | `putGlyphParts` は予算を超えるとき古い部分（`fetchedAt` の昇順）から落として収める。新しい部分だけで超えるときだけ保存しない（R7） |
| L4 | 範囲取得のグリフは `putGlyphParts` を使い、同じ範囲が 2 つあるときの後勝ちを試験する | m3-t7 の台帳 | t4 | `core` の `GlyphCollector` が 1 fontstack 分を集め、`putGlyphParts` で 1 回書く（R-G） |
| L5 | 直列の待ち行列で上流を待つので取得の上限を検討（R34） | m3-t7 の台帳 | t8（Ruling と文書） | 上限を置かない（R14）。`docs/api` の英日の R34 の文に理由を 1 文足す |
| L6 | 取り直しと除去で `credentialParams` がずれる件（L1 i-2）と R3 で残した子の資格情報（L1 i-3）は実害なしとして記録 | m3-t7 の台帳 | t8（記録のみ） | 作業なし。台帳に「m3-t7 の記録どおり実害なし」と書く |
| L7 | `Bearer` の剥がしの不一致（`spec.isSecretToken` は `Bearer`・`Token`・`Basic` を剥がして `sk.` を見るが、`url_pattern.restQuery` の `isSecretPair` は剥がさない） | m3-t3 の台帳（L2 推奨） | t8 | 判定を `url_pattern` の 1 関数にし、`spec` が import する（`spec` は `url_pattern` を import できる。§3）（R35） |
| L8 | 独自名の資格情報に警告を出す | m3-t3 の台帳（L2 推奨） | t8 | テンプレートのクエリで、`credentialParams` に無い名前の値がトークンの形（`^(pk|sk|tk)\.`）なら `warnings` に `credential-undeclared: <名前>`（値は書かない）。公開の code を 1 つ足す（minor）（R36） |

m4 の後へ送るもの: I9（#78）だけ。

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
- **二重実装を作らない**: 配信は `core.serve()` 1 つ（範囲取得のタイル・スタイル・TileJSON・スプライト・グリフも通る）、`ServeInput` を作るのは `hook.serveResource` 1 つ（範囲取得も使う）、上流へ出すのは `upstream.ts`（範囲取得の no-cors の確かめもここ）、Entry のキーを作るのは `url_pattern.entryKey` 1 つ（範囲取得は展開した URL を同じテンプレートに照合して `MatchResult` を得る。R2）、素通しは `core.passThrough` 1 つ、Entry の退避は `store.commitEntry` 1 つ（全体上限も同じ関数の要素）、旧 API（`legacy.ts`）のキャッシュの処理は増やさない（移行の読み通しは `migrate.ts` の 1 関数を `serveTile` の前に呼ぶだけ）
- 既存の試験を書き換えた行は台帳に書く（m3 と同じ）

---

## m4-t1: 保存の土台の直し（L1・L3・P7 の走査・I1a・I1b・store の新しい操作）

コミット種別: `fix:`（内部。公開の挙動が変わるのは I1 の `storage` の配信だけで、§9 に記録済み）

### 対象ファイル

`src/store.ts`・`src/core.ts`・`src/constants.ts`（`DROPPED_HEADERS` を移す）・`tests/unit/store.test.ts`・`tests/unit/core.test.ts`・`tests/unit/glyph.test.ts`・`tests/unit/constants.test.ts`（追記のみ）・`tests/unit/deps.test.ts`（m4 の全行）・`tests/unit/legacy-storage-failure.test.ts`（I1 で結果が変わる行があれば書き換え、台帳に書く）・仕様 §3（表に `range.ts` の行）・§9（I1 の既知の変化を「m4 で直した」に）

### 作るもの

**固定の競合（L1・R6）**: `commitEntry` は `pinned: meta.pinned === 1 || old?.pinned === 1 ? 1 : 0` で書き、`count`・`bytes`・`pinnedBytes` の差分もその値で数える。`core.save` は `savedPinned` を読まず、`meta.pinned` は `input.pin === true ? 1 : 0`（`ServeInput.pin?: boolean` を足す。t3 の範囲取得が真を渡す。通常の配信は偽）。`putGlyphParts` も同じ規則（`next.pinned` を `commitEntry` に任せる）。

**上限を超えた結合レコード（L3・R7）**: `putGlyphParts` は、連結後の大きさが要素のどれかの `maxBytes` を超えるとき、**残す部分を `fetchedAt` の昇順に落として**収める（新しい部分は落とさない）。新しい部分だけで超えるときだけ `{ saved: false }`。退避の規則そのもの（`commitEntry`）は変えない。

**退避の走査の省略（P7・R7'）**: `commitEntry` は要素ごとに、まず `resourceIds` の Resource の `bytes − pinnedBytes` の和（tx の中で `resources.get`）と `newSize` で予算を見て、収まるなら `getAll` を呼ばない。超えるときだけ、`IX_LRU` を Resource ごとに `openCursor`（`[id, 0]` から昇順）で開き、**全 Resource の cursor の先頭のうち `accessedAt` が最小（同値はキー昇順）のものを 1 件ずつ消す**（併合。全件を配列にしない）。消した分は今のとおり `deltas` で数える。t6 の全体上限（`resourceIds` 無し）も同じ関数で、索引を `[pinned, accessedAt]` に替えるだけ。

**容量判定の読み出しの失敗（I1a・I1b・R-I1）**: `core.save` は `evictScopesFor` を `try` で囲み、失敗したら `'storage'` を返す（保存しない・配信は続ける・`x-weiwudi-error: storage`）。`serve` が reject する道は store の `getResource`・`getEntry` の失敗だけになる（m2 R3 のまま）。仕様 §9 の「保存の前の容量の判定…包括の `Error: ${e}` の本文を返す」の項を「m4 で `storage` として配信を続ける形にした」に直す。

**store の新しい操作**（t2〜t6 が使う。ここで型と試験を決める）

```ts
/** 複数の Entry を同じ tx で消し、Resource の数を直す（200 件ずつ呼ぶ） */
deleteEntries(keys: readonly string[]): Promise<void>;
/** 固定を付ける・外す（同じ tx で pinnedBytes を直す）。無いキーは飛ばす */
setPinned(keys: readonly string[], pinned: 0 | 1): Promise<void>;
/** [pinned, fetchedAt] の索引を pinned = 0・fetchedAt < before で古い順に最大 limit 件読む（メタだけ。cursor） */
listUnpinnedBefore(before: number, limit: number, after?: IDBValidKey): Promise<{ metas: EntryMeta[]; next?: IDBValidKey }>;
/** [resourceId, z] の索引で z の Entry のメタを読む（stats の範囲の数え上げ・解放の幾何） */
entriesAtZoom(resourceId: string, z: number): Promise<EntryMeta[]>;
/** グリフのレコードから部分を落として書き直す（空になれば消す）。putGlyphParts と詰め直しを共有する */
pruneGlyphParts(key: string, parts: readonly string[]): Promise<void>;
/** regions */
getRegion(id: string): Promise<RegionRecord | undefined>;
putRegion(r: RegionRecord): Promise<void>;
listRegions(sourceId: string): Promise<RegionRecord[]>;
deleteRegion(id: string): Promise<void>;
```

`RegionRecord` の形は t3 で決める（ここでは `{ id: string; sourceId: string }` を含む型として置く）。`deleteEntries`・`setPinned`・`pruneGlyphParts` は Resource の `count`・`bytes`・`pinnedBytes` を同じ tx で直す（`commitEntry` の `deltas` の処理を関数に切り出して共有する。C-O7 と同じ考え）。

**`DROPPED_HEADERS` の置き場（F24）**: `core.ts` の 4 ヘッダの一覧を `constants.ts`（import を持たない）へ移し、`core` が import する。t7 の移行が旧レコードの `headers` から同じ 4 つを落とすのに使う（`migrate` は `core` を import できない。§3）。ふるまいは変えない。

**`deps.test.ts`**: 表に `range: ['hook', 'core', 'upstream', 'context', 'store', 'spec', 'url_pattern', 'tile_math', 'style_body', 'constants', 'errors']` を足し、`control` の許可に `'range'` を足す（まだ無いファイルは m2・m3 と同じく飛ばす）。仕様 §3 の表にも同じ行を足す（役割: 範囲の正規化・列挙・ジョブ・region・解放。R1）。`control.ts` の行に `range` を足す。

### 試験

`store.test.ts` への追記（表で書く）:

- 固定の競合（L1）: `putEntry` を `pinned: 0` で呼ぶ前に、同じキーを `setPinned([key], 1)` しておく → 書いた後も `pinned === 1`・`pinnedBytes` が本体の大きさ。逆に `putEntry` を `pinned: 1` で呼ぶと `old.pinned === 0` でも 1
- 結合レコードの上限（L3）: `maxBytes` が 2 範囲分のとき、3 つ目の範囲を足すと最も古い範囲が落ちて `saved: true`・`parts` が 2 つ・`size <= maxBytes`。新しい部分 1 つで `maxBytes` を超えるときは `saved: false`
- 走査の省略（P7）: `IDBIndex.prototype.getAll` の spy が、予算内の保存で呼ばれない。予算を超える保存で候補が `accessedAt` 昇順・同値はキー昇順で消え、今の試験（`退避（putItemWithEviction と同じ規則）`）が差分なしで通る
- 2 つの Resource をまたぐ要素で、cursor の併合が `accessedAt` の順を守る（A の古い Entry → B の古い Entry → A の新しい Entry）
- `deleteEntries`・`setPinned`・`pruneGlyphParts` が `count`・`bytes`・`pinnedBytes` を全件の集計と一致させる（種を固定した 100 回）
- `listUnpinnedBefore` が固定を含めず、`before` 未満だけを古い順に `limit` 件、`next` で続きが読める
- `entriesAtZoom` が z の Entry だけを返す
- regions の 4 操作と、`deleteSource` が regions を消すこと（既存の試験の確認）

`core.test.ts` への追記: `evictScopesFor` の読み出し（`store.getSource` の spy の reject）で `x-weiwudi-error: storage`・配信は上流の本体・`entries` が増えない・**上流の `fetch` が 1 回**（I1a。直す前は reject で `serveHit` が素通しし 2 回）。

`glyph.test.ts` への追記: 固定の競合のグリフ版（`putGlyphParts` で `old.pinned` を保つ）。

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0。`store.test.ts`・`core.test.ts`・`glyph.test.ts` は追記だけ（`git diff --numstat <BASE>.. -- tests/unit/store.test.ts tests/unit/core.test.ts tests/unit/glyph.test.ts` の削除数が 0）
- `grep -c 'savedPinned' src/core.ts` が 0
- `grep -c 'getAll(IDBKeyRange.bound(\[id, 0\]' src/store.ts` が 0（走査は cursor）

---

## m4-t2: 保持期間の掃除と保守の契機（仕様 §7.1・L2）

コミット種別: `feat:`（`cacheRetention` が実際に消すようになる。公開の項目の意味が「配信の時点で無いもの」から「消す」に揃う）

### 対象ファイル

`src/core.ts`（`sweepRetention`）・`src/context.ts`（`maintain`）・`src/hook.ts`・`src/legacy.ts`・`src/control.ts`（handler の先頭で `ctx.maintain?.(event)` を呼ぶ 1 行ずつ）・`src/weiwudi_gw_logic.ts`（配線）・`tests/unit/retention.test.ts`（新規）・`tests/unit/legacy-routes.test.ts`（追記のみ）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・README の英日（`cacheRetention` の説明）・仕様 §7.1

### 作るもの

**保守の契機（R9）**: `Context.maintain?: (event: ExtendableEvent) => void` と、保守の状態 `Context.maintenance: { swept: boolean; running?: Promise<void>; migrated?: boolean }`（メモリだけ。`migrated` は t7 が使う）。配線（`weiwudi_gw_logic.ts`）が `ctx.maintain = (event) => event.waitUntil(runMaintenance(ctx))` を設定する。`runMaintenance` は配線が組む（t2 では `sweepOnce(ctx)` だけ。t7 が `migrateStep(ctx)` を足す）。呼ぶのは **Weiwudi が扱う fetch のハンドラの先頭**: `legacy.handleLegacy`・`control.post`・`control.get`・`hook` の照合ルートと門番のハンドラ。新しい `fetch` のリスナは足さない（`legacy-routes.test.ts:60` の「リスナは install・activate だけ」と「`Weiwudi_Internal` で IndexedDB を開かない」を保つ）。`maintain` の例外は `waitUntil` の Promise の中で捕まえて `console.error`（配信を止めない）。

**掃除（R10）**: `core.sweepOnce(ctx)` は SW の起動後 1 回だけ（`ctx.maintenance.swept` の印。メモリだけ）と、ジョブの完了時（t3 が呼ぶ）に走る。手順:

1. `listResources` で `policy.cacheRetention` を持つ Resource を集め、無ければ終わり。`before = now − min(cacheRetention)`
2. `store.listUnpinnedBefore(before, 200, next)` を繰り返す。各 Entry について、その Resource の `cacheRetention` が定義され `now − fetchedAt > retention` なら消す候補。Resource に retention が無ければ飛ばす
3. 候補のうちグリフでないものは `deleteEntries`（200 件ずつ）。グリフ（`body.parts` を持つ。`getEntry` で読む）は部分ごとに見て、全部が期限切れならレコードごと消し、新しい部分が残るなら `pruneGlyphParts(key, 期限切れの部分)`（L2・R8）
4. 1 回の `sweepOnce` は最大 2,000 件まで（残りは次の契機）。`stale` の配信の判定（`core.serve` の `retention` の分岐）はそのまま残す（掃除の前に当たる Entry のため）

掃除は `ctx.job` が動いている間は走らせない（ジョブの完了時に走る）。

**文書**: `cacheRetention` の説明を「期限を過ぎた Entry は配信で無いものとして扱い、SW の起動後の最初の要求とジョブの完了時にまとめて消す。固定した Entry は消さない」に直す（英日）。仕様 §7.1 の「掃除は m4」を事実に。

### 試験

`retention.test.ts`（fake-indexeddb の上の実物の store・core・ハーネス）:

- `cacheRetention` を持つ Source の Entry 3 件（期限内 1・期限切れ 2）と、持たない Source の古い Entry 1 件 → `sweepOnce` の後に期限切れ 2 件だけが消え、`count`・`bytes` が合う。持たない Source の Entry は残る
- 固定（`pinned: 1`）の期限切れは残る
- グリフ: 範囲 2 つのうち古い 1 つが期限切れ → レコードは残り `parts` が 1 つ・`size` が減る（L2）。両方期限切れ → レコードが消える
- 2,001 件の期限切れで 1 回目は 2,000 件、2 回目で残り（`listUnpinnedBefore` の `next`）
- 契機: ハーネスで `/api/ping` を 2 回 dispatch すると `waitUntilCalls` が増え、掃除は 1 回だけ走る（spy）。`Weiwudi_Internal` の呼び出しでは IndexedDB を開かない（既存の試験）
- `maintain` の中の例外（`listResources` の reject）で配信の応答は変わらず、`console.error` が 1 回

`legacy-routes.test.ts` への追記: `self` のリスナが `['activate', 'install']` のまま（既存の行の確認）と、照合ルート・門番・制御の POST の dispatch でも `waitUntilCalls` が増えること。

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0
- `grep -c "addEventListener('fetch'" src/*.ts` が 0
- `grep -c 'ctx.maintain' src/hook.ts src/legacy.ts src/control.ts` がそれぞれ 1 以上
- `grep -c 'cacheRetention' docs/api/weiwudi.md docs/api/weiwudi.ja.md` がどちらも 1 以上で、「掃除は m4」の文が無い（`grep -c 'm4' docs/api/weiwudi.md docs/api/weiwudi.ja.md` は t11 で 0 にする。ここでは `cacheRetention` の段落に無いこと）

---

## m4-t3: 範囲取得の土台とタイルの `fetchRange`（仕様 §7.2・§4.5-3・§4.6・P2・P3・P6・I5b・I5c・I5d）

コミット種別: `feat:`（`estimate`・`fetchRange`・`regions`・`cancel` と型 `RangeSpec`・`FetchRangeOptions`・`RegionInfo`。`opaque` イベント）。**水準 2 のレビュー**

### 対象ファイル

`src/range.ts`（新規）・`src/spec.ts`（`RangeSpec`・`FetchRangeOptions`・`RegionInfo` の型と `normalizeRange`）・`src/url_pattern.ts`（`expandTemplate`）・`src/upstream.ts`（`probeNoCors`・`ctx.notify` の呼び出し）・`src/context.ts`（`notify`・`JobState` の拡張）・`src/core.ts`（`ServeInput.pin` は t1 で足した。`sweepOnce` をジョブの完了時に呼ぶ口）・`src/control.ts`（op `estimate`・`fetchRange`・`regions`・`cancel`・`job/resume`）・`src/weiwudi.ts`（ページ側）・`src/weiwudi_gw_logic.ts`（`ctx.notify`）・`tests/unit/range.test.ts`・`tests/unit/range-cors.test.ts`（新規）・`tests/unit/url-pattern.test.ts`・`tests/unit/spec.test.ts`・`tests/unit/client.test.ts`・`tests/unit/upstream.test.ts`（追記のみ）・`tests/dts/page-consumer.ts`（追記）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・`README.md`・`README.ja.md`・仕様 §7.2・§12

### 作るもの

**型（`spec.ts`。公開。`dist/weiwudi.d.ts` に届く）**

```ts
export type RangeSpec =
  | { bounds: [west: number, south: number, east: number, north: number]; minZoom: number; maxZoom: number }
  | { box: TileBox; minZoom: number; maxZoom: number }
  | 'all';
export interface FetchRangeOptions {
  pin?: boolean;                               // 既定 true
  concurrency?: number;                        // 既定 5（1〜20）
  glyphRanges?: 'common' | 'all' | string[];   // 既定 'common'（t4）
  fonts?: string[];                            // 追加のフォント名（t4）
  ratio?: '' | '@2x';                          // {ratio} の値。既定 ''（R-ratio）
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

`normalizeRange(input, source: { extent?: TileExtent; scheme? })` → `{ kind: 'boxes'; boxes: TileBox[]; minZoom; maxZoom } | { kind: 'all' }`。`bounds` は緯度を `±MERC_MAX_LAT` に丸め（P3・R28）、`west > east` は 2 つの `box` に分ける（日付変更線）。`minZoom`・`maxZoom` は 0〜`MAX_TILE_ZOOM` の整数で `minZoom <= maxZoom`、外れたら `attribute-invalid`。`'all'` は Source の範囲（R30）。

**展開（`url_pattern.expandTemplate`。R2）**: `expandTemplate(template, v: { z?; x?; y?; ratio?; fontstack?; range?; spriteSuffix? })`。タイルの 7 字句は `tile_math.expandTileTemplate(…, { all: true, ratio })` に任せ、`{fontstack}` は `encodeURIComponent`、`{range}`・`{spriteSuffix}` はそのまま置く。**範囲取得はこれで URL を作り、同じテンプレートの `compileTemplate` に `matchUrl` で照合して `MatchResult` を得て、`hook.serveResource` に渡す**（キーの作り方を 2 つにしない。照合に外れたら `internal` として `storage` に数える）。

**`range.ts`**（§3 の表の行は t1 で足した）

- `enumerate(resource, normalized, ratio)`: 生成器。`normalized` の `boxes` と Resource の `extents`（Source の分）を交差させ、`z` 昇順に `[z, x, y]` を出す。Resource の `scheme` が `tms` なら **展開の前に y を反転**（`2^z − 1 − y`。Resource の `extents` は Resource の scheme の座標なので、交差はその座標で行う。R-tms）。`{-y}` は `expandTileTemplate` が面倒を見る
- `estimate(store, rec, range)`: Source の tile の Resource（スタイルは子の）ごとに `countTiles` の交差で数え、同じ Resource は 1 回。`{ tiles }` を返す。`'all'` で範囲（`box`）の無い Source は `cannot-fetch-all`（m1 の表にある code。新 API では `WeiwudiError`）（R30）
- **ジョブ**（`startRangeJob(ctx, rec, region, client, opts)`）: `core.runJob` を使う（`batchSize = concurrency`）。`isAlive` は `self.clients.get(client.id)`、`isCanceled` は `ctx.job.cancel`。各バッチの前に Source がまだあるかを見て、無ければ `stop`（`source-not-found`）（R13）。1 単位の処理:
  1. キー（`entryKey`）で `hasEntries` を見て、有れば飛ばす。`pin` なら `setPinned([key], 1)`（200 件ずつまとめる）
  2. 無ければ `serveResource(ctx, resource, new Request(url), new URL(url), m, credentials, { pin })`。`credentials` は照合表（`ctx.table.current.credentialSources`）の Resource × オリジンのもの（捕捉と同じ選び方。表が無ければ `tableChanged` で作る）（R3）。要求は `new Request(url)`（`mode: 'cors'`・`credentials: 'same-origin'` の既定。§4.5 の「テンプレートから作る要求」と同じ形）
  3. 応答の `x-weiwudi-status`・`x-weiwudi-error` で数える。`hit`・`miss`・`refresh` は成功。`stale`・`offline-miss`・`upstream-error` は `x-weiwudi-error` の種類で `errors` に数える。本体は読み切る（`arrayBuffer()`）
  4. **CORS・認証の規則（P6・R4）**: `x-weiwudi-error: network` のとき、Resource に実績（`count > 0 || corsOk`）が無ければ `upstream.probeNoCors(url)`（`fetch(url, { mode: 'no-cors' })` 1 回。保存しない）。`opaque` なら `jobOpaqueStreak++`・`upstream` に数え直す、`TypeError` なら `network` のまま。`jobOpaqueStreak` が 3 で、範囲から無作為に 5 枚（5 枚未満なら全部）を cors で確かめ（`serveResource` で通常どおり。取れた 200 は保存し進捗にも数える）、1 枚でも通れば `corsOk` が立つ（`markCors` が書く）ので続ける。1 枚も通らず opaque が 1 枚でもあれば `stop`（`opaque`）、全部が両方失敗なら `stop`（`network`）。`upstream-error` で状態が 401・403 かつ `count === 0` が 3 回続いたら `stop`（`upstream`）（§4.6）
  5. 固定分で `cacheMaxBytes` を超えるとき（開始時に `evictScopesFor` の要素の `pinnedBytes >= maxBytes`、または `x-weiwudi-error: quota` が 3 回続く）は `stop`（`quota`）（§7.1）
- **region（R5）**: 開始時に `RegionRecord`（`RegionInfo` の項目＋`normalized`）を `status: 'running'` で `putRegion`。進捗の位置は書かない。終わりに `status`（`finish` で `error === 0` なら `complete`、あれば `partial`。`canceled`・`stopped`）と `error`・`errors`・`updatedAt` を書く。id は `crypto.randomUUID()`（無ければ `Date.now()` と乱数）。`regions()` は `listRegions(sourceId)` を `RegionInfo` にして返し、**`status: 'running'` で `ctx.job` が無い（SW が止まった）ものは `partial` として見せる**（記録は書き換えない。R5）
- **イベント（I5c）**: 開始の client に `postMessage` する。`proceed`（バッチごと: `{ type, sourceId, regionId, percent, processed, total, error, errors }`）・`finish`（`{ …, error, errors }`）・`stop`（`{ …, code, message, processed, total }`）・`canceled`。旧 API の `fetchAll` の形に `sourceId`・`regionId`・`errors` を足したもの（§7.2）
- **再開（§7.2）**: op `job/resume`（`{ id, regionId }`）。`ctx.job` が動いていればそのまま（`RegionInfo` を返す）。無く、region が `running` なら、その record からジョブを作り直して開始する（既に有るタイルは飛ぶので再実行が再開）。region が無ければ `source-not-found`… ではなく新しい code を足さず `attribute-invalid`（`regionId`）
- **1 度に 1 ジョブ**: `ctx.job` があれば `fetch-busy`（m1 の表の code。旧 API の `fetchAll` と共有する）。`cancel()` は自分の Source のジョブだけ止める（`ctx.job.cancel = true`）。無ければ `no-fetch-process`
- ジョブの終わりに `core.sweepOnce(ctx)`（t2）

**`opaque` イベント（P2・I5d・R20）**: `Context.notify?: (m: { type: 'opaque'; resourceId: string; sourceIds: string[] }) => void`。`upstream.countCorsless` が `corslessUntil` を書いた（`patchResource` が値を返した）ときと、ジョブが `opaque` で止めたときに呼ぶ。配線は `range.createNotifier(ctx)` を設定する: 子 Source は親に読み替え（`store.getSource`）、`self.clients.matchAll({ type: 'window' })` の各 client に `{ type: 'opaque', sourceId, resourceId }` を送る。

**制御（`control.ts`）**: op `estimate`（`{ id, range }`）・`fetchRange`（`{ id, range, options }`。`event` と `event.clientId` の client が要る。無ければ `sw-not-controlling`）・`regions`（`{ id }`）・`cancel`（`{ id }`）・`job/resume`。`fetchRange` は region を書いて **応答を先に返し**、ジョブは `event.waitUntil` に結び付ける（F7 と同じ）。`estimate`・`regions`・`cancel`・`job/resume` は直列の外。`fetchRange` の region の書き込みと `ctx.job` の確保は直列の中（同時の 2 つの `fetchRange` が両方始まらない）。

**ページ側（`weiwudi.ts`）**: `WeiwudiSource.estimate(range)`・`fetchRange(range, opts)`・`regions()`・`cancel()`。`fetchRange` は `navigator.storage?.persist?.()` を試し（失敗は無視。I5b）、POST の応答の `RegionInfo`（`running`）を受けたら、**その `regionId` の `finish`・`stop`・`canceled` を `message` で待つ**。30 秒イベントが来なければ `job/resume` を POST し、また待つ。`finish` で `regions()` から該当の `RegionInfo` を読んで resolve、`canceled` も resolve（`status: 'canceled'`）、`stop` は `WeiwudiError(code, message)` で reject（R22）。`release()` で待ちを `instance-released` で reject する。

**文書**: `docs/api` の英日に 4 メソッド・3 型・イベントの形・`opaque` イベント・`fetch-busy`・`cannot-fetch-all`・再開の動き・「`fetchRange` の要求は `cors`・`same-origin` で出す。別オリジンで Cookie だけで認証するサーバは対象外（§4.6）」。README の英日に MapLibre の例（§12 の 4 行）を足す。仕様 §7.2 に R2〜R5・R13・R20・R22・R30 を書く。

### 試験

`url-pattern.test.ts` への追記: `expandTemplate` の全字句（`{z}/{x}/{-y}`・`{quadkey}`・`{ratio}` の 2 値・`{fontstack}` の encode・`{range}`・`{spriteSuffix}`）と、展開した URL が同じテンプレートに `matchUrl` で当たり、`entryKey` が捕捉した要求と同じキーになる（tile・glyph・sprite の 3 型）。

`spec.test.ts` への追記: `normalizeRange` の表（`bounds` の丸め・日付変更線で 2 つ・ズームの検査・`'all'`・不正な形）。

`range.test.ts`（ハーネスと偽の上流。仕様の文 1 つにつき 1 件）:

- `estimate` が `countTiles` の交差と一致し、同じ Resource を共有する 2 つの子で 1 回
- `fetchRange` が範囲のタイルを全部取り、`pinned === 1`・`pinnedBytes === bytes`。`pin: false` なら 0
- 既に有るタイルは上流へ出ずに固定だけ付く
- `tms` の Resource で y が反転した URL になり、キーが捕捉と同じ（R-tms）。`{-y}` のテンプレート
- `ratio: '@2x'` で `@2x` の URL とキー
- イベント: `proceed` が `concurrency` ごと、`finish` に `error`・`errors`・`regionId`・`sourceId`。`cancel()` で `canceled`。`stop` に `code`
- `regions()` が `complete`／`partial`（失敗あり）／`canceled`、`running` で `ctx.job` が無ければ `partial`
- `job/resume`: ジョブの途中で `ctx.job` を消して（SW の再起動の模造）`job/resume` → 残りだけ取る（上流の回数）
- `fetch-busy`（別の Source のジョブ中）・`no-fetch-process`・`cannot-fetch-all`（範囲の無い `'all'`）
- Source を `remove()` すると次のバッチで `stop`（`source-not-found`）（R13）
- `estimate`・`regions` が直列の外（`register` を待たない）
- 資格情報: `credentials` を登録した Source の範囲取得で上流の URL に `access_token` が付き、キーと `regions()` と イベントに無い。別オリジンのミラーが混ざる子（m3 R5 で `{}`）には付かない

`range-cors.test.ts`（P6・R4。仕様 §4.5-3 の文ごとに）:

- 実績の無い Resource で cors が `TypeError`・no-cors が opaque を 3 枚 → 5 枚の確かめ → 全部 opaque → `stop`（`opaque`）・`opaque` イベントが 1 回（`clients.matchAll` の偽物）
- 確かめの 1 枚が cors を通る → `corsOk` が立ち続行、確かめで取れた 200 が保存され `processed` に入る
- 全部が両方失敗 → `stop`（`network`）
- 実績のある Resource では opaque を数えず `upstream` として進む
- `count === 0` で 401 が 3 回 → `stop`（`upstream`）。`count > 0` なら止まらない
- `corslessStreak`（照合ルート）が範囲取得で増えない

`upstream.test.ts` への追記: `countCorsless` が `corslessUntil` を書いたとき `ctx.notify` が 1 回、書かなかった（実績あり）とき 0 回。`probeNoCors` の 2 値。

`client.test.ts` への追記: 4 メソッドの POST の形・`persist` を試すこと・30 秒で `job/resume`（偽のタイマ）・`stop` の reject・`release()` 後の reject。

`tests/dts/page-consumer.ts`: `RangeSpec`・`FetchRangeOptions`・`RegionInfo` の全項目と 4 メソッド。

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0
- `build` の後、`node tests/dts/check-dts.mjs dist/weiwudi.d.ts` と `node_modules/.bin/tsc -p tests/dts/tsconfig.json` が exit 0。`grep -c 'fetchRange(' dist/weiwudi.d.ts` が 1 以上
- `grep -c 'fetch(' src/range.ts` が 0（取得は `serveResource`、確かめは `upstream.probeNoCors`）
- `grep -c 'entryKey\|tileKeySuffix' src/range.ts` のうち `tileKeySuffix` が 0（キーは照合の結果から `entryKey` で作る）
- `grep -c 'fetchRange' docs/api/weiwudi.md docs/api/weiwudi.ja.md README.md README.ja.md` がいずれも 1 以上
- 水準 2 のレビューの記録が台帳にある

---

## m4-t4: スタイルの範囲取得（仕様 §7.2・§11・L4）

コミット種別: `feat:`（`kind: 'style'` の `fetchRange`）

### 対象ファイル

`src/range.ts`・`src/core.ts`（`GlyphCollector`）・`src/style_body.ts`（`collectFonts`）・`tests/unit/range-style.test.ts`（新規）・`tests/unit/style-body.test.ts`・`tests/unit/glyph.test.ts`（追記のみ）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・仕様 §7.2・§11

### 作るもの

スタイルの Source の `fetchRange` は、子の Resource を型ごとに次の順で取る（全部 `serveResource` 経由・`pin` は同じ）:

1. **スタイル**（子 `style`）: 通常の取得（`hit` でよい）。応答の本体を `style_body.parseStyle` で読み、`collectFonts(style)`（新規。`layers[*].layout['text-font']` のリテラル（文字列の配列）だけを集める。式（配列の先頭が演算子）は飛ばす）で fontstack の候補を作る。読めなければ（`invalid-style` の形）スタイルの子だけ `upstream` に数えて続ける
2. **TileJSON**（子 `tilejson`）・**データ**（`data`）: 1 件ずつ
3. **スプライト**（子 `sprite`）: `{spriteSuffix}` の 4 値（`.json`・`.png`・`@2x.json`・`@2x.png`）
4. **タイル**（子 `tile`。TileJSON の下の子も）: t3 の `enumerate` で各 Resource の範囲（`extents` の Source の分）との交差。同じ Resource は 1 回
5. **グリフ**（子 `glyph`）: fontstack は `opts.fonts` ∪ `StyleSpec.fonts` ∪ `collectFonts` の和（`text-font` の配列を `,` で結んだものが MapLibre の fontstack）。範囲は `glyphRanges`: `'common'` は `0-255`・`256-511`・`8192-8447`・`12288-12543`・`65280-65535`、`'all'` は `0-255` から `65280-65535` の 256 個、配列はそのまま（`^\d+-\d+$` の検査）（R32）

**グリフの束ね書き（L4・R-G）**: `core.createGlyphCollector(ctx, resource, key)` を足す。`ServeInput.collect?: GlyphCollector`。`core.save` は `input.part !== undefined && input.collect` のとき `putGlyphPart` を呼ばず、`collect.add({ part, body, fetchedAt, headers })` に渡して `undefined` を返す（配信は通常どおり）。ジョブは 1 fontstack の全範囲を取り終えたら `collect.flush()`（`evictScopesFor` を 1 回読み、`store.putGlyphParts(meta, parts, headers, evict)` を 1 回）。`flush` の失敗は `quota`／`storage` に数える。既に有る範囲（`hasEntries` では分からないので `getEntry` の `parts` で見る）は飛ばし、`pin` は fontstack のレコード単位で付ける。同じ範囲が並びに 2 つあれば後勝ち（`putGlyphParts` の規則。試験する）。

`estimate` はタイルだけを数える（§7.2「タイル枚数」）。`RegionInfo.total` も同じ。非タイルの資源は `processed` に入れるが `total` に入れない（`percent` は `min(100, …)`）。

**非タイル資源の固定（R11）**: スタイル・TileJSON・スプライト・データ・グリフの Entry は region に幾何で結び付かないので、固定は「その Source の region が 1 つでも残っている間」維持する（t5 の解放が外す規則）。

**文書**: `docs/api` の英日に「スタイルの `fetchRange`」の節（取る物・`glyphRanges`・`fonts`・`text-font` の式からは取れない）。仕様 §7.2・§11 を事実に。

### 試験

`style-body.test.ts` への追記: `collectFonts`（リテラルの配列・式は飛ばす・重複を除く・`layout` の無い layer）。

`range-style.test.ts`（m3-t7 の `style.test.ts` の偽の上流を使う）:

- スタイルの `fetchRange` で style・tilejson・tile・glyph・sprite（4 つ）・data が全部 Entry になり、固定される
- グリフ: fontstack 1 つ・`'common'` の 5 範囲で `putGlyphParts` が **1 回**（spy）、`parts` が 5 つ、各範囲の再生が上流の本体と同じ。`'all'` で 256。配列の指定。並びに同じ範囲を 2 つ入れた `glyphRanges` で後勝ち（L4）
- fontstack の集め方: `text-font` のリテラルと `fonts`・`StyleSpec.fonts` の和。式の `text-font` は飛ぶ
- 既に有る範囲は上流へ出ない。無い範囲だけ足す（`parts` が増える）
- `estimate` と `total` がタイルだけ。`percent` が 100 を超えない
- TileJSON の下のタイルの子も範囲の交差で取る。同じ Resource の子 2 つは 1 回
- スタイルが読めない（HTML）とき、スタイルの子だけ `upstream` に数えて他は取れる

`glyph.test.ts` への追記: `collect` のある `serve` が `putGlyphPart` を呼ばず、`flush` で 1 回書く。

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0
- `grep -n 'putEntry\|putGlyphPart' src/*.ts | grep -v '^src/store.ts' | grep -v '^src/core.ts'` が 0 件（m3 の区切りの grep のまま。`range.ts` は `GlyphCollector` 経由）
- `grep -c 'text-font' src/style_body.ts` が 1 以上、`grep -c 'text-font' src/range.ts` が 0

---

## m4-t5: 解放と範囲つき `clean`（仕様 §7.2 の解放・I5a・P1）

コミット種別: `feat:`（`releaseRange`・`clean(range, { force })`）。**水準 2 のレビュー**

### 対象ファイル

`src/range.ts`・`src/control.ts`（op `releaseRange`・`clean` の引数・`remove` の前の解放。P1）・`src/weiwudi.ts`・`tests/unit/release.test.ts`（新規）・`tests/unit/control.test.ts`・`tests/unit/client.test.ts`（追記のみ）・`tests/dts/page-consumer.ts`（追記）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・README の英日・仕様 §7.2

### 作るもの

**`releaseRange(regionId, { keep })`**: region を消し、**他の region に入らないタイルの固定を外す**。既定で Entry も消す。`{ keep: true }` なら固定だけ外す。手順（直列の中）:

1. region を読む（無ければ `attribute-invalid`（`regionId`）。他の Source の region なら同じ）。`running` で `ctx.job` が同じなら `fetch-busy`
2. その region のタイルの Resource ごとに、**その Resource を参照する全 Source（`sourceIds` ∪ `rangeOnlySourceIds`）の残る region**（`listRegions`）の `normalized` を集める（R12）
3. region の範囲を `enumerate` し（t3 と同じ生成器。y の反転も同じ）、`entriesAtZoom(resourceId, z)` の中から box に入るキーを選び、残る region のどれにも入らないキーを `setPinned(keys, 0)`（`keep`）か `deleteEntries(keys)`（既定）。200 件ずつ
4. 非タイル資源（R11）: その Source の region がこれで 0 になるときだけ、子の非タイル Resource の Entry の固定を外す（`keep` でなければ消す）
5. `deleteRegion`

**`clean(range?, { force? })`**（`WeiwudiSource.clean` の引数を足す）: 範囲があれば、範囲の中の **固定されていない** Entry を消す（共有の Resource は他の Source が参照していれば残す。今の `isExclusiveTo` の規則）。`{ force: true }` で固定も消し、**重なる region を `partial` にする**（`putRegion` で `status` を書き換える。完了済みの region の一部が無くなったため）。範囲なしの `clean()` は今の動きに **regions の削除** を足す（§7.2 の表）。

**P1（O-3）**: `applyRemove`（Source の削除）で、その Source が範囲だけで参照していた Resource（`rangeOnlySourceIds`）の Entry のうち、その Source の region に入っていて他の region に入らないものの固定を外す（`deleteSource` が region を消すので、消す前に `range.releaseAllOf(store, sourceId)` を `control.remove` が呼ぶ。`registry` は触らない）。`remove()` の順: `releaseAllOf` → 子を外す → `applyRemove`。

**文書**: `docs/api` の英日に `releaseRange`・`clean(range, opts)`・`force` と region の `partial`・解放の幾何は Resource を参照する全 Source の region で見ること・非タイル資源の固定の規則（R11）。仕様 §7.2 の解放の表に R11・R12 を書く。

### 試験

`release.test.ts`:

- 重なる 2 つの region A・B（同じ Source）: A を解放 → A だけに入るタイルが消え、重なりは固定のまま残る。`keep: true` では固定だけ外れて本体が残る
- 別の Source が同じ Resource に持つ region C と重なる A を解放 → 重なりは残る（R12）
- 非タイル資源: region が 2 つあるうち 1 つを解放 → スタイル・グリフの固定は残る。最後の region を解放 → 外れる（R11）
- `clean(range)` が範囲の中の固定されていない Entry だけ消し、固定は残る。`force: true` で固定も消え、重なる region が `partial`
- `clean()` が regions を消す
- `remove()` で範囲だけで参照していた Resource の固定が外れ、他の Source の region の分は残る（P1）
- 動いているジョブの region の `releaseRange` が `fetch-busy`
- `count`・`bytes`・`pinnedBytes` が全件の集計と一致（種を固定した 100 回の取得・解放・clean）

`control.test.ts`・`client.test.ts` への追記: op の形・直列に通ること・`regionId` の検査。

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0
- `build` の後、`node_modules/.bin/tsc -p tests/dts/tsconfig.json` が exit 0（`releaseRange`・`clean` の引数）
- `grep -c 'releaseRange' docs/api/weiwudi.md docs/api/weiwudi.ja.md README.md README.ja.md` がいずれも 1 以上
- 水準 2 のレビューの記録が台帳にある

---

## m4-t6: 全体上限 `setLimits` と `QuotaExceededError` の再試行（仕様 §7.1・P7・I7b）

コミット種別: `feat:`（`setLimits`。旧 API の挙動が §9 の既知の変化として変わる）。**水準 2 のレビュー**

### 対象ファイル

`src/store.ts`・`src/core.ts`・`src/control.ts`（op `setLimits`）・`src/weiwudi.ts`・`tests/unit/limits.test.ts`（新規）・`tests/unit/store.test.ts`・`tests/unit/core.test.ts`・`tests/unit/client.test.ts`（追記のみ）・`tests/unit/legacy-storage-failure.test.ts`・`tests/e2e/quota.spec.js`（結果が変わる行の書き換え。台帳に書く）・`tests/dts/page-consumer.ts`（追記）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・README の英日・仕様 §7.1・§9

### 作るもの

**全体の数（R15）**: `kv` の `totals`（`{ bytes, pinnedBytes, count }`）を、Entry を増減する全操作（`commitEntry`・`clearEntries`・`deleteResource`・`deleteEntries`・`setPinned`・`pruneGlyphParts`）が **同じ tx** で直す（`S_KV` を tx に足す。`deltas` の処理を共有する関数で）。`totals` が無い（既存の開発用 DB）ときは `listResources` の和で作る。

**`setLimits({ maxBytes })`**: `kv` の `limits` に保存。`undefined` で外す。`maxBytes` は 0 以上の有限の整数（外れたら `attribute-invalid`）。`evictScopesFor` は `limits.maxBytes` があれば **`resourceIds` を持たない要素**（全体）を 1 つ足す。`commitEntry` はその要素を `[pinned, accessedAt]` の索引（`[0]` から昇順）で退避する（t1 の cursor の併合と同じ関数。索引が違うだけ）。予算は `totals.bytes − totals.pinnedBytes`。

**再試行（R16）**: `core.save` は `putEntry`／`putGlyphParts`／`flush` が `quota`（`WeiwudiError.from(err).code === 'quota'`）で失敗したとき、`store.evictGlobal(ceil((totals.bytes − totals.pinnedBytes) × 0.1))`（固定以外を全体 LRU で古い順に消す。`[pinned, accessedAt]` の cursor）を 1 回行い、**1 回だけ再試行**する。再試行も失敗したら `quota`。旧 API も同じ経路（`serve` が 1 つ）。仕様 §9 の既知の変化に「容量超過のとき、固定以外を全体の 10% 退避して 1 回再試行する（1.1.x は保存しなかった）」を足す。

**文書**: `docs/api` の英日に `setLimits`・全体上限と `cacheMaxBytes` の関係（両方を満たす）・再試行。README の英日の機能一覧に 1 行。

### 試験

`limits.test.ts`:

- `setLimits({ maxBytes })` の後、2 つの Source の Entry の和が上限を超えると、Source をまたいで `accessedAt` の古い順に消える。固定は消えない
- `cacheMaxBytes` と全体上限の両方があるとき、両方を満たす
- `totals` が全件の集計と一致（種を固定した 100 回。全操作を混ぜる）
- `totals` の無い DB で最初の保存が `listResources` から作る
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

`src/migrate.ts`（新規）・`src/legacy.ts`（読み通し・`mapSetting` の参照・`\0` の拒否。文面は包括の `Error: …` の文字列で `legacy.ts` に置き、`errors.ts` の表の 16 行は触らない）・`src/weiwudi_gw_logic.ts`（`runMaintenance` に `migrateStep`）・`tests/unit/migrate.test.ts`（新規）・`tests/unit/legacy-store-repair.test.ts`（§13 の表の「移す」3 件を足す。追記のみ）・`tests/unit/legacy-changes.test.ts`（`\0` の拒否。追記のみ）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・README の英日・CHANGELOG は t11・仕様 §9・§14.2

### 作るもの

**状態（`kv`）**: `migration = { stage: 'pending' | 'settings' | 'tiles' | 'done'; maps: Record<mapID, { status: 'pending' | 'copying' | 'done' | 'failed'; failures: number }>; startedAt; updatedAt }`。無ければ `pending`。`done` はメモリにも覚え（`ctx.maintenance.migrated`）、以後の契機で IndexedDB を読まない。

**旧 DB の有無（R17）**: `indexedDB.databases()` があれば、名前が `Weiwudi` か `Weiwudi_` で始まるものを集める。無い環境（古い Firefox）では `Weiwudi` を `indexedDB.open('Weiwudi')`（版なし）で開き、`mapSetting` が無ければ空で完了して **自分で作った空の DB は消す**（`deleteDatabase`）。

**第 1 段（`settings`）**: `Weiwudi.mapSetting` の全件を読み、`legacy.registerMap` と同じ形（`kind: 'legacy'`・`spec: {}`・`legacy: 設定`・Resource は `resourceOf(設定)`）で `sources`・`resources` に書く（**既に `sources` にあれば触らない**。新しい版で先に `add` した地図を上書きしない）。`mapSetting` が無い（#47 の壊れた DB）・DB が無いなら空で完了。`maps` に `tileCache` を持つ `mapID` を `pending` で並べる。**第 1 段が終わるまで、旧 API の地図の参照（`getSetting`）は `sources` に無ければ `mapSetting` も見る**（`migrate.readLegacySetting(mapID)`）。

**第 2 段（`tiles`）**: `maps` の `pending`／`copying` を 1 つ選び（`mapID` の順）、`Weiwudi_<mapID>.tileCache` を `openCursor` で **200 件**読み（1 バッチ）、tx の外で `blob.arrayBuffer()` に変換し、`store.putEntry`（`key = map:<mapID>\0<z_x_y>`・`fetchedAt = epoch`・`accessedAt = accessedAt ?? epoch`・`z, x, y` は `z_x_y` を分解・`size = blob.size`・`pinned: 0`・`contentType = headers['content-type']`・`headers` は名前を小文字にして `constants.DROPPED_HEADERS` の 4 つを落とす（t1 で移した一覧。`core.copyHeaders` と同じ規則）・`evict` は `evictScopesFor`）で新 DB へ書いてから、**旧レコードを消す**（別 tx）。既に新 DB に同じキーがあれば（読み通しで先に移したもの）旧レコードを消すだけ。1 レコードの失敗は飛ばして続ける（`failures++`）。cursor が尽きたら `done`。`Weiwudi_<mapID>` に `tileCache` が無ければ `done`。**地図単位で 3 回（バッチの開始の失敗。open の失敗など）失敗したら `failed`** にし、読み通しのまま残す。

**契機**: `migrateStep(ctx)` は `runMaintenance` の中（t2 の `ctx.maintain`。Weiwudi が扱う fetch のたび）で 1 バッチだけ進める。進行中の Promise は 1 つ（同時の契機で 2 バッチ走らせない）。`activate` は待たせない。

**読み通し（R18）**: `legacy.getImage` は `migration.stage !== 'done'` かつその `mapID` が `done` でないとき、`serveTile` の前に `migrate.pullTile(store, mapID, z, x, y)` を呼ぶ: 新 DB にキーが無く、`Weiwudi_<mapID>.tileCache` に `z_x_y` があれば、変換して `putEntry` し旧レコードを消す。その後は `serve` が通常どおり Entry を見る（配信の経路は 1 つのまま）。`pullTile` の失敗は飲み込んで `serve` に進む。

**完了**: 全地図が `done`（`failed` が無い）になったら `Weiwudi_<mapID>` を全部と `Weiwudi` を `deleteDatabase`。`blocked`（閉じない接続）なら消さずに `stage` を `done` にし、`maps` の `pendingDelete: string[]` に残して**次の起動の最初の契機で消し直す**（§9「旧 DB の削除は次の起動へ回す」）。`failed` が 1 つでもあれば `stage` を `done` にせず、旧 DB も消さない（読み通しのまま）。

**`\0` の `mapID`（I7c・R19）**: `add` で `mapID` に `\0` が含まれていれば `Error: MapID must not contain a NUL character` の文字列で拒否する（新しい文面。包括の形。§9 の既知の変化に足す）。移行でも `\0` を含む `mapID` の地図は `failed` にして飛ばす（旧 DB にも残す）。

**文書**: README の英日に「1.1.x のキャッシュは最初の要求から順に引き継ぐ（数 GB でも止まらない。移行中もオフラインで読める）。1.1.x へ戻しても壊れない（取り直しになる）」。`docs/api` の英日の旧 API の節に同じ 2 文。仕様 §14.2 に R17〜R19 を書き、§9 の既知の変化に `\0` の拒否を足す。

### 試験

`migrate.test.ts`（`fake-indexeddb` の `IDBFactory` に旧 DB を作る。F22 の書き方）:

- 旧 `Weiwudi`（`mapSetting` 2 件）と `Weiwudi_a`（`tileCache` 450 件）・`Weiwudi_b`（0 件）→ 契機 1 回で第 1 段が終わり `sources` に 2 件。契機 3 回で `a` の 450 件が新 DB に入り（200・200・50）、`b` は `done`、旧 DB が消えている。`count`・`bytes` が合う
- 変換: `epoch`→`fetchedAt`・`accessedAt` が無ければ `epoch`・`z_x_y`→`z, x, y`・`size`・`contentType`・本体のバイト列が同じ（ArrayBuffer）
- 途中で止める（契機を 1 回）→ 旧にも新にも残る → 続きの契機で冪等に完了（二重に数えない）
- 読み通し: 第 2 段の途中で `/api/cache/a/z/x/y`（新に無く旧にある）→ `hit` で配信され、新 DB に移り旧から消える。オフラインでも配信される
- 第 1 段の前に `/api/info?mapID=a` が `mapSetting` から読める
- `sources` に既にある `mapID` は上書きしない
- 1 レコードの壊れた記録（`blob` が無い）を飛ばして続ける。`open` が 3 回失敗する地図が `failed` になり、旧 DB が消えず読み通しが続く
- `blocked`（閉じない接続）で `deleteDatabase` が待ちになっても契機は終わり、次の SW の最初の契機で消える
- `indexedDB.databases` が無い factory で、旧 DB が無ければ空で完了し、自分で作った `Weiwudi` が残らない
- `\0` を含む `mapID` の `add` が文字列で拒否され、移行では `failed`

`legacy-store-repair.test.ts` への追記（§13 の表の「移す」）: 旧 `Weiwudi` が store を持たなくても移行が空で完了して `add` が通る／旧 DB が `blocked` でも `delete` は成功し、旧 DB の削除は次の起動へ回る。

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0。`legacy-store-repair.test.ts`・`legacy-changes.test.ts` は追記だけ
- `grep -c 'fetch(' src/migrate.ts` が 0、`grep -c 'indexedDB' src/legacy.ts` が 0（旧 DB を触るのは `migrate.ts` だけ）
- `grep -c 'MapID must not contain a NUL character' src/legacy.ts docs/api/weiwudi.md docs/api/weiwudi.ja.md` がいずれも 1 以上
- 水準 2 のレビューの記録が台帳にある

---

## m4-t8: 制御と門番の堅牢化（I2・I3・I4・I6・I8・I10・L5〜L8）

コミット種別: `fix:`（`warnings` の code 1 つを足す）

### 対象ファイル

`src/hook.ts`・`src/control.ts`・`src/url_pattern.ts`・`src/spec.ts`・`src/store.ts`（`entriesAtZoom` は t1 で足した。触らない）・`tests/unit/control.test.ts`・`tests/unit/hook.test.ts`・`tests/unit/spec.test.ts`・`tests/unit/url-pattern.test.ts`・`tests/unit/m3-credentials.test.ts`（追記のみ）・`docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・`README.md`・`README.ja.md`・仕様 §4.3・§10・§12

### 作るもの

- **I2b（R38）**: `control.refreshTable` は `tableChanged` を `GATE_WAIT_MS` の `withTimeout`（`hook` から export）で待ち、超えたら今の失敗時と同じ（表を捨て、`[]` を返す。登録は成功）。I2a は直さず台帳に記録
- **I3（R41）**: `statsOf` は `total` が決まる Source だけ、`count` を「`box` の中の Entry」で数える: 各 tile の Resource について z ごとに `entriesAtZoom` を読み、`scaleTileBox(box, maxZoom, z)` に入るものを数える。`percent = min(100, floor(count × 100 / total))`。`byResource` と `size` は今のまま（Resource の数）
- **I4a（R39）**: `control.post` の `failure(e)` で、`e` が `WeiwudiError`（印あり）でなく `from` が `internal` にするものは `storage`（`detail: { name }`）にする。`quota`・`db-blocked` は `from` のまま
- **I4b（R40）**: `register`・`update`・`remove`・`removeResource` の `serial` の中で例外が出たら `refreshTable(ctx, [])` を 1 回呼んでから投げ直す（表を古いまま固めない）
- **I8b（R34）**: `hook.tableChanged` の `postMessage` を 100 ms でまとめる（`ctx.table.notifyTimer`。最後の変更から 100 ms 後に 1 回）。受け手の `reload` は今のまま
- **L7（R35）**: `url_pattern` に `isSecretValue(v)`（`Bearer`・`Token`・`Basic` と空白を剥がして `sk.` で始まる。decode した値も見るのは呼び出し側）を置き、`spec.isSecretToken` と `url_pattern.isSecretPair` の両方がそれを使う。挙動の違いは「キーの残りのクエリから `Bearer sk.…` の値の項目も除く」だけ
- **L8（R36）**: `spec.normalizeMember` で、テンプレートのクエリのうち `credentialParams`（既定＋宣言）に無い名前の値が `^(pk|sk|tk)\.` に当たるとき、`warnings` に `credential-undeclared: <名前>` を足す（値は書かない。`sk.` は今のとおり拒否が先）。登録は成功。公開の code を §12・`docs/api` の表に足す
- **文書**: I6（別スコープの SW からの同時の登録は直列にならない）・I8a（署名つき URL は署名の項目を `credentialParams` に挙げる。SW は署名を作れない）・I8c（門番は利用者が評価の後に登録したルートより先に受ける。§4.3 と README）・L5（R34 の文に「上限は置かない。遅い上流を失敗にすると登録そのものが失敗するため」）を英日に書く。I10・L6・I2a は台帳に記録だけ

### 試験

- `control.test.ts` への追記: `tableChanged` が解決しない（`buildTable` を止める）とき `register` が `GATE_WAIT_MS` 後に成功し `ctx.table.current` が消える／`stats` の `count`・`percent` が範囲の中だけ（共有の Resource に範囲の外の Entry を入れて 100 を超えない）／DOMException の失敗が `storage`／`register` の途中の store の失敗の後に `tableChanged` が呼ばれている（spy）
- `hook.test.ts` への追記: 3 回の `tableChanged` で `postMessage` が 1 回（偽のタイマ）
- `url-pattern.test.ts`・`spec.test.ts`・`m3-credentials.test.ts` への追記: `?auth=Bearer%20sk.eyJ…` がキーから除かれる／`?mytoken=pk.abc` で `credential-undeclared: mytoken` が `warnings` にあり値が無い／`credentialParams: ['mytoken']` なら出ない／`sk.` は `credential-rejected` のまま

### 受け入れ条件

- 上の試験と既存の単体試験が exit 0
- `grep -c 'isSecretValue' src/spec.ts src/url_pattern.ts` がどちらも 1 以上、`grep -ci 'bearer' src/spec.ts` が 0（判定も注記も `url_pattern` へ移す。1 か所）
- `grep -c 'credential-undeclared' docs/api/weiwudi.md docs/api/weiwudi.ja.md` がどちらも 1 以上
- `grep -c 'X-Amz-Signature' README.md README.ja.md` がどちらも 1 以上（I8a の例として）

---

## m4-t9: 開発用ページを新 API に直す（#41）

コミット種別: `feat:`（開発用ページ。配布物ではない）

### 対象ファイル

`index.html`・`public/demo-sw.js`（変えない見込み。変えるなら対象に足す）・`README.md`・`README.ja.md`（開発サーバの節の機能一覧）・`tests/unit/demo-third-party.test.ts`（`index.html` の外部の読み込みに `integrity` があることの既存の試験。通ることを確かめる）

### 作るもの

#41 の完了条件は「現行の設計に合わない操作が残っていない」「開発用ページから基本動作を確認できる」。`index.html` を新 API で書き直す（R25）:

- `Weiwudi.registerSW('./demo-sw.js', { scope: './' })` のまま。登録は `Weiwudi.register({ kind: 'raster', id: 'osm_demo', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', bounds: [139.71, 35.63, 139.81, 35.73], minZoom: 14, maxZoom: 17 })` にし、Leaflet には `source.url` を渡す（実 URL の捕捉。旧 API の `map.url` を使わない）
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

`migrate.spec.js`（`legacy-seed.html` が 1.1.1 の形の旧 DB（`Weiwudi.mapSetting` と `Weiwudi_x.tileCache` に Blob）を IndexedDB に直接作る。SW を登録してから `/api/cache/x/z/x/y` を読む）:

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
- **合流**: `vector-cache` → `master` の PR を 1 つ（squash しない。merge commit）。本文に CHANGELOG の `Unreleased` の要約・移行の有無・水準 2 の記録を書く。合流の後、`vector-cache` は残す（次のトレインまでの直しの枝）

### 試験

- 5 コマンドが exit 0。`build` の後、**dist の 4 点（P4）**: `test -f dist/errors.d.ts`・`grep -c 'class WeiwudiError' dist/weiwudi.d.ts` が 1 以上・`grep -c 'export' dist/weiwudi.es.js` が 1 以上かつ `grep -c 'WeiwudiError' dist/weiwudi.umd.js` が 1 以上・`grep -c 'x-weiwudi-error' public/weiwudi-sw.js` が 1 以上（確かめた後で `git restore`）
- `node tests/dts/check-dts.mjs dist/weiwudi.d.ts`・`node tests/dts/check-dts.mjs dist/weiwudi_gw.d.ts`・`node_modules/.bin/tsc -p tests/dts/tsconfig.json` が exit 0

### 受け入れ条件

- `grep -c -E '\bm4\b|upcoming' README.md README.ja.md docs/api/weiwudi.md docs/api/weiwudi.ja.md docs/api/sw.md docs/api/sw.ja.md` がすべて 0
- `grep -c 'Unreleased' CHANGELOG.md` が 1、`git diff --quiet <BASE>.. -- package.json` が exit 0（版番号を変えない）
- **t7 が合流済み**（`git log --oneline origin/vector-cache | grep -c 'm4-t7'` が 1 以上。P5・state の `merge_condition`）
- m4 の区切り（下）の全体レビュー・セキュリティ点検・水準 2 が終わり、台帳に記録がある
- `master` への PR の CI（`test` の Node 22・24 と `e2e-engines`）が緑

---

## m4 の区切りで確かめること

- 軽い道 §6 の全体のレビュー（水準 1 と、公開 API の差分に水準 2）・セキュリティ点検・要約
- セキュリティ点検で特に見るもの: 範囲取得の要求に付く資格情報が捕捉と同じ相手（オリジン・提供元）に限られること（R3）・`regions()`・イベント・`RegionInfo`・`stop` の文面に資格情報と URL のクエリが出ないこと（§10）・`job/resume` と `releaseRange` が他の Source の region を触れないこと・制御の送り手の検査（m3 R25）が新しい op にも効くこと・移行が旧 DB の `headers` から `set-cookie` などの 4 ヘッダを落とすこと・`probeNoCors` が資格情報を付けないこと
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
- `usage()`・`stats()` は Resource の `count`・`bytes` で数えるので、区画の Entry も自然に入る

## 事前点検で見てほしい範囲

m2・m3 と同じく差分ではなく通して見てほしい。

1. **固定の規則（R6・R11・R12）**: `commitEntry` の論理和で競合が消えるか。非タイル資源を region 単位で固定する決定が、`clean(range, { force })`・`remove()`・共有の Resource（2 つのスタイルが同じグリフを共有し、片方だけが region を持つ）で正しいか
2. **範囲取得の経路（R2・R3・R4）**: 展開 → 照合 → `serveResource` の 1 本道で、キーが捕捉と一致するか（`tms`・`{-y}`・`{ratio}`・固定値のクエリ・`sku` のような要求ごとに変わる項目が無いこと）。資格情報が照合表の選び方と同じ相手に限られるか。CORS の規則（§4.5-3）の 5 枚の確かめの置き場がジョブの側で足りるか
3. **ジョブの再開（R5・R22）**: `running` の region と `ctx.job` の無い SW の組み合わせ、ページが閉じたときの region の見え方、`fetch-busy` と旧 API の `fetchAll` の共有
4. **グリフの束ね書き（R-G）**: `GlyphCollector` が配信の経路（`core.serve`）を変えずに保存だけ遅らせること。`flush` の失敗の数え方。既に有る範囲の判定
5. **全体上限と再試行（R15・R16）**: `totals` を全操作の同じ tx で直すことの抜け（`deleteResource`・移行の `putEntry`）。再試行の 10% の根拠は §7.1 の決め
6. **移行（R17〜R19）**: 1 バッチ 200 件・契機のたびに 1 バッチ、で数 GB の利用者が困らないか（要求のたびに進むので、地図を見ている間に進む）。`failed` の地図が永久に読み通しで残ること。`databases()` の無い環境の扱い
7. 申し送りの表の 35 件が、それぞれの拾い先のタスクの「作るもの」と「試験」に実際に入っているか
8. #78 の節の 5 点が、t1〜t7 の設計と矛盾しないか

## Ruling

- R1: 範囲取得・解放は新しい `range.ts` に置き、`control.ts` が呼ぶ。依存は `hook`・`core`・`upstream`・`context`・`store`・`spec`・`url_pattern`・`tile_math`・`style_body`・`constants`・`errors` — `control.ts` は `url_pattern` を import できず（§3）、範囲取得は展開・照合・配信・store を使う。m3 の `style.ts` と同じ切り方 — 誤りなら `control.ts` が太るだけ
- R2: 範囲取得の URL は `expandTemplate` で作り、同じテンプレートに `matchUrl` で照合して `MatchResult` を得て `serveResource` に渡す。キーは `entryKey` 1 つ — 展開からキーを直接組むと、捕捉のキー（`restQuery`・`{spriteSuffix}`・`tms`）と 1 字ずれただけで二重保存になる — 誤りなら照合の 1 回分だけ遅い
- R3: 範囲取得の要求は `new Request(url)`（`cors`・`same-origin` の既定）で `serveResource` を通し、資格情報は照合表の `credentialSources`（Resource × オリジン）から選ぶ — §4.5 の「テンプレートから作る要求」と同じ形で、捕捉と同じ相手にだけ資格情報を送る（m3 R5・m2 I2） — 誤りなら範囲取得だけ資格情報が付かない相手が出る（README に書く）
- R4: 範囲取得の CORS・認証の規則（§4.5-3・§4.6）は `range.ts` のジョブの側で、serve の応答の `x-weiwudi-error` と `upstream.probeNoCors`（`fetch(url, { mode: 'no-cors' })` 1 回。保存しない）で判定する — `createUpstream` は元の要求が `cors` のとき取り直さない（§4.5 の 4）ので、ジョブが確かめる。上流へ出す関数は `upstream.ts` に置いて「fetch は upstream だけ」を保つ — 誤りなら `createUpstream` に範囲取得の分岐を足す
- R5: region は `{ id, sourceId, range, normalized, status, pinned, total, error, errors, code?, createdAt, updatedAt }` を `regions` に持ち、進捗の位置は書かない。`running` で `ctx.job` が無いものは `regions()` で `partial` として見せる — §7.2「進捗の位置は持たない。再実行が再開」。SW が止まった region を `running` のまま見せると利用者が待ち続ける — 誤りなら `interrupted` の値を足す（minor）
- R6（L1）: `commitEntry` は tx の中で読んだ `old.pinned` と `meta.pinned` の論理和を書き、`core.save` は `savedPinned` を読まない。`ServeInput.pin` が真のときだけ `meta.pinned = 1` — 上流を待つ間に `setPinned` が入っても固定が戻らない。外す側（`releaseRange`）と足す側が同時のときは足す側が勝つ（キャッシュなので安全側） — 誤りなら解放の直後の取得で固定が残る（次の解放で外れる）
- R7（L3）: `putGlyphParts` は連結後の大きさが予算を超えるとき、残す部分を `fetchedAt` の昇順に落として収める。新しい部分だけで超えるときだけ保存しない — 結合レコードは 1 Entry なので LRU では丸ごとしか消えず、新しい範囲が永久に入らない — 誤りなら古い範囲の再取得が増えるだけ
- R7'（P7）: 退避は `bytes − pinnedBytes` で予算内なら走査せず、超えるときだけ `IX_LRU`（全体上限は `[pinned, accessedAt]`）の cursor を Resource ごとに開いて併合し、1 件ずつ消す — 上限つきの保存のたびに全件 `getAll` するのは 100 万 Entry で効かない（§5.4 の狙い） — 誤りなら cursor の数だけ要求が増える（Resource の数は少ない）
- R8（L2）: 期限切れの部分は掃除のときに `pruneGlyphParts` で落としてレコードを書き直す。配信の経路は変えない — 配信のたびに書き直すと hit が書き込みになる。掃除は起動後 1 回とジョブの完了時なので回数が少ない — 誤りなら期限切れの部分が次の掃除まで `bytes` に残る
- R9: 掃除と移行の契機は `ctx.maintain`（Weiwudi が扱う fetch のハンドラの先頭で `event.waitUntil`）。新しい `fetch` のリスナを足さない — 利用者の要求（プリキャッシュなど）で IndexedDB を開かない。`legacy-routes.test.ts:60` の固定（リスナは install・activate だけ・起動で IndexedDB を開かない）を保つ — 誤りなら Weiwudi の要求が無いページで移行が進まない（その利用者はキャッシュも使っていない）
- R10: 掃除は `[pinned, fetchedAt]` の 1 本の cursor（`pinned = 0`・`fetchedAt < now − 最短の retention`）で読み、Resource ごとの retention で判定する。1 回 2,000 件まで — Resource ごとの索引を足すと版を上げる。上限を最短の retention で切るので、retention の無い Resource の Entry は訪れない（`fetchedAt` が上限より新しいものも訪れない） — 誤りなら retention の無い Source の古い Entry を読み飛ばす分だけ遅い
- R11: 非タイル資源（スタイル・TileJSON・スプライト・データ・グリフ）の固定は region に幾何で結び付けず、その Source の region が 1 つでも残る間は維持する。最後の region の解放で外す — 非タイル資源は範囲を持たないが、どの region のためにも要る。スタイル 1 枚のために region ごとの参照カウントを Entry に持たない（§7.2「Entry 側に参照カウントを持たない」） — 誤りなら region ごとにスタイルを取り直すだけ
- R12: 解放の幾何の判定は、その Resource を参照する全 Source（`sourceIds` ∪ `rangeOnlySourceIds`）の region で見る — Entry は Resource 単位で共有されるので、別の Source の region のタイルを消すと、その Source のオフラインが壊れる — 誤りなら他の Source の region を数え忘れた分だけ余計に消える（キャッシュなので取り直せる）
- R13: ジョブは直列の待ち行列の外で動く（旧 `fetchAll` と同じ）。各バッチの前に Source の有無を見て、無ければ `stop`（`source-not-found`）。Resource が消えていれば `serve` が保存せず上流を配信するので続けてよい — 長いジョブで `register`・`update` を待たせない。`remove()` された Source のために取り続けない — 誤りなら 1 バッチ分の取得が無駄になるだけ
- R14（L5）: スタイルの登録の上流待ち（m3 R34）に上限を置かない — 遅い上流を失敗にすると登録そのものが `invalid-style`／`fetch-failed` になり、オフライン中心の用途で悪化する。待たされるのは書き換えの op だけで、読み取りと配信は待たない。`AbortSignal` は `upstream.rebuild` が写さない（m2-t7 の Info）ので、上限を効かせるには別の直しが要る — 誤りなら `rebuild` に `signal` を写してから段ごとの上限（60 秒）を足す
- R15: 全体の `bytes`・`pinnedBytes`・`count` は `kv` の `totals` に持ち、Entry を増減する全操作の同じ tx で直す。全体上限は `kv` の `limits` — 保存のたびに全 Resource を読まない。`totals` が無い DB は `listResources` の和で作る — 誤りなら `totals` がずれた分だけ全体上限が早く・遅く効く（`usage()` は Resource の和なので正しいまま）
- R16（P7・I7b）: `QuotaExceededError` のとき、固定以外を全体 LRU で `(bytes − pinnedBytes) × 10%` 退避して 1 回だけ再試行する。旧 API も同じ — §7.1 の決め。全体上限の既定が無いので、これが無いとブラウザの上限に当たった後は自力で回復しない。旧 API の試験の結果が変わる点は §9 に書く — 誤りなら 10% を変えるだけ
- R17: 旧 DB の有無は `indexedDB.databases()` で見る。無い環境では `Weiwudi` を版なしで開き、`mapSetting` が無ければ空で完了して自分で作った空の DB を消す — §14.2「open は無い DB を新しく作ってしまう」。古い Firefox でも移行を飛ばさない — 誤りなら空の `Weiwudi` が 1 つ残る（1.1.x が作る形と同じで害は無い）
- R18: 移行中の読み通しは `legacy.getImage` が `serveTile` の前に `migrate.pullTile` を呼ぶ形（旧にあれば新へ移してから `serve`）。配信の経路は `core.serve` 1 つのまま — `serve` に旧 DB の分岐を足すと core が legacy を知る（§3 に反する） — 誤りなら読み通しの 1 件ごとに新 DB の `hasEntries` が 1 回増えるだけ（移行中だけ）
- R19（I7c）: `mapID` に `\0` があれば `add` で `Error: MapID must not contain a NUL character` の文字列で拒否する。移行では `failed` にして旧 DB に残す — 16 行の文面は変えられず、既存の `attribute-invalid` の文面は `cacheMaxBytes` 固定。これまでは黙って他の地図の範囲にかぶっていた — 誤りなら id を符号化する形へ（キーの形が変わるので m4 の中では採らない）
- R20（P2・I5d）: `opaque` イベントは `corslessUntil` を書いた所（照合ルート経由の `countCorsless`・ジョブの 5 枚の確かめの失敗）から `ctx.notify` で 1 回送る。配線が `clients.matchAll({ type: 'window' })` の全 client に `{ type: 'opaque', sourceId, resourceId }` を送り、子 Source は親に読み替える — 照合ルートには client の文脈が無い（要求を出した client は分かるが、ページの `WeiwudiSource` はどの client にもいる）。`WeiwudiSource` は `sourceId` で選ぶ（F8） — 誤りなら他のページにも届く（`sourceId` が違えば無視される）
- R21（I5c）: ジョブのイベントは開始した client（`fetchRange` の POST の `event.clientId`）に `postMessage` し、`{ type, sourceId, regionId, … }` の形で旧 `fetchAll` の項目を保つ — §7.2「同じ形で使い regionId・errors を足す」。F8 の受け口にそのまま乗る — 誤りなら `clients.matchAll` へ替える（再開は別の client から来うるので、`job/resume` の client にも送る）
- R22: ページ側の `fetchRange` は POST の応答（`running` の `RegionInfo`）を受けた後、その `regionId` の `finish`・`stop`・`canceled` を待って解決する（`canceled` も解決。`stop` だけ reject）。30 秒イベントが来なければ `job/resume` を POST — §7.2 のとおり。`canceled` は利用者の意図なので失敗にしない — 誤りなら `canceled` を reject に替える（新しい code が要る）
- R23: 1 度に 1 ジョブ（`ctx.job`）を旧 API の `fetchAll` と共有し、同時は `fetch-busy`。`cancel()` は自分の Source のジョブだけ止め、無ければ `no-fetch-process` — §7.2「現行の `fetchAllBlocker` と同じ」。m1 の表の code を使い新しい code を足さない — 誤りなら Source ごとのジョブに広げる
- R24: 「取れた」は `x-weiwudi-status` が `hit`・`miss`・`refresh`。`stale`・`offline-miss`・`upstream-error` は `x-weiwudi-error` の種類で数える。既に有る Entry は上流へ出さず固定だけ付ける — 旧 `fetchAll` と同じ数え方（m2-t5 の Ruling）。固定は region のために要る — 誤りなら `stale` を成功に数える
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
- R39（I4a）: `control.post` は `WeiwudiError` でない例外を `storage`（`detail.name`）にする。`WeiwudiError.from` は変えない — `from` は旧 API の文面の分類を担うので変えない。制御の失敗で `internal` と `storage` を分けると利用者が「容量・ブラウザの状態」と「Weiwudi の不具合」を見分けられる — 誤りなら `from` に DOMException → `storage` の規則を足す
- R40（I4b）: `register`・`update`・`remove`・`removeResource` が例外で終わるときも `refreshTable(ctx, [])` を 1 回呼ぶ — 途中まで書いた Resource が照合表に無いと、次の要求で表が古いまま固まる（門番は `current` があれば読み直さない） — 誤りなら失敗のたびに表を 1 回作り直すだけ
- R41（I3）: `stats` の `count`・`percent` は、範囲（`box`）が決まる Source だけ `[resourceId, z]` の索引で `box` の中を数え、`percent` は 100 で止める。`byResource`・`size` は Resource の数のまま — 共有の Resource で 100 を超える `percent` は利用者を迷わせる。`size` は範囲で分けられない（Entry の大きさは座標で分けられるが、`stats` のたびに読むのは重い） — 誤りなら `count` も Resource の数に戻し `percent` だけ止める
- R-I1（I1a・I1b）: `evictScopesFor` の失敗は `storage` として配信を続ける — §9 に記録済みの形。`serve` の reject を照合ルートが素通しにして上流へ 2 回出るのを止める — 誤りなら保存されない応答が増えるだけ
- R-I6（I6）: 同じオリジンの別スコープの SW からの同時の登録は直列にならないことを文書に書き、直さない — SW をまたぐ鎖（Web Locks）は Safari の対応が限られ、1 つのスコープで登録するのが普通 — 誤りなら Web Locks を使えるときだけ使う形を足す
- R-I8（I8a）: 署名つき URL は、署名の項目を `credentialParams` に挙げる使い方を文書に書く。SW が署名を作る口は足さない — 署名は要求ごとに変わるのでキーに残すと同じタイルが別の Entry になる。署名を作るのは利用者の鍵が要り SW の役ではない — 誤りなら `requestWillFetch` の差し込み口で利用者が署名する例を文書に足す
- R-G（L4）: グリフの束ね書きは `core.createGlyphCollector` が保存だけを遅らせ（`save` が `putGlyphPart` の代わりに `collect.add`）、ジョブが fontstack ごとに `flush`（`putGlyphParts` 1 回）する。配信の経路は変えない — §11「1 fontstack 分を溜めてから 1 回で書く」を `core.serve` 1 つのまま満たす — 誤りなら範囲ごとに書く（fontstack の大きさ × 範囲数の書き込み。動くが遅い）
- R-ratio: `{ratio}` のテンプレートの範囲取得は `FetchRangeOptions.ratio`（既定 `''`）の値で展開する — どちらを取るかは利用者の端末で決まり、SW は知らない。両方を取ると 2 倍になる — 誤りなら既定を `@2x` にするか両方を取る指定を足す
- R-tms: `scheme: 'tms'` の Resource は、Resource の座標（`extents` は Resource の scheme）で交差を取り、展開の前に y を反転する。`{-y}` は `expandTileTemplate` が面倒を見る — 捕捉の `MatchResult` は URL の値（tms なら tms の y）で、キーもその値。範囲取得が xyz の y で展開すると別の Entry になる — 誤りなら試験（`tms` のキーが捕捉と同じ）が落ちる

## 未決の点（事前点検と実装で決める）

- U1: `credential-undeclared`（R36）の形の表 `^(pk|sk|tk)\.` は Mapbox の形から決めた。他の配信元の公開トークンの形（例が集まれば）を足してよい。m3-t3 L2 の「独自名の資格情報に警告」の意図がこれと違えば、t8 の実装の前に進行役が台帳の記録を読み直して直す
- U2: 掃除の 1 回の上限 2,000 件（R10）と移行の 1 バッチ 200 件（§14.2）は、実測なしの値。t2・t7 の e2e で Chromium の 1 バッチの時間を記録し、1 秒を超えるなら下げる
- U3: `job/resume` の 30 秒（§7.2）は、`proceed` がバッチごとに出るので、上流が 1 バッチに 30 秒以上かかる（5 枚で 6 秒/枚）と再開を送ってしまう。`ctx.job` が動いていれば `job/resume` は何もしないので害は無い。t10 の実測で揺れるなら 60 秒にする
- U4: `RegionInfo.range` は利用者が渡した `RangeSpec` のまま返す（正規化した `box` ではない）。`'all'` のときに実際の範囲を知りたい要望が出れば `normalized` を公開する（minor）
- U5: 全体上限の退避（`[pinned, accessedAt]` の cursor）は旧 API の Resource の Entry も消す（全体なので）。旧 API の利用者には `setLimits` を呼ばなければ効かないので変化は無い。再試行（R16）は旧 API にも効く（§9 に書く）
