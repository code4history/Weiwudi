import { registerRoute as W } from "workbox-routing";
function J(R) {
  const u = 20037508342789244e-9, D = {}, Z = /* @__PURE__ */ new Set();
  let A;
  self.addEventListener("install", (s) => {
    s.waitUntil(self.skipWaiting());
  }), self.addEventListener("activate", (s) => {
    s.waitUntil(self.clients.claim());
  });
  const k = (s, t, r, c) => s.replace("{z}", String(t)).replace("{x}", String(r)).replace("{y}", String(c)).replace("{-y}", String(Math.pow(2, t) - c - 1)), X = (s, t = "", r = 512) => {
    const c = atob(s), o = [];
    for (let a = 0; a < c.length; a += r) {
      const e = c.slice(a, a + r), n = new Array(e.length);
      for (let m = 0; m < e.length; m++)
        n[m] = e.charCodeAt(m);
      const i = new Uint8Array(n);
      o.push(i);
    }
    return new Blob(o, { type: t });
  }, T = (s) => {
    const t = new Error(`Opening database "${s}" is blocked by another connection`);
    return t.name = "BlockedError", t;
  }, v = (s, t, r, c) => new Promise((o, l) => {
    try {
      const a = t === void 0 ? indexedDB.open(s) : indexedDB.open(s, t);
      a.onupgradeneeded = function() {
        const e = a.result;
        r && c && !e.objectStoreNames.contains(r) && e.createObjectStore(r, { keyPath: c });
      }, a.onsuccess = function() {
        const e = a.result;
        Z.delete(s), e.onversionchange = function() {
          e.close(), D[s] === e && delete D[s];
        }, D[s] = e, o(e);
      }, a.onerror = function() {
        Z.delete(s), l(a.error);
      }, a.onblocked = function() {
        Z.add(s), l(T(s));
      };
    } catch (a) {
      l(a);
    }
  }), M = async (s, t, r) => {
    if (Z.has(s)) throw T(s);
    const c = D[s] ?? await v(s, void 0, t, r);
    if (!t || !r || c.objectStoreNames.contains(t)) return c;
    const { version: o } = c;
    return c.close(), D[s] === c && delete D[s], v(s, o + 1, t, r);
  }, $ = () => M("Weiwudi", "mapSetting", "mapID"), Y = async (s) => (D[s] && (D[s].close(), delete D[s]), new Promise((t, r) => {
    try {
      const c = indexedDB.deleteDatabase(s);
      c.onsuccess = async (o) => {
        t();
      }, c.onerror = function(o) {
        r(o);
      };
    } catch (c) {
      r(c);
    }
  })), C = async (s, t) => new Promise((r, c) => {
    const o = s.transaction([t], "readwrite"), a = o.objectStore(t).clear();
    a.onsuccess = function(e) {
    }, a.onerror = function(e) {
      c(e);
    }, o.oncomplete = function(e) {
      r();
    }, o.onabort = function(e) {
      c(e);
    }, o.onerror = function(e) {
      c(e);
    };
  }), z = async (s, t) => new Promise((r, c) => {
    const o = s.transaction([t], "readonly"), a = o.objectStore(t).openCursor();
    let e = 0, n = 0;
    a.onsuccess = function(i) {
      const m = a.result;
      m && (e++, n = n + m.value.blob.size, m.continue());
    }, a.onerror = function(i) {
      c(i);
    }, o.oncomplete = function(i) {
      r({
        count: e,
        size: n
      });
    }, o.onabort = function(i) {
      c(i);
    }, o.onerror = function(i) {
      c(i);
    };
  }), E = async (s, t, r, c) => new Promise((o, l) => {
    const a = s.transaction([t], "readonly"), e = a.objectStore(t), n = c ? e.getKey(r) : e.get(r);
    n.onsuccess = function(i) {
    }, n.onerror = function(i) {
      l(i);
    }, a.oncomplete = function(i) {
      o(n.result);
    }, a.onabort = function(i) {
      l(i);
    }, a.onerror = function(i) {
      l(i);
    };
  }), S = async (s, t, r) => new Promise((c, o) => {
    const l = s.transaction([t], "readwrite"), e = l.objectStore(t).put(r);
    e.onsuccess = function(n) {
    }, e.onerror = function(n) {
      o(n);
    }, l.oncomplete = function(n) {
      c();
    }, l.onabort = function(n) {
      o(n);
    }, l.onerror = function(n) {
      o(n);
    };
  }), F = async (s, t, r) => new Promise((c, o) => {
    const l = s.transaction([t], "readwrite"), e = l.objectStore(t).delete(r);
    e.onsuccess = function(n) {
    }, e.onerror = function(n) {
      o(n);
    }, l.oncomplete = function(n) {
      c();
    }, l.onabort = function(n) {
      o(n);
    }, l.onerror = function(n) {
      o(n);
    };
  }), L = async (s, t) => new Promise((r, c) => {
    const o = s.transaction([t], "readwrite"), a = o.objectStore(t).getAllKeys();
    a.onsuccess = function(e) {
    }, a.onerror = function(e) {
      c(e);
    }, o.oncomplete = function(e) {
      r(a.result);
    }, o.onabort = function(e) {
      c(e);
    }, o.onerror = function(e) {
      c(e);
    };
  }), P = async (s, t, r, c) => new Promise((o, l) => {
    const a = s.transaction([t], "readwrite"), e = a.objectStore(t), n = [], i = e.openCursor();
    i.onsuccess = function(m) {
      const h = i.result;
      if (h) {
        const f = h.value;
        f && f.z_x_y && n.push({
          key: f.z_x_y,
          size: f.blob ? f.blob.size : 0,
          accessedAt: typeof f.accessedAt == "number" ? f.accessedAt : f.epoch || 0
        }), h.continue();
      } else {
        n.sort((d, w) => d.accessedAt !== w.accessedAt ? d.accessedAt - w.accessedAt : d.key < w.key ? -1 : d.key > w.key ? 1 : 0);
        const f = r.blob.size, p = c > 0 && f <= c, g = p ? n.filter((d) => d.key !== r.z_x_y) : n.slice();
        let b = g.reduce((d, w) => d + w.size, 0);
        const I = p ? c - f : c;
        let x = 0;
        for (; b > I && x < g.length; )
          e.delete(g[x].key), b -= g[x].size, x++;
        p && e.put(r);
      }
    }, i.onerror = function(m) {
      l(m);
    }, a.oncomplete = function(m) {
      o();
    }, a.onabort = function(m) {
      l(m);
    }, a.onerror = function(m) {
      l(m);
    };
  }), N = async ({ url: s, event: t }) => {
    const r = t instanceof FetchEvent ? t : void 0, c = r && r.clientId ? await self.clients.get(r.clientId) : void 0, o = s.pathname.match(/^\/api\/([\w\d]+)(?:\/(.+))?$/);
    if (o) {
      const l = [...s.searchParams.entries()].reduce((i, m) => {
        const h = s.searchParams.getAll(m[0]);
        return h.length === 1 ? i[m[0]] = h[0] : i[m[0]] = h, i;
      }, {}), a = o[1], e = o[2];
      let n = await H(a, l, e, c);
      if (n)
        return n instanceof Response || (n = new Response(n)), n;
    }
    return new Response("Not Found", { status: 404 });
  }, B = async (s, t, r, c, o) => {
    let l;
    const a = await $(), e = await E(a, "mapSetting", s);
    if (!o) {
      if (!e) return `Error: MapID "${s}" not found`;
      if (t < (e.minZoom || 0) || t > (e.maxZoom ?? 1 / 0)) l = "zoom";
      else if (e.maxZoom !== void 0 && e.minX !== void 0 && e.maxX !== void 0 && e.minY !== void 0 && e.maxY !== void 0) {
        const f = Math.pow(2, (e.maxZoom || 0) - t), p = Math.floor((e.minX || 0) / f), g = Math.floor((e.maxX || 0) / f), b = Math.floor((e.minY || 0) / f), I = Math.floor((e.maxY || 0) / f);
        (r < p || r > g || c < b || c > I) && (l = "extent");
      }
    }
    let n = {}, i, m = 200, h = "OK";
    if (l)
      l === "zoom" ? (m = 404, h = "Not Found") : (n = {
        "content-type": "image/png"
      }, i = X("iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAMAAABrrFhUAAAAB3RJTUUH3QgIBToaSbAjlwAAABd0RVh0U29mdHdhcmUAR0xEUE5HIHZlciAzLjRxhaThAAAACHRwTkdHTEQzAAAAAEqAKR8AAAAEZ0FNQQAAsY8L/GEFAAAAA1BMVEX///+nxBvIAAAAAXRSTlMAQObYZgAAAFRJREFUeNrtwQEBAAAAgJD+r+4ICgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgBDwABHHIJwwAAAABJRU5ErkJggg==", n["content-type"]));
    else {
      const f = await M(`Weiwudi_${s}`), p = await E(f, "tileCache", `${t}_${r}_${c}`, o), g = (/* @__PURE__ */ new Date()).getTime(), b = e.cacheTtl ?? 864e5;
      if (!p || !p.epoch || g - p.epoch > b) {
        let I = "";
        e.url instanceof Array ? I = e.url[Math.floor(Math.random() * e.url.length)] : typeof e.url == "string" && (I = e.url);
        const x = k(I, t, r, c);
        try {
          const d = await fetch(x);
          if (d.ok) {
            n = {}, d.headers.forEach((w, _) => {
              n[_] = w;
            }), i = await d.blob();
            try {
              const w = {
                z_x_y: `${t}_${r}_${c}`,
                headers: n,
                blob: i,
                epoch: g,
                accessedAt: g
              }, _ = e.cacheMaxBytes;
              _ === void 0 ? await S(f, "tileCache", w) : await P(f, "tileCache", w, _);
            } catch {
              A && A.error++;
            }
          } else
            p ? (n = p.headers, i = p.blob) : (m = d.status, h = d.statusText, n = {}, d.headers.forEach((w, _) => {
              n[_] = w;
            }), i = await d.blob()), A && A.error++;
        } catch {
          p ? (n = p.headers, i = p.blob) : (m = 404, h = "Not Found"), A && A.error++;
        }
      } else if (!o) {
        n = p.headers, i = p.blob;
        try {
          p.accessedAt = g, await S(f, "tileCache", p);
        } catch {
        }
      }
    }
    return o ? void 0 : new Response(i, {
      status: m,
      statusText: h,
      headers: new Headers(n)
    });
  }, U = async (s, t) => {
    let r = 0, c = 0;
    const o = await M(`Weiwudi_${t.mapID}`), l = await L(o, "tileCache");
    try {
      const a = [], e = t.minZoom || 0, n = t.maxZoom || 0;
      for (let h = e; h <= n; h++) {
        const f = Math.pow(2, n - h), p = Math.floor((t.maxX || 0) / f), g = Math.floor((t.minX || 0) / f), b = Math.floor((t.maxY || 0) / f), I = Math.floor((t.minY || 0) / f);
        for (let x = g; x <= p; x++)
          for (let d = I; d <= b; d++)
            a.push([h, x, d]);
      }
      a.length != t.totalTile && console.log("Number of tiles is different");
      let i = a.splice(0, 5);
      for (; i.length; ) {
        if (!await self.clients.get(s.id)) {
          A = void 0;
          return;
        }
        if (A && A.cancel) {
          A = void 0, s.postMessage({
            type: "canceled",
            message: `Fetching tile of ${t.mapID} is canceled`,
            mapID: t.mapID
          });
          return;
        }
        const f = i.map((p) => {
          if (!(l.indexOf(`${p[0]}_${p[1]}_${p[2]}`) >= 0))
            return B(t.mapID, p[0], p[1], p[2], !0);
        });
        await Promise.all(f), r += f.length, A && (A.count = r), c = Math.floor(r * 100 / (t.totalTile || 1)), s.postMessage({
          type: "proceed",
          message: `Proceeding the tile fetching: ${t.mapID} ${c}% (${r} / ${t.totalTile})`,
          percent: c,
          processed: r,
          error: A ? A.error : 0,
          total: t.totalTile,
          mapID: t.mapID
        }), i = a.splice(0, 5);
      }
      const m = A ? A.error : 0;
      A = void 0, s.postMessage({
        type: "finish",
        message: `Fetched all tiles of ${t.mapID}${m ? ` with ${m} error cases` : ""}`,
        total: t.totalTile,
        mapID: t.mapID,
        error: m
      });
    } catch (a) {
      A = void 0, s.postMessage({
        type: "stop",
        message: `Fetching stopped: ${t.mapID} ${r} / ${t.totalTile}`,
        reason: a,
        processed: r,
        total: t.totalTile,
        mapID: t.mapID
      });
    }
  }, H = async (s, t, r, c) => {
    let o;
    const l = (a, e) => e.reduce((n, i) => n || (a[i] === void 0 ? `Error: Attribute "${i}" is missing` : n), void 0);
    try {
      switch (s) {
        case "ping":
          o = "Implemented";
          break;
        case "info":
          if (o = l(t, ["mapID"]), !o) {
            const a = await $(), e = await E(a, "mapSetting", t.mapID);
            e ? o = new Response(JSON.stringify(e), {
              headers: new Headers({
                "content-type": "application/json"
              })
            }) : o = `Error: MapID "${t.mapID}" not found`;
          }
          break;
        case "add": {
          const a = await $();
          if (o = l(t, ["mapID", "type", "url"]), !o) {
            if (t.tileSize = parseInt(t.tileSize || 256), t.cacheTtl !== void 0 && (t.cacheTtl = parseInt(t.cacheTtl)), t.cacheMaxBytes !== void 0) {
              const e = String(t.cacheMaxBytes).trim(), n = parseInt(e);
              !Number.isFinite(n) || n < 0 || String(n) !== e ? o = 'Error: Attribute "cacheMaxBytes" is not a valid non-negative integer' : t.cacheMaxBytes = n;
            }
            switch (t.type) {
              case "xyz":
                if (o || (o = l(t, ["width", "height"])), !o) {
                  t.width = parseInt(t.width), t.height = parseInt(t.height);
                  const e = (n) => Math.ceil(Math.log(n / t.tileSize) / Math.log(2));
                  t.maxZoom = Math.max(e(t.width), e(t.height)), t.minZoom = t.minZoom ? parseInt(t.minZoom) : 0, t.minX = 0, t.minY = 0, t.maxX = Math.ceil(t.width / t.tileSize) - 1, t.maxY = Math.ceil(t.height / t.tileSize) - 1;
                }
                break;
              case "wmts":
                if (!o) {
                  const e = (i) => 6378137 * i * Math.PI / 180, n = (i) => 6378137 * Math.log(Math.tan(Math.PI / 360 * (90 + i)));
                  if (t.maxZoom && (t.maxZoom = parseInt(t.maxZoom)), t.minZoom && (t.minZoom = parseInt(t.minZoom)), t.maxLng && t.minLng && t.maxLat && t.minLat) {
                    t.maxLng = parseFloat(t.maxLng), t.minLng = parseFloat(t.minLng), t.maxLat = parseFloat(t.maxLat), t.minLat = parseFloat(t.minLat);
                    const i = e(t.maxLng), m = e(t.minLng), h = n(t.maxLat), f = n(t.minLat);
                    t.minX = Math.floor((u + m) / (2 * u) * Math.pow(2, t.maxZoom)), t.maxX = Math.floor((u + i) / (2 * u) * Math.pow(2, t.maxZoom)), t.minY = Math.floor((u - h) / (2 * u) * Math.pow(2, t.maxZoom)), t.maxY = Math.floor((u - f) / (2 * u) * Math.pow(2, t.maxZoom));
                  }
                }
                break;
              default:
                o = 'Error: Unknown "type" value';
            }
          }
          if (!o) {
            if (!l(t, ["maxX", "minX", "maxY", "minY", "minZoom", "maxZoom"])) {
              t.totalTile = 0;
              const e = (n, i) => Math.floor(n / Math.pow(2, t.maxZoom - i));
              for (let n = t.minZoom; n <= t.maxZoom; n++) {
                const i = e(t.minX, n), m = e(t.minY, n), h = e(t.maxX, n), f = e(t.maxY, n);
                t.totalTile += (h - i + 1) * (f - m + 1);
              }
            }
            await S(a, "mapSetting", t), await M(`Weiwudi_${t.mapID}`, "tileCache", "z_x_y"), o = new Response(JSON.stringify(t), {
              headers: new Headers({
                "content-type": "application/json"
              })
            });
          }
          break;
        }
        case "clean":
          if (o = l(t, ["mapID"]), A && A.mapID == t.mapID)
            o = `Error: ${t.mapID} is under fetching process. Please cancel it first`;
          else if (!o) {
            const a = await M(`Weiwudi_${t.mapID}`);
            await C(a, "tileCache"), o = `Cleaned: ${t.mapID}`;
          }
          break;
        case "delete":
          if (o = l(t, ["mapID"]), A && A.mapID == t.mapID)
            o = `Error: ${t.mapID} is under fetching process. Please cancel it first`;
          else if (!o) {
            await Y(`Weiwudi_${t.mapID}`);
            const a = await $();
            await F(a, "mapSetting", t.mapID), o = `Deleted: ${t.mapID}`;
          }
          break;
        case "cancel":
          o = l(t, ["mapID"]), A && A.mapID == t.mapID ? (A.cancel = !0, o = `Fetching process of ${A.mapID} is canceled`) : o = `Error: There are no fetching process of ${t.mapID}`;
          break;
        case "stats":
          if (o = l(t, ["mapID"]), !o) {
            const a = await $(), e = await E(a, "mapSetting", t.mapID);
            if (!e) o = `Error: MapID "${t.mapID}" not found`;
            else {
              const n = await M(`Weiwudi_${t.mapID}`), i = await z(n, "tileCache");
              e.totalTile && (i.total = e.totalTile, i.percent = Math.floor(i.count / i.total * 100)), o = new Response(JSON.stringify(i), {
                headers: new Headers({
                  "content-type": "application/json"
                })
              });
            }
          }
          break;
        case "cache": {
          const a = r?.match(/^([^/]+)\/(\d+)\/(\d+)\/(\d+)$/);
          a ? o = await B(a[1], parseInt(a[2]), parseInt(a[3]), parseInt(a[4])) : o = 'Error: "cache" api needs mapID, zoom, x, y settings';
          break;
        }
        case "fetchAll":
          if (o = l(t, ["mapID"]), !o && c) {
            const a = await $(), e = await E(a, "mapSetting", t.mapID);
            e ? e.totalTile ? A ? o = `Error: Another fetching process is running: "${A.mapID}" (${A.count} / ${A.total})` : (setTimeout(() => {
              A = {
                mapID: t.mapID,
                total: e.totalTile || 0,
                count: 0,
                error: 0
              }, U(c, e);
            }, 1), o = `Fetching task start: ${t.mapID}`) : o = `Error: Map "${t.mapID}" cannot fetch all tiles` : o = `Error: MapID "${t.mapID}" not found`;
          }
          break;
        default:
          o = `Error: API ${s} not found`;
      }
    } catch (a) {
      o = `Error: ${a}`;
    }
    if (o) return o;
  };
  R(/^https?:\/\/weiwudi.example.com/, N, "GET");
}
J(W);
//# sourceMappingURL=weiwudi-sw.es.js.map
