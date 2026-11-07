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

## m4-t3 範囲取得の土台とタイルの fetchRange — 完了（PR #102 → 5c73c63）

- 実装: Claude（Codex・Kimi が 5 時間の枠切れ。Kimi の中継は 429 で何も書かずに停止）。2a5e584・ac2c419、レビューの直し b3ae98d（t7 の合流後に載せ直し、923f7d4）
- 判定: `node_modules/.bin/vitest run` 38 ファイル・1516 件 passed（t7 の合流後）・`tsc --noEmit` exit 0・`eslint src tests` exit 0（warning 2 件は既存）・build（lib・sw-es・sw-umd）と check-dts 2 本・`tsc -p tests/dts/tsconfig.json` exit 0。CI（Node 22・24、WebKit・Firefox）緑
- 受け入れ条件の grep: `fetchRange(`（dist/weiwudi.d.ts）1・`fetch(`・`tileKeySuffix`（range.ts）0・`credentialsFor(`（hook.ts）0・`fetchRange`（docs/api 英日・README 英日）11・11・2・2・skip/only/todo 0・package.json と lock 無変更
- 事前点検の反映: M3（job/resume の作り直しは直列の中・各バッチの前に Source と region の有無を見る）・M4（ページ側の cancel() は canceled か終わりのイベントを受けてから解決。30 秒で regions() に落ちる）
- 計画の対象ファイルの外: src/store.ts の RegionRecord を RegionInfo + normalized + options に広げた（再開に要る）。既存の試験 4 本は import の行の書き換え以外は追記のみ
- Rulings（実装担当）
  - R-t3-1: スタイルの fetchRange は子のタイルの資源だけを取る。スタイル・TileJSON・スプライト・グリフは t4
  - R-t3-2: スタイルの 'all' は子の tile の範囲の和（最大の maxZoom に揃えて子の box を拡大）。box の無い子が 1 つでもあれば cannot-fetch-all
  - R-t3-3: 検査済みの指定（options）を region に保存し、job/resume は同じ指定で作り直す。RegionInfo には出さない
  - R-t3-4: 範囲なしの clean() は t3 で Source の region を消す。固定の解放は t5 の releaseAllOf
  - R-t3-5: probeNoCors は { mode: 'no-cors', credentials: 'omit' }。資格情報も Cookie も送らない
  - R-t3-6: ミラーは持ち主の Source（スタイルは子）が登録したテンプレートから選ぶ。該当が無ければ Resource の全テンプレート
  - R-t3-7: network の失敗は実績があっても毎回 no-cors で確かめる。opaque なら upstream に数え、連続数は実績が無いときだけ足す（仕様 §4.5-3。計画本文の「実績が無ければ」より広い。レビュー L4 で確定）
  - R-t3-8: 確かめの 5 枚は重ならないように選ぶ。取れた 200 はその場で固定の対象に入れ、列挙で失敗と数えたタイルならその場で成功に数え直す（レビュー L2）
  - R-t3-9: ジョブが opaque で止めるときは ctx.notify だけで、corslessUntil は書かない
  - R-t3-10: 固定分の上限（R55）は pin: true のときだけ見る
  - R-t3-11: gone（ページが閉じた）のときは終わりのイベントを送らない（旧 fetchAll と同じ）。region は partial
  - R-t3-12: cancel の応答は { regionId: string | null }
  - R-t3-13: 範囲取得の固定はバッチの後の setPinned 1 本で、region が有るときだけ。ServeInput.pin の近道は使わず ServeResourceOptions.pin は外した（レビュー M2）。確かめが stop を投げてもそのバッチの取れた分は固定する（レビュー L1）
  - R-t3-14: ページ側は終わりのメッセージを使っても消さない。release() と上限 64 件（古いものから）で捨てる（レビュー M1・L5）
- レビュー（L1・L2）: Claude（Codex・Kimi が枠切れ）。S 0・M 3・L 5 → b3ae98d で M1・M2・L1・L2・L5 を直し、新しい試験が直す前の実装で落ちることを確かめた（L1 は M2 を入れたまま finally を外して確認）
  - M1: canceled が cancel の POST の応答より先に届くと cancel() が 30 秒止まる → R-t3-14
  - M2: ジョブ中の clean() で、どの region にも属さない固定が残る → R-t3-13
  - M3: R-t3-7〜12 の記録が無い → 本節に記録
  - L3: 「cancel() の後の clean() が通る」試験は、t3 の clean() が ctx.job を見ないので何も確かめていない → t5 で fetch-busy を入れるときに効くことを確かめる
  - L4: R-t3-7 で確定、直さない
  - 未確認（レビュー）: POST の応答と postMessage の順が実ブラウザで入れ替わるか。stop の message に URL が混ざる経路が無いか（全部は追っていない）
