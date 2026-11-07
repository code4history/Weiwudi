# Range 要求のブロック単位キャッシュ（#78）設計の下書き

- 日付: 2026-11-07 / サイクル: weiwudi-vector-cache（軽い道）/ 位置: m4 の後に着手する独立の里程（#78 の「進め方」）
- 対象 Issue: #78（Range 要求（PMTiles・COG）を区画単位でキャッシュする）
- 親の仕様: `docs/superpowers/specs/2026-11-02-new-interface-spec.md`（以下「仕様」）。本書は仕様 §11 の「Range 要求は本サイクルの対象外」を置き換える追補であり、仕様の他の節の決定は変えない
- 起点: `vector-cache` の `c5712bf`（m3-t9 まで合流）。前提として m3-t10 で `EntryBody` の本体が `Blob` から `ArrayBuffer` に替わる（WebKit の IndexedDB は Blob を保存できない）。本書はブロックの本体を `ArrayBuffer` で書く
- 本書は**下書き**である。実装は走らせていない。「確かめた事実」は一次資料を読んだもの、Ruling は本書の設計担当が決めたもの。実装中に変えるときは台帳に Ruling を残し、本書を直す
- 用語: Issue の「区画」と本書の「ブロック」は同じもの。API の名前は `block`

## 1. 要約

| 問い | 決定 |
|---|---|
| 何を保存するか | ファイルを固定長の**ブロック**（既定 64 KiB）に切り、ブロック 1 つを Entry 1 件として保存する。Range 要求は手元のブロックから 206 を組み立て、足りないブロックだけを上流へ取りに行く |
| 対象 | `kind: 'asset'` に `range: 'block'` を付けた登録（PMTiles・COG のような「1 つの大きなファイルを Range で読む」形式）。既定（`range: 'passthrough'`）は今の素通しのまま |
| キー | `<resourceId>\0<rest>\0b\0<版>\0<ブロック番号 12 桁>`。版は `ETag`（無ければ `Last-Modified`、どちらも無ければ `-`）。ファイルの頭（版・全長・ヘッダ・鮮度）は `ResourceMeta.rangeFiles[rest]` に持つ |
| 応答 | 単一の Range は 206＋`Content-Range`。複数範囲（`bytes=a-b,c-d`）と末尾範囲（`bytes=-N`）は素通し（保存しない）。Range の無い GET はブロックを全部そろえて 200 |
| 上流 | 足りないブロックの連続する並びを 1 本の `Range: bytes=…` にまとめる。複数範囲の要求は出さない（preflight と multipart を避ける）。条件付き要求（`If-Range` など）は出さない |
| 鮮度 | ファイル単位（`rangeFiles[rest].fetchedAt`）。TTL 内は上流に触らない。TTL を過ぎたら要求された範囲を取り直し、版が同じなら `refresh`、違えば新しい版に切り替えて古いブロックを消す。`Request.cache` が `reload`・`no-cache` の要求は hit を飛ばす（pmtiles.js の ETag 不一致の回復のため） |
| 容量と退避 | ブロックは普通の Entry なので `cacheMaxBytes`（LRU）・`cacheRetention`・固定・全体上限がそのまま効く |
| 旧 API | 関係しない。旧 API（`/api/cache`）の Range は素通しのまま（仕様 §9） |
| 実装の分け方 | M1 ブロックキャッシュ（見ながら保存）→ M2 PMTiles の範囲取得 → M3 COG の範囲取得と `pmtiles://` のスタイル |

## 2. 確かめた事実（2026-11-07）

一次資料を読んで確かめたもの。記憶で書いた箇所は無い。

### 2.1 HTTP（RFC 9110。`https://www.rfc-editor.org/rfc/rfc9110.html`）

| # | 事実 | 節 |
|---|---|---|
| H1 | `Range: bytes=first-last`（両端を含む）。`last` が無いか全長以上なら「残り全部」と読み替える。`bytes=-N` は末尾 N バイト。複数範囲は `,` 区切り | 14.1.1・14.1.2 |
| H2 | サーバは Range を**無視してよい**（200 で全体を返してよい）。不正・重なりの多い・小さすぎる多数の範囲は無視か拒否（416）してよい。GET 以外では無視しなければならない | 14.2 |
| H3 | 206 の単一部分は `Content-Range: bytes a-b/全長` が必須。全長が分からなければ `*`。複数部分は `multipart/byteranges` が必須で、ヘッダ部には `Content-Range` を置いてはならない。**単一範囲の要求に multipart で返してはならない**。複数範囲の要求に対しては、重なる範囲や隙間の小さい範囲をまとめてよく、残りが 1 つなら単一部分で返してよい。要求の一部だけを返してもよい（「a server might want to send only a subset」）。クライアントは 206 の `Content-Type`・`Content-Range` を見て追加の要求が要るかを判断しなければならない | 14.4・15.3.7・15.3.7.1・15.3.7.2 |
| H4 | 206 は、200 なら付けていた `Date`・`Cache-Control`・`ETag`・`Expires`・`Content-Location`・`Vary` を付けなければならない | 15.3.7 |
| H5 | 複数の部分応答を結合してよいのは**同じ強い検証子**を持つときだけ | 15.3.7.3 |
| H6 | 416 は `Content-Range: bytes */全長` を付けるべき（SHOULD） | 15.5.17・14.4 |
| H7 | `If-Range` は Range 要求にだけ付く。値は強い `ETag` か、強い検証子である `Last-Modified`。一致しなければ受け手は Range を無視して全体を返す。弱い ETag は使ってはならない | 13.1.5 |
| H8 | `Accept-Ranges: bytes` は助言であり、無くても Range を出してよく、有っても次が 206 とは限らない | 14.3 |

### 2.2 Fetch 標準（`https://fetch.spec.whatwg.org/`）

| # | 事実 |
|---|---|
| F1 | 要求ヘッダ `Range` は、値が**単一の範囲**（`bytes=N-M` か `bytes=N-`）のときだけ CORS-safelisted。`bytes=-500` と複数範囲は safelist 外で、別オリジンでは preflight になる |
| F2 | CORS-safelisted な応答ヘッダは `Cache-Control`・`Content-Language`・`Content-Length`・`Content-Type`・`Expires`・`Last-Modified`・`Pragma` だけ。**`ETag`・`Content-Range`・`Accept-Ranges` は、サーバが `Access-Control-Expose-Headers` で公開しないと別オリジンの応答から読めない** |

F2 は SW にも当たる。SW が `mode: 'cors'` で取った応答から `ETag`・`Content-Range` を読めるかはサーバの設定に依る。ページから直接取る場合と同じ制約なので、Weiwudi が入ることで悪化はしない。

### 2.3 pmtiles.js 4.5.0（`protomaps/PMTiles` の `js/src/index.ts`・`js/src/adapters.ts`）

