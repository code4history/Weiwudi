# m1 実行計画: 基礎固め（#32・#34・#33）

- 日付: 2026-11-02 / サイクル: weiwudi-vector-cache（軽い道）
- 仕様: `docs/superpowers/specs/2026-11-02-new-interface-spec.md`（以下「仕様」）
- BASE: `vector-cache`。各タスクは 1 PR で、`vector-cache` へ入れる
- 粒度: 1 タスク 1 PR。順に実行する（3 タスクとも `weiwudi_gw_logic.ts` か試験の基盤を触るので並行しない）

## 順序の理由

1. **t1（#32）を最初に置く。** オフラインの e2e はいまの実装に対して書く。t2・t3 は `weiwudi_gw_logic.ts` の書き換えなので、先に実ブラウザの安全網を張る
2. **t2（#34）を t3 より前にする。** 計算を抜くと差分が小さくなり、t3 の文面の置き換えが読みやすくなる。公開の挙動が変わらない順に進める
3. **t3（#33）は最後。** 公開の export が増えるのはここだけ。m2 の `/v2/*` はこの `WeiwudiError` と表の上に乗る

m2 へ渡すもの: 依存を持たない `tile_math.ts`（範囲判定・範囲取得が使う）、`errors.ts`（新コードを足す表）、ローカルの上流サーバと SW 停止の手順（フックの試験が使う）。

## 全タスク共通

**環境の準備（着手前に 1 回。PR にしない）**

作業場所の clone に `node_modules` は無い。install は次の手順で行う。`pnpm-workspace.yaml` は commit しない。

```
cd /Users/kochizufan/zcode/weiwudi-work/Weiwudi
cp ci/pnpm-workspace.ci.yaml pnpm-workspace.yaml
pnpm install --frozen-lockfile
rm pnpm-workspace.yaml
```

`--ignore-workspace` は付けない（lock の overrides が落ちる）。ディスクの残りが少ないので、install の前に `df -h` で 2 GB 以上の空きを確かめる。

**Playwright のブラウザ**: lock の `@playwright/test` は 1.64.0。`playwright install` を素で実行すると共有キャッシュの他の版が消える。必要な版が `~/Library/Caches/ms-playwright` に無いときだけ、`PLAYWRIGHT_SKIP_BROWSER_GC=1` を付けて chromium だけ入れる。

**試験のコマンド（合否判定に rtk を使わない）**

```
pnpm -C /Users/kochizufan/zcode/weiwudi-work/Weiwudi run test:unit
pnpm -C /Users/kochizufan/zcode/weiwudi-work/Weiwudi run typecheck
pnpm -C /Users/kochizufan/zcode/weiwudi-work/Weiwudi run build
pnpm -C /Users/kochizufan/zcode/weiwudi-work/Weiwudi exec playwright test --reporter=list
cd /Users/kochizufan/zcode/weiwudi-work/Weiwudi && node_modules/.bin/eslint "src/**/*.ts"
```

e2e は `/dist/weiwudi.es.js` と `/weiwudi-sw.js` を読むので、`build` の後に走らせる。

**`dist/` と `public/weiwudi-sw.js` は git で追跡されている。** タスクの PR には含めない（`git checkout -- dist public/weiwudi-sw.js` で戻す）。rebuild は合流時の `build: rebuild dist` でまとめる。

**全タスクの受け入れ条件に含むもの**: 上の 5 コマンドがすべて exit 0。`git diff --name-only <BASE>..` にタスクの対象外のファイルが無い。

**e2e の前提**: 既存の `tests/e2e/cache.spec.js` は `tile.openstreetmap.org` と `storage.googleapis.com` に依存するので、ネットワークが要る。新しい `offline.spec.js` は外部へ出ない。

---

## m1-t1: オフラインの e2e と、ローカルの上流サーバ（#32）

コミット種別: `test:`（版に影響しない）

### 対象ファイル

| ファイル | 操作 |
|---|---|
| `tests/e2e/fixtures/tile-server.mjs` | 新規 |
| `tests/e2e/fixtures/offline-sw.js` | 新規 |
| `tests/e2e/fixtures/offline-page.html` | 新規 |
| `tests/e2e/offline.spec.js` | 新規 |
| `playwright.config.js` | 変更 |