- t4 への申し送り
  - range.ts の planOf は asset 以外では tile の Resource だけを残す（resources.filter(type === 'tile')）。ここに非タイルの単位を足す
  - 単位は { resource, tile? }。processedTiles と percent はタイルだけで数える。fetchUnit は credentialSourceId を渡し済み
  - normalizeFetchOptions の glyphRanges・fonts は検査して region の options に保存済み（未使用）
  - 固定は onBatch の pinKeys() だけで付ける。グリフの flush の後の setPinned も region の有無を見てから
  - 失敗の数え直し（fail(kind, key) と failed の Map）は t4 の単位でも使える
- t5 への申し送り
  - control.clean は「region を消す → clearEntries」。region を消す行を releaseAllOf に置き換え、ジョブ中の fetch-busy（R48）を足す。あわせてレビュー L3 の試験が効くことを確かめる
  - 解放の列挙は enumerate と countRange を使える。resourcesOf は extents を持ち主の分に絞った写しを返す
  - 子を親に読み替える処理は createNotifier にある（parentId）

## m4-t4 スタイルの範囲取得 — 完了（PR #104 → 135b448）

- 実装: Claude（Codex・Kimi が 5 時間の枠切れ）。1a96cd6、レビューの直し fab7181
- 判定: `node_modules/.bin/vitest run` 40 ファイル・1535 件 passed・`tsc --noEmit` exit 0・`eslint src tests` exit 0（warning 2 件は既存）。CI（Node 22・24、WebKit・Firefox）緑
- 受け入れ条件の grep: `text-font` は style_body.ts 4・range.ts 0。`putEntry|putGlyphPart`（store.ts・core.ts 以外）は src/migrate.ts の 3 行だけ当たる（t7 の移行が新 DB へ直接書く行。起点 aa3f4a2 から同じ）。range.ts は 0
  - R-t4-11（orchestrator）: m3 の区切りの grep は t7 より前に書かれたもの。移行（migrate.ts）は store から store への引き継ぎで、配信の経路ではないので対象から外す。以後の grep は `grep -v '^src/migrate.ts'` を足して 0 件で判定する
- 既存の試験: style-body.test.ts +5・glyph.test.ts +2（追記のみ）。新規 range-style.test.ts 12 件
- Rulings（実装担当）
  - R-t4-1: スタイルは先の段（別の runJob）で取り、後の段のグリフの単位は style の段の後に作る（同じバッチだと fontstack が欠ける）
  - R-t4-2: opaque の連続数（確かめの起点）はタイルの単位だけで数える。非タイルは範囲のタイルで確かめられない
  - R-t4-3: グリフの単位の失敗は 1 単位 1 件。flush の失敗（quota・storage）を先に、無ければ最初の範囲の上流の失敗を数える
  - R-t4-4: グリフの単位は範囲の間で job.cancel を見て抜ける。取れた範囲は finally の flush で書く
  - R-t4-5: 範囲の一部が失敗しても、レコードが有るか 1 範囲でも取れたら fontstack のキーを固定の対象に入れる。スタイルも、読める記録が既に有れば取り直しの失敗でも固定する（レビュー L2）
  - R-t4-6: スタイルが 200 でも読めなければ upstream。stale の本体が読めれば fontstack は集めて失敗も数える
  - R-t4-7: collectFonts の式の判定は、先頭の要素が MapLibre の式の演算子名の集合に入るか（MapLibre の isExpression と同じ考え方）
  - R-t4-8: GlyphCollector.flush は Resource を読み直してから evictScopesFor を作る。meta は pinned: 0（既存の固定は commitEntry が保つ）。headers・contentType は最後の部分
  - R-t4-9: 試験の「evictScopesFor が fontstack ごとに 1 回」は getSource の呼び出し数で見る（同じモジュールの中の呼び出しは spy できない）
  - R-t4-10: 固定分の上限（overPinnedLimit）は非タイルの Resource も含めて見る
  - R-t4-12: job.count はタイルだけ（processedTiles）で数え、job.total と単位をそろえる（レビュー L3。旧 API の fetch-busy の表示）
- レビュー（L1）: Claude（Codex・Kimi が枠切れ）。判定は合流可。S 0・M 0・L 3 → fab7181 で全部直し、直しを外すと新しい試験が落ちることを確かめた
  - L1: 取り消しの試験が単位の途中の break を確かめていない → `toBeLessThan(COMMON.length)` を足した
  - L2: 保存済みのスタイルが取り直しの失敗で固定されない → R-t4-5 に含めた
  - L3: job.count が全単位の数で「14 / 4」になる → R-t4-12
  - 未確認（レビュー）: gone・region 消失のときはグリフの単位の範囲を取りきる（'all' で最大 256 件。F37 どおり）の所要時間。'all' で 256 範囲を同時実行数ぶんメモリに溜める量
