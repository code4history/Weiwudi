// スタイル・TileJSON の本体の解析と書き換え（仕様 §5.5・§10。m3-t6・R5・R28・R31・R32）。純粋関数だけを置く。
// 値の依存は url_pattern・constants・errors だけ（仕様 §3）。IndexedDB も上流の取得も使わない。
//
// 決まり:
// - モジュール変数を持たない
// - 子になる URL の組（1 つの子になる URL の全部）は styleGroups 1 つで数える。collectStyleRefs（子を作る）と
//   rewriteStyleBody（本体の資格情報の除去）が同じ組を使う（S-N1）
// - 除くのは、組の全部の URL で shouldStrip が真のときの、その組の URL の credentialParams の項目だけ（C-S1・X5・R32）。
//   相対 URL は base で絶対化して判定し、書き戻すときは元の相対の形のまま項目だけを除く
// - 読めない本体は invalid-style を投げる（入力をそのまま返さない。C-S4）。拒否の文面に本体の値を入れない
import { WeiwudiError } from './errors';
import { absolutizeTemplate, stripTemplateParams } from './url_pattern';

/** スタイルが参照する下位資源（子になるもの）。URL は絶対化済み */
export interface StyleRefs {
  /** sources[*].url（vector・raster・raster-dem） */
  tilejson: { name: string; url: string }[];
  /** sources[*].tiles（vector は 'vector'、raster・raster-dem は 'raster'。R31） */
  tiles: {
    name: string; encoding: 'raster' | 'vector'; urls: string[]; scheme?: 'xyz' | 'tms';
    bounds?: number[]; minzoom?: number; maxzoom?: number;
  }[];
  glyphs?: string;
  /** 文字列か {id, url}[] の url */
  sprites: string[];
  /** geojson の data（文字列）・image の url */
  data: { name: string; url: string }[];
  /** 子にしない source（video・知らない type・URL が解決できないもの。R31） */
  skipped: { name: string; reason: 'unsupported-source' }[];
}

/** 本体の資格情報の除去の規則（R32）。子を作るときと同じ判定（credentialTargetOf）で作る */
export interface StripRule {
  credentialParams: readonly string[];
  /** 1 つの組（子になる URL の組。絶対化した URL を受ける）の全部が真のときだけ、その組から除く */
  shouldStrip: (absoluteUrl: string) => boolean;
}

/** TileJSON から読む項目 */
export interface TileJsonRefs {
  urls: string[];
  scheme?: 'xyz' | 'tms';
  bounds?: number[];
  minzoom?: number;
  maxzoom?: number;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const invalidStyle = (type: 'style' | 'tilejson'): WeiwudiError =>
  new WeiwudiError('invalid-style', type === 'style' ? 'The style is not readable' : 'The TileJSON is not readable', { type });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (_e) {
    return undefined;
  }
};

/** スタイルの形: object で version と object の sources を持つ */
const isStyleShape = (v: unknown): v is Obj & { sources: Obj } =>
  isObj(v) && Object.prototype.hasOwnProperty.call(v, 'version') && isObj(v.sources);

/** 絶対化（解決できなければ undefined） */
const absOf = (url: string, base: string): string | undefined => {
  try {
    return absolutizeTemplate(url, base);
  } catch (_e) {
    return undefined;
  }
};

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 範囲の項目（TileJSON とスタイルの source で共通）。形の合うものだけを写す */
const rangeOf = (o: Obj): Pick<TileJsonRefs, 'scheme' | 'bounds' | 'minzoom' | 'maxzoom'> => {
  const out: Pick<TileJsonRefs, 'scheme' | 'bounds' | 'minzoom' | 'maxzoom'> = {};
  if (o.scheme === 'xyz' || o.scheme === 'tms') out.scheme = o.scheme;
  if (Array.isArray(o.bounds) && o.bounds.length === 4 && o.bounds.every(isFiniteNumber)) out.bounds = (o.bounds as number[]).slice();
  if (isFiniteNumber(o.minzoom)) out.minzoom = o.minzoom;
  if (isFiniteNumber(o.maxzoom)) out.maxzoom = o.maxzoom;
  return out;
};

