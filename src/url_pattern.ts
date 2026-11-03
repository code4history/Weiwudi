// テンプレートの解析・照合・正規化・キー（仕様 §4.2・§5.1・§5.3。m2-t3）。
// 値の依存は tile_math と errors だけ（仕様 §3）。展開の関数は置かない（tile_math.expandTileTemplate が唯一。R6）。
//
// 決まり:
// - モジュール変数を持たない。正規表現は関数の中で作る（/g の lastIndex を共有しない）
// - 拒否の文面にテンプレートの URL を入れない（クエリの資格情報や userinfo を文面へ出さない。仕様 §10）
import type { ResourceType } from './store';
import { WeiwudiError } from './errors';
import { tileKeySuffix, tilePrefix } from './tile_math';

/** 既定の資格情報のクエリ項目（仕様 §5.3）。登録の credentialParams で足せる */
export const DEFAULT_CREDENTIAL_PARAMS: readonly string[] = Object.freeze([
  'access_token', 'token', 'key', 'api_key', 'apikey', 'sku',
]);

/** 照合する zoom の上限。これより大きい z の要求は照合しない（座標の計算が 2^z で溢れないため） */
export const MAX_TILE_ZOOM = 30;

/** テンプレートの字句（仕様 §4.2 の 9 つ） */
export type TokenName = 'z' | 'x' | 'y' | '-y' | 'quadkey' | 'ratio' | 'prefix' | 'fontstack' | 'range';

/** タイルの字句（raster・vector のテンプレートに使えるもの） */
export const TILE_TOKENS: readonly TokenName[] = Object.freeze(['z', 'x', 'y', '-y', 'quadkey', 'ratio', 'prefix'] as TokenName[]);

const tokenPattern = (t: TokenName): string => {
  switch (t) {
    case 'z': case 'x': case 'y': case '-y': return '(\\d{1,10})';
    case 'quadkey': return `([0-3]{0,${MAX_TILE_ZOOM}})`;
    case 'ratio': return '(@2x)?';
    case 'prefix': return '([0-9a-fA-F]{2})';
    case 'fontstack': return '([^/]+)';
    case 'range': return '(\\d+-\\d+)';
  }
};

const isTokenName = (s: string): s is TokenName =>
  s === 'z' || s === 'x' || s === 'y' || s === '-y' || s === 'quadkey' || s === 'ratio'
  || s === 'prefix' || s === 'fontstack' || s === 'range';

export interface CompiledTemplate {
  /** 元のテンプレート */
  readonly template: string;
  readonly origin: string;
  /** pathname 全体の照合（/g なし） */
  readonly pathRe: RegExp;
  readonly pathTokens: readonly TokenName[];
  /** 値全体が 1 字句のクエリ項目 */
  readonly queryTokens: readonly { readonly name: string; readonly token: TokenName; readonly re: RegExp }[];
  /** 固定値のクエリ項目 */
  readonly queryFixed: readonly { readonly name: string; readonly value: string }[];
  readonly tokens: ReadonlySet<TokenName>;
  /** z・x・y をすべて取れる */
  readonly tile: boolean;
}

export interface MatchResult {
  z?: number;
  x?: number;
  y?: number;
  /** {ratio} があるときだけ。'' か '@2x' */
  ratio?: string;
  /** percent-decode した値（崩れた % はそのまま） */
  fontstack?: string;
  range?: string;
  /** 照合に使ったクエリ項目の名前（キーから除く） */
  queryParams: readonly string[];
}

const unsupported = (reason: string): WeiwudiError =>
  new WeiwudiError('unsupported-template', `Unsupported URL template: ${reason}`);

// ---- 字句の退避（仕様 §4.2: 字句を退避名にして new URL で解決し戻す） ----

interface Held { text: string; tokens: string[] }

/** `{…}` を `__weiwudi<n>__` に置き換える。ホストは小文字にされるので戻すときは大文字小文字を問わない */
const hold = (t: string): Held => {
  const tokens: string[] = [];
  const text = t.replace(/\{[^{}]*\}/g, (m) => {
    tokens.push(m);
    return `__weiwudi${tokens.length - 1}__`;
  });
  return { text, tokens };
};

const release = (s: string, tokens: readonly string[]): string =>
  s.replace(/__weiwudi(\d+)__/gi, (m, i: string) => tokens[Number(i)] ?? m);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseAbsolute = (text: string): URL => {
  try {
    return new URL(text);
  } catch (_e) {
    throw unsupported('not an absolute URL');
  }
};

const lowerSet = (names: readonly string[]): Set<string> => new Set(names.map((n) => n.toLowerCase()));

