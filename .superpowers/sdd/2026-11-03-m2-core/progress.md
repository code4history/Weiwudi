# m2 新コア 台帳

- 計画: `docs/superpowers/plans/2026-11-03-m2-core.md`
- 仕様: `docs/superpowers/specs/2026-11-02-new-interface-spec.md`
- サイクル: `weiwudi-vector-cache`（state: `docs/superpowers/state/nayuta-state.json`・里程 `m2`）
- 担当モデルと並行数（人間の指示）: 指示なし
- BASE: `3ee1e72`（m1 完了時の vector-cache）
- 戻し方: 配備なし

## 再開の手順（長期中断からの復帰用）

1. 作業 clone は `~/zcode/weiwudi-work/Weiwudi`（m1 の台帳の手順 1・2 と同じ）
2. 計画は `887caee` で作った。事前点検の合格まで実装に入らない
3. 点検→反映→再点検・レビューは機械の判定で回す（人間に聞かない）

## 計画づくり 2026-11-03

- 設計担当: Claude（m1 の仕様と計画を書いた担当）/ commit `887caee`
- 仕様の §3・§5.3・§7.1・§16 を計画に合わせて直した（同じ commit）
- Ruling R1〜R15 は計画の中にある
- 人間の判断は増えていない（mapbox:// の標準搭載と旧 API の非推奨の時期は推奨案で進める）

## 事前点検 2026-11-03（第 1 回）

- 点検者: 新しい担当 / 水準 1 ＋ 水準 2（t4・t8 が公開 API） / 対象: 計画と仕様 @ `887caee`
- 範囲: 計画の全体に加え、仕様 §4.5〜§5.6 と §7.2 を差分ではなく通して見る（m1 からの持ち越し）
