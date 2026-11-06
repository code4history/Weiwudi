# m3 ベクタ資源 — 台帳

計画: docs/superpowers/plans/2026-11-04-m3-vector.md

## 事前点検（2026-11-05）

- 第 1 回（7af1db9）: 水準 1（新しい Claude）は不合格・S 8・O 14。水準 2（Codex・範囲を絞り 30 分の指定・約 40 分）は不可・必須 8・推奨 6。どちらも骨格（子 Source の方式・段階の登録・グリフの結合保存・依存を足さない）は成り立つと判定。95a9efa で反映
- 第 2 回（95a9efa・水準 1 だけ）: 第 1 回の 16 件はすべて解消。新しい S 2（ミラーが混ざる子で本体からの除去を URL ごとに判定して 401／TileJSON に parseStyle の形の検査が当たり保存されない）・O 8。2de426a で反映

Ruling: 巻き戻しは、新しい登録は子 → 親の順に外す。既存の登録の update・再登録は段 A（スタイルの取得と解析）が成功するまで何も書き換えない。段 A の後の IndexedDB の失敗と、直列の外の読み取りで途中の状態が見えることは受け入れて文書に書く（計画の R33）— IndexedDB の失敗はまれで次の register・update で直る。動くもの最優先 — 誤りならスナップショットの復元を足す
Ruling: 第 2 回の水準 2 は置かない — Codex の必須 8 件は水準 1 が 1 件ずつ解消を確かめた。Codex は 1 回 40 分かかる — 誤りなら実装の t3・t5・t7・t8 の水準 2 で拾う
Ruling: 第 2 回の反映で事前点検を合格とし、再点検は置かない — 新しい S 2 件は数行の直しで、直し方まで指摘にある。m2 の事前点検の第 4 回と同じ扱い — 誤りなら t6・t7 のレビューで差し戻しが出る
- **m3 の事前点検は合格（2026-11-05）。** 次は t1

## m3-t1 定数の一本化・依存の表・仕様の事実（I5・F1）

- PR: https://github.com/code4history/Weiwudi/pull/84 （合流 511e96d）
- 実測: 単体試験 987 passed（979→987）・typecheck・build・eslint 0・e2e 34 passed・CI 全緑
- 対照（commit せず、実装担当が実測）:
  - `constants.ts` に `import './errors'` を足す → deps.test が落ちる（依存 ["errors"]）
  - `nextOrder` を +2 にする → 2 件が落ちる
  - `isLegacyRecord` の map: 判定を外す → 1 件が落ちる
  - `DAY_MS` を 24 分にする → 3 件が落ちる
- L1（Claude）: 合流可
  - Minor-1（§3 の注と tile_math・errors の行の矛盾）は進行役が注を直した（026dacf）
  - Info: templatesOf は壊れた記録で [] を返す（安全側）。gw_logic の `/v2/` と疑似ホストの正規表現は対象外で残る
- Rulings（実装担当。いずれも承認）: store 補助の試験は constants.test.ts へ。control の `as StoredSpec` 3 か所・gw_logic:32・core.ts:247 は残す。nextOrder は `Pick<Store,'listSources'>`
- t2 への申し送り:
  - isChildRecord・styleSpecOf は store.ts の「SourceRecord を読む補助」の節に置く
  - StyleSpec が templates を持つので、storedSpecOf・templatesOf を kind で絞るかを t2 で決める
  - 残る一本化（gw_logic:32・core.ts:247・control の as 3 か所）は、t2 で触れるなら揃える
  - deps.test の表は m3 の全行を持つので、後のタスクでは触らない

## m3-t2 registry の一般化 — 子 Source・資源の型・範囲の持ち主（P1）