/** 子になる URL の組の 1 つ。set は組の URL を書き戻す（style の object を直に書き換える） */
interface Group {
  slot: 'tilejson' | 'tiles' | 'glyphs' | 'sprite' | 'data';
  /** sources のキー（glyphs・sprite は無し） */
  name?: string;
  urls: string[];
  set: (urls: string[]) => void;
  /** tiles の source（範囲を読む） */
  source?: Obj;
  encoding?: 'raster' | 'vector';
}

const TILE_ENCODING: Readonly<Record<string, 'raster' | 'vector'>> = Object.freeze({
  vector: 'vector', raster: 'raster', 'raster-dem': 'raster',
});

/**
 * 子になる URL の組と、子にしない source（R31）。style は isStyleShape を満たすこと。
 * 組: sources.<キー>.url・sources.<キー>.tiles の全体・glyphs・sprite（配列なら要素ごと）・geojson の文字列の data・image の url
 */
const styleGroups = (style: Obj & { sources: Obj }): { groups: Group[]; unsupported: string[] } => {
  const groups: Group[] = [];
  const unsupported: string[] = [];
  for (const [name, src] of Object.entries(style.sources)) {
    if (!isObj(src)) {
      unsupported.push(name);
      continue;
    }
    const type = typeof src.type === 'string' ? src.type : '';
    const encoding = Object.prototype.hasOwnProperty.call(TILE_ENCODING, type) ? TILE_ENCODING[type] : undefined;
    if (encoding) {
      if (typeof src.url === 'string') groups.push({ slot: 'tilejson', name, urls: [src.url], set: ([u]) => { src.url = u; } });
      if (isStringArray(src.tiles)) groups.push({ slot: 'tiles', name, urls: src.tiles.slice(), set: (us) => { src.tiles = us; }, source: src, encoding });
    } else if (type === 'geojson') {
      // object の data（インライン）は子にしない
      if (typeof src.data === 'string') groups.push({ slot: 'data', name, urls: [src.data], set: ([u]) => { src.data = u; } });
    } else if (type === 'image') {
      if (typeof src.url === 'string') groups.push({ slot: 'data', name, urls: [src.url], set: ([u]) => { src.url = u; } });
    } else {
      // video（Range で取られて保存できない。R31）と知らない type
      unsupported.push(name);
    }
  }
  if (typeof style.glyphs === 'string') groups.push({ slot: 'glyphs', urls: [style.glyphs], set: ([u]) => { style.glyphs = u; } });
  const sprite = style.sprite;
  if (typeof sprite === 'string') {
    groups.push({ slot: 'sprite', urls: [sprite], set: ([u]) => { style.sprite = u; } });
  } else if (Array.isArray(sprite)) {
    for (const item of sprite) {
      if (isObj(item) && typeof item.url === 'string') groups.push({ slot: 'sprite', urls: [item.url], set: ([u]) => { item.url = u; } });
    }
  }
  return { groups, unsupported };
};

/** JSON で、version と object の sources を持つ。外れたら invalid-style */
export function parseStyle(text: string): unknown {
  const v = parseJson(text);
  if (!isStyleShape(v)) throw invalidStyle('style');
  return v;
}

/** スタイルが参照する下位資源（相対 URL はスタイルの URL で解決）。スタイルの形でなければ invalid-style */
export function collectStyleRefs(style: unknown, base: string): StyleRefs {
  if (!isStyleShape(style)) throw invalidStyle('style');
  const refs: StyleRefs = { tilejson: [], tiles: [], sprites: [], data: [], skipped: [] };
  const skip = (name: string) => {
    if (!refs.skipped.some((s) => s.name === name)) refs.skipped.push({ name, reason: 'unsupported-source' });
  };
  const { groups, unsupported } = styleGroups(style);
  for (const name of unsupported) skip(name);
  for (const g of groups) {
    const urls = g.urls.map((u) => absOf(u, base));
    if (urls.some((u) => u === undefined)) {
      // 解決できない URL の source は子にしない（glyphs・sprite は黙って外す）
      if (g.name !== undefined) skip(g.name);
      continue;
    }
    const abs = urls as string[];
    switch (g.slot) {
      case 'tilejson': refs.tilejson.push({ name: g.name!, url: abs[0] }); break;
      case 'tiles': refs.tiles.push({ name: g.name!, encoding: g.encoding!, urls: abs, ...rangeOf(g.source!) }); break;
      case 'glyphs': refs.glyphs = abs[0]; break;
      case 'sprite': refs.sprites.push(abs[0]); break;
      case 'data': refs.data.push({ name: g.name!, url: abs[0] }); break;
    }
  }
  return refs;
}

