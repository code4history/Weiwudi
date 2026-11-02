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

// 文面を照合する正規表現・差し込み値の名前・固定部分の長さ。
// 差し込み値が複数あると切れ目が一意に決まらないことがあるので、差し込みごとに貪欲・非貪欲の
// 組み合わせを全部作る（差し込みは最大 3 つなので 8 通りまで）。先頭は全部貪欲
const MATCHERS = LEGACY_TABLE.map(([code, template], order) => {
  const parts = template.split(PLACEHOLDER);
  const names = parts.filter((_p, i) => i % 2 === 1);
  const fixed = parts.filter((_p, i) => i % 2 === 0);
  const fixedLength = fixed.reduce((n, p) => n + p.length, 0);
  const escaped = fixed.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regexes: RegExp[] = [];
  for (let mask = 0; mask < (1 << names.length); mask++) {
    let pattern = escaped[0];
    names.forEach((_n, i) => {
      pattern += (mask & (1 << i)) ? '([\\s\\S]*?)' : '([\\s\\S]*)';
      pattern += escaped[i + 1];
    });
    regexes.push(new RegExp(`^${pattern}$`));
  }
  return { code, names, fixedLength, order, regexes };
});

const isLegacyMessage = (text: string) => MATCHERS.some(({ regexes }) => regexes[0].test(text));

/**
 * 文字列を表と照合する。差し込み値に別の文面が入ると複数の行に当たりうるので、次の順で 1 つ選ぶ。
 * 1. 差し込み値が丸ごと旧 API の文面になっている数が多いもの（入れ子の外側を選ぶ）
 * 2. 固定部分が長いもの（具体的なもの）
 * 3. 表の順
 * 4. 貪欲な切り方を先に
 */
const matchLegacy = (text: string): { code: LegacyErrorCode; detail?: Record<string, unknown> } | undefined => {
  const candidates = MATCHERS.flatMap((m) => m.regexes.flatMap((regex, variant) => {
    const found = text.match(regex);
    if (!found) return [];
    const values = found.slice(1);
    return [{ m, variant, values, nested: values.filter(isLegacyMessage).length }];
  }));
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) =>
    (b.nested - a.nested) || (b.m.fixedLength - a.m.fixedLength) || (a.m.order - b.m.order) ||
    (a.variant - b.variant));
  const { m, values } = candidates[0];
  if (m.names.length === 0) return { code: m.code };
  const detail: Record<string, unknown> = {};
  m.names.forEach((name, i) => { detail[name] = values[i]; });
  return { code: m.code, detail };
};

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

/** 本物の Error・DOMException だけを例外として扱う（name を持つだけの object は含めない） */
const isErrorLike = (value: unknown): value is Error => {
  if (value instanceof Error) return true;
  const tag = Object.prototype.toString.call(value);
  return tag === '[object Error]' || tag === '[object DOMException]';
};

/** 別のコピーの WeiwudiError か。印で見分け、印が無ければ name と既知の code で見分ける */
const isWeiwudiErrorLike = (value: unknown): value is WeiwudiError => {
  if (typeof value !== 'object' || value === null) return false;
  if ((value as Record<symbol, unknown>)[BRAND] === true) return true;
  const v = value as { name?: unknown; code?: unknown };
  return isErrorLike(value) && v.name === 'WeiwudiError' && typeof v.code === 'string' && KNOWN_CODES.has(v.code);
};

export class WeiwudiError extends Error {
  readonly code: WeiwudiErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: WeiwudiErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'WeiwudiError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    Object.defineProperty(this, BRAND, { value: true });
  }

  /** 文字列・Error・その他から作る。WeiwudiError はそのまま返す */
  static from(value: unknown): WeiwudiError {
    if (value instanceof WeiwudiError || isWeiwudiErrorLike(value)) return value;
    if (typeof value === 'string') {
      const legacy = matchLegacy(value);
      if (legacy) return new WeiwudiError(legacy.code, value, legacy.detail);
      // 包括の `Error: ${e}` は、後ろの例外名で分類する
      const named = value.match(/^Error: (\w+)(?::|$)/);
      return new WeiwudiError(codeOfName(named ? named[1] : undefined), value);
    }
    if (isErrorLike(value)) {
      return new WeiwudiError(codeOfName(value.name), typeof value.message === 'string' ? value.message : String(value));
    }
    return new WeiwudiError('internal', String(value));
  }
}
