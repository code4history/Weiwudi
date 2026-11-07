# m3 ベクタ資源 — まとめ（2026-11-07）

## 結果

m3 は完了。10 タスクと、区切りの直し 3 本を vector-cache へ合流した。Issue（#38・#39・#40）は vector-cache を master へ合流するときに閉じる。

| タスク | Issue | PR | 合流 |
|---|---|---|---|
| t1 定数と型の土台 | — | https://github.com/code4history/Weiwudi/pull/84 | 511e96d |
| t2 registry（子 Source・合流） | — | https://github.com/code4history/Weiwudi/pull/86 | 3d22f3d |
| t3 資格情報の規則（I1・I2・I9） | — | https://github.com/code4history/Weiwudi/pull/87 | ba82cd2 |
| t4 グリフの結合保存 | #39 | https://github.com/code4history/Weiwudi/pull/88 | 1b6ca2d |
| t5 提供元と mapbox:// | #40 | https://github.com/code4history/Weiwudi/pull/89 | 8227414 |
| t6 スタイル・TileJSON の本体と捕捉 | — | https://github.com/code4history/Weiwudi/pull/90 | ddc563e |
| t7 スタイルの芋づる登録と asset | — | https://github.com/code4history/Weiwudi/pull/91 | 840dc1c |
| t8 資源単位の削除と使用量 | #38 | https://github.com/code4history/Weiwudi/pull/92 | d75853e |
| t9 スタイルの e2e | — | https://github.com/code4history/Weiwudi/pull/93 | f02e101 |
| t10 WebKit を CI で測る | — | https://github.com/code4history/Weiwudi/pull/94 | 180122b |
| 区切りの直し（L1 の Minor） | — | https://github.com/code4history/Weiwudi/pull/95 | cb28c68 |
| 区切りの直し（セキュリティ点検） | — | https://github.com/code4history/Weiwudi/pull/97 | 91bddd9 |
| 区切りの直し（L2 の Major） | — | https://github.com/code4history/Weiwudi/pull/99 | 9b96e29 |

最終の実測（9b96e29）:
- 単体試験 1367 passed・typecheck・eslint 0
- e2e: Chromium 46 passed（CI の Test）・WebKit 29 passed・Firefox 29 passed（CI の e2e-engines。Firefox は必須にしない）

## 区切りのレビュー（軽い道 §6）

- 全体（水準 1・Claude Fable・b270c65..c5712bf を通して）: 合格（Minor 2 → #95 で直した）
- セキュリティ点検（Claude Fable）: 合格（Critical・High 0。Low 3: L2・L3 と Info の I1 は #97 で直した。L1 リダイレクト先のオリジンは m4 へ）
- 公開 API の差分（水準 2・Codex gpt-6-astra）: 第 1 回は合流不可（Major 3・すべて再現済み）
  - 子の URL の資格情報が親の値に置き換わる → #99 で直した（本体から除くのは登録した資格情報と同じ値の項目だけ）
  - 子にできない glyphs・sprite が warnings なしで消える → #99 で直した
  - m2 で保存した Mapbox の https の登録の再登録が resource-conflict → 直さない（m2 の保存は未公開）
- 二重実装の grep（計画の 2 つ・m2 の 2 つ）: すべて 0 件

## WebKit で見つかった不具合

WebKit の非永続の保存領域（Playwright の WebKit・Safari のプライベートブラウズ）は IndexedDB に Blob を put できない。診断の試験で確定し、store.ts の本体を ArrayBuffer＋type に替えた（t10）。Codex の水準 2 が、この直しの順の崩れと、旧 API の fetchAll が古い形を取り直さない件を再現して見つけた。

## 水準 2 と委任の運用の記録

- Codex の水準 2 は、Claude の水準 1 が見落とした再現できる不具合を t10 で 2 件・区切りで 3 件見つけた
- Codex の job は cwd を ~/zcode/weiwudi-work にして起動する（NayutaProducts のままだと worktree に書けない）。並行は 2 まで
- 委任の順は Codex → Kimi → Claude（人間の指示）。この区切りでは Codex・Kimi の両方が枠切れになり、最後は Claude で仕上げた
- Kimi（dsh）は worktree では commit できない（sandbox の書き込み域は --cwd の repo toplevel）。commit は進行役が行う

## m4 への申し送り

state の `carried_from_implementation` と、m4 の計画（PR #98）の申し送りの表に載せた。m3 の区切りで足したもの:
- セキュリティ点検 L1: 「同じオリジン」の判定は登録 URL で行い、リダイレクト先の URL を見ない（Response.url で確かめる）
- hasEntries は旧 API の fetchAll で保存済みのタイルごとに本体を 1 回読む。m4-t7 の移行の後はメタだけの判定に戻してよい
- 推奨: docs/api/sw.md の applyCredentials の説明の整理・credentialParams の既定値の列挙
