import { describe, it, expect, vi, beforeEach } from 'vitest';
import Weiwudi from '../src/weiwudi.ts';

// Mock navigator.serviceWorker
const mockServiceWorker = {
  register: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn()
};

const mockRegistration = {
  active: null,
  installing: null,
  waiting: null,
  update: vi.fn(),
  onupdatefound: null
};

beforeEach(() => {
  vi.clearAllMocks();
  (global as any).navigator = {
    serviceWorker: mockServiceWorker
  };
  (global as any).fetch = vi.fn();
});

describe('Weiwudi', () => {
  describe('registerSW', () => {
    it('should register service worker successfully', async () => {
      mockServiceWorker.register.mockResolvedValue(mockRegistration);
      mockRegistration.active = { state: 'activated' };
      (global as any).fetch.mockResolvedValue({ ok: true });

      const reg = await Weiwudi.registerSW('/sw.js');
      
      expect(mockServiceWorker.register).toHaveBeenCalledWith('/sw.js', undefined);
      expect(reg).toBe(mockRegistration);
    });

    it('should throw error when service worker is not supported', async () => {
      (global as any).navigator = {};
      
      await expect(Weiwudi.registerSW('/sw.js')).rejects.toThrow('Service worker is not supported');
    });
  });

  describe('registerMap', () => {
    it('should register a new map', async () => {
      (global as any).fetch.mockImplementation((url: string) => {
        if (url.includes('ping')) {
          return Promise.resolve({ ok: true });
        }
        if (url.includes('add')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({
              type: 'xyz',
              url: 'https://example.com/{z}/{x}/{y}.png',
              minZoom: 0,
              maxZoom: 18
            }))
          });
        }
      });

      const weiwudi = await Weiwudi.registerMap('testMap', {
        type: 'xyz',
        url: 'https://example.com/{z}/{x}/{y}.png',
        width: 1024,
        height: 1024
      });

      expect(weiwudi.mapID).toBe('testMap');
      expect(weiwudi.url).toContain('cache/testMap/{z}/{x}/{y}');
    });
  });

  describe('instance methods', () => {
    let weiwudi: Weiwudi;

    beforeEach(() => {
      weiwudi = new Weiwudi('testMap', {
        type: 'xyz',
        url: 'https://example.com/{z}/{x}/{y}.png'
      });
    });

    it('should get stats', async () => {
      (global as any).fetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ count: 10, size: 1024 }))
      });

      const stats = await weiwudi.stats();
      
      expect(stats).toEqual({ count: 10, size: 1024 });
    });

    it('should clean cache', async () => {
      (global as any).fetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('OK')
      });

      await expect(weiwudi.clean()).resolves.not.toThrow();
    });

    it('should support range-based cleaning for WMTS', async () => {
      (global as any).fetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('OK')
      });

      await expect(weiwudi.clean({
        minZoom: 10,
        maxZoom: 15,
        minLng: 135.0,
        maxLng: 140.0,
        minLat: 35.0,
        maxLat: 40.0
      })).resolves.not.toThrow();
    });

    it('should fetch all tiles', async () => {
      (global as any).fetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('OK')
      });

      await expect(weiwudi.fetchAll()).resolves.not.toThrow();
    });

    it('should cancel fetch operation', async () => {
      (global as any).fetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('OK')
      });

      await expect(weiwudi.cancel()).resolves.not.toThrow();
    });

    it('should register vector tile assets', async () => {
      (global as any).fetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('OK')
      });

      await expect(weiwudi.registerVectorTileAssets({
        definition: 'https://example.com/style.json',
        styles: 'https://example.com/styles',
        fonts: 'https://example.com/fonts/{fontstack}/{range}.pbf',
        icons: 'https://example.com/sprite'
      })).resolves.not.toThrow();
    });

    it('should get vector tile asset URLs', () => {
      expect(weiwudi.getDefinitionUrl()).toContain('cache/testMap/definition');
      expect(weiwudi.getStylesUrl()).toContain('cache/testMap/styles');
      expect(weiwudi.getFontsUrl()).toContain('cache/testMap/fonts');
      expect(weiwudi.getIconsUrl()).toContain('cache/testMap/icons');
    });

    it('should release instance properly', () => {
      weiwudi.release();
      
      expect(() => weiwudi.stats()).rejects.toThrow('This instance is already released');
    });
  });
});