- t5 への申し送り
  - 非タイル資源（style・tilejson・sprite・data・glyph）の固定は onBatch の setPinned で付いている。R11（参照する全 Source の固定つき region が残る間は保つ）の解放の判定はまだ無い
  - グリフの固定はレコード（fontstack）単位。解放もレコード単位
  - plan.resources は非タイルも含む。解放の列挙で enumerate・countRange を使うときはタイルだけに絞る

## m4-t5 解放と範囲つき clean — 完了（PR #105 → e944774）

- 実装: Codex（gpt-6-astra。13:59Z に枠が戻って起動）。実装と判定を終えた後、commit の直前に再び枠切れ（約 9 分で使い切り）→ orchestrator が作業ツリーの変更を確かめて commit（cdf7c9a）。レビューの試験の追加 b9686d2（orchestrator）
- 判定: `node_modules/.bin/vitest run` 41 ファイル・1560 件 passed・`tsc --noEmit` exit 0・`eslint src tests` exit 0（warning 2 件は既存）。Codex の sandbox とレビュー担当の写しで build 3 構成と `tsc -p tests/dts/tsconfig.json` も exit 0。CI（Node 22・24、WebKit・Firefox）緑
- 受け入れ条件の grep: `releaseRange` は docs/api 英日 4・4、README 英日 2・2。`parentId`（range.ts）2
- 既存の試験: control.test.ts +32・client.test.ts +30・tests/dts/page-consumer.ts +11（追記のみ）。range.test.ts は b9686d2 で 1 行追記。新規 release.test.ts
- Rulings（Codex が報告を出す前に枠切れ。レビュー担当が差分から拾い、妥当と判定したもの）
  - R-t5-1: 解放するキーは enumerate を回さず、entriesAtZoom の保存済みの記録を rectsAt（enumerate と同じ座標の直し）で選ぶ
  - R-t5-2: 残る region の保護範囲は、解放する側の持ち主に絞った extents（resourcesOf の写し）で計算する（安全側。対象のキーは自分の extents の中だけ）
  - R-t5-3: force の clean で partial にする region は、Resource の extents を見ず、正規化した範囲どうしの重なりで選ぶ（安全側。消したタイルが無くても partial になり得る）
  - R-t5-4: clean の fetch-busy は範囲の検査より先に判定する。releaseRange は計画の手順 1 どおり region の検査が先
  - R-t5-5: asset の Source の clean(range) は 'all' 以外を attribute-invalid、'all' は何も消さない（planOf を流用しタイルだけを対象にする。文書には未記載）
  - R-t5-6: 非タイル資源は、pin: false の region が残っていても、最後の固定つき region の解放で（keep でなく排他なら）本体まで消す（計画 R11 の文面どおり）
  - R-t5-7: ページ側の releaseRange はいつも options: {} を送り、clean は範囲が無ければ undefined を送らない（client.test.ts で固定）
- レビュー（L1・L2）: Claude（Codex が枠切れ・Kimi は 15:15Z ごろまで枠切れ）。判定は合流可。S 0・M 1・L 1。写しで 13 か所の変異試験を行い、効いていない試験を 2 件見つけた → b9686d2 で 2 件とも試験を足し、変異を入れると落ちることを確かめた
  - M1: holdersOf の rangeOnlySourceIds を外しても全試験が通った（範囲だけで参照する Source の region による保護）→ release.test.ts に試験を追加
  - L1: range.test.ts の「cancel() の後の clean() が通る」は assertSourceIdle を空にしても通った（t3 のレビュー L3 の申し送り）→ 取り消しの後・settle の前の clean が fetch-busy になる 1 行を追加
  - 未確認（レビュー）: update で持ち主の一覧が変わった後（子が外れた後など）に、前の持ち主のときの region を解放すると、今の持ち主が参照しない Resource の固定が残るか。実ブラウザの IndexedDB での動き
- t9・t10 への申し送り: 上の未確認 2 点。R-t5-5 の asset の clean(range) を文書に書くかは t11 の文書の見直しで決める

## m4-t8 制御と門番の堅牢化 — 完了（PR #106 → eaddaf8）

