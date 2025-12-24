const a = "https://weiwudi.example.com/api/";
let w, h;
class f {
  constructor() {
    this.listeners = {};
  }
  addEventListener(e, s) {
    e in this.listeners || (this.listeners[e] = []), this.listeners[e].push(s);
  }
  removeEventListener(e, s) {
    if (!(e in this.listeners))
      return;
    const t = this.listeners[e];
    for (let r = 0, c = t.length; r < c; r++)
      if (t[r] === s) {
        t.splice(r, 1);
        return;
      }
  }
  dispatchEvent(e) {
    if (!(e.type in this.listeners))
      return !0;
    const s = this.listeners[e.type].slice();
    for (let t = 0, r = s.length; t < r; t++)
      s[t].call(this, e);
    return !e.defaultPrevented;
  }
}
class i extends f {
  static async registerSW(e, s) {
    if ("serviceWorker" in navigator)
      try {
        const t = await navigator.serviceWorker.register(e, s), r = t.installing, c = t.waiting;
        return r && (r.state === "activated" && !c && window.location.reload(), r.addEventListener("statechange", (o) => {
          r.state === "activated" && !c && window.location.reload();
        })), t.onupdatefound = () => {
          t.update();
        }, await i.swCheck(), t;
      } catch (t) {
        throw `Error: Service worker registration failed with ${t}`;
      }
    else
      throw "Error: Service worker is not supported";
  }
  static async swCheck() {
    return h !== void 0 ? h : (w === void 0 && (w = new Promise((e, s) => {
      fetch(`${a}ping`).then((t) => {
        h = !!t, e(h);
      }).catch((t) => {
        h = !1, e(h);
      });
    })), w);
  }
  static async registerMap(e, s) {
    if (!await i.swCheck()) throw "Weiwudi service worker is not implemented.";
    let r;
    const c = ["type", "url", "width", "height", "tileSize", "minZoom", "maxZoom", "maxLng", "maxLat", "minLng", "minLat"].reduce((l, n) => (typeof s[n] < "u" && (s[n] instanceof Array ? s[n].map((p) => {
      l.append(n, p);
    }) : l.append(n, String(s[n]))), l), new URLSearchParams());
    c.append("mapID", e);
    const o = new URL(`${a}add`);
    if (o.search = c.toString(), r = await (await fetch(o.href)).text(), r.match(/^Error: /))
      throw r;
    return new i(e, JSON.parse(r));
  }
  static async retrieveMap(e) {
    if (!await i.swCheck()) throw "Weiwudi service worker is not implemented.";
    let t;
    if (t = await (await fetch(`${a}info?mapID=${e}`)).text(), t.match(/^Error: /))
      throw t;
    return console.log(t), new i(e, JSON.parse(t));
  }
  static async removeMap(e) {
    if (!await i.swCheck()) throw "Weiwudi service worker is not implemented.";
    let t;
    if (t = await (await fetch(`${a}delete?mapID=${e}`)).text(), t.match(/^Error: /))
      throw t;
  }
  constructor(e, s) {
    if (super(), !e) throw "MapID is necessary.";
    this.mapID = e, s && Object.assign(this, s), this.url = `${a}cache/${e}/{z}/{x}/{y}`, this.listener = (t) => {
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
    if (this.checkAspect(), e = await (await fetch(`${a}stats?mapID=${this.mapID}`)).text(), typeof e == "string" && e.match(/^Error: /))
      throw e;
    return JSON.parse(e);
  }
  async clean() {
    let e;
    if (this.checkAspect(), e = await (await fetch(`${a}clean?mapID=${this.mapID}`)).text(), e.match(/^Error: /))
      throw e;
  }
  async fetchAll() {
    let e;
    if (this.checkAspect(), e = await (await fetch(`${a}fetchAll?mapID=${this.mapID}`)).text(), e.match(/^Error: /))
      throw e;
  }
  async remove() {
    this.checkAspect(), this.mapID && await i.removeMap(this.mapID), this.release();
  }
  async cancel() {
    let e;
    if (this.checkAspect(), e = await (await fetch(`${a}cancel?mapID=${this.mapID}`)).text(), e.match(/^Error: /))
      throw e;
  }
}
export {
  f as WeiwudiEventTarget,
  i as default
};
//# sourceMappingURL=weiwudi.es.js.map