| # | 事実 | 場所 |
|---|---|---|
| P1 | `FetchSource.getBytes(offset, length)` は `Range: bytes=offset-(offset+length-1)` の**単一範囲**を `fetch(url, { signal, cache, headers, credentials })` で出す。`mode` は指定しない（既定 `cors`）。クエリ項目は足さない | `index.ts` :387-424 |
| P2 | ヘッダとルートディレクトリは `getBytes(0, 16384)` で読む（ヘッダは先頭 127 バイト）。葉ディレクトリとタイルは `getBytes(offset, length, signal, header.etag)` | :221・:586・:621 |
| P3 | `offset === 0` で 416 が返ったら `Content-Range: bytes */N` の N を読み、`bytes=0-(N-1)` で 1 回取り直す（16 KiB より小さいアーカイブのため） | :426-439 |
| P4 | 応答の `Etag` を読む。`W/` で始まる弱い ETag は捨てる。渡された `etag` と違えば `EtagMismatch` を投げ、以後の要求を `cache: 'reload'` にする。416 も `EtagMismatch` | :441-453 |
| P5 | Windows の Chromium 系では常に `cache: 'no-store'`（ブラウザの不具合の回避） | :368-373・:414-415 |
| P6 | 200 が返ったとき、`Content-Length` が無いか要求より大きければ「Byte Serving 非対応」として失敗にする（200 を受けるのは `Content-Length <= length` のときだけ） | :460-466 |
| P7 | 応答から `Etag`・`Cache-Control`・`Expires` を読んで返す | :468-474 |
| P8 | `If-Match` は送らない（ブラウザキャッシュを無効にし、preflight と CORS 設定が要るため）。「CORS 設定で ETag を公開すべき」と注記 | :405-410 |
| P9 | MapLibre の `Protocol` は `pmtiles://https://…` の `https://…` で `new PMTiles(url)` を作り、`getZxy(z, x, y, signal)` で読む。要求はページ（メインスレッド）から出る | `adapters.ts` :196-264 |

### 2.4 geotiff.js 3.1.0（`geotiffjs/geotiff.js` の `src/source/remote.js`・`blockedsource.js`・`httputils.js`）

| # | 事実 | 場所 |
|---|---|---|
| G1 | `BlockedSource` の既定は `blockSize = 65536`・`cacheSize = 100`。要るブロックを番号順に並べ、**連続するブロックを 1 つの `fetchSlice`（単一範囲）にまとめる** | `blockedsource.js` :48・:219-249 |
| G2 | `fetchSlice` は `Range: bytes=offset-(offset+length-1)`。206 なら本体を使い `content-range` の全長を `fileSize` に記録（読めなければ `null`）。200 は `allowFullFile`（既定 `false`）でなければ失敗 | `remote.js` :131-168 |
| G3 | 複数範囲（`bytes=a-b,c-d`）を出すのは `maxRanges > 0` のときだけ（既定 0）。応答が `multipart/byteranges` なら分解し、**単一部分の 206 なら最初の範囲として受け取り、残りを個別に取り直す** | `remote.js` :43-129 |
| G4 | `Content-Range` の解析は `bytes (\d+)-(\d+)/(\d+)` の正規表現。全長が `*` なら `fileSize` は `null` | `httputils.js` :59-67 |

### 2.5 Weiwudi の今の実装（起点 `c5712bf`）

| # | 事実 | 場所 |
|---|---|---|
| W1 | `Range` ヘッダ付きの要求は照合しても `serve()` に入れず `core.passThrough` で素通し。`serve()` 自身にも同じ守りがある | `src/hook.ts` :350-352・`src/core.ts` :311-312 |
| W2 | `upstream.ts` は上流へ出す前に `if-none-match`・`if-modified-since`・`if-match`・`if-unmodified-since`・**`if-range`** を落とす。`Range` は落とさない。`rebuild()` は `Request.cache` を写さない | `src/upstream.ts` :28・:103-118 |
| W3 | `type: 'data'`（`kind: 'asset'`）のテンプレートは字句を持てない。Entry のキーは `<resourceId>\0<残りのクエリ>`（残りのクエリが無ければ `<resourceId>\0`） | `src/url_pattern.ts` :52-63・:445-456 |
| W4 | グリフは fontstack ごとの 1 レコードに部分（`parts`）を束ね、再生は本体の `slice`。保存は 1 tx で既存の本体を読み、残す部分と新しい部分から本体を作り直す。「部分ごとに持つ」前例 | `src/store.ts` :85-101・:608-650・`src/core.ts` :352-371 |
| W5 | `patchResource` は 1 tx で読み・直し・書き、`count`・`bytes`・`pinnedBytes` を保存済みの値のまま保つ。registry の `recompose` は `...m` で未知の項目を引き継ぐ | `src/store.ts` :562-571・`src/registry.ts` :301-305 |
| W6 | `putEntry` の退避は要素ごとに `[resourceId, 0]` の `getAll` で候補を全部読む（m2-t2 水準 1 Minor 1。m4 へ申し送り済み） | `src/store.ts` :485-501 |
| W7 | `isCandidate` は GET・`navigate` でない・`destination` が `''` か `'image'`。HEAD は候補にならない | `src/hook.ts` :46-47 |

## 3. 目的

PMTiles・COG のように「大きなファイル 1 つを Range で部分的に読む」形式を、Weiwudi でオフラインに持ち出せるようにする。仕様 §11 のとおり今は Range を素通ししており、オンラインで読めてもオフラインでは使えない。ファイルの中の 1 タイルは 1 つのバイト範囲なので、範囲をブロックに丸めて保存すれば、Entry を単位に記録する Weiwudi の土台（`cacheMaxBytes`・`cacheRetention`・固定・統計）にそのまま載る（#78 の案）。

## 4. 対象と非対象

### 4.1 対象

- `kind: 'asset'` の登録に `range: 'block'` を付けたもの（§13）。ファイルの形式は問わない。PMTiles（pmtiles.js 経由）と COG（geotiff.js 経由）を第一の利用経路とする
- 単一範囲の Range 要求（`bytes=N-M`・`bytes=N-`）。pmtiles.js（P1）と geotiff.js の `BlockedSource`（G1・G2）はどちらも単一範囲しか出さない
- Range の無い GET（同じ URL をファイル全体として読む要求。§8.3）
- 上流が Range を無視して 200 を返すサーバ（H2）。全体を受けてブロックに切って保存し、ページには 206 を返す（pmtiles.js と geotiff.js はこの変換で動くようになる。P6・G2）

### 4.2 非対象

