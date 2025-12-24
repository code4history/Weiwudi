import { registerRoute as F } from "workbox-routing";
function W(E) {
  const w = 20037508342789244e-9, g = {};
  let p;
  const T = (r, t, l, c) => r.replace("{z}", t).replace("{x}", l).replace("{y}", c).replace("{-y}", Math.pow(2, t) - c - 1), R = (r, t = "", l = 512) => {
    const c = atob(r), o = [];
    for (let n = 0; n < c.length; n += l) {
      const e = c.slice(n, n + l), a = new Array(e.length);
      for (let m = 0; m < e.length; m++)
        a[m] = e.charCodeAt(m);
      const s = new Uint8Array(a);
      o.push(s);
    }
    return new Blob(o, { type: t });
  }, d = async (r, t, l) => new Promise((c, o) => {
    try {
      if (g[r]) c(g[r]);
      else {
        const i = indexedDB.open(r);
        i.onupgradeneeded = function(n) {
          n.target.result.createObjectStore(t, { keyPath: l });
        }, i.onsuccess = function(n) {
          const e = n.target.result;
          g[r] = e, c(e);
        }, i.onerror = function(n) {
          o(n);
        };
      }
    } catch (i) {
      o(i);
    }
  }), B = async (r) => (g[r] && (g[r].close(), delete g[r]), new Promise((t, l) => {
    try {
      const c = indexedDB.deleteDatabase(r);
      c.onsuccess = async (o) => {
        t();
      }, c.onerror = function(o) {
        l(o);
      };
    } catch (c) {
      l(c);
    }
  })), S = async (r, t) => new Promise((l, c) => {
    const o = r.transaction([t], "readwrite"), n = o.objectStore(t).clear();
    n.onsuccess = function(e) {
    }, n.onerror = function(e) {
      c(e);
    }, o.oncomplete = function(e) {
      l();
    }, o.onabort = function(e) {
      c(e);
    }, o.onerror = function(e) {
      c(e);
    };
  }), X = async (r, t) => new Promise((l, c) => {
    const o = r.transaction([t], "readonly"), n = o.objectStore(t).openCursor();
    let e = 0, a = 0;
    n.onsuccess = function(s) {
      const m = n.result;
      m && (e++, a = a + m.value.blob.size, m.continue());
    }, n.onerror = function(s) {
      c(s);
    }, o.oncomplete = function(s) {
      l({
        count: e,
        size: a
      });
    }, o.onabort = function(s) {
      c(s);
    }, o.onerror = function(s) {
      c(s);
    };
  }), M = async (r, t, l, c) => new Promise((o, i) => {
    const n = r.transaction([t], "readonly"), e = n.objectStore(t), a = c ? e.getKey(l) : e.get(l);
    a.onsuccess = function(s) {
    }, a.onerror = function(s) {
      i(s);
    }, n.oncomplete = function(s) {
      o(a.result);
    }, n.onabort = function(s) {
      i(s);
    }, n.onerror = function(s) {
      i(s);
    };
  }), $ = async (r, t, l) => new Promise((c, o) => {
    const i = r.transaction([t], "readwrite"), e = i.objectStore(t).put(l);
    e.onsuccess = function(a) {
    }, e.onerror = function(a) {
      o(a);
    }, i.oncomplete = function(a) {
      c();
    }, i.onabort = function(a) {
      o(a);
    }, i.onerror = function(a) {
      o(a);
    };
  }), Y = async (r, t, l) => new Promise((c, o) => {
    const i = r.transaction([t], "readwrite"), e = i.objectStore(t).delete(l);
    e.onsuccess = function(a) {
    }, e.onerror = function(a) {
      o(a);
    }, i.oncomplete = function(a) {
      c();
    }, i.onabort = function(a) {
      o(a);
    }, i.onerror = function(a) {
      o(a);
    };
  }), C = async (r, t) => new Promise((l, c) => {
    const o = r.transaction([t], "readwrite"), n = o.objectStore(t).getAllKeys();
    n.onsuccess = function(e) {
    }, n.onerror = function(e) {
      c(e);
    }, o.oncomplete = function(e) {
      l(n.result);
    }, o.onabort = function(e) {
      c(e);
    }, o.onerror = function(e) {
      c(e);
    };
  }), P = async ({ url: r, request: t, event: l, _params: c }) => {
    const o = l.clientId ? await self.clients.get(l.clientId) : void 0, i = r.pathname.match(/^\/api\/([\w\d]+)(?:\/(.+))?$/);
    if (i) {
      const n = [...r.searchParams.entries()].reduce((m, A) => {
        const h = r.searchParams.getAll(A[0]);
        return h.length === 1 ? m[A[0]] = h[0] : m[A[0]] = h, m;
      }, {}), e = i[1], a = i[2];
      let s = await L(e, n, a, o);
      if (s)
        return s instanceof Response || (s = new Response(s)), s;
    }
  }, Z = async (r, t, l, c, o) => {
    let i;
    const n = await d("Weiwudi"), e = await M(n, "mapSetting", r);
    if (!o) {
      if (!e) return `Error: MapID "${r}" not found`;
      if (t < e.minZoom || t > e.maxZoom) i = "zoom";
      else {
        const h = Math.floor(e.minX / Math.pow(2, e.maxZoom - t)), f = Math.floor(e.maxX / Math.pow(2, e.maxZoom - t)), I = Math.floor(e.minY / Math.pow(2, e.maxZoom - t)), D = Math.floor(e.maxY / Math.pow(2, e.maxZoom - t));
        (l < h || l > f || c < I || c > D) && (i = "extent");
      }
    }
    let a = {}, s, m = 200, A = "OK";
    if (i)
      i === "zoom" ? (m = 404, A = "Not Found") : (a = {
        "content-type": "image/png"
      }, s = R("iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAMAAABrrFhUAAAAB3RJTUUH3QgIBToaSbAjlwAAABd0RVh0U29mdHdhcmUAR0xEUE5HIHZlciAzLjRxhaThAAAACHRwTkdHTEQzAAAAAEqAKR8AAAAEZ0FNQQAAsY8L/GEFAAAAA1BMVEX///+nxBvIAAAAAXRSTlMAQObYZgAAAFRJREFUeNrtwQEBAAAAgJD+r+4ICgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgBDwABHHIJwwAAAABJRU5ErkJggg==", a["content-type"]));
    else {
      const h = await d(`Weiwudi_${r}`), f = await M(h, "tileCache", `${t}_${l}_${c}`, o), I = (/* @__PURE__ */ new Date()).getTime();
      if (!f || !f.epoch || I - f.epoch > 864e5) {
        const D = e.url instanceof Array ? e.url[Math.floor(Math.random() * e.url.length)] : e.url, k = T(D, t, l, c);
        try {
          const x = await fetch(k);
          x.ok ? (a = [...x.headers.entries()].reduce((u, b) => ({ ...u, [b[0]]: b[1] }), {}), s = await x.blob(), await $(h, "tileCache", {
            z_x_y: `${t}_${l}_${c}`,
            headers: a,
            blob: s,
            epoch: I
          })) : (f ? (a = f.headers, s = f.blob) : (m = x.status, A = x.statusText, a = [...x.headers.entries()].reduce((u, b) => ({ ...u, [b[0]]: b[1] }), {}), s = await x.blob()), p && p.error++);
        } catch {
          f ? (a = f.headers, s = f.blob) : (m = 404, A = "Not Found"), p && p.error++;
        }
      } else o || (a = f.headers, s = f.blob);
    }
    return o ? void 0 : new Response(s, {
      status: m,
      statusText: A,
      headers: new Headers(a)
    });
  }, _ = async (r, t) => {
    let l = 0, c = 0;
    const o = await d(`Weiwudi_${t.mapID}`), i = await C(o, "tileCache");
    try {
      const n = [];
      for (let s = t.minZoom; s <= t.maxZoom; s++) {
        const m = Math.floor(t.maxX / Math.pow(2, t.maxZoom - s)), A = Math.floor(t.minX / Math.pow(2, t.maxZoom - s)), h = Math.floor(t.maxY / Math.pow(2, t.maxZoom - s)), f = Math.floor(t.minY / Math.pow(2, t.maxZoom - s));
        for (let I = A; I <= m; I++)
          for (let D = f; D <= h; D++)
            n.push([s, I, D]);
      }
      n.length != t.totalTile && console.log("Number of tiles is different");
      let e = n.splice(0, 5);
      for (; e.length; ) {
        if (!await self.clients.get(r.id)) {
          p = void 0;
          return;
        }
        if (p.cancel) {
          p = void 0, r.postMessage({
            type: "canceled",
            message: `Fetching tile of ${t.mapID} is canceled`,
            mapID: t.mapID
          });
          return;
        }
        const m = e.map((A) => {
          if (!(i.indexOf(`${A[0]}_${A[1]}_${A[2]}`) >= 0))
            return Z(t.mapID, A[0], A[1], A[2], !0);
        });
        await Promise.all(m), l += m.length, p.count = l, c = Math.floor(l * 100 / t.totalTile), r.postMessage({
          type: "proceed",
          message: `Proceeding the tile fetching: ${t.mapID} ${c}% (${l} / ${t.totalTile})`,
          percent: c,
          processed: l,
          error: p.error,
          total: t.totalTile,
          mapID: t.mapID
        }), e = n.splice(0, 5);
      }
      const a = p.error;
      p = void 0, r.postMessage({
        type: "finish",
        message: `Fetched all tiles of ${t.mapID}${a ? ` with ${a} error cases` : ""}`,
        total: t.totalTile,
        mapID: t.mapID,
        error: a
      });
    } catch (n) {
      p = void 0, r.postMessage({
        type: "stop",
        message: `Fetching stopped: ${t.mapID} ${l} / ${t.totalTile}`,
        reason: n,
        processed: l,
        total: t.totalTile,
        mapID: t.mapID
      });
    }
  }, L = async (r, t, l, c) => {
    let o;
    const i = (n, e) => e.reduce((a, s) => a || (n[s] === void 0 ? `Error: Attribute "${s}" is missing` : a), void 0);
    try {
      switch (r) {
        case "ping":
          o = "Implemented";
          break;
        case "info":
          if (o = i(t, ["mapID"]), !o) {
            const n = await d("Weiwudi", "mapSetting", "mapID"), e = await M(n, "mapSetting", t.mapID);
            e ? o = new Response(JSON.stringify(e), {
              headers: new Headers({
                "content-type": "application/json"
              })
            }) : o = `Error: MapID "${t.mapID}" not found`;
          }
          break;
        case "add": {
          const n = await d("Weiwudi", "mapSetting", "mapID");
          if (o = i(t, ["mapID", "type", "url"]), !o)
            switch (t.tileSize = parseInt(t.tileSize || 256), t.type) {
              case "xyz":
                if (o = i(t, ["width", "height"]), !o) {
                  t.width = parseInt(t.width), t.height = parseInt(t.height);
                  const e = (a) => Math.ceil(Math.log(a / t.tileSize) / Math.log(2));
                  t.maxZoom = Math.max(e(t.width), e(t.height)), t.minZoom = t.minZoom ? parseInt(t.minZoom) : 0, t.minX = 0, t.minY = 0, t.maxX = Math.ceil(t.width / t.tileSize) - 1, t.maxY = Math.ceil(t.height / t.tileSize) - 1;
                }
                break;
              case "wmts":
                if (!o) {
                  const e = (s) => 6378137 * s * Math.PI / 180, a = (s) => 6378137 * Math.log(Math.tan(Math.PI / 360 * (90 + s)));
                  if (t.maxZoom && (t.maxZoom = parseInt(t.maxZoom)), t.minZoom && (t.minZoom = parseInt(t.minZoom)), t.maxLng && t.minLng && t.maxLat && t.minLat) {
                    t.maxLng = parseFloat(t.maxLng), t.minLng = parseFloat(t.minLng), t.maxLat = parseFloat(t.maxLat), t.minLat = parseFloat(t.minLat);
                    const s = e(t.maxLng), m = e(t.minLng), A = a(t.maxLat), h = a(t.minLat);
                    t.minX = Math.floor((w + m) / (2 * w) * Math.pow(2, t.maxZoom)), t.maxX = Math.floor((w + s) / (2 * w) * Math.pow(2, t.maxZoom)), t.minY = Math.floor((w - A) / (2 * w) * Math.pow(2, t.maxZoom)), t.maxY = Math.floor((w - h) / (2 * w) * Math.pow(2, t.maxZoom));
                  }
                }
                break;
              default:
                o = 'Error: Unknown "type" value';
            }
          if (!o) {
            if (!i(t, ["maxX", "minX", "maxY", "minY", "minZoom", "maxZoom"])) {
              t.totalTile = 0;
              const e = (a, s) => Math.floor(a / Math.pow(2, t.maxZoom - s));
              for (let a = t.minZoom; a <= t.maxZoom; a++) {
                const s = e(t.minX, a), m = e(t.minY, a), A = e(t.maxX, a), h = e(t.maxY, a);
                t.totalTile += (A - s + 1) * (h - m + 1);
              }
            }
            await $(n, "mapSetting", t), await d(`Weiwudi_${t.mapID}`, "tileCache", "z_x_y"), o = new Response(JSON.stringify(t), {
              headers: new Headers({
                "content-type": "application/json"
              })
            });
          }
          break;
        }
        case "clean":
          if (o = i(t, ["mapID"]), p && p.mapID == t.mapID)
            o = `Error: ${t.mapID} is under fetching process. Please cancel it first`;
          else if (!o) {
            const n = await d(`Weiwudi_${t.mapID}`);
            await S(n, "tileCache"), o = `Cleaned: ${t.mapID}`;
          }
          break;
        case "delete":
          if (o = i(t, ["mapID"]), p && p.mapID == t.mapID)
            o = `Error: ${t.mapID} is under fetching process. Please cancel it first`;
          else if (!o) {
            await B(`Weiwudi_${t.mapID}`);
            const n = await d("Weiwudi");
            await Y(n, "mapSetting", t.mapID), o = `Deleted: ${t.mapID}`;
          }
          break;
        case "cancel":
          o = i(t, ["mapID"]), p && p.mapID == t.mapID ? (p.cancel = !0, o = `Fetching process of ${p.mapID} is canceled`) : o = `Error: There are no fetching process of ${t.mapID}`;
          break;
        case "stats":
          if (o = i(t, ["mapID"]), !o) {
            const n = await d("Weiwudi"), e = await M(n, "mapSetting", t.mapID);
            if (!e) o = `Error: MapID "${t.mapID}" not found`;
            else {
              const a = await d(`Weiwudi_${t.mapID}`), s = await X(a, "tileCache");
              e.totalTile && (s.total = e.totalTile, s.percent = Math.floor(s.count / s.total * 100)), o = new Response(JSON.stringify(s), {
                headers: new Headers({
                  "content-type": "application/json"
                })
              });
            }
          }
          break;
        case "cache": {
          const n = l.match(/^([^/]+)\/(\d+)\/(\d+)\/(\d+)$/);
          n ? o = await Z(n[1], parseInt(n[2]), parseInt(n[3]), parseInt(n[4])) : o = 'Error: "cache" api needs mapID, zoom, x, y settings';
          break;
        }
        case "fetchAll":
          if (o = i(t, ["mapID"]), !o) {
            const n = await d("Weiwudi"), e = await M(n, "mapSetting", t.mapID);
            e ? e.totalTile ? p ? o = `Error: Another fetching process is running: "${p.mapID}" (${p.count} / ${p.total})` : (setTimeout(() => {
              p = {
                mapID: t.mapID,
                total: e.totalTile,
                count: 0,
                error: 0
              }, _(c, e);
            }, 1), o = `Fetching task start: ${t.mapID}`) : o = `Error: Map "${t.mapID}" cannot fetch all tiles` : o = `Error: MapID "${t.mapID}" not found`;
          }
          break;
        default:
          o = `Error: API ${r} not found`;
      }
    } catch (n) {
      o = `Error: ${n}`;
    }
    if (o) return o;
  };
  E(/^https?:\/\/weiwudi.example.com/, P, "GET");
}
W(F);
//# sourceMappingURL=weiwudi-sw.es.js.map
