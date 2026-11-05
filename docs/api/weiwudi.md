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

**Example:**
```js
const map = await Weiwudi.registerMap('my_map', {
    type: 'xyz',
    width: 10000,
    height: 6000,
    url: 'https://example.com/{z}/{x}/{y}.jpg'
});
```

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

Only Chromium is tested. WebKit and Firefox are not verified yet.

### `Weiwudi.register(spec)`

Register a source. Calling it again with the same spec is idempotent.

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

- `url`: one template or an array of mirrors. Tokens: `{z}` `{x}` `{y}` `{-y}`
  `{quadkey}` `{ratio}` `{prefix}`. A relative URL is resolved against the page.
- `id`: defaults to the normalized first template. An explicit `id` is a public
  value (the key of `source()`, the `id` of `sources()`, and `warnings`): **do not
  put credentials in it**. It must be a non-empty string without `\0` and must not
  start with `map:` (reserved for maps registered with `registerMap`).
- **`kind: 'style'` and `kind: 'asset'` are rejected with `unsupported-kind` in this
  version.**
- Out-of-range tiles are a transparent PNG (raster) or an empty 200 body (vector)
  by default. Use `outOfRange: { zoom: 'not-found' }` to get a 404 outside the zoom range.

**Returns:** `Promise<WeiwudiSource>`

**Rejects with `WeiwudiError`:**
- `attribute-invalid`: a malformed attribute, an `id` starting with `map:`, empty
  or containing `\0`, a template with user info (`user:pass@`), or mirrors that
  carry different values for the same credential parameter (names compared
  case-insensitively; register each mirror as its own source; names in an
  explicit `credentials.query` are not compared)
- `unsupported-template`: an unsupported token, a URL that cannot be resolved
  or is not `http:` / `https:` (relative URLs are resolved against the page
  first), or a template on `weiwudi.example.com`
- `unsupported-kind`: `style` or `asset` (not handled by this version)
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
- Query items whose name or value starts with `sk.` are not put in cache keys.
- **A resource id is never rewritten.** The id of a resource first created by a
  source that does not declare a `credentialParams` item keeps that item. Declare
  credential query items in the source you register first.
- When a source with an explicit `credentials.query` is registered later onto a
  resource that already has entries, it gets `resource-conflict` (the key shape
  would change).

A resource that cannot be merged with an existing one does **not** make
`register()` fail. The source is saved and `warnings` gets
`resource-conflict: <resource id>`.

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

### `WeiwudiSource`

| Member | Description |
|---|---|
| `id` | Source id |
| `url` | Real URL(s) to pass to the map library (without credentials) |
| `resources` | `ResourceInfo[]`, a copy taken at the time of the call. Read `stats()` or `Weiwudi.source()` again for later changes |
| `warnings` | `string[]`, a copy taken at `register()` / `update()` (it does not change afterwards) |
| `stats()` | `Promise<SourceStats>` |
| `update()` | Rebuilds merging and policies from the saved spec and resets the CORS detection. Rejects with `resource-conflict` (and changes nothing) when its own resources conflict |
| `clean()` | Deletes cached entries. Entries of resources shared with another source are kept |
| `remove()` | Deletes the registration and its entries and calls `release()`. Entries of a resource that another source still has in its `sourceIds` are kept; a resource whose `sourceIds` becomes empty is deleted with its entries, even when another source still refers to it only by range (`rangeOnly`) |
| `release()` | Removes the page-side listener. Other methods then reject with `instance-released` |

```typescript
interface SourceStats {
  count: number;
  size: number;
  total?: number;      // only when the range is known (bounds or box)
  percent?: number;    // same
  byResource: Record<string, { count: number; bytes: number }>;
}
```

### `warnings`

Each entry is `"<code>: <subject>"`. The subject is a resource id (credentials
are already removed).

| code | Meaning |
|---|---|
| `resource-conflict` | The resource could not be merged with an existing one (different `type`, `scheme` or encoding, wider `credentialParams` while entries exist, or overlapping two resources). It keeps the existing policy; only the range of this source is added. When the source already belonged to that resource (registering the same `id` again), nothing is added either: the resource keeps the old policy and the old range of this source |
| `template-shadowed` | Another registered template matches the same requests and is evaluated first, so this resource is not captured |

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
- **Only a genuine `Error` that carries a known `code` is returned as is**: a
  `WeiwudiError`, including one created by another copy of Weiwudi (or an
  `Error` whose `name` is `'WeiwudiError'`). Anything else is converted into a
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

**Codes of the source API** (rejected as `WeiwudiError`, see [Source API](#source-api)):
`unsupported-template` and `credential-rejected` (`register`),
`unsupported-kind` (`register` with `kind: 'style'` or `'asset'` in this version),
`sw-outdated` (the controlling service worker lacks the source API),
`source-not-found` (`source()` and the `WeiwudiSource` methods for an unknown id),
`resource-conflict` (`update()` only; `register()` writes it to `warnings`).
The source API also uses `attribute-invalid`, `sw-not-controlling`,
`instance-released` and `api-not-found` from the table above, with its own messages.

**Codes reserved for the upcoming API:** `invalid-style`, `opaque`.
They are part of the `WeiwudiErrorCode` type but are not produced yet.

**New codes may be added in a minor release.** When you `switch` on `code`,
always keep a `default` branch.

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