`src/` は触らない。既存の `tests/e2e/cache.spec.js` も触らない。

### 作るもの

**`tile-server.mjs`**: Node の `http` だけで書く（依存を足さない）。ポート 5174。

- `GET /tiles/{z}/{x}/{y}.png`: `content-type: image/png`・`access-control-allow-origin: *`・本体は `tile:{z}/{x}/{y}` の ASCII。受けた回数を数える
- `GET /__requests`: それまでの受信数を JSON の `{ "count": n }` で返す（CORS 付き）
- `GET /__health`: 200
- `GET /workbox/*`: 起動時に `copyWorkbox(<OS の一時ディレクトリ>)`（`scripts/vite-plugin-copy-workbox.mjs`）で写した一式を配る。`text/javascript`。**写し終えてから listen する**（`__health` が返れば揃っている）

**`offline-sw.js`**: 外部へ出ない SW。

```js
importScripts('http://localhost:5174/workbox/workbox-sw.js');
workbox.setConfig({ modulePathPrefix: 'http://localhost:5174/workbox/' });
importScripts('/weiwudi-sw.js');
```

workbox を `tile-server.mjs` から配るのは、開発サーバの `public/workbox/` に頼らないため。`public/workbox/` はプラグインが起動時に消して作り直すので、Vite の公開ファイル一覧と競合しうる。`playwright.config.js` の先頭で写す形も、設定ファイルが worker ごとに読み直されて走行中に消えるので採らない。

**`offline-page.html`**: `test-page.html` の縮小版。`/dist/weiwudi.es.js` を import し、`Weiwudi.registerSW('./offline-sw.js', { scope: '/tests/e2e/fixtures/' })` まで行って `window.Weiwudi` と `window.swReady = true` を置く。地図の登録は試験の側で行う。

**`playwright.config.js`**:

```js
// webServer を配列にして、既存の pnpm run dev に次を足す
{ command: 'node tests/e2e/fixtures/tile-server.mjs', url: 'http://localhost:5174/__health', reuseExistingServer: !process.env.CI }
```

**`offline.spec.js`**: 全テスト共通の準備は「`offline-page.html` を開く → `swReady` を待つ → `registerMap('offline_map', { type: 'xyz', width: 1024, height: 1024, url: 'http://localhost:5174/tiles/{z}/{x}/{y}.png' })`」。この地図は maxZoom 2、z=2 の x/y は 0〜3、totalTile 21。

オフラインにするのは `context.setOffline(true)`。Chromium では SW の `fetch` まで切れることを Playwright 1.62.1 で実測した（仕様 §2 の 7）。lock は 1.64.0 なので、テスト 1 で確かめる。

| # | テスト名（この文字列のまま） | 手順 | 期待 |
|---|---|---|---|
| 1 | `setOffline cuts the service worker network` | オフラインで未取得のタイル `2/1/1` を取り、`__requests` を別の経路（`request` フィクスチャ）で読む | ページへ 404。受信数が増えない |
| 2 | `serves a cached tile offline` | オンラインで `2/0/0` を取得 → オフライン → 再取得 | 200。本体 `tile:2/0/0` |
| 3 | `returns 404 for an uncached tile offline` | オフラインで `2/3/3` を取得 | 404 で完了する（止まらない） |
| 4 | `serves a stale tile offline after cacheTtl` | `cacheTtl: 1` の地図で `2/0/1` を取得 → 10 ms 待つ → オフライン → 再取得 | 200。本体 `tile:2/0/1` |
| 5 | `serves transparent png out of extent offline` | オフラインで `2/4/0` を取得 | 200・`image/png`・PNG の署名 |
| 6 | `returns 404 out of zoom offline` | オフラインで `3/0/0` を取得 | 404 |
| 7 | `serves every tile offline after fetchAll` | `fetchAll` の `finish` を待つ → オフライン → 21 枚すべて取得 → `stats()` | 全部 200。本体が座標と一致。`count` 21・`percent` 100 |
| 8 | `serves a cached tile after the service worker restarted offline` | `2/0/0` を取得 → オフライン → CDP の `ServiceWorker.enable`・`ServiceWorker.stopAllWorkers`（`context.newCDPSession(page)`）→ 再取得 | 200。本体 `tile:2/0/0` |
| 9 | `keeps the client api working offline` | オフラインで `stats()`・`clean()`・`stats()` | 例外なし。`clean` 後の `count` 0 |

