// 登録内容（SourceSpec）の検査と正規化（仕様 §5.1・§10・§12。m2-t3・第 1 回 O-18）。SW 側で register と update が使う。
// 値の依存は url_pattern・tile_math・errors だけ（仕様 §3）。保存の型は store.ts から import type で使う。
//
// 決まり:
// - 出力は入力を写さず、検査した項目だけで組み立てる（未知の項目や credentials が spec へ紛れ込まない）
// - 資格情報は NormalizedSpec.credentials に分けて持ち、spec（SourceRecord.spec に入る）へは入れない
// - 拒否の文面に入力の値（URL・資格情報・id）を入れない。項目の名前と番号だけを書く
import type { Credentials, OutOfRange, ResourcePolicy, TileExtent } from './store';
import type { TileBox } from './tile_math';
import { WeiwudiError } from './errors';
import { lngLatBoundsToTileBox } from './tile_math';
import {
  DEFAULT_CREDENTIAL_PARAMS, MAX_TILE_ZOOM, TILE_TOKENS, compileTemplate, normalizeTemplate, stripTemplateParams,
} from './url_pattern';

// ---- 公開の型（仕様 §12。ページ側 API の型の正本。t8 で weiwudi.ts から export する） ----

export type { Credentials, OutOfRange, TileBox };

export interface CommonPolicy {
  cacheTtl?: number;
  cacheRetention?: number;
  cacheMaxBytes?: number;
  cachePrivate?: boolean;
  credentials?: Credentials;
  credentialParams?: string[];
}

export type SourceSpec = CommonPolicy & (
  | {
    kind: 'raster' | 'vector'; id?: string; url: string | string[];
    bounds?: [number, number, number, number]; box?: TileBox;
    minZoom?: number; maxZoom?: number; scheme?: 'xyz' | 'tms'; tileSize?: number;
    outOfRange?: { extent?: OutOfRange; zoom?: OutOfRange };
  }
  | { kind: 'style'; id?: string; url: string; fonts?: string[] }
  | { kind: 'asset'; id?: string; url: string | string[] }
);

// ---- 正規化の出力 ----

/** SourceRecord.spec に入れる形（資格情報を除く。m2 は raster・vector だけ） */
export interface StoredSpec {
  kind: 'raster' | 'vector';
  id: string;
  /** 地図ライブラリへ渡す URL。資格情報の項目だけを除き、形（文字列か配列）と順は登録のまま */
  url: string | string[];
  /** normalizeTemplate 済み（資格情報なし・重複なし・登録の順） */
  templates: string[];
  scheme: 'xyz' | 'tms';
  tileSize?: number;
  /** 範囲。無ければ全域 */
  extent?: TileExtent;
  policy: ResourcePolicy;
  /** Source 単位の上限（§7.1） */
  cacheMaxBytes?: number;
}

export interface NormalizedSpec {
  spec: StoredSpec;
  /** credentials ストアだけへ入れる。無ければ undefined */
  credentials?: Credentials;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 疑似ホスト（仕様 §4.1）。実 URL のテンプレートに使えない */
const PSEUDO_HOST = 'weiwudi.example.com';
/** Web メルカトルの緯度の限界 */
const MERC_MAX_LAT = 85.0511287798066;

const invalid = (attr: string, reason = 'is invalid'): WeiwudiError =>
  new WeiwudiError('attribute-invalid', `Attribute "${attr}" ${reason}`, { attribute: attr });

const unsupportedTemplate = (index: number, reason: string): WeiwudiError =>
  new WeiwudiError('unsupported-template', `URL template #${index + 1}: ${reason}`, { index });

const rejectedCredential = (where: string): WeiwudiError =>
  new WeiwudiError('credential-rejected', `A secret token (sk.) is not accepted in ${where}`, { where });

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const own = (o: Record<string, unknown>, k: string): unknown =>
  Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

const isNonNegNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** 先頭の Bearer ・Token ・Basic （大文字小文字を問わない）と空白を剥がしてから sk. で始まるか（仕様 §10） */
const isSecretToken = (v: string): boolean => /^sk\./i.test(v.replace(/^\s*(?:(?:bearer|token|basic)\s+)?\s*/i, ''));

/** クエリ値を percent-decode する。崩れた % でも投げない（URLSearchParams で取る。第 4 回 O-3） */
const decodeQueryValue = (raw: string): string => new URLSearchParams(`v=${raw.replace(/&/g, '%26')}`).get('v') ?? raw;

/**
 * テンプレートのクエリの (名前, 値) の組。名前と値は percent-decode しない生の形と、した形。
 * `#` を含むテンプレートは checkTemplate が先に拒否するので、最初の `?` から末尾までがクエリ（M1）
 */
const templateQueryPairs = (t: string): { rawName: string; name: string; raw: string; decoded: string }[] => {
  const q = t.indexOf('?');
  if (q < 0) return [];
  return t.slice(q + 1).split('&').filter((p) => p !== '').map((p) => {
    const eq = p.indexOf('=');
    const rawName = eq < 0 ? p : p.slice(0, eq);
    const raw = eq < 0 ? '' : p.slice(eq + 1);
    return { rawName, name: decodeQueryValue(rawName), raw, decoded: decodeQueryValue(raw) };
  });
};

const parseKind = (v: unknown): 'raster' | 'vector' => {
  if (v === 'raster' || v === 'vector') return v;
  if (v === 'style' || v === 'asset') {
    throw new WeiwudiError('unsupported-kind', `Source kind "${v}" is not supported in this version`, { kind: v });
  }
  throw invalid('kind');
};

const parseUrls = (v: unknown): string[] => {
  const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v : undefined;
  if (!list || list.length === 0) throw invalid('url', 'must be a URL template or a non-empty array of them');
  list.forEach((t) => {
    if (typeof t !== 'string' || t === '') throw invalid('url', 'must contain only non-empty strings');
  });
  return list as string[];
};

const parseStringRecord = (v: unknown, attr: string): Record<string, string> | undefined => {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) throw invalid(attr);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') throw invalid(attr, 'must have string values');
    out[k] = val;
  }
  return out;
};

