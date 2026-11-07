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
- First-visit proxy activation (`skipWaiting` + `clients.claim`) without a page reload
- Per-map cache capacity limit (`cacheMaxBytes`) with least-recently-used eviction
- Bulk prefetch (`fetchAll`) with progress events (`proceed` / `finish` / `stop`)
- Works with any map library (Leaflet, OpenLayers, etc.) through the URL template
- Source API (`Weiwudi.register`) that caches the real tile URLs the map library already requests
- Open-source (MIT) with a peer dependency on `workbox-routing`

<!-- SECTION 5: Quick Start -->
## Quick Start

<!-- release-pinned:start -->
> **Current release: `1.1.1`**. This block is the only place in
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

// Register the service worker (resolves once the page is controlled,
// from the first visit, without a reload)
await Weiwudi.registerSW('./sw.js', { scope: './' });

// Register an XYZ tile map
const map = await Weiwudi.registerMap('xyz_map', {
  type: 'xyz',
  width: 10000,
  height: 6000,
  url: 'http://example.com/{z}/{x}/{y}.jpg',
  cacheMaxBytes: 500 * 1024 * 1024 // cache capacity limit in bytes (optional)
});

// Read tiles through the cached URL template
L.tileLayer(map.url).addTo(leafletMap);
```

`registerSW` resolves only after the service worker controls the current page
(no reload on first visit). If the page cannot be controlled, it rejects with
`"Error: Service worker did not control this page within 10000 ms"` (e.g. the
page URL is outside the registration scope). `cacheMaxBytes` limits the total
size of cached tiles for a map and evicts the least-recently-used tiles; omit it
for no capacity limit.

Rejections stay strings, so existing `e.match(...)` checks keep working. To
branch on the cause, convert them with `WeiwudiError.from` (codes and messages:
[Errors](docs/api/weiwudi.md#errors)):

```typescript
import Weiwudi, { WeiwudiError } from '@c4h/weiwudi';

try {
  await map.fetchAll();
} catch (e) {
  if (WeiwudiError.from(e).code === 'fetch-busy') { /* another fetch is running */ }
}
```

Tiles served through `map.url` carry the response header `x-weiwudi-error`
(`network` / `upstream` / `quota` / `storage`) when fetching or caching failed.

### CDN (jsDelivr)

For browser usage without a build tool, load Weiwudi via CDN:

```html
<!-- Weiwudi main library -->
<script src="https://cdn.jsdelivr.net/npm/@c4h/weiwudi@1.1.1/dist/weiwudi.umd.js"></script>
```

For the service worker file:

```js
// In your service worker (sw.js)
importScripts("https://cdn.jsdelivr.net/npm/workbox-core@7.4.0/build/workbox-core.prod.js");
importScripts("https://cdn.jsdelivr.net/npm/workbox-routing@7.4.0/build/workbox-routing.prod.js");
importScripts("https://cdn.jsdelivr.net/npm/@c4h/weiwudi@1.1.1/dist/weiwudi-sw.umd.js");
```

### Service worker plugins

`@c4h/weiwudi/sw` exports `addPlugin` to hook into how tiles are fetched and
cached. It is Weiwudi's own API that borrows the hook names of Workbox plugins.
Call it at the top of your service worker script; with the UMD build use
`self.Weiwudi_SW.addPlugin`.

```js
// sw.js (ES module service worker)
import { addPlugin } from '@c4h/weiwudi/sw';

addPlugin({
  async requestWillFetch({ request }) {
    return new Request(request, { headers: { 'x-api-key': 'public-key' } });
  },
  async cacheWillUpdate({ response }) {
    return response.headers.get('content-type')?.startsWith('image/') ? response : null; // null: do not cache
  },
});
```

Headers added in `requestWillFetch` are dropped by the browser when the request
is `no-cors` (for example a tile requested by an `<img>` element). Build a new
`Request` with `mode: 'cors'` if the upstream needs them.

Details: [Service worker API](docs/api/sw.md).

### Caching real tile URLs (source API)

`Weiwudi.register` registers the URL templates that your map library requests.
The service worker then caches those real URLs directly, so you pass the
original URL to the map library.

```typescript
import Weiwudi from '@c4h/weiwudi';

await Weiwudi.registerSW('./sw.js', { scope: './' });
const source = await Weiwudi.register({
  kind: 'raster', // or 'vector'
  url: 'https://tile.example.com/{z}/{x}/{y}.png',
});
// Create the map after register() resolves; earlier requests are not cached
L.tileLayer(source.url as string).addTo(leafletMap);

