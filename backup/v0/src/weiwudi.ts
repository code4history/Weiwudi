import type { 
  WeiwudiOptions, 
  WeiwudiMapAttributes, 
  WeiwudiStats, 
  WeiwudiEvent,
  TileRange,
  VectorTileOptions 
} from "./types/index.ts";

const BASEURL = 'https://weiwudi.example.com/api/';
let swChecking: Promise<boolean> | undefined;
let swChecked: boolean | undefined;

// Polyfill for CustomEvent if needed
(function () {
  if (typeof window.CustomEvent === 'function') return false;

  function CustomEvent(event: string, params?: CustomEventInit) {
    params = params || { bubbles: false, cancelable: false, detail: undefined };
    const evt = document.createEvent('CustomEvent');
    evt.initCustomEvent(event, params.bubbles!, params.cancelable!, params.detail);
    return evt;
  }

  CustomEvent.prototype = window.Event.prototype;

  (window as any).CustomEvent = CustomEvent;
})();

class EventTarget {
  private listeners: { [key: string]: Array<(event: Event) => void> } = {};

  addEventListener(type: string, callback: (event: Event) => void): void {
    if (!(type in this.listeners)) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(callback);
  }

  removeEventListener(type: string, callback: (event: Event) => void): void {
    if (!(type in this.listeners)) {
      return;
    }
    const stack = this.listeners[type];
    for (let i = 0, l = stack.length; i < l; i++) {
      if (stack[i] === callback) {
        stack.splice(i, 1);
        return;
      }
    }
  }

  dispatchEvent(event: Event): boolean {
    if (!(event.type in this.listeners)) {
      return true;
    }
    const stack = this.listeners[event.type].slice();

    for (let i = 0, l = stack.length; i < l; i++) {
      stack[i].call(this, event);
    }
    return !event.defaultPrevented;
  }
}

export default class Weiwudi extends EventTarget {
  mapID: string;
  url: string;
  private listener: (e: MessageEvent) => void;
  type?: 'xyz' | 'wmts';
  width?: number;
  height?: number;
  tileSize?: number;
  minZoom?: number;
  maxZoom?: number;
  maxLng?: number;
  maxLat?: number;
  minLng?: number;
  minLat?: number;
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;

