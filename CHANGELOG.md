# Changelog

このプロジェクトの主な変更を記録します。版数は [Semantic Versioning](https://semver.org/) に従います。

## [Unreleased]

### Added
- 実 URL を捕捉する Source API（`Weiwudi.register`・`sources`・`source`、Source の `update`・`stats`・`clean`・`remove`）を追加。ラスタ・ベクタ・スタイル・単体ファイルを登録できる
- スタイルが参照する TileJSON・タイル・グリフ・スプライト・GeoJSON・画像の登録と、fontstack ごとのグリフの結合保存を追加
- 範囲の見積もり・取得・固定・再開と進捗イベント（`estimate`・`fetchRange`・`regions`・`cancel`）、解放（`releaseRange`）と範囲つき `clean` を追加
- キャッシュの保持期間 `cacheRetention` と、固定した Entry を保護する期限切れの掃除を追加
- 全 Source を合わせたキャッシュ容量上限 `Weiwudi.setLimits({ maxBytes })` を追加
- 資源単位の削除 `removeResource` と、全体・提供元別の使用量 `Weiwudi.usage()` を追加
- Service Worker の差し込み口 `addPlugin` と提供元の追加 `addProvider`、標準の `mapbox://` URL 解決を追加
- 資格情報の分離保存と送信先の制限、未宣言の資格情報らしいクエリを知らせる `credential-undeclared` warning を追加
- 新 API の `WeiwudiError` と、旧 API の文字列エラーを分類する `WeiwudiError.from`、応答の `x-weiwudi-error` ヘッダを追加
- 1.1.x の既存タイルキャッシュを段階的に新 DB へ引き継ぐ移行を追加。移行中も旧 API のタイルはオフラインで読み出せる
- 上流へ送る User-Agent に `Weiwudi/<版>` を足す。`registerSW` の `userAgent`（または SW 側の `setUserAgent`）で利用者の名前も足せる。Service Worker と同じオリジンの上流にだけ付ける（Chromium 系は捨てる）

### Changed
- IndexedDB の失敗は `Error: [object Event]` ではなく `tx.error`・`req.error` に基づく文字列を返す
- 未登録の地図の `clean` は `Error: NotFoundError: …` ではなく `Error: MapID "x" not found` を返す
- 旧 API も 200 OK の `text/html` 応答を上流の失敗として扱い、保存せず、既存キャッシュか失敗の合成応答を返す
- 保存する応答から `content-encoding`・`content-length`・`transfer-encoding`・`set-cookie` を除き、キャッシュからも返さない
- 合成応答に `x-weiwudi-status` と `access-control-expose-headers` を付ける
- 上流の HTTP 失敗でキャッシュが無いときの合成応答からも `content-encoding`・`content-length`・`transfer-encoding`・`set-cookie` を除く
- NUL 文字（`\0`）を含む `mapID` の `add` を `Error: MapID must not contain a NUL character` で拒否する
- `blocked` のエラー文面の DB 名は `WeiwudiStore` になる。旧 DB の削除が `blocked` でも `delete` は成功し、旧 DB の削除を次の起動へ回す
- `fetchAll` の `proceed`・`finish` の `error`・`errors` は、そのジョブの要求の失敗だけを数える
- `Range` ヘッダつきの `/api/cache` は保存も範囲外の判定もせず上流へ素通しし、206 をそのまま返す。ネットワーク失敗は 404 と `x-weiwudi-status: offline-miss`・`x-weiwudi-error: network`・`access-control-expose-headers` で返す
- 保存前の容量判定の読み出しに失敗しても、取得済みのタイルを `x-weiwudi-error: storage` で配信し、保存せず、上流への要求を繰り返さない
- ブラウザの容量超過では固定以外の保存量の 10% を全体 LRU で退避して 1 回再試行する。退避に失敗したときや再試行も容量超過なら `x-weiwudi-error: quota`、再試行の他の保存エラーは `storage` を返す
- 移行中の旧 API の `fetchAll`・`stats` は新 DB だけを見る（未移行の旧 DB のタイルは数えず、オンラインなら取り直し、`percent` は一時的に低くなる）。旧版へ戻すとキャッシュは取り直しになる

## [1.1.1] - 2026-11-02

1.1.1-rc.1 と同じ内容の正式版です（版番号のみ変更）。変更点は 1.1.1-rc.1 までの各項を参照してください。

## [1.1.1-rc.1] - 2026-10-26

### Fixed
- Service Worker が `weiwudi.example.com` で始まる別のホスト（`weiwudi.example.com.evil.test` など）への要求も捕捉していたのを直した。ホスト名の境界まで一致したときだけ捕捉する
- xyz の地図を `cacheMaxBytes` に無効な値（負数・小数・数字以外）を付けて登録すると、エラーにならず保存され、タイルを取るたびにキャッシュが消える（または無効になる）不具合を修正（#44）。無効な値では登録がエラーになる（wmts と同じ）。既に登録した地図は、有効な値で登録し直すと直る
- 地図を登録する前に `stats`・`cache`・`delete`・`fetchAll` を呼ぶと、以後の `add`・`info` もすべて `NotFoundError` で失敗する不具合を修正（#47）。これらの API は `MapID not found` または `Deleted` を返すようになる。既に壊れた状態の DB は開いたときに自動で直す。別の接続が閉じずに残っているときは止まらず Error を返し、その接続が閉じると直る
- デモページの leaflet に `integrity` を付け、デモの Service Worker が読む workbox を CDN ではなくデモと一緒に配るようにした

## [1.1.0] - 2026-10-05

1.1.0-rc.1 と同じ内容の正式版です（版番号のみ変更）。変更点は 1.1.0-rc.1 までの各項を参照してください。

## [1.1.0-rc.1] - 2026-09-28

### Added
- 地図ごとのキャッシュ容量上限 `cacheMaxBytes` を追加（超えた分は最も長く使われていないタイルから削除）

### Changed
- 初回訪問からリロードなしで Service Worker 経由のタイル取得が効くようにした。`registerSW` はページが制御下に入るまで待ち、10000 ms 以内に制御できなければ Error で reject する
- 依存関係を更新
