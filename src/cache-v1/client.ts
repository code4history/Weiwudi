/**
 * Weiwudi client API for cache v1
 */

import { WeiwudiDatabase } from './database';
import {
  Resource,
  WeiwudiOptions,
  WeiwudiPlugin,
  QuotaOptions,
  AutoCleanupOptions,
  StorageUsage
} from './types';
import { BeatBox } from '@c4h/beatbox';

export class WeiwudiClient extends EventTarget {
  private db: WeiwudiDatabase;
  private plugins: WeiwudiPlugin[] = [];
  private managedUrls: Set<string> = new Set();
  private beatbox: BeatBox | null = null;

  constructor() {
    super();
    this.db = new WeiwudiDatabase();
  }

  /**
   * Initialize Weiwudi
   */
  async init(): Promise<void> {
    await this.db.open();
    
    const accessToken = await this.db.getSetting('mapboxAccessToken');
    if (accessToken) {
      this.beatbox = new BeatBox({ accessToken });
    }

    // Load managed URLs
    const resources = await this.db.getResourcesByType('style');
    const tileResources = await this.db.getResourcesByType('tile');
    
    [...resources, ...tileResources].forEach(resource => {
      this.managedUrls.add(resource.url);
      if (resource.urlTemplate) {
        this.managedUrls.add(resource.urlTemplate);
      }
    });
  }

  /**
   * Register URLs for caching
   */
  async register(params: {
    url?: string;
    urls?: string[];
    options?: WeiwudiOptions;
  }): Promise<void> {
    const urls = params.urls || (params.url ? [params.url] : []);

    if (params.options?.mapboxAccessToken) {
      await this.db.saveSetting('mapboxAccessToken', params.options.mapboxAccessToken);
      this.beatbox = new BeatBox({ accessToken: params.options.mapboxAccessToken });
    }
    
    for (const url of urls) {
      // Detect resource type
      const type = this.detectResourceType(url);
      
      // Check if this is a style URL
      if (type === 'style' && params.options?.autoRegisterAssets !== false) {
        await this.registerStyleWithAssets(url);
      } else {
        // Register single resource
        const resource: Resource = {
          url,
          urlTemplate: this.isTemplateUrl(url) ? url : undefined,
          type,
          lastAccessed: Date.now(),
          size: 0
        };
        
        // Run plugins
        const modifiedResource = await this.runResourceWillRegister(resource);
        
        await this.saveResourceWithAliases(modifiedResource || resource);
      }
    }
  }

  /**
   * Unregister URLs from caching
   */
  async unregister(url: string): Promise<void> {
    await this.db.deleteResource(url);
    this.managedUrls.delete(url);
  }

  /**
   * Check if URL is managed by Weiwudi
   */
  async isManaged(url: string): Promise<boolean> {
    const resource = await this.db.getResource(url);
    return resource !== undefined;
  }

  /**
   * Register a plugin
   */
  registerPlugin(plugin: WeiwudiPlugin): void {
    this.plugins.push(plugin);
  }

  /**
   * Add a plugin (alias for registerPlugin)
   */
  addPlugin(plugin: WeiwudiPlugin): void {
    this.registerPlugin(plugin);
  }

  /**
   * Set quota options
   */
  async setQuota(options: QuotaOptions): Promise<void> {
    if (options.maxCacheSize !== undefined) {
      await this.db.saveSetting('quotaLimit', options.maxCacheSize);
    }
    if (options.maxResourceSize !== undefined) {
      await this.db.saveSetting('maxResourceSize', options.maxResourceSize);
    }
    if (options.alertThreshold !== undefined) {
      await this.db.saveSetting('alertThreshold', options.alertThreshold);
    }
  }