テスト 8 は m2 のフック（SW 再起動の窓）の試験の雛形になる。

### 使うもの

- `Weiwudi.registerSW`・`registerMap`・`fetchAll`・`stats`・`clean`（公開 API のみ）
- `scripts/vite-plugin-copy-workbox.mjs` の `copyWorkbox`

### 試験コマンド

```
pnpm -C /Users/kochizufan/zcode/weiwudi-work/Weiwudi run build
pnpm -C /Users/kochizufan/zcode/weiwudi-work/Weiwudi exec playwright test tests/e2e/offline.spec.js --reporter=list
```

### 受け入れ条件

- 上のコマンドが exit 0 で、9 テストすべて passed（`--reporter=json` の `stats.expected` が 9、`stats.unexpected` が 0）
- `git diff --name-only <BASE>..` が上の表の 5 ファイルだけ
- `tests/e2e/offline.spec.js` と `offline-sw.js` に外部ホストの文字列が無い: `grep -c 'https://' tests/e2e/offline.spec.js tests/e2e/fixtures/offline-sw.js tests/e2e/fixtures/offline-page.html` がいずれも 0
- テスト 1 が通らない（`setOffline` が SW に効かない）ときの代替: `tile-server.mjs` を試験の途中で閉じて上流を落とす。その場合は Ruling を残し、テスト名はそのままにする

---

## m1-t2: 座標・タイル計算の分離（#34）

コミット種別: `refactor:`（版に影響しない。公開の挙動は変わらない）

### 対象ファイル

| ファイル | 操作 |
|---|---|
| `src/tile_math.ts` | 新規 |
| `tests/unit/tile-math.test.ts` | 新規 |
| `src/weiwudi_gw_logic.ts` | 変更（計算を差し替えるだけ） |

### 作るもの

`src/tile_math.ts`。依存なしの純粋関数だけ。DOM・SW の型を使わない。

```ts
export interface TileBox { minX: number; maxX: number; minY: number; maxY: number }

export const MERC_MAX: number;
export const lngToMercX: (lng: number) => number;
export const latToMercY: (lat: number) => number;

/** 経緯度の範囲 → zoom でのタイル範囲。現行の wmts の丸めと同じ（:677-680） */
export const lngLatBoundsToTileBox: (
  b: { minLng: number; maxLng: number; minLat: number; maxLat: number }, zoom: number
) => TileBox;

/** maxZoom での範囲を z へ縮める。現行の :413-417・:530-534・:691-696 の 3 か所の統合 */
export const scaleTileBox: (box: TileBox, maxZoom: number, z: number) => TileBox;

export const isInTileBox: (box: TileBox, x: number, y: number) => boolean;

/** minZoom〜maxZoom の総タイル数。現行の :690-698 */
export const countTiles: (box: TileBox, minZoom: number, maxZoom: number) => number;

/** z 昇順 → x 昇順 → y 昇順。配列を作らない生成器。現行の :529-540 の順序を保つ */
export function enumerateTiles(box: TileBox, minZoom: number, maxZoom: number): Generator<[z: number, x: number, y: number]>;

/** ピクセル寸法の地図の maxZoom。現行の :653-654 */
export const maxZoomForPixelSize: (width: number, height: number, tileSize: number) => number;
export const pixelSizeToTileBox: (width: number, height: number, tileSize: number) => TileBox;

/** {z}{x}{y}{-y} の展開。現行の :78-84。各字句は最初の 1 回だけ置換する（String.replace のまま） */
export const expandTileTemplate: (template: string, z: number, x: number, y: number) => string;
```

