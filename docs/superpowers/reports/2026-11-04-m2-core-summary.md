# m2 URL 直接フックの新コアと旧 IF の上乗せ — まとめ（2026-11-04）

## 結果

m2 は完了。9 タスクと、区切りの直し 2 本を vector-cache へ合流した。Issue は vector-cache を master へ合流するときに閉じる。

| タスク | Issue | PR | 合流 |
|---|---|---|---|
| t1 試験の土台 | — | https://github.com/code4history/Weiwudi/pull/72 | 53d43f3 |
| t2 store.ts | #37 | https://github.com/code4history/Weiwudi/pull/73 | f39a8f2 |
| t3 url_pattern.ts・spec.ts | — | https://github.com/code4history/Weiwudi/pull/74 | 2a642b1 |
| t4 core・plugins・context | #36 | https://github.com/code4history/Weiwudi/pull/75 | 145f8f5 |
| t5 旧 API を新コアへ載せ替える | — | https://github.com/code4history/Weiwudi/pull/76 | 040a9a7 |
| t6 registry.ts（合流と実効方針） | — | https://github.com/code4history/Weiwudi/pull/77 | 868991f |
| t7 照合ルート・門番・上流の取得 | — | https://github.com/code4history/Weiwudi/pull/79 | 63152ca |
| t8 制御（/v2/*）とページ側 API | #36 | https://github.com/code4history/Weiwudi/pull/80 | d4177b3 |
| t9 実 URL の e2e | — | https://github.com/code4history/Weiwudi/pull/81 | 6a60a0e |
| 区切りの前段（e2e の記録を試験ごとに空にする） | — | https://github.com/code4history/Weiwudi/pull/82 | dd7b6e9 |
| 区切りの直し | — | https://github.com/code4history/Weiwudi/pull/83 | 6a768bd |

最終の実測（6a768bd の枝の HEAD で）:
- 単体試験 979 passed
- typecheck・build・eslint は exit 0
- e2e 34 passed（Chromium だけ。WebKit・Firefox は R14 で m2 の範囲外）

## 区切りのレビュー（軽い道 §6）

- 全体（水準 1・新しい Claude）: 第 1 回は不合格（Major 1: `scheme: 'tms'` と `bounds` で範囲の判定が上下逆）。PR #83 で直し、再点検で正しいことを確かめた
  - 計画の「範囲」はすべて揃った。モジュールの継ぎ目（キーの形・方針の合成・資格情報の選び方・照合表の作り直しの契機・旧 API の隔離・退避の範囲）は噛み合っている
  - 二重実装の grep は計画の基準どおり（`indexedDB.open` は store.ts だけ、SW 側の上流の `fetch(` は upstream・legacy・hook だけ）
- 公開 API の差分全体（水準 2・Codex）: 合流可・必須 0。推奨の文書の書き足し（opaque の stale・2xx は 200 OK・未知の warning code）は PR #83 で入れた

## セキュリティ点検

Critical 0・High 0。計画の点検の項目 5 つを満たす（PR #83 の後）。

- 捕捉の範囲: navigate・スクリプトに触らない、旧 API と疑似ホストは照合表に入らない、利用者のルートを奪わない
- 認証付きの要求: 既定で保存しない・hit を飛ばす・匿名の要求とまとめない
- 資格情報: 総当たり（大文字・重複・percent-encode・`#`・ヘッダ・`sk.`）で、公開値・保存値・応答ヘッダに出ない
- `sk.`: クエリ・credentials・パスの区画で拒否する
- `/v2/*`: `ensureV2()` の前と制御下でないときに出ない

点検で見つけて PR #83 で直したもの: 明示の `credentials.query` の名前が資格情報として扱われない（Medium）・合流でテンプレートを正規化し直さない（Low）・パスの `sk.`（Low）。

## 水準 2 の運用の記録

- t4: Codex の第 1 回は合流不可（必須 4）。第 2 回は 3 時間探索して最終報告を書かずに終わったので、新しい Claude で判定した
- t8: 範囲を絞り 30 分で切り上げる指定で、Codex は約 32 分で最終報告（必須 1）。再確認は指定を超えて止まったので、並べて出した Claude の判定で合流した
- 区切り: Codex は約 13 分で最終報告（必須 0）
- 学び: Codex には見る範囲（ファイルと仕様の節）と時間を必ず指定し、同じ確認を Claude にも並べて出す

## m3・m4 への申し送り

state の `carried_from_implementation` に載せた（台帳の m2-t5〜m2-t9 と区切りの節が出どころ）。
