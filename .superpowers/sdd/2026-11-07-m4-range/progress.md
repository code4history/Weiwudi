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

## m4-t7 旧 DB からの移行 — 完了（PR #103 → 22be6a9）

- 実装: Claude（Codex・Kimi が 5 時間の枠切れ）。8b46fec・8453e3b、レビューの直し 66d3167。t3 と並行（t3 の前に合流）
- 判定: `node_modules/.bin/vitest run` 37 ファイル・1448 件 passed・`tsc --noEmit` exit 0・`eslint src tests` exit 0（warning 2 件は既存）。CI（Node 22・24、WebKit・Firefox）緑
- 受け入れ条件の grep: `fetch(`（migrate.ts）0・`indexedDB`（legacy.ts）0・migrate.ts の値の import は constants のみ・NUL の文面 3 ファイルで各 1・`settingsCopied`（仕様）0
- 事前点検の反映: M2（forgetLegacyTiles が「忘れた印 → 進行中の migrateStep・pulls を待つ → clearEntries → deleteDatabase」、putEntry の直前にも印を見る）・L2（Resource 無しは batchFailures）・L3（R59 のやり直し）・L4（R60 は文書のみ。fetchAll は読み通しを通さない）
- 既存の試験: legacy-store-repair.test.ts +41/-0・legacy-changes.test.ts +10/-0（追記のみ）
- Rulings（実装担当）
  - R-t7-1: 1 回の契機の 200 件の枠は、読み終えた地図の残りを次の地図へ回す
  - R-t7-2: Resource の有無はバッチの始めに 1 回と saved: false のときに見る。evictScopesFor はバッチごとに 1 回
  - R-t7-3: 旧 DB が 1 つも無ければ kv に書かずメモリだけで完了（既存の legacy-storage-failure の mockImplementationOnce を移行の kvPut が食うため）
  - R-t7-4: migrationDeps は Readonly<MigrateDeps> で凍結（module-state.test の許可の形）
  - R-t7-5: 削除が blocked の DB 名は blockedDeletes に覚え、出し直しと open をしない
  - R-t7-6（レビューで改めた）: putEntry の例外はバッチの失敗。それまで saved の分だけ旧レコードを消し、lastKey は進めず batchFailed
  - R-t7-7: epoch が数でない・キーが z_x_y でない・blob が Blob でないレコードは 1 レコードの失敗。ヘッダ名 __proto__ は落とす
  - R-t7-8: delete は clearEntries を呼ばない（deleteResource が Entry も消す）
  - R-t7-9: やり直し（R59）でも failed の地図は failed のまま。孤児の削除の対象からも外す
  - R-t7-10: kv の状態の読み直しと書き込みは migrationLock で直列。忘れた地図の項目は patchMap が書かない
  - R-t7-11: context.ts の maintenance に settings・settingsDone・migrating・migrationBooted・pulls・forgotten・failedMaps・blockedDeletes・migrationLock（すべて省略可能・createContext は不変）
  - R-t7-12: batchFailed には飛ばしたレコード数を足さない（lastKey を進めないので次のバッチで数え直す）
  - R-t7-13（orchestrator）: batchFailures は連続の 3 回で failed（成功したバッチと mapDone で 0 に戻す）
- レビュー（L1・L2）: Claude（Codex・Kimi が枠切れ）。S 0・M 1・L 2 → 66d3167 で全部直し、直す前の実装で新しい試験 3 件が落ちることを確かめた
  - M1: putEntry の例外を 1 レコードの失敗として飛ばし、読み尽くすと旧 DB ごと消えていた（データの消失）→ R-t7-6 の形に
  - L1: batchFailures が累計だった → R-t7-13
  - L2: done の後に Weiwudi_<id> だけ残ると孤児として移さず消していた → sources に登録済みの地図は pending として移す
  - 未確認（レビュー）: 同じ SW の中で R59 のやり直しとハンドラの copySettings が逆順になる競合。起きても移行が次の SW まで遅れるだけ
- t10 への申し送り: 実ブラウザでの blocked・onversionchange、旧 Blob の arrayBuffer()（WebKit の非永続領域）、数 GB で止まらないこと、SW 更新直後の最初の要求の読み通し。1.1.x の DB を作ってから新 SW を起動する筋書きを推奨
- t11 への申し送り: CHANGELOG に「1.1.x のキャッシュの引き継ぎ（feat）」と「NUL を含む mapID の拒否（§9 の既知の変化。文面は `Error: MapID must not contain a NUL character`）」