| 外すもの | 理由 | 扱い |
|---|---|---|
| 複数範囲の要求（`bytes=a-b,c-d`） | 別オリジンでは preflight になる（F1）。応答は `multipart/byteranges` の生成が要る（H3）。geotiff.js の既定（`maxRanges = 0`）は出さない（G3） | 今のまま素通し（保存しない）。Ruling R5 |
| 末尾範囲（`bytes=-N`） | safelist 外（F1）。どちらの読み手も出さない | 素通し。全長が分かっていても変換しない（R5） |
| GET 以外（HEAD） | 候補にならない（W7）。Range は GET にだけ定義される（H2） | 触らない |
| `range: 'block'` 以外の Resource の Range 要求 | 仕様 §11 のまま。タイル・グリフ・スタイルへの Range は想定しない | 素通し |
| `kind: 'raster' | 'vector' | 'style'` への `range` | 対象の形式ではない | `attribute-invalid` |
| 差し込み口（§8）の `cacheWillUpdate`・`cachedResponseWillBeUsed` | ブロックは 1 要求 N Entry で、プラグインの契約（1 要求 1 応答）に合わない | M1 では範囲の経路に差し込み口を当てない（R12）。`requestWillFetch` 等も当てない |
| 複数の部分応答の `multipart/byteranges` の生成 | H3 の義務を負うより素通しが安全 | 作らない |
| COG の投影（EPSG）変換 | Weiwudi の `RangeSpec` は WGS84 の `bounds` かピクセルの `box`。COG の座標系は多様 | M3 で `box` と EPSG:3857・4326 に限る（§16） |

## 5. ブロックの単位と大きさ

- ブロック番号 `n` はバイト範囲 `[n·B, (n+1)·B − 1]`。`B` はその Resource の `blockBytes`。最後のブロックは短い（全長 − n·B）
- **既定 `B = 65536`**（64 KiB）。geotiff.js の `BlockedSource` の既定（G1）と同じで、要求のブロック境界が一致する。pmtiles.js のヘッダ読み（0〜16383。P2）は 1 ブロックに収まる
- 登録で `blockBytes` を変えられる。2 の冪で 4096（4 KiB）〜4194304（4 MiB）。外れたら `attribute-invalid`。ラスタ PMTiles（タイルが数百 KiB）では大きめ、ベクタでは既定、が目安（README に書く）
- `blockBytes` は Resource に固定する（`ResourceMeta.range.blockBytes`）。同じ URL に違う `blockBytes` や `range: 'passthrough'` で登録すると `resource-conflict`（§15。キーの形が変わるため。仕様 §5.6 の `scheme` の違いと同じ扱い）
- 1 要求が触るブロックは「開始バイトのブロック〜終了バイトのブロック」。要求の長さが `rangeMaxBytes`（既定 32 MiB、登録で変えられる）を超える要求は素通し（保存しない）。大きな組み立てでメモリを使い切らないため（R6）

## 6. キーの形

```
key = <resourceId> + '\0' + <rest> + '\0' + 'b' + '\0' + <version> + '\0' + <index>
```

| 部分 | 内容 |
|---|---|
| `resourceId` | 仕様 §5.1 のまま |
| `rest` | 仕様 §5.3 の `data` の suffix（残りのクエリ。無ければ空）。`type: 'data'` のテンプレートは字句を持たない（W3）ので、同じ Resource の中でファイルを区別するのは `rest` だけ。ミラーは同じ `rest` に落ちる |
| `'b'` | ブロックの印。`rest` の後に `\0b\0` が来るので、ファイル全体のキー `<resourceId>\0<rest>` とは衝突しない（`rest` はクエリ文字列で `\0` を含まない） |
| `version` | 版（§10）。`\0` と制御文字を `_` に置き換え、128 文字で切る。版が無いときは `-` |
| `index` | ブロック番号を 10 進 12 桁で 0 詰め。キーの昇順がバイト順になるので、連続するブロックを `IDBKeyRange.bound(key(a), key(b))` 1 回の `getAll` で読める（4 MiB × 10¹² で足りる） |

- 1 つの Resource の Entry は今までどおり `IDBKeyRange.bound(id + '\0', id + '\x01', false, true)` に収まる（仕様 §5.4）。`deleteResource`・`clearEntries`・`removeResource` は変えずに効く
- 1 つのファイルの 1 つの版のブロック群は接頭辞 `<resourceId>\0<rest>\0b\0<version>\0` の範囲。版の切り替え（§10）でこの範囲を消す
- `EntryMeta` には `z`・`x`・`y` を入れず、項目も足さない。ブロック番号はキーの `index` から読める（範囲の解放（M2）はキーの接頭辞と番号の範囲で引く）

### 6.1 ファイルの頭（`rangeFiles`）

ファイル単位の状態は `ResourceMeta` に持つ（Entry にしない。R2）。

```ts
export interface RangeFileHead {
  version: string;            // ETag（優先）か Last-Modified、無ければ '-'。キーの <version> と同じ文字列
  total?: number;             // 全長。Content-Range の complete-length か、短い本体で末尾が分かったとき。不明なら無し
  headers: Record<string, string>;   // 200 なら付くヘッダ（content-type・etag・last-modified・cache-control・expires・accept-ranges 等）。
                                     // 4 ヘッダ（§6 の落とすもの）と content-range・x-weiwudi-* は入れない
  fetchedAt: number;          // 上流で版を確かめた最新の時刻（鮮度。§10）
}

// ResourceMeta に足す
range?: { blockBytes: number; maxBytes: number };   // 無ければ passthrough（今の挙動）
rangeFiles?: Record<string, RangeFileHead>;          // rest → 頭。範囲の経路だけが patchResource で書く
```

- 読み書きは `store.patchResource`（W5）。`count`・`bytes` は store が守り、registry の `recompose` は `...m` で引き継ぐ（W5）
- 1 つの Resource に持てるファイルは 16 まで。17 個目以降の `rest` は素通し（保存しない。`console.warn` を 1 回）。`type: 'data'` の `rest` は普通は空なので当たらない。クエリで版を付け替える配信（`?v=2`）がこの上限を踏むが、その場合は版ごとに別ファイルとして正しい（R3）

## 7. 配信の決定（範囲の経路）

照合ルート・門番は、Resource に `range` があるとき（`range: 'block'`）だけ `range.serveRange()` へ渡す。それ以外は今のまま（`Range` 付きは `passThrough`、無ければ `core.serve`）。`serveRange` は仕様 §6 の表と同じ 7 つの `x-weiwudi-status` と 4 つの `x-weiwudi-error` を使う（値を増やさない）。

### 7.1 要求の分類

| 要求 | 扱い |
|---|---|
| `Range: bytes=N-M`・`bytes=N-`（単一範囲。空白は許す） | ブロックの経路（下） |
| 複数範囲・末尾範囲・読めない Range（`bytes=` 以外の単位を含む） | 素通し（`core.passThrough`）。保存しない。R5 |
| Range なし GET | ファイル全体として扱う。§8.3 |
| 要求の長さ（M − N + 1）が `range.maxBytes` を超える | 素通し |
| `Request.cache` が `reload`・`no-cache` | ブロックの経路だが hit を飛ばす（§10.3。R8） |
| 認証付き（仕様 §4.6）で `policy.store` が偽 | 上流へそのまま。保存しない。組み立てもしない（§12） |

### 7.2 ブロックの経路（単一範囲）