  /**
   * Get storage usage
   */
  async getStorageUsage(): Promise<StorageUsage> {
    const used = await this.db.calculateTotalSize();
    const quota = await this.db.getSetting('quotaLimit') || 500 * 1024 * 1024;
    const resources = await this.db.getResourcesByType('style');
    const tileResources = await this.db.getResourcesByType('tile');
    
    return {
      used,
      quota,
      percentage: Math.round((used / quota) * 100),
      resources: resources.length + tileResources.length
    };
  }

  /**
   * Set auto cleanup options
   */
  async setAutoCleanup(options: AutoCleanupOptions): Promise<void> {
    await this.db.saveSetting('autoCleanupEnabled', options.enabled);
    if (options.strategy !== undefined) {
      await this.db.saveSetting('cleanupStrategy', options.strategy);
    }
    if (options.targetPercentage !== undefined) {
      await this.db.saveSetting('cleanupTargetPercentage', options.targetPercentage);
    }
  }

  /**
   * Protect/unprotect a resource from auto-deletion
   */
  async protectResource(url: string, protect: boolean): Promise<void> {
    const resource = await this.db.getResource(url);
    if (resource) {
      resource.protected = protect;
      await this.db.saveResource(resource);
    }
  }

  /**
   * Clean cache (with optional range for WMTS)
   */
  async clean(options?: {
    url?: string;
    bounds?: [number, number, number, number];
    minZoom?: number;
    maxZoom?: number;
  }): Promise<void> {
    if (!options?.url) {
      // Clean all
      await this.db.clear();
      this.managedUrls.clear();
      return;
    }
    
    // Clean specific resource
    await this.db.deleteResource(options.url);
    this.managedUrls.delete(options.url);
  }

  /**
   * Fetch all tiles in range (for preloading)
   */
  async fetchAll(options: {
    bounds: [number, number, number, number];
    minZoom: number;
    maxZoom: number;
  }): Promise<void> {
    // This is a placeholder - actual implementation would:
    // 1. Find all tile resources that intersect with bounds
    // 2. Calculate tile coordinates for each zoom level
    // 3. Fetch each tile that isn't already cached
    // 4. Respect quota limits
    
    console.log('fetchAll called with:', options);
    
    // For now, just trigger a simple fetch to demonstrate
    const resources = await this.db.getResourcesByType('tile');
    
    for (const resource of resources) {
      if (resource.urlTemplate && resource.urlTemplate.includes('{z}')) {
        // This is a tile URL template
        // In a real implementation, we would:
        // - Calculate tile bounds for the given geographic bounds
        // - Iterate through zoom levels
        // - Fetch each tile
        console.log('Would fetch tiles for:', resource.urlTemplate);
      }
    }
  }

  /**
   * Internal: Register style with assets
   */
  private async registerStyleWithAssets(styleUrl: string): Promise<void> {
    try {
      // Fetch style
      const response = await fetch(styleUrl);
      if (!response.ok) throw new Error(`Failed to fetch style: ${response.status}`);
      
      const style = await response.json();
      
      // Register style itself
      const styleResource: Resource = {
        url: styleUrl,
        type: 'style',
        lastAccessed: Date.now(),
        size: 0
      };
      await this.saveResourceWithAliases(styleResource);
      
      // Extract and register sources
      if (style.sources) {
        for (const [_, source] of Object.entries(style.sources)) {
          const sourceObj = source as any;
          if (sourceObj.tiles) {
            for (const tileUrl of sourceObj.tiles) {
              const tileResource: Resource = {
                url: tileUrl,
                urlTemplate: tileUrl,
                type: 'tile',
                metadata: {
                  styleId: styleUrl,
                  bounds: sourceObj.bounds,
                  minzoom: sourceObj.minzoom,
                  maxzoom: sourceObj.maxzoom
                },
                lastAccessed: Date.now(),
                size: 0
              };
              await this.saveResourceWithAliases(tileResource);
            }
          }
        }
      }
      
      // Register sprite
      if (style.sprite) {
        const spriteResource: Resource = {
          url: style.sprite,
          type: 'sprite',
          metadata: { styleId: styleUrl },
          lastAccessed: Date.now(),
          size: 0
        };
        await this.saveResourceWithAliases(spriteResource);
      }
      
      // Register glyphs
      if (style.glyphs) {
        const glyphsResource: Resource = {
          url: style.glyphs,
          urlTemplate: style.glyphs,
          type: 'font',
          metadata: { styleId: styleUrl },
          lastAccessed: Date.now(),
          size: 0
        };
        await this.saveResourceWithAliases(glyphsResource);
      }
    } catch (error) {
      console.error('Failed to register style with assets:', error);
      throw error;
    }
  }

