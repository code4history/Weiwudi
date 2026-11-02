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
3. 事前点検は第 6 回で m1 の範囲について合格した。「点検後に state へ反映すること」も反映済み。**計画の冒頭の環境手順から t1 に入る**
4. 点検→反映→再点検・レビューは機械の判定で回す（人間に聞かない。2026-11-02 人間の指摘）
5. 人間の判断 2 件が残る（推奨案で進めてよい）

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

第 2 回の反映: `b4d3ce9`（S 3 件はすべて裁定案・O 8 件すべて採用）。S-A は `credentials:'same-origin'`、S-B は `Resource.corsOk` の新設、S-C は Entry がある間 `credentialParams` を縮めない。次は第 3 回の再点検（新しい担当・S-A／S-B／S-C と反映で生じた新規に絞る。単体試験 :228・:239 の差分なしを実走で確かめる）。人間の指示で、反映の完了時点で停止中。

## 事前点検 2026-11-02（第 3 回・再点検）

- 点検者: Claude Code（quality-engineer サブエージェント・第 1・2 回とは別）/ 水準 1 / 対象: 計画と仕様 @ `b4d3ce9`
- 前回の S: S-A・S-B・S-C はすべて直った（S-A は単体 68 件の実走と Chromium の Cookie の実測で確認）
- 新しい S: 2（どちらも b4d3ce9 の文言から出たもの。文言の修正で済む）
- O: 9（作者の判断。点検者の報告の O-1〜O-9）
- 判定: 不合格（S 2）
- 反映: `fbffd87`（S 2 件は裁定案どおり。O 9 件すべて採用。O-9 は README の制約ではなく「元の要求で 1 回取り直し、opaque を渡して保存しない」）。次は第 4 回の再点検（新しい担当・S-D／S-E と反映で生じた新規に絞る）

| ID | 内容 | 根拠 | 裁定案 |
|---|---|---|---|
| S-D | 範囲取得の止め方「cors の成功が 1 件も無いうちに」が実行ごとと読め、再実行（＝再開）が毎回同じ所で止まる | §7.2 の再開の仕組みとの突き合わせ | 条件を Resource の状態（`count === 0` かつ `corsOk` 無し）に揃えて明記。`corsOk` は CORS を通った応答の印（状態は問わない）と定義。401・403 は `count === 0` |
| S-E | cors の成功がある Resource で上流が失敗すると opaque を渡すとあり、§6 の 4（Entry があれば古い本体）と食い違う | nginx の 502・504 に CORS ヘッダが付かない既定 | `upstream` として §6 に従う（Entry があれば古い本体、無ければ opaque） |

O の要旨: O-1 旧 API は `fetch(url)` の 1 引数でなければ :228・:239 が落ちる（`fetch(url, undefined)` でも落ちると実走）／O-2 cors の成功で `corslessUntil` を消す／O-3 `source.update()` で `corsOk` も消す／O-4 「旧 DB から移した Entry を除いて」は起きないので削る／O-5 自分の `update()` で `credentialParams` が広がる場合も `resource-conflict`／O-6 §5.5 の 4 を「既存 Resource の方針で扱われる」と事実に合わせる／O-7 旧 API でも 200 の `text/html` を保存しなくなることを例外として書く／O-8 計画 :304 を仕様 §9 の言い方に揃える／O-9 同じサイトの別オリジンで 401 に CORS ヘッダを付ける Cookie 認証のサーバは、捕捉で壊れる（`no-cors` の 401・403 も元の要求で取り直すか README の制約へ）

未確認: WebKit（webkit-2370 未導入。共有キャッシュを消すおそれがあり install せず）・Firefox・nginx と S3 の実物の応答。

## 事前点検 2026-11-02（第 4 回・再点検）

- 点検者: Claude Code（quality-engineer サブエージェント・第 1〜3 回とは別）/ 水準 1 / 対象: 計画と仕様 @ `4795383`（反映 `fbffd87`）
- 前回の S: S-D・S-E は直った
- 新しい S: 2（S-F は O-9 の追記から、S-G は O-6 の書き直しで表に出た食い違い）
- O: 6（O-a〜O-f。作者の判断）
- 判定: 不合格（S 2）
- 反映: `db65a5f`（S 2 件は裁定どおり。S-G は `rangeOnlySourceIds` を新設。O 6 件すべて採用。O-d は「opaque が 3 回続いたら範囲内の無作為 5 枚を cors で確かめる」）。次は第 5 回の再点検

| ID | 内容 | 根拠 | 裁定 |
|---|---|---|---|
| S-F | `no-cors` の 401・403 を取り直す追記（:166）に Entry があるときの扱いが無く、§6 の 4 より先に当てるとトークン失効でキャッシュがあるのに壊れた画像が出る | 読み | :166 に「Entry があれば §6 の 4 とし取り直さない。無いときだけ取り直す。取り直しが `TypeError` なら 1 の 401・403 をそのまま返す」 |
| S-G | `resource-conflict` の下位資源が既存 Resource の `extents` で扱われ、新しいスタイルの範囲が透明になり §5.6 :312・:329 と矛盾 | 読み | 進行役の決定: 第 1 案。拒否するときも範囲（`TileExtent`）は既存 Resource に足す（キーを変えないので拒否の理由に当たらない）。`scheme` の違いで拒否するときは、その Source の分を範囲の制限なしにする |