- 実装: Claude（Codex・Kimi が 5 時間の枠切れ）。501ee46・cc47fd9、レビューの直し 34c5ec3。t6 と並行
- 判定: `node_modules/.bin/vitest run` 41 ファイル・1583 件 passed・`tsc --noEmit` exit 0・`eslint src tests` exit 0（warning 2 件は既存）。CI（Node 22・24、WebKit・Firefox）緑
- 受け入れ条件の grep: `isSecretValue` は spec.ts 3・url_pattern.ts 3、`bearer`（spec.ts）0、`credential-undeclared`（docs/api 英日）1・1、`X-Amz-Signature`（README 英日）1・1、L5 の語 1・1、`redirect` 4→7・`リダイレクト` 3→5
  - 事前点検 M5: I6・I8c は文に固有の語で grep した。`separate scope`・`別スコープ`・`gatekeeper`・`門番` がいずれも 0 → 1
- 既存の試験: style-capture.test.ts の C-S1 の待ちを `NOTIFY_DEBOUNCE_MS + 20` に書き換えた（I8b で別の SW への通知が 100 ms 遅れるため）。ほかは追記のみ
- Rulings（実装担当）
  - R-t8-1（I4b）: serialRefresh は検査の失敗も含め、serial の中のすべての例外で表を作り直す（計画の文のとおり。費用だけで害は無い。レビュー L3 で記録のみ）
  - R-t8-2: 「tableChanged が呼ばれた」は ctx.table.generation が 1 進むことで確かめる（ESM の export は spy で差し替えられない）
  - R-t8-3（I8b）: notifyTimer は TableState（src/context.ts。計画の対象ファイルの外）に置く
  - R-t8-4（L8）: update() は applyUpdate が warnings を書き直すので、credential-undeclared を保存した登録内容から作り直して足す
  - R-t8-5（L8）: 値は /^(pk|sk|tk)\./i で、生の形と decode した形の両方を見る。同じ名前は 1 回だけ。Bearer の剥がしはしない。スタイルの子 Source の警告は親へ上げない
  - R-t8-6（I3）: countInBox は x・y を持たない Entry（タイルでないもの）を数えない
  - R-t8-7（I4a）: storage の message は WeiwudiError.from の文面をそのまま使う
  - R-t8-8〜10（記録のみ）: I2a は直さない（R38。最悪 30 秒に 1 回の 3 秒待ち）。I10 は作業なし（R37）。L6 は作業なし（m3-t7 の記録どおり実害なし）
  - R-t8-11（L5）: 日本語の R34 の文は既存の bullet に続けると崩れるので、すぐ後に別の bullet として足した
  - R-t8-12（レビュー M1）: 共有・範囲だけの Resource の count は、Source の box ではなく、owners の extents の box（registry.extentOf が Resource の座標に直したもの）で数える。extents が複数あるときはどれかに入る Entry を 1 回だけ数える
  - R-t8-13（レビュー L1）: 名前そのものがトークンの形（isSecretValue か /^(pk|sk|tk)\./i。生の形と decode した形）なら、その項目を warnings に書かない
- レビュー（L1）: Claude（Codex・Kimi が枠切れ）。S 0・M 1・L 3 → 34c5ec3 で M1・L1・L2 を直し、直す前の実装で新しい試験が落ちることを確かめた
  - M1: tms の Source が xyz の Resource を範囲だけで参照すると、count が y の反転を忘れて範囲の外を数えた → R-t8-12
  - L1: `?pk.SECRET=…` の名前が warnings に出た → R-t8-13
  - L2: docs/api の「sk. で始まる項目はキーに入れない」に Bearer・Token・Basic を剥がした値も足した
  - L3: 検査の失敗でも表を作り直して通知する → R-t8-1 のとおり直さない
  - 未確認（レビュー）: 最後の変更から 100 ms 以内に SW が終わったときの通知の取りこぼし（受け手は次の起動で読み直すので害は小さい見込み）
- t9・t10・t11 への申し送り
  - 範囲が決まる Source の stats().count は範囲の中の Entry の数。共有・範囲だけの Resource では z ごとに entriesAtZoom を読む。byResource の count の和と一致しないことがある（t9 の 2 秒ごとの stats() に注意）
  - 書き換えの op が失敗すると表を作り直すので、失敗の応答に最大 3 秒の待ちが乗り得る
  - 別の SW への表の通知は 100 ms 遅れる。e2e で別スコープの SW の反映を見るときは待つ
  - 新しい公開の code `credential-undeclared` は warnings だけに出る。WeiwudiErrorCode は不変
  - storage が制御の失敗としても返る（detail.name）。ページ側が storage をタイルの失敗だけと決めつけていないか確かめる
  - t11: CHANGELOG に credential-undeclared（warnings の code が 1 つ増えた）を書く

## m4-t6 全体上限 setLimits と QuotaExceededError の再試行 — 完了（PR #107 → 1fe1b58）

