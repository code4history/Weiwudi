// 複数のファイルが使う定数の唯一の置き場（m3-t1・I5・R27）。import を持たない（仕様 §3。全ファイルが import してよい）。

/** 疑似ホスト（仕様 §4.1）。旧 API（/api/*）と制御（/v2/*）の相手。実 URL のテンプレートに使えない */
export const PSEUDO_HOST = 'weiwudi.example.com';
/** 旧 API の Source と Resource の id の前置き（仕様 §5.1）。新 API の id には使えない */
export const LEGACY_PREFIX = 'map:';
/** 既定の時間（24 時間）。新 API の cacheTtl の既定・旧 API の既定の鮮度・CORS なしの上流を覚える期間 */
export const DAY_MS = 24 * 60 * 60 * 1000;
/** 制御のパスの前置き（仕様 §4.1） */
export const V2_PREFIX = '/v2/';
