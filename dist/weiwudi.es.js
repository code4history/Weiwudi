const i = "https://weiwudi.example.com/api/";
let f, o;
(function() {
  if (typeof window.CustomEvent == "function") return !1;
  function h(e, s) {
    s = s || { bubbles: !1, cancelable: !1, detail: void 0 };
    var t = document.createEvent("CustomEvent");
    return t.initCustomEvent(e, s.bubbles, s.cancelable, s.detail), t;
  }
  h.prototype = window.Event.prototype, window.CustomEvent = h;
})();
class p {
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
    for (let r = 0, n = t.length; r < n; r++)
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
class a extends p {
  static async registerSW(e, s) {
    if ("serviceWorker" in navigator)
      try {
        const t = await navigator.serviceWorker.register(e, s), r = t.installing, n = t.waiting;
        return r && (r.state === "activated" && !n && window.location.reload(), r.addEventListener("statechange", (l) => {
          r.state === "activated" && !n && window.location.reload();
        })), t.onupdatefound = () => {
          t.update();
        }, await a.swCheck(), t;
      } catch (t) {
        throw `Error: Service worker registration failed with ${t}`;
      }
    else
      throw "Error: Service worker is not supported";
  }
  static async swCheck() {
    return o !== void 0 ? o : (f === void 0 && (f = new Promise((e, s) => {
      fetch(`${i}ping`).then((t) => {
        o = !!t, e(o);
      }).catch((t) => {
        o = !1, e(o);
      });
    })), f);
  }
  static async registerMap(e, s) {
    if (!await a.swCheck()) throw "Weiwudi service worker is not implemented.";
    let r;
    const n = ["type", "url", "width", "height", "tileSize", "minZoom", "maxZoom", "maxLng", "maxLat", "minLng", "minLat"].reduce((w, c) => (typeof s[c] < "u" && (s[c] instanceof Array ? s[c].map((d) => {
      w.append(c, d);
    }) : w.append(c, s[c])), w), new URLSearchParams());
    n.append("mapID", e);
    const l = new URL(`${i}add`);
    if (l.search = n, r = await (await fetch(l.href)).text(), r.match(/^Error: /))
      throw r;
    return new a(e, JSON.parse(r));
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
  constructor(e, s) {
    if (super(), !e) throw "MapID is necessary.";
    this.mapID = e, s && Object.assign(this, s), this.url = `${i}cache/${e}/{z}/{x}/{y}`, this.listener = (t) => {
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
    this.checkAspect(), await a.removeMap(this.mapID), this.release();
  }
  async cancel() {
    let e;
    if (this.checkAspect(), e = await (await fetch(`${i}cancel?mapID=${this.mapID}`)).text(), e.match(/^Error: /))
      throw e;
  }
}
export {
  a as default
};
//# sourceMappingURL=weiwudi.es.js.map
