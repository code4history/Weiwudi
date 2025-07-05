# Weiwudi (魏武帝:TileCacheServiceWorker)

Service worker for tile cache with vector tile (MVT) support.  
Project name is named from [魏武帝(Weiwudi)](https://zh.wikipedia.org/wiki/%E6%9B%B9%E6%93%8D), who was originally named as 曹操(Cao Cao), and was Chinese warlord of the Eastern Han dynasty.

## Features

- **Raster & Vector Tile Support**: Cache both traditional raster tiles and Mapbox Vector Tiles (MVT)
- **Multiple Tile Formats**: Support for XYZ and WMTS tile schemes
- **Offline Capability**: Full offline map support with IndexedDB caching
- **Selective Caching**: Cache tiles by geographic bounds and zoom levels
- **Storage Management**: Built-in quota management and cache cleanup
- **No Page Reload**: Service Worker activates immediately without requiring page reload
- **Asset Caching**: Cache vector tile assets (styles, fonts, sprites)

## Installation

### npm

```sh
npm install @c4h/weiwudi@1.0.0
```

### Browser (CDN)

```html
<script src="https://unpkg.com/@c4h/weiwudi@1.0.0/dist/weiwudi.umd.js"></script>
```

## Usage

### Service Worker Setup

Create a service worker file (`sw.js`):

```js
importScripts("https://storage.googleapis.com/workbox-cdn/releases/7.3.0/workbox-sw.js");
importScripts("https://unpkg.com/@c4h/weiwudi@1.0.0/dist/weiwudi_sw.js");
```

### Client-Side Implementation

```typescript
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
    map2.addEventListener('progress', (e) => {
        console.log(`Progress: ${e.detail.success}/${e.detail.total} tiles`);
    });
    map2.addEventListener('finished', (e) => {
        console.log('Fetch completed');
    });
    
    // Fetch all tiles (XYZ only)
    await map1.fetchAll();
    
    // Fetch tiles in specific range (WMTS)
    await map2.fetchAll({
        minZoom: 17,
        maxZoom: 18,
        minLng: 135.0,
        maxLng: 135.05,
        minLat: 35.0,
        maxLat: 35.05
    });

    // Clean all cached tile images
    await map2.clean();
    
    // Clean tiles in specific range (WMTS only)
    await map2.clean({
        minZoom: 17,
        maxZoom: 18,
        minLng: 135.0,
        maxLng: 135.05,
        minLat: 35.0,
        maxLat: 35.05
    });

    // Remove registered map setting
    await map2.remove();


    // Vector Tile Support (MVT)
    const vectorMap = await Weiwudi.registerMap('vector_map', {
        type: 'wmts',
        minLat: 35.0,
        maxLat: 36.0,
        minLng: 135.0,
        maxLng: 136.0,
        minZoom: 0,
        maxZoom: 14,
        url: 'https://example.com/tiles/{z}/{x}/{y}.mvt'
    });
    
    // Register vector tile assets
    await vectorMap.registerVectorTileAssets({
        definition: 'https://example.com/style.json',
        styles: 'https://example.com/styles',
        fonts: 'https://example.com/fonts/{fontstack}/{range}.pbf',
        icons: 'https://example.com/sprite'
    });
    
    // Get cached asset URLs
    const definitionUrl = vectorMap.getDefinitionUrl();
    const stylesUrl = vectorMap.getStylesUrl();
    const fontsUrl = vectorMap.getFontsUrl();
    const iconsUrl = vectorMap.getIconsUrl();

} catch(e) {
    console.error('Error:', e);
}
```

## API Reference

### Static Methods

#### `Weiwudi.registerSW(scriptURL, options?)`
Register the service worker.

#### `Weiwudi.registerMap(mapID, options)`
Register a new map configuration.

#### `Weiwudi.retrieveMap(mapID)`
Retrieve an existing map configuration.

#### `Weiwudi.removeMap(mapID)`
Remove a map configuration.

### Instance Methods

#### `map.stats()`
Get cache statistics including tile count and storage size.

#### `map.clean(range?)`
Clean cached tiles. Optional range parameter for WMTS maps.

#### `map.fetchAll(range?)`
Fetch all tiles. Range parameter required for WMTS maps.

#### `map.cancel()`
Cancel ongoing fetch operation.

#### `map.registerVectorTileAssets(options)`
Register URLs for vector tile assets (definition, styles, fonts, icons).

#### `map.release()`
Release the map instance and clean up event listeners.

## Storage Quota

Weiwudi automatically manages storage quota:
- Default quota: 500MB per origin
- Automatic quota checking before caching
- Falls back to cached tiles when quota exceeded

## Browser Support

- Chrome/Edge: Full support
- Firefox: Full support  
- Safari: Requires iOS 11.3+ / macOS 10.13.4+

## License

MIT License

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments

Built with [Workbox](https://developers.google.com/web/tools/workbox) by Google.

