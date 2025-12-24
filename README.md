# Weiwudi (魏武帝:TileCacheServiceWorker)
[![CI](https://github.com/code4history/Weiwudi/actions/workflows/ci.yml/badge.svg)](https://github.com/code4history/Weiwudi/actions/workflows/ci.yml)
Service worker for tile cache.  
Project name is named from [魏武帝(Weiwudi)](https://zh.wikipedia.org/wiki/%E6%9B%B9%E6%93%8D), who was originally named as 曹操(Cao Cao), and was Chinese warload of the Eastern Han dynasty.

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

## How to use

### Service worker side
Call this js with workbox in your service worker.
```js
importScripts("https://storage.googleapis.com/workbox-cdn/releases/6.0.2/workbox-sw.js");
importScripts("https://cdn.jsdelivr.net/npm/weiwudi@0.1.4/src/weiwudi_sw.js");
```

### Front logic side
```js
import Weiwudi from 'weiwudi';

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