1. `rest` と `head = rangeFiles[rest]` を読む。全長が分かれば（`head.total`）`M` を `min(M, total − 1)` に丸め、`N >= total` なら 416 を合成（`Content-Range: bytes */total`。H6。保存も上流も無し。`x-weiwudi-status: out-of-range`）
2. 必要なブロック番号 `[n0, n1]` を求める（`n0 = floor(N / B)`、`n1 = floor(M / B)`。`M` が無く全長も不明なら `n1` は未定で、上流の応答で決まる）
3. **hit**: `head` があり、`now − head.fetchedAt <= cacheTtl` で、`cache` が `reload`・`no-cache` でなく、現在の版のブロック `n0..n1` が全部ある（`getAll` 1 回。削除期限を過ぎたブロックは「無いもの」）→ 206 を組み立てて返す（`hit`）。`touch` はブロックごとに呼び、完了は待たない
4. それ以外は上流へ。取るのは
   - TTL 内で一部のブロックが欠けているとき: **欠けているブロックの連続する並びごとに 1 本**の `Range: bytes=a·B-((b+1)·B−1)`（全長が分かれば末尾を丸める）。同じブロックが進行中（`ctx.inflight`）なら取らずに待つ
   - TTL を過ぎたとき、または `reload`・`no-cache`: 手元の有無にかかわらず**要求された範囲を覆うブロック `n0..n1` 全部**を 1 本で取る（版の確認を兼ねる。§10）
5. 上流の応答を §9 の規則で読む。版が `head.version` と違えば §10.2 の切り替えを行い、手元のブロックは使わず、`n0..n1` を取り直して組み立てる（1 回だけ。2 度目も違えば `upstream-error`）
6. 取れたブロックを保存する（§11）。保存の失敗は配信を止めず `x-weiwudi-error: quota | storage` を付ける
7. 206 を組み立てて返す。状態は、全部手元なら `hit`、上流から取ったブロックがあり `head` が無かった・版が替わったなら `miss`、`head` があり版が同じなら `refresh`
8. 上流の失敗:
   - ネットワーク失敗（`TypeError`）: 現在の版のブロック `n0..n1` が全部あれば `stale`（`x-weiwudi-error: network`）。欠けていれば 404（`offline-miss`・`network`）。途中まで欠けた 206 は返さない（R7）
   - HTTP 失敗（`!ok`。416 を含む）: 全部あれば `stale`（`upstream`）。無ければ上流の応答をそのまま写して返す（`upstream-error`。仕様 §6 の 5 と同じ形。416 の `Content-Range: bytes */N` は `head.total` に記録する）
   - 200 の `text/html`: 仕様 §4.6 のとおり HTTP 失敗として扱う（ログイン画面をブロックとして固定しない）

### 7.3 206 の組み立て

- 状態 206・`statusText: 'Partial Content'`
- `Content-Range: bytes N-M'/total`。`M'` は実際に返す最後のバイト（全長で丸めた値）。全長が不明なら `*`（H3。geotiff.js は `*` を `null` として受ける。G4）
- 本体: ブロック `n0..n1` を `Uint8Array(M' − N + 1)` に写す（`set` で連結し、先頭 `N − n0·B` と末尾を落とす）。`ArrayBuffer` を `Response` の本体にする
- ヘッダ: `head.headers`（`content-type`・`etag`・`last-modified`・`cache-control`・`expires`・`accept-ranges`・`date` など。H4 の義務のうち持っているもの）を写し、`content-range` を足し、`x-weiwudi-status`・`x-weiwudi-error`・`access-control-expose-headers` を仕様 §6 のとおり付ける。`content-length` は付けない（仕様 §6 の落とすヘッダ）。pmtiles.js は 206 では `Content-Length` を見ない（P6）
- `ETag` を写すのは pmtiles.js の版の照合（P4）のため。ページから見える応答は SW が合成した `basic` なので、上流が `ETag` を公開していればページも読める

### 7.4 同時要求のまとめ

- `ctx.inflight` にブロック単位の鍵 `<fileKey>\0b\0<version>\0<index>` で上流の取得を置く。要求 A がブロック 3〜5、要求 B が 5〜7 を同時に求めたら、A が 3〜5 を 1 本で取り、B は 5 を A から受けて 6〜7 だけを取る
- 認証付きで保存しない要求はまとめない（仕様 §6 と同じ）
- ページの要求の `signal`（MapLibre のタイル取り消し）は上流へ渡さない。取り消された要求のために取ったブロックも保存する（次の要求が使う。R9）

## 8. 上流への要求のまとめ方

### 8.1 要求の形

- `upstream.createUpstream`（仕様 §4.5・§4.6・§10）を使う。CORS の組み替え・資格情報の追加・条件付きヘッダの除去・`corsOk`／`corslessUntil` の判定は今の実装のまま。範囲の経路のために上流の取得を別に書かない（二重実装にしない）
- `Range` ヘッダだけを差し替える: ページの要求の `Range` を落とし、ブロックに丸めた `bytes=a·B-((b+1)·B−1)` を置く。単一範囲なので preflight にならない（F1）
- `Request.cache` を上流へ写す（`rebuild()` に `cache: request.cache` を足す。W2）。pmtiles.js の `reload`（P4）が上流に届かないと、ブラウザの HTTP キャッシュが古い版を返し続けて `EtagMismatch` から抜けられない。`no-store`（P5）もそのまま写す（上流の HTTP キャッシュを使わないだけで、Weiwudi の保存には影響しない）
- `If-Range` は今のとおり落とす（W2）。ページが `If-Range` を付けても Weiwudi は評価しない（§10.4）
- 連続するブロックの並びは 1 本にまとめ、離れた並びは**別々の要求**にする（並行は 4 本まで）。複数範囲の要求は出さない（H3 の multipart の解析と F1 の preflight を避ける。geotiff.js の `BlockedSource` と同じ方針。G1）

### 8.2 応答の読み方

| 上流の応答 | 読み方 |
|---|---|
| 206・`Content-Range: bytes a-b/total` が読める | 本体を `a` から並べてブロックに切る。`total` を `head.total` に書く。`b` が要求より小さければ（H3「一部だけ返す」）足りないブロックはこの要求では無いものとし、組み立てに足りなければ残りを 1 回だけ取り直す。2 度目も足りなければ `upstream-error` |
| 206・`Content-Range` が読めない（F2。公開されていない） | 本体の先頭を要求した `a` と見なす。本体が要求より短ければ末尾に達したと見なし `head.total = a + 本体長` を書く。同じ長さなら全長は不明のまま |
| 200（Range を無視した。H2） | 本体を先頭からブロックに切って**全部保存**し、`head.total = 本体長`。要求には 206 で答える（P6・G2 の読み手はこの変換で動く）。本体が `range.maxBytes` を超えるときは読み切らずに `response.body.cancel()` して素通しの応答に替える（上流へもう 1 度出す。R6） |
| 416 | `Content-Range: bytes */N` の N を `head.total` に書く。保存しない。手元に `n0..n1` が全部あれば `stale`、無ければ 416 をそのまま写す（pmtiles.js は 416 を自分で処理する。P3） |
| 2xx で上の 3 つ以外（203 など）・opaque | 保存しない。opaque は仕様 §4.5 のとおり（Entry があれば `stale`、無ければそのまま） |

