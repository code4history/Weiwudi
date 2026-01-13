/**
 * Service Worker implementation for cache v1
 */

import { WeiwudiDatabase } from './database';
import { Resource, CacheEntry, WeiwudiPlugin } from './types';
import { BeatBox } from '@c4h/beatbox';

declare const self: ServiceWorkerGlobalScope;

export class WeiwudiServiceWorker {
  private db: WeiwudiDatabase;
  private plugins: WeiwudiPlugin[] = [];
  private accessToken: string | null = null;
  private beatbox: BeatBox | null = null;

  constructor() {
    this.db = new WeiwudiDatabase();
  }

  async init(): Promise<void> {
    await this.db.open();
    
    // Store access token if available
    const accessToken = await this.db.getSetting('mapboxAccessToken');
    if (accessToken) {
      this.accessToken = accessToken as string;
      this.beatbox = new BeatBox({ accessToken: this.accessToken });
    }
  }

  /**
   * Handle request
   */
  async handleRequest(request: Request): Promise<Response | null> {
    try {
      let url = request.url;
      
      // Transform mapbox:// URLs
      if (this.beatbox && url.startsWith('mapbox://')) {
        url = this.beatbox.toHttpUrl(url);
      }
      
      // Find matching resource
      const resource = await this.findMatchingResource(url);
      if (!resource) return null;
      
      // Update last accessed time
      resource.lastAccessed = Date.now();
      await this.db.saveResource(resource);
      
      // Apply request plugins
      const modifiedRequest = await this.applyPlugins('requestWillFetch', { request }) || request;
      
      // Handle based on resource type
      let response: Response;
      
      switch (resource.type) {
        case 'style':
          response = await this.handleStyleRequest(modifiedRequest, resource);
          break;
        case 'tile':
          response = await this.handleTileRequest(modifiedRequest, resource);
          break;
        case 'sprite':
          response = await this.handleSpriteRequest(modifiedRequest, resource);
          break;
        case 'font':
          response = await this.handleFontRequest(modifiedRequest, resource);
          break;
        default:
          response = await this.handleGenericRequest(modifiedRequest, resource);
      }
      
      // Apply response plugins
      const modifiedResponse = await this.applyPlugins('fetchDidSucceed', { response }) || response;
      
      return modifiedResponse;
    } catch (error) {
      console.error('Error handling request:', error);
      return null;
    }
  }

  /**
   * Apply plugins
   */
  async applyPlugins(hook: string, params: any): Promise<any> {
    let result = params[Object.keys(params)[0]];
    
    for (const plugin of this.plugins) {
      if ((plugin as any)[hook]) {
        const pluginResult = await (plugin as any)[hook](params);
        if (pluginResult && pluginResult[Object.keys(params)[0]]) {
          result = pluginResult[Object.keys(params)[0]];
        }
      }
    }
    
    return result;
  }

  /**
   * Handle fetch event
   */
  async handle(event: FetchEvent): Promise<Response> {
    const request = event.request;
    const state: any = {};

    try {
      // Run requestWillFetch plugins
      const modifiedRequest = await this.runRequestWillFetch(request, event, state) || request;

      // Find matching resource
      const resource = await this.findMatchingResource(modifiedRequest.url);
      if (!resource) {
        return fetch(modifiedRequest);
      }

      // Update last accessed
      resource.lastAccessed = Date.now();
      await this.db.saveResource(resource);

      // Handle different resource types
      let response: Response;
      
      switch (resource.type) {
        case 'tile':
          response = await this.handleTileRequest(modifiedRequest, resource);
          break;
        case 'style':
          response = await this.handleStyleRequest(modifiedRequest, resource);
          break;
        case 'sprite':
          response = await this.handleSpriteRequest(modifiedRequest, resource);
          break;
        case 'font':
          response = await this.handleFontRequest(modifiedRequest, resource);
          break;
        default:
          response = await this.handleGenericRequest(modifiedRequest, resource);
      }

      // Run fetchDidSucceed plugins
      const modifiedResponse = await this.runFetchDidSucceed(modifiedRequest, response, event, state) || response;
      
      return modifiedResponse;
    } catch (error) {
      // Run fetchDidFail plugins
      const errorResponse = await this.runFetchDidFail(error as Error, request, event, state);
      if (errorResponse) return errorResponse;
      
      throw error;
    }
  }

  /**
   * Register plugin
   */
  registerPlugin(plugin: WeiwudiPlugin): void {
    this.plugins.push(plugin);
  }