console.log(source.warnings, await source.stats());
```

- Chromium is tested locally and in CI. **WebKit** (Playwright's WebKit on Linux) is tested in CI, except
  the tests that only work on Chromium: going offline (`context.setOffline`), stopping the service worker
  (CDP), the real storage quota, and the Mapbox tests (Playwright cannot intercept requests from a service
  worker on WebKit). Linux WebKit is not the same as Safari on iOS. WebKit cannot store a `Blob` in
  IndexedDB in a non-persistent session (private browsing included), so Weiwudi stores bodies as
  `ArrayBuffer`; all 29 CI tests pass on WebKit in this form. **Firefox** is run
  in CI on the same 29 tests as WebKit and all pass, but it is not a required check.
- A sandboxed `srcdoc` iframe (`allow-scripts allow-same-origin`) inherits the page's service worker on
  Chromium and WebKit, so it can use the API there. On Firefox it does not, and calls in it reject with
  `sw-not-controlling`.
- `kind` is `'raster'`, `'vector'`, `'style'` or `'asset'`. A style registers
  everything it refers to (TileJSON, tiles, glyphs, sprites, GeoJSON, images);
  pass `source.url` to MapLibre after `register()` resolves:

  ```typescript
  const style = await Weiwudi.register({ kind: 'style', url: 'https://example.com/style.json' });
  const map = new maplibregl.Map({ container, style: style.url as string });
  ```

  Credentials of a style are sent only to the origin of the style and to its
  provider, and a style from another origin cannot capture URLs of the page's
  origin. `update()` fetches the style again
  ([Styles](docs/api/weiwudi.md#styles-kind-style)).
- An explicit `id` is a public value (it appears in `sources()` and `warnings`).
  Do not put credentials in it; pass them as `credentials` instead.
- The service worker adds `credentials` only to requests on the page request's
  origin, and sends requests with credential headers with `redirect: 'error'`.
  Secret tokens (`sk.` in queries, `sk.eyJ…` path segments) are rejected, and
  mirrors with different values for the same credential parameter are
  rejected with `attribute-invalid`.
- `mapbox://` URLs are resolved to `https://api.mapbox.com/…` by default (pass the
  access token as `credentials: { query: { access_token } }`). Checking the
  provider's terms of service, including whether offline storage is allowed, is
  your responsibility. `mapbox://` inside a third-party style is not resolved:
  only styles you register with a `mapbox://` URL or a Mapbox `https` URL are,
  so your Mapbox token is never used for someone else's style. Other providers
  can be added in the service worker with `addProvider`
  ([Service worker API](docs/api/sw.md#addproviderprovider-weiwudiprovider-void)).
- `source.removeResource(resourceId)` deletes the cached entries of one resource
  even when it is shared with another source (`clean()` keeps shared ones); the
  resource stays registered. `Weiwudi.usage()` reports the stored amount in total
  and per provider (`byProvider`, keyed by provider or origin).
- Failures reject with `WeiwudiError` (`sw-not-controlling`, `sw-outdated`,
  `source-not-found`, `resource-not-found`, …). A resource that cannot be merged with an existing one
  does not fail `register()`; it is reported in `source.warnings`.
- In your service worker, **put the Weiwudi import first** (`import '@c4h/weiwudi/sw'`
  or the `importScripts` line) and register your own Workbox routes after it.
  A catch-all route (for example `/.*/`) registered before Weiwudi takes every
  tile request from it.

`cacheRetention` sets a deletion deadline in milliseconds from `fetchedAt` (no deadline by default).
Expired entries are treated as missing when serving requests and are deleted in batches on the first
store-using Weiwudi request after the service worker starts, and when a job ends.
Pinned entries are never deleted by this cleanup. Glyphs expire per stored range.
Each cleanup run visits at most 2,000 records; unfinished cleanup continues on the next eligible request.
It pauses while a job is running. Neither ping endpoint nor `fetchAll` dispatch starts cleanup;
`fetchAll` runs it when the job ends.

Details: [Source API](docs/api/weiwudi.md#source-api).

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
pnpm run test:unit   # Unit tests (Vitest, tests/unit/)
pnpm test            # E2E tests (Playwright, tests/e2e/)
```

The unit tests cover the service-worker gateway logic (`src/weiwudi_gw_logic.ts`): API branching, tile fetching and caching, and the cache size limit.

The E2E tests verify:
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
