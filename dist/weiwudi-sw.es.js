try {
  self["workbox:core:7.3.0"] && _();
} catch {
}
const z = (A, ...a) => {
  let f = A;
  return a.length > 0 && (f += ` :: ${JSON.stringify(a)}`), f;
}, J = z;
class k extends Error {
  /**
   *
   * @param {string} errorCode The error code that
   * identifies this particular error.
   * @param {Object=} details Any relevant arguments
   * that will help developers identify issues should
   * be added as a key on the context object.
   */
  constructor(a, f) {
    const r = J(a, f);
    super(r), this.name = a, this.details = f;
  }
}
try {
  self["workbox:routing:7.3.0"] && _();
} catch {
}
const Y = "GET", B = (A) => A && typeof A == "object" ? A : { handle: A };
class S {
  /**
   * Constructor for Route class.
   *
   * @param {workbox-routing~matchCallback} match
   * A callback function that determines whether the route matches a given
   * `fetch` event by returning a non-falsy value.
   * @param {workbox-routing~handlerCallback} handler A callback
   * function that returns a Promise resolving to a Response.
   * @param {string} [method='GET'] The HTTP method to match the Route
   * against.
   */
  constructor(a, f, r = Y) {
    this.handler = B(f), this.match = a, this.method = r;
  }
  /**
   *
   * @param {workbox-routing-handlerCallback} handler A callback
   * function that returns a Promise resolving to a Response
   */
  setCatchHandler(a) {
    this.catchHandler = B(a);
  }
}
class K extends S {
  /**
   * If the regular expression contains
   * [capture groups]{@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp#grouping-back-references},
   * the captured values will be passed to the
   * {@link workbox-routing~handlerCallback} `params`
   * argument.
   *
   * @param {RegExp} regExp The regular expression to match against URLs.
   * @param {workbox-routing~handlerCallback} handler A callback
   * function that returns a Promise resulting in a Response.
   * @param {string} [method='GET'] The HTTP method to match the Route
   * against.
   */
  constructor(a, f, r) {
    const I = ({ url: b }) => {
      const p = a.exec(b.href);
      if (p && !(b.origin !== location.origin && p.index !== 0))
        return p.slice(1);
    };
    super(I, f, r);
  }
}
class Q {
  /**
   * Initializes a new Router.
   */
  constructor() {
    this._routes = /* @__PURE__ */ new Map(), this._defaultHandlerMap = /* @__PURE__ */ new Map();
  }
  /**
   * @return {Map<string, Array<workbox-routing.Route>>} routes A `Map` of HTTP
   * method name ('GET', etc.) to an array of all the corresponding `Route`
   * instances that are registered.
   */
  get routes() {
    return this._routes;
  }
  /**
   * Adds a fetch event listener to respond to events when a route matches
   * the event's request.
   */
  addFetchListener() {
    self.addEventListener("fetch", ((a) => {
      const { request: f } = a, r = this.handleRequest({ request: f, event: a });
      r && a.respondWith(r);
    }));
  }
  /**
   * Adds a message event listener for URLs to cache from the window.
   * This is useful to cache resources loaded on the page prior to when the
   * service worker started controlling it.
   *
   * The format of the message data sent from the window should be as follows.
   * Where the `urlsToCache` array may consist of URL strings or an array of
   * URL string + `requestInit` object (the same as you'd pass to `fetch()`).
   *
   * ```
   * {
   *   type: 'CACHE_URLS',
   *   payload: {
   *     urlsToCache: [
   *       './script1.js',
   *       './script2.js',
   *       ['./script3.js', {mode: 'no-cors'}],
   *     ],
   *   },
   * }
   * ```
   */
  addCacheListener() {
    self.addEventListener("message", ((a) => {
      if (a.data && a.data.type === "CACHE_URLS") {
        const { payload: f } = a.data, r = Promise.all(f.urlsToCache.map((I) => {
          typeof I == "string" && (I = [I]);
          const b = new Request(...I);
          return this.handleRequest({ request: b, event: a });
        }));
        a.waitUntil(r), a.ports && a.ports[0] && r.then(() => a.ports[0].postMessage(!0));
      }
    }));
  }
  /**
   * Apply the routing rules to a FetchEvent object to get a Response from an
   * appropriate Route's handler.
   *
   * @param {Object} options
   * @param {Request} options.request The request to handle.
   * @param {ExtendableEvent} options.event The event that triggered the
   *     request.
   * @return {Promise<Response>|undefined} A promise is returned if a
   *     registered route can handle the request. If there is no matching
   *     route and there's no `defaultHandler`, `undefined` is returned.
   */
  handleRequest({ request: a, event: f }) {
    const r = new URL(a.url, location.href);
    if (!r.protocol.startsWith("http"))
      return;
    const I = r.origin === location.origin, { params: b, route: p } = this.findMatchingRoute({
      event: f,
      request: a,
      sameOrigin: I,
      url: r
    });
    let w = p && p.handler;
    const D = a.method;
    if (!w && this._defaultHandlerMap.has(D) && (w = this._defaultHandlerMap.get(D)), !w)
      return;
    let R;
    try {
      R = w.handle({ url: r, request: a, event: f, params: b });
    } catch (E) {
      R = Promise.reject(E);
    }
    const M = p && p.catchHandler;
    return R instanceof Promise && (this._catchHandler || M) && (R = R.catch(async (E) => {
      if (M)
        try {
          return await M.handle({ url: r, request: a, event: f, params: b });
        } catch (L) {
          L instanceof Error && (E = L);
        }
      if (this._catchHandler)
        return this._catchHandler.handle({ url: r, request: a, event: f });
      throw E;
    })), R;
  }
  /**
   * Checks a request and URL (and optionally an event) against the list of
   * registered routes, and if there's a match, returns the corresponding
   * route along with any params generated by the match.
   *
   * @param {Object} options
   * @param {URL} options.url
   * @param {boolean} options.sameOrigin The result of comparing `url.origin`
   *     against the current origin.
   * @param {Request} options.request The request to match.
   * @param {Event} options.event The corresponding event.
   * @return {Object} An object with `route` and `params` properties.
   *     They are populated if a matching route was found or `undefined`
   *     otherwise.
   */
  findMatchingRoute({ url: a, sameOrigin: f, request: r, event: I }) {
    const b = this._routes.get(r.method) || [];
    for (const p of b) {
      let w;
      const D = p.match({ url: a, sameOrigin: f, request: r, event: I });
      if (D)
        return w = D, (Array.isArray(w) && w.length === 0 || D.constructor === Object && // eslint-disable-line
        Object.keys(D).length === 0 || typeof D == "boolean") && (w = void 0), { route: p, params: w };
    }
    return {};
  }
  /**
   * Define a default `handler` that's called when no routes explicitly
   * match the incoming request.
   *
   * Each HTTP method ('GET', 'POST', etc.) gets its own default handler.
   *
   * Without a default handler, unmatched requests will go against the
   * network as if there were no service worker present.
   *
   * @param {workbox-routing~handlerCallback} handler A callback
   * function that returns a Promise resulting in a Response.
   * @param {string} [method='GET'] The HTTP method to associate with this
   * default handler. Each method has its own default.
   */
  setDefaultHandler(a, f = Y) {
    this._defaultHandlerMap.set(f, B(a));
  }
  /**
   * If a Route throws an error while handling a request, this `handler`
   * will be called and given a chance to provide a response.
   *
   * @param {workbox-routing~handlerCallback} handler A callback
   * function that returns a Promise resulting in a Response.
   */
  setCatchHandler(a) {
    this._catchHandler = B(a);
  }
  /**
   * Registers a route with the router.
   *
   * @param {workbox-routing.Route} route The route to register.
   */
  registerRoute(a) {
    this._routes.has(a.method) || this._routes.set(a.method, []), this._routes.get(a.method).push(a);
  }
  /**
   * Unregisters a route with the router.
   *
   * @param {workbox-routing.Route} route The route to unregister.
   */
  unregisterRoute(a) {
    if (!this._routes.has(a.method))
      throw new k("unregister-route-but-not-found-with-method", {
        method: a.method
      });
    const f = this._routes.get(a.method).indexOf(a);
    if (f > -1)
      this._routes.get(a.method).splice(f, 1);
    else
      throw new k("unregister-route-route-not-registered");
  }
}
let C;
const G = () => (C || (C = new Q(), C.addFetchListener(), C.addCacheListener()), C);
function V(A, a, f) {
  let r;
  if (typeof A == "string") {
    const b = new URL(A, location.href), p = ({ url: w }) => w.href === b.href;
    r = new S(p, a, f);
  } else if (A instanceof RegExp)
    r = new K(A, a, f);
  else if (typeof A == "function")
    r = new S(A, a, f);
  else if (A instanceof S)
    r = A;
  else
    throw new k("unsupported-route-type", {
      moduleName: "workbox-routing",
      funcName: "registerRoute",
      paramName: "capture"
    });
  return G().registerRoute(r), r;
}
function j(A) {
  const a = 20037508342789244e-9, f = {};
  let r;
  const I = (m, t, h, c) => m.replace("{z}", t).replace("{x}", h).replace("{y}", c).replace("{-y}", Math.pow(2, t) - c - 1), b = (m, t = "", h = 512) => {
    const c = atob(m), e = [];
    for (let s = 0; s < c.length; s += h) {
      const o = c.slice(s, s + h), n = new Array(o.length);
      for (let d = 0; d < o.length; d++)
        n[d] = o.charCodeAt(d);
      const i = new Uint8Array(n);
      e.push(i);
    }
    return new Blob(e, { type: t });
  }, p = async (m, t, h) => new Promise((c, e) => {
    try {
      if (f[m]) c(f[m]);
      else {
        const l = indexedDB.open(m);
        l.onupgradeneeded = function(s) {
          s.target.result.createObjectStore(t, { keyPath: h });
        }, l.onsuccess = function(s) {
          const o = s.target.result;
          f[m] = o, c(o);
        }, l.onerror = function(s) {
          e(s);
        };
      }
    } catch (l) {
      e(l);
    }
  }), w = async (m) => (f[m] && (f[m].close(), delete f[m]), new Promise((t, h) => {
    try {
      const c = indexedDB.deleteDatabase(m);
      c.onsuccess = async (e) => {
        t();
      }, c.onerror = function(e) {
        h(e);
      };
    } catch (c) {
      h(c);
    }
  })), D = async (m, t) => new Promise((h, c) => {
    const e = m.transaction([t], "readwrite"), s = e.objectStore(t).clear();
    s.onsuccess = function(o) {
    }, s.onerror = function(o) {
      c(o);
    }, e.oncomplete = function(o) {
      h();
    }, e.onabort = function(o) {
      c(o);
    }, e.onerror = function(o) {
      c(o);
    };
  }), R = async (m, t) => new Promise((h, c) => {
    const e = m.transaction([t], "readonly"), s = e.objectStore(t).openCursor();
    let o = 0, n = 0;
    s.onsuccess = function(i) {
      const d = s.result;
      d && (o++, n = n + d.value.blob.size, d.continue());
    }, s.onerror = function(i) {
      c(i);
    }, e.oncomplete = function(i) {
      h({
        count: o,
        size: n
      });
    }, e.onabort = function(i) {
      c(i);
    }, e.onerror = function(i) {
      c(i);
    };
  }), M = async (m, t, h, c) => new Promise((e, l) => {
    const s = m.transaction([t], "readonly"), o = s.objectStore(t), n = c ? o.getKey(h) : o.get(h);
    n.onsuccess = function(i) {
    }, n.onerror = function(i) {
      l(i);
    }, s.oncomplete = function(i) {
      e(n.result);
    }, s.onabort = function(i) {
      l(i);
    }, s.onerror = function(i) {
      l(i);
    };
  }), E = async (m, t, h) => new Promise((c, e) => {
    const l = m.transaction([t], "readwrite"), o = l.objectStore(t).put(h);
    o.onsuccess = function(n) {
    }, o.onerror = function(n) {
      e(n);
    }, l.oncomplete = function(n) {
      c();
    }, l.onabort = function(n) {
      e(n);
    }, l.onerror = function(n) {
      e(n);
    };
  }), L = async (m, t, h) => new Promise((c, e) => {
    const l = m.transaction([t], "readwrite"), o = l.objectStore(t).delete(h);
    o.onsuccess = function(n) {
    }, o.onerror = function(n) {
      e(n);
    }, l.oncomplete = function(n) {
      c();
    }, l.onabort = function(n) {
      e(n);
    }, l.onerror = function(n) {
      e(n);
    };
  }), F = async (m, t) => new Promise((h, c) => {
    const e = m.transaction([t], "readwrite"), s = e.objectStore(t).getAllKeys();
    s.onsuccess = function(o) {
    }, s.onerror = function(o) {
      c(o);
    }, e.oncomplete = function(o) {
      h(s.result);
    }, e.onabort = function(o) {
      c(o);
    }, e.onerror = function(o) {
      c(o);
    };
  }), U = async ({ url: m, request: t, event: h, _params: c }) => {
    const e = h.clientId ? await self.clients.get(h.clientId) : void 0, l = m.pathname.match(/^\/api\/([\w\d]+)(?:\/(.+))?$/);
    if (l) {
      const s = [...m.searchParams.entries()].reduce((d, u) => {
        const x = m.searchParams.getAll(u[0]);
        return x.length === 1 ? d[u[0]] = x[0] : d[u[0]] = x, d;
      }, {}), o = l[1], n = l[2];
      let i = await N(o, s, n, e);
      if (i)
        return i instanceof Response || (i = new Response(i)), i;
    }
  }, X = async (m, t, h, c, e) => {
    let l;
    const s = await p("Weiwudi"), o = await M(s, "mapSetting", m);
    if (!e) {
      if (!o) return `Error: MapID "${m}" not found`;
      if (t < o.minZoom || t > o.maxZoom) l = "zoom";
      else {
        const x = Math.floor(o.minX / Math.pow(2, o.maxZoom - t)), g = Math.floor(o.maxX / Math.pow(2, o.maxZoom - t)), $ = Math.floor(o.minY / Math.pow(2, o.maxZoom - t)), T = Math.floor(o.maxY / Math.pow(2, o.maxZoom - t));
        (h < x || h > g || c < $ || c > T) && (l = "extent");
      }
    }
    let n = {}, i, d = 200, u = "OK";
    if (l)
      l === "zoom" ? (d = 404, u = "Not Found") : (n = {
        "content-type": "image/png"
      }, i = b("iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAMAAABrrFhUAAAAB3RJTUUH3QgIBToaSbAjlwAAABd0RVh0U29mdHdhcmUAR0xEUE5HIHZlciAzLjRxhaThAAAACHRwTkdHTEQzAAAAAEqAKR8AAAAEZ0FNQQAAsY8L/GEFAAAAA1BMVEX///+nxBvIAAAAAXRSTlMAQObYZgAAAFRJREFUeNrtwQEBAAAAgJD+r+4ICgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgBDwABHHIJwwAAAABJRU5ErkJggg==", n["content-type"]));
    else {
      const x = await p(`Weiwudi_${m}`), g = await M(x, "tileCache", `${t}_${h}_${c}`, e), $ = (/* @__PURE__ */ new Date()).getTime();
      if (!g || !g.epoch || $ - g.epoch > 864e5) {
        const T = o.url instanceof Array ? o.url[Math.floor(Math.random() * o.url.length)] : o.url, O = I(T, t, h, c);
        try {
          const Z = await fetch(O);
          Z.ok ? (n = [...Z.headers.entries()].reduce((P, H) => ({ ...P, [H[0]]: H[1] }), {}), i = await Z.blob(), await E(x, "tileCache", {
            z_x_y: `${t}_${h}_${c}`,
            headers: n,
            blob: i,
            epoch: $
          })) : (g ? (n = g.headers, i = g.blob) : (d = Z.status, u = Z.statusText, n = [...Z.headers.entries()].reduce((P, H) => ({ ...P, [H[0]]: H[1] }), {}), i = await Z.blob()), r && r.error++);
        } catch {
          g ? (n = g.headers, i = g.blob) : (d = 404, u = "Not Found"), r && r.error++;
        }
      } else e || (n = g.headers, i = g.blob);
    }
    return e ? void 0 : new Response(i, {
      status: d,
      statusText: u,
      headers: new Headers(n)
    });
  }, W = async (m, t) => {
    let h = 0, c = 0;
    const e = await p(`Weiwudi_${t.mapID}`), l = await F(e, "tileCache");
    try {
      const s = [];
      for (let i = t.minZoom; i <= t.maxZoom; i++) {
        const d = Math.floor(t.maxX / Math.pow(2, t.maxZoom - i)), u = Math.floor(t.minX / Math.pow(2, t.maxZoom - i)), x = Math.floor(t.maxY / Math.pow(2, t.maxZoom - i)), g = Math.floor(t.minY / Math.pow(2, t.maxZoom - i));
        for (let $ = u; $ <= d; $++)
          for (let T = g; T <= x; T++)
            s.push([i, $, T]);
      }
      s.length != t.totalTile && console.log("Number of tiles is different");
      let o = s.splice(0, 5);
      for (; o.length; ) {
        if (!await self.clients.get(m.id)) {
          r = void 0;
          return;
        }
        if (r.cancel) {
          r = void 0, m.postMessage({
            type: "canceled",
            message: `Fetching tile of ${t.mapID} is canceled`,
            mapID: t.mapID
          });
          return;
        }
        const d = o.map((u) => {
          if (!(l.indexOf(`${u[0]}_${u[1]}_${u[2]}`) >= 0))
            return X(t.mapID, u[0], u[1], u[2], !0);
        });
        await Promise.all(d), h += d.length, r.count = h, c = Math.floor(h * 100 / t.totalTile), m.postMessage({
          type: "proceed",
          message: `Proceeding the tile fetching: ${t.mapID} ${c}% (${h} / ${t.totalTile})`,
          percent: c,
          processed: h,
          error: r.error,
          total: t.totalTile,
          mapID: t.mapID
        }), o = s.splice(0, 5);
      }
      const n = r.error;
      r = void 0, m.postMessage({
        type: "finish",
        message: `Fetched all tiles of ${t.mapID}${n ? ` with ${n} error cases` : ""}`,
        total: t.totalTile,
        mapID: t.mapID,
        error: n
      });
    } catch (s) {
      r = void 0, m.postMessage({
        type: "stop",
        message: `Fetching stopped: ${t.mapID} ${h} / ${t.totalTile}`,
        reason: s,
        processed: h,
        total: t.totalTile,
        mapID: t.mapID
      });
    }
  }, N = async (m, t, h, c) => {
    let e;
    const l = (s, o) => o.reduce((n, i) => n || (s[i] === void 0 ? `Error: Attribute "${i}" is missing` : n), void 0);
    try {
      switch (m) {
        case "ping":
          e = "Implemented";
          break;
        case "info":
          if (e = l(t, ["mapID"]), !e) {
            const s = await p("Weiwudi", "mapSetting", "mapID"), o = await M(s, "mapSetting", t.mapID);
            o ? e = new Response(JSON.stringify(o), {
              headers: new Headers({
                "content-type": "application/json"
              })
            }) : e = `Error: MapID "${t.mapID}" not found`;
          }
          break;
        case "add": {
          const s = await p("Weiwudi", "mapSetting", "mapID");
          if (e = l(t, ["mapID", "type", "url"]), !e)
            switch (t.tileSize = parseInt(t.tileSize || 256), t.type) {
              case "xyz":
                if (e = l(t, ["width", "height"]), !e) {
                  t.width = parseInt(t.width), t.height = parseInt(t.height);
                  const o = (n) => Math.ceil(Math.log(n / t.tileSize) / Math.log(2));
                  t.maxZoom = Math.max(o(t.width), o(t.height)), t.minZoom = t.minZoom ? parseInt(t.minZoom) : 0, t.minX = 0, t.minY = 0, t.maxX = Math.ceil(t.width / t.tileSize) - 1, t.maxY = Math.ceil(t.height / t.tileSize) - 1;
                }
                break;
              case "wmts":
                if (!e) {
                  const o = (i) => 6378137 * i * Math.PI / 180, n = (i) => 6378137 * Math.log(Math.tan(Math.PI / 360 * (90 + i)));
                  if (t.maxZoom && (t.maxZoom = parseInt(t.maxZoom)), t.minZoom && (t.minZoom = parseInt(t.minZoom)), t.maxLng && t.minLng && t.maxLat && t.minLat) {
                    t.maxLng = parseFloat(t.maxLng), t.minLng = parseFloat(t.minLng), t.maxLat = parseFloat(t.maxLat), t.minLat = parseFloat(t.minLat);
                    const i = o(t.maxLng), d = o(t.minLng), u = n(t.maxLat), x = n(t.minLat);
                    t.minX = Math.floor((a + d) / (2 * a) * Math.pow(2, t.maxZoom)), t.maxX = Math.floor((a + i) / (2 * a) * Math.pow(2, t.maxZoom)), t.minY = Math.floor((a - u) / (2 * a) * Math.pow(2, t.maxZoom)), t.maxY = Math.floor((a - x) / (2 * a) * Math.pow(2, t.maxZoom));
                  }
                }
                break;
              default:
                e = 'Error: Unknown "type" value';
            }
          if (!e) {
            if (!l(t, ["maxX", "minX", "maxY", "minY", "minZoom", "maxZoom"])) {
              t.totalTile = 0;
              const o = (n, i) => Math.floor(n / Math.pow(2, t.maxZoom - i));
              for (let n = t.minZoom; n <= t.maxZoom; n++) {
                const i = o(t.minX, n), d = o(t.minY, n), u = o(t.maxX, n), x = o(t.maxY, n);
                t.totalTile += (u - i + 1) * (x - d + 1);
              }
            }
            await E(s, "mapSetting", t), await p(`Weiwudi_${t.mapID}`, "tileCache", "z_x_y"), e = new Response(JSON.stringify(t), {
              headers: new Headers({
                "content-type": "application/json"
              })
            });
          }
          break;
        }
        case "clean":
          if (e = l(t, ["mapID"]), r && r.mapID == t.mapID)
            e = `Error: ${t.mapID} is under fetching process. Please cancel it first`;
          else if (!e) {
            const s = await p(`Weiwudi_${t.mapID}`);
            await D(s, "tileCache"), e = `Cleaned: ${t.mapID}`;
          }
          break;
        case "delete":
          if (e = l(t, ["mapID"]), r && r.mapID == t.mapID)
            e = `Error: ${t.mapID} is under fetching process. Please cancel it first`;
          else if (!e) {
            await w(`Weiwudi_${t.mapID}`);
            const s = await p("Weiwudi");
            await L(s, "mapSetting", t.mapID), e = `Deleted: ${t.mapID}`;
          }
          break;
        case "cancel":
          e = l(t, ["mapID"]), r && r.mapID == t.mapID ? (r.cancel = !0, e = `Fetching process of ${r.mapID} is canceled`) : e = `Error: There are no fetching process of ${t.mapID}`;
          break;
        case "stats":
          if (e = l(t, ["mapID"]), !e) {
            const s = await p("Weiwudi"), o = await M(s, "mapSetting", t.mapID);
            if (!o) e = `Error: MapID "${t.mapID}" not found`;
            else {
              const n = await p(`Weiwudi_${t.mapID}`), i = await R(n, "tileCache");
              o.totalTile && (i.total = o.totalTile, i.percent = Math.floor(i.count / i.total * 100)), e = new Response(JSON.stringify(i), {
                headers: new Headers({
                  "content-type": "application/json"
                })
              });
            }
          }
          break;
        case "cache": {
          const s = h.match(/^([^/]+)\/(\d+)\/(\d+)\/(\d+)$/);
          s ? e = await X(s[1], parseInt(s[2]), parseInt(s[3]), parseInt(s[4])) : e = 'Error: "cache" api needs mapID, zoom, x, y settings';
          break;
        }
        case "fetchAll":
          if (e = l(t, ["mapID"]), !e) {
            const s = await p("Weiwudi"), o = await M(s, "mapSetting", t.mapID);
            o ? o.totalTile ? r ? e = `Error: Another fetching process is running: "${r.mapID}" (${r.count} / ${r.total})` : (setTimeout(() => {
              r = {
                mapID: t.mapID,
                total: o.totalTile,
                count: 0,
                error: 0
              }, W(c, o);
            }, 1), e = `Fetching task start: ${t.mapID}`) : e = `Error: Map "${t.mapID}" cannot fetch all tiles` : e = `Error: MapID "${t.mapID}" not found`;
          }
          break;
        default:
          e = `Error: API ${m} not found`;
      }
    } catch (s) {
      e = `Error: ${s}`;
    }
    if (e) return e;
  };
  A(/^https?:\/\/weiwudi.example.com/, U, "GET");
}
j(V);
//# sourceMappingURL=weiwudi-sw.es.js.map
