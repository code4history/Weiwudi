# Weiwudi (魏武帝:TileCacheServiceWorker)
[![CI](https://github.com/code4history/Weiwudi/actions/workflows/ci.yml/badge.svg)](https://github.com/code4history/Weiwudi/actions/workflows/ci.yml)
Service worker for tile cache.  
Project name is named from [魏武帝(Weiwudi)](https://zh.wikipedia.org/wiki/%E6%9B%B9%E6%93%8D), who was originally named as 曹操(Cao Cao), and was Chinese warload of the Eastern Han dynasty.

日本語のREADMEは[こちら](./README.ja.md)

## Requirements

- **Node.js**: >= 20.0.0
- **Package Manager**: pnpm >= 9.0.0 (recommended) or npm

## Live Demo

Try the interactive demo to see Weiwudi in action:

```bash
pnpm install
pnpm dev
```

Then open `http://localhost:5173/` in your browser. The demo features:
- 🗺️ Leaflet map with OSM tiles cached via Weiwudi
- 📊 Real-time cache statistics (tile count, cache size)
- 🔄 Fetch all tiles button
- 🗑️ Clear cache functionality

## Testing

Run the E2E test suite powered by Playwright:

```bash
pnpm run test:e2e
```

The tests verify:
- Service Worker registration and activation
- Tile caching behavior
- Cache statistics retrieval
- Cache clearing functionality

## Installation

### NPM Package

Install using **pnpm** (recommended):

```bash
pnpm add @c4h/weiwudi
```

Or using npm:

```bash
npm install @c4h/weiwudi
```

### Peer Dependencies

Weiwudi requires `workbox-routing` as a peer dependency. Install it alongside:

```bash
pnpm add workbox-routing
```

### Browser (CDN)

For browser usage without a build tool, you can load Weiwudi via CDN:

```html
<!-- Load Weiwudi main library -->
<script src="https://cdn.jsdelivr.net/npm/@c4h/weiwudi@0.2.0/dist/weiwudi.umd.js"></script>
```

For the service worker file, use:

```js
// In your service worker (sw.js)
importScripts("https://cdn.jsdelivr.net/npm/workbox-routing@7.4.0/build/workbox-routing.prod.umd.min.js");
importScripts("https://cdn.jsdelivr.net/npm/@c4h/weiwudi@0.2.0/dist/weiwudi-sw.umd.js");
```

## How to use

### Service worker side
Call this js with workbox in your service worker.
```js
importScripts("https://cdn.jsdelivr.net/npm/workbox-routing@7.4.0/build/workbox-routing.prod.umd.min.js");
importScripts("https://cdn.jsdelivr.net/npm/@c4h/weiwudi@0.2.0/dist/weiwudi-sw.umd.js");
```

### Front logic side
```js
import Weiwudi from '@c4h/weiwudi';

try {
    // Register service worker
    await Weiwudi.registerSW('./sw.js', {scope: './'});
    // Register map setting to service worker
    // XYZ map case
    const map1 = await Weiwudi.registerMap('xyz_map', {
        type: 'xyz',
        width: 10000,
        height: 6000,
        url: 'http://example.com/{z}/{x}/{y}.jpg'
    });
    // WMTS map case
    const map2 = await Weiwudi.registerMap('wmts_map', {
        type: 'wmts',
        minLat: 35.0,
        maxLat: 35.1,
        minLng: 135.0,
        maxLng: 135.1,
        minZoom: 17,
        maxZoom: 18,
        url: 'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png'
    });

    // Get url template of cached map
    const map1_url = map1.url;
    const map2_url = map2.url;

    // If map API access to map tile by using above url template,
    // Tile images are automatically cached in indexedDB.

    // Get current caching status
    const status = await map1.stats();

    // Fetch all tiles
    map2.addEventListener('proceed', (e) => {
        // Write some codes for handling event of proceeding to fetch tiles
    });
    map2.addEventListener('finish', (e) => {
        // Write some codes for handling event of finishing to fetch tiles
    });
    map2.addEventListener('stop', (e) => {
        // Write some codes for handling event of stopping to fetch tiles by some errors
    });
    // Start fetching 
    await map2.fetchAll();

    // Clean all cached tile images
    await map2.clean();

    // Remove registered map setting
    await map2.remove();


} catch(e) {
    // For error cases (E.g. browser doesn't support service worker) 
    ...
}
```

## API Reference

### Static Methods

#### `Weiwudi.registerSW(sw, swOptions?)`

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

#### `Weiwudi.registerMap(mapID, options)`

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

#### `Weiwudi.retrieveMap(mapID)`

Retrieve an existing registered map configuration.

**Parameters:**
- `mapID` (string): Unique identifier for the map

**Returns:** `Promise<Weiwudi>` - A Weiwudi instance for the retrieved map

**Throws:** 
- `"Weiwudi service worker is not implemented."`: When service worker is not active
- `"Error: {message}"`: When map retrieval fails

---

#### `Weiwudi.removeMap(mapID)`

Remove a registered map configuration.

**Parameters:**
- `mapID` (string): Unique identifier for the map to remove

**Returns:** `Promise<void>`

**Throws:** 
- `"Weiwudi service worker is not implemented."`: When service worker is not active
- `"Error: {message}"`: When map removal fails

---

### Instance Methods

#### `stats()`

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

#### `clean()`

Clear all cached tiles for this map.

**Returns:** `Promise<void>`

**Throws:** 
- `"This instance is already released."`: When called on a released instance
- `"Error: {message}"`: When cache cleaning fails

---

#### `fetchAll()`

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

#### `cancel()`

Cancel an ongoing `fetchAll()` operation.

**Returns:** `Promise<void>`

**Throws:** 
- `"This instance is already released."`: When called on a released instance
- `"Error: {message}"`: When cancellation fails

---

#### `remove()`

Remove the map registration and release this instance. After calling this method, the instance cannot be used.

**Returns:** `Promise<void>`

**Throws:** 
- `"This instance is already released."`: When called on a released instance

---

### Instance Properties

#### `url`

**Type:** `string`

The URL template for accessing cached tiles. Use this URL in your map library (e.g., Leaflet, OpenLayers).

**Example:**
```js
const map = await Weiwudi.registerMap('my_map', {...});
L.tileLayer(map.url).addTo(leafletMap);
```

---

### Events

Weiwudi instances extend `WeiwudiEventTarget` and support the following events:

#### `proceed`

Fired periodically during a `fetchAll()` operation to report progress.

**Event Detail:**
- `mapID` (string): Map identifier
- Additional progress information

---

#### `finish`

Fired when a `fetchAll()` operation completes successfully.

**Event Detail:**
- `mapID` (string): Map identifier

---

#### `stop`

Fired when a `fetchAll()` operation stops due to an error or cancellation.

**Event Detail:**
- `mapID` (string): Map identifier
- Error information

---

### WeiwudiOptions Interface

Configuration options for map registration.

#### For XYZ Tile Maps

```typescript
{
    type: 'xyz',
    url: string,           // URL template with {z}, {x}, {y} placeholders
    width: number,         // Map width in pixels
    height: number,        // Map height in pixels
    tileSize?: number      // Tile size (default: 256)
}
```

#### For WMTS Tile Maps

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

## Build

### Development

Run the development server with hot reload:

```bash
pnpm dev
```

### Production Build

Build the library for production:

```bash
pnpm build
```

This generates:
- `dist/weiwudi.es.js` - ES module for modern bundlers
- `dist/weiwudi.umd.js` - UMD bundle for browsers
- `dist/weiwudi-sw.es.js` - Service worker ES module
- `dist/weiwudi-sw.umd.js` - Service worker UMD bundle
- `dist/weiwudi.d.ts` - TypeScript type definitions

---

## License

Copyright (c) 2020-2026 Code for History

Licensed under the [MIT License](LICENSE).