版（`ETag` → `Last-Modified` → `-`）は 206 と 200 のどちらでも読み、§10 に渡す。`ETag` が読めず `Last-Modified` が読めるサーバ（F2 の既定）は `Last-Modified` が版になる。

### 8.3 Range の無い GET

`range: 'block'` の Resource に Range 無しの GET が来たとき（ファイル全体を読むアプリ、または `curl` 的な確認）:

- `bytes=0-` の要求として §7.2 を通し、応答は **200**（`Content-Range` 無し）で全体を返す。全長が不明なら最初のブロックの取得（§8.2）で分かる
- 全長が `range.maxBytes` を超えるファイルは素通し（保存しない）。全体を 1 つの `ArrayBuffer` に組み立てられないため
- ファイル全体を 1 Entry として保存する形（今の `asset`）とは**混在させない**（§12）

## 9. 版（ETag・Last-Modified）の扱い

- 版の文字列は、応答の `ETag` があればそれ（弱い `W/…` も**そのまま使う**。R4）、無ければ `Last-Modified` の値、どちらも無ければ `-`
- `ETag` と `Last-Modified` の両方があるときは `ETag` だけで比べる（`Last-Modified` は無視）。`ETag` が無いサーバで `Last-Modified` だけが変わったら新しい版
- `-` どうしは同じ版と見なす。ただし `head.total` が分かっていて応答の全長と違えば新しい版（長さだけで差し替えを検知する）
- 版が違うブロックは組み立てに混ぜない（H5。弱い検証子を使っている場合は厳密には RFC の「強い検証子」の条件を満たさないが、R4 の理由で受け入れる）

## 10. 鮮度と版の切り替え

### 10.1 鮮度の単位はファイル

- `head.fetchedAt` は、上流から版を読んだ最新の時刻。`cacheTtl`（Resource の実効方針）と比べる
- TTL 内: 上流に触らない（ブロックが欠けていれば欠けたブロックだけを取り、`fetchedAt` は**更新しない**。版の照合はするので、違えば §10.2）
- TTL を過ぎた最初の要求で、要求された範囲を取り直す（§7.2 の 4）。版が同じなら `head.fetchedAt = now`・`refresh`。これでファイルの他のブロックも TTL 内に戻る。タイルごとに TTL を持つ今の形と違い、1 回の確認でファイル全体が新しくなる（R1）
- ブロックの `EntryMeta.fetchedAt` は取得時刻。`cacheRetention` はブロックごとに効く（期限を過ぎたブロックは「無いもの」。掃除は m4 の `[pinned, fetchedAt]` の走査のまま）

### 10.2 版の切り替え

上流の応答の版が `head.version` と違うとき:

1. `patchResource` で `rangeFiles[rest]` を新しい版・新しい全長・新しいヘッダ・`fetchedAt = now` に書き換える
2. 古い版のブロックを接頭辞の範囲で消す（新しい store の操作 `deleteEntriesByPrefix(resourceId, prefix)`。1 tx で cursor を回して `size` を足し、`count`・`bytes`・`pinnedBytes` を直す。固定されたブロックも消す（版が替わったので、固定していても意味を持たない。region は残り、次の範囲取得で新しい版を固定する。M2 で `regions` に版を記録する）
3. 手元の古いブロックは使わず、要求の範囲を新しい版で取り直して組み立てる（§7.2 の 5）
4. pmtiles.js は新しい `ETag` を見て `EtagMismatch` を投げ、ヘッダとディレクトリを `cache: 'reload'` で読み直す（P4）。その要求は §10.3 で hit を飛ばすので、新しい版のヘッダが返る。古い版が残ってループになることはない

### 10.3 `Request.cache` の読み替え

| `cache` | 扱い | 理由 |
|---|---|---|
| `reload`・`no-cache` | hit を飛ばして上流へ（結果は保存する）。TTL を無視する | pmtiles.js の `EtagMismatch` の回復（P4）がこれで届く。「ブラウザのキャッシュを使うな」は Weiwudi の保存にも当てる |
| `no-store` | **普通の経路**（hit を返す） | Windows の Chromium では pmtiles.js が全要求に付ける（P5）。従うとオフラインで何も返せない。意図はブラウザの不具合回避で、Weiwudi の保存を禁じるものではない |
| `default`・`force-cache`・`only-if-cached` | 普通の経路 | — |

### 10.4 `If-Range`

- ページの要求の `If-Range` は落とす（W2 のまま）。Weiwudi は評価しない。pmtiles.js も geotiff.js も送らない（P8）
- 版が替わったときにページへ全体（200）を返すことはしない。常に現在の版の 206 と `ETag` を返し、版を照合するクライアント（pmtiles.js）に判断させる

## 11. 保存

- ブロックごとに `putEntry(meta, body, evict)`。`meta.size` はブロックの長さ、`fetchedAt = accessedAt = now`、`pinned` は保存済みの値を引き継ぐ（範囲取得が固定したブロックを上書きしても固定が外れない。仕様 §6 の `savedPinned` と同じ）。`contentType` は `head.headers['content-type']`
- `EntryBody` は `{ key, body: ArrayBuffer, headers: {} }`（m3-t10 の形）。ヘッダは `head` が持つので Entry には入れない（空の object）
- 1 本の上流の要求で取れたブロック群は **1 tx で書く**新しい操作 `putEntries(metas, bodies, evict)` を足す（W4 のグリフの「溜めてから 1 回で書く」と同じ理由。退避の計算（W6）を要求ごとに 1 回にする）。`putEntry` はこれに 1 つ渡す形にし、実装は 1 つ
- 退避の範囲（`evictScopesFor`）は今のまま。ブロックは `pinned = 0` の普通の Entry として LRU の候補に入る
- 単体で `cacheMaxBytes` を超えるブロックは保存しない（今の規則）。`blockBytes` を `cacheMaxBytes` より大きくすると何も保存されないので、登録でこの組を `attribute-invalid` にする

## 12. 資格情報と認証付きの要求

- 登録の `credentials`（仕様 §10）は `createUpstream` が上流の要求に足す。範囲の経路も同じ関数を使うので規則は変わらない。`Range` を差し替えても URL とヘッダの資格情報の扱いは変わらない
- 認証付きの要求（`Authorization` がある、または `mode: 'cors'` で `credentials: 'include'`。仕様 §4.6）は、`policy.store` が偽なら**組み立ても保存もせず**元の `Request` のまま上流へ出す（今の素通しと同じ）。pmtiles.js の `credentials: 'include'`（P1）は認証付きになるので、保存したい利用者は `cachePrivate: true` を付ける（README に書く）。`policy.store` が真なら普通の経路（上流は元の `Request` に `Range` だけ差し替えて出す。同時要求はまとめない）
- 版（`ETag`・`Last-Modified`）と `head.headers` は資格情報を含まない。`set-cookie` は落とす（仕様 §6）
- ミラー（URL 配列）は同じブロックを共有する。ミラーの間で `ETag` が違うと版の切り替えが往復する。README に「ミラーは同じ検証子を返すこと。違うなら別々に登録する」と書く（R10）