O の要旨: O-a「数」を `corslessStreak` 等と命名し置き場所を書く／O-b §5.2 の `corsOk` の型コメントを新定義に揃える／O-c `count > 0` で CORS をやめたサーバは `update()` では戻らず `clean()` が要ると書く／O-d 登録直後の範囲取得が海の 404 で止まる件の対策／O-e opaque には `x-weiwudi-status` が付かないと §6 の注記に書く／O-f 自分の `update()` が `resource-conflict` のときの結果を書く

Ruling: S-G は第 1 案（範囲だけは合流する）— §5.6 が掲げる「片方が透明画像にならない」を守れるのはこちらだけで、範囲はキーに入らない — 誤りなら範囲外が透明になり、§5.5 の 4 に制約として書き直す

## 事前点検 2026-11-02（第 5 回・再点検）

- 点検者: Claude Code（quality-engineer サブエージェント・第 1〜4 回とは別）/ 水準 1 / 対象: 仕様 @ `4afece2`（反映 `db65a5f`）
- 前回の S: S-F・S-G は直った
- 新しい S: 1（S-H。db65a5f の §5.6 :330 の一般則から）
- O: 7（O-g〜O-m。作者の判断）
- 判定: 不合格（S 1）
- 反映: `c6ff4a7`（S-H は第 1 案。`resource-conflict` を投げるのは自分の `update()` だけ。O 7 件すべて採用。O-j は y を反転して既存の `scheme` に読み替える。O-k は `jobOpaqueStreak` を新設。確認事項: range-only の Resource は範囲取得の対象・`rangeOnly: true` で一覧に含める・`clean()` で Entry を消さない）。次は第 6 回（S-H の反映箇所に絞る）

| ID | 内容 | 根拠 | 裁定 |
|---|---|---|---|
| S-H | 「拒否しても範囲だけは足す」が最上位の `kind: 'tile'`・`'asset'` の `register()` にも及ぶのに、拒否時に失敗か成功かが無い。reject にすると `rangeOnlySourceIds` に存在しない Source が残り外せない（`scheme` 違いなら制限なしが永久に残る） | 読み | 進行役の決定: 第 1 案。最上位もスタイルと同じく登録は成功して Source を保存し、その資源は範囲だけ足して `warnings` に書く。`remove()` で外せる |

Ruling: S-H は第 1 案 — S-G の裁定（片方が透明画像にならない）と揃い、Source が残るので外せる — 誤りなら `register()` が成功扱いになる分、利用者が衝突に気づきにくい（`warnings` で補う）
Ruling: 第 6 回の再点検は S-H の反映箇所だけに絞り、S 0 なら m1 の事前点検は合格とする。CORS・`resource-conflict`・範囲取得（§4.5〜§5.6・§7.2）の残る細部は m2 の事前点検で改めて見る — 5 回とも新しい S はこの領域の直した文言から出ており、m1（座標計算・エラー・オフライン試験）はこの領域を実装しない — 誤りなら m2 の点検で同じ領域の S がまとめて出る（m2 の実装前なので手戻りは文書だけ）

## 事前点検 2026-11-02（第 6 回・S-H に絞った再点検）

- 点検者: Claude Code（quality-engineer サブエージェント・第 1〜5 回とは別）/ 水準 1 / 対象: 仕様 @ `2400554`（反映 `c6ff4a7`）
- 前回の S: S-H は直った（成功して保存・範囲だけ足して warnings・`resource-conflict` は自分の `update()` だけ・`remove()` で multiEntry 索引から外れる）
- 新しい S: 1（S-I: 同じ id の再登録で衝突したとき :326 と :330 のどちらに当たるか未定）。裁定案どおり作者へ反映を依頼（「既存の id への `register()` は自分の `update()` の規則に従い、例外にせず warnings に書く」）
- O: 7（O-1 の崩れた文は今回直す。O-2〜O-7 は m2 の事前点検へ送る）
- 反映: `eb1adf3`（S-I は §5.6 :332 を新設・:334 で範囲だけ足す規則を限定。O-1 の理由文を :334 の末尾へ戻した）
- 判定: **m1 の範囲について合格**

Ruling: S-I は反映したうえで m1 の事前点検を合格とし、確かめ直しは m2 の事前点検で行う — S-I は `register()` の衝突規則で m2 の実装対象であり、m1（座標計算・エラー・オフライン試験）の実装に影響しない。第 5 回の Ruling どおり — 誤りなら m2 の点検で S-I の反映に S が出る（m2 の実装前なので手戻りは文書だけ）

m2 の事前点検へ送るもの: 第 6 回の O-2〜O-7（`remove()` が共有・範囲だけの Resource の Entry を消さない明記／持ち主の Source の削除で range-only の region が実体なしで残る／asset の衝突で範囲が制限なしになる／warnings の書式とクエリの扱い（:525）／§12 の `update()` の注記／スタイルの `update()` で新しく現れた下位資源の衝突）と S-I の反映の確かめ。CORS・範囲取得（§4.5〜§5.6・§7.2）は 6 回とも直した文言から新しい S が出た領域なので、m2 では差分ではなく領域全体を一度通して点検する

state へ反映済み（第 6 回の後）: 旧 IF の上乗せを m2 へ前倒し（m2・m4 の title）、`branch_policy.merge_condition`（移行が無い状態で master へ入れない）、m2 の `carried_from_precheck`

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
