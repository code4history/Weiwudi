/**
 * Migration from cache v0 to v1
 */

import { WeiwudiDatabase } from './database';
import { Resource, CacheEntry } from './types';

const V0_DB_NAME = 'Weiwudi';

interface V0MapSetting {
  mapID: string;
  type: 'xyz' | 'wmts';
  url: string | string[];
  tileSize: number;
  minZoom: number;
  maxZoom: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  totalTile: number;
  // xyzタイプの場合
  width?: number;
  height?: number;
  // wmtsタイプの場合  
  minLng?: number;
  maxLng?: number;
  minLat?: number;
  maxLat?: number;
}

interface V0CachedTile {
  z_x_y: string;
  blob: Blob;
  headers?: Record<string, string>;
  epoch?: number;
}

// v0ではアセットキャッシュは存在しない

export class WeiwudiMigration {
  private v1db: WeiwudiDatabase;

  constructor() {
    this.v1db = new WeiwudiDatabase();
  }

  async migrate(): Promise<boolean> {
    try {
      console.log('Starting Weiwudi v0 to v1 migration...');
      
      // Check if v0 database exists
      const v0db = await this.openV0Database();
      if (!v0db) {
        console.log('No v0 database found, skipping migration');
        await this.deleteV0Database();
        return false;
      }

      // Open v1 database
      await this.v1db.open();

      // Read v0 data
      const v0Maps = await this.readV0Maps(v0db);
      console.log(`Found ${v0Maps.length} maps`);

      // Convert and save to v1
      await this.convertMaps(v0Maps);
      
      // Convert tiles for each map
      for (const map of v0Maps) {
        const v0Tiles = await this.readV0Tiles(map.mapID);
        console.log(`Found ${v0Tiles.length} tiles for map ${map.mapID}`);
        await this.convertTiles(v0Tiles, map);
        
        // Delete individual map database
        await this.deleteMapDatabase(map.mapID);
      }

      // Close v0 database
      v0db.close();

      // Delete v0 database
      await this.deleteV0Database();

      console.log('Migration completed successfully');
      return true;
    } catch (error) {
      console.warn('Weiwudi v0 cache migration failed, cleaning up old data', error);
      // Delete v0 database even on failure
      await this.deleteV0Database().catch(() => {});
      // v1 starts fresh
      return false;
    } finally {
      await this.v1db.close();
    }
  }

  private async openV0Database(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      const request = indexedDB.open(V0_DB_NAME);
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onupgradeneeded = () => {
        // v0 database doesn't exist
        request.transaction?.abort();
        resolve(null);
      };
    });
  }

  private async readV0Maps(db: IDBDatabase): Promise<V0MapSetting[]> {
    if (!db.objectStoreNames.contains('mapSetting')) return [];
    
    const tx = db.transaction(['mapSetting'], 'readonly');
    const store = tx.objectStore('mapSetting');
    const keys = await this.getAllKeys(store);
    const results: V0MapSetting[] = [];
    
    for (const key of keys) {
      const value = await this.getValue(store, key);
      if (value) {
        results.push(value);
      }
    }
    
    return results;
  }

  private async readV0Tiles(mapId: string): Promise<V0CachedTile[]> {
    // 各マップのタイルは個別のDBに保存されている
    const dbName = `Weiwudi_${mapId}`;
    
    return new Promise((resolve) => {
      const request = indexedDB.open(dbName);
      
      request.onsuccess = async () => {
        const db = request.result;
        
        if (!db.objectStoreNames.contains('tileCache')) {
          db.close();
          resolve([]);
          return;
        }
        
        const tx = db.transaction(['tileCache'], 'readonly');
        const store = tx.objectStore('tileCache');
        const keys = await this.getAllKeys(store);
        const results: V0CachedTile[] = [];
        
        for (const key of keys) {
          const value = await this.getValue(store, key);
          if (value) {
            results.push(value);
          }
        }
        
        db.close();
        resolve(results);
      };
      
      request.onerror = () => resolve([]);
    });
  }

  // v0では設定はマップ設定に含まれるので、このメソッドは不要

  private async getAllKeys(store: IDBObjectStore): Promise<IDBValidKey[]> {
    return new Promise((resolve, reject) => {
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  private async getValue(store: IDBObjectStore, key: IDBValidKey): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async convertMaps(v0Maps: V0MapSetting[]): Promise<void> {
    for (const map of v0Maps) {
      // URLは配列の場合がある
      const urls = Array.isArray(map.url) ? map.url : [map.url];
      
      for (const url of urls) {
        const resource: Resource = {
          url: url,
          urlTemplate: url,
          type: 'tile',
          metadata: {
            bounds: map.minLng && map.maxLng && map.minLat && map.maxLat
              ? [map.minLng, map.minLat, map.maxLng, map.maxLat]
              : undefined,
            minzoom: map.minZoom,
            maxzoom: map.maxZoom
          },
          lastAccessed: Date.now(),
          size: 0,
          headers: {}
        };

        await this.v1db.saveResource(resource);
      }
    }
  }

  private async convertTiles(v0Tiles: V0CachedTile[], map: V0MapSetting): Promise<void> {
    for (const tile of v0Tiles) {
      // v0のキーは "z_x_y" 形式
      const parts = tile.z_x_y.split('_');
      if (parts.length !== 3) continue;

      const [z, x, y] = parts;

      // URLは配列の場合があるので、最初のURLを使用
      const templateUrl = Array.isArray(map.url) ? map.url[0] : map.url;
      
      // Expand tile URL
      const expandedUrl = this.expandTileUrl(templateUrl, z, x, y);

      const cacheEntry: CacheEntry = {
        url: expandedUrl,
        resourceUrl: templateUrl,
        data: tile.blob,
        headers: tile.headers || {},
        created: tile.epoch || Date.now(),
        size: tile.blob.size
      };

      await this.v1db.saveCacheEntry(cacheEntry);
    }
  }

  private async deleteMapDatabase(mapId: string): Promise<void> {
    const dbName = `Weiwudi_${mapId}`;
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }


  private expandTileUrl(template: string, z: string, x: string, y: string): string {
    return template
      .replace('{z}', z)
      .replace('{x}', x)
      .replace('{y}', y);
  }

  private async deleteV0Database(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(V0_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

/**
 * Convenience function to perform migration
 */
export async function migrateFromV0(): Promise<boolean> {
  const migration = new WeiwudiMigration();
  return migration.migrate();
}