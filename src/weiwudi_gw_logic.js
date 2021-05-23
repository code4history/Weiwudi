import createSqlWasm from "./sql-wasm-browser";
//import "./sqlite3.wasm";

export function Weiwudi_Internal(registerRoute){
  "use strict";
  const MERC_MAX = 20037508.342789244;
  const dbCache = {};
  let fetchAllBlocker;

  let sql;
  let sqlLoader = async () => {};

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

  const handlerCb = async ({url, request, event, params}) => {
    await sqlLoader();
    const client = event.clientId ? await self.clients.get(event.clientId) : undefined;
    const matched = url.pathname.match(/^\/api\/([\w\d]+)(?:\/(.+))?$/);
    if (matched) {
      const query = [...url.searchParams.entries()].reduce((obj, e) => {
        const values = url.searchParams.getAll(e[0]);
        if (values.length === 1) obj[e[0]] = values[0];
        else obj[e[0]] = values;
        return obj;
      }, {});
      const apiName = matched[1];
      const restPath = matched[2];
      let res = await apiFunc(apiName, query, restPath, client);
      if (res) {
        if (!(res instanceof Response)) res = new Response(res);
        return res;
      }
    }
  };

  const getDB = async (dbname, table, key) => {
    /* if (sql) {
      console.log("sql process2");
      // Create a database
      var db = new sql.Database();
      // NOTE: You can also use new sql.Database(data) where
      // data is an Uint8Array representing an SQLite database file

      // Execute some sql
      let sqlstr = "CREATE TABLE hello (a int, b char);";
      sqlstr += "INSERT INTO hello VALUES (0, 'hello');"
      sqlstr += "INSERT INTO hello VALUES (1, 'world');"
      db.run(sqlstr); // Run the query without returning anything

      var res = db.exec("SELECT * FROM hello");
      /*
      [
          {columns:['a','b'], values:[[0,'hello'],[1,'world']]}
      ]
      * /

      // Prepare an sql statement
      //var stmt = db.prepare("SELECT * FROM hello WHERE a=:aval AND b=:bval");
      var stmt = db.prepare("SELECT * FROM hello WHERE a=:aval");

      // Bind values to the parameters and fetch the results of the query
      //var result = stmt.getAsObject({':aval' : 1, ':bval' : 'world'});
      var result = stmt.getAsObject({':aval' : 0});
      console.log(result); // Will print {a:1, b:'world'}
    }*/

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
  const getImage = async (mapID, z, x, y, noOutput) => {
    let outExtent;
    const db = await getDB('Weiwudi');
    const setting = await getItem(db, 'mapSetting', mapID);
    if (!noOutput) {
      if (!setting) return `Error: MapID "${mapID}" not found`;
      if (z < setting.minZoom || z > setting.maxZoom) outExtent = 'zoom';
      else {
        const minXatZ = Math.floor(setting.minX / Math.pow(2, setting.maxZoom - z));
        const maxXatZ = Math.floor(setting.maxX / Math.pow(2, setting.maxZoom - z));
        const minYatZ = Math.floor(setting.minY / Math.pow(2, setting.maxZoom - z));
        const maxYatZ = Math.floor(setting.maxY / Math.pow(2, setting.maxZoom - z));
        if (x < minXatZ || x > maxXatZ || y < minYatZ || y > maxYatZ) outExtent = 'extent';
      }
    }
    let headers = {};
    let blob;
    let status = 200;
    let statusText = 'OK';
    if (outExtent) {
      if (outExtent === 'zoom') {
        status = 404;
        statusText = 'Not Found';
      } else {
        headers = {
          'content-type': 'image/png'
        };
        blob = b64toBlob('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAMAAABrrFhUAAAAB3RJTUUH3QgIBToaSbAjlwAAABd0'+
          'RVh0U29mdHdhcmUAR0xEUE5HIHZlciAzLjRxhaThAAAACHRwTkdHTEQzAAAAAEqAKR8AAAAEZ0FN'+
          'QQAAsY8L/GEFAAAAA1BMVEX///+nxBvIAAAAAXRSTlMAQObYZgAAAFRJREFUeNrtwQEBAAAAgJD+'+
          'r+4ICgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'+
          'AAAAAAAAAAAAABgBDwABHHIJwwAAAABJRU5ErkJggg==', headers['content-type']);
      }
    } else {
      const cacheDB = await getDB(`Weiwudi_${mapID}`);
      const cached = await getItem(cacheDB, 'tileCache', `${z}_${x}_${y}`, noOutput);
      const nowEpoch = new Date().getTime();
      if (!cached || !cached.epoch || nowEpoch - cached.epoch > 86400000) {
        const template = setting.url instanceof Array ?
          setting.url[Math.floor(Math.random() * setting.url.length)] :
          setting.url;
        const url = extractTemplate(template, z, x, y);
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
      if (allTasks.length !== setting.totalTile) console.log('Number of tiles is different');
      let subTasks = allTasks.splice(0, 5);
      while (subTasks.length) {
        //Alive check
        const checkClient = await self.clients.get(client.id);
        if (!checkClient) {
          fetchAllBlocker = undefined;
          return;
        }
        if (fetchAllBlocker.cancel) {
          fetchAllBlocker = undefined;
          client.postMessage({
            type: 'canceled',
            message: `Fetching tile of ${setting.mapID} is canceled`,
            mapID: setting.mapID,
            method: 'tiles'
          });
          return;
        }
        const promises = subTasks.map((task) => {
          if (allKeys.indexOf(`${task[0]}_${task[1]}_${task[2]}`) >= 0) return;
          return getImage(setting.mapID, task[0], task[1], task[2], true);
        });
        await Promise.all(promises);
        processed += promises.length;
        fetchAllBlocker.count = processed;
        percent = Math.floor(processed * 100 / setting.totalTile);
        client.postMessage({
          type: 'proceed',
          message: `Proceeding the tile fetching: ${setting.mapID} ${percent}% (${processed} / ${setting.totalTile})`,
          percent,
          processed,
          error: fetchAllBlocker.error,
          total: setting.totalTile,
          mapID: setting.mapID,
          method: 'tiles'
        });
        subTasks = allTasks.splice(0, 5);
      }
      const error = fetchAllBlocker.error;
      fetchAllBlocker = undefined;
      client.postMessage({
        type: 'finish',
        message: `Fetched all tiles of ${setting.mapID}${error ? ` with ${error} error cases` : ''}`,
        total: setting.totalTile,
        mapID: setting.mapID,
        error,
        method: 'tiles'
      });
    } catch(e) {
      fetchAllBlocker = undefined;
      client.postMessage({
        type: 'stop',
        message: `Fetching stopped: ${setting.mapID} ${processed} / ${setting.totalTile}`,
        reason: e,
        processed,
        total: setting.totalTile,
        mapID: setting.mapID,
        method: 'tiles'
      });
    }
  }
  const fetchMbtiles = async (client, setting) => {
    let processed = 0;
    let error = 0;
    let percent = 0;
    const db = await getDB(`Weiwudi_${setting.mapID}`);
    const mbtiles = setting.mbtiles;
    const resp_h = await fetch(mbtiles, {
      method: 'HEAD'
    });
    try {
      if (resp_h.status === 200) {
        const size = resp_h.headers.get('Content-Length');
        fetchAllBlocker.total = size;
        fetchAllBlocker.controller = new AbortController();

        const resp_g = await fetch(mbtiles, {
          signal: fetchAllBlocker.controller.signal
        });
        if (resp_g.status === 200) {
          const body = resp_g.body;
          const headers = [...resp_g.headers.entries()].reduce((obj, e) => ({...obj, [e[0]]: e[1]}), {});
          console.log(body);
          const reader = body.getReader();

          const stream = new ReadableStream({
            start(controller) {
              return pump();

              function pump() {
                return reader.read().then(({ done, value }) => {
                  if (fetchAllBlocker.cancel) {
                    controller.abort();
                    return;
                  }

                  if (done) {
                    controller.close();
                    return;
                  }

                  processed += value.byteLength;
                  fetchAllBlocker.count = processed;
                  const prevPercent = percent;
                  percent = Math.floor(processed * 100 / fetchAllBlocker.total);
                  if (prevPercent !== percent) {
                    console.log(`Percent: ${percent}`);

                    client.postMessage({
                      type: 'proceed',
                      message: `Proceeding the mbtiles fetching: ${setting.mapID} ${percent}% (${processed} / ${fetchAllBlocker.total})`,
                      percent,
                      processed,
                      total: fetchAllBlocker.total,
                      mapID: setting.mapID,
                      method: 'mbtiles'
                    });
                  }
                  controller.enqueue(value);
                  return pump();
                });
              }
            }
          });
          const resp_a = new Response(stream);
          const buffer = await resp_a.arrayBuffer();
          const uint8Arr = new Uint8Array(buffer);

          const mbtiles = new sql.Database(uint8Arr);
          const meta = mbtiles.exec("SELECT value FROM metadata WHERE name = 'format'");
          let mimeType;
          if (meta.length > 0) {
            const format = meta[0].values[0][0];
            mimeType = format === 'png' ? 'image/png' :
              format === 'jpg' ? 'image/jpeg' :
                format === 'webp' ? 'image/webp' :
                  format === 'pbf' ? 'application/x-protobuf' : undefined;
          }

          const res = mbtiles.exec("SELECT * FROM tiles");
          let z_i = 0, x_i = 1, y_i = 2, d_i = 3;
          for (let i = 0; i < res[0].columns.length; i++) {
            switch (res[0].columns[i]) {
              case "zoom_level":
                z_i = i;
                break;
              case "tile_column":
                x_i = i;
                break;
              case "tile_row":
                y_i = i;
                break;
              case "tile_data":
                d_i = i;
                break;
              default:
            }
          }
          const nowEpoch = new Date().getTime();

          const decoder = new TextDecoder('utf-8');
          for (let i = 0; i < res[0].values.length; i++) {
            const value = res[0].values[i];
            const z = value[z_i];
            const x = value[x_i];
            const y = value[y_i];
            const data = value[d_i];
            if (!mimeType) {
              const str = decoder.decode(data.slice(1, 4));
              mimeType = str === 'PNG' ? 'image/png' : 'image/jpeg';
              headers['content-type'] = mimeType;
            }
            headers['content-length'] = data.byteLength;

            const blob = new Blob([data], {type: mimeType});
            await putItem(db, 'tileCache', {
              'z_x_y': `${z}_${x}_${y}`,
              headers: headers,
              blob: blob,
              epoch: nowEpoch
            });
          }
          client.postMessage({
            type: 'finish',
            message: `Fetched all tiles of ${setting.mapID}`,
            total: fetchAllBlocker.total,
            mapID: setting.mapID,
            method: 'mbtiles'
          });
          fetchAllBlocker = undefined;
        } else {
          throw `Error downloading mbtiles of ${setting.mapID}`;
        }
      } else {
        throw `Error downloading mbtiles of ${setting.mapID}`;
      }
    } catch(err) {
      if (fetchAllBlocker.cancel) {
        fetchAllBlocker = undefined;
        client.postMessage({
          type: 'canceled',
          message: `Fetching mbtiles of ${setting.mapID} is canceled`,
          mapID: setting.mapID,
          method: 'mbtiles'
        });
      } else {
        fetchAllBlocker = undefined;
        client.postMessage({
          type: 'stop',
          message: `Fetching stopped: ${setting.mapID}`,
          reason: err,
          mapID: setting.mapID,
          method: 'mbtiles'
        });
      }
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
          if (query.enableMbtiles) {
            sqlLoader = async function() {
              return createSqlWasm({ wasmUrl: "./sqlite3.wasm" }).then((sql_) => {
                sql = sql_;
                return sql;
              }).catch(() => {});
            };
          }
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
                if (!retVal) {
                  const lng2MercX = (lng) => { return 6378137 * lng * Math.PI / 180 };
                  const lat2MercY = (lat) => { return 6378137 * Math.log(Math.tan(Math.PI / 360 * (90 + lat))) };
                  if (query.maxZoom) query.maxZoom = parseInt(query.maxZoom);
                  if (query.minZoom) query.minZoom = parseInt(query.minZoom);
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
            if (!checkAttributes(query, ['maxX', 'minX', 'maxY', 'minY', 'minZoom', 'maxZoom'])) {
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
          if (fetchAllBlocker && fetchAllBlocker.mapID === query.mapID) {
            retVal = `Error: ${query.mapID} is under fetching process. Please cancel it first`;
          } else if (!retVal) {
            const cacheDB = await getDB(`Weiwudi_${query.mapID}`);
            await cleanDB(cacheDB, 'tileCache');
            retVal = `Cleaned: ${query.mapID}`;
          }
          break;
        case 'delete':
          retVal = checkAttributes(query, ['mapID']);
          if (fetchAllBlocker && fetchAllBlocker.mapID === query.mapID) {
            retVal = `Error: ${query.mapID} is under fetching process. Please cancel it first`;
          } else if (!retVal) {
            await deleteDB(`Weiwudi_${query.mapID}`);
            const db = await getDB('Weiwudi');
            await deleteItem(db, 'mapSetting', query.mapID);
            retVal = `Deleted: ${query.mapID}`;
          }
          break;
        case 'cancel':
          retVal = checkAttributes(query, ['mapID']);
          if (fetchAllBlocker && fetchAllBlocker.mapID === query.mapID) {
            fetchAllBlocker.cancel = true;
            if (fetchAllBlocker.controller) {
              fetchAllBlocker.controller.abort();
            }
            retVal = `Fetching process of ${fetchAllBlocker.mapID} is canceled`;
          } else {
            retVal = `Error: There are no fetching process of ${query.mapID}`;
          }
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
          const matched = restPath.match(/^([^\/]+)\/(\d+)\/(\d+)\/(\d+)$/);
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
                  error: 0,
                  type: setting.mbtiles ? 'bytes' : 'tiles'
                };
                if (setting.mbtiles && sql) fetchMbtiles(client, setting);
                else fetchAll(client, setting);
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

  registerRoute(/^https?:\/\/weiwudi.example.com/, handlerCb, 'GET');
}