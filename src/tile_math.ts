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

/** expandTileTemplate の新 API 向けの指定（R6。展開の実装は新旧で 1 つ） */
export interface ExpandOptions {
  /** 全出現を置換する。無ければ各字句の最初の出現だけ */
  all?: boolean;
  /** {ratio} の値（'' か '@2x'）。既定は '' */
  ratio?: string;
}

/** Bing の quadkey（z 桁の 4 進。z 0 は空文字） */
export const tileToQuadkey = (z: number, x: number, y: number): string => {
  let key = '';
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    key += String(((x & mask) !== 0 ? 1 : 0) + ((y & mask) !== 0 ? 2 : 0));
  }
  return key;
};

/** {prefix} の値: (x % 16) と (y % 16) の 16 進 1 字ずつ */
export const tilePrefix = (x: number, y: number): string => (x % 16).toString(16) + (y % 16).toString(16);

const replaceToken = (s: string, token: string, value: string, all: boolean): string =>
  all ? s.split(token).join(value) : s.replace(token, () => value);

/**
 * テンプレートの展開。
 * - opts なし（旧 API）: {z}{x}{y}{-y} の各字句を最初の 1 回だけ置換する（String.replace のまま。BASE と 1 字も変えない）
 * - opts あり（新 API）: 上の 4 字句に {quadkey}・{prefix}・{ratio} を足す。opts.all なら全出現を置換する。
 *   グリフの {fontstack}・{range} は展開しない
 */
export const expandTileTemplate = (template: string, z: number, x: number, y: number, opts?: ExpandOptions) => {
  if (!opts) {
    return template.replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y))
      .replace('{-y}', String(Math.pow(2, z) - y - 1));
  }
  const all = opts.all === true;
  const pairs: [string, string][] = [
    ['{z}', String(z)],
    ['{x}', String(x)],
    ['{y}', String(y)],
    ['{-y}', String(Math.pow(2, z) - y - 1)],
    ['{quadkey}', tileToQuadkey(z, x, y)],
    ['{prefix}', tilePrefix(x, y)],
    ['{ratio}', opts.ratio ?? ''],
  ];
  return pairs.reduce((s, [token, value]) => replaceToken(s, token, value, all), template);
};

/** タイルのキーの suffix（仕様 §5.3・R2。新旧で 1 つ）。`<z>_<x>_<y>`、ratio が '@2x' なら `<z>_<x>_<y>@2x` */
export const tileKeySuffix = (z: number, x: number, y: number, ratio?: string): string =>
  `${z}_${x}_${y}${ratio === '@2x' ? '@2x' : ''}`;
