try {
  self["workbox:core:7.3.0"] && _();
} catch {
}
const O = (A, ...a) => {
  let f = A;
  return a.length > 0 && (f += ` :: ${JSON.stringify(a)}`), f;
}, J = O;
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
    const i = J(a, f);
    super(i), this.name = a, this.details = f;
  }
}
try {
  self["workbox:routing:7.3.0"] && _();
} catch {
}
const F = "GET", P = (A) => A && typeof A == "object" ? A : { handle: A };
class B {
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
  constructor(a, f, i = F) {
    this.handler = P(f), this.match = a, this.method = i;
  }
  /**
   *
   * @param {workbox-routing-handlerCallback} handler A callback
   * function that returns a Promise resolving to a Response
   */
  setCatchHandler(a) {
    this.catchHandler = P(a);
  }
}
class K extends B {
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
  constructor(a, f, i) {
    const x = ({ url: D }) => {
      const p = a.exec(D.href);
      if (p && !(D.origin !== location.origin && p.index !== 0))
        return p.slice(1);
    };
    super(x, f, i);
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
      const { request: f } = a, i = this.handleRequest({ request: f, event: a });
      i && a.respondWith(i);
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
        const { payload: f } = a.data, i = Promise.all(f.urlsToCache.map((x) => {
          typeof x == "string" && (x = [x]);
          const D = new Request(...x);
          return this.handleRequest({ request: D, event: a });
        }));
        a.waitUntil(i), a.ports && a.ports[0] && i.then(() => a.ports[0].postMessage(!0));
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
    const i = new URL(a.url, location.href);
    if (!i.protocol.startsWith("http"))
      return;
    const x = i.origin === location.origin, { params: D, route: p } = this.findMatchingRoute({
      event: f,
      request: a,
      sameOrigin: x,
      url: i
    });
    let I = p && p.handler;
    const M = a.method;
    if (!I && this._defaultHandlerMap.has(M) && (I = this._defaultHandlerMap.get(M)), !I)
      return;
    let $;
    try {
      $ = I.handle({ url: i, request: a, event: f, params: D });
    } catch (E) {
      $ = Promise.reject(E);
    }
    const R = p && p.catchHandler;
    return $ instanceof Promise && (this._catchHandler || R) && ($ = $.catch(async (E) => {
      if (R)
        try {
          return await R.handle({ url: i, request: a, event: f, params: D });
        } catch (L) {
          L instanceof Error && (E = L);
        }
      if (this._catchHandler)
        return this._catchHandler.handle({ url: i, request: a, event: f });
      throw E;
    })), $;
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
  findMatchingRoute({ url: a, sameOrigin: f, request: i, event: x }) {
    const D = this._routes.get(i.method) || [];
    for (const p of D) {
      let I;
      const M = p.match({ url: a, sameOrigin: f, request: i, event: x });
      if (M)
        return I = M, (Array.isArray(I) && I.length === 0 || M.constructor === Object && // eslint-disable-line
        Object.keys(M).length === 0 || typeof M == "boolean") && (I = void 0), { route: p, params: I };
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
  setDefaultHandler(a, f = F) {
    this._defaultHandlerMap.set(f, P(a));
  }
  /**
   * If a Route throws an error while handling a request, this `handler`
   * will be called and given a chance to provide a response.
   *
   * @param {workbox-routing~handlerCallback} handler A callback
   * function that returns a Promise resulting in a Response.
   */
  setCatchHandler(a) {
    this._catchHandler = P(a);
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
const v = () => (C || (C = new Q(), C.addFetchListener(), C.addCacheListener()), C);
function G(A, a, f) {
  let i;
  if (typeof A == "string") {
    const D = new URL(A, location.href), p = ({ url: I }) => I.href === D.href;
    i = new B(p, a, f);
  } else if (A instanceof RegExp)
    i = new K(A, a, f);
  else if (typeof A == "function")
    i = new B(A, a, f);
  else if (A instanceof B)
    i = A;
  else
    throw new k("unsupported-route-type", {
      moduleName: "workbox-routing",
      funcName: "registerRoute",
      paramName: "capture"
    });
  return v().registerRoute(i), i;
}
function V(A) {
  const a = 20037508342789244e-9, f = {};
  let i;
  const x = (h, t, l, c) => h.replace("{z}", String(t)).replace("{x}", String(l)).replace("{y}", String(c)).replace("{-y}", String(Math.pow(2, t) - c - 1)), D = (h, t = "", l = 512) => {
    const c = atob(h), e = [];
    for (let s = 0; s < c.length; s += l) {
      const o = c.slice(s, s + l), n = new Array(o.length);
      for (let d = 0; d < o.length; d++)
        n[d] = o.charCodeAt(d);
      const r = new Uint8Array(n);
      e.push(r);
    }
    return new Blob(e, { type: t });
  }, p = async (h, t, l) => new Promise((c, e) => {
    try {
      if (f[h]) c(f[h]);
      else {
        const m = indexedDB.open(h);
        m.onupgradeneeded = function(s) {
          const o = s.target.result;
          t && l && o.createObjectStore(t, { keyPath: l });
        }, m.onsuccess = function(s) {
          const o = s.target.result;
          f[h] = o, c(o);
        }, m.onerror = function(s) {
          e(m.error);
        };
      }
    } catch (m) {
      e(m);
    }
  }), I = async (h) => (f[h] && (f[h].close(), delete f[h]), new Promise((t, l) => {
    try {
      const c = indexedDB.deleteDatabase(h);
      c.onsuccess = async (e) => {
        t();
      }, c.onerror = function(e) {
        l(e);
      };
    } catch (c) {
      l(c);
    }
  })), M = async (h, t) => new Promise((l, c) => {
    const e = h.transaction([t], "readwrite"), s = e.objectStore(t).clear();
    s.onsuccess = function(o) {
    }, s.onerror = function(o) {
      c(o);
    }, e.oncomplete = function(o) {
      l();
    }, e.onabort = function(o) {
      c(o);
    }, e.onerror = function(o) {
      c(o);
    };
  }), $ = async (h, t) => new Promise((l, c) => {
    const e = h.transaction([t], "readonly"), s = e.objectStore(t).openCursor();
    let o = 0, n = 0;
    s.onsuccess = function(r) {
      const d = s.result;
      d && (o++, n = n + d.value.blob.size, d.continue());
    }, s.onerror = function(r) {
      c(r);
    }, e.oncomplete = function(r) {
      l({
        count: o,
        size: n
      });
    }, e.onabort = function(r) {
      c(r);
    }, e.onerror = function(r) {
      c(r);
    };
  }), R = async (h, t, l, c) => new Promise((e, m) => {
    const s = h.transaction([t], "readonly"), o = s.objectStore(t), n = c ? o.getKey(l) : o.get(l);
    n.onsuccess = function(r) {
    }, n.onerror = function(r) {
      m(r);
    }, s.oncomplete = function(r) {
      e(n.result);
    }, s.onabort = function(r) {
      m(r);
    }, s.onerror = function(r) {
      m(r);
    };
  }), E = async (h, t, l) => new Promise((c, e) => {
    const m = h.transaction([t], "readwrite"), o = m.objectStore(t).put(l);
    o.onsuccess = function(n) {
    }, o.onerror = function(n) {
      e(n);
    }, m.oncomplete = function(n) {
      c();
    }, m.onabort = function(n) {
      e(n);
    }, m.onerror = function(n) {
      e(n);
    };
  }), L = async (h, t, l) => new Promise((c, e) => {
    const m = h.transaction([t], "readwrite"), o = m.objectStore(t).delete(l);
    o.onsuccess = function(n) {
    }, o.onerror = function(n) {
      e(n);
    }, m.oncomplete = function(n) {
      c();
    }, m.onabort = function(n) {
      e(n);
    }, m.onerror = function(n) {
      e(n);
    };
  }), U = async (h, t) => new Promise((l, c) => {
    const e = h.transaction([t], "readwrite"), s = e.objectStore(t).getAllKeys();
    s.onsuccess = function(o) {
    }, s.onerror = function(o) {
      c(o);
    }, e.oncomplete = function(o) {
      l(s.result);
    }, e.onabort = function(o) {
      c(o);
    }, e.onerror = function(o) {
      c(o);
    };
  }), W = async ({ url: h, event: t }) => {
    const l = t instanceof FetchEvent ? t : void 0, c = l && l.clientId ? await self.clients.get(l.clientId) : void 0, e = h.pathname.match(/^\/api\/([\w\d]+)(?:\/(.+))?$/);
    if (e) {
      const m = [...h.searchParams.entries()].reduce((r, d) => {
        const g = h.searchParams.getAll(d[0]);
        return g.length === 1 ? r[d[0]] = g[0] : r[d[0]] = g, r;
      }, {}), s = e[1], o = e[2];
      let n = await z(s, m, o, c);
      if (n)
        return n instanceof Response || (n = new Response(n)), n;
    }
    return new Response("Not Found", { status: 404 });
  }, Y = async (h, t, l, c, e) => {
    let m;
    const s = await p("Weiwudi"), o = await R(s, "mapSetting", h);
    if (!e) {
      if (!o) return `Error: MapID "${h}" not found`;
      if (t < (o.minZoom || 0) || t > (o.maxZoom || 0)) m = "zoom";
      else {
        const w = Math.pow(2, (o.maxZoom || 0) - t), u = Math.floor((o.minX || 0) / w), T = Math.floor((o.maxX || 0) / w), Z = Math.floor((o.minY || 0) / w), H = Math.floor((o.maxY || 0) / w);
        (l < u || l > T || c < Z || c > H) && (m = "extent");
      }
    }
    let n = {}, r, d = 200, g = "OK";
    if (m)
      m === "zoom" ? (d = 404, g = "Not Found") : (n = {
        "content-type": "image/png"
      }, r = D("iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAMAAABrrFhUAAAAB3RJTUUH3QgIBToaSbAjlwAAABd0RVh0U29mdHdhcmUAR0xEUE5HIHZlciAzLjRxhaThAAAACHRwTkdHTEQzAAAAAEqAKR8AAAAEZ0FNQQAAsY8L/GEFAAAAA1BMVEX///+nxBvIAAAAAXRSTlMAQObYZgAAAFRJREFUeNrtwQEBAAAAgJD+r+4ICgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgBDwABHHIJwwAAAABJRU5ErkJggg==", n["content-type"]));
    else {
      const w = await p(`Weiwudi_${h}`), u = await R(w, "tileCache", `${t}_${l}_${c}`, e), T = (/* @__PURE__ */ new Date()).getTime();
      if (!u || !u.epoch || T - u.epoch > 864e5) {
        let Z = "";
        o.url instanceof Array ? Z = o.url[Math.floor(Math.random() * o.url.length)] : typeof o.url == "string" && (Z = o.url);
        const H = x(Z, t, l, c);
        try {
          const b = await fetch(H);
          b.ok ? (n = {}, b.headers.forEach((S, X) => {
            n[X] = S;
          }), r = await b.blob(), await E(w, "tileCache", {
            z_x_y: `${t}_${l}_${c}`,
            headers: n,
            blob: r,
            epoch: T
          })) : (u ? (n = u.headers, r = u.blob) : (d = b.status, g = b.statusText, n = {}, b.headers.forEach((S, X) => {
            n[X] = S;
          }), r = await b.blob()), i && i.error++);
        } catch {
          u ? (n = u.headers, r = u.blob) : (d = 404, g = "Not Found"), i && i.error++;
        }
      } else e || (n = u.headers, r = u.blob);
    }
    return e ? void 0 : new Response(r, {
      status: d,
      statusText: g,
      headers: new Headers(n)
    });
  }, N = async (h, t) => {
    let l = 0, c = 0;
    const e = await p(`Weiwudi_${t.mapID}`), m = await U(e, "tileCache");
    try {
      const s = [], o = t.minZoom || 0, n = t.maxZoom || 0;
      for (let g = o; g <= n; g++) {
        const w = Math.pow(2, n - g), u = Math.floor((t.maxX || 0) / w), T = Math.floor((t.minX || 0) / w), Z = Math.floor((t.maxY || 0) / w), H = Math.floor((t.minY || 0) / w);
        for (let b = T; b <= u; b++)
          for (let S = H; S <= Z; S++)
            s.push([g, b, S]);
      }
      s.length != t.totalTile && console.log("Number of tiles is different");
      let r = s.splice(0, 5);
      for (; r.length; ) {
        if (!await self.clients.get(h.id)) {
          i = void 0;
          return;
        }
        if (i && i.cancel) {
          i = void 0, h.postMessage({
            type: "canceled",
            message: `Fetching tile of ${t.mapID} is canceled`,
            mapID: t.mapID
          });
          return;
        }
        const w = r.map((u) => {
          if (!(m.indexOf(`${u[0]}_${u[1]}_${u[2]}`) >= 0))
            return Y(t.mapID, u[0], u[1], u[2], !0);
        });
        await Promise.all(w), l += w.length, i && (i.count = l), c = Math.floor(l * 100 / (t.totalTile || 1)), h.postMessage({
          type: "proceed",
          message: `Proceeding the tile fetching: ${t.mapID} ${c}% (${l} / ${t.totalTile})`,
          percent: c,
          processed: l,
          error: i ? i.error : 0,
          total: t.totalTile,
          mapID: t.mapID
        }), r = s.splice(0, 5);
      }
      const d = i ? i.error : 0;
      i = void 0, h.postMessage({
        type: "finish",
        message: `Fetched all tiles of ${t.mapID}${d ? ` with ${d} error cases` : ""}`,
        total: t.totalTile,
        mapID: t.mapID,
        error: d
      });
    } catch (s) {
      i = void 0, h.postMessage({
        type: "stop",
        message: `Fetching stopped: ${t.mapID} ${l} / ${t.totalTile}`,
        reason: s,
        processed: l,
        total: t.totalTile,
        mapID: t.mapID
      });
    }
  }, z = async (h, t, l, c) => {
    let e;
    const m = (s, o) => o.reduce((n, r) => n || (s[r] === void 0 ? `Error: Attribute "${r}" is missing` : n), void 0);
    try {
      switch (h) {
        case "ping":
          e = "Implemented";
          break;
        case "info":
          if (e = m(t, ["mapID"]), !e) {
            const s = await p("Weiwudi", "mapSetting", "mapID"), o = await R(s, "mapSetting", t.mapID);
            o ? e = new Response(JSON.stringify(o), {
              headers: new Headers({
                "content-type": "application/json"
              })
            }) : e = `Error: MapID "${t.mapID}" not found`;
          }
          break;
        case "add": {
          const s = await p("Weiwudi", "mapSetting", "mapID");
          if (e = m(t, ["mapID", "type", "url"]), !e)
            switch (t.tileSize = parseInt(t.tileSize || 256), t.type) {
              case "xyz":
                if (e = m(t, ["width", "height"]), !e) {
                  t.width = parseInt(t.width), t.height = parseInt(t.height);
                  const o = (n) => Math.ceil(Math.log(n / t.tileSize) / Math.log(2));
                  t.maxZoom = Math.max(o(t.width), o(t.height)), t.minZoom = t.minZoom ? parseInt(t.minZoom) : 0, t.minX = 0, t.minY = 0, t.maxX = Math.ceil(t.width / t.tileSize) - 1, t.maxY = Math.ceil(t.height / t.tileSize) - 1;
                }
                break;
              case "wmts":
                if (!e) {
                  const o = (r) => 6378137 * r * Math.PI / 180, n = (r) => 6378137 * Math.log(Math.tan(Math.PI / 360 * (90 + r)));
                  if (t.maxZoom && (t.maxZoom = parseInt(t.maxZoom)), t.minZoom && (t.minZoom = parseInt(t.minZoom)), t.maxLng && t.minLng && t.maxLat && t.minLat) {
                    t.maxLng = parseFloat(t.maxLng), t.minLng = parseFloat(t.minLng), t.maxLat = parseFloat(t.maxLat), t.minLat = parseFloat(t.minLat);
                    const r = o(t.maxLng), d = o(t.minLng), g = n(t.maxLat), w = n(t.minLat);
                    t.minX = Math.floor((a + d) / (2 * a) * Math.pow(2, t.maxZoom)), t.maxX = Math.floor((a + r) / (2 * a) * Math.pow(2, t.maxZoom)), t.minY = Math.floor((a - g) / (2 * a) * Math.pow(2, t.maxZoom)), t.maxY = Math.floor((a - w) / (2 * a) * Math.pow(2, t.maxZoom));
                  }
                }
                break;
              default:
                e = 'Error: Unknown "type" value';
            }
          if (!e) {
            if (!m(t, ["maxX", "minX", "maxY", "minY", "minZoom", "maxZoom"])) {
              t.totalTile = 0;
              const o = (n, r) => Math.floor(n / Math.pow(2, t.maxZoom - r));
              for (let n = t.minZoom; n <= t.maxZoom; n++) {
                const r = o(t.minX, n), d = o(t.minY, n), g = o(t.maxX, n), w = o(t.maxY, n);
                t.totalTile += (g - r + 1) * (w - d + 1);
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
          if (e = m(t, ["mapID"]), i && i.mapID == t.mapID)
            e = `Error: ${t.mapID} is under fetching process. Please cancel it first`;
          else if (!e) {
            const s = await p(`Weiwudi_${t.mapID}`);
            await M(s, "tileCache"), e = `Cleaned: ${t.mapID}`;
          }
          break;
        case "delete":
          if (e = m(t, ["mapID"]), i && i.mapID == t.mapID)
            e = `Error: ${t.mapID} is under fetching process. Please cancel it first`;
          else if (!e) {
            await I(`Weiwudi_${t.mapID}`);
            const s = await p("Weiwudi");
            await L(s, "mapSetting", t.mapID), e = `Deleted: ${t.mapID}`;
          }
          break;
        case "cancel":
          e = m(t, ["mapID"]), i && i.mapID == t.mapID ? (i.cancel = !0, e = `Fetching process of ${i.mapID} is canceled`) : e = `Error: There are no fetching process of ${t.mapID}`;
          break;
        case "stats":
          if (e = m(t, ["mapID"]), !e) {
            const s = await p("Weiwudi"), o = await R(s, "mapSetting", t.mapID);
            if (!o) e = `Error: MapID "${t.mapID}" not found`;
            else {
              const n = await p(`Weiwudi_${t.mapID}`), r = await $(n, "tileCache");
              o.totalTile && (r.total = o.totalTile, r.percent = Math.floor(r.count / r.total * 100)), e = new Response(JSON.stringify(r), {
                headers: new Headers({
                  "content-type": "application/json"
                })
              });
            }
          }
          break;
        case "cache": {
          const s = l?.match(/^([^/]+)\/(\d+)\/(\d+)\/(\d+)$/);
          s ? e = await Y(s[1], parseInt(s[2]), parseInt(s[3]), parseInt(s[4])) : e = 'Error: "cache" api needs mapID, zoom, x, y settings';
          break;
        }
        case "fetchAll":
          if (e = m(t, ["mapID"]), !e && c) {
            const s = await p("Weiwudi"), o = await R(s, "mapSetting", t.mapID);
            o ? o.totalTile ? i ? e = `Error: Another fetching process is running: "${i.mapID}" (${i.count} / ${i.total})` : (setTimeout(() => {
              i = {
                mapID: t.mapID,
                total: o.totalTile || 0,
                count: 0,
                error: 0
              }, N(c, o);
            }, 1), e = `Fetching task start: ${t.mapID}`) : e = `Error: Map "${t.mapID}" cannot fetch all tiles` : e = `Error: MapID "${t.mapID}" not found`;
          }
          break;
        default:
          e = `Error: API ${h} not found`;
      }
    } catch (s) {
      e = `Error: ${s}`;
    }
    if (e) return e;
  };
  A(/^https?:\/\/weiwudi.example.com/, W, "GET");
}
V(G);
//# sourceMappingURL=weiwudi-sw.es.js.map
