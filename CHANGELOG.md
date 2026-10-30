# Changelog

このプロジェクトの主な変更を記録します。版数は [Semantic Versioning](https://semver.org/) に従います。

## [Unreleased]

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
