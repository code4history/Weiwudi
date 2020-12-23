"use strict";

const BASEURL = 'https://weiwudi.example.com/api/';
let swChecking;
let swChecked;

class WeiwudiEvent extends Event {
    constructor(type, parameter, eventInitDict) {
        super(type, eventInitDict);
        this.parameter = parameter;
    }
}

class EventTarget {
    constructor() {
        this.listeners = {};
    }

    addEventListener(type, callback) {
        if (!(type in this.listeners)) {
            this.listeners[type] = [];
        }
        this.listeners[type].push(callback);
    }

    removeEventListener(type, callback) {
        if (!(type in this.listeners)) {
            return;
        }
        const stack = this.listeners[type];
        for (let i = 0, l = stack.length; i < l; i++) {
            if (stack[i] === callback){
                stack.splice(i, 1);
                return;
            }
        }
    }

    dispatchEvent(event) {
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
    static async registerSW(sw, swOptions) {
        if ('serviceWorker' in navigator) {
            try {
                const reg = await navigator.serviceWorker.register(sw, swOptions);
                //console.log('Service Worker Registered');

                reg.onupdatefound = () => {
                    //console.log('Found Service Worker update');
                    reg.update();
                };

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
        if (swChecked !== undefined) return swChecked;
        if (swChecking === undefined) swChecking = new Promise(async (res, rej) => {
            try {
                swChecked = await fetch(`${BASEURL}ping`);
                swChecked = !!swChecked;
            } catch(e) {
                swChecked = false;
            }
            res(swChecked);
        });
        return swChecking;
    }

    static async registerMap(mapID, options) {
        const swCheck = await Weiwudi.swCheck();
        if (!swCheck) throw('Weiwudi service worker is not implemented.');
        let text;
        try {
            const p = ['type', 'url', 'width', 'height', 'tileSize', 'minZoom', 'maxZoom', 'maxLng', 'maxLat', 'minLng', 'minLat'].reduce((p, key) => {
                if (typeof options[key] !== 'undefined') {
                    if (options[key] instanceof Array) {
                        options[key].map((val) => {
                            p.append(key, val);
                        });
                    } else {
                        p.append(key, options[key]);
                    }
                }
                return p;
            }, new URLSearchParams());
            p.append('mapID', mapID);
            const url = new URL(`${BASEURL}add`);
            url.search = p;
            const res = await fetch(url.href);
            text = await res.text();
        } catch(e) {
            throw(e);
        }
        if (text.match(/^Error: /)) {
            throw(text);
        }
        return new Weiwudi(mapID, JSON.parse(text));
    }

    static async retrieveMap(mapID) {
        const swCheck = await Weiwudi.swCheck();
        if (!swCheck) throw('Weiwudi service worker is not implemented.');
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
        const swCheck = await Weiwudi.swCheck();
        if (!swCheck) throw('Weiwudi service worker is not implemented.');
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

    async cancel() {
        let text;
        this.checkAspect();
        try {
            const res = await fetch(`${BASEURL}cancel?mapID=${this.mapID}`);
            text = await res.text();
        } catch(e) {
            throw(e);
        }
        if (text.match(/^Error: /)) {
            throw(text);
        }
    }
}