  private expandMapboxUrl(url: string): string | null {
    if (!this.beatbox || !url.startsWith('mapbox://')) {
      return null;
    }

    try {
      return this.beatbox.toHttpUrl(url);
    } catch {
      return null;
    }
  }

  private resolveTemplateForUrl(
    url: string,
    template?: string,
    expandedTemplate?: string
  ): string | undefined {
    if (!template) return undefined;

    if (template.startsWith('mapbox://') && url.startsWith('http')) {
      return expandedTemplate || template;
    }

    return template;
  }

  private async saveResourceWithAliases(resource: Resource): Promise<void> {
    const urls = new Set<string>([resource.url]);
    const expandedUrl = this.expandMapboxUrl(resource.url);
    if (expandedUrl) {
      urls.add(expandedUrl);
    }

    const template = resource.urlTemplate;
    const expandedTemplate = template ? this.expandMapboxUrl(template) : null;

    for (const url of urls) {
      const urlTemplate = this.resolveTemplateForUrl(url, template, expandedTemplate || undefined);
      const resourceForUrl: Resource = {
        ...resource,
        url,
        urlTemplate
      };

      await this.db.saveResource(resourceForUrl);
      this.managedUrls.add(url);
      if (urlTemplate) {
        this.managedUrls.add(urlTemplate);
      }
    }
  }

  /**
   * Detect resource type from URL
   */
  private detectResourceType(url: string): Resource['type'] {
    if (url.includes('/sprite') || url.includes('@2x')) return 'sprite';
    if (url.includes('/fonts/') || url.includes('{fontstack}')) return 'font';
    if (url.includes('{z}') && url.includes('{x}') && url.includes('{y}')) return 'tile';
    if (url.endsWith('.geojson')) return 'geojson';
    if (url.includes('/style') || url.endsWith('.json')) return 'style';
    return 'tile'; // Default
  }

  /**
   * Check if URL is a template
   */
  private isTemplateUrl(url: string): boolean {
    return url.includes('{') && url.includes('}');
  }

  /**
   * Run plugin hook: resourceWillRegister
   */
  private async runResourceWillRegister(resource: Resource): Promise<Resource | void> {
    let modifiedResource = resource;
    
    for (const plugin of this.plugins) {
      if (plugin.resourceWillRegister) {
        const result = await plugin.resourceWillRegister({ resource: modifiedResource });
        if (result) modifiedResource = result;
      }
    }
    
    return modifiedResource;
  }


  /**
   * Get all registered resources
   */
  async getRegisteredResources(): Promise<Resource[]> {
    return this.db.getAllResources();
  }

  /**
   * Get resources by type
   */
  async getResourcesByType(type: Resource['type']): Promise<Resource[]> {
    return this.db.getResourcesByType(type);
  }

  /**
   * Apply plugins
   */
  async applyPlugins(hook: string, params: any): Promise<any> {
    let result = params[Object.keys(params)[0]];
    
    for (const plugin of this.plugins) {
      if ((plugin as any)[hook]) {
        const pluginResult = await (plugin as any)[hook](params);
        if (pluginResult !== undefined && pluginResult !== null) {
          result = pluginResult;
        }
      }
    }
    
    return result;
  }

  /**
   * Get database instance (for testing)
   */
  getDatabase(): WeiwudiDatabase {
    return this.db;
  }
}
