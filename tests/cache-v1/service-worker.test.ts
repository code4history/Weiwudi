import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WeiwudiServiceWorker } from '../../src/cache-v1/service-worker';
import { WeiwudiClient } from '../../src/cache-v1/client';
import { WeiwudiDatabase } from '../../src/cache-v1/database';
import { Resource, CacheEntry } from '../../src/cache-v1/types';

// Mock modules
vi.mock('../../src/cache-v1/client');
vi.mock('../../src/cache-v1/database');
vi.mock('@c4h/beatbox', () => ({
  transformMapboxUrl: (url: string) => {
    if (url.startsWith('mapbox://')) {
      return {
        url: url.replace('mapbox://', 'https://api.mapbox.com/'),
        accessToken: 'test_token'
      };
    }
    return null;
  }
}));

describe('WeiwudiServiceWorker', () => {
  let sw: WeiwudiServiceWorker;
  let mockClient: any;
  let mockDb: any;

  beforeEach(() => {
    // Mock database
    mockDb = {
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getResource: vi.fn(),
      getResourcesByType: vi.fn().mockResolvedValue([]),
      getCacheEntry: vi.fn(),
      saveCacheEntry: vi.fn().mockResolvedValue(undefined),
      saveResource: vi.fn().mockResolvedValue(undefined),
      getSetting: vi.fn().mockResolvedValue(500 * 1024 * 1024), // Default quota
      calculateTotalSize: vi.fn().mockResolvedValue(0)
    };

    // Mock client
    mockClient = {
      applyPlugins: vi.fn((_hook: any, params: any) => params),
      getDatabase: vi.fn(() => mockDb)
    };

    (WeiwudiDatabase as any).mockImplementation(() => mockDb);
    (WeiwudiClient as any).mockImplementation(() => mockClient);

    sw = new WeiwudiServiceWorker();
    
    // Mock SW's own applyPlugins method
    sw.applyPlugins = vi.fn((hook, params) => {
      if (hook === 'requestWillFetch') {
        return params.request;
      }
      if (hook === 'fetchDidSucceed') {
        return params.response;
      }
      return null;
    });
  });

  describe('Request handling', () => {
    it('should handle cached tile request', async () => {
      const url = 'https://example.com/tiles/10/512/340.mvt';
      const resource: Resource = {
        url: 'https://example.com/tiles/{z}/{x}/{y}.mvt',
        urlTemplate: 'https://example.com/tiles/{z}/{x}/{y}.mvt',
        type: 'tile',
        lastAccessed: Date.now(),
        size: 0
      };
      const cachedData = new Blob(['tile data']);
      const cacheEntry: CacheEntry = {
        url,
        resourceUrl: resource.url,
        data: cachedData,
        headers: { 'content-type': 'application/vnd.mapbox-vector-tile' },
        created: Date.now(),
        size: cachedData.size
      };

      mockDb.getResource.mockResolvedValue(resource);
      mockDb.getCacheEntry.mockResolvedValue(cacheEntry);

      const request = new Request(url);
      const response = await sw.handleRequest(request);

      expect(response).toBeDefined();
      expect(response?.status).toBe(200);
      expect(response?.headers.get('content-type')).toBe('application/vnd.mapbox-vector-tile');
    });

    it('should fetch and cache uncached tile', async () => {
      const url = 'https://example.com/tiles/10/512/340.mvt';
      const resource: Resource = {
        url: 'https://example.com/tiles/{z}/{x}/{y}.mvt',
        urlTemplate: 'https://example.com/tiles/{z}/{x}/{y}.mvt',
        type: 'tile',
        lastAccessed: Date.now(),
        size: 0
      };
      const fetchedData = new Blob(['new tile data']);

      mockDb.getResource.mockResolvedValue(resource);
      mockDb.getCacheEntry.mockResolvedValue(undefined);

      // Mock fetch
      global.fetch = vi.fn().mockResolvedValue(
        new Response(fetchedData, {
          headers: { 'content-type': 'application/vnd.mapbox-vector-tile' }
        })
      );

      const request = new Request(url);
      const response = await sw.handleRequest(request);

      expect(response).toBeDefined();
      expect(response?.status).toBe(200);
      expect(mockDb.saveCacheEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          url,
          resourceUrl: resource.url
        })
      );
    });

    it('should handle style.json request', async () => {
      const url = 'https://api.mapbox.com/styles/v1/mapbox/streets-v11/style.json';
      const resource: Resource = {
        url,
        type: 'style',
        lastAccessed: Date.now(),
        size: 1024
      };
      const styleData = {
        version: 8,
        sources: {
          'mapbox-streets': {
            type: 'vector',
            url: 'mapbox://mapbox.mapbox-streets-v8'
          }
        }
      };

      mockDb.getResource.mockResolvedValue(resource);
      mockDb.getCacheEntry.mockResolvedValue({
        url,
        resourceUrl: url,
        data: new Blob([JSON.stringify(styleData)]),
        headers: { 'content-type': 'application/json' },
        created: Date.now(),
        size: 1024
      });

      const request = new Request(url);
      const response = await sw.handleRequest(request);

      expect(response).toBeDefined();
      expect(response?.status).toBe(200);
      expect(response?.headers.get('content-type')).toBe('application/json');
    });

    it('should handle mapbox:// URL transformation', async () => {
      const mapboxUrl = 'mapbox://styles/mapbox/streets-v11';
      const httpsUrl = 'https://api.mapbox.com/styles/mapbox/streets-v11';
      
      const resource: Resource = {
        url: httpsUrl,
        type: 'style',
        lastAccessed: Date.now(),
        size: 1024
      };

      mockDb.getResource.mockResolvedValue(resource);
      mockDb.getCacheEntry.mockResolvedValue({
        url: httpsUrl,
        resourceUrl: httpsUrl,
        data: new Blob(['style data']),
        headers: { 'content-type': 'application/json' },
        created: Date.now(),
        size: 1024
      });

      const request = new Request(mapboxUrl);
      const response = await sw.handleRequest(request);

      expect(response).toBeDefined();
      expect(response?.status).toBe(200);
    });

    it('should return null for unmanaged resources', async () => {
      const url = 'https://example.com/unmanaged.json';
      
      mockDb.getResource.mockResolvedValue(undefined);

      const request = new Request(url);
      const response = await sw.handleRequest(request);

      expect(response).toBeNull();
    });
  });

  describe('Plugin integration', () => {
    it('should apply request plugins', async () => {
      const url = 'https://example.com/test.json';
      const modifiedUrl = 'https://example.com/modified.json';
      
      mockClient.applyPlugins.mockImplementation((hook: string, params: any) => {
        if (hook === 'requestWillFetch') {
          return {
            request: new Request(modifiedUrl)
          };
        }
        return params;
      });

      // Need to have a resource for the request to be processed
      mockDb.getResource.mockResolvedValue({
        url,
        type: 'style',
        lastAccessed: Date.now(),
        size: 0
      });
      
      mockDb.getCacheEntry.mockResolvedValue(null);
      
      global.fetch = vi.fn().mockResolvedValue(
        new Response('test', { status: 200 })
      );

      const request = new Request(url);
      await sw.handleRequest(request);

      expect(sw.applyPlugins).toHaveBeenCalledWith(
        'requestWillFetch',
        expect.objectContaining({ request })
      );
    });

    it('should apply response plugins', async () => {
      const url = 'https://example.com/style.json';
      const resource: Resource = {
        url,
        type: 'style',
        lastAccessed: Date.now(),
        size: 1024
      };

      mockDb.getResource.mockResolvedValue(resource);
      mockDb.getCacheEntry.mockResolvedValue({
        url,
        resourceUrl: url,
        data: new Blob(['data']),
        headers: {},
        created: Date.now(),
        size: 4
      });

      sw.applyPlugins = vi.fn((hook, params) => {
        if (hook === 'fetchDidSucceed') {
          return new Response('modified data', {
            headers: { 'x-modified': 'true' }
          });
        }
        return params.response || params.request;
      });

      const request = new Request(url);
      const response = await sw.handleRequest(request);

      expect(response).toBeDefined();
      expect(response?.headers.get('x-modified')).toBe('true');
      expect(sw.applyPlugins).toHaveBeenCalledWith(
        'fetchDidSucceed',
        expect.objectContaining({ response: expect.any(Response) })
      );
    });
  });

  describe('Cache management', () => {
    it('should check quota before caching', async () => {
      const url = 'https://example.com/large-tile.mvt';
      const resource: Resource = {
        url: 'https://example.com/tiles/{z}/{x}/{y}.mvt',
        urlTemplate: 'https://example.com/tiles/{z}/{x}/{y}.mvt',
        type: 'tile',
        lastAccessed: Date.now(),
        size: 0
      };
      
      // Simulate quota exceeded
      mockDb.getSetting.mockResolvedValue(100); // 100 bytes quota
      mockDb.calculateTotalSize.mockResolvedValue(90); // 90 bytes used
      
      mockDb.getResource.mockResolvedValue(resource);
      mockDb.getCacheEntry.mockResolvedValue(undefined);

      const largeData = new Blob(['x'.repeat(20)]); // 20 bytes
      global.fetch = vi.fn().mockResolvedValue(
        new Response(largeData, {
          headers: { 'content-type': 'application/octet-stream' }
        })
      );

      const request = new Request(url);
      const response = await sw.handleRequest(request);

      expect(response).toBeDefined();
      expect(response?.status).toBe(200);
      // Should not cache due to quota
      expect(mockDb.saveCacheEntry).not.toHaveBeenCalled();
    });

    it('should update resource last accessed time', async () => {
      const url = 'https://example.com/style.json';
      const resource: Resource = {
        url,
        type: 'style',
        lastAccessed: Date.now() - 1000,
        size: 1024
      };

      mockDb.getResource.mockResolvedValue(resource);
      mockDb.getCacheEntry.mockResolvedValue({
        url,
        resourceUrl: url,
        data: new Blob(['data']),
        headers: {},
        created: Date.now(),
        size: 4
      });

      const request = new Request(url);
      await sw.handleRequest(request);

      expect(mockDb.saveResource).toHaveBeenCalledWith(
        expect.objectContaining({
          url,
          lastAccessed: expect.any(Number)
        })
      );
    });
  });

  describe('Error handling', () => {
    it('should handle fetch errors gracefully', async () => {
      const url = 'https://example.com/error.json';
      const resource: Resource = {
        url,
        type: 'style',
        lastAccessed: Date.now(),
        size: 0
      };

      mockDb.getResource.mockResolvedValue(resource);
      mockDb.getCacheEntry.mockResolvedValue(undefined);

      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const request = new Request(url);
      const response = await sw.handleRequest(request);

      expect(response).toBeNull();
    });

    it('should handle plugin errors', async () => {
      const url = 'https://example.com/test.json';
      
      sw.applyPlugins = vi.fn(async (hook: string) => {
        if (hook === 'requestWillFetch') {
          throw new Error('Plugin error');
        }
        return null;
      });

      mockDb.getResource.mockResolvedValue({
        url,
        type: 'style',
        lastAccessed: Date.now(),
        size: 0
      });

      const request = new Request(url);
      const response = await sw.handleRequest(request);

      expect(response).toBeNull();
    });
  });
});