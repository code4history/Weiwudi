// 標準の提供元 mapbox（#40・仕様 §10。m3-t5）。mapbox:// を登録の時点で https://api.mapbox.com へ解決する。
// 値の依存は errors だけ（仕様 §3）。WeiwudiProvider・Credentials は import type で使う。
//
// 決まり:
// - 解決の表は計画 m3-t5 の表（BeatBox 0.1.1 の変換表を写した）。Mapbox GL JS 3.27.0 の normalize*URL との関係は次のとおり:
//   styles・glyphs（fonts）・source（TileJSON。GL JS と同じく ?secure を付ける。F3）は一致する。
//   sprite は基底の URL まで（GL JS はこの後ろに format と拡張子を付ける）。
//   tiles は字句のまま写す（GL JS の @2x・webp への置き換え・raster の前置は扱わない）。資格情報は足さない
// - パスの残りは字句のまま写す（{z}・{fontstack} などをそのまま通す）。クエリは解決した URL の後ろへそのまま残す
// - 資格情報の足し方は自前で組まない。配線が upstream の関数を createMapboxProvider に渡す
// - 解決できない mapbox:// は unsupported-template。文面に URL を入れない
import type { WeiwudiProvider } from '../plugins';
import type { Credentials } from '../store';
import { WeiwudiError } from '../errors';

/** Mapbox の API のオリジン */
export const MAPBOX_API = 'https://api.mapbox.com';

/** クエリの資格情報を、要求に無い名前だけ url に足す関数（upstream.appendQueryCredentials） */
export type QueryCredentialAdder = (url: URL, query: Record<string, string>) => void;

const SCHEME = /^mapbox:\/\//i;

const unresolvable = (): WeiwudiError =>
  new WeiwudiError('unsupported-template', 'mapbox:// URL has an unsupported form', {});

const isSegment = (s: string | undefined): s is string => s !== undefined && s !== '';

/** ソースの id（user.tileset）。複合は , でつなぐ */
const SOURCE_ID = /^[\w-]+\.[\w.-]+$/;

/**
 * mapbox:// の URL を https へ解決する（表は計画 m3-t5）。https の URL はそのまま返す
 */
const resolveMapbox = (url: string): string => {
  if (!SCHEME.test(url)) return url;
  const rest = url.replace(SCHEME, '');
  const q = rest.indexOf('?');
  const path = q < 0 ? rest : rest.slice(0, q);
  const query = q < 0 ? '' : rest.slice(q + 1);
  const withQuery = (base: string, first?: string): string => {
    const parts = [first, query].filter((p): p is string => p !== undefined && p !== '');
    return parts.length > 0 ? `${base}?${parts.join('&')}` : base;
  };
  const segs = path.split('/');
  const [head, ...tail] = segs;
  if (!tail.every(isSegment)) throw unresolvable();
  switch (head) {
    case 'styles':
      // {u}/{s} と draft の {u}/{s}/draft（GL JS の normalizeStyleURL はパスを /styles/v1 の後ろへそのまま写す）
      if (tail.length === 2 || (tail.length === 3 && tail[2] === 'draft')) return withQuery(`${MAPBOX_API}/styles/v1/${tail.join('/')}`);
      throw unresolvable();
    case 'sprites':
      // {u}/{s} と Studio の {u}/{s}/{hash}（GL JS の normalizeSpriteURL: /styles/v1<path>/sprite）
      if (tail.length === 2 || tail.length === 3) return withQuery(`${MAPBOX_API}/styles/v1/${tail.join('/')}/sprite`);
      throw unresolvable();
    case 'fonts':
      if (tail.length === 3 && tail[2].endsWith('.pbf') && tail[2] !== '.pbf') return withQuery(`${MAPBOX_API}/fonts/v1/${tail.join('/')}`);
      throw unresolvable();
    case 'tiles':
      // {id}/{z}/{x}/{y}[@2x].{fmt}（字句のまま）
      if (tail.length === 4) return withQuery(`${MAPBOX_API}/v4/${tail.join('/')}`);
      throw unresolvable();
    default: {
      // ソースの url: mapbox://{id}[,{id}…] → TileJSON（GL JS の normalizeSourceURL と同じく ?secure）
      if (segs.length !== 1 || !head.split(',').every((id) => SOURCE_ID.test(id))) throw unresolvable();
      const secure = query.split('&').indexOf('secure') >= 0 ? undefined : 'secure';
      return withQuery(`${MAPBOX_API}/v4/${head}.json`, secure);
    }
  }
};

/** https の api.mapbox.com・*.tiles.mapbox.com（テンプレートの字句があっても読む） */
const isMapboxHttps = (url: string): boolean => {
  let u: URL;
  try {
    u = new URL(url.replace(/\{[^{}]*\}/g, '0'));
  } catch (_e) {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'api.mapbox.com' || /^[a-z0-9-]+\.tiles\.mapbox\.com$/.test(host);
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** mapbox:// の文字列だけを直す。解決できなければそのまま */
const fix = (v: unknown): unknown => {
  if (typeof v !== 'string' || !SCHEME.test(v)) return v;
  try {
    return resolveMapbox(v);
  } catch (_e) {
    return v;
  }
};

/** スタイルの sources[*].url・sources[*].tiles[]・sprite（文字列と {id, url}[]）・glyphs を直した新しい object */
const rewriteMapboxStyle = (style: unknown): unknown => {
  if (!isPlainObject(style)) return style;
  const out: Record<string, unknown> = { ...style };
  if (isPlainObject(style.sources)) {
    // __proto__ も通常の source 名として JSON に残す。
    const sources: Record<string, unknown> = Object.create(null);
    for (const [name, src] of Object.entries(style.sources)) {
      if (!isPlainObject(src)) {
        sources[name] = src;
        continue;
      }
      const next: Record<string, unknown> = { ...src };
      if ('url' in src) next.url = fix(src.url);
      if (Array.isArray(src.tiles)) next.tiles = src.tiles.map(fix);
      sources[name] = next;
    }
    out.sources = sources;
  }
  if (typeof style.sprite === 'string') out.sprite = fix(style.sprite);
  else if (Array.isArray(style.sprite)) {
    out.sprite = style.sprite.map((s: unknown) => (isPlainObject(s) && 'url' in s ? { ...s, url: fix(s.url) } : s));
  }
  if ('glyphs' in style) out.glyphs = fix(style.glyphs);
  return out;
};

const rejected = (): WeiwudiError =>
  new WeiwudiError('credential-rejected', 'A secret token (sk.) is not accepted for the mapbox provider', { where: 'credentials.query' });

/** 標準の提供元 mapbox を作る。addQuery は upstream.appendQueryCredentials（配線が渡す） */
export function createMapboxProvider(addQuery: QueryCredentialAdder): WeiwudiProvider {
  return {
    id: 'mapbox',
    matches: (url: string) => SCHEME.test(url) || isMapboxHttps(url),
    resolve: resolveMapbox,
    applyCredentials: (url: URL, c: Credentials) => {
      if (c.query) addQuery(url, c.query);
    },
    rewriteStyle: rewriteMapboxStyle,
    validateCredentials: (c: Credentials) => {
      for (const [name, value] of Object.entries(c.query ?? {})) {
        if (name.toLowerCase() === 'access_token' && /^\s*sk\./i.test(value)) throw rejected();
      }
    },
    credentialParams: ['access_token'],
  };
}
