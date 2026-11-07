// スタイル・TileJSON の本体の解析と書き換え（仕様 §5.5・§10。m3-t6・R5・R28・R31・R32）。純粋関数だけを置く。
// 値の依存は url_pattern・constants・errors だけ（仕様 §3）。IndexedDB も上流の取得も使わない。
//
// 決まり:
// - モジュール変数を持たない
// - 子になる URL の組（1 つの子になる URL の全部）は childGroups 1 つで数える。collectStyleRefs（子を作る）と
//   rewriteStyleBody（本体の資格情報の除去）が同じ組を使う（S-N1）
// - 子として受けられない組（型の字句の許可に外れる・compile できない。url_pattern.tokenRejection）は子にせず、除去もしない。
//   1 つでも外れる組を持つ source は、source ごと skipped にする（L1 Major-1・Minor-3）。source を持たない
//   glyphs・sprite の組は dropped に種類と論理名だけを残す（subject に URL・トークンを入れない。仕様 §12）
// - 除くのは、組の全部の URL で shouldStrip が真のときの、その組の URL の credentialParams の項目だけ（C-S1・X5・R32）。
//   除くのは登録した資格情報の値（StripRule.credentialValues）と同じ値の項目だけ（違う値・登録の無い名前は子の固有の
//   トークンなので本体に残し、normalizeMember で子の資格情報に移る）。相対 URL は base で絶対化して判定し、書き戻すときは元の相対の形のまま項目だけを除く
// - 読めない本体は invalid-style を投げる（入力をそのまま返さない。C-S4）。拒否の文面に本体の値を入れない
import { WeiwudiError } from './errors';
import type { ResourceType } from './store';
import { absolutizeTemplate, compileTemplate, spriteTemplateOf, stripTemplateParams, tokenRejection } from './url_pattern';

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
  /** sprites と同じ並びの id（{id, url}[] の id。文字列の sprite は undefined。子の論理名に使う。m3-t7） */
  spriteIds: (string | undefined)[];
  /** geojson の data（文字列）・image の url */
  data: { name: string; url: string }[];
  /** 子にしない source（video・知らない type・URL が解決できないもの。R31） */
  skipped: { name: string; reason: 'unsupported-source' }[];
  /** 子にできなかった glyphs・sprite（種類と論理名だけ。URL・トークンを入れない。仕様 §12 の unsupported-source の subject） */
  dropped: DroppedRef[];
}

/** 子にできなかった glyphs・sprite の組（source を持たないので skipped に入らない分。仕様 §12） */
export interface DroppedRef {
  slot: 'glyphs' | 'sprite';
  /** sprite の {id, url}[] の id（文字列の sprite は undefined） */
  spriteId?: string;
}

/** 本体の資格情報の除去の規則（R32）。子を作るときと同じ判定（credentialTargetOf）で作る */
export interface StripRule {
  credentialParams: readonly string[];
  /**
   * 登録した資格情報の値（親の credentials.query）。本体の項目は、名前が credentialParams にあり値がこの値と同じときだけ除く
   * （違う値・登録の無い名前＝子の固有のトークンは本体に残し、子の資格情報に移る。§10 R32）
   */
  credentialValues: Readonly<Record<string, string>>;
  /** 1 つの組（子になる URL の組。絶対化した URL を受ける）の全部が真のときだけ、その組から除く */
  shouldStrip: (absoluteUrl: string) => boolean;
  /** 組を子として受けるか（spec.acceptsMember。normalizeMember だけが拒否する組を、子作りと除去で揃える。m3-t7） */
  accepts?: MemberAcceptor;
}

/**
 * 子の URL の組（型の子のテンプレート。sprite は base＋{spriteSuffix}）を子として受けるか（m3-t7）。
 * 配線と style.ts が spec.acceptsMember を渡す。無ければ字句の許可（tokenRejection）だけで見る
 */
export type MemberAcceptor = (type: ResourceType, templates: string[]) => boolean;

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

/** 組の置き場所ごとの子の Resource の型 */
const SLOT_TYPE: Readonly<Record<'tilejson' | 'tiles' | 'glyphs' | 'sprite' | 'data', ResourceType>> = Object.freeze({
  tilejson: 'tilejson', tiles: 'tile', glyphs: 'glyph', sprite: 'sprite', data: 'data',
});