- 実装: Claude（Codex・Kimi が 5 時間の枠切れ）。037a40e・6994f11（t8 の合流後に載せ直し ffa02fb・836b45c）、レビューの試験の追加 851109a。t8 と並行（t8 の後に合流。衝突は src/control.ts の import 1 か所だけ）
- 判定: `node_modules/.bin/vitest run` 42 ファイル・1608 件 passed（t8 の合流後）・`tsc --noEmit` exit 0・`eslint src tests` exit 0（warning 2 件は既存）・build 3 構成と `tsc -p tests/dts/tsconfig.json` exit 0・e2e（Chromium）46 passed。CI（Node 22・24、WebKit・Firefox）緑
- 受け入れ条件の grep: `static setLimits(`（dist/weiwudi.d.ts）1・`setLimits` は docs/api 英日 4・4、README 英日 1・1・`10%` は docs/api 英日 2・2
- 事前点検 M1: 全体の要素の初めの値は「totals.bytes − totals.pinnedBytes ＋ この tx の全 Resource の deltas.bytes の和 −（willSave かつ old.pinned === 0 なら old.size）」。cursor でも保存するキーを飛ばす。limits.test.ts で旧 getAll を写した参照の関数と種を固定して 100 回突き合わせ（Source の上限と全体上限の両方）
- 既存の試験の書き換え（計画が台帳への記録を求めたもの）: 「1 回だけ失敗させる」仕掛けを 2 回にした。1 回の再試行で成功してしまい quota が出なくなるため。期待する quota・保存されないこと・stats の count 0 は不変
  - tests/unit/legacy-storage-failure.test.ts（計画が許可）: :91・:168・:183・:215 の 4 件。仕掛けを entries の put だけを N 回失敗させる補助に替え、`toHaveBeenCalledTimes(3)`・`(1)` を `entryPuts(spy) === 2` に替えた（kv の put が増えたため）。「abort が 1 回なら再試行で保存される」を 1 件追加
  - 計画の対象外（R-t1-1 と同じ扱い）: tests/unit/core.test.ts:225・:254、glyph.test.ts:484、range-style.test.ts:260 の `mockRejectedValueOnce` を 2 回つないだ
  - tests/e2e/quota.spec.js: 上限が 1 byte なので再試行も失敗し、書き換えなしで passed（実装担当とレビュー担当の両方が Chromium で確認）
- Rulings（実装担当）
  - R-t6-1: EvictionScope.resourceIds は省略できる形。省略したものが全体の要素で、evictScopesFor は Source の要素の後に置く
  - R-t6-2: 全体上限は Source の上限と同じく固定分を数えない。固定は上限を超えても消さない
  - R-t6-3: totals が無いときの和は resources を getAll でなく cursor で数える（hook.test.ts:127 が照合表の読み込みの getAll を数えるため）
  - R-t6-4: 新しい DB を作るとき totals を書かない（upgrade の put が既存の put の仕掛けの試験を壊す）。最初の書き込みの tx が作る
  - R-t6-5: totals は Entry を増減する書き込みの tx で毎回 put する（差分 0 でも）。getTotals は読むだけ
  - R-t6-6: evictGlobal(bytes) は bytes ≤ 0 なら tx を作らず 0。消した Entry の数を返す
  - R-t6-7: 再試行の前の退避が失敗したら再試行せず quota。quota でない失敗は再試行しない。再試行が quota 以外で失敗したら storage
  - R-t6-8: 移行（migrate.ts）の putEntry は再試行しない（計画は core.save と flush だけ）。全体の要素は evictScopesFor を通るので移行にも効く
  - R-t6-9: setLimits は次の保存から効く。下げたときにすぐには消さない（文書にも記載）
  - R-t6-10: setLimits の本文が object でない・maxBytes が null・小数・負・文字列・真偽値・object なら attribute-invalid（attribute は limits／maxBytes）
  - R-t6-11: range.ts の overPinnedLimit は、全体の要素なら totals.pinnedBytes ≥ maxBytes で quota（計画の対象外のファイルを 3 行。直さないと resourceIds の undefined を回して TypeError）
  - R-t6-12: control.ts の import は既存の行を変えず 1 行足した（t8 との共有ファイルを追記に留める）
  - R-t6-13: setLimits は直列（serial・serialRefresh）に入れない。kv に 1 回書くだけで、表も Entry も変えない
  - R-t6-14（orchestrator・レビュー L4）: グリフの flush の再試行で、同じレコードの固定でない古い部分が evictGlobal でレコードごと消え、再試行は新しい部分だけで作り直す。LRU として正当な退避で失うのはキャッシュだけなので直さない
