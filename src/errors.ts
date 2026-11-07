// エラーの具体化（#33）。依存を持たない。ページと Service Worker の両方が import する。
// 旧 API は文字列で reject し続ける（仕様 §9）。WeiwudiError.from(e) でその文字列から code を得る。

const LEGACY_CODES = [
  'sw-unsupported', 'sw-register-failed', 'sw-not-controlling', 'sw-not-implemented',
  'map-id-required', 'instance-released',
  'attribute-missing', 'attribute-invalid', 'unknown-type',
  'map-not-found', 'map-busy', 'no-fetch-process', 'cache-path-invalid',
  'cannot-fetch-all', 'fetch-busy', 'api-not-found',
] as const;
const OTHER_CODES = ['db-blocked', 'quota', 'network', 'upstream', 'storage', 'internal'] as const;
// 新 API（仕様 §9）で使うコード。公開の後に union を広げると exhaustive な switch を書いた利用者が
// 壊れるので、先に型へ入れておく。m1 の時点では作られない
const NEW_API_CODES = [
  'unsupported-template', 'invalid-style', 'opaque', 'sw-outdated',
  'credential-rejected', 'source-not-found', 'resource-conflict',
  // その版がまだ扱わない kind（m2 では style・asset。仕様 §9）
  'unsupported-kind',
  // WeiwudiSource.removeResource の id がその Source の Resource でない（m3-t8・R18）
  'resource-not-found',
] as const;

/** 旧 API に文面があるコード（16 件） */
export type LegacyErrorCode = typeof LEGACY_CODES[number];

/** 新 API（仕様 §9）で使うコード */
export type NewApiErrorCode = typeof NEW_API_CODES[number];

/** code は今後の minor で増えることがある。switch には default を置くこと */
export type WeiwudiErrorCode =
  | LegacyErrorCode
  | typeof OTHER_CODES[number]
  | NewApiErrorCode;

const KNOWN_CODES: ReadonlySet<string> = new Set<string>([...LEGACY_CODES, ...OTHER_CODES, ...NEW_API_CODES]);

/** 印のある WeiwudiError が持ってよい code の書式（新しい SW の未知の code を消さない。m3-t8・I4・R24） */
const CODE_FORMAT = /^[a-z][a-z0-9-]*$/;

/** code の書式に合うか（ページ側の postV2 も SW の答えの code をこれで確かめる。m3-t8 i-1） */
export const isCodeFormat = (code: unknown): code is string => typeof code === 'string' && CODE_FORMAT.test(code);

// 別のバンドル・別のコピーの errors.ts で作られた WeiwudiError も見分けるための印（#33）
const BRAND = Symbol.for('@c4h/weiwudi/error');

/** タイルの取得・保存の失敗の種類。応答ヘッダ x-weiwudi-error と fetchAll の errors に使う */
export type TileFailure = 'network' | 'upstream' | 'quota' | 'storage';

/**
 * 旧 API の文面の表（唯一の出どころ）。`${name}` は差し込み値。
 * 文面は 1 字も変えない（仕様 §9）。from は上から照合する。
 */
const LEGACY_TABLE: readonly (readonly [LegacyErrorCode, string])[] = [
  ['sw-unsupported', 'Error: Service worker is not supported'],
  ['sw-register-failed', 'Error: Service worker registration failed with ${error}'],
  ['sw-not-controlling', 'Error: Service worker did not control this page within 10000 ms'],
  ['sw-not-implemented', 'Weiwudi service worker is not implemented.'],
  ['map-id-required', 'MapID is necessary.'],
  ['instance-released', 'This instance is already released.'],
  ['attribute-missing', 'Error: Attribute "${target}" is missing'],
  ['attribute-invalid', 'Error: Attribute "cacheMaxBytes" is not a valid non-negative integer'],
  ['unknown-type', 'Error: Unknown "type" value'],
  ['map-not-found', 'Error: MapID "${mapID}" not found'],
  ['map-busy', 'Error: ${mapID} is under fetching process. Please cancel it first'],
  ['no-fetch-process', 'Error: There are no fetching process of ${mapID}'],
  ['cache-path-invalid', 'Error: "cache" api needs mapID, zoom, x, y settings'],
  ['cannot-fetch-all', 'Error: Map "${mapID}" cannot fetch all tiles'],
  ['fetch-busy', 'Error: Another fetching process is running: "${mapID}" (${count} / ${total})'],
  ['api-not-found', 'Error: API ${apiName} not found'],
];

const PLACEHOLDER = /\$\{(\w+)\}/g;

const TEMPLATES = new Map<LegacyErrorCode, string>(LEGACY_TABLE.map(([code, template]) => [code, template]));

