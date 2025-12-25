import { registerRoute as k } from "workbox-routing";
function v(_) {
  const g = 20037508342789244e-9, x = {};
  let m;
  const S = (l, t, r, i) => l.replace("{z}", String(t)).replace("{x}", String(r)).replace("{y}", String(i)).replace("{-y}", String(Math.pow(2, t) - i - 1)), T = (l, t = "", r = 512) => {
    const i = atob(l), o = [];
    for (let a = 0; a < i.length; a += r) {
      const e = i.slice(a, a + r), n = new Array(e.length);
      for (let A = 0; A < e.length; A++)
        n[A] = e.charCodeAt(A);
      const s = new Uint8Array(n);
      o.push(s);
    }
    return new Blob(o, { type: t });
  }, w = async (l, t, r) => new Promise((i, o) => {
    try {
      if (x[l]) i(x[l]);
      else {
        const c = indexedDB.open(l);
        c.onupgradeneeded = function(a) {
          const e = a.target.result;
          t && r && e.createObjectStore(t, { keyPath: r });
        }, c.onsuccess = function(a) {
          const e = a.target.result;
          x[l] = e, i(e);
        }, c.onerror = function(a) {
          o(c.error);
        };
      }
    } catch (c) {
      o(c);
    }
  }), R = async (l) => (x[l] && (x[l].close(), delete x[l]), new Promise((t, r) => {
    try {
      const i = indexedDB.deleteDatabase(l);
      i.onsuccess = async (o) => {
        t();
      }, i.onerror = function(o) {
        r(o);
      };
    } catch (i) {
      r(i);
    }
  })), B = async (l, t) => new Promise((r, i) => {
    const o = l.transaction([t], "readwrite"), a = o.objectStore(t).clear();
    a.onsuccess = function(e) {
    }, a.onerror = function(e) {
      i(e);
    }, o.oncomplete = function(e) {
      r();
    }, o.onabort = function(e) {
      i(e);
    }, o.onerror = function(e) {
      i(e);
    };
  }), X = async (l, t) => new Promise((r, i) => {
    const o = l.transaction([t], "readonly"), a = o.objectStore(t).openCursor();
    let e = 0, n = 0;
    a.onsuccess = function(s) {
      const A = a.result;
      A && (e++, n = n + A.value.blob.size, A.continue());
    }, a.onerror = function(s) {
      i(s);
    }, o.oncomplete = function(s) {
      r({
        count: e,
        size: n
      });
    }, o.onabort = function(s) {
      i(s);
    }, o.onerror = function(s) {
      i(s);
    };
  }), M = async (l, t, r, i) => new Promise((o, c) => {
    const a = l.transaction([t], "readonly"), e = a.objectStore(t), n = i ? e.getKey(r) : e.get(r);
    n.onsuccess = function(s) {
    }, n.onerror = function(s) {
      c(s);
    }, a.oncomplete = function(s) {
      o(n.result);
    }, a.onabort = function(s) {
      c(s);
    }, a.onerror = function(s) {
      c(s);
    };
  }), Z = async (l, t, r) => new Promise((i, o) => {
    const c = l.transaction([t], "readwrite"), e = c.objectStore(t).put(r);
    e.onsuccess = function(n) {
    }, e.onerror = function(n) {
      o(n);
    }, c.oncomplete = function(n) {
      i();
    }, c.onabort = function(n) {
      o(n);
    }, c.onerror = function(n) {
      o(n);
    };
  }), Y = async (l, t, r) => new Promise((i, o) => {
    const c = l.transaction([t], "readwrite"), e = c.objectStore(t).delete(r);
    e.onsuccess = function(n) {
    }, e.onerror = function(n) {
      o(n);
    }, c.oncomplete = function(n) {
      i();
    }, c.onabort = function(n) {
      o(n);
    }, c.onerror = function(n) {
      o(n);
    };
  }), C = async (l, t) => new Promise((r, i) => {
    const o = l.transaction([t], "readwrite"), a = o.objectStore(t).getAllKeys();
    a.onsuccess = function(e) {
    }, a.onerror = function(e) {
      i(e);
    }, o.oncomplete = function(e) {
      r(a.result);
    }, o.onabort = function(e) {
      i(e);
    }, o.onerror = function(e) {
      i(e);
    };
  }), F = async ({ url: l, event: t }) => {
    const r = t instanceof FetchEvent ? t : void 0, i = r && r.clientId ? await self.clients.get(r.clientId) : void 0, o = l.pathname.match(/^\/api\/([\w\d]+)(?:\/(.+))?$/);
    if (o) {
      const c = [...l.searchParams.entries()].reduce((s, A) => {
        const h = l.searchParams.getAll(A[0]);
        return h.length === 1 ? s[A[0]] = h[0] : s[A[0]] = h, s;
      }, {}), a = o[1], e = o[2];
      let n = await L(a, c, e, i);
      if (n)
        return n instanceof Response || (n = new Response(n)), n;
    }
    return new Response("Not Found", { status: 404 });
  }, E = async (l, t, r, i, o) => {
    let c;
    const a = await w("Weiwudi"), e = await M(a, "mapSetting", l);
    if (console.log(`MapID: ${l}, z: ${t}, x: ${r}, y: ${i}`), console.log(`Setting: ${JSON.stringify(e)}`), console.log(`Before: ${c}`), !o) {
      if (!e) return `Error: MapID "${l}" not found`;
      if (t < (e.minZoom || 0) || t > (e.maxZoom || 0)) c = "zoom";
      else if (e.minX !== void 0 && e.maxX !== void 0 && e.minY !== void 0 && e.maxY !== void 0) {
        const f = Math.pow(2, (e.maxZoom || 0) - t), p = Math.floor((e.minX || 0) / f), b = Math.floor((e.maxX || 0) / f), I = Math.floor((e.minY || 0) / f), $ = Math.floor((e.maxY || 0) / f);
        (r < p || r > b || i < I || i > $) && (c = "extent");
      }
    }
    console.log(`After: ${c}`);
    let n = {}, s, A = 200, h = "OK";
    if (c)
      c === "zoom" ? (A = 404, h = "Not Found") : (n = {
        "content-type": "image/png"
      }, s = T("iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAMAAABrrFhUAAAAB3RJTUUH3QgIBToaSbAjlwAAABd0RVh0U29mdHdhcmUAR0xEUE5HIHZlciAzLjRxhaThAAAACHRwTkdHTEQzAAAAAEqAKR8AAAAEZ0FNQQAAsY8L/GEFAAAAA1BMVEX///+nxBvIAAAAAXRSTlMAQObYZgAAAFRJREFUeNrtwQEBAAAAgJD+r+4ICgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgBDwABHHIJwwAAAABJRU5ErkJggg==", n["content-type"]));
    else {
      const f = await w(`Weiwudi_${l}`), p = await M(f, "tileCache", `${t}_${r}_${i}`, o), b = (/* @__PURE__ */ new Date()).getTime();
      if (!p || !p.epoch || b - p.epoch > 864e5) {
        let I = "";
        e.url instanceof Array ? I = e.url[Math.floor(Math.random() * e.url.length)] : typeof e.url == "string" && (I = e.url);
        const $ = S(I, t, r, i);
        try {
          const d = await fetch($);
          d.ok ? (n = {}, d.headers.forEach((D, u) => {
            n[u] = D;
          }), s = await d.blob(), await Z(f, "tileCache", {
            z_x_y: `${t}_${r}_${i}`,
            headers: n,
            blob: s,
            epoch: b
          })) : (p ? (n = p.headers, s = p.blob) : (A = d.status, h = d.statusText, n = {}, d.headers.forEach((D, u) => {
            n[u] = D;
          }), s = await d.blob()), m && m.error++);
        } catch {
          p ? (n = p.headers, s = p.blob) : (A = 404, h = "Not Found"), m && m.error++;
        }
      } else o || (n = p.headers, s = p.blob);
    }
    return o ? void 0 : new Response(s, {
      status: A,
      statusText: h,
      headers: new Headers(n)
    });
  }, P = async (l, t) => {
    let r = 0, i = 0;
    const o = await w(`Weiwudi_${t.mapID}`), c = await C(o, "tileCache");
    try {
      const a = [], e = t.minZoom || 0, n = t.maxZoom || 0;
      for (let h = e; h <= n; h++) {
        const f = Math.pow(2, n - h), p = Math.floor((t.maxX || 0) / f), b = Math.floor((t.minX || 0) / f), I = Math.floor((t.maxY || 0) / f), $ = Math.floor((t.minY || 0) / f);
        for (let d = b; d <= p; d++)
          for (let D = $; D <= I; D++)
            a.push([h, d, D]);
      }
      a.length != t.totalTile && console.log("Number of tiles is different");
      let s = a.splice(0, 5);
      for (; s.length; ) {
        if (!await self.clients.get(l.id)) {
          m = void 0;
          return;
        }
        if (m && m.cancel) {
          m = void 0, l.postMessage({
            type: "canceled",
            message: `Fetching tile of ${t.mapID} is canceled`,
            mapID: t.mapID
          });
          return;
        }
        const f = s.map((p) => {
          if (!(c.indexOf(`${p[0]}_${p[1]}_${p[2]}`) >= 0))
            return E(t.mapID, p[0], p[1], p[2], !0);
        });
        await Promise.all(f), r += f.length, m && (m.count = r), i = Math.floor(r * 100 / (t.totalTile || 1)), l.postMessage({
          type: "proceed",
          message: `Proceeding the tile fetching: ${t.mapID} ${i}% (${r} / ${t.totalTile})`,
          percent: i,
          processed: r,
          error: m ? m.error : 0,
          total: t.totalTile,
          mapID: t.mapID
        }), s = a.splice(0, 5);
      }
      const A = m ? m.error : 0;
      m = void 0, l.postMessage({
        type: "finish",
        message: `Fetched all tiles of ${t.mapID}${A ? ` with ${A} error cases` : ""}`,
        total: t.totalTile,
        mapID: t.mapID,
        error: A
      });
    } catch (a) {
      m = void 0, l.postMessage({
        type: "stop",
        message: `Fetching stopped: ${t.mapID} ${r} / ${t.totalTile}`,
        reason: a,
        processed: r,
        total: t.totalTile,
        mapID: t.mapID
      });
    }
  }, L = async (l, t, r, i) => {
    let o;
    const c = (a, e) => e.reduce((n, s) => n || (a[s] === void 0 ? `Error: Attribute "${s}" is missing` : n), void 0);
    try {
      switch (l) {
        case "ping":
          o = "Implemented";
          break;
        case "info":
          if (o = c(t, ["mapID"]), !o) {
            const a = await w("Weiwudi", "mapSetting", "mapID"), e = await M(a, "mapSetting", t.mapID);
            e ? o = new Response(JSON.stringify(e), {
              headers: new Headers({
                "content-type": "application/json"
              })
            }) : o = `Error: MapID "${t.mapID}" not found`;
          }
          break;
        case "add": {
          const a = await w("Weiwudi", "mapSetting", "mapID");
          if (o = c(t, ["mapID", "type", "url"]), !o)
            switch (t.tileSize = parseInt(t.tileSize || 256), t.type) {
              case "xyz":
                if (o = c(t, ["width", "height"]), !o) {
                  t.width = parseInt(t.width), t.height = parseInt(t.height);
                  const e = (n) => Math.ceil(Math.log(n / t.tileSize) / Math.log(2));
                  t.maxZoom = Math.max(e(t.width), e(t.height)), t.minZoom = t.minZoom ? parseInt(t.minZoom) : 0, t.minX = 0, t.minY = 0, t.maxX = Math.ceil(t.width / t.tileSize) - 1, t.maxY = Math.ceil(t.height / t.tileSize) - 1;
                }
                break;
              case "wmts":
                if (!o) {
                  const e = (s) => 6378137 * s * Math.PI / 180, n = (s) => 6378137 * Math.log(Math.tan(Math.PI / 360 * (90 + s)));
                  if (t.maxZoom && (t.maxZoom = parseInt(t.maxZoom)), t.minZoom && (t.minZoom = parseInt(t.minZoom)), t.maxLng && t.minLng && t.maxLat && t.minLat) {
                    t.maxLng = parseFloat(t.maxLng), t.minLng = parseFloat(t.minLng), t.maxLat = parseFloat(t.maxLat), t.minLat = parseFloat(t.minLat);
                    const s = e(t.maxLng), A = e(t.minLng), h = n(t.maxLat), f = n(t.minLat);
                    t.minX = Math.floor((g + A) / (2 * g) * Math.pow(2, t.maxZoom)), t.maxX = Math.floor((g + s) / (2 * g) * Math.pow(2, t.maxZoom)), t.minY = Math.floor((g - h) / (2 * g) * Math.pow(2, t.maxZoom)), t.maxY = Math.floor((g - f) / (2 * g) * Math.pow(2, t.maxZoom));
                  }
                }
                break;
              default:
                o = 'Error: Unknown "type" value';
            }
          if (!o) {
            if (!c(t, ["maxX", "minX", "maxY", "minY", "minZoom", "maxZoom"])) {
              t.totalTile = 0;
              const e = (n, s) => Math.floor(n / Math.pow(2, t.maxZoom - s));
              for (let n = t.minZoom; n <= t.maxZoom; n++) {
                const s = e(t.minX, n), A = e(t.minY, n), h = e(t.maxX, n), f = e(t.maxY, n);
                t.totalTile += (h - s + 1) * (f - A + 1);
              }
            }
            await Z(a, "mapSetting", t), await w(`Weiwudi_${t.mapID}`, "tileCache", "z_x_y"), o = new Response(JSON.stringify(t), {
              headers: new Headers({
                "content-type": "application/json"
              })
            });
          }
          break;
        }
        case "clean":
          if (o = c(t, ["mapID"]), m && m.mapID == t.mapID)
            o = `Error: ${t.mapID} is under fetching process. Please cancel it first`;
          else if (!o) {
            const a = await w(`Weiwudi_${t.mapID}`);
            await B(a, "tileCache"), o = `Cleaned: ${t.mapID}`;
          }
          break;
        case "delete":
          if (o = c(t, ["mapID"]), m && m.mapID == t.mapID)
            o = `Error: ${t.mapID} is under fetching process. Please cancel it first`;
          else if (!o) {
            await R(`Weiwudi_${t.mapID}`);
            const a = await w("Weiwudi");
            await Y(a, "mapSetting", t.mapID), o = `Deleted: ${t.mapID}`;
          }
          break;
        case "cancel":
          o = c(t, ["mapID"]), m && m.mapID == t.mapID ? (m.cancel = !0, o = `Fetching process of ${m.mapID} is canceled`) : o = `Error: There are no fetching process of ${t.mapID}`;
          break;
        case "stats":
          if (o = c(t, ["mapID"]), !o) {
            const a = await w("Weiwudi"), e = await M(a, "mapSetting", t.mapID);
            if (!e) o = `Error: MapID "${t.mapID}" not found`;
            else {
              const n = await w(`Weiwudi_${t.mapID}`), s = await X(n, "tileCache");
              e.totalTile && (s.total = e.totalTile, s.percent = Math.floor(s.count / s.total * 100)), o = new Response(JSON.stringify(s), {
                headers: new Headers({
                  "content-type": "application/json"
                })
              });
            }
          }
          break;
        case "cache": {
          const a = r?.match(/^([^/]+)\/(\d+)\/(\d+)\/(\d+)$/);
          a ? o = await E(a[1], parseInt(a[2]), parseInt(a[3]), parseInt(a[4])) : o = 'Error: "cache" api needs mapID, zoom, x, y settings';
          break;
        }
        case "fetchAll":
          if (o = c(t, ["mapID"]), !o && i) {
            const a = await w("Weiwudi"), e = await M(a, "mapSetting", t.mapID);
            e ? e.totalTile ? m ? o = `Error: Another fetching process is running: "${m.mapID}" (${m.count} / ${m.total})` : (setTimeout(() => {
              m = {
                mapID: t.mapID,
                total: e.totalTile || 0,
                count: 0,
                error: 0
              }, P(i, e);
            }, 1), o = `Fetching task start: ${t.mapID}`) : o = `Error: Map "${t.mapID}" cannot fetch all tiles` : o = `Error: MapID "${t.mapID}" not found`;
          }
          break;
        default:
          o = `Error: API ${l} not found`;
      }
    } catch (a) {
      o = `Error: ${a}`;
    }
    if (o) return o;
  };
  _(/^https?:\/\/weiwudi.example.com/, F, "GET");
}
v(k);
//# sourceMappingURL=weiwudi-sw.es.js.map
