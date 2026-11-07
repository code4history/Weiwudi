# Weiwudi

The main class of `@c4h/weiwudi`. Instances are created via `Weiwudi.registerMap`
and expose tile-cache operations for a registered map.

The source API (`Weiwudi.register` and `WeiwudiSource`) caches the real tile URLs
your map library already uses; see [Source API](#source-api).

## Static Methods

### `Weiwudi.registerSW(sw, swOptions?)`

Register a service worker.

**Parameters:**
- `sw` (string | URL): Path to the service worker file
- `swOptions` (RegistrationOptions, optional): Service worker registration options

**Returns:** `Promise<ServiceWorkerRegistration>`

**Resolves when:** The registered service worker has activated and controls the
current page. The worker calls `skipWaiting` on install and `clients.claim()` on
activate, so the page is controlled from the first visit without a page reload.

**Throws:**
- `"Error: Service worker is not supported"`: When the browser doesn't support service workers
- `"Error: Service worker registration failed with {error}"`: When registration fails
- `"Error: Service worker did not control this page within 10000 ms"`: When the page is not controlled within 10000 ms (e.g. the page URL is outside the registration scope)

**Example:**
```js
await Weiwudi.registerSW('./sw.js', {scope: './'});
```

---

### `Weiwudi.registerMap(mapID, options)`

Register a map configuration and create a Weiwudi instance.

**Parameters:**
- `mapID` (string): Unique identifier for the map
- `options` (WeiwudiOptions): Map configuration object

**Returns:** `Promise<Weiwudi>` - A Weiwudi instance for the registered map

**Throws:**
- `"Weiwudi service worker is not implemented."`: When service worker is not active
- `"Error: {message}"`: When map registration fails
- `"Error: MapID must not contain a NUL character"`: When `mapID` contains a NUL character (`\0`). Added in the release with the cache migration; it is a catch-all `Error: …` message, so `WeiwudiError.from` gives `internal`

**Example:**
```js
const map = await Weiwudi.registerMap('my_map', {
    type: 'xyz',
    width: 10000,
    height: 6000,
    url: 'https://example.com/{z}/{x}/{y}.jpg'
});
```

**Cache from 1.1.x:**
- The tile cache of 1.1.x is carried over gradually, starting with the first request after the update (it does not stall even with several GB, and the cached tiles stay readable offline during the migration).
- Going back to 1.1.x does not break anything (its cache starts empty, so the tiles are fetched again). Where `indexedDB.databases()` is not available (older Firefox), a cache that 1.1.x recreated while you were back on it is not migrated again.
- During the migration, `fetchAll` and `stats` count only the tiles migrated so far (`fetchAll` fetches the tiles not migrated yet again when online, and the `percent` of `stats` is temporarily low).

---

### `Weiwudi.retrieveMap(mapID)`

Retrieve an existing registered map configuration.

**Parameters:**
- `mapID` (string): Unique identifier for the map

**Returns:** `Promise<Weiwudi>` - A Weiwudi instance for the retrieved map

**Throws:**
- `"Weiwudi service worker is not implemented."`: When service worker is not active
- `"Error: {message}"`: When map retrieval fails

---

### `Weiwudi.removeMap(mapID)`

Remove a registered map configuration.

**Parameters:**
- `mapID` (string): Unique identifier for the map to remove

**Returns:** `Promise<void>`

**Throws:**
- `"Weiwudi service worker is not implemented."`: When service worker is not active
- `"Error: {message}"`: When map removal fails

---

## Instance Methods

### `stats()`

Get current cache statistics for this map.

**Returns:** `Promise<{count: number, size: number, total?: number, percent?: number}>`

**Throws:**
- `"This instance is already released."`: When called on a released instance
- `"Error: {message}"`: When stats retrieval fails

**Example:**
```js
const stats = await map.stats();
console.log(`Cached tiles: ${stats.count}, Size: ${stats.size} bytes`);
```

---

### `clean()`

Clear all cached tiles for this map.

**Returns:** `Promise<void>`

**Throws:**
- `"This instance is already released."`: When called on a released instance
- `"Error: {message}"`: When cache cleaning fails

---

### `fetchAll()`

Fetch and cache all tiles for this map (for offline use).

**Returns:** `Promise<void>`

**Throws:**
- `"This instance is already released."`: When called on a released instance
- `"Error: {message}"`: When fetch operation fails

**Events:** Dispatches `proceed`, `finish`, and `stop` events during the fetch process.

**Example:**
```js
map.addEventListener('proceed', (e) => {
    console.log('Fetching tiles...', e.detail);
});
map.addEventListener('finish', (e) => {
    console.log('All tiles fetched!');
});
await map.fetchAll();
```

---

### `cancel()`

Cancel an ongoing `fetchAll()` operation.

**Returns:** `Promise<void>`

**Throws:**
- `"This instance is already released."`: When called on a released instance
- `"Error: {message}"`: When cancellation fails

---

### `remove()`

Remove the map registration and release this instance. After calling this method, the instance cannot be used.

**Returns:** `Promise<void>`

**Throws:**
- `"This instance is already released."`: When called on a released instance

---

## Instance Properties

### `url`

**Type:** `string`

The URL template for accessing cached tiles. Use this URL in your map library (e.g., Leaflet, OpenLayers).

**Example:**
```js
const map = await Weiwudi.registerMap('my_map', {...});
L.tileLayer(map.url).addTo(leafletMap);
```

---

## Events

Weiwudi instances extend `WeiwudiEventTarget` and support the following events:

### `proceed`

Fired periodically during a `fetchAll()` operation to report progress.

**Event Detail:**
- `mapID` (string): Map identifier
- `error` (number): Number of failed tiles so far (total)
- `errors` (object): Failed tiles so far by kind: `{ network, upstream, quota, storage }`.
  Only the tiles requested by this `fetchAll()` are counted
- Additional progress information

---

### `finish`

Fired when a `fetchAll()` operation completes successfully.

**Event Detail:**
- `mapID` (string): Map identifier
- `error` (number): Number of failed tiles (total)
- `errors` (object): Failed tiles by kind: `{ network, upstream, quota, storage }`.
  Only the tiles requested by this `fetchAll()` are counted

---

### `stop`

Fired when a `fetchAll()` operation stops due to an error or cancellation.

**Event Detail:**
- `mapID` (string): Map identifier
- `reason`: The error that stopped the operation
- `code` (string): `WeiwudiError.from(reason).code` (see [Errors](#errors))

## Source API

Register the URL templates your map library requests. The service worker then
catches those real URLs directly, so you pass the original URL to the map
library instead of a `weiwudi.example.com` URL.

```typescript
import Weiwudi from '@c4h/weiwudi';

await Weiwudi.registerSW('./sw.js', { scope: './' });
const source = await Weiwudi.register({
  kind: 'raster',
  url: 'https://tile.example.com/{z}/{x}/{y}.png',
  bounds: [139.7, 35.6, 139.8, 35.7], minZoom: 0, maxZoom: 16,
});
// Create the map after register() resolves; earlier requests are not cached
L.tileLayer(source.url as string).addTo(leafletMap);
```

Chromium is tested locally and in CI. WebKit (Playwright's WebKit on Linux) is tested in CI, except the
tests that only work on Chromium: going offline (`context.setOffline`), stopping the service worker (CDP),
the real storage quota, and the Mapbox tests (Playwright cannot intercept requests from a service worker on
WebKit). Linux WebKit is not the same as Safari on iOS. WebKit cannot store a `Blob` in IndexedDB in a
non-persistent session (private browsing included), so Weiwudi stores bodies as `ArrayBuffer`; all 29 CI
tests pass on WebKit in this form. Firefox is run in CI on the same 29 tests as WebKit and all pass, but it
is not a required check.

A sandboxed `srcdoc` iframe (`allow-scripts allow-same-origin`) inherits the page's service worker on Chromium
and WebKit, so it can use the API there. On Firefox it does not, and calls in it reject with `sw-not-controlling`.

### `Weiwudi.register(spec)`

Register a source. Calling it again with the same spec is idempotent.
Registering again with the same `id` replaces the spec, credentials included
(omitting `credentials` removes them).

**Parameters:** `spec` (`SourceSpec`)

```typescript
type SourceSpec = CommonPolicy & (
  | { kind: 'raster' | 'vector'; id?: string; url: string | string[];
      bounds?: [west: number, south: number, east: number, north: number];
      box?: TileBox;  // tile coordinates at maxZoom in this source's scheme (y counts from the south for 'tms')
      minZoom?: number; maxZoom?: number; scheme?: 'xyz' | 'tms'; tileSize?: number;
      outOfRange?: { extent?: OutOfRange; zoom?: OutOfRange } }
  | { kind: 'style'; id?: string; url: string; fonts?: string[] }
  | { kind: 'asset'; id?: string; url: string | string[] }
);
interface CommonPolicy {
  cacheTtl?: number;          // freshness in ms (default 24 h)
  cacheRetention?: number;    // deletion deadline in ms (default: none)
  cacheMaxBytes?: number;     // capacity of this source in bytes
  cachePrivate?: boolean;     // also cache authenticated requests (default false)
  credentials?: Credentials;  // added by the service worker; never stored outside the credentials store
  credentialParams?: string[];// query names dropped from cache keys (added to the defaults and to the names in credentials.query)
}
type Credentials = { query?: Record<string, string>; headers?: Record<string, string> };
type OutOfRange = 'transparent' | 'empty' | 'not-found';
interface TileBox { minX: number; maxX: number; minY: number; maxY: number }
```

`cacheRetention` sets a deletion deadline in milliseconds from `fetchedAt` (no deadline by default).
Expired entries are treated as missing when serving requests and are deleted in batches on the first
store-using Weiwudi request after the service worker starts, and when a job ends.
Pinned entries are never deleted by this cleanup. Glyphs expire per stored range.
Each cleanup run visits at most 2,000 records; unfinished cleanup continues on the next eligible request.
It pauses while a job is running. Neither ping endpoint nor `fetchAll` dispatch starts cleanup;
`fetchAll` runs it when the job ends.

- `url`: one template or an array of mirrors. Tokens: `{z}` `{x}` `{y}` `{-y}`
  `{quadkey}` `{ratio}` `{prefix}`. A relative URL is resolved against the page.
- `id`: defaults to the normalized first template. An explicit `id` is a public
  value (the key of `source()`, the `id` of `sources()`, and `warnings`): **do not
  put credentials in it**. It must be a non-empty string without `\0` and must not
  start with `map:` (reserved for maps registered with `registerMap`).
- `kind: 'style'`: one style URL (an array is `attribute-invalid`). The service
  worker fetches the style and registers everything it refers to. See
  [Styles](#styles-kind-style). `fonts` is only saved in this version.
- `kind: 'asset'`: a file without tokens (GeoJSON, an image, …). An array is a list
  of mirrors of the same file (one resource). An asset has no range.
- Out-of-range tiles are a transparent PNG (raster) or an empty 200 body (vector)
  by default. Use `outOfRange: { zoom: 'not-found' }` to get a 404 outside the zoom range.

**Returns:** `Promise<WeiwudiSource>`

**Rejects with `WeiwudiError`:**
- `attribute-invalid`: a malformed attribute, an `id` starting with `map:`, empty
  or containing `\0`, a template with user info (`user:pass@`), or mirrors that
  carry different values for the same credential parameter (names compared
  case-insensitively; register each mirror as its own source; names in an
  explicit `credentials.query` are not compared), a `kind: 'style'` with an array
  `url` or a malformed `fonts`, or a different `kind` for an `id` that is already
  registered (`remove()` it first)
- `unsupported-template`: an unsupported token, a URL that cannot be resolved
  or is not `http:` / `https:` (relative URLs are resolved against the page
  first), or a template on `weiwudi.example.com`
- `invalid-style`: the style of `kind: 'style'` could not be fetched or read (see [Styles](#styles-kind-style))
- `credential-rejected`: a secret token (`sk.`) in `credentials` or in a template query,
  or a path segment starting with `sk.eyJ` (a segment name such as `sk.osm` is accepted)
- `sw-not-controlling` / `sw-outdated`: see [Before every call](#before-every-call)

**Credentials:**
- The service worker adds credentials only when the request after the plugins
  has the same origin as the request from the page. A request that got
  credential headers is sent with `redirect: 'error'` (except a `no-cors`
  request, which does not send those headers), so a redirect is treated
  as a network failure (query credentials alone keep the original `redirect`).
  A request with only query credentials follows redirects. The redirect target
  is chosen by the upstream in `Location`, and the query of the original request
  is not carried over (unless the upstream itself writes it there; the upstream
  is assumed to be trusted).
- For a style, credentials go only to the origin of the registered style URL
  and to its provider, also when the style URL redirects. They are added to the
  URLs of the registered URL's origin inside the body returned by the redirect
  target too, so do not register a style URL that redirects to an untrusted
  upstream.
- Query items whose name or value starts with `sk.` are not put in cache keys
  (also a value that starts with `sk.` after a leading `Bearer `, `Token ` or
  `Basic ` and spaces are removed).
- **A resource id is never rewritten.** The id of a resource first created by a
  source that does not declare a `credentialParams` item keeps that item. Declare
  credential query items in the source you register first.
- When a source with an explicit `credentials.query` is registered later onto a
  resource that already has entries, it gets `resource-conflict` (the key shape
  would change).

A resource that cannot be merged with an existing one does **not** make
`register()` fail. The source is saved and `warnings` gets
`resource-conflict: <resource id>`.

A template of another shape that matches the same requests (`{y}` and `{-y}`,
for example) is only reported as `template-shadowed`; the later registration is
not captured.

`register`, `update`, `clean`, `remove`, `removeResource` and `releaseRange`
run one at a time in a queue of the service worker. The queue does not span
service workers: calls made at the same time from pages controlled by service
workers of a separate scope (same origin) are not serialized against each
other. Register sources from one scope.

### Styles (`kind: 'style'`)

```typescript
const style = await Weiwudi.register({
  kind: 'style', url: 'mapbox://styles/u/s',
  credentials: { query: { access_token: 'pk.…' } },
});
// style.url is https://api.mapbox.com/styles/v1/u/s (no token). Create the map after register() resolves
const map = new maplibregl.Map({ container, style: style.url as string });
```

The service worker fetches the style through its own cache and registers each
resource the style refers to: the TileJSON of `sources.*.url` (and the `tiles`
inside it), `sources.*.tiles`, `glyphs`, `sprite` (a string or `{ id, url }[]`;
`.json`, `.png`, `@2x.json` and `@2x.png` share one resource), the URL `data` of a
`geojson` source and the `url` of an `image` source. Ranges come from `bounds`,
`minzoom`, `maxzoom` and `scheme` of the TileJSON and of the source (the source
wins; a `bounds` without `maxzoom` uses zoom 30). Out-of-range tiles are a
transparent PNG (raster) or an empty body (vector). `source.resources` and
`stats()` include all of them. `raster-dem` is cached as raster tiles.

- `mapbox://` is resolved at registration (the standard `mapbox` provider), and
  the saved style is rewritten to `https`. Only a style that you register with
  `mapbox://` or a Mapbox `https` URL is rewritten.
- **Credentials are sent only to the origin of the style and to the provider of
  the style** (for a `mapbox://` style: `api.mapbox.com` and `*.tiles.mapbox.com`).
  A resource gets the credentials only when every mirror of it is such a
  target. A style from a third party cannot make the service worker send your
  token to another host. A credential that is already written in a URL of the
  style stays with that URL (it wins over the registered value of the same name).
- When credentials are registered, the credential items are removed from the
  URLs in the saved style and TileJSON bodies that receive the credentials (the
  service worker adds them again upstream). Other URLs are kept as they are.
  Only items whose value equals the registered credential are removed; a
  different value (a token of that child) stays in the body and becomes the
  credential of that URL.
- **A style from another origin cannot capture URLs of the page's origin**:
  those resources are not registered (`same-origin-skipped`). The same applies
  to the `tiles` of a TileJSON when the style or the TileJSON is from another
  origin.
- A resource that cannot be registered does not make `register()` fail; it is
  written to `warnings` (see [warnings](#warnings)). A conflict with another
  source's resource is `resource-conflict` here too, also in `update()`.
- `invalid-style`: the style itself could not be fetched or read (for example,
  an HTML login page). A new registration then leaves nothing. For a style that
  is already registered (`update()`, or `register()` with the same `id`),
  nothing is changed.
- `register()` again with the same spec uses the cache (it works offline).
  `update()` fetches the style and the TileJSON again from upstream, drops the
  resources the style no longer refers to (with their entries), and keeps the
  resources under a TileJSON that could not be fetched (`fetch-failed`).
- When credentials are added to an already registered style by `register()`
  with the same `id` and the saved style is still fresh, the saved body keeps the
  token until it is fetched again (after `cacheTtl`, or by `update()`). That token
  came from the style server and was visible to the page anyway.
- Mapbox `imports` are not followed (`unsupported-source: imports`). Tile URLs
  are used as written (Mapbox GL JS rewrites some `mapbox://` tile URLs, MapLibre
  does not).
- The registration of a style waits for the upstream inside the queue that also
  runs `register`, `update`, `clean` and `remove`, so those calls wait for it.
  `source()`, `sources()` and `stats()` do not wait and can show a style in the
  middle of its registration (some resources, older `warnings`).
  There is no timeout on this wait (no upper limit): failing a slow upstream
  would make the registration itself fail (`invalid-style` or `fetch-failed`).

### `Weiwudi.source(id)`

**Returns:** `Promise<WeiwudiSource>`. Rejects with `source-not-found` when no
source has the id (maps registered with `registerMap` are not listed).

### `Weiwudi.sources()`

**Returns:** `Promise<SourceInfo[]>` in registration order.

```typescript
interface SourceInfo {
  id: string;
  kind: SourceSpec['kind'];
  url: string | string[];      // the real URL without credentials
  resources: ResourceInfo[];   // a copy taken at the time of the call
  warnings: string[];          // a copy taken at register() / update()
}
interface ResourceInfo {
  id: string; type: ResourceType; templates: string[];
  count: number; bytes: number;
  rangeOnly?: true;            // only the range of this source was added (resource-conflict)
  corsless?: true;             // treated as a server without CORS for now
}
type ResourceType = 'style' | 'tilejson' | 'tile' | 'glyph' | 'sprite' | 'data';
```

`ResourceType` may get new values in a minor release. Add a `default` branch to every `switch` on it.

### `Weiwudi.usage()`

**Returns:** `Promise<UsageReport>`, the stored amount in total and per provider.

```typescript
interface UsageReport {
  count: number;   // entries of every resource
  bytes: number;   // their size
  byProvider: Record<string, { count: number; bytes: number }>;
}
```

- Every resource is counted once, including the resources of maps registered
  with `registerMap` (it is the amount stored) and the resources of a style.
- The key of `byProvider` is the provider of the resource (`'mapbox'`, or the
  `id` of a provider added with `addProvider`), otherwise the origin of its first
  URL template (a relative URL of `registerMap` is resolved against the service
  worker). `'unknown'` is used when there is no origin. Provider ids and
  origins share one key space (a provider id equal to an origin adds to the
  same entry).
- `byProvider` has a `null` prototype, so a key such as `__proto__` is an own
  property.

### `Weiwudi.setLimits(limits)`

**Parameters:** `limits: { maxBytes?: number }`. **Returns:** `Promise<void>`.

Sets a global cache limit in bytes for all sources together (maps registered
with `registerMap` included). When a new entry would make the unpinned
entries exceed `maxBytes`, the least recently used unpinned entries are
deleted across sources first. Pinned entries (`fetchRange` with `pin`) are
neither counted nor deleted.

- `maxBytes` is a non-negative finite integer; anything else rejects with
  `attribute-invalid`. `Weiwudi.setLimits({})` removes the limit.
- `maxBytes: 0` means "store nothing": tiles are still served, but none is
  cached (the same as `cacheMaxBytes: 0` on a source). A single response larger
  than `maxBytes` is not cached either.
- The global limit and the `cacheMaxBytes` of each source both apply: an entry
  is saved only after both are satisfied (the source's limit is applied first).
- The limit applies from the next saved entry; setting a lower limit does not
  delete anything at once.
- Independently of `setLimits`, when the browser's storage quota is exceeded
  (`QuotaExceededError`), Weiwudi deletes 10% of the unpinned cached bytes
  (least recently used first, across sources) and retries the save once. If
  the retry also fails, the tile is served with `x-weiwudi-error: quota`.

### `WeiwudiSource`

| Member | Description |
|---|---|
| `id` | Source id |
| `url` | Real URL(s) to pass to the map library (without credentials) |
| `resources` | `ResourceInfo[]`, a copy taken at the time of the call. Read `stats()` or `Weiwudi.source()` again for later changes |
| `warnings` | `string[]`, a copy taken at `register()` / `update()` (it does not change afterwards) |
| `stats()` | `Promise<SourceStats>` |
| `update()` | Rebuilds merging and policies from the saved spec and resets the CORS detection. Rejects with `resource-conflict` (and changes nothing) when its own resources conflict. A style is fetched again instead and never rejects with `resource-conflict` (conflicts go to `warnings`); it rejects with `invalid-style` when the style cannot be read |
| `clean(range?, opts?: { force?: boolean })` | Without a range, releases all regions and deletes entries of exclusive resources. With a range, deletes unpinned tile entries there; `force: true` also deletes pinned tiles and marks overlapping regions `partial`. Shared resources are kept. See [Releasing and cleaning ranges](#releasing-and-cleaning-ranges) |
| `removeResource(resourceId)` | Deletes the cached entries of one resource of this source (for a style, of the resources it registered), **even when the resource is shared with another source or only referred to by range** (`rangeOnly`), because you named it. All glyph records (every fontstack) of a glyph resource are deleted. The resource and its capture stay: the next request fetches and stores it again. Rejects with `resource-not-found` when the source does not refer to that resource id. For a style, the ids it accepts are those of the resources of the children that `remove()` removes (including orphaned children left by an interrupted update) |
| `remove()` | Deletes the registration and its entries and calls `release()`. Entries of a resource that another source still has in its `sourceIds` are kept; a resource whose `sourceIds` becomes empty is deleted with its entries, even when another source still refers to it only by range (`rangeOnly`) |
| `release()` | Removes the page-side listener. Other methods then reject with `instance-released` (a pending `fetchRange()` or `cancel()` is rejected the same way) |
| `estimate(range)` | `Promise<{ tiles: number }>`, the number of tiles `fetchRange(range)` would fetch. See [Range fetching](#range-fetching) |
| `fetchRange(range, opts?)` | Fetches and pins every tile of the range and resolves with the final `RegionInfo` |
| `releaseRange(regionId, opts?: { keep?: boolean })` | `Promise<void>`. Releases a region and deletes entries no remaining pinned region needs; `keep: true` keeps their bodies. Shared resources are kept. See [Releasing and cleaning ranges](#releasing-and-cleaning-ranges) |
| `regions()` | `Promise<RegionInfo[]>`, the regions of this source |
| `cancel()` | Stops the running `fetchRange()` of this source |

```typescript
interface SourceStats {
  count: number;
  size: number;
  total?: number;      // only when the range is known (bounds or box)
  percent?: number;    // same
  byResource: Record<string, { count: number; bytes: number }>;
}
```

When the range is known, `count` is the number of entries inside the range and
`percent` stops at 100. `size` and `byResource` count the whole resources.

### Range fetching

`fetchRange()` fetches every tile of a range through the same path as a captured
request and pins it (`pin: true`, the default), so that it stays available
offline and is never evicted by `cacheMaxBytes` or deleted by `cacheRetention`.
Each run is recorded as a *region*.

```typescript
type RangeSpec =
  | { bounds: [west: number, south: number, east: number, north: number]; minZoom: number; maxZoom: number }
  | { box: TileBox; minZoom: number; maxZoom: number }
  | 'all';

interface FetchRangeOptions {
  pin?: boolean;                               // default true
  concurrency?: number;                        // default 5 (1 to 20)
  glyphRanges?: 'common' | 'all' | string[];   // styles; default 'common'
  fonts?: string[];                            // styles; extra fontstacks
  ratio?: '' | '@2x';                          // value of {ratio}
}

interface RegionInfo {
  id: string; sourceId: string; range: RangeSpec;
  status: 'running' | 'complete' | 'partial' | 'canceled' | 'stopped';
  pinned: boolean; total: number;
  error: number; errors: Record<TileFailure, number>;
  code?: WeiwudiErrorCode;                     // when stopped
  createdAt: number; updatedAt: number;
}
```

- `bounds` is in degrees. Latitudes are clamped to ±85.0511°, and `west > east`
  is a range across the antimeridian. `box` is the x/y range at `maxZoom` **in
  the scheme of the source** (the same coordinates as the `box` of `register`;
  for `scheme: 'tms'` the y axis points up). `minZoom` and `maxZoom` are
  integers from 0 to 30 with `minZoom <= maxZoom`; anything else rejects with
  `attribute-invalid`
- `'all'` is the range of the source **at the time of the call** (for a style,
  the ranges of its tile resources). A later `update()` does not change a
  region. A source without a `box` or `bounds` rejects `'all'` with
  `cannot-fetch-all`
- Only the tiles inside both the range and the registered range of the
  source are fetched. `estimate()` and `RegionInfo.total` count tiles only.
  A style also fetches its non-tile resources; see
  [Range fetching of a style](#range-fetching-of-a-style)
- A source of `kind: 'asset'` accepts `'all'` only (any other range rejects
  with `attribute-invalid`) and fetches and pins its resources. Its
  `estimate()` is `{ tiles: 0 }`
- `ratio` fills `{ratio}`. When it is not given, `fetchRange()` sends `'@2x'`
  if `devicePixelRatio > 1` and `''` otherwise, because the cached key
  includes `@2x` the same way the map library requests it
- `fetchRange()` first asks for persistent storage
  (`navigator.storage.persist()`; it does not wait for the answer, and a refusal
  is ignored. Firefox asks the user and settles the request only after an answer)
- Tiles that are already cached are not requested again; they are only pinned.
  Running the same range again therefore resumes an interrupted run
- Requests are made like `fetch(url)` (`mode: 'cors'`,
  `credentials: 'same-origin'`). The registered `credentials` are added for
  the same sources and origins as for captured requests. **A server of another
  origin that authenticates by cookies only is not supported**
- With no CORS record for the resource yet, a tile that fails with a network
  error is checked once with `mode: 'no-cors'` (without credentials or
  cookies). After 3 opaque results in a row, 5 random tiles of the range are
  fetched again with CORS. If one passes, fetching continues; otherwise the
  run stops with `opaque` (or `network` when every request failed). Other
  opaque results count as `upstream`. With no stored tile yet, three 401 or 403
  responses in a row stop the run with `upstream`
- When the pinned entries of a source reach its `cacheMaxBytes`, the run stops
  with `quota` (checked at the start and after each batch)
- One run at a time in the service worker, shared with the legacy
  `fetchAll()`. Another run rejects with `fetch-busy`. `cancel()` stops only
  the run of its own source and rejects with `no-fetch-process` otherwise. It
  resolves after the run reports `canceled` (the batch already started is
  finished first, so up to `concurrency` tiles are still fetched)
- `fetchRange()` resolves with the `RegionInfo` (`complete`, `partial` or
  `canceled`) and rejects with `WeiwudiError(code)` when the run stops. When no
  event arrives for 30 seconds, the page asks the service worker to resume the
  run (`POST /v2/job/resume`), so a run interrupted by a stopped service worker
  continues. If another run is busy, it rejects with `fetch-busy`
- `regions()` shows a `running` region whose run is no longer active (the
  service worker stopped, or another region is being fetched) as `partial`.
  This does not rewrite its stored status. `clean()` without a range deletes
  the regions of the source after releasing their pins

Events of a `WeiwudiSource` (`addEventListener(type, e => e.detail)`), sent to
the page that called `fetchRange()`:

| type | `detail` |
|---|---|
| `proceed` | `{ type, sourceId, regionId, percent, processed, total, error, errors }` after each batch. `percent` counts tiles only |
| `finish` | `{ type, sourceId, regionId, percent, processed, total, error, errors }` |
| `stop` | `{ type, sourceId, regionId, code, message, processed, total }` |
| `canceled` | `{ type, sourceId, regionId }` |
| `opaque` | `{ type, sourceId, resourceId }`, sent to every page once when a resource is found to have no CORS support (24 hours of no-CORS handling start, or a run stops with `opaque`) |

The shapes follow the legacy `fetchAll()` events, with `sourceId`,
`regionId` and `errors` added.

#### Range fetching of a style

`fetchRange()` of a style source fetches its resources in this order, each
through the same path as a captured request and pinned the same way:

1. The style itself (a cached copy within `cacheTtl` is used as it is). Its `text-font` values
   give fontstacks for the glyphs. If the style cannot be read (HTML, broken
   JSON), only the style counts as `upstream` and the run continues
2. Each TileJSON and data resource (GeoJSON, images) once
3. Each sprite with its four files: `.json`, `.png`, `@2x.json`, `@2x.png`
4. The tiles of every tile resource (also those listed by a TileJSON) inside
   the range. A resource shared by two sources of the style is fetched once
5. The glyphs: every fontstack × every range of `glyphRanges`

- `estimate()`, `RegionInfo.total` and `percent` count tiles only. The other
  resources are counted in `processed`, not in `total`
- `glyphRanges`: `'common'` (the default) is `0-255`, `256-511`, `8192-8447`,
  `12288-12543` and `65280-65535`. `'all'` is the 256 ranges from `0-255` to
  `65280-65535`. An array is used as it is (each item `"<start>-<end>"`)
- The fontstacks are the union of `FetchRangeOptions.fonts`, the `fonts` of
  the registered style and the `text-font` values of the style. **Each item of
  `fonts` is a fontstack**, the value of `{fontstack}`: font names joined by
  `,` (for example `"Open Sans Regular,Arial Unicode MS Regular"`). A single
  font name is one fontstack as it is
- From `text-font`, only a literal array of strings and
  `["literal", [strings…]]` are read. **Fontstacks chosen by an expression
  (`["get", …]`, `["case", …]` and so on) cannot be found**; list them in
  `fonts`
- The ranges of one fontstack are written to its record at once after its
  ranges are fetched. Ranges already in the record are not requested again.
  A failure to write the record counts once per fontstack (`quota` or
  `storage`). `cancel()` keeps the ranges already fetched for the current
  fontstack
- The style, TileJSON, sprite, data and glyph entries are not tied to the
  geometry of a region. Their pins stay while any pinned region of any source
  that refers to the resource remains (style children count as their parent).
  Glyph pins are released per fontstack record, not per glyph range

#### Releasing and cleaning ranges

- `await source.releaseRange(regionId)` deletes that region and releases tiles
  not covered by any remaining pinned region. By default it also deletes their
  entries when the resource is exclusive to this source. Pass `{ keep: true }`
  as the second argument to keep the entries and only remove their pins.
  An unknown region id or one belonging to another source rejects with
  `attribute-invalid` (`attribute: 'regionId'`).
- Overlap is computed geometrically in the resource's tile coordinates, using
  the pinned regions of **every source referring to that resource**, including
  range-only references. A style child is counted as its parent, where its
  regions are stored. `partial` and `canceled` regions still protect entries
  when pinned; a region fetched with `pin: false` does not.
- Non-tile resources (style, TileJSON, sprite, data and glyph) are not released
  by geometry. Their pins are removed only when no referring source has a
  pinned region left. This includes glyph records shared by different styles;
  release operates on whole fontstack records.
- `await source.clean(range)` deletes only unpinned tile entries inside the
  range, using the same range syntax and coordinates as `fetchRange()`. Pins
  are checked again in the deletion transaction. With `{ force: true }` as
  the second argument, pinned tiles are also deleted and this source's
  overlapping regions become `partial`. Regions of other sources are unchanged.
- **Shared resource entries are never deleted by `releaseRange()`, even with
  its default options, or by `clean(range, { force: true })`.** Release only
  removes pins no remaining pinned region needs; range cleaning leaves shared
  entries and their pins untouched. Range cleaning does not delete non-tile
  resources.
- `await source.clean()` releases all of this source's regions, then clears
  entries of exclusive resources. Shared entries stay, with pins retained
  only where other pinned regions need them. `remove()` also releases all
  regions before removing children and the source registration; its resource
  removal rules in the table above still apply.
- `clean()` (with or without a range), `remove()` and `releaseRange()` reject
  with `fetch-busy` while **this source's** job is running. First call
  `await source.cancel()` and wait for its Promise to resolve. Cancellation
  waits for the batch already started: up to `concurrency` tiles, or a style's
  glyph work for one fontstack (up to 256 ranges with `glyphRanges: 'all'`),
  may still need to finish. Another source's job does not block these operations.

### `warnings`

Each entry is `"<code>: <subject>"`. The subject is a resource id (credentials
are already removed), except for the codes below that name a URL or a source of
the style.

| code | Meaning |
|---|---|
| `resource-conflict` | The resource could not be merged with an existing one (different `type`, `scheme` or encoding, wider `credentialParams` while entries exist, or overlapping two resources). It keeps the existing policy; only the range of this source is added. When the source already belonged to that resource (registering the same `id` again), nothing is added either: the resource keeps the old policy and the old range of this source |
| `template-shadowed` | Another registered template matches the same requests and is evaluated first, so this resource is not captured |
| `fetch-failed` | A style: a resource (a TileJSON) could not be fetched and had no cached entry. The subject is its resource id |
| `same-origin-skipped` | A style: a URL of the page's origin referred to by a style or TileJSON of another origin was not registered. The subject is the URL without its query, or the name in the style (`sources.<name>`, `glyphs`, `sprite`, `sprite.<id>`) when its path holds a secret token or it has user info |
| `unsupported-source` | A style: a source that is not registered (`video`, an unknown `type`, a URL that cannot be a template). The subject is `sources.<name>`, `glyphs`, `sprite`, `sprite.<id>` (an item of a `sprite` array) or `imports` |
| `credential-undeclared` | A query item of a template has a value that looks like a token (`pk.`, `tk.`) but its name is not in `credentialParams` (the defaults or the declared ones). The registration succeeds, but the item stays in the cache keys and in `url`. The subject is the query name (the value is not written). Declare the name in `credentialParams` |

Ignore any code you do not know: new codes may be added in a minor release.

### Before every call

The source API first checks that the page is controlled by a service worker
with this API (`GET https://weiwudi.example.com/v2/ping` answering
`{ api: 2, version }`). Nothing is sent when the check fails:

- `sw-not-controlling`: the page is not controlled, the check could not reach
  the service worker, or the controller changed during the check
- `sw-outdated`: the controlling service worker is an older Weiwudi without
  this API (`/v2/ping` is 404), or it answered 200 with a body that is not
  `{ api: 2, version: <non-empty string> }` (reload after the new one activates)

The service worker accepts a control `POST` only from a client (a page or a
worker; a `blob:` worker by the origin inside its URL) of its own origin. A
request from a client of another origin, or from a client it cannot find, is
answered with `sw-not-controlling` and changes nothing. A same-origin `srcdoc`
or `about:blank` iframe (its client URL is `about:srcdoc` or `about:blank`) is
accepted; other clients without an origin (such as `data:`) are not.
`GET /v2/ping` is not checked.

A successful check is remembered for the controlling worker until
`controllerchange`. Control requests are `POST` with
`Content-Type: text/plain;charset=UTF-8` so that no preflight is sent.

### Tile responses: `x-weiwudi-status`

Responses that the service worker builds for captured URLs (and for `map.url`)
carry `x-weiwudi-status`, and `x-weiwudi-error` on failure. Both can be read
from the page because `access-control-expose-headers` lists them.

| `x-weiwudi-status` | Meaning |
|---|---|
| `out-of-range` | Outside the registered range |
| `hit` | Fresh cached entry |
| `miss` | Fetched from upstream (cached when possible) |
| `refresh` | Stale entry replaced by a new upstream response |
| `stale` | Upstream failed; the cached entry was served |
| `upstream-error` | Upstream failed (HTTP) with no cached entry; the upstream status is passed on |
| `offline-miss` | Network failure with no cached entry (404) |

`x-weiwudi-error` is one of `network`, `upstream`, `quota`, `storage`.
Opaque responses (servers without CORS, requested from `<img>`) are never
cached. When no cached entry exists, the opaque response is passed on as is
and carries no header. When an older cached entry exists, that entry is
served instead with `x-weiwudi-status: stale` and `x-weiwudi-error: upstream`.
New values may be added in a minor release.

---

## Errors

### Rejections stay strings

The existing API (`registerSW`, `registerMap`, `retrieveMap`, `removeMap` and the
instance methods) **keeps rejecting with strings**. The messages below are not
changed by a minor release, so `typeof e === 'string'` and `e.match(...)` keep
working. To branch on the cause, convert the string with `WeiwudiError.from`.

### `WeiwudiError.from(value)`

```typescript
import Weiwudi, { WeiwudiError } from '@c4h/weiwudi';

try {
    await Weiwudi.registerMap('my_map', options);
} catch (e) {
    const err = WeiwudiError.from(e); // e is still a string
    if (err.code === 'map-busy') { /* cancel first */ }
    console.log(err.code, err.message, err.detail);
}
```

- Returns a `WeiwudiError` (a subclass of `Error`) with `code`, `message` and
  `detail`. It never throws, whatever value is passed.
- **Only a genuine `Error` is returned as is.** A `WeiwudiError` with the brand
  (including one created by another copy of Weiwudi) is returned even with a
  `code` this version does not know, as long as the code matches
  `/^[a-z][a-z0-9-]*$/`, so a code added by a newer service worker is not turned
  into `internal`. An `Error` rescued only by `name: 'WeiwudiError'` (without
  the brand) must carry a known `code`. Anything else is converted into a
  new `WeiwudiError`. Where `Error.isError` is not available (e.g. Node 22),
  whether a value is a genuine `Error` can only be checked with `instanceof`,
  so an object that inherits the prototype, such as one made with
  `Object.create(WeiwudiError.prototype)`, and is given its own known `code`
  plus either the brand (an own non-enumerable data property) or
  `name: 'WeiwudiError'` may still be returned as is there (a `code` alone is
  not enough; such an object is converted). Only the caller can pass such a crafted object, so
  this is not a security boundary.
- For a known message, `code` is taken from the table below and the inserted
  values go into `detail` as strings (e.g. `map-not-found` → `{ mapID: 'x' }`).
  When an inserted value contains another message and the same string can be
  produced by more than one message, the code of the message with the longer
  fixed text before its first inserted value is used. A message with several
  inserted values is split at the last occurrence of each separator; how the
  values are split into `detail` is not guaranteed in that case.
- Other `"Error: {message}"` strings (wrapped exceptions such as IndexedDB
  errors) are classified by the exception name after `Error: `:
  `QuotaExceededError` → `quota`, `BlockedError` → `db-blocked`, anything else →
  `internal`. Only the `Error: ` prefix and this classification are guaranteed
  for these; the rest of the text may change. For example, when saving the map
  setting in `registerMap` hits the storage quota, real browsers reject with
  `Error: QuotaExceededError` (often followed by `: ` and a description).
- An `Error` or `DOMException` is classified by its `name` the same way. Any
  other value (including objects that only have a `name`) becomes `internal`
  with `String(value)` as the message (`[unprintable]` if it cannot be
  converted). A value that throws while being read also becomes `internal`.

**Codes with a fixed message:**

| code | Message (unchanged) |
|---|---|
| `sw-unsupported` | `Error: Service worker is not supported` |
| `sw-register-failed` | `Error: Service worker registration failed with {error}` |
| `sw-not-controlling` | `Error: Service worker did not control this page within 10000 ms` |
| `sw-not-implemented` | `Weiwudi service worker is not implemented.` |
| `map-id-required` | `MapID is necessary.` |
| `instance-released` | `This instance is already released.` |
| `attribute-missing` | `Error: Attribute "{target}" is missing` |
| `attribute-invalid` | `Error: Attribute "cacheMaxBytes" is not a valid non-negative integer` |
| `unknown-type` | `Error: Unknown "type" value` |
| `map-not-found` | `Error: MapID "{mapID}" not found` |
| `map-busy` | `Error: {mapID} is under fetching process. Please cancel it first` |
| `no-fetch-process` | `Error: There are no fetching process of {mapID}` |
| `cache-path-invalid` | `Error: "cache" api needs mapID, zoom, x, y settings` |
| `cannot-fetch-all` | `Error: Map "{mapID}" cannot fetch all tiles` |
| `fetch-busy` | `Error: Another fetching process is running: "{mapID}" ({count} / {total})` |
| `api-not-found` | `Error: API {apiName} not found` |

**Other codes:** `db-blocked`, `quota`, `internal` (from wrapped exceptions, see
above) and `network`, `upstream`, `storage` (tile failures, see below).
The source API also rejects with `storage` (`detail.name` is the exception
name) when IndexedDB fails with an exception that is not `quota` or
`db-blocked`. Other exceptions stay `internal`.

**Codes of the source API** (rejected as `WeiwudiError`, see [Source API](#source-api)):
`unsupported-template` and `credential-rejected` (`register`),
`invalid-style` (`register` and `update()` of a style that cannot be read),
`sw-outdated` (the controlling service worker lacks the source API),
`source-not-found` (`source()` and the `WeiwudiSource` methods for an unknown id),
`resource-conflict` (`update()` only; `register()` writes it to `warnings`),
`resource-not-found` (`removeResource()` with a resource id the source does not refer to),
`opaque` (`fetchRange()` stopped because the upstream has no CORS support).
The source API also uses `attribute-invalid`, `sw-not-controlling`,
`instance-released`, `api-not-found`, `fetch-busy` (another range fetching
or `fetchAll()` is running), `no-fetch-process` (`cancel()` with nothing to
cancel) and `cannot-fetch-all` (`'all'` for a source without a range) from the
table above, with its own messages, and `network`, `upstream`, `quota` as the
code of a stopped `fetchRange()`.

`unsupported-kind` stays in the type but is no longer produced (every `kind` is
handled).

`WeiwudiErrorCode` may get new values in a minor release. Add a `default` branch to every `switch` on it.

### Tile responses: `x-weiwudi-error`

A tile served through `map.url` keeps its status and body, and carries the
response header `x-weiwudi-error` when fetching or caching failed. A
successful upstream response (any 2xx) is served as `200 OK`, as the legacy
API has always done; the body is unchanged:

| Situation | Response | `x-weiwudi-error` |
|---|---|---|
| Network error, no cached tile | 404 | `network` |
| Network error, cached tile | 200, cached tile | `network` |
| Upstream returned a non-OK status, no cached tile | upstream status | `upstream` |
| Upstream returned a non-OK status, cached tile | 200, cached tile | `upstream` |
| Fetched but saving hit the storage quota | 200, fetched tile | `quota` |
| Fetched but saving failed otherwise | 200, fetched tile | `storage` |

The header is absent when the tile was served and cached normally.

When saving hits the storage quota, Weiwudi first deletes 10% of the unpinned
cached bytes (least recently used first) and retries once; `quota` is reported
only when the retry also fails (see `Weiwudi.setLimits`).

---

## WeiwudiOptions Interface

Configuration options for map registration.

### For XYZ Tile Maps

```typescript
{
    type: 'xyz',
    url: string,           // URL template with {z}, {x}, {y} placeholders
    width: number,         // Map width in pixels
    height: number,        // Map height in pixels
    tileSize?: number,     // Tile size (default: 256)
    cacheTtl?: number      // Tile cache lifetime in ms (default: 86400000, i.e. 24h)
    cacheMaxBytes?: number // Cache capacity limit in bytes (unlimited if omitted)
}
```

### For WMTS Tile Maps

```typescript
{
    type: 'wmts',
    url: string,           // URL template with {z}, {x}, {y} placeholders
    minLat: number,        // Minimum latitude
    maxLat: number,        // Maximum latitude
    minLng: number,        // Minimum longitude
    maxLng: number,        // Maximum longitude
    minZoom: number,       // Minimum zoom level
    maxZoom?: number,      // Maximum zoom level (unlimited if omitted)
    cacheTtl?: number      // Tile cache lifetime in ms (default: 86400000, i.e. 24h)
    cacheMaxBytes?: number // Cache capacity limit in bytes (unlimited if omitted)
}
```

**Notes:**
- `maxZoom`: when omitted, tile requests are not rejected at any zoom level
  (treated as unlimited). Leave it unset for maps without a known maximum
  zoom.
- `cacheTtl`: controls how long a cached tile is served before Weiwudi
  re-fetches it from `url`. If the re-fetch succeeds but writing the new
  tile to the cache fails (e.g. storage quota exceeded), the freshly fetched
  tile is still served to the caller.
- `cacheMaxBytes`: limits the total size (in bytes) of cached tiles for this
  map. When the limit is reached, the least-recently-used tiles are evicted.
  When `cacheMaxBytes` is `0` or a single tile exceeds the limit, the tile
  response is still delivered to the caller but not cached. When omitted, no
  capacity limit is applied. Must be a non-negative integer; otherwise
  `registerMap` rejects with `Error: Attribute "cacheMaxBytes" is not a valid non-negative integer`
  and the map is not registered.

---

## See also

- [API index](README.md) — install / quick start / ecosystem
- [Main README](../README.md) — install / quick start / ecosystem