- PR: https://github.com/code4history/Weiwudi/pull/86 （合流 3d22f3d）
- 実測: 単体試験 1034 passed（987→1034）・typecheck・build・eslint 0・e2e 34 passed・CI 全緑
- 対照: わざと壊した 12 通りで試験が落ちた。初めに検出できなかった 2 通り（control で子を隠さない・glyph に z/x/y を許す）は 0a106e1 で試験を補った
- L1（Claude）第 1 回: 合流不可。Major 1 件・Minor 1 件
  - M1: m2 の記録（type なし）の update() が必ず resource-conflict になる。control.ts が生の rec.spec を渡していた
  - m1: recomposeExtents が tile でない Resource に extents: [] を書く
  - 651029f で直した。control の `as StoredSpec` は 0 件。足した試験は、それぞれ直しを外すと落ちる
  - 直しは小さく、指摘に直し方まで書かれていたので、進行役が差分を読んで確かめて再点検は置かなかった（m3 の Ruling「再点検を省く」と同じ扱い）
- Rulings（実装担当。いずれも承認）:
  - storedSpecOf・templatesOf は style の親を除く
  - tile でない指定の outOfRange は not-found に固定する
  - raster・vector の StoredSpec は encoding を持たない
  - evictScopesFor は StyleSpec.children を正本として読む
  - control の isVisible で子を隠す
  - childLogicalName は関数にする（module-state 試験のため）
  - sprite の {spriteSuffix} は t6 で足す
- 申し送り:
  - t3: 資格情報を親と子のどちらの id で持つかは、まだ決めていない。hook の候補は今の templatesOf のままで子に効く
  - t5: StoredSpec.provider は型だけ置いてある
  - t6: sprite の {spriteSuffix} を TokenName と checkTokens に足す
  - t7:
    - 子は normalizeMember(type, [url], common, {kind:'child', internalId: childSourceId(...), logicalName, encoding, single}) で作る。tile の子には encoding を必ず渡す
    - 合流は apply(..., {throwOnConflict:false, resetCors, order: 親の order, parentId}) で行う
    - 親の children を保守する。子を書いてから children を更新するまでの間、その子は退避の範囲に入らない
    - asset を開けるときは、kind と type の組み合わせを検査する

## m3-t3 資格情報の検査と行き先（I1・I2・I8・I9）

- PR: https://github.com/code4history/Weiwudi/pull/87 （合流 ba82cd2）
- 実測（t3 の枝）: 単体試験 1057 passed・typecheck・build・eslint 0・e2e 35 passed（1 件増えた）・CI 全緑
- 対照: わざと壊した 10 通りで、試験が落ちた。M-1 の直しを外すと、単体と e2e の両方で 1 件ずつ落ちた
- L1（Claude・セキュリティの観点）第 1 回: 合流不可。Major 1 件・Minor 2 件
  - M-1: no-cors の取り直しにも redirect: 'error' が付く。Fetch の main fetch では network error になるので、ヘッダの資格情報 ＋ CORS の無い上流で必ず失敗する。単体の fetch の模造品はこの規則をまねないので、試験では見えなかった
  - m-1: C-O6 の grep がコメントにしか当たっていない
  - m-2: 台帳への記録（下に書いた）
  - 6f42299 で直した: `addedHeader && mode !== 'no-cors'`。単体と e2e に 1 件ずつ足した
- L2（Codex・範囲と 30 分を指定）: 約 6 分で最終報告。必須とされた 2 件は、進行役が次のとおり判定した
  - glyph の fontstack の区画の `sk.abcdef` がキーに入る → 取らない。本物の秘密トークンは必ず sk.eyJ で始まる（L1 i-3 でも確認）。拒否を sk.eyJ に絞ったのは計画どおり
  - クエリの資格情報だけを足した要求がリダイレクトを辿る → 計画どおり。上流を信頼する前提を、仕様 §10 と docs/api の英日に 1 文書いた（6f42299）
  - 推奨（Bearer の剥がしの不一致・独自名の資格情報に警告を出す）は m4 へ申し送る
- 書き換えた既存の試験:
  - m2-checkpoint.test.ts の L-2: describe 名と 4 件の URL を sk.eyJ の形に替え、sk.abcdef が通る 1 件を足した
  - spec.test.ts:179: 2 つ目のミラーを `access_token=pk.fromurl&sku=pk.second` に替えた。元の形は I2 で拒否になるため