  /**
   * Handle tile request
   */
  private async handleTileRequest(request: Request, resource: Resource): Promise<Response> {
    const url = request.url;
    
    // Check cache
    const cached = await this.db.getCacheEntry(url);
    if (cached && this.isCacheValid(cached)) {
      return new Response(cached.data, { headers: cached.headers });
    }

    // Expand URL if needed (handle mapbox:// URLs)
    let fetchUrl = url;
    if (this.beatbox && url.startsWith('mapbox://')) {
      fetchUrl = this.beatbox.toHttpUrl(url);
    }

    // Fetch from network
    const response = await fetch(fetchUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch tile: ${response.status}`);
    }

    // Check quota before saving
    const blob = await response.blob();
    if (await this.checkQuota(blob.size)) {
      // Save to cache
      const cacheEntry: CacheEntry = {
        url,
        resourceUrl: resource.url,
        data: blob,
        headers: Object.fromEntries(response.headers.entries()),
        etag: response.headers.get('etag') || undefined,
        expires: this.parseExpires(response.headers),
        lastModified: response.headers.get('last-modified') || undefined,
        created: Date.now(),
        size: blob.size
      };
      
      await this.db.saveCacheEntry(cacheEntry);
    }

    return new Response(blob, { 
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    });
  }

  /**
   * Handle style request
   */
  private async handleStyleRequest(request: Request, resource: Resource): Promise<Response> {
    const url = request.url;
    
    // Check cache
    const cached = await this.db.getCacheEntry(url);
    if (cached && this.isCacheValid(cached)) {
      return new Response(cached.data, { headers: cached.headers });
    }

    // Expand URL if needed
    let fetchUrl = url;
    if (this.beatbox && url.startsWith('mapbox://')) {
      fetchUrl = this.beatbox.toHttpUrl(url);
    }

    // Fetch from network
    const response = await fetch(fetchUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch style: ${response.status}`);
    }

    // Process style (replace URLs)
    let styleText = await response.text();
    if (this.beatbox) {
      const style = JSON.parse(styleText);
      const processedStyle = this.beatbox.translateStyleUrls(style);
      styleText = JSON.stringify(processedStyle);
    }

    const blob = new Blob([styleText], { type: 'application/json' });

    // Save to cache
    if (await this.checkQuota(blob.size)) {
      const cacheEntry: CacheEntry = {
        url,
        resourceUrl: resource.url,
        data: blob,
        headers: Object.fromEntries(response.headers.entries()),
        created: Date.now(),
        size: blob.size
      };
      
      await this.db.saveCacheEntry(cacheEntry);
    }