/**
 * 絶対化した URL が、その型の子のテンプレートとして受けられるか（L1 Major-1）。userinfo が無く、compileTemplate が通り、字句がその型の許可の範囲
 * （url_pattern.tokenRejection。spec.ts の登録の検査と同じ表）にあること。sprite は子のテンプレート（base＋{spriteSuffix}）で見る
 */
const acceptsAsChild = (type: ResourceType, absoluteUrl: string): boolean => {
  try {
    // userinfo（user:pass@）は登録の検査（spec.checkTemplate）と同じく受けない。accepts が無くても子作りと除去で揃う（L2 B）
    const u = new URL(absoluteUrl.replace(/\{[^{}]*\}/g, '0'));
    if (u.username !== '' || u.password !== '') return false;
    return tokenRejection(type, compileTemplate(type === 'sprite' ? spriteTemplateOf(absoluteUrl) : absoluteUrl)) === undefined;
  } catch (_e) {
    return false;
  }
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
  /** sprite の {id, url}[] の id（m3-t7） */
  spriteId?: string;
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
      if (isObj(item) && typeof item.url === 'string') {
        groups.push({
          slot: 'sprite', urls: [item.url], set: ([u]) => { item.url = u; },
          ...(typeof item.id === 'string' ? { spriteId: item.id } : {}),
        });
      }
    }
  }
  return { groups, unsupported };
};

/**
 * 子として受けられる組（abs は絶対化した URL）と、子にしない source の名前と、子にできなかった glyphs・sprite。
 * source は組が 1 つでも外れたら丸ごと外す（Minor-3）。accepts があれば組の単位でも見る（R22 のミラーの値の食い違い・
 * userinfo・sk. など。m3-t7）
 */
const childGroups = (
  style: Obj & { sources: Obj }, base: string, accepts?: MemberAcceptor,
): { groups: (Group & { abs: string[] })[]; skipped: string[]; dropped: DroppedRef[] } => {
  const { groups, unsupported } = styleGroups(style);
  const skipped = unsupported.slice();
  const dropped: DroppedRef[] = [];
  const ok: (Group & { abs: string[] })[] = [];
  for (const g of groups) {
    const abs = g.urls.map((u) => absOf(u, base));
    const type = SLOT_TYPE[g.slot];
    if (abs.every((u): u is string => u !== undefined && acceptsAsChild(type, u))
      && (!accepts || accepts(type, (abs as string[]).map((u) => (type === 'sprite' ? spriteTemplateOf(u) : u))))) {
      ok.push({ ...g, abs: abs as string[] });
    } else if (g.name !== undefined) {
      // 解決できない・受けられない URL の source は子にしない
      if (skipped.indexOf(g.name) < 0) skipped.push(g.name);
    } else if (g.slot === 'glyphs' || g.slot === 'sprite') {
      // glyphs・sprite は source を持たない。外した組の種類と論理名だけを残す（subject に URL・トークンを入れない）
      dropped.push(g.slot === 'glyphs'
        ? { slot: g.slot }
        : { slot: g.slot, ...(g.spriteId !== undefined ? { spriteId: g.spriteId } : {}) });
    }
  }
  return { groups: ok.filter((g) => g.name === undefined || skipped.indexOf(g.name) < 0), skipped, dropped };
};

/** JSON で、version と object の sources を持つ。外れたら invalid-style */
export function parseStyle(text: string): unknown {
  const v = parseJson(text);
  if (!isStyleShape(v)) throw invalidStyle('style');
  return v;
}

/**
 * スタイルが参照する下位資源（相対 URL はスタイルの URL で解決）。スタイルの形でなければ invalid-style。
 * accepts は組を子として受けるかの判定（本体の除去の StripRule.accepts と同じもの。m3-t7）
 */
