import { describe, it, expect } from 'vitest';
import {
  MERC_MAX,
  lngToMercX,
  latToMercY,
  lngLatBoundsToTileBox,
  scaleTileBox,
  isInTileBox,
  countTiles,
  enumerateTiles,
  maxZoomForPixelSize,
  pixelSizeToTileBox,
  expandTileTemplate,
  tileKeySuffix,
} from '../../src/tile_math';

// 期待値は weiwudi_gw_logic.ts の現行の式で計算した値（#34。新しい実装から書き写さない）

describe('メルカトル変換', () => {
  it('MERC_MAX は現行の定数', () => {
    expect(MERC_MAX).toBe(20037508.342789244);
  });

  it('lngToMercX・latToMercY は現行の式の値', () => {
    expect(lngToMercX(180)).toBe(20037508.34278924);
    expect(latToMercY(0)).toBe(-7.081154551613622e-10);
    // 現行の式は 90 度で Infinity にならず有限の値を返す（癖として残す）
    expect(latToMercY(90)).toBe(238107693.26496765);
  });
});

describe('lngLatBoundsToTileBox', () => {
  const bounds = { minLng: 139.7, maxLng: 139.8, minLat: 35.6, maxLat: 35.7 };

  it('WMTS_ADD と同じ入力で既存試験の期待値と一致する', () => {
    expect(lngLatBoundsToTileBox(bounds, 12)).toEqual({ minX: 3637, maxX: 3638, minY: 1612, maxY: 1614 });
  });

  it('zoom が無いときは NaN のまま（現行の Math.pow(2, undefined) の動き）', () => {
    const box = lngLatBoundsToTileBox(bounds, undefined as unknown as number);
    expect(box.minX).toBeNaN();
    expect(box.maxX).toBeNaN();
    expect(box.minY).toBeNaN();
    expect(box.maxY).toBeNaN();
  });
});

describe('scaleTileBox・isInTileBox', () => {
  const box = { minX: 0, maxX: 3, minY: 0, maxY: 3 };

  it('maxZoom 2 の範囲を各 z へ縮める', () => {
    expect(scaleTileBox(box, 2, 0)).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
    expect(scaleTileBox(box, 2, 1)).toEqual({ minX: 0, maxX: 1, minY: 0, maxY: 1 });
    expect(scaleTileBox(box, 2, 2)).toEqual(box);
  });

  it('奇数の端は floor で縮む', () => {
    expect(scaleTileBox({ minX: 3637, maxX: 3638, minY: 1612, maxY: 1614 }, 12, 10))
      .toEqual({ minX: 909, maxX: 909, minY: 403, maxY: 403 });
  });

  it('範囲の内外を判定する（端を含む）', () => {
    expect(isInTileBox(box, 0, 0)).toBe(true);
    expect(isInTileBox(box, 3, 3)).toBe(true);
    expect(isInTileBox(box, 4, 0)).toBe(false);
    expect(isInTileBox(box, 0, -1)).toBe(false);
  });
});