    return new Response(blob, { 
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    });
  }

  /**
   * Handle sprite request
   */
  private async handleSpriteRequest(request: Request, resource: Resource): Promise<Response> {
    const url = new URL(request.url);
    
    // Detect sprite type
    const spriteType = this.detectSpriteType(url.pathname);
    const actualUrl = this.buildSpriteUrl(resource.url, spriteType);
    
    // Check cache
    const cached = await this.db.getCacheEntry(actualUrl);
    if (cached && this.isCacheValid(cached)) {
      return new Response(cached.data, { headers: cached.headers });
    }

    // Fetch from network
    const response = await fetch(actualUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch sprite: ${response.status}`);
    }

    const blob = await response.blob();

    // Save to cache
    if (await this.checkQuota(blob.size)) {
      const cacheEntry: CacheEntry = {
        url: actualUrl,
        resourceUrl: resource.url,
        data: blob,
        headers: Object.fromEntries(response.headers.entries()),
        created: Date.now(),
        size: blob.size
      };
      
      await this.db.saveCacheEntry(cacheEntry);
    }

    return new Response(blob, { 
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    });
  }

  /**
   * Handle font request
   */
  private async handleFontRequest(request: Request, resource: Resource): Promise<Response> {
    const url = new URL(request.url);
    
    // Extract fontstack and range
    const pathParts = url.pathname.split('/');
    const fontstack = pathParts[pathParts.length - 2];
    const range = pathParts[pathParts.length - 1].replace('.pbf', '');
    
    // Build actual URL
    const actualUrl = resource.urlTemplate!
      .replace('{fontstack}', fontstack)
      .replace('{range}', range);
    
    // Check cache
    const cached = await this.db.getCacheEntry(actualUrl);
    if (cached && this.isCacheValid(cached)) {
      return new Response(cached.data, { headers: cached.headers });
    }

    // Fetch from network
    const response = await fetch(actualUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch font: ${response.status}`);
    }

    const blob = await response.blob();

    // Save to cache
    if (await this.checkQuota(blob.size)) {
      const cacheEntry: CacheEntry = {
        url: actualUrl,
        resourceUrl: resource.url,
        data: blob,
        headers: Object.fromEntries(response.headers.entries()),
        created: Date.now(),
        size: blob.size
      };
      
      await this.db.saveCacheEntry(cacheEntry);
    }

    return new Response(blob, { 
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    });
  }

  /**
   * Handle generic request
   */
  private async handleGenericRequest(request: Request, resource: Resource): Promise<Response> {
    const url = request.url;
    
    // Check cache
    const cached = await this.db.getCacheEntry(url);
    if (cached && this.isCacheValid(cached)) {
      return new Response(cached.data, { headers: cached.headers });
    }

    // Fetch from network
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch resource: ${response.status}`);
    }

    const blob = await response.blob();

    // Save to cache
    if (await this.checkQuota(blob.size)) {
      const cacheEntry: CacheEntry = {
        url,
        resourceUrl: resource.url,
        data: blob,
        headers: Object.fromEntries(response.headers.entries()),
        created: Date.now(),
        size: blob.size
      };
      
      await this.db.saveCacheEntry(cacheEntry);
    }

    return new Response(blob, { 
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    });
  }

  /**
   * Find matching resource for URL
   */
  private async findMatchingResource(url: string): Promise<Resource | undefined> {
    // Try direct match first
    let resource = await this.db.getResource(url);
    if (resource) return resource;

    const normalizedUrl = this.normalizeUrl(url);
    if (normalizedUrl !== url) {
      resource = await this.db.getResource(normalizedUrl);
      if (resource) return resource;
    }

    // Try template match
    const allResources = [
      ...await this.db.getResourcesByType('tile'),
      ...await this.db.getResourcesByType('font')
    ];

    for (const res of allResources) {
      if (res.urlTemplate && this.matchesTemplate(normalizedUrl, res.urlTemplate)) {
        return res;
      }
    }

    return undefined;
  }

  /**
   * Check if cache is valid
   */
  private isCacheValid(cached: CacheEntry): boolean {
    // Check expires header
    if (cached.expires && cached.expires < Date.now()) {
      return false;
    }

    // Default 24 hour cache
    const maxAge = 24 * 60 * 60 * 1000;
    return (Date.now() - cached.created) < maxAge;
  }

  /**
   * Check quota before saving
   */
  private async checkQuota(size: number): Promise<boolean> {
    const quotaLimit = await this.db.getSetting('quotaLimit') || 500 * 1024 * 1024;
    const currentSize = await this.db.calculateTotalSize();
    
    if (currentSize + size > quotaLimit * 0.9) {
      self.dispatchEvent(new CustomEvent('quotawarning', {
        detail: { used: currentSize, limit: quotaLimit }
      }));
    }
    
    return currentSize + size <= quotaLimit;
  }

  /**
   * Parse expires header
   */
  private parseExpires(headers: Headers): number | undefined {
    const expires = headers.get('expires');
    if (expires) {
      return new Date(expires).getTime();
    }
    
    const cacheControl = headers.get('cache-control');
    if (cacheControl) {
      const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
      if (maxAgeMatch) {
        return Date.now() + parseInt(maxAgeMatch[1]) * 1000;
      }
    }
    
    return undefined;
  }


  /**
   * Detect sprite type
   */
  private detectSpriteType(pathname: string): { resolution: '1x' | '2x', format: 'json' | 'png' } {
    if (pathname.endsWith('@2x.json')) return { resolution: '2x', format: 'json' };
    if (pathname.endsWith('@2x.png')) return { resolution: '2x', format: 'png' };
    if (pathname.endsWith('.json')) return { resolution: '1x', format: 'json' };
    if (pathname.endsWith('.png')) return { resolution: '1x', format: 'png' };
    return { resolution: '1x', format: 'png' };
  }

  /**
   * Build sprite URL
   */
  private buildSpriteUrl(baseUrl: string, type: { resolution: '1x' | '2x', format: 'json' | 'png' }): string {
    const suffix = type.resolution === '2x' ? '@2x' : '';
    return `${baseUrl}${suffix}.${type.format}`;
  }

  /**
   * Match URL to template
   */
  private matchesTemplate(url: string, template: string): boolean {
    const normalizedUrl = this.normalizeUrl(url);
    const normalizedTemplate = this.normalizeUrl(template);

    let pattern = normalizedTemplate
      .replace(/\{z\}/g, '__Z__')
      .replace(/\{x\}/g, '__X__')
      .replace(/\{y\}/g, '__Y__')
      .replace(/\{fontstack\}/g, '__FONTSTACK__')
      .replace(/\{range\}/g, '__RANGE__');

    pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    pattern = pattern
      .replace(/__Z__/g, '\\d+')
      .replace(/__X__/g, '\\d+')
      .replace(/__Y__/g, '\\d+')
      .replace(/__FONTSTACK__/g, '[^/]+')
      .replace(/__RANGE__/g, '\\d+-\\d+');

    return new RegExp(`^${pattern}$`).test(normalizedUrl);
  }

  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return url.split('?')[0].split('#')[0];
    }
  }

  // Plugin hooks
  private async runRequestWillFetch(request: Request, event: FetchEvent, state: any): Promise<Request | void> {
    let modifiedRequest = request;
    
    for (const plugin of this.plugins) {
      if (plugin.requestWillFetch) {
        const result = await plugin.requestWillFetch({ request: modifiedRequest, event, state });
        if (result) modifiedRequest = result;
      }
    }
    
    return modifiedRequest;
  }

  private async runFetchDidSucceed(request: Request, response: Response, event: FetchEvent, state: any): Promise<Response | void> {
    let modifiedResponse = response;
    
    for (const plugin of this.plugins) {
      if (plugin.fetchDidSucceed) {
        const result = await plugin.fetchDidSucceed({ request, response: modifiedResponse, event, state });
        if (result) modifiedResponse = result;
      }
    }
    
    return modifiedResponse;
  }

  private async runFetchDidFail(error: Error, request: Request, event: FetchEvent, state: any): Promise<Response | void> {
    for (const plugin of this.plugins) {
      if (plugin.fetchDidFail) {
        const result = await plugin.fetchDidFail({ error, request, event, state });
        if (result) return result;
      }
    }
    
    return undefined;
  }
}
