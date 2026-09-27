# Changelog

このプロジェクトの主な変更を記録します。版数は [Semantic Versioning](https://semver.org/) に従います。

## [1.1.0-rc.1] - 2026-09-28

### Added
- 地図ごとのキャッシュ容量上限 `cacheMaxBytes` を追加（超えた分は最も長く使われていないタイルから削除）

### Changed
- 初回訪問からリロードなしで Service Worker 経由のタイル取得が効くようにした。`registerSW` はページが制御下に入るまで待ち、10000 ms 以内に制御できなければ Error で reject する
- 依存関係を更新