- レビュー（L1・L2）: Claude（Codex・Kimi が枠切れ）。判定は合流可。S 0・M 0・L 5。写しで 29 個の変異試験（依頼の 4 点はすべて落ちた）。entries への put・delete の経路を全部洗い、totals の更新の漏れが無いことを確かめた
  - L1: Math.ceil を floor にしても通った → 固定でない 5 byte で evictGlobal(1) の試験を追加
  - L2: 再試行が quota 以外で失敗したとき storage の試験が無い → 追加
  - L3: overPinnedLimit の全体の要素の行（R-t6-11）を消しても通った → setLimits の後の fetchRange が quota で止まる試験を追加
  - L4: グリフの再試行で古い部分が消える → R-t6-14
  - L5: kv の limits の検査を外しても通る（書くのは検査済みの setLimits だけで実害なし）→ 見送り
  - 851109a の 3 件は、該当の行を壊すと落ちることを確かめた
  - 未確認（レビュー）: 実ブラウザで totals の put が増えた削除の tx が容量超過で abort するか。WebKit・Firefox の quota.spec（手元は Chromium のみ。CI の WebKit・Firefox は緑）。保存のたびに evictScopesFor が kv を 1 回余分に読む性能の影響
- t10 への申し送り: 実ブラウザでの再試行の成功（abort が 1 回の筋書き。CDP の上限では 1 回だけ失敗させられない）。totals の無い開発用 DB での最初の書き込みと、数 GB の resources の cursor の時間
- t11 への申し送り: CHANGELOG に「`Weiwudi.setLimits({ maxBytes })`（feat）」と「容量超過のとき固定以外を全体の 10% 退避して 1 回再試行する（1.1.x は保存しなかった。§9 の既知の変化）」

## m4-t9 開発用ページを新 API に直す（#41） — 完了（PR #108 → 110be77）

- 実装: Kimi（dsh・k3）が index.html を途中まで書いたところで週（7 日）の利用上限の 429 で停止 → Claude が引き継いで完成（Codex も枠切れ）。3507667、レビューの直し e0caf40
- 判定: build 4 構成（lib・sw-es・sw-umd・demo。build:demo と同じ並び）・`node_modules/.bin/vitest run` 42 ファイル・1608 件 passed（demo-third-party.test.ts を含む）・`tsc --noEmit`・`eslint src tests` exit 0。CI（Node 22・24、WebKit・Firefox）緑
- 受け入れ条件の grep: `registerMap|fetchAll`（index.html）0・`fetchRange` 1・`Fetch all tiles`（README.md）0・usage policy（index.html 2・README.md 1）・`利用規約`（README.ja.md）2
- 実ブラウザの 4 手順（計画が台帳への記録を求めたもの。vite の dev サーバ 127.0.0.1:5190・手元の Playwright の Chromium・ズーム 16）
  1. 登録: 状態 Active・表示中のタイル 6/6・stats count 6・usage tile.openstreetmap.org 6 件
  2. 表示範囲の取得: 確認「Fetch 22 tiles (zoom 16-17)?」→ region complete・pinned・total 22・error 0・stats count 22
  3. オフライン（setOffline(true)）で再読み込み: 状態 Active・タイル 6/6 がキャッシュから表示・stats と regions は手順 2 と同じ。レビューの直しの後にも手順 3 をやり直し、控えのキャッシュに入るのはページ・vite のモジュール・dist/weiwudi.es.js・Leaflet の 7 件だけでタイルは入らないことを確かめた
  4. 解放: stats count 0・regions 空・usage 0 件
  - OSM からの実取得は合計約 50 枚（1 回目 22 枚 × 2 回と、直しの後の手順 3 の 6 枚）。計画の R54 の最小限の範囲
- 計画の対象ファイルの追加: public/demo-sw.js（計画は「変えない見込み。変えるなら対象に足す」）。オフラインの再読み込みでページ本体が `net::ERR_INTERNET_DISCONNECTED` になったため
- Rulings（実装担当）
  - R-t9-1: demo-sw.js に、同じオリジンと unpkg.com の要求を NetworkFirst（cacheName weiwudi-demo-shell）で控える経路を足した。対象は request.mode === 'navigate' か destination が script・style のものだけ（レビュー S1 で絞った。タイルや照合ルートに当たらない）。既存の試験が見る `https://` の文字列は使わず hostname で照合
  - R-t9-2: 殻の控えには、オンラインでの再読み込みが 1 回要る（SW の制御下に入る前の読み込みは控えに入らない）。画面と README の英日に書いた（レビュー S5）
  - R-t9-3: usage() も 2 秒ごとに更新する（初期化の時だけだと登録直後の 0 が残る）
  - R-t9-4: 提供元名の表示を innerHTML から DOM 生成に替えた（XSS の対策。innerHTML は定数の '' だけ）
  - R-t9-5: 判定の build に、package.json の build にある public/weiwudi-sw.js への写しを再現した（dev のページはこのファイルを読む）。出力は判定の後に戻した
  - R-t9-6: estimate が 0 枚なら取得せずに断る。結果が complete 以外なら error の色で出す（レビュー S4）
