# m1 基礎固めと新インタフェース仕様 — まとめ（2026-11-03）

## 結果

m1 は完了。3 タスクを vector-cache へ合流した。Issue は vector-cache を master へ合流するときに閉じる。

| タスク | Issue | PR | 合流 |
|---|---|---|---|
| t1 オフライン e2e | #32 | https://github.com/code4history/Weiwudi/pull/67 | 0d34e10 |
| t2 座標・タイル計算を tile_math.ts へ分ける | #34 | https://github.com/code4history/Weiwudi/pull/69 | dec9098 |
| t3 エラーを WeiwudiError で具体化する | #33 | https://github.com/code4history/Weiwudi/pull/71 | efddaa0 |

新インタフェース仕様（docs/superpowers/specs/2026-11-02-new-interface-spec.md）は事前点検の第 6 回で m1 の範囲について合格。

## 区切りのレビュー（軽い道 §6）

- 判定: 合格（必須 0・推奨 4）。HEAD 0472217 で実測した結果は次のとおり。
  - 単体試験 404 passed
  - typecheck・build・eslint は exit 0
  - e2e 18 passed
- Issue の完了条件はすべて満たす。#33 の対応は PR #71 のコメントに書いた。
- タスク間の衝突はない。旧 API の文面は 16 行とも不変。挙動の変化は仕様 §9 で意図した 1 点だけ（保存失敗の文面が `[object Event]` から原因名になる）。

## セキュリティ確認

Critical 0・Major 0。

- semgrep（既定ルール）は 0 件。目視でも確かめた。
- `x-weiwudi-error` は固定の 4 語だけを載せる。上流のタイル URL（トークンを含みうる）は、エラー文面にも detail にも入らない。
- e2e は localhost だけ。固定サーバはパストラバーサルを拒む。
- 依存の追加はない。

## m2 への申し送り

1. e2e の一時ディレクトリ（`weiwudi-e2e-*`）が走行ごとに残る。2026-11-03 の時点で 54 個・95 MB が `$TMPDIR` に残っている（進行役の一括削除は権限で止められたので未処理）。tile-server の終了時に `rmSync` を足し、溜まった分は人間が消す。
2. SW の合成応答はページから見るとクロスオリジンなので、ブラウザによっては `x-weiwudi-error` が CORS のフィルタで隠れうる。`/v2/*` と WebKit・Firefox の確認とあわせて、`access-control-expose-headers` を足すかを決める。
3. `playwright.config.js` の `reuseExistingServer` は、ローカルで 5174 にいる別のプロセスを取り違える（Minor）。
4. tile-server は `[::1]:5174` だけで待ち受けるので、`127.0.0.1` と書かない。
5. 新 API の予約 code 7 件は型にだけある。作るときに文書の「not produced yet」を直す。
6. 事前点検で見送った CORS・resource-conflict・範囲取得の細部（台帳の第 6 回の節）。

## m4 への申し送り

- `latToMercY(90)` は有限の値になる。`bounds` の設計はこれを前提にする。
- master へ合流するときの dist の再生成で、次の 4 点を確かめる。
  - `dist/errors.d.ts` がある
  - `dist/weiwudi.d.ts` に WeiwudiError がある
  - UMD・ES に named export がある
  - `public/weiwudi-sw.js` に `x-weiwudi-error` がある
- 移行（仕様 §14.2）が無いまま master へ入れない。
