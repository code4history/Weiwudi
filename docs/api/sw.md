# Service worker API (`@c4h/weiwudi/sw`)

[日本語](sw.ja.md)

> **Status on the development branch:** the hooks are not yet connected to tile
> serving. `addPlugin` is exported and registers plugins, but until the legacy
> API is moved onto the new core (m2-t5), no hook is called for real requests.
> This note is removed in m2-t5.

The service worker entry registers Weiwudi's routes when it is imported. A
side-effect import keeps working as before:

```js
import '@c4h/weiwudi/sw';
```

It also has named exports for hooking into tile fetching and caching.

| Export | Kind |
|---|---|
| `addPlugin(plugin)` | function |
| `WeiwudiPlugin` | type |
| `ResourceInfo` | type |
| `ResourceType` | type |

With the UMD build (`weiwudi-sw.umd.js` loaded by `importScripts`), the same
function is `self.Weiwudi_SW.addPlugin`.

## `addPlugin(plugin: WeiwudiPlugin): void`

Registers a plugin. Call it at the top of the service worker script. The
registration is not persisted: when the browser restarts the service worker,
the script runs again and registers it again.

- Plugins run in registration order.
- Adding the same object twice has no effect (the second call is ignored).
- A plugin applies to requests that start after `addPlugin` returns. A request
  already being handled keeps the plugins it started with.
- If a hook throws or rejects, the error is logged with `console.error`, that
  plugin is skipped for that step, and the request continues. A plugin cannot
  stop the map.
- A value that is not an object throws a `TypeError`.

```js
import { addPlugin } from '@c4h/weiwudi/sw';

addPlugin({
  async requestWillFetch({ request, resource }) {
    // Fetch from another URL. Return nothing to keep the request.
    if (resource.type === 'tile') return new Request(request.url.replace('http:', 'https:'));
  },
  async cacheWillUpdate({ response }) {
    // null: serve the response but do not cache it
    return response.headers.get('content-type')?.startsWith('image/') ? response : null;
  },
});
```

UMD:

```js
importScripts('https://cdn.jsdelivr.net/npm/workbox-core@7.4.0/build/workbox-core.prod.js');
importScripts('https://cdn.jsdelivr.net/npm/workbox-routing@7.4.0/build/workbox-routing.prod.js');
importScripts('https://cdn.jsdelivr.net/npm/@c4h/weiwudi@<version>/dist/weiwudi-sw.umd.js');

self.Weiwudi_SW.addPlugin({ /* hooks */ });
```

## `WeiwudiPlugin`

Every hook is optional. This is Weiwudi's own API. It borrows the hook names of
Workbox plugins, but it is not a Workbox plugin and Workbox plugins cannot be
passed to it. Differences from Workbox:

- No `event` is passed to any hook.
- `state` is passed only to `requestWillFetch`, `fetchDidSucceed` and
  `fetchDidFail`.
- `cacheWillUpdate` and `cachedResponseWillBeUsed` receive the original request
  (before `requestWillFetch`), not a cache key.

```ts
interface WeiwudiPlugin {
  requestWillFetch?(p: { request: Request; resource: ResourceInfo; state: unknown }): Promise<Request | void>;
  fetchDidSucceed?(p: { request: Request; response: Response; resource: ResourceInfo; state: unknown }): Promise<Response | void>;
  fetchDidFail?(p: { request: Request; error: unknown; resource: ResourceInfo; state: unknown }): Promise<void>;
  cacheWillUpdate?(p: { request: Request; response: Response; resource: ResourceInfo }): Promise<Response | null | void>;
  cachedResponseWillBeUsed?(p: { request: Request; cachedResponse: Response; resource: ResourceInfo }): Promise<Response | null | void>;
}
```

| Hook | When | Return value |
|---|---|---|
| `requestWillFetch` | Before the request goes upstream | A different `Request` to fetch instead. Nothing keeps the current one. The next plugin receives the result |
| `fetchDidSucceed` | After a response arrives from upstream, including HTTP errors and opaque responses | A different `Response` to use instead. If the hook reads the body and returns nothing (or returns the read response), Weiwudi logs an error and uses the response from before the hook |
| `fetchDidFail` | When upstream could not be reached (network failure) | Ignored |
| `cacheWillUpdate` | Just before Weiwudi tries to cache a response | `null`: do not cache. A different `Response`: cache that one (the page still receives the original response). If its body cannot be read, the tile is served with `x-weiwudi-error: storage` and not cached |
| `cachedResponseWillBeUsed` | Before a cached response is served (fresh, or stale after an upstream failure) | `null`: treat it as not cached. A different `Response`: serve that one |

Order for one request:

- Cached and fresh: `cachedResponseWillBeUsed`. If it returns `null`, the request
  continues as "not cached" below.
- Not cached, or expired: `requestWillFetch` → `fetchDidSucceed` → `cacheWillUpdate`
  (only when the response will be cached)
- HTTP error (or an opaque response, or a `text/html` page instead of a tile)
  with a stale copy: `requestWillFetch` → `fetchDidSucceed` → `cachedResponseWillBeUsed`
- Network failure: `requestWillFetch` → `fetchDidFail` → `cachedResponseWillBeUsed`
  (only when a stale copy exists)
- No hook is called for a request whose resource is no longer registered, or for
  a request with a `Range` header (these go to upstream unchanged).

Notes:

- `state` is a new empty object for each plugin and each request. The same
  object is passed to `requestWillFetch`, `fetchDidSucceed` and `fetchDidFail`
  of that plugin within one request.
- `cacheWillUpdate` is called only when Weiwudi would cache the response. It is
  not called for HTTP errors, a `text/html` page served instead of a tile, opaque
  responses, or authenticated requests that are not cached.
- A successful (2xx) upstream response is served and cached as `200 OK`, the
  same as the legacy API.
- With the legacy API (`Weiwudi.registerMap`), Weiwudi fetches upstream with the
  URL string. When `requestWillFetch` returns a different `Request`, it fetches
  that `Request` instead.
- Concurrent anonymous requests for the same tile are merged into one. The hooks
  run once, with the plugins registered when the first request started.
  Authenticated requests are never merged.

## `ResourceInfo`

What a plugin receives as `resource`. It is a read-only snapshot taken when the
request starts; changing it does not change Weiwudi's records.

```ts
type ResourceType = 'style' | 'tilejson' | 'tile' | 'glyph' | 'sprite' | 'data';

interface ResourceInfo {
  id: string;            // the resource id
  type: ResourceType;
  templates: string[];   // URL templates without credentials
  count: number;         // number of cached entries
  bytes: number;         // total size of cached entries
  rangeOnly?: true;      // not passed to plugins
  corsless?: true;       // the upstream is currently treated as not supporting CORS
}
```

`ResourceType` and the fields of `ResourceInfo` may gain values in a minor
release. Put a `default` branch in a `switch` over `type`.
