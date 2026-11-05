// 登録内容（SourceSpec）の検査と正規化（仕様 §5.1・§10・§12。m2-t3・第 1 回 O-18）。SW 側で register と update が使う。
// 値の依存は url_pattern・tile_math・constants・errors だけ（仕様 §3）。保存の型は store.ts から import type で使う。
//
// 決まり:
// - 出力は入力を写さず、検査した項目だけで組み立てる（未知の項目や credentials が spec へ紛れ込まない）
// - 資格情報は NormalizedSpec.credentials に分けて持ち、spec（SourceRecord.spec に入る）へは入れない
// - 拒否の文面に入力の値（URL・資格情報・id）を入れない。項目の名前と番号だけを書く
// - 提供元（m3-t5）: providers を渡されたときだけ使う。URL が matches に当たれば resolve してから検査し、
//   validateCredentials を呼び、credentialParams を和に入れ、spec.provider に id を入れる
import type { Credentials, OutOfRange, ResourcePolicy, ResourceType, TileExtent } from './store';
import type { TileBox } from './tile_math';
import type { WeiwudiProvider } from './plugins';
import { WeiwudiError } from './errors';
import { DAY_MS, LEGACY_PREFIX, PSEUDO_HOST } from './constants';
import { lngLatBoundsToTileBox } from './tile_math';
import {
  DEFAULT_CREDENTIAL_PARAMS, MAX_TILE_ZOOM, TILE_TOKENS, compileTemplate, normalizeTemplate, stripTemplateParams,
  type TokenName,
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

/** 資源の指定の種類（利用者の kind と、スタイルの下位資源の種類。m3-t2） */
export type MemberKind = 'raster' | 'vector' | 'asset' | 'style' | 'tilejson' | 'glyph' | 'sprite';

/**
 * SourceRecord.spec に入れる形（資格情報を除く）。raster・vector・asset の Source と、スタイルの子 Source（kind: 'child'）。
 * m2 の記録は type を持たない（store.ts の storedSpecOf が 'tile' として読む）
 */
export interface StoredSpec {
  kind: 'raster' | 'vector' | 'asset' | 'child';
  /** raster・vector は 'tile'、asset は 'data'。子は下位資源の型 */
  type: ResourceType;
  id: string;
  /** 地図ライブラリへ渡す URL。資格情報の項目だけを除き、形（文字列か配列）と順は登録のまま */
  url: string | string[];
  /** normalizeTemplate 済み（資格情報なし・重複なし・登録の順） */
  templates: string[];
  /** tile だけ（無ければ xyz） */
  scheme?: 'xyz' | 'tms';
  tileSize?: number;
  /** 範囲（tile だけ）。無ければ全域 */
  extent?: TileExtent;
  /** 子の tile の符号化（raster・vector の Source は kind が符号化） */
  encoding?: 'raster' | 'vector';
  /** 子だけ: スタイルの中で子を指す名前（id の \0 の後の "<type>:" に続く部分） */
  logicalName?: string;
  policy: ResourcePolicy;
  /** Source 単位の上限（§7.1）。子は持たない（親の値を使う） */
  cacheMaxBytes?: number;
  /** 提供元（m3-t5） */
  provider?: string;
}

/** スタイルの子 Source の一覧の 1 要素。from は TileJSON の下のタイルのときの TileJSON の子の id */
export interface StyleChild {
  id: string;
  logicalName: string;
  type: ResourceType;
  from?: string;
}

/** スタイルの Source（親）の登録内容（m3-t2 で型と保存を決め、m3-t7 が使う） */
export interface StyleSpec {
  kind: 'style';
  id: string;
  /** 地図ライブラリへ渡す https の URL（提供元の解決後・資格情報なし） */
  url: string;
  /** スタイル自身のテンプレート（正規化済み） */
  templates: [string];
  /** m3 では保存だけ。m4 の範囲取得のグリフで使う */
  fonts?: string[];
  policy: ResourcePolicy;
  cacheMaxBytes?: number;
  provider?: string;
  children: StyleChild[];
}

export interface NormalizedSpec {
  spec: StoredSpec;
  /** credentials ストアだけへ入れる。無ければ undefined */
  credentials?: Credentials;
}

/** Web メルカトルの緯度の限界 */
const MERC_MAX_LAT = 85.0511287798066;

const invalid = (attr: string, reason = 'is invalid'): WeiwudiError =>
  new WeiwudiError('attribute-invalid', `Attribute "${attr}" ${reason}`, { attribute: attr });

const unsupportedTemplate = (index: number, reason: string): WeiwudiError =>
  new WeiwudiError('unsupported-template', `URL template #${index + 1}: ${reason}`, { index });

const rejectedCredential = (where: string): WeiwudiError =>
  new WeiwudiError('credential-rejected', `A secret token (sk.) is not accepted in ${where}`, { where });

const conflictingCredential = (name: string): WeiwudiError =>
  new WeiwudiError(
    'attribute-invalid',
    `URL templates carry different values for credential "${name}"; register each mirror as its own source`,
    { attribute: 'url' },
  );

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const own = (o: Record<string, unknown>, k: string): unknown =>
  Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

const isNonNegNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** 先頭の Bearer ・Token ・Basic （大文字小文字を問わない）と空白を剥がしてから sk. で始まるか（仕様 §10） */
const isSecretToken = (v: string): boolean => /^sk\./i.test(v.replace(/^\s*(?:(?:bearer|token|basic)\s+)?\s*/i, ''));

/** パスの区画の秘密トークン（仕様 §10。I9・R23）: sk.eyJ で始まる区画だけ（sk.osm のような区画名は通す）。大文字小文字を問わない */
const isSecretPathSegment = (v: string): boolean => /^sk\.eyj/i.test(v);

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

/**
 * 既定 ＋ 登録の credentialParams ＋ 明示の credentials.query の名前（M-1）。
 * 明示の名前は、大文字小文字を問わずに既にある名前なら足さない（照合も除去も大文字小文字を問わないため）
 */
const parseCredentialParams = (v: unknown, explicitNames: readonly string[], fromProvider: readonly string[] = []): string[] => {
  if (v !== undefined && (!Array.isArray(v) || v.some((p) => typeof p !== 'string' || p === ''))) {
    throw invalid('credentialParams', 'must be an array of non-empty strings');
  }
  const base = [...DEFAULT_CREDENTIAL_PARAMS, ...((v as string[] | undefined) ?? []), ...fromProvider]
    .filter((p, i, xs) => xs.indexOf(p) === i);
  const have = new Set(base.map((p) => p.toLowerCase()));
  for (const n of explicitNames) {
    if (n === '' || have.has(n.toLowerCase())) continue;
    have.add(n.toLowerCase());
    base.push(n);
  }
  return base;
};

/**
 * 型ごとの字句の許可（m3-t2）。tile は TILE_TOKENS で座標が要る。glyph は {fontstack}・{range} の両方が要る。
 * sprite の内部の字句 {spriteSuffix} は m3-t6 で足す（登録の入力では受けない）。style・tilejson・data は字句なし
 */
const checkTokens = (type: ResourceType, compiled: ReturnType<typeof compileTemplate>, index: number): void => {
  const allowed: readonly TokenName[] = type === 'tile' ? TILE_TOKENS : type === 'glyph' ? ['fontstack', 'range'] : [];
  for (const tok of compiled.tokens) {
    if (allowed.indexOf(tok) >= 0) continue;
    throw unsupportedTemplate(index, type === 'tile' ? `{${tok}} is not a tile token` : `{${tok}} is not allowed in a ${type} URL`);
  }
  if (type === 'tile' && !compiled.tile) throw unsupportedTemplate(index, 'needs {z}, {x} and {y} (or {-y} / {quadkey})');
  if (type === 'glyph' && !(compiled.tokens.has('fontstack') && compiled.tokens.has('range'))) {
    throw unsupportedTemplate(index, 'needs {fontstack} and {range}');
  }
};

/** 1 つのテンプレートを検査し、正規化した形を返す */
const checkTemplate = (t: string, index: number, credentialParams: readonly string[], type: ResourceType = 'tile'): string => {
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
  // パスの区画も見る（生の形と decode した形。L-2）。区画は sk.eyJ だけ（I9）。崩れた % は生の形だけで見る
  for (const seg of parsed.pathname.split('/')) {
    let decoded = seg;
    try { decoded = decodeURIComponent(seg); } catch (_e) { /* 生の形だけ */ }
    if (isSecretPathSegment(seg) || isSecretPathSegment(decoded)) throw rejectedCredential(`URL template #${index + 1}`);
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
  checkTokens(type, compiled, index);
  return normalized;
};

/** 提供元の matches（投げたら当たらないものとする） */
const safeMatches = (p: WeiwudiProvider, url: string): boolean => {
  try {
    return p.matches(url) === true;
  } catch (_e) {
    return false;
  }
};

/**
 * 提供元の解決（m3-t5）。各 URL に最初に当たる提供元で resolve する。当たる提供元がミラーの間で違う
 * （オブジェクトの同一性で比べる。当たるものと当たらないものが混ざるのも含む）なら attribute-invalid。
 * resolve の失敗は、例外の種類を問わず固定の文面の unsupported-template（番号つき。利用者の提供元の文面を外へ出さない）
 */
const resolveProviders = (urls: string[], providers: readonly WeiwudiProvider[] | undefined): { urls: string[]; provider?: WeiwudiProvider } => {
  if (!providers || providers.length === 0) return { urls };
  const hits = urls.map((u) => providers.find((p) => safeMatches(p, u)));
  const provider = hits[0];
  if (hits.some((h) => h !== provider)) throw invalid('url', 'must not mix URLs of different providers');
  if (!provider) return { urls };
  const cannot = (i: number) => unsupportedTemplate(i, `cannot be resolved by the provider "${provider.id}"`);
  const resolved = urls.map((u, i) => {
    let out: unknown;
    try {
      out = provider.resolve(u);
    } catch (_e) {
      throw cannot(i);
    }
    if (typeof out !== 'string' || out === '') throw cannot(i);
    return out;
  });
  return { urls: resolved, provider };
};

const parseId = (v: unknown, fallback: string): string => {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || v === '') throw invalid('id', 'must be a non-empty string');
  if (v.indexOf('\0') >= 0) throw invalid('id', 'must not contain \\0');
  if (v.startsWith(LEGACY_PREFIX)) throw invalid('id', `must not start with "${LEGACY_PREFIX}"`);
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

const parseExtent = (o: Record<string, unknown>, sourceId: string, scheme: 'xyz' | 'tms'): TileExtent | undefined => {
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
    const minY = clamp(b.minY, 0, last);
    const maxY = clamp(b.maxY, 0, last);
    // box は Source の scheme の座標（照合で得る y は URL の値そのまま）。bounds は XYZ で作るので tms なら反転する
    extent.box = scheme === 'tms'
      ? { minX: clamp(b.minX, 0, last), maxX: clamp(b.maxX, 0, last), minY: last - maxY, maxY: last - minY }
      : { minX: clamp(b.minX, 0, last), maxX: clamp(b.maxX, 0, last), minY, maxY };
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

/** 資源の指定に共通の入力（cacheTtl などの方針・credentials・credentialParams。tile は範囲・scheme・tileSize・outOfRange も）。検査は normalizeMember が行う */
export type CommonPolicyInput = Record<string, unknown>;

export interface MemberOptions {
  kind: StoredSpec['kind'];
  /** 利用者の id（検査する。無ければ先頭のテンプレート） */
  id?: unknown;
  /** 内部で作る id（子の id。\0 を含むので検査しない）。id より優先 */
  internalId?: string;
  /** 登録の url が文字列だった（StoredSpec.url の形を合わせる） */
  single?: boolean;
  /** 子の tile の符号化（raster・vector の Source は kind から決まるので要らない） */
  encoding?: 'raster' | 'vector';
  /** 子の論理名 */
  logicalName?: string;
}

/**
 * 1 つの資源の指定を検査して正規化する（仕様 §5.1・§10・§12。m3-t2）。拒否は WeiwudiError:
 * - id（利用者の id）: map: から始まる・空・\0 を含む・文字列でない は attribute-invalid。既定は先頭のテンプレートの normalizeTemplate
 * - テンプレート: 絶対でない・http/https 以外・字句の誤り（型ごとの許可は checkTokens）・weiwudi.example.com・
 *   tile で座標が取れない は unsupported-template、userinfo は attribute-invalid
 * - sk. の資格情報（credentials の query・headers の値、テンプレートの全クエリ値と名前。decode した後も）と
 *   sk.eyJ で始まるパスの区画は credential-rejected
 * - テンプレートの資格情報の項目に、同じ名前（大文字小文字を問わない）で違う値があれば attribute-invalid（明示の名前は除く）
 * テンプレートに載っていた資格情報の項目は credentials.query へ移す（明示の credentials が勝つ）。
 * 範囲・scheme・tileSize・outOfRange は tile だけが読む（tile でない指定は範囲を持たない。P1）
 */
export function normalizeMember(
  type: ResourceType, inputUrls: string[], common: CommonPolicyInput, opts: MemberOptions,
  providers?: readonly WeiwudiProvider[],
): NormalizedSpec {
  // 提供元の URL は resolve してから検査する（以後の urls は解決した https の URL。m3-t5）
  const { urls, provider } = resolveProviders(inputUrls, providers);
  const explicit = parseCredentials(own(common, 'credentials'));
  const providerParams = (provider?.credentialParams ?? []).filter((p) => typeof p === 'string' && p !== '');
  // 明示の credentials.query の名前も資格情報の項目として除く（テンプレートとページの要求に載っていても残さない）
  const credentialParams = parseCredentialParams(own(common, 'credentialParams'), Object.keys(explicit?.query ?? {}), providerParams);

  const normalized = urls.map((t, i) => checkTemplate(t, i, credentialParams, type));
  const templates = normalized.filter((t, i, xs) => xs.indexOf(t) === i);
  const id = opts.internalId ?? parseId(opts.id, templates[0]);

  // テンプレートに載っていた資格情報の項目（字句を含む値は除く）。名前は小文字で 1 つにまとめ（M2）、
  // 先のミラー・先の出現が勝ち、明示の credentials がさらに勝つ。出力の名前は勝った側の綴り。
  // 同じ名前に違う値があれば attribute-invalid（I2・R22。明示の名前は見ない。値は文面に入れない）
  const drop = new Set(credentialParams.map((p) => p.toLowerCase()));
  const explicitNames = new Set(Object.keys(explicit?.query ?? {}).map((n) => n.toLowerCase()));
  // 1 つのテンプレートの中では先の出現が勝つ（M2）。比べるのはミラーごとに勝った値どうし
  const merged = new Map<string, [name: string, value: string]>();
  for (const t of urls) {
    const first = new Map<string, [name: string, value: string]>();
    for (const p of templateQueryPairs(t)) {
      const lower = p.name.toLowerCase();
      if (!drop.has(lower) || /\{[^{}]*\}/.test(p.decoded)) continue;
      if (!first.has(lower)) first.set(lower, [p.name, p.decoded]);
    }
    for (const [lower, pair] of first) {
      const seen = merged.get(lower);
      if (!seen) merged.set(lower, pair);
      else if (seen[1] !== pair[1] && !explicitNames.has(lower)) throw conflictingCredential(seen[0]);
    }
  }
  for (const [name, value] of Object.entries(explicit?.query ?? {})) merged.set(name.toLowerCase(), [name, value]);
  let credentials: Credentials | undefined;
  if (explicit || merged.size > 0) {
    credentials = { ...(explicit ?? {}) };
    delete credentials.query;
    if (merged.size > 0) credentials.query = Object.fromEntries([...merged.values()]);
  }
  // 提供元としての資格情報の検査（汎用の検査と重なってもよい。不正なら credential-rejected）
  // 例外は種類を問わず固定の文面の credential-rejected へ包む（利用者の提供元の文面を外へ出さない）
  if (provider?.validateCredentials) {
    try {
      provider.validateCredentials(credentials ? { ...credentials } : {});
    } catch (_e) {
      throw new WeiwudiError('credential-rejected', `Credentials are rejected by the provider "${provider.id}"`, { where: 'credentials' });
    }
  }

  const cacheTtl = own(common, 'cacheTtl');
  if (cacheTtl !== undefined && !isNonNegNumber(cacheTtl)) throw invalid('cacheTtl', 'must be a non-negative number');
  const cacheRetention = own(common, 'cacheRetention');
  if (cacheRetention !== undefined && !isNonNegNumber(cacheRetention)) throw invalid('cacheRetention', 'must be a non-negative number');
  const cacheMaxBytes = own(common, 'cacheMaxBytes');
  if (cacheMaxBytes !== undefined && !isNonNegInt(cacheMaxBytes)) throw invalid('cacheMaxBytes', 'must be a non-negative integer');
  const cachePrivate = own(common, 'cachePrivate');
  if (cachePrivate !== undefined && typeof cachePrivate !== 'boolean') throw invalid('cachePrivate', 'must be a boolean');

  const isTile = type === 'tile';
  const encoding = opts.encoding ?? (opts.kind === 'raster' || opts.kind === 'vector' ? opts.kind : undefined);
  const scheme = isTile ? own(common, 'scheme') : undefined;
  if (scheme !== undefined && scheme !== 'xyz' && scheme !== 'tms') throw invalid('scheme');
  const tileSize = isTile ? own(common, 'tileSize') : undefined;
  if (tileSize !== undefined && !(isNonNegInt(tileSize) && tileSize > 0)) throw invalid('tileSize', 'must be a positive integer');

  // tile でない資源の範囲外の応答は使われない（範囲を持たない）。合成で型の違う値が混ざらないよう not-found に揃える
  const policy: ResourcePolicy = {
    cacheTtl: cacheTtl ?? DAY_MS,
    store: cachePrivate === true,
    outOfRange: isTile
      ? parseOutOfRange(own(common, 'outOfRange'), encoding === 'vector' ? 'empty' : 'transparent')
      : { extent: 'not-found', zoom: 'not-found' },
    credentialParams,
  };
  if (cacheRetention !== undefined) policy.cacheRetention = cacheRetention;

  const stripped = urls.map((t) => stripTemplateParams(t, credentialParams));
  const spec: StoredSpec = {
    kind: opts.kind,
    type,
    id,
    url: opts.single ? stripped[0] : stripped,
    templates,
    policy,
  };
  if (isTile) {
    spec.scheme = scheme ?? 'xyz';
    if (tileSize !== undefined) spec.tileSize = tileSize;
    const extent = parseExtent(common, id, spec.scheme);
    if (extent) spec.extent = extent;
    if (opts.kind === 'child' && encoding !== undefined) spec.encoding = encoding;
  }
  if (opts.logicalName !== undefined) spec.logicalName = opts.logicalName;
  if (cacheMaxBytes !== undefined) spec.cacheMaxBytes = cacheMaxBytes;
  if (provider) spec.provider = provider.id;

  return credentials ? { spec, credentials } : { spec };
}

/**
 * 利用者の登録内容を検査して正規化する（仕様 §5.1・§10・§12）。kind: style・asset は m3-t7 まで unsupported-kind（R18）、
 * それ以外の未知の値は attribute-invalid。残りの検査は normalizeMember('tile', …)。providers は提供元の評価の順（m3-t5。無ければ使わない）
 */
export function normalizeSpec(input: unknown, providers?: readonly WeiwudiProvider[]): NormalizedSpec {
  if (!isPlainObject(input)) throw invalid('spec', 'must be an object');
  const kind = parseKind(own(input, 'kind'));
  const urlIn = own(input, 'url');
  const urls = parseUrls(urlIn);
  return normalizeMember('tile', urls, input, { kind, id: own(input, 'id'), single: typeof urlIn === 'string' }, providers);
}