- Rulings（実装担当。いずれも承認）: I2 はミラーの間だけで比べる。「ヘッダを足した」は実際に set したときだけ。オリジンの比較は requestChanged のときだけ。I2 の detail は {attribute:'url'}
- 申し送り:
  - t5: applyCredentials を差し込むときも、「ヘッダを足したら redirect: 'error'（no-cors は除く）」を保つ
  - t7: 資格情報を親と子のどちらの id で持つかを決める。TileJSON・スタイルから作るミラーで値が違うときの扱いも決める

## m3-t4 グリフの結合保存（#39・仕様 §11）

- PR: https://github.com/code4history/Weiwudi/pull/88 （合流 1b6ca2d）。t3 と並行で、別の worktree で作業した（作業後に撤去）
- 実測（t4 の枝）: 単体試験 1052 passed・typecheck・build・eslint 0・e2e 34 passed・CI 全緑
- 対照: わざと壊した 9 通りで試験が落ちた。種を固定した 100 回の試験で、count・bytes が全件の集計と一致した
- L1（Claude）: 合流可。Critical・Major・Minor はいずれも 0
- Rulings（実装担当。いずれも承認）:
  - 部分を LiveEntry に置き換え、後段の処理を共有する
  - parts の無い既存のレコードは miss として作り直す
  - 新しい部分は末尾に足す
  - ヘッダはレコード単位で持つ
- 申し送り:
  - t7: 範囲取得では「1 fontstack 分を溜めてから 1 回で書く」ために、putGlyphParts（複数の部分を一度に受ける）を足す。今は 1 範囲ごとにレコード全体を書き直す
  - m4:
    - 固定の値が、上流を待つ間に戻る競合がある（putEntry にも以前からある）。commitEntry で old.pinned を引き継ぐ
    - 期限切れの部分は bytes に残る（R7）
    - 上限を超えた結合レコードでは、新しい範囲を保存できない

## 合流後の実測（vector-cache ba82cd2）

- 単体試験 1075 passed・typecheck・build 0・e2e 35 passed
- 運用の記録: e2e は build してから走らせる。public/weiwudi-sw.js は build で作られ、commit されている版は古い。build しないと 18 件落ちる（分岐点でも同じ）

## m3-t5 提供元の登録表と標準の mapbox://（#40）

- PR: https://github.com/code4history/Weiwudi/pull/89 （合流 8227414）
- 実測（t5 の枝 55f198c）: 単体試験 1165 passed・typecheck・build・eslint 0・e2e 35 passed・check-dts と tests/dts の tsc 0・CI 全緑
- C-O3（mapbox:// の解決の形）: mapbox-gl 3.27.0 の normalizeStyleURL などの解決の形（配布物の 55811〜55870 行）と照らした。styles・glyphs・source は一致、sprite は基底の URL まで、tiles は字句のまま
- F3（BeatBox との違い）: `?secure` を付けない・token を URL に入れない（applyCredentials で上流へ出す直前に足す）・`mapbox://a.b` と `tiles/{id}`・draft と 3 区画の sprite を扱う
- L1（Claude）: 合流可。Minor 3（resolve の契約の文言・利用者の提供元の例外の文面・ミラーの提供元の比較）
- L2（Codex・約 22 分で最終報告）: 合流不可・必須 3。いずれも直した（55f198c）
  - 提供元の違う Source が 1 つの Resource にまとまる → conflictOf に provider を足し resource-conflict にした
  - 提供元の id の重複 → addProvider で TypeError。id 'mapbox' は標準の差し替え（文書に記載）
  - mapbox.ts の頭の注記が一致の範囲を言い過ぎ → 限定に書き直した
- 対照: 直しの各項目を外すと試験が落ちることを実装担当が確かめた（文書だけの直しを除く）
- Rulings（orchestrator）: L2 の必須 3 件は直してから合流。再点検は対照の実測で足りるとし、L2 は回し直さない
- 申し送り（t7）: tiles の @2x・webp・raster の前置、secure の付く位置、スタイルの imports

## m3-t6 スタイル・TileJSON の本体と捕捉（I3 の前半）