## 13. 新しいインタフェース

```ts
export type SourceSpec = CommonPolicy & (
  | { kind: 'raster' | 'vector'; … }                 // 変更なし
  | { kind: 'style'; … }                              // 変更なし
  | { kind: 'asset'; id?: string; url: string | string[];
      range?: 'passthrough' | 'block';                // 既定 'passthrough'（今の挙動）
      blockBytes?: number;                            // range: 'block' のとき。既定 65536。2 の冪で 4096〜4194304
      rangeMaxBytes?: number }                        // range: 'block' のとき。既定 33554432（32 MiB）。1 要求・1 ファイル全体の上限
);
```

- `range`・`blockBytes`・`rangeMaxBytes` は `kind: 'asset'` だけが受ける。他の `kind` に付いていたら `attribute-invalid`。`range: 'passthrough'` で `blockBytes` が付いていても `attribute-invalid`
- `StoredSpec` に `range?: { blockBytes: number; maxBytes: number }` を足す。`ResourceMeta.range` は作るときに写し、合流では先の値を変えない（`provider` と同じ）
- `ResourceInfo` に `range?: { blockBytes: number }` を足す（`source.resources`・`stats().byResource` で見える）。`stats().count` はブロックの数（ファイルの数ではない）。README に書く
- `WeiwudiSource.fetchRange(range)` は M2 から `range: 'block'` の asset に効く（§16）。M1 では `attribute-invalid`（`fetchRange is not supported for this source`）
- 使い方（MapLibre ＋ pmtiles.js）:

```ts
const archive = await Weiwudi.register({ kind: 'asset', url: 'https://example.com/japan.pmtiles', range: 'block' });
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
// style.json の sources.x.url は 'pmtiles://https://example.com/japan.pmtiles'（pmtiles.js が https の URL で要求を出す。P9）
```

- 公開 API は追加だけなので minor（`feat:`）。仕様 §14.1 と同じ

## 14. 全体を保存する場合との関係

| | `range: 'passthrough'`（今の `asset`） | `range: 'block'` |
|---|---|---|
| Range なし GET | 1 Entry に全体を保存（仕様 §6） | ブロックに切って保存し 200 で返す（§8.3） |
| Range 付き GET | 素通し（仕様 §11） | ブロックの経路（§7） |
| キー | `<id>\0<rest>` | `<id>\0<rest>\0b\0<版>\0<番号>` |
| 鮮度 | Entry ごと | ファイルごと（`rangeFiles`） |

- 1 つの Resource の中で 2 つを混ぜない。`range` の有無・`blockBytes` が違う登録は `resource-conflict`（§15）。利用者が片方を `remove()` して登録し直す
- 同じ URL をあるアプリは全体で、別のアプリは Range で読む、という場合は `block` を選ぶ（どちらの要求にも答えられる。§8.3）
- `passthrough` → `block` へ移すときの既存の全体 Entry は使わない（`remove()` で消える）。移行は作らない

## 15. 合流（仕様 §5.6 への追加）

- `conflictOf` に 1 行足す: `(r.range?.blockBytes) !== (s.range?.blockBytes)` なら `'range'` で衝突。`range` の有無の違いもこれで拾う（`undefined !== 65536`）
- `type: 'data'` は範囲（`extents`）を持たないので「拒否しても範囲だけは足す」は当たらない（P1 のまま）。衝突は `warnings` に書くだけ
- 自分自身の `update()` で `range` を変えると `resource-conflict`（仕様 §5.6 と同じ）。`rangeMaxBytes` だけの変更は衝突にしない（キーに関係しないので `ResourceMeta.range.maxBytes` を書き換える）

## 16. 容量と退避

- ブロックは `pinned = 0` の Entry として `cacheMaxBytes`（Source ごと）と全体上限（m4 の `setLimits`）の LRU の候補に入る。ファイルの一部のブロックだけが残る状態は正常（次の要求が欠けたブロックだけを取る）
- `touch` は hit したブロックごとに呼ぶ。1 要求で最大 `maxBytes / blockBytes`（既定 512）回の `touch` になるので、`touchMany(keys, accessedAt)`（1 tx）を足す
- `putEntries` の退避の計算（W6）は要求ごとに 1 回。m2-t2 Minor 1 の改善（`bytes − pinnedBytes` が予算内なら走査を省く）はブロックの経路で効き目が大きいので、M1 で一緒に入れる（§18 の M1-t2）
- `cacheRetention` はブロックごと。`rangeFiles` の頭は小さいので掃除しない（ファイルの全ブロックが消えても頭は残り、次の要求で版を照合してそのまま使う）
- `QuotaExceededError` の再試行（m4）はブロックにもそのまま効く
- `rangeFiles` の 16 ファイルの上限（§6.1）と `rangeMaxBytes`（§5）が、1 Resource の `ResourceMeta` とメモリの上限

## 17. 旧 API との関係

- 無い。旧 API（`/api/cache/<id>/z/x/y`）は `Range` を素通しし続ける（仕様 §9 の既知の変化のまま）。旧 API の Source（`map:`）は `range` を持たない
- `core.passThrough` は、旧 API・`range: 'passthrough'` の asset・複数範囲／末尾範囲の要求（§4.2）の素通しの唯一の実装として残る

## 18. 試験の方針

- **単体（`tests/unit`。fake-indexeddb）**: 偽の上流を RFC 9110 の規則で書く（単一範囲の 206・`Content-Range` の有無（F2 の再現）・Range を無視する 200・416＋`bytes */N`・一部だけ返す 206・`ETag` の切り替え・`Last-Modified` だけのサーバ・`text/html` の 200）。要求の形は P1〜P3 と G1〜G2 をそのまま写す（`bytes=0-16383` から始めて `header.etag` を比べる手順、64 KiB 境界の連続ブロックのまとめ）。見る値は `x-weiwudi-status`・`Content-Range`・本体のバイト・`entries` の件数と `count`・`bytes` の一致・上流への要求の `Range` の値と本数
- **性質の試験**: 種を固定した乱択で、ブロックの大きさ・要求の範囲・手元のブロックの有無・上流の応答の種類を振り、組み立てた本体が元のファイルの該当バイトと一致し、`count`・`bytes` が `entries` の集計と一致すること（m2-t2 の「数の一致」と同じ形）
- **e2e（Playwright・Chromium。WebKit は CI。m3 R14'）**: 実際の pmtiles.js・geotiff.js は npm 依存を足さずに使えない（m3 R15）ので、同じ形の要求を出す小さなクライアントを `tests/e2e/fixtures` に置く。固定の `.pmtiles`（M2 で作る fixture 生成器）に対して、オンラインで一度読んだ範囲がオフラインで 206・`hit` になること、`ETag` を替えた後の `cache: 'reload'` で新しい版が返ること、Range を無視するサーバで 206 に変換されること
- **合否判定のコマンドは rtk を通さない**（単体・e2e・typecheck・lint）
- 二重実装の grep: `grep -n 'fetch(' src/range.ts` が 0 件（上流は `createUpstream` だけ）、`grep -n 'putEntry\|putEntries' src/*.ts | grep -v '^src/store.ts' | grep -v '^src/core.ts' | grep -v '^src/range.ts'` が 0 件