const parseCredentials = (v: unknown): Credentials | undefined => {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) throw invalid('credentials');
  const query = parseStringRecord(own(v, 'query'), 'credentials.query');
  const headers = parseStringRecord(own(v, 'headers'), 'credentials.headers');
  for (const val of Object.values(query ?? {})) if (isSecretToken(val)) throw rejectedCredential('credentials.query');
  // クエリの名前は大文字小文字を問わずに除く・合わせるので、小文字で同じ名前が 2 つあると勝ち負けが決まらない（M2）
  const lower = Object.keys(query ?? {}).map((k) => k.toLowerCase());
  if (lower.some((k, i) => lower.indexOf(k) !== i)) throw invalid('credentials.query', 'must not repeat a name in a different case');
  for (const val of Object.values(headers ?? {})) if (isSecretToken(val)) throw rejectedCredential('credentials.headers');
  const c: Credentials = {};
  if (query) c.query = query;
  if (headers) c.headers = headers;
  return c;
};

const parseCredentialParams = (v: unknown): string[] => {
  if (v === undefined) return [...DEFAULT_CREDENTIAL_PARAMS];
  if (!Array.isArray(v) || v.some((p) => typeof p !== 'string' || p === '')) {
    throw invalid('credentialParams', 'must be an array of non-empty strings');
  }
  return [...DEFAULT_CREDENTIAL_PARAMS, ...(v as string[])].filter((p, i, xs) => xs.indexOf(p) === i);
};

/** 1 つのテンプレートを検査し、正規化した形を返す */
const checkTemplate = (t: string, index: number, credentialParams: readonly string[]): string => {
  if (/[\u0000-\u001f\u007f]/.test(t)) throw unsupportedTemplate(index, 'contains a control character');
  // フラグメントは上流へ届かず、クエリの検査と除去の外に資格情報を残す（M1）
  if (t.indexOf('#') >= 0) throw unsupportedTemplate(index, 'must not contain a fragment (#)');
  let parsed: URL;
  try {
    parsed = new URL(t.replace(/\{[^{}]*\}/g, '0'));
  } catch (_e) {
    throw unsupportedTemplate(index, 'is not an absolute URL');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new WeiwudiError('attribute-invalid', `URL template #${index + 1} must not contain user info`, { attribute: 'url', index });
  }
  for (const p of templateQueryPairs(t)) {
    // 値の無い項目（?sk.…）も名前で見る（I1）
    if (isSecretToken(p.raw) || isSecretToken(p.decoded) || isSecretToken(p.rawName) || isSecretToken(p.name)) {
      throw rejectedCredential(`URL template #${index + 1}`);
    }
  }
  let normalized: string;
  let compiled: ReturnType<typeof compileTemplate>;
  try {
    normalized = normalizeTemplate(t, credentialParams);
    compiled = compileTemplate(normalized);
  } catch (e) {
    if (e instanceof WeiwudiError && e.code === 'unsupported-template') throw unsupportedTemplate(index, e.message);
    throw e;
  }
  if (new URL(compiled.origin).hostname === PSEUDO_HOST) throw unsupportedTemplate(index, `${PSEUDO_HOST} is reserved`);
  for (const tok of compiled.tokens) {
    if (TILE_TOKENS.indexOf(tok) < 0) throw unsupportedTemplate(index, `{${tok}} is not a tile token`);
  }
  if (!compiled.tile) throw unsupportedTemplate(index, 'needs {z}, {x} and {y} (or {-y} / {quadkey})');
  return normalized;
};