- レビュー（L1）: Claude（Codex が枠切れ・Kimi は週の上限）。判定は合流可。小さな指摘 6 件 → e0caf40 で 4 件を直した
  - 直した: demo-sw.js の控えの条件（R-t9-1）・showMessage のタイマを clearTimeout してから作り直す・0 枚の取得と complete 以外の色（R-t9-6）・オフラインの注意（R-t9-2）
  - 直さない: 控えのキャッシュ weiwudi-demo-shell に期限も件数の上限も無い（開発用ページで実害は小さい）。計画の対象ファイルの追加は本節に記録
  - 未確認（レビュー）: 同じブラウザで、デモの SW（scope `/`）が手で開いた他のページに及ぼす影響（e2e は demo-sw.js を使わない）
- t10 への申し送り
  - releaseRange（keep なし）は、範囲取得の前から捕捉していた region の範囲の中の Entry も消す（stats 0）。e2e は keep: true の場合も見る
  - stats().total は Source の範囲全体なので percent は小さい。範囲が決まる Source の count は範囲の中の Entry の数（t8）
  - Playwright の context.on('request') はページの要求と SW の要求を両方数える（初期表示の 6 枚が 12 件）。上流の取得枚数を数えるときは注意
  - オフラインの e2e は、オンラインで 1 回読み直してからオフラインにする。vite の HMR の WebSocket のエラーは無視してよい
  - 開発用ページの範囲取得は confirm() のダイアログを出すので、自動化では accept が要る

## m4-t10 範囲取得・解放・移行・全体上限の e2e — 完了（PR #109 → 610a864）

- 実装: Claude（Codex は sandbox で port の bind と network ができず、Kimi は週の上限）。142c1d5、レビューの直し 4fa0fe5
- 判定: 新規 12 件（range 9・migrate 3）を Chromium で 3 回続けて passed（揺れなし）。直しの後も range・migrate・offline の 21 件を 3 回続けて passed。e2e の全件（Chromium）58 passed。`vitest run` 1608 件・`tsc --noEmit`・`eslint src tests` exit 0。src の直しはなし
  - 直しの後の最初の 3 回のループで 3 回目が無出力だった（原因は未確認）。単独の 1 回の passed の後、改めて 3 回続けて passed
- 受け入れ条件: `127.0.0.1` の grep（対象 4 ファイル）0 件。全試験の最後で実ネットワークの計数（localhost:5173・5174 以外と weiwudi.example.com が 0 件）を expect（offline.spec の追記分にもレビュー L1 で追加）
- CI（4fa0fe5）: Node 22・24 緑。e2e-engines の WebKit は 35 passed・2 skipped（migrate の 1・2 件目。R-t10-5 の Blob を保存できない環境の skip が想定どおりに働いた）
  - **Firefox（記録のみの段。continue-on-error）で range の 5 件が失敗**: pins fetched tiles against cacheMaxBytes・releases a range and frees entries・keeps overlapping tiles on release・reports an opaque event for a server without cors・cancels a running job。いずれも `fetchRange` の Promise が 30 秒で解決しない（page.evaluate の timeout）。enforces a global limit と migrate の 2 件は Firefox でも passed。Chromium・WebKit では通る → Firefox 固有の不具合の疑い。m4 の合流の前に調べる（下の申し送り）
- 申し送りの未確認点のうち確かめたもの（Chromium）: 旧 DB の blocked と onversionchange（Weiwudi_x は閉じて消え、閉じない Weiwudi は削除が blocked のまま残り、ページが閉じると通る）・旧 Blob の arrayBuffer() からの配信・SW 更新直後の最初の要求の読み通し・1365 件（7 バッチ分）の移行の途中のオフラインで末尾のキーが hit・SW を止めてから 31 秒未満で job/resume して complete
- 確かめられなかったもの: WebKit の非永続領域での移行（種の Blob を作れない）・再試行の成功（CDP の上限では 1 回だけ失敗させられない）・totals の無い開発用 DB の最初の書き込み・数 GB の cursor と移行の時間・別の SW への表の通知の 100 ms 遅れ（同じスコープの SW 1 つの試験のみ）
- Rulings（実装担当）
  - R-t10-1: tile-server.mjs に `/slow/{z}/{x}/{y}.png`（250 ms 待って 200・CORS あり）を足した（計画が許す「端点を足すとき」）。SW の停止と取り消しの試験で z0〜3 の 85 枚・約 4 秒
  - R-t10-2: 「30 秒以内に job/resume」は、SW を止めた時刻から最初の POST まで 31 秒未満で判定（届くまでの遅れに 1 秒の余裕）
  - R-t10-3: releases a range and frees entries に、keep: true で本体が残る確認と、解放済みの id が attribute-invalid になる確認を追記（t9 の申し送り）
  - R-t10-4: スタイルの範囲取得は fontstack を fonts で渡す（basic.json に text-font が無い）。既定の common の 5 範囲を上流が受けたことも見る
  - R-t10-5: migrate の種で Blob の put が失敗する環境では理由つきで test.skip（1.1.1 もその環境では保存できず移す旧 DB が無い）。skip にするのは DataCloneError か文面に blob・file を含む失敗だけで、ほかは投げ直す（レビュー M1）。計画どおりタグは付けない
  - R-t10-6: 範囲・移行のページの SW は offline-sw.js（hook-sw.js の利用者のルートは不要）
  - R-t10-7（レビュー M2）: 移行の完了は要求の回数でなく 20 秒の期限つきのループ（要求 → 完了条件の確認 → 50 ms）で待つ