## 19. 実装を分ける案（マイルストーンとタスク）

m4（範囲取得・保持・移行・master への合流）の**後**に独立の里程として置く（#78 の「進め方」）。公開は次のトレイン以降の minor。

### M1: ブロックキャッシュ（見ながら保存）

| タスク | 内容 | 主なファイル |
|---|---|---|
| M1-t1 | 登録: `range`・`blockBytes`・`rangeMaxBytes` の検査と保存、`conflictOf` の `range`、`ResourceInfo.range`、公開の型と `docs/api` の英日 | `spec.ts`・`registry.ts`・`store.ts`（型）・`weiwudi.ts`・README |
| M1-t2 | store: `putEntries`（1 tx・複数 Entry。`putEntry` はこれに 1 つ渡す）・`touchMany`・`deleteEntriesByPrefix`・`getEntriesInRange`（キーの範囲の `getAll`）。退避の走査の省略（m2-t2 Minor 1） | `store.ts` |
| M1-t3 | `range.ts`: Range の解析（単一範囲の判定）・ブロックの計算・`rangeFiles` の読み書き・上流の要求のまとめ・応答の読み方（§8.2）・206／200／416 の組み立て・版の切り替え・`inflight`。`upstream.rebuild` に `cache` を写す | `range.ts`（新規）・`upstream.ts`・`core.ts`（`synthesize` 系の export） |
| M1-t4 | hook: `range` を持つ Resource の振り分け（`serveRange` へ）。依存の表（仕様 §3）に `range.ts` の行を足す。`deps.test.ts` | `hook.ts`・仕様 §3 |
| M1-t5 | e2e: 固定のバイト列を Range で配る fixture サーバ（Range 無視・`Content-Range` 非公開の 2 形も）と pmtiles.js／geotiff.js と同じ形のクライアント | `tests/e2e/range.spec.js`・fixtures |

受け入れ条件: 単体・e2e が緑（rtk なし）。pmtiles.js の形の要求（P1〜P4）がオフラインで `hit` になること。`stats().bytes` が `entries` の集計と一致すること。既存の試験（旧 API・タイル・グリフ）に差分が無いこと。

### M2: PMTiles の範囲取得（`fetchRange`）

- PMTiles v3 のヘッダ（127 バイト）・ルート／葉ディレクトリ（varint・`internal_compression`。gzip は `DecompressionStream('gzip')`、他の圧縮は `unsupported` で止める）を読み、`RangeSpec` の z/x/y をタイル ID（Hilbert）→ バイト範囲 → ブロック番号に写す。ディレクトリ自身のブロックも固定する
- `regions` に版（`version`）とブロック番号の範囲の列を記録する（m4 の `regions` の形に項目を足す。§20）。解放はブロック番号の範囲で引く
- fixture の `.pmtiles` 生成器（試験コード。依存を足さない）
- 確かめること（M2 の設計で一次資料を読む）: PMTiles v3 の仕様（`protomaps/PMTiles` の `spec/v3/spec.md`）・`DecompressionStream` の SW での対応（Chromium・WebKit・Firefox）

### M3: COG の範囲取得と `pmtiles://` のスタイル

- COG: TIFF／BigTIFF の IFD・`TileOffsets`・`TileByteCounts`・overview の段を読み、`RangeSpec` の `box`（ピクセル）と、EPSG:3857・4326 の `bounds` だけに対応する（他の座標系は `unsupported`）
- スタイル（仕様 §5.5）の `sources.*.url` が `pmtiles://https://…` のとき、内側の URL で `type: 'data'`・`range: 'block'` の子を作る（今は `unsupported-source`）。`blockBytes` は既定
- 確かめること: COG の IFD の読み方は geotiff.js の `geotiff.js`／`geotiffimage.js` を読む。BigTIFF の 8 バイトのオフセット

## 20. m4 の設計との接点

m4（範囲取得・解放・保持・移行）は本書より先に設計・実装される。m4 で次を見込んでおくと M2 が m4 の形を壊さずに乗る。

1. **`regions` の記録に、タイルの範囲以外の単位を持てる余地**: ブロックの固定は「版 ＋ ブロック番号の範囲の列」で表す。`regions` の形を `{ id, sourceId, range: RangeSpec, … }` に閉じず、資源の型ごとの `targets`（tile は幾何、data は `{ rest, version, blocks: [from, to][] }`）を持てる形にする。解放の「重なる region の判定は幾何で行う」（仕様 §7.2）はタイルだけに当て、ブロックはキーの範囲で引く
2. **`runJob` の単位は汎用のまま**（今の `JobSpec<T>`）。M2 のタスクは「ブロックの連続する並び 1 本」になる。`concurrency`・`isAlive`・`isCanceled`・`onBatch` はそのまま使える
3. **`putEntries`（1 tx・複数 Entry）と退避の走査の省略（m2-t2 Minor 1）**: m4 の範囲取得も保存の回数が多い。m4 で先に入れるなら M1-t2 は無くなる。どちらが先でも実装は 1 つにする
4. **`cacheRetention` の掃除**: ブロックは普通の Entry なので `[pinned, fetchedAt]` の走査で消える。`rangeFiles` の頭は掃除の対象にしない（§16）
5. **`QuotaExceededError` の再試行と全体上限**: ブロックにそのまま効く。特別な扱いは要らない
6. **`fetchRange` の CORS・認証の規則（仕様 §4.5 の `jobOpaqueStreak`・§4.6 の 401／403 の 3 回）**: ブロックの取得は `mode: 'cors'` の要求（pmtiles.js も geotiff.js も `fetch` から出す）なので no-cors の取り直しは起きない。規則はそのまま当てられる
7. **`opaque` イベント・`proceed`／`finish` の `errors`**: ブロック単位で数える。`total` はブロック数（タイル数ではない）。イベントの形は変えない
8. **移行（§14.2）**: 関係しない。旧 DB に Range の記録は無い
9. **`Request.cache` を上流へ写す**（§8.1）は範囲の経路に限らず、タイルの経路でも害が無い。m4 か M1 のどちらかで `upstream.rebuild` に入れる（1 か所）

## 21. Ruling（決めたこと — 理由 — 誤りならどうなるか）