- PR: https://github.com/code4history/Weiwudi/pull/90 （合流 ddc563e）
- 実測（t6 の枝 dfa2f1e）: 単体試験 1242 passed・typecheck・build・eslint 0・e2e 35 passed・受け入れ条件の grep 0・CI 全緑
- 対照: 初回 11 通り・直し 6 通りで、外すと試験が落ちた
- L1（Claude）: 第 1 回は合流不可（Major 1・Minor 4）。すべて直した（33f67af・dfa2f1e）
  - Major-1: 子にならない URL（WMS の `{bbox-epsg-3857}`・`{range}` の無い glyphs）のトークンを本体から除いていた → 字句の許可の表を url_pattern.tokenRejection 1 つにし、style_body の acceptsAsChild と spec の checkTokens で共有。受けられない組は除かず、source ごと skipped
  - Minor: revalidate が通常の要求にまとめられる（flightKey に印）・sourceIds を順に探す道の試験・skipped と tiles の重複・hit での IndexedDB の読み出し（遅延計算）
- Rulings（実装担当。いずれも承認）: spec.ts の sprite の字句・sprite で字句を必須にしない・stripTemplateParams を相対 URL に広げる・serveResource の opts・除去は Resource 単位・skipped の reason は unsupported-source・source の組が 1 つでも受けられなければ source ごと外す・transform 内の store の失敗は上流の失敗
- 申し送り（t7）:
  - update() でスタイルの URL が変わるとき、serveResource の opts で除去の親を直接渡す（O-N2）
  - 子に資格情報を配る判定は credentialTargetOf と childGroups（acceptsAsChild）を同じ組の単位で使う
  - ミラーの間で資格情報の値が違う組（R22）と、normalizeMember だけが拒否する組（userinfo・sk.・#）を、子作りと本体の除去で揃える
  - 親の資格情報を明示として子に配ると、テンプレートの値と違う子で 401 になりうる。扱いを決める
  - スプライトの子は spriteTemplateOf で作る。登録時の取得は revalidate: true を使い、serveResource の reject を扱う

## m3-t7 スタイルの芋づる登録と asset（仕様 §5.5・P2・I3 の後半・I10）

- PR: https://github.com/code4history/Weiwudi/pull/91 （合流 840dc1c）
- 実測（t7 の枝 faf3772）: 単体試験 1305 passed・typecheck・build・eslint・check-dts・tests/dts の tsc 0・e2e 35 passed・受け入れ条件の grep をすべて満たす・CI 全緑
- 対照: 初回 30 通り（3 通りは試験を足して検出）・直し 6 通り。M-1 の (a)(b) は二重の守りで、両方外すと 3 件落ちる
- 書き換えた既存の試験（style・asset を受けるようになったため）: control.test.ts:139 の unsupported-kind → 受け付けと未知の kind の attribute-invalid・spec.test.ts:34 の it.each → style・asset の受け付けと検査・spec.test.ts:397 の期待値
- L1（Claude）: 合流不可（Major 1・Minor 1）。資格情報の漏れは見つからず
  - M-1: registry.apply の途中で失敗すると、書きかけの子と親の資格情報が孤児で残り remove() で消せない → applyChild で apply の前に巻き戻しの対象へ入れる＋removeStyleChildren が parentId で孤児も外す（巻き戻しと remove の両方）
  - m-1: X2 の試験が空振りしうる（実際に 1 件しか出ていなかった）→ 件数と先のホストを確かめ、別の座標で出す
- L2（Codex）: 第 1 回はネットワーク切断で 5 時間止まり取り消し。第 2 回は約 30 分で最終報告・合流不可
  - 直した: 巻き戻しの孤児（L1 M-1 と同じ）・warnings の subject に userinfo（到達する経路あり）・acceptsAsChild の既定の判定に userinfo の拒否・`sprite.<id>` を文書と仕様 §12 へ・子の内部 id に子でない記録や別の親の子があれば internal・R10 の新しい子の衝突の試験
  - Rulings（orchestrator。直さない）:
    - 再登録で credentials を省くと資格情報が消える → register は置き換えで、タイルの登録と同じ。文書に無かったので英日に 1 文ずつ足した
    - 親の資格情報を受け取らない子の TileJSON の本体は除去しない → R32 どおり（除くと 401）
    - 推奨のうち空の資格情報の記録・fonts の扱い・stagesBC の差分のログは入れない（実害なし・文書どおり）
