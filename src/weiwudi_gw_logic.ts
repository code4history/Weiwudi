/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import type { RouteHandler, RouteMatchCallback } from "workbox-routing";

interface MapSetting {
  type: 'xyz' | 'wmts';
  url: string | string[];
  width?: number;
  height?: number;
  tileSize?: number;
  minZoom: number;
  maxZoom: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface CachedTile {
  z_x_y: string;
  headers: { [key: string]: string };
  blob: Blob;
  epoch: number;
}

interface CachedAsset {
  assetType: string;
  headers: { [key: string]: string };
  blob: Blob;
  epoch: number;
}

interface FetchAllBlocker {
  cancel: boolean;
  error: number;
  success: number;
  total: number;
}

const MERC_MAX = 20037508.342789244;
const dbCache: { [key: string]: IDBDatabase } = {};
let fetchAllBlocker: FetchAllBlocker | undefined;
const CACHE_DURATION = 86400000; // 24 hours
const QUOTA_LIMIT = 500 * 1024 * 1024; // 500MB default quota

function extractTemplate(template: string, z: number, x: number, y: number): string {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{-y}', String(Math.pow(2, z) - y - 1));
}

function b64toBlob(b64Data: string, contentType = '', sliceSize = 512): Blob {
  const byteCharacters = atob(b64Data);
  const byteArrays: Uint8Array[] = [];

  for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
    const slice = byteCharacters.slice(offset, offset + sliceSize);

    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }

    const byteArray = new Uint8Array(byteNumbers);
    byteArrays.push(byteArray);
  }

  return new Blob(byteArrays, { type: contentType });
}