- **R1 鮮度はファイル単位**（`rangeFiles[rest].fetchedAt`。ブロックごとではない）— PMTiles・COG は 1 ファイルが 1 つの版を持ち、`ETag` も 1 つ。ブロックごとの TTL だと TTL 切れのたびに全ブロックを取り直す。ファイル単位なら 1 回の照合で全部が新しくなる — 誤りなら（ファイルの一部だけが更新される配信があれば）版が同じで中身が違うブロックが残る。その場合は版を `ETag` に限り、`Last-Modified`・`-` の版では TTL 切れで全ブロックを無いものとする形へ直す
- **R2 ファイルの頭は `ResourceMeta.rangeFiles` に持つ**（Entry にしない）— 配信のたびに読む `getResource` に乗るので IndexedDB の読みが 1 回増えない。`patchResource` で版の切り替えが 1 tx になる。LRU に消される心配が無い — 誤りなら（1 Resource に多数のファイルが来る使い方が出れば）`rangeFiles` が肥大する。16 ファイルの上限で止めているので、超える使い方は素通しになるだけ
- **R3 1 Resource あたり 16 ファイルまで**。超えた `rest` は素通し — `type: 'data'` の `rest` は普通は空。クエリで版を替える配信（`?v=N`）は別ファイルとして正しいが、無制限にはしない — 誤りなら上限を上げるか、`credentialParams` と同じ「キーから除くクエリ名」の指定を足す
- **R4 弱い ETag（`W/…`）も版として使う**（pmtiles.js は捨てる。P4）— 版はブロックの混在を防ぐための印であり、弱くても「違えば違う」は言える。捨てると `Last-Modified` か `-` に落ちて検知が弱くなる — 誤りなら（弱い ETag が同じ中身で変わるサーバがあれば）無駄な版の切り替えが起きる。切り替えはブロックを捨てるだけで壊れない
- **R5 複数範囲と末尾範囲は素通し**（組み立てない・保存しない）— 複数範囲は preflight（F1）と multipart の生成（H3）が要り、既定の pmtiles.js・geotiff.js は出さない（P1・G1・G3）。「最初の範囲だけ返す」は RFC 上は許されるが（H3・G3 が示す）、他のクライアントを混乱させる — 誤りなら（`maxRanges > 0` の geotiff.js の利用者が出れば）multipart の生成を足す。キーの形は変わらない
- **R6 1 要求と 1 ファイル全体の上限 `rangeMaxBytes`（既定 32 MiB）**。超える要求と全体 GET は素通し — 組み立ては要求の長さ分のメモリを使う。SW のメモリは小さい — 誤りなら上限を上げる。大きなタイル（ラスタ COG の overview 全体など）が素通しになるだけで壊れない
- **R7 一部のブロックが欠けたまま上流に失敗したら 404（`offline-miss`）**。短い 206 は返さない — RFC は一部だけの 206 を許す（H3）が、pmtiles.js はディレクトリやタイルの長さが合わないと復号に失敗し、geotiff.js は `fetchSlice` の `length` を信じて切る（G2）。欠けた部分を黙って短く返すより、失敗が見える 404 のほうがよい — 誤りなら（部分応答を正しく扱うクライアントが主になれば）短い 206 を返す選択肢を登録で足す
- **R8 `Request.cache` が `reload`・`no-cache` なら hit を飛ばす。`no-store` は普通の経路** — `reload` は pmtiles.js の `EtagMismatch` の回復手段（P4）で、Weiwudi がこれを無視すると古い版を返し続けて地図が止まる。`no-store` は Windows の Chromium で常に付く（P5）ので、従うとオフラインで何も返せない — 誤りなら（`no-store` を本当に「保存しない」意図で付けるクライアントがあれば）その利用者は `range: 'passthrough'` にする
- **R9 ページの `signal` を上流へ渡さない。取り消された要求のために取ったブロックも保存する** — MapLibre はタイルの取り消しを頻繁に出す。上流の取得を途中で捨てると、同じブロックを次の要求で取り直す。`inflight` で共有しているので、別の要求が待っている場合もある — 誤りなら無駄な転送が増えるだけ。保存の失敗にはならない
- **R10 ミラーは同じブロックを共有し、版も 1 つ**。ミラーの間で `ETag` が違えば切り替えが往復する — 仕様 §5.1 の「URL 配列（ミラー）は 1 つの Resource」と揃える。同じ中身を配るミラーは同じ `ETag` を返すのが普通（S3・R2 など）— 誤りなら README の「別々に登録する」で回避できる
- **R11 Range を無視する 200 は全体をブロックに切って保存し、ページには 206 を返す** — RFC はサーバに 200 を許し（H2）、pmtiles.js も geotiff.js も 200 を受け取れない（P6・G2）。Weiwudi が 206 に直せば、Range 非対応の配信でも動くようになる — 誤りなら（`Content-Length` を見て 200 を受けるクライアントが 206 を嫌う場合）そのクライアントは `range: 'passthrough'` にする
- **R12 M1 では差し込み口（仕様 §8）を範囲の経路に当てない** — 差し込み口の契約は 1 要求 1 応答で、ブロックは 1 要求 N Entry。`cacheWillUpdate` をブロックごとに呼ぶか要求ごとに呼ぶかは使い道が無いと決められない — 誤りなら（使い道が出れば）`requestWillFetch`・`fetchDidSucceed`・`fetchDidFail` を上流の要求ごとに当てる形から足す。文書に「範囲の経路には効かない」と書く
- **R13 `range: 'block'` は `kind: 'asset'` だけ。新しい `kind` は作らない** — PMTiles・COG は「1 つのファイル」で、`asset`（`type: 'data'`）の定義どおり。新しい `kind` は `SourceSpec` の union・`childLogicalName`・`usage` の集計・`docs/api` を増やす — 誤りなら（`asset` の他の指定と食い合う項目が出れば）`kind: 'archive'` に分ける。保存の形は同じなので移行は要らない
- **R14 ブロック番号は 12 桁 0 詰めの 10 進** — キーの昇順をバイト順にして、連続ブロックを `IDBKeyRange` 1 回で読む。16 進や可変長より読みやすい。4 MiB × 10¹² で足りる — 誤りなら桁を増やす（キーの形が変わるので版の切り替えと同じ手順で古いブロックを捨てる）
- **R15 複数範囲を出さず、離れたブロックの並びは別々の要求にする（並行 4 本）** — geotiff.js の `BlockedSource` と同じ（G1）。preflight（F1）と multipart の解析（H3）を避ける。RFC も「離れた小さな範囲を多数求めるな」と言う（H2）— 誤りなら上流への要求の本数が増えるだけ
- **R16 `rangeFiles` の頭は掃除しない** — 数百バイトで、ファイルの全ブロックが消えても次の要求で版の照合に使える — 誤りなら `remove()`・`removeResource()` で消えるので放置しても溜まらない

## 22. 人間に上げない点の確認

本書の決定は、仕様と一次資料から機械的に導けるものだけで、好みで分かれる点は無い。`blockBytes` の既定（64 KiB）は geotiff.js の既定に揃えた事実で、`rangeMaxBytes` の既定（32 MiB）は SW のメモリの常識的な上限で、どちらも登録で変えられる。
