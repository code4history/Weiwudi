import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WeiwudiDatabase } from '../../src/cache-v1/database';
import { Resource, CacheEntry } from '../../src/cache-v1/types';

describe('WeiwudiDatabase', () => {
  let db: WeiwudiDatabase;

  beforeEach(async () => {
    db = new WeiwudiDatabase();
    await db.open();
  });

  afterEach(async () => {
    await db.clear();
    await db.close();
  });

  describe('Resource operations', () => {
    it('should save and retrieve a resource', async () => {
      const resource: Resource = {
        url: 'https://example.com/style.json',
        type: 'style',
        lastAccessed: Date.now(),
        size: 1024
      };

      await db.saveResource(resource);
      const retrieved = await db.getResource(resource.url);

      expect(retrieved).toEqual(resource);
    });

    it('should delete a resource', async () => {
      const resource: Resource = {
        url: 'https://example.com/style.json',
        type: 'style',
        lastAccessed: Date.now(),
        size: 1024
      };

      await db.saveResource(resource);
      await db.deleteResource(resource.url);
      const retrieved = await db.getResource(resource.url);

      expect(retrieved).toBeUndefined();
    });

    it('should get resources by type', async () => {
      const resources: Resource[] = [
        {
          url: 'https://example.com/style1.json',
          type: 'style',
          lastAccessed: Date.now(),
          size: 1024
        },
        {
          url: 'https://example.com/style2.json',
          type: 'style',
          lastAccessed: Date.now(),
          size: 2048
        },
        {
          url: 'https://example.com/tiles/{z}/{x}/{y}',
          type: 'tile',
          urlTemplate: 'https://example.com/tiles/{z}/{x}/{y}',
          lastAccessed: Date.now(),
          size: 0
        }
      ];

      for (const resource of resources) {
        await db.saveResource(resource);
      }

      const styles = await db.getResourcesByType('style');
      expect(styles).toHaveLength(2);
      expect(styles.every(r => r.type === 'style')).toBe(true);
    });
  });

  describe('Cache operations', () => {
    it('should save and retrieve a cache entry', async () => {
      const entry: CacheEntry = {
        url: 'https://example.com/tiles/10/512/340',
        resourceUrl: 'https://example.com/tiles/{z}/{x}/{y}',
        data: new Blob(['test data']),
        headers: { 'content-type': 'image/png' },
        created: Date.now(),
        size: 9
      };

      await db.saveCacheEntry(entry);
      const retrieved = await db.getCacheEntry(entry.url);

      expect(retrieved).toBeDefined();
      expect(retrieved?.url).toBe(entry.url);
      expect(retrieved?.resourceUrl).toBe(entry.resourceUrl);
    });

    it('should get cache entries by resource', async () => {
      const resourceUrl = 'https://example.com/tiles/{z}/{x}/{y}';
      const entries: CacheEntry[] = [
        {
          url: 'https://example.com/tiles/10/512/340',
          resourceUrl,
          data: new Blob(['tile1']),
          headers: {},
          created: Date.now(),
          size: 5
        },
        {
          url: 'https://example.com/tiles/10/512/341',
          resourceUrl,
          data: new Blob(['tile2']),
          headers: {},
          created: Date.now(),
          size: 5
        }
      ];

      for (const entry of entries) {
        await db.saveCacheEntry(entry);
      }

      const retrieved = await db.getCacheEntriesByResource(resourceUrl);
      expect(retrieved).toHaveLength(2);
    });
  });

  describe('Settings operations', () => {
    it('should save and retrieve settings', async () => {
      await db.saveSetting('quotaLimit', 1024 * 1024 * 1024);
      const value = await db.getSetting('quotaLimit');
      expect(value).toBe(1024 * 1024 * 1024);
    });

    it('should return undefined for non-existent settings', async () => {
      const value = await db.getSetting('nonexistent');
      expect(value).toBeUndefined();
    });
  });

  describe('Utility operations', () => {
    it('should calculate total cache size', async () => {
      const entries: CacheEntry[] = [
        {
          url: 'https://example.com/tile1',
          resourceUrl: 'https://example.com/tiles',
          data: new Blob(['data1']),
          headers: {},
          created: Date.now(),
          size: 100
        },
        {
          url: 'https://example.com/tile2',
          resourceUrl: 'https://example.com/tiles',
          data: new Blob(['data2']),
          headers: {},
          created: Date.now(),
          size: 200
        }
      ];

      for (const entry of entries) {
        await db.saveCacheEntry(entry);
      }

      const totalSize = await db.calculateTotalSize();
      expect(totalSize).toBe(300);
    });
  });
});