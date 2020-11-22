"use strict";

const BASEURL = 'https://weiwudi.example.com/api/';
let swChecked;

class WeiwudiEvent extends Event {
    constructor(type, parameter, eventInitDict) {
        super(type, eventInitDict);
        this.parameter = parameter;
    }
}

export default class Weiwudi extends EventTarget {
    static async registerSW(sw, swOptions) {
        if ('serviceWorker' in navigator) {
            try {
                const reg = await navigator.serviceWorker.register(sw, swOptions);

                // A wild service worker has appeared in reg.installing and maybe in waiting!
                const newWorker = reg.installing;
                const waitingWoker = reg.waiting;

                if (newWorker) {
                    if (newWorker.state === 'activated' && !waitingWoker) {
                        // reload to avoid skipWaiting and clients.claim()
                        window.location.reload();
                    }
                    newWorker.addEventListener('statechange', (e) => {
                        // newWorker.state has changed
                        if (newWorker.state === 'activated' && !waitingWoker) {
                            // reload to avoid skipWaiting and clients.claim()
                            window.location.reload();
                        }
                    });
                }

                await Weiwudi.swCheck();

                return reg;
            } catch(e) {
                throw(`Error: Service worker registration failed with ${e}`);
            }
        } else {
            throw('Error: Service worker is not supported');
        }
    }

    static async swCheck() {
        swChecked = await fetch(`${BASEURL}ping`);
    }

    static async registerMap(mapID, options) {
        if (!swChecked) throw('Weiwudi service worker is not implemented.');
        let text;
        try {
            const queries = ['type', 'url', 'width', 'height', 'tileSize', 'minZoom', 'maxZoom', 'maxLng', 'maxLat', 'minLng', 'minLat'].reduce((prev, key) => {
                if (typeof options[key] !== 'undefined') prev[key] = options[key];
                return prev;
            }, { mapID });
            const url = new URL(`${BASEURL}add`);
            url.search = new URLSearchParams(queries);
            const res = await fetch(url.href);
            text = await res.text();
        } catch(e) {
            throw(e);
        }
        if (text.match(/^Error: /)) {
            throw(text);
        }
        console.log(text);
        return new Weiwudi(mapID, JSON.parse(text));
    }

    static async retrieveMap(mapID) {
        if (!swChecked) throw('Weiwudi service worker is not implemented.');
        let text;
        try {
            const res = await fetch(`${BASEURL}info?mapID=${mapID}`);
            text = await res.text();
        } catch(e) {
            throw(e);
        }
        if (text.match(/^Error: /)) {
            throw(text);
        }
        console.log(text);
        return new Weiwudi(mapID, JSON.parse(text));
    }

    static async removeMap(mapID) {
        if (!swChecked) throw('Weiwudi service worker is not implemented.');
        let text;
        try {
            const res = await fetch(`${BASEURL}delete?mapID=${mapID}`);
            text = await res.text();
        } catch(e) {
            throw(e);
        }
        if (text.match(/^Error: /)) {
            throw(text);
        }
    }

    constructor(mapID, attrs) {
        if (!swChecked) throw('Weiwudi service worker is not implemented.');
        super();
        if (!mapID) throw('MapID is necessary.');
        this.mapID = mapID;
        if (attrs) Object.assign(this, attrs);
        this.url = `${BASEURL}cache/${mapID}/{z}/{x}/{y}`;
        this.listener = (e) => {
            const eventMapID = e.data.mapID;
            if (eventMapID !== mapID) return;
            this.dispatchEvent(new WeiwudiEvent(e.data.type, e.data));
        };
        navigator.serviceWorker.addEventListener('message', this.listener);
    }

    release() {
        navigator.serviceWorker.removeEventListener('message', this.listener);
        delete this.mapID;
    }

    checkAspect() {
        if (!this.mapID) throw('This instance is already released.');
    }

    async stats() {
        let text;
        this.checkAspect();
        try {
            const res = await fetch(`${BASEURL}stats?mapID=${this.mapID}`);
            text = await res.text();
        } catch(e) {
            throw(e);
        }
        if (typeof text === 'string' && text.match(/^Error: /)) {
            throw(text);
        }
        return JSON.parse(text);
    }

    async clean() {
        let text;
        this.checkAspect();
        try {
            const res = await fetch(`${BASEURL}clean?mapID=${this.mapID}`);
            text = await res.text();
        } catch(e) {
            throw(e);
        }
        if (text.match(/^Error: /)) {
            throw(text);
        }
    }

    async fetchAll() {
        let text;
        this.checkAspect();
        try {
            const res = await fetch(`${BASEURL}fetchAll?mapID=${this.mapID}`);
            text = await res.text();
        } catch(e) {
            throw(e);
        }
        if (text.match(/^Error: /)) {
            throw(text);
        }
    }

    async remove() {
        this.checkAspect();
        await Weiwudi.removeMap(this.mapID);
        this.release();
    }
}