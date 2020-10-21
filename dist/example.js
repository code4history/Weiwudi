!function(){
    "use strict";
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
        switch (apiName) {
            case 'ping':
                retVal = 'Implemented';
                break;
            case 'add':
                const db = await getDB();
                await putItem(db, 'mapSetting', query);
                retVal = 'Success';
                break;
            default:
        }
        if (retVal) return retVal;
        console.log(`${apiName} ${query}`);
    };



    self.workbox.routing.registerRoute(/^https?:\/\/tilecache.example.com/, handlerCb, 'GET');
}();