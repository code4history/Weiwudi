# m1 基礎固め 台帳

- 計画: `docs/superpowers/plans/2026-11-02-m1-foundation.md`
- 仕様: `docs/superpowers/specs/2026-11-02-new-interface-spec.md`
- サイクル: `weiwudi-vector-cache`（state: `docs/superpowers/state/nayuta-state.json`・里程 `m1`）
- 担当モデルと並行数（人間の指示）: 指示なし
- BASE: `9bb83a3`（vector-cache を切った master）
- 戻し方: 配備なし

## 再開の手順（長期中断からの復帰用）

1. 作業 clone は `~/zcode/weiwudi-work/Weiwudi`。無ければ `https://github.com/code4history/Weiwudi.git` を clone し `vector-cache` へ切り替える。root の `NayutaProducts/Weiwudi` では作業しない
2. `git fetch` し、`origin/master` が進んでいれば `vector-cache` へ取り込むか確かめる
3. **再点検から再開する。** 人間の「再点検へ進む」待ちで止まった。下の「再点検で渡すもの」のとおり、作者でも前回の点検者でもない新しいサブエージェントに任せる
4. 再点検で S が 0 になるまで m1 の実装に入らない。残れば作者が反映し、また新しい担当が点検する
5. 合格後: 下の「点検後に state へ反映すること」を行い、計画の冒頭の環境手順から t1 に入る。人間の判断 2 件が残る

## 事前点検 2026-11-02（第 1 回）

- 点検者: Claude Code（quality-engineer サブエージェント）/ 水準 1 / 対象: 計画と仕様 @ `2a239c8`
- S: 7（反映 7・すべて裁定案を採用）
- O: 17（反映 17・不採用 0）
- 再点検: **未実施**。対象は `947ab56`
- 判定: 不合格（S 7）。再点検の合格が必要

S の一覧（反映先と結果は `947ab56` の差分）:

| ID | 内容 | 根拠 |
|---|---|---|
| S1 | `rm pnpm-workspace.yaml` のとおりだと試験が exit 1、lock の overrides が消える | 実走 |
| S2 | t3 の `quota` 判定が実際の容量超過で働かず、試験だけ通る（`tx.abort` で Event を reject） | 実走（Chromium） |
| S3 | 公開 API を足す t3 に水準 2 のレビューが無い | 軽い道 §4 |
| S4 | Source と Resource が多対多なのに実効方針の合成規則が無い | 読み |
| S5 | §4.5 の `credentials:'omit'` と §4.6 の認証付き要求が矛盾 | 読み |
| S6 | `corsless` が瞬断で永続し解除できない | 読み |
| S7 | 「既存の単体試験はそのまま通す」が不成立 | 実物 |

## 事前点検 2026-11-02（第 2 回・再点検）

- 点検者: Claude Code（quality-engineer サブエージェント・第 1 回とは別）/ 水準 1 / 対象: 計画と仕様 @ `947ab56`
- 前回の S: S1〜S6 は直った。S7 は一部残る（S-A と同じ原因）
- 新しい S: 3（S-A・S-B・S-C。下表）。反映は作者へ依頼済み
- O: 8（作者の判断）
- 判定: 不合格（S 3）。直した版を、新しい担当がこの 3 件に絞って再点検する

| ID | 内容 | 根拠 | 裁定案 |
|---|---|---|---|
| S-A | 組み替えた形の `credentials:'omit'` で「残す」試験 2 件が落ち、同一オリジンの Cookie 付き配信が壊れる | 実走（2 failed） | 組み替えを `credentials:'same-origin'` にし、旧 API とテンプレートは `fetch(url 文字列)` のまま |
| S-B | 4xx に CORS ヘッダを付けないサーバを CORS 非対応と誤判定し、24 時間保存されず範囲取得も止まる | Fetch の仕様と nginx の文書（実走なし） | cors の成功が 1 回でもある Resource では opaque を候補に数えない |
| S-C | Source を外して `credentialParams` の和が縮むと、資格情報がキーに入る | 読み | Entry がある間は縮めない |

## 再点検で渡すもの（第 1 回の後に書いたもの）

- 対象: `947ab56` の仕様と計画。前回の S 7 件が直ったか、直したことで新しい S が出ていないかに絞る（軽い道 §3）
- 特に見る新規の決定: `resource-conflict`、`ResourcePolicy`（仕様 §5.6）、`corsless` の 3 回・24 時間・`corslessUntil`、Cookie だけのサーバを範囲取得の対象外にすること、門番の待ち 3 秒、旧 API の文面の例外 2 件（仕様 §9）、`clean` の `NotFoundError` を `map-not-found` にすること（仕様 §13）
- 環境: 文書とソースを編集しない。使い捨ての実走は clone の外で行う。判定のコマンドに rtk を使わない

## 点検後に state へ反映すること

- 旧 API の載せ替えを m4 から m2 の最後へ前倒しする（仕様 §16）。m2・m4 の `title` を直す
- 合流条件: 移行（仕様 §14.2）が無い状態で master へ入れない

## 人間の判断（未回答。どちらも推奨案で進められる）

1. `mapbox://` を標準で載せるか（推奨: 載せて、README に規約の確認は利用者の責任と書く）
2. 旧 API を非推奨にする時期（推奨: Maplat#254 の完了後のトレイン。それまで 2.0 の予定は立てない）

## 未確認のまま残っていること

- Firefox は未測定。WebKit の結果は Playwright 1.62.1・webkit-2336 のもので、1.64 の 2370 では未測定
- t2・t3 の実装は未走行。m2 以降の実装可能性は読みだけ
- BeatBox 0.1.1 の変換表と Mapbox の利用規約は未確認
- 第 1 回の点検で build の初回に dts が約 9 分かかった。2 回目以降は約 2 秒で、原因は未特定

## 進み具合

Ruling: #35 は閉じる — #59 で `onblocked` と試験が入り完了条件を満たす。人間の許可を得て実施 — 誤りなら Issue を開き直すだけ
Ruling: 第 1 回の点検は水準 1 で実施した — 軽い道 §3 の規定。公開 API の水準 2 は t3 のレビューと m1 の区切りで行う — 誤りなら API の見落としが後ろへずれる
申し送り: 12 月サイクルへ移管を連絡済み。`DEC26-WEIWUDI-AUG-ISSUES` は 12 月側で closed。`DEC26-LARGE-ITEMS-TRIAGE` は他の項目を含むので open のまま
