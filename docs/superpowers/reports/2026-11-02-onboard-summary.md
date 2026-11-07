# weiwudi-vector-cache オンボーディング要約（2026-11-02）

## 人間の決定

- 月次トレインから切り離し、完成次第 master へ合流する独立開発とする
- 起点タイプ: project ／ レーン: 軽い道 ／ ブランチ: 長期ブランチ `vector-cache`（master から切る）
- 公開は master への合流後の次の月次トレイン

## 出発点の実測（2026-11-02）

- 公開版は 1.1.1。`src/` は `weiwudi.ts`・`weiwudi_gw.ts`・`weiwudi_gw_logic.ts`（769 行）・`weiwudi_sw.ts` の 4 ファイル。ラスタ（`xyz`・`wmts`）のみで、`https://weiwudi.example.com/` への疑似 URL を経由する
- 利用側: MaplatCore・Maplat（`^1.1.0`）、MaplatCorePro（`1.0.0` 固定）
- 試験: `tests/unit/`（vitest）と `tests/e2e/`（Playwright）

## 試作ブランチ `origin/v1_dev`

- 2025-07〜2026-01 の試作。`src/cache-v1/`（約 1,730 行）・`tests/cache-v1/`・`SPEC_DISCUSSION.md`（838 行）がある
- 分岐点は `45cf8a3`（0.x の時代）で、現行 master とは TypeScript 化・Vite 移行・1.x の機能追加のすべてが食い違う ∴ **merge はできない。設計の資料として読み、移植は個別に判断する**
- 主な内容: URL を資源の識別子にする「キャッシュ仕様 v1」、`register()`、プラグインの差し込み口、LRU とクオータ、`mapbox://` 展開、フォントの結合保存、v0→v1 の自動移行
- 既知の問題（コミットメッセージより）: `migration.test.ts` のタイムアウト、`fetchAll` の範囲指定が未完成
- `SPEC_DISCUSSION.md` の「後方互換は不要」は 1.x の公開前の判断である。**現在は 1.1.1 が公開済みで、利用者がいる**。release-policy §5.3 と「新旧の実装を二重にしない」方針に照らして m1 で決め直す

## Issue の仕分け

| Issue | 扱い | 里程 |
|---|---|---|
| #42 新インタフェース | 取り込み。仕様は m1、実装は m2〜m4 | m1〜m4 |
| #34 座標・タイル計算の分離 | 取り込み | m1 |
| #33 エラーの具体化 | 取り込み | m1 |
| #32 オフライン試験 | 取り込み | m1 |
| #37 メタデータ型 | 取り込み | m2 |
| #36 差し込み口 | 取り込み（容量側は #29 で済み。残りは差し込み口） | m2 |
| #39 分割要求の結合保存 | 取り込み | m3 |
| #40 提供元固有の URL | 取り込み | m3 |
| #38 資源単位の削除と集計 | 取り込み | m3 |
| #41 開発用ページ | 取り込み | m4 |
| #35 IndexedDB の堅牢性 | 閉じる（#59 で `onblocked` と試験が入り、完了条件を満たす） | — |

対象外: Maplat#254 のベクタ対応は、Weiwudi の公開後に利用側で行う。

## 他サイクルとの関係

- 11 月・12 月サイクルの `scope_declaration` は `Weiwudi/**` を含むが、12 月の Weiwudi の PR（#57〜#61）は master へ合流済みで、作業はブランチが分かれる
- 12 月サイクルの backlog のうち `DEC26-WEIWUDI-AUG-ISSUES` と `DEC26-LARGE-ITEMS-TRIAGE` の #42 分は、本サイクルで受ける
- 先に確かめる項目として backlog に残る「ベクタタイルのオフライン需要」は、人間が本サイクルの開始を決めたことで着手の条件ではなくなった。どの利用経路を第一の対象にするかは m1 の仕様で定める
