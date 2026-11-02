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
- 判定: 水準 1（Claude quality-engineer）不合格・S 15・O 18。水準 2（Codex・読み取り専用）差し戻し・必須 6・推奨 7
- 実走で確かめた事実（水準 1）: BASE の単体 404 passed・計画の行番号はすべて一致・PLAYWRIGHT_SKIP_BROWSER_GC は 1.64 にある・手元の firefox-1538／webkit-2336 は 1.64 の要求（1555／2370）と合わない

### 水準 1 の S（裁定はすべて裁定案を採る）

| ID | 内容 | 裁定（反映すること） |
|---|---|---|
| S1 | 実行中の状態（store 接続・照合表・同時要求の Map・corslessStreak・ジョブ）の置き場が未定。モジュール変数だと残す旧試験が DB を共有し、t7 の 2 ハーネス試験が偽の緑（模型で実走して落ちた） | 可変状態は Weiwudi_Internal の呼び出しごとの実行文脈に置く。モジュール変数は plugins の登録表だけ（試験用の消去関数つき）。t1 で `createSwHarness({ factory? })`。t7 に broadcast を止めると落ちる対照 |
| S2 | Resource の count・bytes・corsOk・corslessUntil を書き換える経路が `putResource` の丸ごと書き戻しだけで、並行更新が消える・古い写しで判定する | t2 に `patchResource(id, fn)`（1 tx で読み・直し・書き）。putResource は新規と registry の置き換えだけで、置き換え時も同じ tx で count・bytes・pinnedBytes を引き継ぐ。upstream は判定ごとに getResource。交互実行と「同じ実体で CORS 成功後に opaque 3 回で corslessUntil を立てない」の試験 |
| S3 | serve の upstream の口が Entry の有無を受け取れず、仕様 §4.5 の S-E・S-F が書けない | `upstream(request, ctx: { hasEntry })`。t4 の試験で渡ることを確かめる |
| S4 | 共有 Resource でどの Source の cacheMaxBytes を当てるか未定 | `evict` を `{ resourceIds, maxBytes }[]` にし、上限を持つ各 Source の Resource 群で退避。rangeOnlySourceIds の Source は数えない。2 Source が上限を持つ試験 |
| S5 | Resource.id と Source の既定 id の正規化が未定義で担当が無い | t3 に `normalizeTemplate(t, credentialParams)`・`templatesOverlap(a, b)`。規則は絶対化・資格情報の項目を除く・クエリを名前順・URL の既定の小文字化だけ。新しい id は先頭テンプレートの正規化、合流時は既存 id を変えない。ミラー順の入れ替えの試験 |
| S6 | 旧 API の Source id（mapID）と新 API の任意 id が同じ sources で衝突 | 旧 API の Source id は `map:<mapID>`。新 API で `map:` 始まりは拒否（attribute-invalid 等）。control は legacy の記録を source-not-found 扱いにし sources から除く。t5・t8 に試験 |
| S7 | style・tilejson 以外の text/html を「保存しない」だけにしており、Entry があるとログイン画面を refresh で配信する | HTTP の失敗として §6 の 4・5 に入れる。「Entry あり → 古い本体・stale・upstream」の試験 |
| S8 | 旧 API の経路で requestWillFetch が効かない（仕様 §8 と食い違う） | `req === 元の要求 ? fetch(url 文字列) : fetch(req)`。legacy の試験に 1 件 |
| S9 | t5 の golden が後の commit で書き換えられても、消して作り直されても通る | golden と筋書きの git log が 1 行、golden が無ければ失敗（書き出しは UPDATE_GOLDEN=1 のときだけ）、手数 ≥60 を試験内で expect |
| S10 | 「旧試験を壊さない」が削除や skip を見逃す | `diff <(git show 3ee1e72:… | sed '39,75d;500,585d;597,865d') …` が空、`.skip/.only/.todo` が 0 件 |
| S11 | ハーネスの FakeFetchEvent に waitUntil が無く R11 が試験されない | t1 で waitUntil を足し Promise を記録。t5 で fetchAll のジョブが waitUntil に渡る試験 |
| S12 | t4 の d.ts の判定が `export … from` の 1 行で偽の緑 | `dist/plugins.d.ts`・`dist/store.d.ts` の存在と、d.ts から相対で辿れるファイルが全部あることを node で確かめる（t8 も同じ形） |
| S13 | t8 の対象ファイルでは版の埋め込み（define）と warnings の保存先が書けない | t8 の対象に vite.config.sw-*.js・vitest.config.ts（`__WEIWUDI_VERSION__`）。`SourceRecord.warnings` を t2 の型に |
| S14 | Playwright 1.64 は gracefulShutdown が無いと SIGKILL で止め、t1 の rmSync が走らない | webServer に `gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 }`。起動時に古い `weiwudi-e2e-*` を消す保険も置く |
| S15 | t9 の「制御外の POST」の判定が必ず通る | weiwudi.example.com への要求が 0 件であることを route か request で見る。`https://` の grep から weiwudi.example.com を除く |

