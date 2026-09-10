"use strict";

const BASEURL = 'https://weiwudi.example.com/api/';
let swChecking: Promise<boolean> | undefined;
let swChecked: boolean | undefined;

// Polyfill removed as target is ES2020

export class WeiwudiEventTarget {
    listeners: Record<string, ((...args: unknown[]) => void)[]>;

    constructor() {
        this.listeners = {};
    }

    addEventListener(type: string, callback: (...args: unknown[]) => void) {
        if (!(type in this.listeners)) {
            this.listeners[type] = [];
        }
        this.listeners[type].push(callback);
    }

    removeEventListener(type: string, callback: (...args: unknown[]) => void) {
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

    dispatchEvent(event: Event | CustomEvent) {
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

export interface WeiwudiOptions {
    type?: string;
    url?: string;
    width?: number;
    height?: number;
    tileSize?: number;
    minZoom?: number;
    maxZoom?: number;
    maxLng?: number;
    maxLat?: number;
    minLng?: number;
    minLat?: number;
    // タイルキャッシュの有効期間(ms)。未指定は24時間 (#2)
    cacheTtl?: number;
    // キャッシュ容量の上限(byte)。未指定は上限なし (#29)
    cacheMaxBytes?: number;
    [key: string]: unknown;
}

export interface WeiwudiInternalOps {
    // Placeholder for future strict typing of internal operations
    [key: string]: unknown;
}

export default class Weiwudi extends WeiwudiEventTarget {
    mapID?: string;
    url?: string;
    listener: (e: MessageEvent) => void;

    static async registerSW(sw: string | URL, swOptions?: RegistrationOptions) {
        if (!('serviceWorker' in navigator)) {
            throw ('Error: Service worker is not supported');
        }
        let reg: ServiceWorkerRegistration;
        try {
            reg = await navigator.serviceWorker.register(sw, swOptions);
        } catch (e) {
            throw (`Error: Service worker registration failed with ${e}`);
        }
        // 初回ナビゲーションをリロードせずに SW の制御下へ置くため、
        // ready + controller 取得を上限付きで待つ（#30）
        await Weiwudi.waitForController();
        await Weiwudi.swCheck();
        return reg;
    }

    static async waitForController(): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timeout: ReturnType<typeof setTimeout> | undefined;

            function finish() {
                if (settled) return;
                settled = true;
                if (timeout !== undefined) clearTimeout(timeout);
                navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
            }

            function onControllerChange() {
                if (navigator.serviceWorker.controller) {
                    finish();
                    resolve();
                }
            }

            navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
            timeout = setTimeout(() => {
                finish();
                reject('Error: Service worker did not control this page within 10000 ms');
            }, 10000);
            navigator.serviceWorker.ready.then(() => {
                if (navigator.serviceWorker.controller) {
                    finish();
                    resolve();
                }
            }).catch(() => {
                // ready が解決しない構成（scope 外 page など）では controllerchange も発火せず、
                // 上限時間で reject される
            });
        });
    }

    static async swCheck() {
        if (swChecked !== undefined) return swChecked;
        if (swChecking === undefined) swChecking = new Promise((res, _rej) => {
            // Removing async from executor and handling promise explicitly if needed, 
            // but here the code was wrapping await in a new Promise which is antipattern.
            // We can just rely on correct async flow or keep simpler.
            // Given logic:
            fetch(`${BASEURL}ping`)
                .then(r => {
                    swChecked = !!r;
                    res(swChecked);
                })
                .catch(_e => {
                    swChecked = false;
                    res(swChecked);
                });
        });
        return swChecking;
    }

    static async registerMap(mapID: string, options: WeiwudiOptions) {
        const swCheck = await Weiwudi.swCheck();
        if (!swCheck) throw ('Weiwudi service worker is not implemented.');
        let text;
        const p = ['type', 'url', 'width', 'height', 'tileSize', 'minZoom', 'maxZoom', 'maxLng', 'maxLat', 'minLng', 'minLat', 'cacheTtl', 'cacheMaxBytes'].reduce((p, key) => {
            if (typeof options[key] !== 'undefined') {
                if (options[key] instanceof Array) {
                    options[key].map((val: string) => {
                        p.append(key, val);
                    });
                } else {
                    p.append(key, String(options[key]));
                }
            }
            return p;
        }, new URLSearchParams());
        p.append('mapID', mapID);
        const url = new URL(`${BASEURL}add`);
        url.search = p.toString(); // URLSearchParams to string
        const res = await fetch(url.href);
        text = await res.text();
        if (text.match(/^Error: /)) {
            throw (text);
        }
        return new Weiwudi(mapID, JSON.parse(text));
    }

    static async retrieveMap(mapID: string) {
        const swCheck = await Weiwudi.swCheck();
        if (!swCheck) throw ('Weiwudi service worker is not implemented.');
        let text;
        const res = await fetch(`${BASEURL}info?mapID=${mapID}`);
        text = await res.text();
        if (text.match(/^Error: /)) {
            throw (text);
        }
        console.log(text);
        return new Weiwudi(mapID, JSON.parse(text));
    }

    static async removeMap(mapID: string) {
        const swCheck = await Weiwudi.swCheck();
        if (!swCheck) throw ('Weiwudi service worker is not implemented.');
        let text;
        const res = await fetch(`${BASEURL}delete?mapID=${mapID}`);
        text = await res.text();
        if (text.match(/^Error: /)) {
            throw (text);
        }
    }

    constructor(mapID: string, attrs?: WeiwudiOptions) {
        super();
        if (!mapID) throw ('MapID is necessary.');
        this.mapID = mapID;
        if (attrs) Object.assign(this, attrs);
        this.url = `${BASEURL}cache/${mapID}/{z}/{x}/{y}`;
        this.listener = (e: MessageEvent) => {
            const eventMapID = e.data.mapID;
            if (eventMapID !== mapID) return;
            this.dispatchEvent(new CustomEvent(e.data.type, { detail: e.data }));
        };
        navigator.serviceWorker.addEventListener('message', this.listener);
    }

    release() {
        navigator.serviceWorker.removeEventListener('message', this.listener);
        delete this.mapID;
    }

    checkAspect() {
        if (!this.mapID) throw ('This instance is already released.');
    }

    async stats() {
        let text;
        this.checkAspect();
        const res = await fetch(`${BASEURL}stats?mapID=${this.mapID}`);
        text = await res.text();
        if (typeof text === 'string' && text.match(/^Error: /)) {
            throw (text);
        }
        return JSON.parse(text);
    }

    async clean() {
        let text;
        this.checkAspect();
        const res = await fetch(`${BASEURL}clean?mapID=${this.mapID}`);
        text = await res.text();
        if (text.match(/^Error: /)) {
            throw (text);
        }
    }

    async fetchAll() {
        let text;
        this.checkAspect();
        const res = await fetch(`${BASEURL}fetchAll?mapID=${this.mapID}`);
        text = await res.text();
        if (text.match(/^Error: /)) {
            throw (text);
        }
    }

    async remove() {
        this.checkAspect();
        if (this.mapID) await Weiwudi.removeMap(this.mapID);
        this.release();
    }

    async cancel() {
        let text;
        this.checkAspect();
        const res = await fetch(`${BASEURL}cancel?mapID=${this.mapID}`);
        text = await res.text();
        if (text.match(/^Error: /)) {
            throw (text);
        }
    }
}