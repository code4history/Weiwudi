!function(){
    "use strict";
    const MERC_MAX = 20037508.342789244;
    const getDB = async () => {
        return await new Promise((resolve, reject) => {
            const openDB = indexedDB.open('mapTileListDB');
            openDB.onupgradeneeded = function (event) {
                const db = event.target.result;
                db.createObjectStore('mapSetting', {keyPath: 'mapID'});
            };
            openDB.onsuccess = function (event) {
                const db = event.target.result;
                resolve(db);
            };
            openDB.onerror = function (error) { // eslint-disable-line no-unused-vars
                resolve();
            };
        });
    };
    const putItem = async (db, table, item) => {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction([table], 'readwrite');
            const store = tx.objectStore(table);
            const putReq = store.put(item);
            putReq.onsuccess = function(e) {
            };
            putReq.onerror = function(e) {
                reject(e);
            };
            tx.oncomplete = function(e) {
                resolve();
            };
            tx.onabort = function(e) {
                reject(e);
            };
            tx.onerror = function(e) {
                reject(e);
            };
        });
    };
    const handlerCb = async ({url, request, event, params}) => {
        if (url.pathname.match(/^\/api/)) {
            const query = [...url.searchParams.entries()].reduce((obj, e) => ({...obj, [e[0]]: e[1]}), {});
            const apiName = url.pathname.replace(/^\/api\//, '');
            const res = await apiFunc(apiName, query);
            if (res) return new Response(res);
        }

        const response = await fetch('https://b.tile.openstreetmap.org/17/116339/51358.png');
        const responseBody = await response.text();
        return new Response(`${responseBody} <!-- Look Ma. Added Content. -->`);
    };
    const apiFunc = async (apiName, query) => {
        let retVal;
        const checkAttributes = (query, targets) => {
            return targets.reduce((prev, target) => {
                if (prev) return prev;
                if (query[target] === undefined) return `Error: Attribute "${target}" is missing`;
                return prev;
            }, undefined);
        };
        switch (apiName) {
            case 'ping':
                retVal = 'Implemented';
                break;
            case 'add':
                const db = await getDB();
                retVal = checkAttributes(query, ['type', 'url']);
                if (!retVal) {
                    query.tileSize = query.tileSize || 256;
                    switch (query.type) {
                        case 'xyz':
                            retVal = checkAttributes(query, ['width', 'height']);
                            if (!retVal) {
                                query.width = parseInt(query.width);
                                query.height = parseInt(query.height);
                                const calcZoom = (v) => { return Math.ceil(Math.log(v / query.tileSize) / Math.log(2)) };
                                query.maxZoom = Math.max(calcZoom(query.width), calcZoom(query.height));
                                query.minZoom = query.minZoom ? parseInt(query.minZoom) : 0;
                                query.minX = 0;
                                query.minY = 0;
                                query.maxX = Math.ceil(query.width / query.tileSize) - 1;
                                query.maxY = Math.ceil(query.height / query.tileSize) - 1;
                            }
                            break;
                        case 'wmts':
                            retVal = checkAttributes(query, ['minZoom', 'maxZoom']);
                            if (!retVal) {
                                const lng2MercX = (lng) => { return 6378137 * lng * Math.PI / 180 };
                                const lat2MercY = (lat) => { return 6378137 * Math.log(Math.tan(Math.PI / 360 * (90 + lat))) };
                                query.maxZoom = parseInt(query.maxZoom);
                                query.minZoom = parseInt(query.minZoom);
                                if (query.maxLng && query.minLng && query.maxLat && query.minLat) {
                                    query.maxLng = parseFloat(query.maxLng);
                                    query.minLng = parseFloat(query.minLng);
                                    query.maxLat = parseFloat(query.maxLat);
                                    query.minLat = parseFloat(query.minLat);
                                    const maxMercX = lng2MercX(query.maxLng);
                                    const minMercX = lng2MercX(query.minLng);
                                    const maxMercY = lat2MercY(query.maxLat);
                                    const minMercY = lat2MercY(query.minLat);
                                    query.minX = Math.floor((MERC_MAX + minMercX) / (2 * MERC_MAX) * Math.pow(2, query.maxZoom));
                                    query.maxX = Math.floor((MERC_MAX + maxMercX) / (2 * MERC_MAX) * Math.pow(2, query.maxZoom));
                                    query.minY = Math.floor((MERC_MAX - maxMercY) / (2 * MERC_MAX) * Math.pow(2, query.maxZoom));
                                    query.maxY = Math.floor((MERC_MAX - minMercY) / (2 * MERC_MAX) * Math.pow(2, query.maxZoom));
                                }
                            }
                            break;
                        default:
                            retVal = 'Error: Unknown "type" value';
                    }
                }
                if (!retVal) {
                    if (!checkAttributes(query, ['maxX', 'minX', 'maxY', 'minY'])) {
                        query.totalTile = 0;
                        const calcTileCoord = (atMaxZoom, zoom) => { return Math.floor(atMaxZoom / Math.pow(2, query.maxZoom - zoom)) };
                        for (let z = query.minZoom; z <= query.maxZoom; z++) {
                            const minX = calcTileCoord(query.minX, z);
                            const minY = calcTileCoord(query.minY, z);
                            const maxX = calcTileCoord(query.maxX, z);
                            const maxY = calcTileCoord(query.maxY, z);
                            query.totalTile += (maxX - minX + 1) * (maxY - minY + 1);
                        }
                    }
                    await putItem(db, 'mapSetting', query);
                    retVal = 'Success';
                }
                break;
            default:
        }
        if (retVal) return retVal;
        console.log(`${apiName} ${query}`);
    };



    self.workbox.routing.registerRoute(/^https?:\/\/tilecache.example.com/, handlerCb, 'GET');
}();