  static async registerSW(sw: string, swOptions?: RegistrationOptions): Promise<ServiceWorkerRegistration> {
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.register(sw, swOptions);

        // Handle service worker activation without reloading
        if (reg.active) {
          // Service worker is already active
          await Weiwudi.swCheck();
          return reg;
        }

        // Wait for the service worker to activate
        await new Promise<void>((resolve) => {
          const checkState = () => {
            if (reg.active) {
              resolve();
              return;
            }
            if (reg.installing) {
              reg.installing.addEventListener('statechange', function handler() {
                if (reg.active) {
                  reg.installing?.removeEventListener('statechange', handler);
                  resolve();
                }
              });
            } else if (reg.waiting) {
              reg.waiting.addEventListener('statechange', function handler() {
                if (reg.active) {
                  reg.waiting?.removeEventListener('statechange', handler);
                  resolve();
                }
              });
            }
          };
          checkState();
        });

        reg.onupdatefound = () => {
          reg.update();
        };

        await Weiwudi.swCheck();
        return reg;
      } catch (e) {
        throw new Error(`Service worker registration failed with ${e}`);
      }
    } else {
      throw new Error('Service worker is not supported');
    }
  }

  static async swCheck(): Promise<boolean> {
    if (swChecked !== undefined) return swChecked;
    if (swChecking === undefined) {
      swChecking = new Promise<boolean>(async (res) => {
        try {
          const response = await fetch(`${BASEURL}ping`);
          swChecked = !!response && response.ok;
        } catch (e) {
          swChecked = false;
        }
        res(swChecked);
      });
    }
    return swChecking;
  }

  static async registerMap(mapID: string, options: WeiwudiOptions): Promise<Weiwudi> {
    const swCheck = await Weiwudi.swCheck();
    if (!swCheck) throw new Error('Weiwudi service worker is not implemented.');
    let text: string;
    try {
      const p = ['type', 'url', 'width', 'height', 'tileSize', 'minZoom', 'maxZoom', 'maxLng', 'maxLat', 'minLng', 'minLat'].reduce((p, key) => {
        const value = options[key as keyof WeiwudiOptions];
        if (typeof value !== 'undefined') {
          if (value instanceof Array) {
            value.forEach((val) => {
              p.append(key, String(val));
            });
          } else {
            p.append(key, String(value));
          }
        }
        return p;
      }, new URLSearchParams());
      p.append('mapID', mapID);
      const url = new URL(`${BASEURL}add`);
      url.search = p.toString();
      const res = await fetch(url.href);
      text = await res.text();
    } catch (e) {
      throw e;
    }
    if (text.match(/^Error: /)) {
      throw new Error(text);
    }
    return new Weiwudi(mapID, JSON.parse(text));
  }

  static async retrieveMap(mapID: string): Promise<Weiwudi> {
    const swCheck = await Weiwudi.swCheck();
    if (!swCheck) throw new Error('Weiwudi service worker is not implemented.');
    let text: string;
    try {
      const res = await fetch(`${BASEURL}info?mapID=${mapID}`);
      text = await res.text();
    } catch (e) {
      throw e;
    }
    if (text.match(/^Error: /)) {
      throw new Error(text);
    }
    return new Weiwudi(mapID, JSON.parse(text));
  }

  static async removeMap(mapID: string): Promise<void> {
    const swCheck = await Weiwudi.swCheck();
    if (!swCheck) throw new Error('Weiwudi service worker is not implemented.');
    let text: string;
    try {
      const res = await fetch(`${BASEURL}delete?mapID=${mapID}`);
      text = await res.text();
    } catch (e) {
      throw e;
    }
    if (text.match(/^Error: /)) {
      throw new Error(text);
    }
  }

  constructor(mapID: string, attrs?: WeiwudiMapAttributes) {
    super();
    if (!mapID) throw new Error('MapID is necessary.');
    this.mapID = mapID;
    if (attrs) Object.assign(this, attrs);
    this.url = `${BASEURL}cache/${mapID}/{z}/{x}/{y}`;
    this.listener = (e: MessageEvent) => {
      const eventMapID = e.data.mapID;
      if (eventMapID !== mapID) return;
      this.dispatchEvent(new CustomEvent(e.data.type, { detail: e.data }) as WeiwudiEvent);
    };
    navigator.serviceWorker.addEventListener('message', this.listener);
  }

  release(): void {
    navigator.serviceWorker.removeEventListener('message', this.listener);
    delete (this as any).mapID;
  }

  private checkAspect(): void {
    if (!this.mapID) throw new Error('This instance is already released.');
  }

  async stats(): Promise<WeiwudiStats> {
    let text: string;
    this.checkAspect();
    try {
      const res = await fetch(`${BASEURL}stats?mapID=${this.mapID}`);
      text = await res.text();
    } catch (e) {
      throw e;
    }
    if (typeof text === 'string' && text.match(/^Error: /)) {
      throw new Error(text);
    }
    return JSON.parse(text);
  }

  async clean(range?: TileRange): Promise<void> {
    let text: string;
    this.checkAspect();
    try {
      let url = `${BASEURL}clean?mapID=${this.mapID}`;
      if (range) {
        const params = new URLSearchParams({
          minZoom: String(range.minZoom),
          maxZoom: String(range.maxZoom),
          minLng: String(range.minLng),
          maxLng: String(range.maxLng),
          minLat: String(range.minLat),
          maxLat: String(range.maxLat)
        });
        url += `&${params.toString()}`;
      }
      const res = await fetch(url);
      text = await res.text();
    } catch (e) {
      throw e;
    }
    if (text.match(/^Error: /)) {
      throw new Error(text);
    }
  }

  async fetchAll(range?: TileRange): Promise<void> {
    let text: string;
    this.checkAspect();
    try {
      let url = `${BASEURL}fetchAll?mapID=${this.mapID}`;
      if (range) {
        const params = new URLSearchParams({
          minZoom: String(range.minZoom),
          maxZoom: String(range.maxZoom),
          minLng: String(range.minLng),
          maxLng: String(range.maxLng),
          minLat: String(range.minLat),
          maxLat: String(range.maxLat)
        });
        url += `&${params.toString()}`;
      }
      const res = await fetch(url);
      text = await res.text();
    } catch (e) {
      throw e;
    }
    if (text.match(/^Error: /)) {
      throw new Error(text);
    }
  }

  async remove(): Promise<void> {
    this.checkAspect();
    await Weiwudi.removeMap(this.mapID);
    this.release();
  }

  async cancel(): Promise<void> {
    let text: string;
    this.checkAspect();
    try {
      const res = await fetch(`${BASEURL}cancel?mapID=${this.mapID}`);
      text = await res.text();
    } catch (e) {
      throw e;
    }
    if (text.match(/^Error: /)) {
      throw new Error(text);
    }
  }

  // New methods for vector tile support
  async registerVectorTileAssets(options: VectorTileOptions): Promise<void> {
    const swCheck = await Weiwudi.swCheck();
    if (!swCheck) throw new Error('Weiwudi service worker is not implemented.');
    
    this.checkAspect();
    
    let text: string;
    try {
      const params = new URLSearchParams({ mapID: this.mapID });
      Object.entries(options).forEach(([key, value]) => {
        if (value) params.append(key, value);
      });
      
      const res = await fetch(`${BASEURL}registerAssets?${params.toString()}`);
      text = await res.text();
    } catch (e) {
      throw e;
    }
    if (text.match(/^Error: /)) {
      throw new Error(text);
    }
  }

  // Get URLs for vector tile assets
  getDefinitionUrl(): string {
    return `${BASEURL}cache/${this.mapID}/definition`;
  }

  getStylesUrl(): string {
    return `${BASEURL}cache/${this.mapID}/styles`;
  }

  getFontsUrl(): string {
    return `${BASEURL}cache/${this.mapID}/fonts`;
  }

  getIconsUrl(): string {
    return `${BASEURL}cache/${this.mapID}/icons`;
  }
}