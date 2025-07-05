/**
 * Cache specification v1 types
 * URL-based resource management system
 */

export interface Resource {
  url: string;                    // Primary key (actual URL)
  urlTemplate?: string;           // Template URL for tiles
  type: "style" | "tile" | "sprite" | "font" | "geojson";
  metadata?: {
    styleId?: string;             // Which style this belongs to
    tileset?: string;             // Tileset identifier
    bounds?: [number, number, number, number];  // [west, south, east, north]
    minzoom?: number;
    maxzoom?: number;
  };
  lastAccessed: number;           // For LRU
  size: number;                   // Cache size
  headers?: Record<string, string>;
  protected?: boolean;            // Protected from auto-deletion
}

export interface CacheEntry {
  url: string;                    // Primary key (expanded URL)
  resourceUrl: string;            // Parent resource URL
  data: Blob;                     // Actual data
  headers: Record<string, string>;
  etag?: string;
  expires?: number;
  lastModified?: string;
  created: number;
  size: number;
}

export interface Settings {
  key: string;                    // Primary key
  value: any;
}

export interface QuotaOptions {
  maxCacheSize?: number;          // Bytes (default: 500MB)
  maxResourceSize?: number;       // Per-resource max size (default: 50MB)
  alertThreshold?: number;        // Alert threshold (default: 0.9 = 90%)
}

export interface AutoCleanupOptions {
  enabled?: boolean;              // Default: false
  strategy?: 'lru' | 'lfu';       // Default: 'lru'
  targetPercentage?: number;      // Cleanup target (default: 0.7 = 70%)
}

export interface WeiwudiOptions {
  autoRegisterAssets?: boolean;   // Default: true
  mapboxAccessToken?: string;     // Mapbox access token (pk.* only)
  type?: string;                  // Resource type for registration
  metadata?: any;                 // Additional metadata for resource
}

export interface WeiwudiPlugin {
  // Workbox-compatible lifecycle hooks
  requestWillFetch?: (params: {
    request: Request;
    event: FetchEvent;
    state: any;
  }) => Promise<Request | void>;
  
  fetchDidSucceed?: (params: {
    request: Request;
    response: Response;
    event: FetchEvent;
    state: any;
  }) => Promise<Response | void>;
  
  fetchDidFail?: (params: {
    error: Error;
    request: Request;
    event: FetchEvent;
    state: any;
  }) => Promise<Response | void>;
  
  // Weiwudi-specific hooks
  resourceWillRegister?: (params: {
    resource: Resource;
  }) => Promise<Resource | void>;
  
  cacheWillClean?: (params: {
    resources: Resource[];
    reason: 'manual' | 'lru' | 'quota';
  }) => Promise<Resource[] | void>;
}

export interface StorageUsage {
  used: number;
  quota: number;
  percentage: number;
  resources: number;
}