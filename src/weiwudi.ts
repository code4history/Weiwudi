"use strict";

const BASEURL = 'https://weiwudi.example.com/api/';
let swChecking: Promise<boolean> | undefined;
let swChecked: boolean | undefined;

// Polyfill removed as target is ES2020

class EventTarget {
    listeners: Record<string, Function[]>;

    constructor() {
        this.listeners = {};
    }

    addEventListener(type: string, callback: Function) {
        if (!(type in this.listeners)) {
            this.listeners[type] = [];
        }
        this.listeners[type].push(callback);
    }

    removeEventListener(type: string, callback: Function) {
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
    [key: string]: any;
}

export interface WeiwudiInternalOps {
    // Placeholder for future strict typing of internal operations
    [key: string]: any;
}

export default class Weiwudi extends EventTarget {
    mapID?: string;
    url?: string;
    listener: (e: MessageEvent) => void;

    static async registerSW(sw: string | URL, swOptions?: RegistrationOptions) {
        if ('serviceWorker' in navigator) {
            try {
                const reg = await navigator.serviceWorker.register(sw, swOptions);
                //console.log('Service Worker Registered');

                // A wild service worker has appeared in reg.installing and maybe in waiting!
                const newWorker = reg.installing;
                const waitingWoker = reg.waiting;

                if (newWorker) {
                    if (newWorker.state === 'activated' && !waitingWoker) {
                        // reload to avoid skipWaiting and clients.claim()
                        window.location.reload();
                    }
                    newWorker.addEventListener('statechange', (_e) => {
                        // newWorker.state has changed
                        if (newWorker.state === 'activated' && !waitingWoker) {
                            // reload to avoid skipWaiting and clients.claim()
                            window.location.reload();
                        }
                    });
                }
                reg.onupdatefound = () => {
                    //console.log('Found Service Worker update');
                    reg.update();
                };

                await Weiwudi.swCheck();

                return reg;
            } catch (e) {
                throw (`Error: Service worker registration failed with ${e}`);
            }
        } else {
            throw ('Error: Service worker is not supported');
        }
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
        const p = ['type', 'url', 'width', 'height', 'tileSize', 'minZoom', 'maxZoom', 'maxLng', 'maxLat', 'minLng', 'minLat'].reduce((p, key) => {
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
        // @ts-ignore: This method handles the possibility of mapID being undefined/deleted, but TS checks strict logic
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