名前と形は仕様 §7.2 と §5 の利用に合わせてある（m2 の範囲判定・m4 の範囲取得がこのまま使う）。

`weiwudi_gw_logic.ts` の置き換え:

| 行 | 現在 | 置き換え先 |
|---|---|---|
| 64 | `MERC_MAX` | 削除 |
| 78-84 | `extractTemplate` | `expandTileTemplate` |
| 413-418 | 範囲判定 | `scaleTileBox`＋`isInTileBox` |
| 529-540 | `allTasks` の生成 | `[...enumerateTiles(…)]`（配列のままでよい。生成器へ変えるのは m4） |
| 653-659 | xyz の計算 | `maxZoomForPixelSize`＋`pixelSizeToTileBox` |
| 664-680 | wmts の計算 | `lngLatBoundsToTileBox` |
| 689-699 | `totalTile` | `countTiles` |

**現行の癖を直さない。** `(setting.minX || 0)` の既定、`query.maxZoom` が無い wmts で `NaN` になる動き（`Math.pow(2, undefined)`）、`lat2MercY(90)` の `Infinity` はそのまま残す。`|| 0` は呼び出し側に残す。`tile_math` が丸めるのは m4 の `bounds` の入口だけで、それは別の関数にする。

`b64toBlob`・`percent` の計算（:566・:751）はタイル計算ではないので動かさない。`Math.random` の `:449` も同様。

### 使うもの

なし（土台のタスク）。t1 の e2e が実ブラウザの回帰検知になる。

### 試験

`tests/unit/tile-math.test.ts`。**期待値は現行の式で計算した値を書く**（新しい実装から書き写さない）。最低限:

- `lngLatBoundsToTileBox`: `tests/unit/weiwudi-gw-logic.test.ts` の `WMTS_ADD` と同じ入力（139.7〜139.8・35.6〜35.7・maxZoom 12）で、既存試験の期待値と一致
- `scaleTileBox`: maxZoom 2・`{0,3,0,3}` → z=0 で `{0,0,0,0}`、z=1 で `{0,1,0,1}`、z=2 で不変
- `countTiles`: 1024×1024（tileSize 256）→ 21。1000×500 → 11
- `enumerateTiles`: 順序が z→x→y。件数が `countTiles` と一致。最初の値を取って止めても残りを計算しない（巨大な範囲で即座に返る）
- `maxZoomForPixelSize`: 1000×500 → 2
- `expandTileTemplate`: `{-y}` の反転、字句が 2 回あるときに 2 回目を残すこと

### 受け入れ条件

- `pnpm -C <clone> run test:unit` が exit 0
- `tests/unit/weiwudi-gw-logic.test.ts` と `tests/unit/add-cachemaxbytes.test.ts` に差分が無い（`git diff --quiet <BASE>.. -- tests/unit/weiwudi-gw-logic.test.ts tests/unit/add-cachemaxbytes.test.ts` が exit 0）
- `src/tile_math.ts` が import を持たない: `grep -c '^import' src/tile_math.ts` が 0
- 直書きが残っていない: `grep -c 'Math.pow(2' src/weiwudi_gw_logic.ts` が 0、`grep -c 'MERC_MAX' src/weiwudi_gw_logic.ts` が 0
- `weiwudi_gw_logic.ts` の行数が減っている: `wc -l` が 803 未満
- `offline.spec.js` が全部 passed

---

## m1-t3: エラーの具体化（#33）

コミット種別: `feat:`（`WeiwudiError` の追加。minor）

**旧 API の reject は文字列のまま、1 字も変えない**（仕様 §9）。`Error` への置き換えはしない。

### 対象ファイル

| ファイル | 操作 |
|---|---|
| `src/errors.ts` | 新規 |
| `tests/unit/errors.test.ts` | 新規 |
| `src/weiwudi_gw_logic.ts` | 変更 |
| `src/weiwudi.ts` | 変更 |
| `vite.config.lib.js` | 変更（`dts` の `include` に `src/errors.ts` を足す） |
| `tests/unit/weiwudi-gw-logic.test.ts` | 追記のみ |
| `docs/api/weiwudi.md`・`docs/api/weiwudi.ja.md`・`README.md`・`README.ja.md` | 変更（rule-0001） |