/** TileJSON の tiles（base で絶対化）と範囲。JSON の object で tiles が配列でなければ undefined */
export function collectTileJson(text: string, base: string): TileJsonRefs | undefined {
  const v = parseJson(text);
  if (!isObj(v) || !Array.isArray(v.tiles)) return undefined;
  const urls = v.tiles
    .map((u) => (typeof u === 'string' ? absOf(u, base) : undefined))
    .filter((u): u is string => u !== undefined);
  return { urls, ...rangeOf(v) };
}

/**
 * 組の全部の URL（base で絶対化）で shouldStrip が真なら、元の形のまま credentialParams の項目を除いた URL の列。
 * 除かない・変わらないときは undefined
 */
const strippedGroup = (urls: readonly string[], base: string, strip: StripRule): string[] | undefined => {
  const abs = urls.map((u) => absOf(u, base));
  if (abs.some((u) => u === undefined || !strip.shouldStrip(u))) return undefined;
  const out = urls.map((u) => stripTemplateParams(u, strip.credentialParams));
  return out.some((u, i) => u !== urls[i]) ? out : undefined;
};

/**
 * スタイルの本体を書き換える（R28）: 提供元の rewriteStyle を当て、strip があれば子の組の単位で資格情報の項目を除く（R32）。
 * どちらも無く変わらなければ入力と同じ文字列。読めない本体・rewriteStyle の結果がスタイルの形でなければ invalid-style
 */
export function rewriteStyleBody(
  text: string, base: string, o: { rewriteStyle?: (s: unknown) => unknown; strip?: StripRule },
): string {
  let style = parseStyle(text) as Obj & { sources: Obj };
  let changed = false;
  if (o.rewriteStyle) {
    const next = o.rewriteStyle(style);
    if (!isStyleShape(next)) throw invalidStyle('style');
    // 書き換えた object を直に変えない（提供元が入力の部分を共有していても、写しの上で除く）
    style = parseJson(JSON.stringify(next)) as Obj & { sources: Obj };
    if (!isStyleShape(style)) throw invalidStyle('style');
    changed = true;
  }
  if (o.strip) {
    for (const g of styleGroups(style).groups) {
      const out = strippedGroup(g.urls, base, o.strip);
      if (!out) continue;
      g.set(out);
      changed = true;
    }
  }
  return changed ? JSON.stringify(style) : text;
}

/**
 * TileJSON の本体を書き換える（R28）: strip があれば tiles の全体を 1 つの組として資格情報の項目を除く（R32）。
 * 変わらなければ入力と同じ文字列。JSON の object で tiles が配列でなければ invalid-style（detail.type: 'tilejson'）
 */
export function rewriteTileJsonBody(text: string, base: string, o: { strip?: StripRule }): string {
  const v = parseJson(text);
  if (!isObj(v) || !Array.isArray(v.tiles)) throw invalidStyle('tilejson');
  if (!o.strip || !isStringArray(v.tiles)) return text;
  const out = strippedGroup(v.tiles, base, o.strip);
  if (!out) return text;
  v.tiles = out;
  return JSON.stringify(v);
}

/**
 * 親の資格情報を受け取る URL か（R5）。子を作るとき（t7）と本体の除去（R32）の両方がこれを使う。
 * スタイルの URL と同じオリジンか、親の提供元の matches に当たる（投げたら当たらない）
 */
export function credentialTargetOf(o: { styleOrigin: string; providerMatches?: (url: string) => boolean }): (absoluteUrl: string) => boolean {
  return (absoluteUrl) => {
    let origin: string | undefined;
    try {
      origin = new URL(absoluteUrl.replace(/\{[^{}]*\}/g, '0')).origin;
    } catch (_e) {
      origin = undefined;
    }
    if (origin !== undefined && origin !== 'null' && origin === o.styleOrigin) return true;
    if (!o.providerMatches) return false;
    try {
      return o.providerMatches(absoluteUrl) === true;
    } catch (_e) {
      return false;
    }
  };
}