### 水準 2 の必須（裁定）

| ID | 内容 | 裁定（反映すること） |
|---|---|---|
| C1 | `/v2/*` の JSON POST は cross-origin の preflight を生むが、preflight が SW の fetch に渡るか未測定。旧 SW は weiwudi.example.com の GET だけを持つので POST が実ホストへ出て資格情報入りの本文が漏れうる | 制御の POST は preflight の要らない単純要求にする（`Content-Type: text/plain;charset=UTF-8` で本文は JSON）。資格情報を含む POST の前に C2 の ping 成功を必須にする。t9 の実ブラウザで「preflight が出ない・SW が受ける」を測る |
| C2 | controller が非 null でも Weiwudi の SW とは限らない。swCheck は旧 API が共有しグローバルに固定するので、/v2/ping に変えると旧 SW の上で旧 API が壊れる | 新 API の確認は swCheck と別の関数にし、`/v2/ping` の成功（版を含む）を最初の資格情報 POST より前に必須とする。404 は sw-outdated、ネットワーク失敗は sw-not-controlling 扱いで再試行可（記憶しない） |
| C3 | Source.id・Resource.id を資格情報の除去後に作る規定が無く、`?access_token=` が IndexedDB と公開値に残る | S5 の normalizeTemplate を id の唯一の作り方にし、仕様 §5.1 に「credentialParams を除いた後から作る」と書く。id と warnings に資格情報が入らない試験 |
| C4 | SourceInfo・SourceStats に名前付きの定義が無い。Credentials・OutOfRange・TileBox も公開型から到達する | すべて名前付きで export し、t8 の d.ts の確かめ（S12 の形）の対象に入れる |
| C5 | `WeiwudiSource.resources: ResourceMeta[]` が保存型（corsOk・corslessUntil・会計）を公開する | 公開用の `ResourceInfo` に射影する（id・type・templates・count・bytes 程度）。ResourceMeta は内部に残す。t4 の `WeiwudiPlugin` が ResourceMeta を晒すなら同じく射影する |
| C6 | 汎用 credentials を m2 に入れながら `sk.` の拒否が m3 で、m2 で通った登録が m3 で失敗し、秘密トークンが m2〜m3 の間保存される | `sk.` の拒否（credential-rejected）を m2 に入れる（提供元に依存しない文字列検査） |
| C7 | golden が statusText と全ヘッダを比べず、保存時に落とすヘッダ（content-encoding 等）の挙動変化が §9 に無い | golden は全ヘッダと statusText を記録して比べる（除外は計画の 2 ヘッダだけ）。意図した差は仕様 §9 の既知の変化に列挙する |

### 推奨と O の扱い

- 水準 2 の推奨 7 件はすべて採る。
  - R2 の理由を「suffix の再解析が不要」に直す。
  - warnings を snapshot と定める。
  - requestWillFetch は S8 と同じ。
  - SourceSpec の style・asset を m2 の間は拒否すると文書に書き、`unknown-type` と別の「未対応」の code を予約する。
  - 門番は「利用者ルートは同期に登録」と明記し、表の読み込み失敗に backoff を置く。
  - weiwudi.example.com の登録を拒否する。
  - x-weiwudi-status の 7 値と x-weiwudi-error の 4 語・expose-headers の名前を、公開契約として試験で列挙する。
- 水準 1 の O は、作者の判断で反映してよい。ただし次の 4 件は進行役が決める。
  - O-1: `<BASE>` は「そのタスクの分岐点（`git merge-base HEAD origin/vector-cache`）」と定義する。
  - O-13: Firefox は m2 では測らないとして、仕様 §2 を R14 に揃える。playwright install はしない。
  - O-14: m3・m4 への持ち越しは、進行役が state の m3・m4 の `carried_from_precheck` に書く。
  - O-16: R9 の理由の文を直す。

Ruling: S 15 件と水準 2 の必須 7 件（C1〜C7）は、すべて裁定案で反映する — どれも実装前に直せば文書の変更で済み、実装後や公開後だと手戻りか互換破壊になる — 誤りなら m2 の計画が大きくなるだけ
Ruling: C1 は単純要求（preflight の要らない形）を選ぶ（text/plain の JSON）を選ぶ — preflight が SW に届くかに依存しない。旧 SW で本文が漏れる件は C2 の ping 先行で塞ぐ — 誤りなら t9 の実ブラウザの測定で落ちるので、OPTIONS の扱いへ切り替える

