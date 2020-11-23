# Weiwudi (TileCacheServiceWorker)
Service worker for tile cache

## How to use

### Service worker side
Call this js with workbox in your service worker.
```js
importScripts("https://storage.googleapis.com/workbox-cdn/releases/5.1.4/workbox-sw.js");
importScripts("https://cdn.jsdelivr.net/npm/weiwudi@0.0.2/src/weiwudi_sw.js");
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





### Ping
*Request:*
```
https://weiwudi.example.com/api/ping
```
*Redponse:*
```
Implemented
```

### Add map setting (XYZ)
*Request:*
```
https://weiwudi.example.com/api/add?
```
*Redponse:*
```
Implemented
```