- レビュー（L1）: Codex（gpt-6-astra。19:05Z に枠が戻って起動）。S 0・M 2・L 1 → 4fa0fe5 で全部直した
  - M1: legacy-seed の putAll の例外を種類によらず skip にしていた → R-t10-5
  - M2: 移行の完了を最大 40 要求で打ち切っていた（移行は waitUntil で並行し、要求は同じ Promise を共有する）→ R-t10-7
  - L1: offline.spec の追記した試験に通信の計数が無かった → 追加
  - 固定の 1 秒待ち（range.spec.js:342。取り消し後の通信数の観測）は指摘として残さず記録のみ
- 範囲の外で気づいたこと: 既存の cache.spec.js の 2 件（should cache tile requests・should clear cached tiles）は test-page.html が tile.openstreetmap.org を登録し、route を置かずに 0/0/0 を取る。e2e の全件を走らせると実の OSM へ数回出る
- t11 への申し送り
  - Firefox の range の 5 件の失敗を調べてから master へ合流する（m4 の中で直す）
  - 文書の「CI の 29 件」（docs/api/weiwudi.md の 29 tests）は range のタグ無し 6 件と migrate の 2 件ぶん変わる
  - 文書の「WebKit は Blob を保存できない」と、WebKit の CI で migrate の 1・2 件目が skip になることが合っているか確かめる
  - cache.spec.js が実の OSM へ出る件をどう扱うか決める

## m4 の追加の直し: Firefox で fetchRange が始まらない — 完了（PR #110 → f95dd19）

- 発見: PR #109（t10）の CI の e2e-engines の Firefox の段（記録のみ・continue-on-error。チェックは緑のまま）で range.spec.js の 5 件が 30 秒の時間切れ。orchestrator が CI の log を読んで気づいた
- 原因（製品の不具合）: ページ側の fetchRange が制御の POST の前に `await navigator.storage.persist()` をしていた。Firefox の persist() は利用者に許可の確認を出し、答えるまで Promise が決まらない → 範囲取得が始まらない（無視されれば永久に）。根拠: 手元の Firefox 159 で persist() が 5 秒 pending・/v2/fetchRange の POST が出ない・落ちた 5 件はすべて fetchRange を呼び、通った 3 件（global limit・migrate 2 件）は呼ばない
- 直し: persist() は求めるだけで待たない（失敗と同期の例外は無視）。仕様 I5b「試す（失敗は無視）」のまま。docs/api 英日に 1 文ずつ。a5f455e
- 実装と調査: Claude（e2e が要るので Codex の sandbox では不可・Kimi は週の上限）。レビュー: orchestrator が差分を読んで L1（小さな差分）
- 判定: 手元の Firefox 159（Playwright の moz-firefox・WebDriver BiDi）で直す前は CI と同じ 5 件が落ち、直した後は range.spec.js 6 件・e2e 全件 37 件 passed。Chromium の e2e 全件 58 passed・vitest 1609 件（persist が決して解決しない・同期の例外の試験を追加。直す前は時間切れで落ちる）・tsc・eslint exit 0。CI: Node 22・24 緑、e2e-engines の WebKit 35 passed・2 skipped（R-t10-5）、**Firefox（firefox-1555・Juggler）37 passed・失敗 0**
- 手元の罠: vite の開発サーバは、起動後に作り直した /dist/weiwudi.es.js を配らない（メモリの古い版を返す）。build し直したら vite も起動し直す
- 教訓: Firefox の段は continue-on-error なので、チェックが緑でも log の失敗の件数を読む。t11 以降の PR でも e2e-engines の log の集計を見る
