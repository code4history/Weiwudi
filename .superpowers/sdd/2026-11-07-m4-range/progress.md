# m4 範囲取得と解放・保持期間・移行・#41・master への合流 — 台帳

- 計画: docs/superpowers/plans/2026-11-07-m4-range-release-migration.md（PR #98 で合流）
- 起点: vector-cache の f6189a0（m3 の完了）
- 事前点検: 第 1 回（Claude）直してから（S 4・M 15・L 18）→ cceee2c で反映。第 2 回（Claude・反映の範囲に絞る）直してから（S 1・M 5・L 5）→ b5ff39b で反映。m2 と同じ運用で合格とし、第 3 回は置かない
  - 第 1 回・第 2 回とも、Codex と Kimi が枠切れだったので Claude で行った（委任の順は Codex → Kimi → Claude）
- 委任の運用: Codex（cwd は ~/zcode/weiwudi-work・gpt-6-astra）→ Kimi（dsh・kimi-coding/k3・effort high。worktree では commit できない）→ Claude。並行は 2 まで
- 共通の規則: 判定のコマンドに rtk を使わない・手元で playwright install をしない・e2e は build の後・--ignore-workspace を付けない

## m4-t1 保存の土台の直し — 完了（PR #100 → 36fe34b）

- 実装: Claude（Codex・Kimi が枠切れ）。6fb6062・38b9982。レビュー（L1）: Codex（gpt-6-astra）。S 0・M 0・L 2（どちらも試験の縛り不足）→ 7cb1cdf で直し、直しを壊すと落ちることを確かめた
- Codex は旧 getAll 実装との突き合わせを別に 500 回行い、退避の集合と集計が一致。ただし fake-indexeddb 上で、実ブラウザでの tx の寿命は未検証（e2e で見る）
- 判定: test:unit 1396・typecheck・build・e2e（Chromium 46）・eslint 0 errors・check-dts すべて exit 0。CI（Node 22・24、WebKit・Firefox）緑
- Rulings
  - R-t1-1: I1 の直しで逆の結果になる既存の試験 2 件（core.test.ts:666・legacy-changes.test.ts:265）を「200・storage・上流 1 回」に書き換えた。計画の「core.test は削除 0」に反するが、直しの意図そのもの。計画の書き換え先 legacy-storage-failure.test.ts には該当行が無かった
  - R-t1-3: 退避の見積もりで old を引くのは old の Resource が要素の resourceIds にあるときだけ（参照の実装と同じ集合を消すため）
  - R-t1-4: L3 の予算は要素の maxBytes の最小値。落とす順は fetchedAt 昇順・同値は本体の中の順
  - R-t1-5: setPinned の戻り値は実際に変えた数
  - R-t1-6: pruneGlyphParts は部分の索引の無いもの・古い形の本体・本体を超える部分を持つものを触らず 0
  - R-t1-7: listUnpinnedBefore の next は limit 件読めたときだけ [fetchedAt, key]。続きは continuePrimaryKey（位置が同じなら continue）
  - R-t1-8: 差分 0 の Resource も put（put の回数を数える既存の試験を変えない）
- 申し送り
  - t3: RegionRecord は {id, sourceId, status} だけ。項目は t3 で足す。ServeResourceOptions.pin は t3 で足す（ServeInput.pin は core にある）
  - t6: 全体上限は commitEntry の要素のループで。evictByCursor は IX_LRU 決め打ちなので索引と範囲を引数に
  - t7: DROPPED_HEADERS・OWN_PREFIX は constants.ts から import
