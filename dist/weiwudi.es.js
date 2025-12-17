const i = "https://weiwudi.example.com/api/";
let f, c;
(function() {
  if (typeof window.CustomEvent == "function") return !1;
  function h(t, e) {
    e = e || { bubbles: !1, cancelable: !1, detail: void 0 };
    var r = document.createEvent("CustomEvent");
    return r.initCustomEvent(t, e.bubbles, e.cancelable, e.detail), r;
  }
  h.prototype = window.Event.prototype, window.CustomEvent = h;
})();
class p {
  constructor() {
    this.listeners = {};
  }
  addEventListener(t, e) {
    t in this.listeners || (this.listeners[t] = []), this.listeners[t].push(e);
  }
  removeEventListener(t, e) {
    if (!(t in this.listeners))
      return;
    const r = this.listeners[t];
    for (let s = 0, a = r.length; s < a; s++)
      if (r[s] === e) {
        r.splice(s, 1);
        return;
      }
  }
  dispatchEvent(t) {
    if (!(t.type in this.listeners))
      return !0;
    const e = this.listeners[t.type].slice();
    for (let r = 0, s = e.length; r < s; r++)
      e[r].call(this, t);
    return !t.defaultPrevented;
  }
}
class n extends p {
  static async registerSW(t, e) {
    if ("serviceWorker" in navigator)
      try {
        const r = await navigator.serviceWorker.register(t, e), s = r.installing, a = r.waiting;
        return s && (s.state === "activated" && !a && window.location.reload(), s.addEventListener("statechange", (l) => {
          s.state === "activated" && !a && window.location.reload();
        })), r.onupdatefound = () => {
          r.update();
        }, await n.swCheck(), r;
      } catch (r) {
        throw `Error: Service worker registration failed with ${r}`;
      }
    else
      throw "Error: Service worker is not supported";
  }
  static async swCheck() {
    return c !== void 0 ? c : (f === void 0 && (f = new Promise(async (t, e) => {
      try {
        c = await fetch(`${i}ping`), c = !!c;
      } catch {
        c = !1;
      }
      t(c);
    })), f);
  }
  static async registerMap(t, e) {
    if (!await n.swCheck()) throw "Weiwudi service worker is not implemented.";
    let s;
    try {
      const a = ["type", "url", "width", "height", "tileSize", "minZoom", "maxZoom", "maxLng", "maxLat", "minLng", "minLat"].reduce((w, o) => (typeof e[o] < "u" && (e[o] instanceof Array ? e[o].map((d) => {
        w.append(o, d);
      }) : w.append(o, e[o])), w), new URLSearchParams());
      a.append("mapID", t);
      const l = new URL(`${i}add`);
      l.search = a, s = await (await fetch(l.href)).text();
    } catch (a) {
      throw a;
    }
    if (s.match(/^Error: /))
      throw s;
    return new n(t, JSON.parse(s));
  }
  static async retrieveMap(t) {
    if (!await n.swCheck()) throw "Weiwudi service worker is not implemented.";
    let r;
    try {
      r = await (await fetch(`${i}info?mapID=${t}`)).text();
    } catch (s) {
      throw s;
    }
    if (r.match(/^Error: /))
      throw r;
    return console.log(r), new n(t, JSON.parse(r));
  }
  static async removeMap(t) {
    if (!await n.swCheck()) throw "Weiwudi service worker is not implemented.";
    let r;
    try {
      r = await (await fetch(`${i}delete?mapID=${t}`)).text();
    } catch (s) {
      throw s;
    }
    if (r.match(/^Error: /))
      throw r;
  }
  constructor(t, e) {
    if (super(), !t) throw "MapID is necessary.";
    this.mapID = t, e && Object.assign(this, e), this.url = `${i}cache/${t}/{z}/{x}/{y}`, this.listener = (r) => {
      r.data.mapID === t && this.dispatchEvent(new CustomEvent(r.data.type, { detail: r.data }));
    }, navigator.serviceWorker.addEventListener("message", this.listener);
  }
  release() {
    navigator.serviceWorker.removeEventListener("message", this.listener), delete this.mapID;
  }
  checkAspect() {
    if (!this.mapID) throw "This instance is already released.";
  }
  async stats() {
    let t;
    this.checkAspect();
    try {
      t = await (await fetch(`${i}stats?mapID=${this.mapID}`)).text();
    } catch (e) {
      throw e;
    }
    if (typeof t == "string" && t.match(/^Error: /))
      throw t;
    return JSON.parse(t);
  }
  async clean() {
    let t;
    this.checkAspect();
    try {
      t = await (await fetch(`${i}clean?mapID=${this.mapID}`)).text();
    } catch (e) {
      throw e;
    }
    if (t.match(/^Error: /))
      throw t;
  }
  async fetchAll() {
    let t;
    this.checkAspect();
    try {
      t = await (await fetch(`${i}fetchAll?mapID=${this.mapID}`)).text();
    } catch (e) {
      throw e;
    }
    if (t.match(/^Error: /))
      throw t;
  }
  async remove() {
    this.checkAspect(), await n.removeMap(this.mapID), this.release();
  }
  async cancel() {
    let t;
    this.checkAspect();
    try {
      t = await (await fetch(`${i}cancel?mapID=${this.mapID}`)).text();
    } catch (e) {
      throw e;
    }
    if (t.match(/^Error: /))
      throw t;
  }
}
export {
  n as default
};
//# sourceMappingURL=weiwudi.es.js.map
