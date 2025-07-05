export interface WeiwudiOptions {
  type: 'xyz' | 'wmts';
  url: string | string[];
  width?: number;
  height?: number;
  tileSize?: number;
  minZoom?: number;
  maxZoom?: number;
  maxLng?: number;
  maxLat?: number;
  minLng?: number;
  minLat?: number;
}

export interface WeiwudiMapAttributes extends WeiwudiOptions {
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
}

export interface WeiwudiStats {
  count: number;
  size: number;
}

export interface WeiwudiEvent extends CustomEvent {
  detail: {
    mapID: string;
    type: string;
    [key: string]: any;
  };
}

export interface TileRange {
  minZoom: number;
  maxZoom: number;
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

export interface VectorTileOptions {
  definition?: string;
  styles?: string;
  fonts?: string;
  icons?: string;
}