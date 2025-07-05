import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { migrateFromV0 } from '../../src/cache-v1/migration';

describe('Migration from v0 to v1', { timeout: 30000 }, () => {
  const v0DbName = 'Weiwudi';
  const v1DbName = 'weiwudi-v1';

  beforeEach(async () => {
    // クリーンアップ
    await deleteDatabase(v0DbName);
    await deleteDatabase(v1DbName);
  }, 30000);

  afterEach(async () => {
    // クリーンアップ
    await deleteDatabase(v0DbName);
    await deleteDatabase(v1DbName);
  }, 30000);

  async function deleteDatabase(name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function createV0Database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(v0DbName, 1);
      
      request.onerror = () => reject(request.error || new Error('Request error'));
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // v0のストア構造を作成
        if (!db.objectStoreNames.contains('mapSetting')) {
          db.createObjectStore('mapSetting');
        }
      };
      
      request.onsuccess = () => resolve(request.result);
    });
  }

  async function populateV0Data(db: IDBDatabase): Promise<void> {
    const tx = db.transaction(['mapSetting'], 'readwrite');
    
    // mapSetting データ
    const mapStore = tx.objectStore('mapSetting');
    await new Promise<void>((resolve, reject) => {
      const req = mapStore.put({
        mapID: 'osm-raster',
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        type: 'raster',
        tileSize: 256,
        minZoom: 0,
        maxZoom: 19,
        minX: 0,
        maxX: 1,
        minY: 0,
        maxY: 1,
        totalTile: 1
      }, 'osm-raster');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    await new Promise<void>((resolve, reject) => {
      const req = mapStore.put({
        mapID: 'mapbox-streets',
        url: 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/{z}/{x}/{y}.mvt',
        type: 'wmts',
        tileSize: 512,
        minZoom: 0,
        maxZoom: 22,
        minLng: -180,
        maxLng: 180,
        minLat: -85,
        maxLat: 85,
        minX: 0,
        maxX: 1,
        minY: 0,
        maxY: 1,
        totalTile: 1
      }, 'mapbox-streets');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    
    // 各マップの個別DBにタイルを追加
    await createMapTileDatabase('osm-raster');
    await createMapTileDatabase('mapbox-streets');
  }
  
  async function createMapTileDatabase(mapId: string): Promise<void> {
    const dbName = `Weiwudi_${mapId}`;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('tileCache')) {
          db.createObjectStore('tileCache');
        }
      };
      
      request.onsuccess = async () => {
        const db = request.result;
        const tx = db.transaction(['tileCache'], 'readwrite');
        const store = tx.objectStore('tileCache');
        
        const tileData = mapId === 'osm-raster' 
          ? new Blob(['fake tile data'], { type: 'image/png' })
          : new Blob(['fake mvt data'], { type: 'application/vnd.mapbox-vector-tile' });
        
        await new Promise<void>((resolve, reject) => {
          const req = store.put({
            z_x_y: '10_512_340',
            blob: tileData,
            headers: {
              'content-type': mapId === 'osm-raster' ? 'image/png' : 'application/vnd.mapbox-vector-tile'
            },
            epoch: Date.now()
          }, '10_512_340');
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
        
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error || new Error('Transaction error'));
        });
        resolve();
      };
      
      request.onerror = () => reject(request.error || new Error('Request error'));
    });
  }

  async function getV1Database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(v1DbName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Request error'));
    });
  }

  it('should migrate v0 data to v1 format', async () => {
    // v0データベースを作成
    const v0Db = await createV0Database();
    await populateV0Data(v0Db);
    v0Db.close();

    // マイグレーション実行
    const migrated = await migrateFromV0();
    expect(migrated).toBe(true);

    // v1データベースを確認
    const v1Db = await getV1Database();
    const tx = v1Db.transaction(['resources', 'cache', 'settings'], 'readonly');

    // リソースの確認
    const resourcesStore = tx.objectStore('resources');
    const resources = await new Promise<any[]>((resolve, reject) => {
      const req = resourcesStore.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    expect(resources).toHaveLength(2); // 2つのタイルセット
    
    // ラスタータイルリソースの確認
    const rasterResource = resources.find(r => r.url.includes('openstreetmap.org'));
    expect(rasterResource).toBeDefined();
    expect(rasterResource.type).toBe('tile');
    expect(rasterResource.urlTemplate).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');

    // ベクタータイルリソースの確認
    const vectorResource = resources.find(r => r.url.includes('mapbox.mapbox-streets-v8'));
    expect(vectorResource).toBeDefined();
    expect(vectorResource.type).toBe('tile');

    // キャッシュエントリの確認
    const cacheStore = tx.objectStore('cache');
    const cacheEntries = await new Promise<any[]>((resolve, reject) => {
      const req = cacheStore.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    expect(cacheEntries).toHaveLength(2); // 2つのタイル

    // v0では設定はmapSettingに含まれるため、v1では設定なし

    v1Db.close();

    // v0データベースが削除されていることを確認
    const v0Exists = await new Promise<boolean>((resolve) => {
      const req = indexedDB.open(v0DbName);
      req.onsuccess = () => {
        const db = req.result;
        const exists = db.objectStoreNames.contains('mapSetting');
        db.close();
        // データベースが削除されていれば、新規作成時にオブジェクトストアは存在しない
        resolve(exists);
      };
      req.onerror = () => resolve(false);
    });

    expect(v0Exists).toBe(false);
    
    // 個別マップデータベースも削除されていることを確認
    for (const mapId of ['osm-raster', 'mapbox-streets']) {
      const mapDbExists = await new Promise<boolean>((resolve) => {
        const req = indexedDB.open(`Weiwudi_${mapId}`);
        req.onsuccess = () => {
          const db = req.result;
          const exists = db.objectStoreNames.contains('tileCache');
          db.close();
          resolve(exists);
        };
        req.onerror = () => resolve(false);
      });
      expect(mapDbExists).toBe(false);
    }
  });

  it('should handle empty v0 database', async () => {
    // 空のv0データベースを作成
    const v0Db = await createV0Database();
    v0Db.close();

    // マイグレーション実行
    const migrated = await migrateFromV0();
    expect(migrated).toBe(false); // データがないのでマイグレーション不要

    // v0データベースが削除されていることを確認
    const v0Exists = await new Promise<boolean>((resolve) => {
      const req = indexedDB.open(v0DbName);
      req.onsuccess = () => {
        req.result.close();
        resolve(true);
      };
      req.onerror = () => resolve(false);
    });

    expect(v0Exists).toBe(false);
  });

  it('should handle missing v0 database', async () => {
    // v0データベースが存在しない状態でマイグレーション実行
    const migrated = await migrateFromV0();
    expect(migrated).toBe(false);
  });

  it('should handle v0 database with partial data', async () => {
    // 部分的なデータのみを持つv0データベースを作成
    const v0Db = await createV0Database();
    
    const tx = v0Db.transaction(['mapSetting'], 'readwrite');
    const mapStore = tx.objectStore('mapSetting');
    
    await new Promise<void>((resolve, reject) => {
      const req = mapStore.put({
        mapID: 'partial-tileset',
        url: 'https://example.com/{z}/{x}/{y}.png',
        type: 'raster',
        tileSize: 256,
        minZoom: 0,
        maxZoom: 18,
        minX: 0,
        maxX: 1,
        minY: 0,
        maxY: 1,
        totalTile: 1
      }, 'partial-tileset');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    v0Db.close();

    // マイグレーション実行
    const migrated = await migrateFromV0();
    expect(migrated).toBe(true);

    // v1データベースを確認
    const v1Db = await getV1Database();
    const v1Tx = v1Db.transaction(['resources'], 'readonly');
    const resourcesStore = v1Tx.objectStore('resources');
    
    const resources = await new Promise<any[]>((resolve, reject) => {
      const req = resourcesStore.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    expect(resources).toHaveLength(1);
    expect(resources[0].url).toBe('https://example.com/{z}/{x}/{y}.png');
    expect(resources[0].type).toBe('tile');

    v1Db.close();
  });
});