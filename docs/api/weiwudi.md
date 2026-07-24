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

**Throws:**
- `"Error: Service worker is not supported"`: When the browser doesn't support service workers
- `"Error: Service worker registration failed with {error}"`: When registration fails

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
- Additional progress information

---

### `finish`

Fired when a `fetchAll()` operation completes successfully.

**Event Detail:**
- `mapID` (string): Map identifier

---

### `stop`

Fired when a `fetchAll()` operation stops due to an error or cancellation.

**Event Detail:**
- `mapID` (string): Map identifier
- Error information

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
    tileSize?: number      // Tile size (default: 256)
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
    maxZoom: number        // Maximum zoom level
}
```

---

## See also

- [API index](README.md) — install / quick start / ecosystem
- [Main README](../README.md) — install / quick start / ecosystem
