!function(){
    "use strict";
    const MERC_MAX = 20037508.342789244;
    const dbCache = {};
    let fetchAllBlocker;
    const extractTemplate = (template, z, x, y) => {
        const result = template.replace('{z}', z)
            .replace('{x}', x)
            .replace('{y}', y)
            .replace('{-y}', Math.pow(2, z) - y - 1);
        return result;
    };
    const b64toBlob = (b64Data, contentType='', sliceSize=512) => {
        const byteCharacters = atob(b64Data);
        const byteArrays = [];

        for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
            const slice = byteCharacters.slice(offset, offset + sliceSize);

            const byteNumbers = new Array(slice.length);
            for (let i = 0; i < slice.length; i++) {
                byteNumbers[i] = slice.charCodeAt(i);
            }

            const byteArray = new Uint8Array(byteNumbers);
            byteArrays.push(byteArray);
        }

        const blob = new Blob(byteArrays, {type: contentType});
        return blob;
    };
    const getDB = async (dbname, table, key) => {
        return new Promise((resolve, reject) => {
            try {
                if (dbCache[dbname]) resolve(dbCache[dbname]);
                else {
                    const openDB = indexedDB.open(dbname);
                    openDB.onupgradeneeded = function (event) {
                        const db = event.target.result;
                        db.createObjectStore(table, {keyPath: key});
                    };
                    openDB.onsuccess = function (event) {
                        const db = event.target.result;
                        dbCache[dbname] = db;
                        resolve(db);
                    };
                    openDB.onerror = function (error) {
                        reject(error);
                    };
                }
            } catch (e) {
                reject(e);
            }
        });
    };
    const deleteDB = async (dbname) => {
        if (dbCache[dbname]) {
            const db = dbCache[dbname];
            db.close();
            delete dbCache[dbname];
        }
        return new Promise((resolve, reject) => {
            try {
                const deleteReq = indexedDB.deleteDatabase(dbname);

                deleteReq.onsuccess = async (event) => {
                    resolve();
                };
                deleteReq.onerror = function (error) {
                    reject(error);
                };
            } catch(e) {
                reject(e);
            }
        });
    };
    const cleanDB = async (db, table) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([table], 'readwrite');
            const store = tx.objectStore(table);
            const clearReq = store.clear();
            clearReq.onsuccess = function(e) {
            };
            clearReq.onerror = function(e) {
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
    const countDB = async (db, table) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([table], 'readonly');
            const store = tx.objectStore(table);
            const cursorReq = store.openCursor();
            let count = 0;
            let size = 0;
            cursorReq.onsuccess = function(e) {
                const cursor = cursorReq.result;
                if (cursor) {
                    count++;
                    size = size + cursor.value.blob.size;
                    cursor.continue();
                }
            };
            cursorReq.onerror = function(e) {
                reject(e);
            };
            tx.oncomplete = function(e) {
                resolve({
                    count: count,
                    size: size
                });
            };
            tx.onabort = function(e) {
                reject(e);
            };
            tx.onerror = function(e) {
                reject(e);
            };
        });
    };
    const getItem = async (db, table, key, dry) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([table], 'readonly');
            const store = tx.objectStore(table);
            const getReq = dry ? store.getKey(key) : store.get(key);
            getReq.onsuccess = function(e) {
            };
            getReq.onerror = function(e) {
                reject(e);
            };
            tx.oncomplete = function(e) {
                resolve(getReq.result);
            };
            tx.onabort = function(e) {
                reject(e);
            };
            tx.onerror = function(e) {
                reject(e);
            };
        });
    };
    const putItem = async (db, table, item) => {
        return new Promise((resolve, reject) => {
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
    const deleteItem = async (db, table, key) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([table], 'readwrite');
            const store = tx.objectStore(table);
            const delReq = store.delete(key);
            delReq.onsuccess = function(e) {
            };
            delReq.onerror = function(e) {
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
    const getAllKeys = async (db, table) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([table], 'readwrite');
            const store = tx.objectStore(table);
            const getReq = store.getAllKeys();
            getReq.onsuccess = function(e) {
            };
            getReq.onerror = function(e) {
                reject(e);
            };
            tx.oncomplete = function(e) {
                resolve(getReq.result);
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
        const client = event.clientId ? await self.clients.get(event.clientId) : undefined;
        const matched = url.pathname.match(/^\/api\/([\w\d]+)(?:\/(.+))?$/);
        if (matched) {
            const query = [...url.searchParams.entries()].reduce((obj, e) => ({...obj, [e[0]]: e[1]}), {});
            const apiName = matched[1];
            const restPath = matched[2];
            let res = await apiFunc(apiName, query, restPath, client);
            if (res) {
                if (!(res instanceof Response)) res = new Response(res);
                return res;
            }
        }
    };
    const getImage = async (mapID, z, x, y, noOutput) => {
        let outExtent;
        const db = await getDB('Weiwudi');
        const setting = await getItem(db, 'mapSetting', mapID);
        if (!noOutput) {
            if (!setting) return `Error: MapID "${mapID}" not found`;
            if (z < setting.minZoom || z > setting.maxZoom) outExtent = true;
            else {
                const minXatZ = Math.floor(setting.minX / Math.pow(2, setting.maxZoom - z));
                const maxXatZ = Math.floor(setting.maxX / Math.pow(2, setting.maxZoom - z));
                const minYatZ = Math.floor(setting.minY / Math.pow(2, setting.maxZoom - z));
                const maxYatZ = Math.floor(setting.maxY / Math.pow(2, setting.maxZoom - z));
                if (x < minXatZ || x > maxXatZ || y < minYatZ || y > maxYatZ) outExtent = true;
            }
        }
        let headers = {};
        let blob;
        let status = 200;
        let statusText = 'OK';
        if (outExtent) {
            headers = {
                'content-type': 'image/png'
            };
            blob = b64toBlob('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAMAAABrrFhUAAAAB3RJTUUH3QgIBToaSbAjlwAAABd0'+
                'RVh0U29mdHdhcmUAR0xEUE5HIHZlciAzLjRxhaThAAAACHRwTkdHTEQzAAAAAEqAKR8AAAAEZ0FN'+
                'QQAAsY8L/GEFAAAAA1BMVEX///+nxBvIAAAAAXRSTlMAQObYZgAAAFRJREFUeNrtwQEBAAAAgJD+'+
                'r+4ICgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'+
                'AAAAAAAAAAAAABgBDwABHHIJwwAAAABJRU5ErkJggg==', headers['content-type']);
        } else {
            const cacheDB = await getDB(`Weiwudi_${mapID}`);
            const cached = await getItem(cacheDB, 'tileCache', `${z}_${x}_${y}`, noOutput);
            const nowEpoch = new Date().getTime();
            if (!cached || !cached.epoch || nowEpoch - cached.epoch > 86400000) {
                const url = extractTemplate(setting.url, z, x, y);
                try {
                    const resp = await fetch(url);
                    if (resp.ok) {
                        headers = [...resp.headers.entries()].reduce((obj, e) => ({...obj, [e[0]]: e[1]}), {});
                        blob = await resp.blob();
                        await putItem(cacheDB, 'tileCache', {
                            'z_x_y': `${z}_${x}_${y}`,
                            headers: headers,
                            blob: blob,
                            epoch: nowEpoch
                        });
                    } else {
                        if (cached) {
                            headers = cached.headers;
                            blob = cached.blob;
                        } else {
                            status = resp.status;
                            statusText = resp.statusText;
                            headers = [...resp.headers.entries()].reduce((obj, e) => ({...obj, [e[0]]: e[1]}), {});
                            blob = await resp.blob();
                        }
                        if (fetchAllBlocker) fetchAllBlocker.error++;
                    }
                } catch(e) {
                    if (cached) {
                        headers = cached.headers;
                        blob = cached.blob;
                    } else {
                        status = 404;
                        statusText = 'Not Found';
                    }
                    if (fetchAllBlocker) fetchAllBlocker.error++;
                }
            } else if (!noOutput) {
                headers = cached.headers;
                blob = cached.blob;
            }
        }
        return noOutput ? undefined : new Response(blob, {
            status,
            statusText,
            headers: new Headers(headers)
        });
    };
    const fetchAll = async (client, setting) => {
        let processed = 0;
        let error = 0;
        let percent = 0;
        const db = await getDB(`Weiwudi_${setting.mapID}`);
        const allKeys = await getAllKeys(db, 'tileCache');
        try {
            const allTasks = [];
            for (let z = setting.minZoom; z <= setting.maxZoom; z++) {
                const maxXatZ = Math.floor(setting.maxX / Math.pow(2, setting.maxZoom - z));
                const minXatZ = Math.floor(setting.minX / Math.pow(2, setting.maxZoom - z));
                const maxYatZ = Math.floor(setting.maxY / Math.pow(2, setting.maxZoom - z));
                const minYatZ = Math.floor(setting.minY / Math.pow(2, setting.maxZoom - z));
                for (let x = minXatZ; x <= maxXatZ; x++) {
                    for (let y = minYatZ; y <= maxYatZ; y++) {
                        allTasks.push([z, x, y]);
                    }
                }
            }
            if (allTasks.length != setting.totalTile) console.log('Number of tiles is different');
            let subTasks = allTasks.splice(0, 5);
            while (subTasks.length) {
                //Alive check
                const checkClient = await self.clients.get(client.id);
                if (!checkClient) {
                    fetchAllBlocker = undefined;
                    return;
                }
                const promises = subTasks.map((task) => {
                    if (allKeys.indexOf(`${task[0]}_${task[1]}_${task[2]}`) >= 0) return;
                    return getImage(setting.mapID, task[0], task[1], task[2], true);
                });
                await Promise.all(promises);
                processed += promises.length;
                fetchAllBlocker.count = processed;
                const done = Math.floor(processed * 100 / setting.totalTile);
                const done5 = Math.floor(done / 5) * 5;
                if (done5 != percent) {
                    percent = done5;
                    client.postMessage({
                        type: 'proceed',
                        message: `Proceeding the tile fetching: ${setting.mapID} ${done}% (${processed} / ${setting.totalTile})`,
                        percent: done,
                        processed,
                        error: fetchAllBlocker.error,
                        total: setting.totalTile,
                        mapID: setting.mapID
                    });
                }
                subTasks = allTasks.splice(0, 5);
            }
            const error = fetchAllBlocker.error;
            fetchAllBlocker = undefined;
            client.postMessage({
                type: 'finish',
                message: `Fetched all tiles of ${setting.mapID}${error ? ` with ${error} error cases` : ''}`,
                total: setting.totalTile,
                mapID: setting.mapID,
                error
            });
        } catch(e) {
            fetchAllBlocker = undefined;
            client.postMessage({
                type: 'stop',
                message: `Fetching stopped: ${setting.mapID} ${processed} / ${setting.totalTile}`,
                reason: e,
                processed,
                total: setting.totalTile,
                mapID: setting.mapID
            });
        }
    }
    const apiFunc = async (apiName, query, restPath, client) => {
        let retVal;
        const checkAttributes = (query, targets) => {
            return targets.reduce((prev, target) => {
                if (prev) return prev;
                if (query[target] === undefined) return `Error: Attribute "${target}" is missing`;
                return prev;
            }, undefined);
        };
        try {
            switch (apiName) {
                case 'ping':
                    retVal = 'Implemented';
                    break;
                case 'info':
                    retVal = checkAttributes(query, ['mapID']);
                    if (!retVal) {
                        const db = await getDB('Weiwudi', 'mapSetting', 'mapID');
                        const setting = await getItem(db, 'mapSetting', query.mapID);
                        if (!setting) retVal = `Error: MapID "${query.mapID}" not found`;
                        else {
                            retVal = new Response(JSON.stringify(setting), {
                                headers: new Headers({
                                    'content-type': 'application/json'
                                })
                            });
                        }
                    }
                    break;
                case 'add':
                    const db = await getDB('Weiwudi', 'mapSetting', 'mapID');
                    retVal = checkAttributes(query, ['mapID','type', 'url']);
                    if (!retVal) {
                        query.tileSize = parseInt(query.tileSize || 256);
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
                        await getDB(`Weiwudi_${query.mapID}`, 'tileCache', 'z_x_y');
                        retVal = new Response(JSON.stringify(query), {
                            headers: new Headers({
                                'content-type': 'application/json'
                            })
                        });
                    }
                    break;
                case 'clean':
                    retVal = checkAttributes(query, ['mapID']);
                    if (!retVal) {
                        const cacheDB = await getDB(`Weiwudi_${query.mapID}`);
                        await cleanDB(cacheDB, 'tileCache');
                        retVal = `Cleaned: ${query.mapID}`;
                    }
                    break;
                case 'delete':
                    retVal = checkAttributes(query, ['mapID']);
                    if (!retVal) {
                        await deleteDB(`Weiwudi_${query.mapID}`);
                        const db = await getDB('Weiwudi');
                        await deleteItem(db, 'mapSetting', query.mapID);
                        retVal = `Deleted: ${query.mapID}`;
                    }
                    break;
                case 'stats':
                    retVal = checkAttributes(query, ['mapID']);
                    if (!retVal) {
                        const db = await getDB('Weiwudi');
                        const setting = await getItem(db, 'mapSetting', query.mapID);
                        if (!setting) retVal = `Error: MapID "${query.mapID}" not found`;
                        else {
                            const cacheDB = await getDB(`Weiwudi_${query.mapID}`);
                            const ret = await countDB(cacheDB, 'tileCache');
                            if (setting.totalTile) {
                                ret.total = setting.totalTile;
                                ret.percent = Math.floor(ret.count / ret.total * 100);
                            }
                            retVal = new Response(JSON.stringify(ret), {
                                headers: new Headers({
                                    'content-type': 'application/json'
                                })
                            });
                        }
                    }
                    break;
                case 'cache':
                    const matched = restPath.match(/^([\d\w]+)\/(\d+)\/(\d+)\/(\d+)$/);
                    if (matched) {
                        retVal = await getImage(matched[1], parseInt(matched[2]), parseInt(matched[3]), parseInt(matched[4]));
                    } else {
                        retVal = 'Error: "cache" api needs mapID, zoom, x, y settings';
                    }
                    break;
                case 'fetchAll':
                    retVal = checkAttributes(query, ['mapID']);
                    if (!retVal) {
                        const db = await getDB('Weiwudi');
                        const setting = await getItem(db, 'mapSetting', query.mapID);
                        if (!setting) retVal = `Error: MapID "${query.mapID}" not found`;
                        else if (!setting.totalTile) retVal = `Error: Map "${query.mapID}" cannot fetch all tiles`;
                        else if (fetchAllBlocker) {
                            retVal = `Error: Another fetching process is running: "${fetchAllBlocker.mapID}" (${fetchAllBlocker.count} / ${fetchAllBlocker.total})`;
                        } else {
                            setTimeout(() => {
                                fetchAllBlocker = {
                                    mapID: query.mapID,
                                    total: setting.totalTile,
                                    count: 0,
                                    error: 0
                                };
                                fetchAll(client, setting);
                            }, 1);
                            retVal = `Fetching task start: ${query.mapID}`;
                        }
                    }
                    break;
                default:
                    retVal = `Error: API ${apiName} not found`;
            }
        } catch (e) {
            retVal = `Error: ${e}`;
        }

        if (retVal) return retVal;
    };

    self.workbox.routing.registerRoute(/^https?:\/\/weiwudi.example.com/, handlerCb, 'GET');
}();