## 事前点検 2026-11-03（第 2 回）

- 点検者: 新しい Claude（quality-engineer）/ 水準 1、Codex / 水準 2 / 対象 `4e9266e`（第 1 回の反映）
- 判定: 水準 1 不合格・S 7・O 21（第 1 回の S・C は S6 の t5 側の試験を除き反映済み）。水準 2 差し戻し・必須 6・推奨 5（C1・C5・C7 は解消、C2・C3・C4・C6 は一部）
- 実走で確かめた事実（水準 1）: Chromium 1248 では JSON の POST も preflight なしで SW に届き、context.route には SW が受けた要求は見えない（S15 の数え方は有効、t9 の「without preflight」は区別できない）

### 水準 1 の S（裁定はすべて裁定案）

| ID | 内容 | 裁定 |
|---|---|---|
| S-1 | 試験の一覧が「前の版のとおり」で、今の計画に無い（upstream・hook の試験が列挙されていない） | `887caee` の 4 つの一覧（url-pattern・registry・upstream・hook）を本文へ戻し、追加分を足す |
| S-2 | `unsupported-kind` を t3 で投げるのに errors.ts への追加が t8 で、t3 の typecheck が通らない | errors.ts と errors.test.ts への追加を t3 へ移す |
| S-3 | spec.ts が tile_math を使うのに §3 の表が許していない | §3 の spec.ts の行に tile_math を足す |
| S-4 | t8 の d.ts の確かめに export でない `register`（static メンバ）が入り、必ず落ちる | 引数から外し、`static register(` を別に見る |
| S-5 | 旧 API の `ServeInput.request` が未定義で、requestWillFetch の要求が疑似ホストへ出る | 旧 API の request は `new Request(選んだミラーを展開した URL)`。プラグインが受けた request.url が上流の URL である試験 |
| S-6 | 新 API の登録が `map:` の Resource に合流しうる（以後捕捉されない） | t6 の合流候補から `map:` を除き、別 Resource ができる試験 |
| S-7 | golden の筋書きに §9 の既知の変化が入りうる | 既知の変化に当たる手は筋書きから外し legacy-changes.test.ts で見ると明記 |

### 水準 2 の必須（裁定）

| ID | 内容 | 裁定 |
|---|---|---|
| D1 | 資格情報の除去がクエリだけで、URL の userinfo（`user:pass@`）が id・templates・warnings に残る。明示 id も無検査 | userinfo を含む URL は登録時に拒否する（attribute-invalid）。明示 id は公開値であり資格情報を入れないことを契約に書く（検査はしない）。公開値に残らない試験 |
| D2 | controller が替わっても ping 成功の記憶が残る。失敗が 404 とネットワーク失敗だけ | 記憶は controller の実体ごとにし、controllerchange で捨てる。200 で正しい JSON（版あり）以外はすべて失敗扱いで記憶しない（fail-closed）。試験 |
| D3 | SourceInfo・SourceStats が完全な型宣言になっていない。d.ts の試験が名前しか見ない | 完全な interface として書き、d.ts は tsc で型を使う小さな確かめ（形の不一致で落ちる）にする |
| D4 | addPlugin の重複登録の契約が無い | 同じオブジェクトの 2 回目は無視（冪等）。試験 |
| D5 | sk. の検査が値の先頭だけで、`Bearer sk.…` や credentialParams 以外のクエリ値を見逃す | credentials の各値とテンプレートの全クエリ値について、`Bearer `／`Token ` などの前置きを剥がしてから `sk.` 始まりを拒否する。試験 |
| D6 | §6 の Entry なしの上流 HTTP 失敗が「そのまま」と「ヘッダを付ける」で矛盾 | 新 API は上流の status・statusText・本体を写した合成応答にヘッダを足す。旧 API の経路は golden に従う。§6 の表を直す |

- 水準 2 の推奨 5 件は採る（golden のヘッダはキー小文字・名前順・重複結合で正規化／resources は呼び出し時点の写し／d.ts と文書は m2 で入るメソッドだけにし将来の API は書かない／plugin の state はプラグインごと・要求ごと、addPlugin は以後の要求にだけ効く／SourceSpec の未対応 kind は文書に明記）
- 水準 1 の O は作者の判断。O2（持ち越しの中身）は進行役が state に書き写した

Ruling: 第 2 回の S 7 件と D1〜D6 は裁定案で反映する — 実装前の文書の変更で済む — 誤りなら計画が細かくなるだけ
Ruling: 明示 id は検査せず契約で縛る — 任意の文字列から資格情報を見分ける規則は作れない — 誤りなら利用者が id にトークンを入れたとき公開値に出る（利用者の責任）