/** 1 つのクエリ片（`name=value`）の名前を percent-decode して返す */
const pieceName = (piece: string): string => {
  const eq = piece.indexOf('=');
  const raw = eq < 0 ? piece : piece.slice(0, eq);
  const first = new URLSearchParams(`${raw}=`).keys().next();
  return first.done ? '' : first.value;
};

interface SplitUrl { scheme: string; authority: string; path: string; query?: string; hash?: string }

/** 文字列のまま分ける（URL の直列化で符号化を変えないため） */
const splitUrl = (s: string): SplitUrl => {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:)(\/\/[^/?#]*)?([^?#]*)(?:\?([^#]*))?(#[\s\S]*)?$/.exec(s);
  if (!m) throw unsupported('not an absolute URL');
  return { scheme: m[1], authority: m[2] ?? '', path: m[3], query: m[4], hash: m[5] };
};

const joinUrl = (u: SplitUrl): string =>
  `${u.scheme}${u.authority}${u.path}${u.query !== undefined && u.query !== '' ? `?${u.query}` : ''}${u.hash ?? ''}`;

/** 文字列のクエリから名前（大文字小文字を問わない）で除く。並びは保つ */
const dropQueryPieces = (query: string, drop: Set<string>): string[] =>
  query.split('&').filter((p) => p !== '' && !drop.has(pieceName(p).toLowerCase()));

/**
 * id の唯一の作り方（仕様 §5.1）。規則は 4 つだけ: 絶対化済みであること（でなければ unsupported-template）・
 * credentialParams の項目を除く（名前の大文字小文字を問わない）・残りのクエリを名前順（同名は元の順）・
 * スキームとホストを小文字。パスとクエリの符号化は変えない
 */
export function normalizeTemplate(t: string, credentialParams: readonly string[]): string {
  const held = hold(t);
  parseAbsolute(held.text);
  const u = splitUrl(held.text);
  u.scheme = u.scheme.toLowerCase();
  // userinfo（登録では拒否する）は大文字小文字を変えない。ホストとポートだけを小文字に
  const at = u.authority.lastIndexOf('@');
  u.authority = at < 0 ? u.authority.toLowerCase() : u.authority.slice(0, at + 1) + u.authority.slice(at + 1).toLowerCase();
  if (u.query !== undefined) {
    const pieces = dropQueryPieces(u.query, lowerSet(credentialParams))
      .map((p) => ({ p, name: pieceName(p) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    u.query = pieces.map((x) => x.p).join('&');
  }
  return release(joinUrl(u), held.tokens);
}

/** 文字列のテンプレートから資格情報の項目を除く（並びは変えない・字句はそのまま）。spec.ts が url の返却に使う */
export function stripTemplateParams(t: string, params: readonly string[]): string {
  const held = hold(t);
  const u = splitUrl(held.text);
  if (u.query !== undefined) u.query = dropQueryPieces(u.query, lowerSet(params)).join('&');
  return release(joinUrl(u), held.tokens);
}

/** 正規化した形が 1 つでも一致すれば重なる（ミラーの順に依らない） */
export function templatesOverlap(a: readonly string[], b: readonly string[], credentialParams: readonly string[]): boolean {
  const left = new Set(a.map((t) => normalizeTemplate(t, credentialParams)));
  return b.some((t) => left.has(normalizeTemplate(t, credentialParams)));
}

/** 字句を退避名にして new URL で解決し戻す（`%7B` を作らない）。解決できなければ unsupported-template */
export function absolutizeTemplate(t: string, base: string): string {
  const held = hold(t);
  let href: string;
  try {
    href = new URL(held.text, base).href;
  } catch (_e) {
    throw unsupported('cannot be resolved');
  }
  return release(href, held.tokens);
}

/**
 * テンプレートを照合の規則にする。不可なら WeiwudiError('unsupported-template'):
 * 絶対でない・http/https 以外・未知の字句・ホスト（や userinfo・#）に字句・クエリ項目の名前に字句・
 * 値の一部だけが字句・{-y} に z が無い・{prefix} に x と y が無い
 */
export function compileTemplate(t: string): CompiledTemplate {
  const held = hold(t);
  const names: TokenName[] = held.tokens.map((raw) => {
    const inner = raw.slice(1, -1);
    if (!isTokenName(inner)) throw unsupported('unknown token');
    return inner;
  });
  const url = parseAbsolute(held.text);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw unsupported('only http: and https: are supported');

  let used = 0;
  // パス: 退避名で切り、字句以外は文字どおり
  const segs = url.pathname.split(/__weiwudi(\d+)__/i);
  const pathTokens: TokenName[] = [];
  let src = '^';
  segs.forEach((seg, i) => {
    if (i % 2 === 0) {
      src += escapeRe(seg);
    } else {
      const tok = names[Number(seg)];
      if (tok === undefined) throw unsupported('unknown token');
      pathTokens.push(tok);
      src += tokenPattern(tok);
      used++;
    }
  });
  src += '$';

  // クエリ: 値全体が 1 字句なら座標、字句を含まなければ固定値、それ以外は拒否
  const queryTokens: { name: string; token: TokenName; re: RegExp }[] = [];
  const queryFixed: { name: string; value: string }[] = [];
  for (const [name, value] of url.searchParams) {
    if (/__weiwudi\d+__/i.test(name)) throw unsupported('a token in a query parameter name');
    const whole = /^__weiwudi(\d+)__$/i.exec(value);
    if (whole) {
      const tok = names[Number(whole[1])];
      if (tok === undefined) throw unsupported('unknown token');
      queryTokens.push({ name, token: tok, re: new RegExp(`^${tokenPattern(tok)}$`) });
      used++;
    } else if (/__weiwudi\d+__/i.test(value)) {
      throw unsupported('a token in a part of a query value');
    } else {
      queryFixed.push({ name, value });
    }
  }
  // ホスト・userinfo・# に残った字句は照合に使えない
  if (used !== held.tokens.length) throw unsupported('a token outside the path and query values');

  const tokens = new Set<TokenName>(names);
  const hasZ = tokens.has('z') || tokens.has('quadkey');
  const hasX = tokens.has('x') || tokens.has('quadkey');
  const hasY = tokens.has('y') || tokens.has('quadkey') || (tokens.has('-y') && hasZ);
  if (tokens.has('-y') && !hasZ) throw unsupported('{-y} needs {z}');
  if (tokens.has('prefix') && !(hasX && hasY)) throw unsupported('{prefix} needs {x} and {y}');

  return {
    template: t,
    origin: url.origin,
    pathRe: new RegExp(src),
    pathTokens,
    queryTokens,
    queryFixed,
    tokens,
    tile: hasZ && hasX && hasY,
  };
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch (_e) {
    return s;
  }
};

/** 字句の値の組から座標などを作る。食い違い・範囲外は null */
const derive = (values: readonly (readonly [TokenName, string])[]): Omit<MatchResult, 'queryParams'> | null => {
  const got = new Map<TokenName, string[]>();
  for (const [t, v] of values) got.set(t, [...(got.get(t) ?? []), v]);
  const same = (t: TokenName): string | undefined | null => {
    const vs = got.get(t);
    if (!vs) return undefined;
    return vs.every((v) => v === vs[0]) ? vs[0] : null;
  };
  const num = (t: TokenName): number | undefined | null => {
    const v = same(t);
    return v === undefined || v === null ? v : Number(v);
  };
  const out: Omit<MatchResult, 'queryParams'> = {};
  let z = num('z');
  let x = num('x');
  let y = num('y');
  if (z === null || x === null || y === null) return null;
  const qk = same('quadkey');
  if (qk === null) return null;
  if (qk !== undefined) {
    let qx = 0;
    let qy = 0;
    for (const ch of qk) {
      const d = Number(ch);
      qx = qx * 2 + (d & 1);
      qy = qy * 2 + ((d >> 1) & 1);
    }
    if ((z !== undefined && z !== qk.length) || (x !== undefined && x !== qx) || (y !== undefined && y !== qy)) return null;
    z = qk.length;
    x = qx;
    y = qy;
  }
  const ny = num('-y');
  if (ny === null) return null;
  if (z !== undefined && z > MAX_TILE_ZOOM) return null;
  if (ny !== undefined && z !== undefined) {
    const fromNy = Math.pow(2, z) - 1 - ny;
    if (y !== undefined && y !== fromNy) return null;
    y = fromNy;
  }
  if (z !== undefined) {
    const n = Math.pow(2, z);
    if ((x !== undefined && x >= n) || (y !== undefined && (y < 0 || y >= n))) return null;
  }
  const prefix = same('prefix');
  if (prefix === null) return null;
  if (prefix !== undefined && (x === undefined || y === undefined || prefix.toLowerCase() !== tilePrefix(x, y))) return null;
  const ratio = same('ratio');
  if (ratio === null) return null;
  const fontstack = same('fontstack');
  const range = same('range');
  if (fontstack === null || range === null) return null;
  if (z !== undefined) out.z = z;
  if (x !== undefined) out.x = x;
  if (y !== undefined) out.y = y;
  if (ratio !== undefined) out.ratio = ratio;
  if (fontstack !== undefined) out.fontstack = safeDecode(fontstack);
  if (range !== undefined) out.range = range;
  return out;
};

/** 要求の URL をテンプレートと照合する。origin・pathname・テンプレートに書かれたクエリ項目だけを見る */
export function matchUrl(c: CompiledTemplate, url: URL): MatchResult | null {
  if (url.origin !== c.origin) return null;
  const pm = c.pathRe.exec(url.pathname);
  if (!pm) return null;
  const values: [TokenName, string][] = c.pathTokens.map((t, i) => [t, pm[i + 1] ?? '']);
  const params = url.searchParams;
  for (const q of c.queryTokens) {
    const v = params.get(q.name);
    if (v === null) return null;
    const qm = q.re.exec(v);
    if (!qm) return null;
    values.push([q.token, qm[1] ?? '']);
  }
  for (const f of c.queryFixed) {
    if (params.getAll(f.name).indexOf(f.value) < 0) return null;
  }
  const d = derive(values);
  if (!d) return null;
  const queryParams = [...c.queryTokens.map((q) => q.name), ...c.queryFixed.map((f) => f.name)]
    .filter((n, i, xs) => xs.indexOf(n) === i);
  return { ...d, queryParams };
}

/** 指定の名前（大文字小文字を問わない）のクエリ項目を除いた新しい URL。何も除かなければ search を変えない */
export function stripParams(url: URL, params: readonly string[]): URL {
  const out = new URL(url.href);
  const drop = lowerSet(params);
  const kept = [...url.searchParams].filter(([n]) => !drop.has(n.toLowerCase()));
  if (kept.length === [...url.searchParams].length) return out;
  out.search = kept.length === 0 ? '' : new URLSearchParams(kept).toString();
  return out;
}

/** 照合に使った項目と資格情報を除いた残りのクエリを、名前順（同名は値の順）に並べた `?…`。無ければ空 */
const restQuery = (url: URL, used: readonly string[], credentialParams: readonly string[]): string => {
  const drop = lowerSet(credentialParams);
  const rest = [...url.searchParams]
    .filter(([n]) => used.indexOf(n) < 0 && !drop.has(n.toLowerCase()))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return rest.length === 0 ? '' : `?${new URLSearchParams(rest).toString()}`;
};

/**
 * Entry のキー（仕様 §5.3）: `<resourceId>\0<suffix>`。
 * tile は tile_math.tileKeySuffix ＋残りのクエリ・glyph は fontstack・それ以外は残りのクエリ（無ければ空）
 */
export function entryKey(resourceId: string, type: ResourceType, m: MatchResult, url: URL, credentialParams: readonly string[]): string {
  if (type === 'glyph') return `${resourceId}\0${m.fontstack ?? ''}`;
  const rest = restQuery(url, m.queryParams, credentialParams);
  if (type === 'tile') {
    if (m.z === undefined || m.x === undefined || m.y === undefined) {
      throw new WeiwudiError('internal', 'A tile key needs z, x and y');
    }
    return `${resourceId}\0${tileKeySuffix(m.z, m.x, m.y, m.ratio)}${rest}`;
  }
  return `${resourceId}\0${rest}`;
}

export interface MatchRule {
  resourceId: string;
  type: ResourceType;
  compiled: CompiledTemplate;
}

/**
 * 照合表（仕様 §4.2）: Map<origin, 規則[]>。無関係なオリジンでは Map を 1 回引くだけで、正規表現を実行しない。
 * 同じオリジンの規則は登録順に評価し、最初に一致したものを返す
 */
export class MatchTable {
  private readonly byOrigin = new Map<string, MatchRule[]>();
  private count = 0;

  constructor(rules: Iterable<MatchRule> = []) {
    for (const r of rules) this.add(r);
  }

  add(rule: MatchRule): void {
    const list = this.byOrigin.get(rule.compiled.origin);
    if (list) list.push(rule);
    else this.byOrigin.set(rule.compiled.origin, [rule]);
    this.count++;
  }

  get size(): number {
    return this.count;
  }

  match(url: URL): { resourceId: string; type: ResourceType; m: MatchResult } | null {
    const rules = this.byOrigin.get(url.origin);
    if (!rules) return null;
    for (const r of rules) {
      const m = matchUrl(r.compiled, url);
      if (m) return { resourceId: r.resourceId, type: r.type, m };
    }
    return null;
  }
}