// 文面の固定部分と差し込み値の名前。照合は正規表現を使わず、固定部分の位置で切る
// （区切りの多い長い文字列で、正規表現のバックトラックが長さの 2〜3 乗で遅くなるため）
const MATCHERS = LEGACY_TABLE.map(([code, template], order) => {
  const parts = template.split(PLACEHOLDER);
  const names = parts.filter((_p, i) => i % 2 === 1);
  const fixed = parts.filter((_p, i) => i % 2 === 0);
  const fixedLength = fixed.reduce((n, p) => n + p.length, 0);
  return { code, names, fixed, fixedLength, order };
});

type Matcher = typeof MATCHERS[number];

/**
 * 1 行の文面として切れるかを調べ、切れたら差し込み値を返す。先頭と末尾の固定部分で絞り、
 * 間の区切りは右から lastIndexOf で探す（どの区切りも最後の出現を採る。手間は文字列の長さに比例）。
 * 区切りは各区切りの最後の出現で分ける。差し込みが 2 つ以上ある行の detail の分け方は保証しない
 * （code の判定と、文面を作り直せることだけを保証する）。
 * 区切りの並びが成り立つ切り方が 1 つでもあれば、右からの探し方で必ず見つかる
 */
const splitLegacy = (m: Matcher, text: string): string[] | undefined => {
  const { fixed } = m;
  const head = fixed[0];
  const tail = fixed[fixed.length - 1];
  if (fixed.length === 1) return text === head ? [] : undefined;
  if (text.length < head.length + tail.length) return undefined;
  if (!text.startsWith(head) || !text.endsWith(tail)) return undefined;
  const lo = head.length;
  let end = text.length - tail.length;
  const values: string[] = [];
  for (let k = fixed.length - 2; k >= 1; k--) {
    const sep = fixed[k];
    const pos = end - sep.length < lo ? -1 : text.lastIndexOf(sep, end - sep.length);
    if (pos < lo) return undefined;
    values.unshift(text.slice(pos + sep.length, end));
    end = pos;
  }
  values.unshift(text.slice(lo, end));
  return values;
};

/**
 * 文字列を表と照合する。候補は、取り出した差し込み値で legacyMessage が元の文字列をそのまま
 * 作り直せる行に限る。差し込み値が別の文面を含み、同じ文字列が複数の行から作れるときは、
 * 先頭の固定部分（最初の差し込みより前）が長い行を選ぶ。同点なら固定部分の総長が長い行、
 * それも同点なら表の順
 */
const matchLegacy = (text: string): { code: LegacyErrorCode; detail?: Record<string, unknown> } | undefined => {
  let best: { m: Matcher; detail?: Record<string, string> } | undefined;
  for (const m of MATCHERS) {
    const values = splitLegacy(m, text);
    if (!values) continue;
    const detail = m.names.length === 0 ? undefined : Object.fromEntries(m.names.map((name, i) => [name, values[i]]));
    if (legacyMessage(m.code, detail) !== text) continue;
    if (!best || isBetter(m, best.m)) best = { m, detail };
  }
  if (!best) return undefined;
  return best.detail ? { code: best.m.code, detail: best.detail } : { code: best.m.code };
};

const isBetter = (a: Matcher, b: Matcher) =>
  a.fixed[0].length !== b.fixed[0].length ? a.fixed[0].length > b.fixed[0].length
    : a.fixedLength !== b.fixedLength ? a.fixedLength > b.fixedLength
      : a.order < b.order;

/** 旧 API の文面の唯一の出どころ */
export const legacyMessage = (code: LegacyErrorCode, params?: Record<string, string | number>): string => {
  const template = TEMPLATES.get(code);
  if (template === undefined) throw new Error(`Unknown legacy error code: ${code}`);
  return template.replace(PLACEHOLDER, (_m, name: string) => String(params?.[name]));
};

/** 例外名からの分類（包括の `Error: ${e}` と Error・DOMException に使う） */
const codeOfName = (name: string | undefined): WeiwudiErrorCode => {
  if (name === 'QuotaExceededError') return 'quota';
  if (name === 'BlockedError') return 'db-blocked';
  return 'internal';
};

// Error.isError（ES2026）は [[ErrorData]] を見るので、Error を装う Proxy や素の object を通さない。
// 試験で差し替えられるよう、呼ぶたびに読む
const getNativeIsError = (): ((v: unknown) => boolean) | undefined => {
  const f = (Error as unknown as { isError?: unknown }).isError;
  return typeof f === 'function' ? (f as (v: unknown) => boolean) : undefined;
};

const isDOMException = (value: unknown): boolean =>
  typeof DOMException === 'function' && value instanceof DOMException;

/**
 * 本物の Error・DOMException だけを例外として扱う（name を持つだけの object は含めない）。
 * - Error.isError がある環境: Error.isError か DOMException の instanceof。Firefox・WebKit では
 *   Error.isError(DOMException) が false になりうるので、DOMException は instanceof でも拾う
 * - Error.isError が無い環境（Node 22 など）: Error か DOMException の instanceof。
 *   instanceof はプロトタイプを差し替えた object や Proxy で装えるので、ここでは見分けきれない
 *   （そのため、そのまま返すかどうかは isWeiwudiErrorLike で自前のプロパティも見る）。
 *   toString の印は Symbol.toStringTag で装えるので使わない
 * 読み取りが throw する値は呼び出し側（from）で受け止める
 */