async function getDB(dbname: string, table?: string, key?: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      if (dbCache[dbname]) {
        resolve(dbCache[dbname]);
      } else {
        const openDB = indexedDB.open(dbname, 2); // Version 2 for new tables
        openDB.onupgradeneeded = function (event) {
          const db = (event.target as IDBOpenDBRequest).result;
          
          // Create tile cache table
          if (!db.objectStoreNames.contains('tileCache')) {
            db.createObjectStore('tileCache', { keyPath: 'z_x_y' });
          }
          
          // Create map settings table
          if (!db.objectStoreNames.contains('mapSetting')) {
            db.createObjectStore('mapSetting', { keyPath: 'mapID' });
          }
          
          // Create asset cache table for vector tile assets
          if (!db.objectStoreNames.contains('assetCache')) {
            db.createObjectStore('assetCache', { keyPath: 'assetType' });
          }
        };
        openDB.onsuccess = function (event) {
          const db = (event.target as IDBOpenDBRequest).result;
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
}

async function deleteDB(dbname: string): Promise<void> {
  if (dbCache[dbname]) {
    const db = dbCache[dbname];
    db.close();
    delete dbCache[dbname];
  }
  return new Promise((resolve, reject) => {
    try {
      const deleteReq = indexedDB.deleteDatabase(dbname);
      deleteReq.onsuccess = () => resolve();
      deleteReq.onerror = () => reject(deleteReq.error);
    } catch (e) {
      reject(e);
    }
  });
}

async function cleanDB(db: IDBDatabase, table: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([table], 'readwrite');
    const store = tx.objectStore(table);
    const clearReq = store.clear();
    
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function countDB(db: IDBDatabase, table: string): Promise<{ count: number; size: number }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([table], 'readonly');
    const store = tx.objectStore(table);
    const cursorReq = store.openCursor();
    let count = 0;
    let size = 0;
    
    cursorReq.onsuccess = function () {
      const cursor = cursorReq.result;
      if (cursor) {
        count++;
        if (cursor.value.blob) {
          size += cursor.value.blob.size;
        }
        cursor.continue();
      }
    };
    
    tx.oncomplete = () => resolve({ count, size });
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function getItem<T>(db: IDBDatabase, table: string, key: string, dry?: boolean): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([table], 'readonly');
    const store = tx.objectStore(table);
    const getReq = dry ? store.getKey(key) : store.get(key);
    
    tx.oncomplete = () => resolve(getReq.result as T);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function putItem(db: IDBDatabase, table: string, item: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([table], 'readwrite');
    const store = tx.objectStore(table);
    const putReq = store.put(item);
    
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteItem(db: IDBDatabase, table: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([table], 'readwrite');
    const store = tx.objectStore(table);
    const delReq = store.delete(key);
    
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllKeys(db: IDBDatabase, table: string): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([table], 'readonly');
    const store = tx.objectStore(table);
    const getReq = store.getAllKeys();
    
    tx.oncomplete = () => resolve(getReq.result);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

// Check storage quota
async function checkQuota(): Promise<{ usage: number; quota: number; available: boolean }> {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage || 0;
    const quota = estimate.quota || QUOTA_LIMIT;
    return {
      usage,
      quota,
      available: usage < quota * 0.9 // Leave 10% buffer
    };
  }
  return { usage: 0, quota: QUOTA_LIMIT, available: true };
}

async function getImage(mapID: string, z: number, x: number, y: number, noOutput?: boolean): Promise<Response | string> {
  let outExtent: string | undefined;
  const db = await getDB('Weiwudi');
  const setting = await getItem<MapSetting>(db, 'mapSetting', mapID);
  
  if (!noOutput) {
    if (!setting) return `Error: MapID "${mapID}" not found`;
    if (z < setting.minZoom || z > setting.maxZoom) {
      outExtent = 'zoom';
    } else {
      const minXatZ = Math.floor(setting.minX / Math.pow(2, setting.maxZoom - z));
      const maxXatZ = Math.floor(setting.maxX / Math.pow(2, setting.maxZoom - z));
      const minYatZ = Math.floor(setting.minY / Math.pow(2, setting.maxZoom - z));
      const maxYatZ = Math.floor(setting.maxY / Math.pow(2, setting.maxZoom - z));
      if (x < minXatZ || x > maxXatZ || y < minYatZ || y > maxYatZ) {
        outExtent = 'extent';
      }
    }
  }
  
  let headers: { [key: string]: string } = {};
  let blob: Blob;
  let status = 200;
  let statusText = 'OK';
  
  if (outExtent) {
    if (outExtent === 'zoom') {
      status = 404;
      statusText = 'Not Found';
    } else {
      // Return transparent tile
      headers = { 'content-type': 'image/png' };
      blob = b64toBlob(
        'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAMAAABrrFhUAAAAB3RJTUUH3QgIBToaSbAjlwAAABd0' +
        'RVh0U29mdHdhcmUAR0xEUE5HIHZlciAzLjRxhaThAAAACHRwTkdHTEQzAAAAAEqAKR8AAAAEZ0FN' +
        'QQAAsY8L/GEFAAAAA1BMVEX///+nxBvIAAAAAXRSTlMAQObYZgAAAFRJREFUeNrtwQEBAAAAgJD+' +
        'r+4ICgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAABgBDwABHHIJwwAAAABJRU5ErkJggg==',
        headers['content-type']
      );
    }
  } else {
    const cacheDB = await getDB(`Weiwudi_${mapID}`);
    const cached = await getItem<CachedTile>(cacheDB, 'tileCache', `${z}_${x}_${y}`, noOutput);
    const nowEpoch = new Date().getTime();
    
    if (!cached || !cached.epoch || nowEpoch - cached.epoch > CACHE_DURATION) {
      // Check quota before fetching
      const quotaInfo = await checkQuota();
      if (!quotaInfo.available) {
        if (cached) {
          headers = cached.headers;
          blob = cached.blob;
        } else {
          return new Response('Storage quota exceeded', { status: 507, statusText: 'Insufficient Storage' });
        }
      } else {
        const template = setting!.url instanceof Array ?
          setting!.url[Math.floor(Math.random() * setting!.url.length)] :
          setting!.url;
        const url = extractTemplate(template, z, x, y);
        
        try {
          const resp = await fetch(url);
          if (resp.ok) {
            headers = Object.fromEntries([...resp.headers.entries()]);
            blob = await resp.blob();
            
            await putItem(cacheDB, 'tileCache', {
              z_x_y: `${z}_${x}_${y}`,
              headers,
              blob,
              epoch: nowEpoch
            });
          } else {
            if (cached) {
              headers = cached.headers;
              blob = cached.blob;
            } else {
              status = resp.status;
              statusText = resp.statusText;
              headers = Object.fromEntries([...resp.headers.entries()]);
              blob = await resp.blob();
            }
            if (fetchAllBlocker) fetchAllBlocker.error++;
          }
        } catch (e) {
          if (cached) {
            headers = cached.headers;
            blob = cached.blob;
          } else {
            return new Response('Network error', { status: 503, statusText: 'Service Unavailable' });
          }
          if (fetchAllBlocker) fetchAllBlocker.error++;
        }
      }
    } else {
      headers = cached.headers;
      blob = cached.blob;
    }
  }
  
  if (fetchAllBlocker) {
    fetchAllBlocker.success++;
    if (self.clients) {
      const client = await self.clients.get(fetchAllBlocker.clientId);
      if (client) {
        client.postMessage({
          mapID,
          type: 'progress',
          success: fetchAllBlocker.success,
          error: fetchAllBlocker.error,
          total: fetchAllBlocker.total
        });
      }
    }
  }
  
  return new Response(blob!, { status, statusText, headers });
}

async function getAsset(mapID: string, assetType: string): Promise<Response> {
  const db = await getDB('Weiwudi');
  const setting = await getItem<MapSetting>(db, 'mapSetting', mapID);
  
  if (!setting) {
    return new Response(`Error: MapID "${mapID}" not found`, { status: 404 });
  }
  
  const cacheDB = await getDB(`Weiwudi_${mapID}`);
  const cached = await getItem<CachedAsset>(cacheDB, 'assetCache', assetType);
  const nowEpoch = new Date().getTime();
  
  if (!cached || !cached.epoch || nowEpoch - cached.epoch > CACHE_DURATION) {
    // Fetch from registered URL
    const assetUrl = (setting as any)[assetType];
    if (!assetUrl) {
      return new Response(`Asset type "${assetType}" not registered`, { status: 404 });
    }
    
    try {
      const resp = await fetch(assetUrl);
      if (resp.ok) {
        const headers = Object.fromEntries([...resp.headers.entries()]);
        let blob = await resp.blob();
        
        // Process definition file to replace URLs
        if (assetType === 'definition') {
          const text = await blob.text();
          const processed = processDefinition(text, mapID);
          blob = new Blob([processed], { type: 'application/json' });
        }
        
        await putItem(cacheDB, 'assetCache', {
          assetType,
          headers,
          blob,
          epoch: nowEpoch
        });
        
        return new Response(blob, { headers });
      } else {
        if (cached) {
          return new Response(cached.blob, { headers: cached.headers });
        }
        return new Response(await resp.blob(), { 
          status: resp.status, 
          statusText: resp.statusText,
          headers: Object.fromEntries([...resp.headers.entries()])
        });
      }
    } catch (e) {
      if (cached) {
        return new Response(cached.blob, { headers: cached.headers });
      }
      return new Response('Network error', { status: 503 });
    }
  } else {
    return new Response(cached.blob, { headers: cached.headers });
  }
}

function processDefinition(definition: string, mapID: string): string {
  try {
    const def = JSON.parse(definition);
    
    // Replace tile URL templates
    if (def.tiles) {
      def.tiles = def.tiles.map((url: string) => 
        `https://weiwudi.example.com/api/cache/${mapID}/{z}/{x}/{y}`
      );
    }
    
    // Replace other asset URLs
    if (def.glyphs) {
      def.glyphs = `https://weiwudi.example.com/api/cache/${mapID}/fonts`;
    }
    if (def.sprite) {
      def.sprite = `https://weiwudi.example.com/api/cache/${mapID}/icons`;
    }
    
    return JSON.stringify(def);
  } catch (e) {
    return definition; // Return as-is if not JSON
  }
}

// Calculate tiles in range for WMTS
function calculateTilesInRange(setting: MapSetting, range: any): Array<[number, number, number]> {
  const tiles: Array<[number, number, number]> = [];
  
  for (let z = range.minZoom; z <= range.maxZoom; z++) {
    const scale = Math.pow(2, z);
    
    // Convert lat/lng to tile coordinates
    const minX = Math.floor((range.minLng + 180) / 360 * scale);
    const maxX = Math.floor((range.maxLng + 180) / 360 * scale);
    const minY = Math.floor((1 - Math.log(Math.tan(range.maxLat * Math.PI / 180) + 
      1 / Math.cos(range.maxLat * Math.PI / 180)) / Math.PI) / 2 * scale);
    const maxY = Math.floor((1 - Math.log(Math.tan(range.minLat * Math.PI / 180) + 
      1 / Math.cos(range.minLat * Math.PI / 180)) / Math.PI) / 2 * scale);
    
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        tiles.push([z, x, y]);
      }
    }
  }
  
  return tiles;
}

async function apiFunc(apiName: string, query: any, restPath?: string, client?: Client): Promise<Response | string | null> {
  const mapID = query.mapID;
  
  switch (apiName) {
    case 'ping':
      return 'pong';
      
    case 'add': {
      const db = await getDB('Weiwudi');
      const existing = await getItem<MapSetting>(db, 'mapSetting', mapID);
      if (existing) return 'Error: MapID already exists';
      
      const setting: MapSetting = {
        type: query.type || 'xyz',
        url: query.url,
        minZoom: parseInt(query.minZoom) || 0,
        maxZoom: parseInt(query.maxZoom) || 18,
        minX: 0,
        maxX: 0,
        minY: 0,
        maxY: 0
      };
      
      // Calculate bounds for WMTS
      if (setting.type === 'wmts') {
        const maxZ = setting.maxZoom;
        const scale = Math.pow(2, maxZ);
        
        setting.minX = Math.floor((parseFloat(query.minLng) + 180) / 360 * scale);
        setting.maxX = Math.floor((parseFloat(query.maxLng) + 180) / 360 * scale);
        setting.minY = Math.floor((1 - Math.log(Math.tan(parseFloat(query.maxLat) * Math.PI / 180) + 
          1 / Math.cos(parseFloat(query.maxLat) * Math.PI / 180)) / Math.PI) / 2 * scale);
        setting.maxY = Math.floor((1 - Math.log(Math.tan(parseFloat(query.minLat) * Math.PI / 180) + 
          1 / Math.cos(parseFloat(query.minLat) * Math.PI / 180)) / Math.PI) / 2 * scale);
      } else {
        // XYZ tiles
        setting.width = parseInt(query.width);
        setting.height = parseInt(query.height);
        setting.tileSize = parseInt(query.tileSize) || 256;
        
        const maxZ = setting.maxZoom;
        setting.maxX = Math.ceil(setting.width! / setting.tileSize!) - 1;
        setting.maxY = Math.ceil(setting.height! / setting.tileSize!) - 1;
        
        for (let z = maxZ - 1; z >= setting.minZoom; z--) {
          setting.maxX = Math.ceil((setting.maxX + 1) / 2) - 1;
          setting.maxY = Math.ceil((setting.maxY + 1) / 2) - 1;
        }
        
        setting.minX = 0;
        setting.minY = 0;
        setting.maxX = setting.maxX * Math.pow(2, maxZ - setting.minZoom);
        setting.maxY = setting.maxY * Math.pow(2, maxZ - setting.minZoom);
      }
      
      await putItem(db, 'mapSetting', { mapID, ...setting });
      await getDB(`Weiwudi_${mapID}`);
      
      return JSON.stringify(setting);
    }
    
    case 'info': {
      const db = await getDB('Weiwudi');
      const setting = await getItem<MapSetting>(db, 'mapSetting', mapID);
      if (!setting) return 'Error: MapID not found';
      return JSON.stringify(setting);
    }
    
    case 'delete': {
      const db = await getDB('Weiwudi');
      await deleteItem(db, 'mapSetting', mapID);
      await deleteDB(`Weiwudi_${mapID}`);
      return 'OK';
    }
    
    case 'stats': {
      const cacheDB = await getDB(`Weiwudi_${mapID}`);
      const tileStat = await countDB(cacheDB, 'tileCache');
      const assetStat = await countDB(cacheDB, 'assetCache');
      
      return JSON.stringify({
        count: tileStat.count + assetStat.count,
        size: tileStat.size + assetStat.size,
        tiles: tileStat,
        assets: assetStat
      });
    }
    
    case 'clean': {
      const cacheDB = await getDB(`Weiwudi_${mapID}`);
      
      if (query.minZoom) {
        // Range-based cleaning for WMTS only
        const db = await getDB('Weiwudi');
        const setting = await getItem<MapSetting>(db, 'mapSetting', mapID);
        if (!setting || setting.type !== 'wmts') {
          return 'Error: Range cleaning only supported for WMTS';
        }
        
        const tiles = calculateTilesInRange(setting, query);
        for (const [z, x, y] of tiles) {
          await deleteItem(cacheDB, 'tileCache', `${z}_${x}_${y}`);
        }
      } else {
        // Full clean
        await cleanDB(cacheDB, 'tileCache');
        await cleanDB(cacheDB, 'assetCache');
      }
      
      return 'OK';
    }
    
    case 'fetchAll': {
      if (fetchAllBlocker) return 'Error: FetchAll already running';
      
      const db = await getDB('Weiwudi');
      const setting = await getItem<MapSetting>(db, 'mapSetting', mapID);
      if (!setting) return 'Error: MapID not found';
      
      let tiles: Array<[number, number, number]>;
      
      if (query.minZoom) {
        // Range-based fetching
        if (setting.type !== 'wmts') {
          return 'Error: Range fetching only supported for WMTS';
        }
        tiles = calculateTilesInRange(setting, query);
      } else {
        // Full fetch (only for XYZ)
        if (setting.type === 'wmts') {
          return 'Error: Full fetch not supported for WMTS. Please specify a range.';
        }
        
        tiles = [];
        for (let z = setting.minZoom; z <= setting.maxZoom; z++) {
          const scale = Math.pow(2, setting.maxZoom - z);
          const minX = Math.floor(setting.minX / scale);
          const maxX = Math.floor(setting.maxX / scale);
          const minY = Math.floor(setting.minY / scale);
          const maxY = Math.floor(setting.maxY / scale);
          
          for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
              tiles.push([z, x, y]);
            }
          }
        }
      }
      
      fetchAllBlocker = {
        cancel: false,
        error: 0,
        success: 0,
        total: tiles.length,
        clientId: client?.id || ''
      };
      
      // Fetch tiles asynchronously
      (async () => {
        for (const [z, x, y] of tiles) {
          if (fetchAllBlocker.cancel) break;
          await getImage(mapID, z, x, y, true);
        }
        
        if (client) {
          client.postMessage({
            mapID,
            type: 'finished',
            success: fetchAllBlocker.success,
            error: fetchAllBlocker.error,
            total: fetchAllBlocker.total
          });
        }
        
        fetchAllBlocker = undefined;
      })();
      
      return 'OK';
    }
    
    case 'cancel': {
      if (fetchAllBlocker) {
        fetchAllBlocker.cancel = true;
      }
      return 'OK';
    }
    
    case 'registerAssets': {
      const db = await getDB('Weiwudi');
      const setting = await getItem<MapSetting>(db, 'mapSetting', mapID);
      if (!setting) return 'Error: MapID not found';
      
      // Store asset URLs in settings
      const updates: any = { mapID };
      if (query.definition) updates.definition = query.definition;
      if (query.styles) updates.styles = query.styles;
      if (query.fonts) updates.fonts = query.fonts;
      if (query.icons) updates.icons = query.icons;
      
      await putItem(db, 'mapSetting', { ...setting, ...updates });
      
      // Auto-fetch definition if provided
      if (query.definition) {
        await getAsset(mapID, 'definition');
      }
      
      return 'OK';
    }
    
    case 'cache': {
      if (!restPath) return null;
      
      const parts = restPath.split('/');
      const mapID = parts[0];
      
      if (parts.length === 4) {
        // Tile request: cache/{mapID}/{z}/{x}/{y}
        const z = parseInt(parts[1]);
        const x = parseInt(parts[2]);
        const y = parseInt(parts[3]);
        return await getImage(mapID, z, x, y);
      } else if (parts.length === 2) {
        // Asset request: cache/{mapID}/{assetType}
        const assetType = parts[1];
        return await getAsset(mapID, assetType);
      }
      
      return null;
    }
    
    default:
      return null;
  }
}

export function Weiwudi_Internal(registerRoute: (match: RouteMatchCallback, handler: RouteHandler) => void): void {
  const handlerCb: RouteHandler = async ({ url, request, event }) => {
    const client = (event as FetchEvent).clientId 
      ? await self.clients.get((event as FetchEvent).clientId) 
      : undefined;
      
    const matched = url.pathname.match(/^\/api\/([\w\d]+)(?:\/(.+))?$/);
    if (matched) {
      const query = Object.fromEntries(
        [...url.searchParams.entries()].map(([key, _]) => {
          const values = url.searchParams.getAll(key);
          return [key, values.length === 1 ? values[0] : values];
        })
      );
      
      const apiName = matched[1];
      const restPath = matched[2];
      const res = await apiFunc(apiName, query, restPath, client);
      
      if (res) {
        if (!(res instanceof Response)) {
          return new Response(res);
        }
        return res;
      }
    }
    
    return new Response('Not Found', { status: 404 });
  };
  
  registerRoute(
    ({ url }) => url.pathname.startsWith('/api/'),
    handlerCb
  );
}