export function collectStyleRefs(style: unknown, base: string, accepts?: MemberAcceptor): StyleRefs {
  if (!isStyleShape(style)) throw invalidStyle('style');
  const { groups, skipped, dropped } = childGroups(style, base, accepts);
  const refs: StyleRefs = {
    tilejson: [], tiles: [], sprites: [], spriteIds: [], data: [],
    skipped: skipped.map((name) => ({ name, reason: 'unsupported-source' as const })),
    dropped,
  };
  for (const g of groups) {
    const { abs } = g;
    switch (g.slot) {
      case 'tilejson': refs.tilejson.push({ name: g.name!, url: abs[0] }); break;
      case 'tiles': refs.tiles.push({ name: g.name!, encoding: g.encoding!, urls: abs, ...rangeOf(g.source!) }); break;
      case 'glyphs': refs.glyphs = abs[0]; break;
      case 'sprite': refs.sprites.push(abs[0]); refs.spriteIds.push(g.spriteId); break;
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
 * 子として受けられる組（childGroups が絶対化した abs）の全部で shouldStrip が真なら、元の形のまま credentialParams の項目
 * のうち credentialValues と同じ値のものだけを除いた URL の列（判定は stripTemplateParams の 1 か所。§10 R32）。除かない・変わらないときは undefined
 */
const strippedGroup = (urls: readonly string[], abs: readonly string[], strip: StripRule): string[] | undefined => {
  if (abs.some((u) => !strip.shouldStrip(u))) return undefined;
  const out = urls.map((u) => stripTemplateParams(u, strip.credentialParams, strip.credentialValues));
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
    for (const g of childGroups(style, base, o.strip.accepts).groups) {
      const out = strippedGroup(g.urls, g.abs, o.strip);
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
  const abs = v.tiles.map((u) => absOf(u, base));
  if (!abs.every((u): u is string => u !== undefined && acceptsAsChild('tile', u))) return text;
  if (o.strip.accepts && !o.strip.accepts('tile', abs as string[])) return text;
  const out = strippedGroup(v.tiles, abs, o.strip);
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

/**
 * MapLibre の式の演算子（collectFonts が text-font の式を飛ばすための判定。先頭がこれらの文字列の配列は式）。
 * フォント名と取り違えないよう、式の仕様の名前だけを並べる（m4-t4・R53）
 */
const EXPRESSION_OPERATORS: ReadonlySet<string> = new Set([
  'array', 'boolean', 'collator', 'format', 'image', 'literal', 'number', 'number-format', 'object', 'string',
  'to-boolean', 'to-color', 'to-number', 'to-string', 'typeof', 'accumulated', 'feature-state', 'geometry-type', 'id',
  'line-progress', 'properties', 'at', 'config', 'get', 'has', 'in', 'index-of', 'length', 'slice', 'split', 'join',
  '!', '!=', '<', '<=', '==', '>', '>=', 'all', 'any', 'case', 'coalesce', 'match', 'within', 'distance', 'global-state',
  'interpolate', 'interpolate-hcl', 'interpolate-lab', 'step', 'let', 'var', 'concat', 'downcase', 'is-supported-script',
  'resolved-locale', 'upcase', 'rgb', 'rgba', 'to-rgba', '-', '*', '/', '%', '^', '+', 'abs', 'acos', 'asin', 'atan',
  'ceil', 'cos', 'e', 'floor', 'ln', 'ln2', 'log10', 'log2', 'max', 'min', 'pi', 'round', 'sin', 'sqrt', 'tan', 'zoom',
  'heatmap-density', 'elevation',
]);

/** text-font の値の fontstack（文字列の配列か ["literal", [文字列…]]。式・関数の object は undefined） */
const fontstackOf = (v: unknown): string | undefined => {
  let list = v;
  if (Array.isArray(v) && v.length === 2 && v[0] === 'literal' && Array.isArray(v[1])) list = v[1];
  else if (Array.isArray(v) && typeof v[0] === 'string' && EXPRESSION_OPERATORS.has(v[0])) return undefined;
  return isStringArray(list) ? list.join(',') : undefined;
};

/**
 * スタイルの layers[*].layout['text-font'] の fontstack（m4-t4・R53）。文字列の配列と ["literal", [文字列…]] を集め、
 * 配列を , で結んで 1 つの fontstack にする（MapLibre が {fontstack} に入れる形）。式は飛ばす。重複を除き、最初に現れた順
 */
export function collectFonts(style: unknown): string[] {
  const out: string[] = [];
  const layers = isObj(style) && Array.isArray(style.layers) ? style.layers : [];
  for (const layer of layers) {
    const layout = isObj(layer) ? layer.layout : undefined;
    const fontstack = isObj(layout) ? fontstackOf(layout['text-font']) : undefined;
    if (fontstack !== undefined && out.indexOf(fontstack) < 0) out.push(fontstack);
  }
  return out;
}