describe('countTiles・enumerateTiles', () => {
  it('1024×1024（tileSize 256）→ 21', () => {
    const box = pixelSizeToTileBox(1024, 1024, 256);
    expect(countTiles(box, 0, maxZoomForPixelSize(1024, 1024, 256))).toBe(21);
  });

  it('1000×500 → 11', () => {
    const box = pixelSizeToTileBox(1000, 500, 256);
    expect(countTiles(box, 0, maxZoomForPixelSize(1000, 500, 256))).toBe(11);
  });

  it('WMTS_ADD の z10〜12 → 11', () => {
    expect(countTiles({ minX: 3637, maxX: 3638, minY: 1612, maxY: 1614 }, 10, 12)).toBe(11);
  });

  it('z→x→y の順に列挙し、件数が countTiles と一致する', () => {
    const box = pixelSizeToTileBox(1000, 500, 256);
    const tiles = [...enumerateTiles(box, 0, 2)];
    expect(tiles.slice(0, 5)).toEqual([[0, 0, 0], [1, 0, 0], [1, 1, 0], [2, 0, 0], [2, 0, 1]]);
    expect(tiles[tiles.length - 1]).toEqual([2, 3, 1]);
    expect(tiles.length).toBe(countTiles(box, 0, 2));
  });

  it('最初の値を取って止めれば、巨大な範囲でも残りを計算しない', () => {
    const huge = { minX: 0, maxX: 2 ** 30, minY: 0, maxY: 2 ** 30 };
    const start = Date.now();
    const first = enumerateTiles(huge, 0, 30).next();
    expect(first.value).toEqual([0, 0, 0]);
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe('maxZoomForPixelSize・pixelSizeToTileBox', () => {
  it('1000×500 → maxZoom 2・maxX 3・maxY 1', () => {
    expect(maxZoomForPixelSize(1000, 500, 256)).toBe(2);
    expect(pixelSizeToTileBox(1000, 500, 256)).toEqual({ minX: 0, maxX: 3, minY: 0, maxY: 1 });
  });
});

describe('expandTileTemplate', () => {
  it('{z}{x}{y} を展開する', () => {
    expect(expandTileTemplate('t/{z}/{x}/{y}.png', 2, 1, 3)).toBe('t/2/1/3.png');
  });

  it('{-y} は 2^z - y - 1 に反転する', () => {
    expect(expandTileTemplate('t/{z}/{x}/{-y}.png', 2, 1, 0)).toBe('t/2/1/3.png');
  });

  it('字句が 2 回あるときは最初の 1 回だけ置換する', () => {
    expect(expandTileTemplate('{z}/{x}/{y}?z={z}', 2, 1, 3)).toBe('2/1/3?z={z}');
  });
});

// ---- m2-t3: 展開の拡張（R6）と tileKeySuffix（R2） ----

// BASE（f08046a）の expandTileTemplate の本体をそのまま写したもの。opts なしの呼び出しはこれと 1 字も変わらない
const baseExpand = (template: string, z: number, x: number, y: number) => {
  return template.replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{-y}', String(Math.pow(2, z) - y - 1));
};

describe('expandTileTemplate の opts なし（旧 API の呼び出し）は BASE と同じ', () => {
  it.each([
    't/{z}/{x}/{y}.png',
    't/{z}/{x}/{-y}.png',
    '{z}/{x}/{y}?z={z}&x={x}',
    'https://a.example/{quadkey}/{prefix}/{z}/{x}/{y}{ratio}.png',
    'https://a.example/{-y}/{y}/{-y}',
    'no-token',
    '',
  ])('%s', (t) => {
    for (const [z, x, y] of [[0, 0, 0], [2, 1, 3], [5, 17, 30], [12, 3639, 1612]]) {
      expect(expandTileTemplate(t, z, x, y)).toBe(baseExpand(t, z, x, y));
    }
  });
});

describe('expandTileTemplate の opts', () => {
  it('{ all: true } は全出現を置換する', () => {
    expect(expandTileTemplate('{z}/{x}/{y}?z={z}&x={x}&y={y}&r={-y}&r2={-y}', 2, 1, 3, { all: true }))
      .toBe('2/1/3?z=2&x=1&y=3&r=0&r2=0');
  });

  it('opts があり all が無ければ、各字句の最初の出現だけを置換する', () => {
    expect(expandTileTemplate('{quadkey}/{quadkey}/{z}/{z}', 2, 1, 3, {})).toBe('23/{quadkey}/2/{z}');
  });

  it('{quadkey} は Bing の 4 進の鍵（z 0 は空文字）', () => {
    expect(expandTileTemplate('q/{quadkey}', 3, 3, 5, { all: true })).toBe('q/213');
    expect(expandTileTemplate('q/{quadkey}', 1, 0, 0, { all: true })).toBe('q/0');
    expect(expandTileTemplate('q/{quadkey}', 0, 0, 0, { all: true })).toBe('q/');
  });

  it('{prefix} は (x % 16) と (y % 16) の 16 進 1 字ずつ', () => {
    expect(expandTileTemplate('{prefix}', 10, 31, 250, { all: true })).toBe('fa');
    expect(expandTileTemplate('{prefix}', 10, 1, 2, { all: true })).toBe('12');
  });

  it('{ratio} は opts.ratio（既定は空文字）', () => {
    expect(expandTileTemplate('{z}/{x}/{y}{ratio}.png', 1, 0, 1, { all: true, ratio: '@2x' })).toBe('1/0/1@2x.png');
    expect(expandTileTemplate('{z}/{x}/{y}{ratio}.png', 1, 0, 1, { all: true })).toBe('1/0/1.png');
  });

  it('グリフの字句（{fontstack}・{range}）は展開しない', () => {
    expect(expandTileTemplate('{fontstack}/{range}.pbf', 1, 0, 0, { all: true })).toBe('{fontstack}/{range}.pbf');
  });
});

describe('tileKeySuffix', () => {
  it('<z>_<x>_<y>。ratio が @2x なら @2x を後ろに付け、空・省略なら付けない', () => {
    expect(tileKeySuffix(2, 1, 3)).toBe('2_1_3');
    expect(tileKeySuffix(2, 1, 3, '')).toBe('2_1_3');
    expect(tileKeySuffix(2, 1, 3, '@2x')).toBe('2_1_3@2x');
  });

  it('旧キー（weiwudi_gw_logic の `${z}_${x}_${y}`）と同じ形', () => {
    const [z, x, y] = [12, 3639, 1612];
    expect(tileKeySuffix(z, x, y)).toBe(`${z}_${x}_${y}`);
  });
});
