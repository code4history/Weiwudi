// 座標・タイル計算（#34）。依存を持たない純粋関数だけを置く（DOM・SW の型を使わない）。
// weiwudi_gw_logic.ts の現行の式をそのまま移した。癖（呼び出し側の `|| 0` の既定・
// zoom が無いときの NaN・latToMercY(90) の値）は直さない。

export interface TileBox { minX: number; maxX: number; minY: number; maxY: number }

export const MERC_MAX = 20037508.342789244;

export const lngToMercX = (lng: number) => { return 6378137 * lng * Math.PI / 180 };
export const latToMercY = (lat: number) => { return 6378137 * Math.log(Math.tan(Math.PI / 360 * (90 + lat))) };

/** 経緯度の範囲 → zoom でのタイル範囲。現行の wmts の丸めと同じ */
export const lngLatBoundsToTileBox = (
  b: { minLng: number; maxLng: number; minLat: number; maxLat: number }, zoom: number
): TileBox => {
  const maxMercX = lngToMercX(b.maxLng);
  const minMercX = lngToMercX(b.minLng);
  const maxMercY = latToMercY(b.maxLat);
  const minMercY = latToMercY(b.minLat);
  return {
    minX: Math.floor((MERC_MAX + minMercX) / (2 * MERC_MAX) * Math.pow(2, zoom)),
    maxX: Math.floor((MERC_MAX + maxMercX) / (2 * MERC_MAX) * Math.pow(2, zoom)),
    minY: Math.floor((MERC_MAX - maxMercY) / (2 * MERC_MAX) * Math.pow(2, zoom)),
    maxY: Math.floor((MERC_MAX - minMercY) / (2 * MERC_MAX) * Math.pow(2, zoom)),
  };
};

/** maxZoom での範囲を z へ縮める */
export const scaleTileBox = (box: TileBox, maxZoom: number, z: number): TileBox => {
  const factor = Math.pow(2, maxZoom - z);
  return {
    minX: Math.floor(box.minX / factor),
    maxX: Math.floor(box.maxX / factor),
    minY: Math.floor(box.minY / factor),
    maxY: Math.floor(box.maxY / factor),
  };
};

export const isInTileBox = (box: TileBox, x: number, y: number) => {
  return !(x < box.minX || x > box.maxX || y < box.minY || y > box.maxY);
};

/** minZoom〜maxZoom の総タイル数 */
export const countTiles = (box: TileBox, minZoom: number, maxZoom: number) => {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const b = scaleTileBox(box, maxZoom, z);
    total += (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1);
  }
  return total;
};

/** z 昇順 → x 昇順 → y 昇順。配列を作らない生成器 */
export function* enumerateTiles(box: TileBox, minZoom: number, maxZoom: number): Generator<[z: number, x: number, y: number]> {
  for (let z = minZoom; z <= maxZoom; z++) {
    const b = scaleTileBox(box, maxZoom, z);
    for (let x = b.minX; x <= b.maxX; x++) {
      for (let y = b.minY; y <= b.maxY; y++) {
        yield [z, x, y];
      }
    }
  }
}

/** ピクセル寸法の地図の maxZoom */
export const maxZoomForPixelSize = (width: number, height: number, tileSize: number) => {
  const calcZoom = (v: number) => { return Math.ceil(Math.log(v / tileSize) / Math.log(2)) };
  return Math.max(calcZoom(width), calcZoom(height));
};

export const pixelSizeToTileBox = (width: number, height: number, tileSize: number): TileBox => {
  return {
    minX: 0,
    maxX: Math.ceil(width / tileSize) - 1,
    minY: 0,
    maxY: Math.ceil(height / tileSize) - 1,
  };
};

/** {z}{x}{y}{-y} の展開。各字句は最初の 1 回だけ置換する（String.replace のまま） */
export const expandTileTemplate = (template: string, z: number, x: number, y: number) => {
  return template.replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{-y}', String(Math.pow(2, z) - y - 1));
};