- Rulings（実装担当。いずれも承認）: 対象外のファイル（hook・context・weiwudi_gw_logic・style_body・store）への手入れ・組の判定を先に当てる・仮の id `#weiwudi-unsaved-N`・親の記録を子 1 つごとに書き直す・段 A が取れなければ invalid-style・スタイルの source の範囲が TileJSON に勝つ・imports は辿らず unsupported-source: imports・タイルの URL は字句のまま（@2x・webp・raster の前置なし）・ミラーが混ざった子は丸ごと same-origin-skipped・資格情報の無い子は何も書かない・remove は source-not-found 以外を投げ直す
- 申し送り:
  - t8: removeResource・usage は子を親の単位で数えるか決める。removeStyleChildren・ownersOf を使う
  - t9（e2e）: blob Worker から スタイル → `?secure` の TileJSON → タイル・sprite@2x・{fontstack}/{range} を確かめる
  - m4: 範囲取得のグリフは putGlyphParts を使い、同じ範囲が 2 つあるときの後勝ちを試験する・直列の待ち行列で上流を待つので取得の上限を検討（R34）・取り直しと除去で credentialParams がずれる件（L1 i-2）と R3 で残した子の資格情報（L1 i-3）は実害なしとして記録

## m3-t8 資源単位の削除と提供元別の使用量（#38・I4・I6）

- PR: https://github.com/code4history/Weiwudi/pull/92 （合流は下の merge commit）
- 実測（t8 の枝 3ae6e2d）: 単体試験 1338 passed・typecheck・build・eslint・check-dts（weiwudi_gw・weiwudi）・tests/dts の tsc 0・e2e 35 passed・受け入れ条件の grep をすべて満たす・CI 全緑
- 対照: 初回 18 通り・直し 11 通りで、外すと試験が落ちた
- 書き換えた既存の試験（I6 で送り手の無い POST が sw-not-controlling になるため）: sw-harness.ts に PAGE_CLIENT を足し post の既定の送り手にした・control.test.ts の direct() の event を `{ clientId: PAGE_CLIENT_ID }` に・style.test.ts の R33 の孤児の試験で event と self を置く
- L1（Claude）: 合流可（Minor 3）。実 Chromium の探りの e2e で、window・blob Worker・同じオリジンの iframe が通ることを確かめた
  - m-1: srcdoc の iframe が sw-not-controlling で弾かれる → about:srcdoc・about:blank は完全一致で受ける（Ruling: clients.get は同じオリジンの client だけを返し、opaque な sandbox の iframe は制御下に入らないことを実測済み）
  - m-2: clientId が空・event が無い POST の試験 → 足した
  - m-3: 名指ししない Resource を消さない試験 → 足した（id の境界 a/ab も）
  - Info: postV2 で書式に合わない code を internal に（isCodeFormat を共有）・文書の重複の削除・usage の鍵の名前空間の注記
- L2（Codex）: 第 1 回は 30 分の枠で最終報告の前に止まった。同じスレッドを再開して最終報告だけを書かせた。合流不可（必須 2・いずれも文書）
  - from の未知の code の説明が段落の中で食い違う → 冒頭を書き換えた
  - removeResource の「resources の id」が実装と合わない（孤児の子も受ける）→ 書き直した
  - 推奨（clearEntries の境界・共有の usage・送り手の検査の失敗）の試験を足した
- Rulings（実装担当。いずれも承認）: weiwudi_gw_logic は触らない（workbox が event を渡す）・styleChildIds を style.ts に切り出す・孤児の子を持ち主に入れる・resourceId が空なら attribute-invalid・usage の鍵が引けなければ 'unknown'・送り手の検査は fail-closed で本文の前・usage は直列にしない・about: は完全一致
- 運用の記録: Codex の job の記録は cwd ごとの台帳（clone で起動すると state/Weiwudi-*）に入る。見張るときは find で探す
- 申し送り（t9）: 実ブラウザで blob Worker・同じオリジンの iframe・srcdoc の iframe からの制御の POST・removeResource の後の再取得・usage を確かめる。WebKit・Firefox の dedicated Worker の client は未確認（R14 で Chromium だけ）
