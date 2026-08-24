<!-- SECTION 1: Header (badges, title) -->
<h1 align="center">Weiwudi</h1>

<p align="center">
  <a href="https://github.com/code4history/Weiwudi/actions/workflows/ci.yml"><img src="https://github.com/code4history/Weiwudi/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@c4h/weiwudi" alt="License" /></a>
</p>

<!-- SECTION 2: Elevator Pitch -->
## About Weiwudi

Weiwudi is a service worker for tile cache. It registers map configurations and
caches tile images in IndexedDB, so any map library (Leaflet, OpenLayers, etc.)
can read tiles through the cached URL template without modification.
The project name comes from
[魏武帝 (Weiwudi)](https://zh.wikipedia.org/wiki/%E6%9B%B9%E6%93%8D), originally
known as 曹操 (Cao Cao), a warlord of the Eastern Han dynasty.

Weiwudi is open-source under the MIT License.

<!-- SECTION 3: Language switch link -->
**[Read this document in Japanese / 日本語で読む](README.ja.md)**

<!-- SECTION 4: Key Features -->
## Key Features

- Service-worker-based tile cache for XYZ and WMTS tile maps
- Automatic tile caching in IndexedDB via a cached URL template
- Bulk prefetch (`fetchAll`) with progress events (`proceed` / `finish` / `stop`)
- Works with any map library (Leaflet, OpenLayers, etc.) through the URL template
- Open-source (MIT) with a peer dependency on `workbox-routing`

<!-- SECTION 5: Quick Start -->
## Quick Start

<!-- release-pinned:start -->
> **Current release: `1.0.0`**. This block is the only place in
> this repository that carries a release version (ADR-0012); everything outside it is
> written against the 1.0 release.
> npm: [`@c4h/weiwudi`](https://www.npmjs.com/package/@c4h/weiwudi)
> [![npm](https://img.shields.io/npm/v/@c4h/weiwudi)](https://www.npmjs.com/package/@c4h/weiwudi)

### Install

```bash
# pnpm (recommended)
pnpm add @c4h/weiwudi

# npm
npm install @c4h/weiwudi
```

### Minimal usage

```typescript
import Weiwudi from '@c4h/weiwudi';

// Register the service worker
await Weiwudi.registerSW('./sw.js', { scope: './' });

// Register an XYZ tile map
const map = await Weiwudi.registerMap('xyz_map', {
  type: 'xyz',
  width: 10000,
  height: 6000,
  url: 'http://example.com/{z}/{x}/{y}.jpg'
});

// Read tiles through the cached URL template
L.tileLayer(map.url).addTo(leafletMap);
```

### CDN (jsDelivr)

For browser usage without a build tool, load Weiwudi via CDN:

```html
<!-- Weiwudi main library -->
<script src="https://cdn.jsdelivr.net/npm/@c4h/weiwudi@1.0.0/dist/weiwudi.umd.js"></script>
```

For the service worker file:

```js
// In your service worker (sw.js)
importScripts("https://cdn.jsdelivr.net/npm/workbox-routing@7.4.0/build/workbox-routing.prod.umd.min.js");
importScripts("https://cdn.jsdelivr.net/npm/@c4h/weiwudi@1.0.0/dist/weiwudi-sw.umd.js");
```

### API reference

- **API signatures** (release-dependent): see [`docs/api/`](docs/api/)

### Development

#### Setup
Clone the repository and install dependencies.

```bash
git clone https://github.com/code4history/Weiwudi.git
cd Weiwudi
pnpm install
```

#### Development Server
Start the development server with hot reload.

```bash
pnpm dev
```

Access `http://localhost:5173/` in your browser. The demo features:
- Leaflet map with OSM tiles cached via Weiwudi
- Real-time cache statistics (tile count, cache size)
- Fetch all tiles button
- Clear cache functionality

#### Build

```bash
pnpm build
```

This generates:
- `dist/weiwudi.es.js` - ES module for modern bundlers
- `dist/weiwudi.umd.js` - UMD bundle for browsers
- `dist/weiwudi-sw.es.js` - Service worker ES module
- `dist/weiwudi-sw.umd.js` - Service worker UMD bundle
- `dist/weiwudi.d.ts` - TypeScript type definitions

#### Test

```bash
pnpm run test:e2e
```

The tests verify:
- Service Worker registration and activation
- Tile caching behavior
- Cache statistics retrieval
- Cache clearing functionality
<!-- release-pinned:end -->

<!-- SECTION 6: Prerequisites -->
## Prerequisites

> Derived from the `engines` field in `package.json` (ADR-0012: release-dependent).

- Node.js: `>= 20.0.0`
- pnpm: `>= 9.0.0` (recommended; npm also works)

<!-- SECTION 7: Peer Dependencies -->
## Peer Dependencies

Weiwudi requires `workbox-routing` as a peer dependency. Install it alongside:

```bash
pnpm add workbox-routing
```

<!-- SECTION 8: Ecosystem / Related Repositories -->
## Ecosystem

Weiwudi is part of the Maplat ecosystem by [Code for History](https://github.com/code4history).
See the full ecosystem map (8 repositories + product/corporate sites):

📖 **Ecosystem Map** — *(the diagram is currently kept in a private planning
repository; the Sister repositories table below is the public substitute)*

### Sister repositories

| Repository | License | npm | Role |
|---|---|---|---|
| [Maplat](https://github.com/code4history/Maplat) | Apache 2.0 | `@maplat/ui` | Main viewer |
| [MaplatCore](https://github.com/code4history/MaplatCore) | Apache 2.0 | `@maplat/core` | Core library |
| [MaplatTin](https://github.com/code4history/MaplatTin) | Apache 2.0 | `@maplat/tin` | TIN conversion |
| [MaplatTransform](https://github.com/code4history/MaplatTransform) | Apache 2.0 | `@maplat/transform` | Coordinate transform |
| [MaplatEditor](https://github.com/code4history/MaplatEditor) | Apache 2.0 | — | Data authoring tool (desktop) |
| [Chuci](https://github.com/code4history/Chuci) | MIT | `@c4h/chuci` | Multimedia swiper & viewer Web Components |
| [Quyuan](https://github.com/code4history/Quyuan) | MIT | `@c4h/quyuan` | GeoJSON template engine + multimedia viewer Web Components |
| [Weiwudi](https://github.com/code4history/Weiwudi) | MIT | `@c4h/weiwudi` | Service Worker for tile cache |

> MaplatEditor is the data authoring tool used to create the maps and POIs
> that the viewers above render. The Maplat ecosystem is end-to-end:
> author with MaplatEditor, serve with any of the viewer libraries.

<!-- SECTION 9: Nayuta links -->
<!-- MIT-licensed repositories (Weiwudi / Quyuan / Chuci) carry no Nayuta link (ADR-0012). -->

<!-- SECTION 10: License -->
## License

MIT License — see [LICENSE](LICENSE).

```
Copyright (c) 2020-2026 Code for History

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

<!-- SECTION 11: Contributors / Sponsors (optional) -->
<!-- Weiwudi has no Contributors / Sponsors section. -->
