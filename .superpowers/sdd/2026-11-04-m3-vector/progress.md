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
