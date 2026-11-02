# Weiwudi

The main class of `@c4h/weiwudi`. Instances are created via `Weiwudi.registerMap`
and expose tile-cache operations for a registered map.

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
  This also counts failures of other tile requests served while `fetchAll()` is running
- Additional progress information

---

### `finish`

Fired when a `fetchAll()` operation completes successfully.

**Event Detail:**
- `mapID` (string): Map identifier
- `error` (number): Number of failed tiles (total)
- `errors` (object): Failed tiles by kind: `{ network, upstream, quota, storage }`.
  This also counts failures of other tile requests served while `fetchAll()` is running

---

### `stop`

Fired when a `fetchAll()` operation stops due to an error or cancellation.

**Event Detail:**
- `mapID` (string): Map identifier
- `reason`: The error that stopped the operation
- `code` (string): `WeiwudiError.from(reason).code` (see [Errors](#errors))

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
  `Object.create(WeiwudiError.prototype)`, and is given a `code` may still be
  returned as is there. Only the caller can pass such a crafted object, so
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

**Codes reserved for the upcoming API:** `unsupported-template`, `invalid-style`,
`opaque`, `sw-outdated`, `credential-rejected`, `source-not-found`,
`resource-conflict`. They are part of the `WeiwudiErrorCode` type but are not
produced yet.

**New codes may be added in a minor release.** When you `switch` on `code`,
always keep a `default` branch.

### Tile responses: `x-weiwudi-error`

A tile served through `map.url` keeps its status and body, and carries the
response header `x-weiwudi-error` when fetching or caching failed:

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
