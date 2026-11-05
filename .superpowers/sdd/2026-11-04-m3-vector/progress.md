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