const isErrorLike = (value: unknown): value is Error => {
  const nativeIsError = getNativeIsError();
  if (nativeIsError) return nativeIsError(value) || isDOMException(value);
  return value instanceof Error || isDOMException(value);
};

/** String(value) が投げる値（Symbol.toPrimitive を持たない Proxy など）でも文字列にする */
const safeString = (value: unknown): string => {
  try {
    return String(value);
  } catch (_e) {
    return '[unprintable]';
  }
};

/** 自前の（継承でも getter でもない）データプロパティの値。無ければ undefined */
const ownDataValue = (value: object, key: string | symbol): { value: unknown; enumerable: boolean } | undefined => {
  const desc = Object.getOwnPropertyDescriptor(value, key);
  if (!desc || !('value' in desc)) return undefined;
  return { value: desc.value, enumerable: !!desc.enumerable };
};

/**
 * 別のコピーの WeiwudiError として、そのまま返してよいか。
 * **そのまま返すのは、本物の Error で、code を自前の文字列として持つものだけ。**
 * そのうえで次のどちらかを求める。
 * - 印（Symbol.for('@c4h/weiwudi/error')）を、列挙されない自前のデータプロパティとして持ち、code が CODE_FORMAT に合う
 *   （未知の code も保つ。新しい SW・新しい版のコピーが増やした code を internal に潰さない。m3-t8・I4・R24）
 * - name が 'WeiwudiError' で、code が既知（印を付けない別の作り方の救済。どちらの環境でも認める。未知の code は救わない）
 * 素の object・Proxy・toStringTag の偽装は、本物の Error の判定（isErrorLike）で落ちる。
 * ただし Error.isError の無い環境では本物の Error かどうかを instanceof でしか見られないので、
 * Object.create(WeiwudiError.prototype) などでプロトタイプを継いで作った object に、印か name と
 * code を自前のデータとして付ければ装える（その限界は試験で固定し、文書にも書く）。
 * 偽装した object を渡すのは呼び出し側自身であり、安全上の境界ではない
 */
const isWeiwudiErrorLike = (value: unknown): value is WeiwudiError => {
  if (typeof value !== 'object' || value === null) return false;
  if (!isErrorLike(value)) return false;
  const code = ownDataValue(value, 'code');
  if (!code || typeof code.value !== 'string') return false;
  const brand = ownDataValue(value, BRAND);
  if (brand && brand.value === true && !brand.enumerable) return CODE_FORMAT.test(code.value);
  if (!KNOWN_CODES.has(code.value)) return false;
  const name = ownDataValue(value, 'name')?.value ?? (value as { name?: unknown }).name;
  return name === 'WeiwudiError';
};

const fromUnsafe = (value: unknown): WeiwudiError => {
  if (isWeiwudiErrorLike(value)) return value;
  if (typeof value === 'string') {
    const legacy = matchLegacy(value);
    if (legacy) return new WeiwudiError(legacy.code, value, legacy.detail);
    // 包括の `Error: ${e}` は、後ろの例外名で分類する。名前の直後は `:` か文末に限る
    // （`Error: QuotaExceededErrorX` や `Error: QuotaExceededError foo` は分類しない）
    const named = value.match(/^Error: (\w+)(?::|$)/);
    return new WeiwudiError(codeOfName(named ? named[1] : undefined), value);
  }
  if (isErrorLike(value)) {
    const name = value.name;
    const message = value.message;
    return new WeiwudiError(codeOfName(typeof name === 'string' ? name : undefined),
      typeof message === 'string' ? message : safeString(value));
  }
  return new WeiwudiError('internal', safeString(value));
};

export class WeiwudiError extends Error {
  readonly code: WeiwudiErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: WeiwudiErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'WeiwudiError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    // 別のコピーの errors.ts からも見分けられる印。列挙されない自前のデータプロパティにする
    Object.defineProperty(this, BRAND, { value: true, enumerable: false, writable: false, configurable: false });
  }

  /**
   * 文字列・Error・その他から作る。どんな値を渡しても throw しない。
   * そのまま返すのは、本物の Error で、code を自前の文字列として持ち、印があって code が書式（/^[a-z][a-z0-9-]*$/）に
   * 合うもの（未知の code も保つ）か、name が 'WeiwudiError' で code が既知のものだけ（別のコピーの WeiwudiError を含む）。
   * 読み取りの途中で例外が起きる値（throw する getter・Proxy など）は internal で作り直す
   */
  static from(value: unknown): WeiwudiError {
    try {
      return fromUnsafe(value);
    } catch (_e) {
      return new WeiwudiError('internal', safeString(value));
    }
  }
}
