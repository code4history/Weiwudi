# Service worker API (`@c4h/weiwudi/sw`)

[日本語](sw.ja.md)

The service worker entry registers Weiwudi's routes when it is imported. A
side-effect import keeps working as before:

```js
import '@c4h/weiwudi/sw';
```

It also has named exports for hooking into tile fetching and caching, and for
adding URL providers.

| Export | Kind |
|---|---|
| `addPlugin(plugin)` | function |
| `addProvider(provider)` | function |
| `WeiwudiPlugin` | type |
| `WeiwudiProvider` | type |
| `Credentials` | type |
| `ResourceInfo` | type |
| `ResourceType` | type |

With the UMD build (`weiwudi-sw.umd.js` loaded by `importScripts`), the same
functions are `self.Weiwudi_SW.addPlugin` and `self.Weiwudi_SW.addProvider`.

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
  that `Request` instead. The `request` the hooks receive is for the upstream
  tile URL (one mirror picked at random, a relative URL resolved against the
  service worker's location), never the `weiwudi.example.com` URL.
- Concurrent anonymous requests for the same tile are merged into one. The hooks
  run once, with the plugins registered when the first request started.
  Authenticated requests are never merged.
- An authenticated request (one Weiwudi does not cache) always goes upstream,
  even when a fresh cached copy exists. The cached copy is used only when
  upstream fails (HTTP error or network failure), as a stale response.

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

## `addProvider(provider: WeiwudiProvider): void`

Registers a URL provider. A provider turns its own URL scheme (such as
`mapbox://`) into `https` URLs when a source is registered, and adds the
registered credentials just before a request goes upstream. Call it at the top
of the service worker script, like `addPlugin`. The registration is not
persisted.

- Adding the same object twice has no effect (the second call is ignored).
- A value that is not an object, or that lacks `id`, `matches`, `resolve` or
  `applyCredentials`, throws a `TypeError`.
- It applies to sources registered after it returns. A source keeps the
  provider `id` it was registered with. If no provider with that `id` is
  registered when a request is handled (for example, after the service worker
  restarted and the script did not call `addProvider`), credentials are added
  the generic way.

**Order.** Providers you add are tried first, in the order you added them.
The built-in `mapbox` provider is tried last. The first provider whose
`matches` returns `true` for the URL is used, so a provider you add can replace
the built-in one for the same URLs.

**`id`.** Each `id` may be added only once: adding a different object with an
`id` already added throws a `TypeError`. Adding a provider with the `id`
`'mapbox'` replaces the built-in one (yours is tried first, and a resource with
`provider: 'mapbox'` uses yours). If the service worker restarts and your
script does not add it again, the built-in `mapbox` provider is used for those
resources. Sources registered with different providers are never merged into
one resource, even when their URLs resolve to the same template; this is
reported as a `resource-conflict` warning.

All mirrors of one source must match the
same provider (or none): mixing them is `attribute-invalid`.

```js
import { addProvider } from '@c4h/weiwudi/sw';

addProvider({
  id: 'example',
  matches: (url) => url.startsWith('example://') || url.startsWith('https://tiles.example.com/'),
  resolve: (url) => url.replace(/^example:\/\//, 'https://tiles.example.com/'),
  applyCredentials: (url, c) => {
    const key = c.query?.key;
    if (key !== undefined && !url.searchParams.has('key')) url.searchParams.set('key', key);
  },
  credentialParams: ['key'],
});
```

## `WeiwudiProvider`

```ts
type Credentials = { query?: Record<string, string>; headers?: Record<string, string> };

interface WeiwudiProvider {
  id: string;                                         // stored on the resource
  matches(url: string): boolean;                      // its own scheme and its https URLs
  resolve(url: string): string;                       // an https URL; adds no credentials (see below)
  applyCredentials(url: URL, c: Credentials): void;   // called just before the request goes upstream
  rewriteStyle?(style: unknown): unknown;             // its own scheme inside a style, to https
  validateCredentials?(c: Credentials): void;         // throw to reject the registration
  credentialParams?: string[];                        // query names treated as credentials
}
```

- `resolve` runs when a source is registered. The URL it returns is checked
  like any other URL template, and becomes the source's `url` and the
  resource's templates. Return `https` URLs unchanged. Throw for a form you
  cannot resolve; the registration fails with `unsupported-template` and a
  fixed message (`cannot be resolved by the provider "<id>"`; your error's
  message is not passed on).
- `resolve` must not add new credentials. It may keep the query of its input.
  Names listed in `credentialParams` are then removed by the registration check;
  credentials under any other name stay in the URL.
- `applyCredentials` changes `url` in place. Only the query is taken from it:
  header credentials are always added the generic way. If it throws, or changes
  the origin of `url`, no query credentials are added. The rules for credentials
  still apply: nothing is added when a plugin's `requestWillFetch` changed the
  origin of the request, and a request that got a header credential is sent
  with `redirect: 'error'`.
- `validateCredentials` receives the credentials of the registration (the
  `credentials` option and those moved out of the URL query). If it throws, the
  registration fails with `credential-rejected` and a fixed message (your
  error's message is not passed on). The generic check for secret tokens (`sk.`)
  runs as well.
- When `applyCredentials` throws, only the provider `id` and the error's `name`
  are logged with `console.error`.
- `credentialParams` is added to the source's `credentialParams`.
- `rewriteStyle` must return a new object and leave its input unchanged.

### The built-in `mapbox` provider

`mapbox://` URLs are resolved without any setup. It matches `mapbox://` URLs and
`https` URLs on `api.mapbox.com` and `*.tiles.mapbox.com`.

| Registered URL | Resolved to |
|---|---|
| `mapbox://styles/{user}/{style}` (also `…/draft`) | `https://api.mapbox.com/styles/v1/{user}/{style}` |
| `mapbox://sprites/{user}/{style}` (also `…/{hash}`) | `https://api.mapbox.com/styles/v1/{user}/{style}/sprite` |
| `mapbox://fonts/{user}/{fontstack}/{range}.pbf` | `https://api.mapbox.com/fonts/v1/{user}/{fontstack}/{range}.pbf` |
| `mapbox://tiles/{id}/{z}/{x}/{y}[@2x].{format}` | `https://api.mapbox.com/v4/{id}/{z}/{x}/{y}[@2x].{format}` |
| `mapbox://{id}[,{id}…]` (a source `url`) | `https://api.mapbox.com/v4/{ids}.json?secure` |

Tile URLs are copied as written: the `@2x` and `webp` substitutions that Mapbox
GL JS makes are not applied. A sprite URL resolves to its base; the map library
adds the format and extension.

Register the access token as `credentials: { query: { access_token } }` (or in
the URL query; it is moved out). A secret token (`sk.`) is rejected with
`credential-rejected`. Checking the provider's terms of service, including
whether offline storage is allowed, is your responsibility.

