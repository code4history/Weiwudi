// エラーの具体化（#33）。依存を持たない。ページと Service Worker の両方が import する。
// 旧 API は文字列で reject し続ける（仕様 §9）。WeiwudiError.from(e) でその文字列から code を得る。

/** 旧 API に文面があるコード（16 件） */
export type LegacyErrorCode =
  | 'sw-unsupported' | 'sw-register-failed' | 'sw-not-controlling' | 'sw-not-implemented'
  | 'map-id-required' | 'instance-released'
  | 'attribute-missing' | 'attribute-invalid' | 'unknown-type'
  | 'map-not-found' | 'map-busy' | 'no-fetch-process' | 'cache-path-invalid'
  | 'cannot-fetch-all' | 'fetch-busy' | 'api-not-found';

export type WeiwudiErrorCode =
  | LegacyErrorCode
  | 'db-blocked' | 'quota' | 'network' | 'upstream' | 'storage' | 'internal';

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

// 文面を照合する正規表現と、差し込み値の名前
const MATCHERS = LEGACY_TABLE.map(([code, template]) => {
  const names: string[] = [];
  const pattern = template.split(PLACEHOLDER).map((part, i) => {
    if (i % 2 === 1) {
      names.push(part);
      return '([\\s\\S]*)';
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { code, names, regex: new RegExp(`^${pattern}$`) };
});

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

export class WeiwudiError extends Error {
  readonly code: WeiwudiErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: WeiwudiErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'WeiwudiError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  /** 文字列・Error・その他から作る。WeiwudiError はそのまま返す */
  static from(value: unknown): WeiwudiError {
    if (value instanceof WeiwudiError) return value;
    if (typeof value === 'string') {
      for (const { code, names, regex } of MATCHERS) {
        const m = value.match(regex);
        if (!m) continue;
        if (names.length === 0) return new WeiwudiError(code, value);
        const detail: Record<string, unknown> = {};
        names.forEach((name, i) => { detail[name] = m[i + 1]; });
        return new WeiwudiError(code, value, detail);
      }
      // 包括の `Error: ${e}` は、後ろの例外名で分類する
      const named = value.match(/^Error: (\w+)(?::|$)/);
      return new WeiwudiError(codeOfName(named ? named[1] : undefined), value);
    }
    if (value instanceof Error || (typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string')) {
      const err = value as { name: string; message?: unknown };
      return new WeiwudiError(codeOfName(err.name), typeof err.message === 'string' ? err.message : String(value));
    }
    return new WeiwudiError('internal', String(value));
  }
}
