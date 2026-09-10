const i = "https://weiwudi.example.com/api/";
let w, o;
class m {
  constructor() {
    this.listeners = {};
  }
  addEventListener(e, r) {
    e in this.listeners || (this.listeners[e] = []), this.listeners[e].push(r);
  }
  removeEventListener(e, r) {
    if (!(e in this.listeners))
      return;
    const t = this.listeners[e];
    for (let s = 0, c = t.length; s < c; s++)
      if (t[s] === r) {
        t.splice(s, 1);
        return;
      }
  }
  dispatchEvent(e) {
    if (!(e.type in this.listeners))
      return !0;
    const r = this.listeners[e.type].slice();
    for (let t = 0, s = r.length; t < s; t++)
      r[t].call(this, e);
    return !e.defaultPrevented;
  }
}
class a extends m {
  static async registerSW(e, r) {
    if (!("serviceWorker" in navigator))
      throw "Error: Service worker is not supported";
    let t;
    try {
      t = await navigator.serviceWorker.register(e, r);
    } catch (s) {
      throw `Error: Service worker registration failed with ${s}`;
    }
    return await a.waitForController(), await a.swCheck(), t;
  }
  static async waitForController() {
    return new Promise((e, r) => {
      let t = !1, s;
      function c() {
        t || (t = !0, s !== void 0 && clearTimeout(s), navigator.serviceWorker.removeEventListener("controllerchange", h));
      }
      function h() {
        navigator.serviceWorker.controller && (c(), e());
      }
      navigator.serviceWorker.addEventListener("controllerchange", h), s = setTimeout(() => {
        c(), r("Error: Service worker did not control this page within 10000 ms");
      }, 1e4), navigator.serviceWorker.ready.then(() => {
        navigator.serviceWorker.controller && (c(), e());
      }).catch(() => {
      });
    });
  }
  static async swCheck() {
    return o !== void 0 ? o : (w === void 0 && (w = new Promise((e, r) => {
      fetch(`${i}ping`).then((t) => {
        o = !!t, e(o);
      }).catch((t) => {
        o = !1, e(o);
      });
    })), w);
  }
  static async registerMap(e, r) {
    if (!await a.swCheck()) throw "Weiwudi service worker is not implemented.";
    let s;
    const c = ["type", "url", "width", "height", "tileSize", "minZoom", "maxZoom", "maxLng", "maxLat", "minLng", "minLat", "cacheTtl", "cacheMaxBytes"].reduce((l, n) => (typeof r[n] < "u" && (r[n] instanceof Array ? r[n].map((f) => {
      l.append(n, f);
    }) : l.append(n, String(r[n]))), l), new URLSearchParams());
    c.append("mapID", e);
    const h = new URL(`${i}add`);
    if (h.search = c.toString(), s = await (await fetch(h.href)).text(), s.match(/^Error: /))
      throw s;
    return new a(e, JSON.parse(s));
  }
  static async retrieveMap(e) {
    if (!await a.swCheck()) throw "Weiwudi service worker is not implemented.";
    let t;
    if (t = await (await fetch(`${i}info?mapID=${e}`)).text(), t.match(/^Error: /))
      throw t;
    return console.log(t), new a(e, JSON.parse(t));
  }
  static async removeMap(e) {
    if (!await a.swCheck()) throw "Weiwudi service worker is not implemented.";
    let t;
    if (t = await (await fetch(`${i}delete?mapID=${e}`)).text(), t.match(/^Error: /))
      throw t;
  }
  constructor(e, r) {
    if (super(), !e) throw "MapID is necessary.";
    this.mapID = e, r && Object.assign(this, r), this.url = `${i}cache/${e}/{z}/{x}/{y}`, this.listener = (t) => {
      t.data.mapID === e && this.dispatchEvent(new CustomEvent(t.data.type, { detail: t.data }));
    }, navigator.serviceWorker.addEventListener("message", this.listener);
  }
  release() {
    navigator.serviceWorker.removeEventListener("message", this.listener), delete this.mapID;
  }
  checkAspect() {
    if (!this.mapID) throw "This instance is already released.";
  }
  async stats() {
    let e;
    if (this.checkAspect(), e = await (await fetch(`${i}stats?mapID=${this.mapID}`)).text(), typeof e == "string" && e.match(/^Error: /))
      throw e;
    return JSON.parse(e);
  }
  async clean() {
    let e;
    if (this.checkAspect(), e = await (await fetch(`${i}clean?mapID=${this.mapID}`)).text(), e.match(/^Error: /))
      throw e;
  }
  async fetchAll() {
    let e;
    if (this.checkAspect(), e = await (await fetch(`${i}fetchAll?mapID=${this.mapID}`)).text(), e.match(/^Error: /))
      throw e;
  }
  async remove() {
    this.checkAspect(), this.mapID && await a.removeMap(this.mapID), this.release();
  }
  async cancel() {
    let e;
    if (this.checkAspect(), e = await (await fetch(`${i}cancel?mapID=${this.mapID}`)).text(), e.match(/^Error: /))
      throw e;
  }
}
export {
  m as WeiwudiEventTarget,
  a as default
};
//# sourceMappingURL=weiwudi.es.js.map