`vite.config.lib.js` を直さないと `dist/weiwudi.d.ts` の `./errors` の参照が宙に浮く。

### 作るもの

`src/errors.ts`。依存なし。ページと SW の両方が import する。

```ts
export type WeiwudiErrorCode =
  | 'sw-unsupported' | 'sw-register-failed' | 'sw-not-controlling' | 'sw-not-implemented'
  | 'map-id-required' | 'instance-released'
  | 'attribute-missing' | 'attribute-invalid' | 'unknown-type'
  | 'map-not-found' | 'map-busy' | 'no-fetch-process' | 'cache-path-invalid'
  | 'cannot-fetch-all' | 'fetch-busy' | 'api-not-found'
  | 'db-blocked' | 'quota' | 'network' | 'upstream' | 'storage' | 'internal';

export type TileFailure = 'network' | 'upstream' | 'quota' | 'storage';

export class WeiwudiError extends Error {
  readonly code: WeiwudiErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: WeiwudiErrorCode, message: string, detail?: Record<string, unknown>);
  /** 文字列・Error・その他から作る。WeiwudiError はそのまま返す */
  static from(value: unknown): WeiwudiError;
}

/** 旧 API の文面の唯一の出どころ */
export const legacyMessage: (code: WeiwudiErrorCode, params?: Record<string, string | number>) => string;
```

表（`code`・文面・`from` の照合）を 1 か所に持つ。現行の文面をそのまま写す。

| code | 文面 | 現在の場所 |
|---|---|---|
| `sw-unsupported` | `Error: Service worker is not supported` | `weiwudi.ts:80` |
| `sw-register-failed` | `Error: Service worker registration failed with ${error}` | `:86` |
| `sw-not-controlling` | `Error: Service worker did not control this page within 10000 ms` | `:117` |
| `sw-not-implemented` | `Weiwudi service worker is not implemented.` | `:153`・`:180`・`:193` |
| `map-id-required` | `MapID is necessary.` | `:204` |
| `instance-released` | `This instance is already released.` | `:222` |
| `attribute-missing` | `Error: Attribute "${target}" is missing` | `gw_logic:607` |
| `attribute-invalid` | `Error: Attribute "cacheMaxBytes" is not a valid non-negative integer` | `:642` |
| `unknown-type` | `Error: Unknown "type" value` | `:685` |
| `map-not-found` | `Error: MapID "${mapID}" not found` | `:408`・`:621`・`:745`・`:775` |
| `map-busy` | `Error: ${mapID} is under fetching process. Please cancel it first` | `:713`・`:723` |
| `no-fetch-process` | `Error: There are no fetching process of ${mapID}` | `:737` |
| `cache-path-invalid` | `Error: "cache" api needs mapID, zoom, x, y settings` | `:766` |
| `cannot-fetch-all` | `Error: Map "${mapID}" cannot fetch all tiles` | `:776` |
| `fetch-busy` | `Error: Another fetching process is running: "${mapID}" (${count} / ${total})` | `:778` |
| `api-not-found` | `Error: API ${apiName} not found` | `:794` |

`:797` の包括の `Error: ${e}` は文面を変えない。`from` は `Error: ` の後ろの例外名で分類する。

| 文字列・例外 | code |
|---|---|
| `QuotaExceededError` | `quota` |
| `BlockedError` | `db-blocked` |
| それ以外 | `internal` |

`from` が文字列を受けたら、表を上から照合し、当たれば `detail` に差し込み値を入れる。当たらなければ `internal`。文字列でも Error でもない値は `String(value)` で `internal`。

**`weiwudi_gw_logic.ts`**:

- 上の表の文字列リテラルを `legacyMessage(…)` へ置き換える。`getImage` の `Error:` も同じ
- タイルの応答に `x-weiwudi-error` を足す。文面は変えない:

| 場面（`getImage`） | 応答 | ヘッダの値 |
|---|---|---|
| `fetch` の例外・保存なし（:492-499） | 404（現行） | `network` |
| `fetch` の例外・保存あり | 200（現行）・古い本体 | `network` |
| `resp.ok` でない・保存なし（:483-488） | 上流の状態（現行） | `upstream` |
| `resp.ok` でない・保存あり | 200（現行）・古い本体 | `upstream` |
| 保存の失敗（:475）・`QuotaExceededError` | 200 | `quota` |
| 保存の失敗・それ以外 | 200 | `storage` |

`cached.headers` を書き換えない（複製に足す）。

- `FetchAllBlocker` に `failures: Record<TileFailure, number>` を足す。`proceed`・`finish` に `errors: failures`、`stop` に `code: WeiwudiError.from(e).code` を足す。既存の項目（`error`・`reason` など）は変えない

**`weiwudi.ts`**:

- `export { WeiwudiError, type WeiwudiErrorCode, type TileFailure } from './errors'`
- `throw ('…')` のリテラルを `throw (legacyMessage(…))` にする。**投げるものは文字列のまま**。`throw (text)` はそのまま

### 使うもの

- t1 の `offline.spec.js`（`x-weiwudi-error` の確認を足さない。単体で見る）
- t2 の後の `weiwudi_gw_logic.ts`（行番号はずれるので、文字列で探す）

### 試験

`tests/unit/errors.test.ts`:

- 全 code について `WeiwudiError.from(legacyMessage(code, 例)).code === code`（往復）。`it.each` で表の全行
- 差し込み値が `detail` に入る（`map-not-found` → `{ mapID: 'x' }`）
- `Error: QuotaExceededError: …` → `quota`。`Error: BlockedError: …` → `db-blocked`。`Error: Foo` → `internal`
- `DOMException('…', 'QuotaExceededError')` → `quota`
- `WeiwudiError` を渡すと同じものが返る。`new WeiwudiError(…) instanceof Error`
- 文面の固定: 表の全行について `legacyMessage` の結果が文字列の直書きと一致（ここだけ直書きする）

`tests/unit/weiwudi-gw-logic.test.ts` に追記:

- `fetch` 例外・保存なし → 404・`x-weiwudi-error: network`
- `fetch` 例外・保存あり → 200・`network`
- 上流 500・保存なし → 500・`upstream`
- `IDBObjectStore.put` が `QuotaExceededError` → 200・`quota`
- `fetchAll` の `finish` に `errors` が入る

### 受け入れ条件

- `pnpm -C <clone> run test:unit` が exit 0
- 既存の試験を変えていない: `git diff --numstat <BASE>.. -- tests/unit/weiwudi-gw-logic.test.ts` の削除数が 0、`tests/unit/add-cachemaxbytes.test.ts` に差分なし
- 文字列リテラルの throw が残っていない: `grep -c "throw ('" src/weiwudi.ts` が 0、`grep -c 'throw (`' src/weiwudi.ts` が 0
- `gw_logic` に文面の直書きが残っていない: `grep -c 'retVal = .Error: ' src/weiwudi_gw_logic.ts` の結果が 1（包括の `:797` だけ）
- `pnpm -C <clone> run build` の後、`dist/errors.d.ts` がある。`grep -c 'WeiwudiError' dist/weiwudi.d.ts` が 1 以上
- `offline.spec.js` が全部 passed
- `docs/api/weiwudi.md` と `.ja.md` に `WeiwudiError.from` の節と code の表があり、「reject は文字列のまま」と書いてある: `grep -c 'WeiwudiError.from' docs/api/weiwudi.md docs/api/weiwudi.ja.md` がいずれも 1 以上

---

## m1 の区切りで確かめること

- #32・#33・#34 の完了条件を PR の本文で 1 件ずつ対応付ける（`Closes` は `vector-cache` では効かないので、Issue を閉じるのは master への合流時。PR 本文には `Refs #32` と書く）
- 軽い道 §6 の全体のレビュー・セキュリティ点検・要約
- state の更新は進行役が行う: m1 の `plan` にこの文書のパス、仕様 §16 の里程の題名の変更
