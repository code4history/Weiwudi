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

## m4-t2 保持期間の掃除と保守の契機 — 完了（PR #101 → 576ab0c）

- 実装: Codex が commit 2e94dac（wip。枠切れで中断）まで、Kimi（dsh）が残りの照合と確認。計画の全項目は wip で済んでおり、コードの追加は無し
- 判定: `node_modules/.bin/vitest run --configLoader runner` で 36 ファイル・1416 件 passed（exit 0。sandbox が symlink 先の node_modules/.vite-temp への設定バンドルの書き込みを拒否するため runner loader を付けた。試験の内容は同一）・`node_modules/.bin/tsc --noEmit` exit 0・`node_modules/.bin/eslint src tests` exit 0（warning 2 件は t2 以前からの既存）
- 受け入れ条件: legacy-routes.test.ts は +37/-0（追記のみ）・legacy-changes.test.ts は `git diff --quiet 36fe34b..HEAD` で無変更・`grep -c "addEventListener('fetch'" src/*.ts` すべて 0・`grep -c 'ctx.maintain'` は hook 2・legacy 1・control 1・文書の 4 grep はすべて 1（実装担当は計画どおりの語を使ったので語の記録は不要）
- 台帳に書く確認（計画 333 行）: legacy-transcript.test.ts は `waitUntilCalls` を 0 か所しか数えず、`:159` の `requestFromClient` は fetchAll 以外の API でも保守の契機を起こすが結果は変わらない（1416 件の通過で確認）
- Rulings（実装担当）:
- t7 への申し送り: `ctx.maintenance.migrated` は予約済み。`runMaintenance`（weiwudi_gw_logic.ts）の `if (!state.swept) await sweepOnce(ctx)` の並びに `migrateStep(ctx, migrationDeps)` を足す。t7 が使う `maintenance.settings`・`pulls`・`forgotten` は context.ts に t7 で足す。t2 の `maintenance.running` は保守全体の共有 Promise なので、migrateStep もこの中で 1 本にまとまる
- レビュー（L1）: Kimi（k3・別セッション・読み取り専用）。S 0・M 0・L 4。CI（Node 22・24、WebKit・Firefox）緑
  - L4（文書の「per request」は 1 回の掃除あたり）→ c080dc9 で直した
  - L1（legacy の store を使わない API 名でも保守が起きる）: 計画の規定（ping と fetchAll を除く）どおり。実害は起動後の掃除が早まるだけ → 直さない（R-t2-4）
  - L2（getImage が契機になること・門番の未照合で契機にならないこと・走査中の deleteResource の試験が無い）・L3（ハーネスに ctx.maintain を止める口）: 実装は正しく予防的な指摘 → 直さない。t10 の e2e か、試験が壊れたときに足す
