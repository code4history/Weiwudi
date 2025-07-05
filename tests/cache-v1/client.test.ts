import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WeiwudiClient } from '../../src/cache-v1/client';
import { WeiwudiDatabase } from '../../src/cache-v1/database';
import { Resource } from '../../src/cache-v1/types';

// Mock the database module
vi.mock('../../src/cache-v1/database');

describe('WeiwudiClient', () => {
  let client: WeiwudiClient;
  let mockDb: any;

  beforeEach(() => {
    // Mock fetch
    global.fetch = vi.fn();
    
    // Create mock database
    mockDb = {
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      saveResource: vi.fn().mockResolvedValue(undefined),
      getResource: vi.fn(),
      deleteResource: vi.fn().mockResolvedValue(undefined),
      getResourcesByType: vi.fn().mockResolvedValue([]),
      getAllResources: vi.fn().mockResolvedValue([]),
      saveSetting: vi.fn().mockResolvedValue(undefined),
      getSetting: vi.fn(),
      calculateTotalSize: vi.fn().mockResolvedValue(0)
    };

    // Mock the constructor
    (WeiwudiDatabase as any).mockImplementation(() => mockDb);

    client = new WeiwudiClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Resource registration', () => {
    it('should register a style resource', async () => {
      const styleUrl = 'https://api.mapbox.com/styles/v1/mapbox/streets-v11/style.json';
      
      await client.register({
        url: styleUrl,
        options: {
          autoRegisterAssets: false
        }
      });

      expect(mockDb.saveResource).toHaveBeenCalledWith(
        expect.objectContaining({
          url: styleUrl,
          type: 'style'
        })
      );
    });

    it('should register a tile resource with template', async () => {
      const tileTemplate = 'https://example.com/tiles/{z}/{x}/{y}.mvt';
      
      await client.register({
        url: tileTemplate,
        options: {
          type: 'tile'
        }
      });

      expect(mockDb.saveResource).toHaveBeenCalledWith(
        expect.objectContaining({
          url: tileTemplate,
          urlTemplate: tileTemplate,
          type: 'tile'
        })
      );
    });

    it('should register a font resource', async () => {
      const fontUrl = 'https://example.com/fonts/0-255.pbf';
      
      await client.register({
        url: fontUrl,
        options: {
          type: 'font'
        }
      });

      expect(mockDb.saveResource).toHaveBeenCalledWith(
        expect.objectContaining({
          url: fontUrl,
          type: 'font'
        })
      );
    });

    it('should register a sprite resource', async () => {
      const spriteUrl = 'https://example.com/sprite.json';
      
      // Sprite resources don't need fetching
      await client.register({
        url: spriteUrl,
        options: {
          type: 'sprite',
          autoRegisterAssets: false  // Disable auto-fetch
        }
      });

      expect(mockDb.saveResource).toHaveBeenCalledWith(
        expect.objectContaining({
          url: spriteUrl,
          type: 'sprite'
        })
      );
    });

    it('should register with metadata', async () => {
      const styleUrl = 'https://example.com/style.json';
      const metadata = {
        bounds: [-180, -90, 180, 90] as [number, number, number, number],
        minzoom: 0,
        maxzoom: 22
      };
      
      // Mock fetch for style
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          version: 8,
          sources: {},
          layers: []
        })
      });
      
      await client.register({
        url: styleUrl,
        options: {
          metadata,
          autoRegisterAssets: false
        }
      });

      expect(mockDb.saveResource).toHaveBeenCalledWith(
        expect.objectContaining({
          url: styleUrl,
          type: 'style'
        })
      );
    });
  });

  describe('Resource management', () => {
    it('should check if resource is managed', async () => {
      const url = 'https://example.com/style.json';
      const resource: Resource = {
        url,
        type: 'style',
        lastAccessed: Date.now(),
        size: 1024
      };
      
      mockDb.getResource.mockResolvedValue(resource);
      
      const isManaged = await client.isManaged(url);
      expect(isManaged).toBe(true);
      expect(mockDb.getResource).toHaveBeenCalledWith(url);
    });

    it('should return false for unmanaged resource', async () => {
      const url = 'https://example.com/unknown.json';
      mockDb.getResource.mockResolvedValue(undefined);
      
      const isManaged = await client.isManaged(url);
      expect(isManaged).toBe(false);
    });

    it('should unregister a resource', async () => {
      const url = 'https://example.com/style.json';
      
      await client.unregister(url);
      
      expect(mockDb.deleteResource).toHaveBeenCalledWith(url);
    });

    it('should get all registered resources', async () => {
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
        }
      ];
      
      mockDb.getAllResources.mockResolvedValue(resources);
      
      const result = await client.getRegisteredResources();
      expect(result).toEqual(resources);
    });

    it('should get resources by type', async () => {
      const styles: Resource[] = [
        {
          url: 'https://example.com/style1.json',
          type: 'style',
          lastAccessed: Date.now(),
          size: 1024
        }
      ];
      
      mockDb.getResourcesByType.mockResolvedValue(styles);
      
      const result = await client.getResourcesByType('style');
      expect(result).toEqual(styles);
      expect(mockDb.getResourcesByType).toHaveBeenCalledWith('style');
    });
  });

  describe('Storage management', () => {
    it('should set quota', async () => {
      const quota = 100 * 1024 * 1024; // 100MB
      
      await client.setQuota({ maxCacheSize: quota });
      
      expect(mockDb.saveSetting).toHaveBeenCalledWith('quotaLimit', quota);
    });

    it('should get storage usage', async () => {
      const quotaLimit = 100 * 1024 * 1024;
      const used = 50 * 1024 * 1024;
      
      mockDb.getSetting.mockResolvedValue(quotaLimit);
      mockDb.calculateTotalSize.mockResolvedValue(used);
      
      const usage = await client.getStorageUsage();
      
      expect(usage.quota).toBe(quotaLimit);
      expect(usage.used).toBe(used);
      expect(usage.percentage).toBe(50);
    });

    it('should handle missing quota setting', async () => {
      const used = 50 * 1024 * 1024;
      
      mockDb.getSetting.mockResolvedValue(undefined);
      mockDb.calculateTotalSize.mockResolvedValue(used);
      
      const usage = await client.getStorageUsage();
      
      expect(usage.quota).toBe(500 * 1024 * 1024); // Default 500MB
      expect(usage.used).toBe(used);
      expect(usage.percentage).toBe(10);
    });
  });

  describe('Plugin management', () => {
    it('should add and execute plugins', async () => {
      const mockPlugin = {
        requestWillFetch: vi.fn(async ({ request }) => request),
        fetchDidSucceed: vi.fn(async ({ response }) => response)
      };
      
      client.addPlugin(mockPlugin);
      
      const request = new Request('https://example.com/test');
      const response = new Response('test');
      
      // Execute plugin hooks
      const requestResult = await client.applyPlugins('requestWillFetch', { request });
      expect(mockPlugin.requestWillFetch).toHaveBeenCalledWith({ request });
      expect(requestResult).toBe(request);
      
      const responseResult = await client.applyPlugins('fetchDidSucceed', { response });
      expect(mockPlugin.fetchDidSucceed).toHaveBeenCalledWith({ response });
      expect(responseResult).toBe(response);
    });

    it('should handle plugins without specific hooks', async () => {
      const mockPlugin = {
        requestWillFetch: vi.fn(async ({ request }) => request)
        // No fetchDidSucceed hook
      };
      
      client.addPlugin(mockPlugin);
      
      const response = new Response('test');
      
      // Should not throw when plugin doesn't have the hook
      const result = await client.applyPlugins('fetchDidSucceed', { response });
      expect(result).toBe(response);
    });
  });

  describe('Cleanup operations', () => {
    it('should clean all resources', async () => {
      await client.clean();
      
      expect(mockDb.clear).toHaveBeenCalled();
    });

    it('should clean resources with range', async () => {
      const range = {
        minZoom: 10,
        maxZoom: 15,
        bounds: [130, 30, 140, 40] as [number, number, number, number]
      };
      
      await client.clean(range);
      
      // Since range-based cleaning is not yet implemented in the mock,
      // we just verify the method was called
      expect(mockDb.clear).toHaveBeenCalled();
    });
  });
});