const parseId = (v: unknown, fallback: string): string => {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || v === '') throw invalid('id', 'must be a non-empty string');
  if (v.indexOf('\0') >= 0) throw invalid('id', 'must not contain \\0');
  if (v.startsWith('map:')) throw invalid('id', 'must not start with "map:"');
  return v;
};

const parseOutOfRange = (v: unknown, def: OutOfRange): { extent: OutOfRange; zoom: OutOfRange } => {
  const ok = (x: unknown): x is OutOfRange => x === 'transparent' || x === 'empty' || x === 'not-found';
  if (v === undefined) return { extent: def, zoom: def };
  if (!isPlainObject(v)) throw invalid('outOfRange');
  const extent = own(v, 'extent');
  const zoom = own(v, 'zoom');
  if (extent !== undefined && !ok(extent)) throw invalid('outOfRange.extent');
  if (zoom !== undefined && !ok(zoom)) throw invalid('outOfRange.zoom');
  return { extent: extent ?? def, zoom: zoom ?? def };
};

const parseZoom = (v: unknown, attr: string): number | undefined => {
  if (v === undefined) return undefined;
  if (!isNonNegInt(v) || v > MAX_TILE_ZOOM) throw invalid(attr, `must be an integer from 0 to ${MAX_TILE_ZOOM}`);
  return v;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const parseExtent = (o: Record<string, unknown>, sourceId: string): TileExtent | undefined => {
  const minZoomIn = parseZoom(own(o, 'minZoom'), 'minZoom');
  const maxZoomIn = parseZoom(own(o, 'maxZoom'), 'maxZoom');
  const bounds = own(o, 'bounds');
  const boxIn = own(o, 'box');
  if (bounds !== undefined && boxIn !== undefined) throw invalid('bounds', 'cannot be given with "box"');
  if ((bounds !== undefined || boxIn !== undefined) && maxZoomIn === undefined) {
    throw invalid('maxZoom', 'is required with "bounds" or "box"');
  }
  if (minZoomIn === undefined && maxZoomIn === undefined) return undefined;
  const minZoom = minZoomIn ?? 0;
  const maxZoom = maxZoomIn ?? MAX_TILE_ZOOM;
  if (minZoom > maxZoom) throw invalid('minZoom', 'must not be greater than "maxZoom"');
  const extent: TileExtent = { minZoom, maxZoom, sourceId };
  const last = Math.pow(2, maxZoom) - 1;
  if (bounds !== undefined) {
    if (!Array.isArray(bounds) || bounds.length !== 4 || bounds.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      throw invalid('bounds', 'must be [west, south, east, north]');
    }
    const [w, s, e, n] = bounds as number[];
    if (w < -180 || e > 180 || s < -90 || n > 90 || w > e || s > n) throw invalid('bounds', 'is out of range');
    const b = lngLatBoundsToTileBox({
      minLng: w, maxLng: e, minLat: clamp(s, -MERC_MAX_LAT, MERC_MAX_LAT), maxLat: clamp(n, -MERC_MAX_LAT, MERC_MAX_LAT),
    }, maxZoom);
    extent.box = {
      minX: clamp(b.minX, 0, last), maxX: clamp(b.maxX, 0, last), minY: clamp(b.minY, 0, last), maxY: clamp(b.maxY, 0, last),
    };
  } else if (boxIn !== undefined) {
    if (!isPlainObject(boxIn)) throw invalid('box');
    const [minX, maxX, minY, maxY] = ['minX', 'maxX', 'minY', 'maxY'].map((k) => own(boxIn, k));
    if (![minX, maxX, minY, maxY].every((n) => isNonNegInt(n) && n <= last)) throw invalid('box', 'is out of range');
    const box = { minX, maxX, minY, maxY } as TileBox;
    if (box.minX > box.maxX || box.minY > box.maxY) throw invalid('box', 'min must not be greater than max');
    extent.box = box;
  }
  return extent;
};

/**
 * 登録内容を検査して正規化する（仕様 §5.1・§10・§12）。拒否は WeiwudiError:
 * - kind: style・asset は unsupported-kind（R18）、それ以外の未知の値は attribute-invalid
 * - id: map: から始まる・空・\0 を含む・文字列でない は attribute-invalid。既定は先頭のテンプレートの normalizeTemplate
 * - テンプレート: 絶対でない・http/https 以外・字句の誤り・weiwudi.example.com・座標が取れない は unsupported-template、
 *   userinfo は attribute-invalid
 * - sk. の資格情報（credentials の query・headers の値、テンプレートの全クエリ値。decode した後も）は credential-rejected
 * テンプレートに載っていた資格情報の項目は credentials.query へ移す（明示の credentials が勝つ）
 */
export function normalizeSpec(input: unknown): NormalizedSpec {
  if (!isPlainObject(input)) throw invalid('spec', 'must be an object');
  const kind = parseKind(own(input, 'kind'));
  const urlIn = own(input, 'url');
  const urls = parseUrls(urlIn);
  const credentialParams = parseCredentialParams(own(input, 'credentialParams'));
  const explicit = parseCredentials(own(input, 'credentials'));

  const normalized = urls.map((t, i) => checkTemplate(t, i, credentialParams));
  const templates = normalized.filter((t, i, xs) => xs.indexOf(t) === i);
  const id = parseId(own(input, 'id'), templates[0]);

  // テンプレートに載っていた資格情報の項目（字句を含む値は除く）。名前は小文字で 1 つにまとめ（M2）、
  // 先のミラー・先の出現が勝ち、明示の credentials がさらに勝つ。出力の名前は勝った側の綴り
  const drop = new Set(credentialParams.map((p) => p.toLowerCase()));
  const merged = new Map<string, [name: string, value: string]>();
  for (const t of urls) {
    for (const p of templateQueryPairs(t)) {
      const lower = p.name.toLowerCase();
      if (!drop.has(lower) || /\{[^{}]*\}/.test(p.decoded)) continue;
      if (!merged.has(lower)) merged.set(lower, [p.name, p.decoded]);
    }
  }
  for (const [name, value] of Object.entries(explicit?.query ?? {})) merged.set(name.toLowerCase(), [name, value]);
  let credentials: Credentials | undefined;
  if (explicit || merged.size > 0) {
    credentials = { ...(explicit ?? {}) };
    delete credentials.query;
    if (merged.size > 0) credentials.query = Object.fromEntries([...merged.values()]);
  }

  const cacheTtl = own(input, 'cacheTtl');
  if (cacheTtl !== undefined && !isNonNegNumber(cacheTtl)) throw invalid('cacheTtl', 'must be a non-negative number');
  const cacheRetention = own(input, 'cacheRetention');
  if (cacheRetention !== undefined && !isNonNegNumber(cacheRetention)) throw invalid('cacheRetention', 'must be a non-negative number');
  const cacheMaxBytes = own(input, 'cacheMaxBytes');
  if (cacheMaxBytes !== undefined && !isNonNegInt(cacheMaxBytes)) throw invalid('cacheMaxBytes', 'must be a non-negative integer');
  const cachePrivate = own(input, 'cachePrivate');
  if (cachePrivate !== undefined && typeof cachePrivate !== 'boolean') throw invalid('cachePrivate', 'must be a boolean');
  const scheme = own(input, 'scheme');
  if (scheme !== undefined && scheme !== 'xyz' && scheme !== 'tms') throw invalid('scheme');
  const tileSize = own(input, 'tileSize');
  if (tileSize !== undefined && !(isNonNegInt(tileSize) && tileSize > 0)) throw invalid('tileSize', 'must be a positive integer');

  const policy: ResourcePolicy = {
    cacheTtl: cacheTtl ?? DAY_MS,
    store: cachePrivate === true,
    outOfRange: parseOutOfRange(own(input, 'outOfRange'), kind === 'raster' ? 'transparent' : 'empty'),
    credentialParams,
  };
  if (cacheRetention !== undefined) policy.cacheRetention = cacheRetention;

  const stripped = urls.map((t) => stripTemplateParams(t, credentialParams));
  const spec: StoredSpec = {
    kind,
    id,
    url: typeof urlIn === 'string' ? stripped[0] : stripped,
    templates,
    scheme: scheme ?? 'xyz',
    policy,
  };
  if (tileSize !== undefined) spec.tileSize = tileSize;
  const extent = parseExtent(input, id);
  if (extent) spec.extent = extent;
  if (cacheMaxBytes !== undefined) spec.cacheMaxBytes = cacheMaxBytes;

  return credentials ? { spec, credentials } : { spec };
}
