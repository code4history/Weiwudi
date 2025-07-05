/**
 * IndexedDB management for cache v1
 */

import { Resource, CacheEntry } from './types';

const DB_NAME = 'weiwudi-cache-v1';
const DB_VERSION = 1;

export class WeiwudiDatabase {
  private db: IDBDatabase | null = null;

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Resources table
        if (!db.objectStoreNames.contains('resources')) {
          const resourceStore = db.createObjectStore('resources', { keyPath: 'url' });
          resourceStore.createIndex('type', 'type', { unique: false });
          resourceStore.createIndex('lastAccessed', 'lastAccessed', { unique: false });
        }

        // Cache table
        if (!db.objectStoreNames.contains('cache')) {
          const cacheStore = db.createObjectStore('cache', { keyPath: 'url' });
          cacheStore.createIndex('resourceUrl', 'resourceUrl', { unique: false });
          cacheStore.createIndex('created', 'created', { unique: false });
        }

        // Settings table
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
    });
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // Resource operations
  async getResource(url: string): Promise<Resource | undefined> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['resources'], 'readonly');
    const store = tx.objectStore('resources');
    const request = store.get(url);
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async saveResource(resource: Resource): Promise<void> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['resources'], 'readwrite');
    const store = tx.objectStore('resources');
    await store.put(resource);
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteResource(url: string): Promise<void> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['resources', 'cache'], 'readwrite');
    const resourceStore = tx.objectStore('resources');
    const cacheStore = tx.objectStore('cache');
    
    // Delete resource
    await resourceStore.delete(url);
    
    // Delete related cache entries
    const index = cacheStore.index('resourceUrl');
    const request = index.openCursor(IDBKeyRange.only(url));
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getResourcesByType(type: string): Promise<Resource[]> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['resources'], 'readonly');
    const store = tx.objectStore('resources');
    const index = store.index('type');
    const request = index.getAll(type);
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getResourcesSortedByLastAccess(): Promise<Resource[]> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['resources'], 'readonly');
    const store = tx.objectStore('resources');
    const index = store.index('lastAccessed');
    const request = index.openCursor();
    const resources: Resource[] = [];
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          resources.push(cursor.value);
          cursor.continue();
        } else {
          resolve(resources);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Cache operations
  async getCacheEntry(url: string): Promise<CacheEntry | undefined> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['cache'], 'readonly');
    const store = tx.objectStore('cache');
    const request = store.get(url);
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async saveCacheEntry(entry: CacheEntry): Promise<void> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['cache'], 'readwrite');
    const store = tx.objectStore('cache');
    await store.put(entry);
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteCacheEntry(url: string): Promise<void> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['cache'], 'readwrite');
    const store = tx.objectStore('cache');
    await store.delete(url);
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getCacheEntriesByResource(resourceUrl: string): Promise<CacheEntry[]> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['cache'], 'readonly');
    const store = tx.objectStore('cache');
    const index = store.index('resourceUrl');
    const request = index.getAll(resourceUrl);
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Settings operations
  async getSetting(key: string): Promise<any> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['settings'], 'readonly');
    const store = tx.objectStore('settings');
    const request = store.get(key);
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result?.value);
      request.onerror = () => reject(request.error);
    });
  }

  async saveSetting(key: string, value: any): Promise<void> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['settings'], 'readwrite');
    const store = tx.objectStore('settings');
    await store.put({ key, value });
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Utility operations
  async calculateTotalSize(): Promise<number> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['cache'], 'readonly');
    const store = tx.objectStore('cache');
    const request = store.openCursor();
    let totalSize = 0;
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          totalSize += cursor.value.size;
          cursor.continue();
        } else {
          resolve(totalSize);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async clear(): Promise<void> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['resources', 'cache', 'settings'], 'readwrite');
    const stores = ['resources', 'cache', 'settings'];
    
    for (const storeName of stores) {
      await tx.objectStore(storeName).clear();
    }
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllResources(): Promise<Resource[]> {
    if (!this.db) throw new Error('Database not open');
    
    const tx = this.db.transaction(['resources'], 'readonly');
    const store = tx.objectStore('resources');
    const request = store.getAll();
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}