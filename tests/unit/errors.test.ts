// src/errors.ts のユニットテスト（#33）。
// 旧 API の文面は 1 字も変えない（仕様 §9）。文面の固定の試験だけは文字列を直書きする。
import { describe, expect, it, vi } from 'vitest';
import { WeiwudiError, legacyMessage, type LegacyErrorCode } from '../../src/errors';

// [code, 差し込み値, 現行の文面（直書き）, from で detail に入る値]
const LEGACY: [LegacyErrorCode, Record<string, string | number> | undefined, string, Record<string, unknown> | undefined][] = [
  ['sw-unsupported', undefined, 'Error: Service worker is not supported', undefined],
  ['sw-register-failed', { error: 'TypeError: bad scope' }, 'Error: Service worker registration failed with TypeError: bad scope', { error: 'TypeError: bad scope' }],
  ['sw-not-controlling', undefined, 'Error: Service worker did not control this page within 10000 ms', undefined],
  ['sw-not-implemented', undefined, 'Weiwudi service worker is not implemented.', undefined],
  ['map-id-required', undefined, 'MapID is necessary.', undefined],
  ['instance-released', undefined, 'This instance is already released.', undefined],
  ['attribute-missing', { target: 'width' }, 'Error: Attribute "width" is missing', { target: 'width' }],
  ['attribute-invalid', undefined, 'Error: Attribute "cacheMaxBytes" is not a valid non-negative integer', undefined],
  ['unknown-type', undefined, 'Error: Unknown "type" value', undefined],
  ['map-not-found', { mapID: 'x' }, 'Error: MapID "x" not found', { mapID: 'x' }],
  ['map-busy', { mapID: 'x' }, 'Error: x is under fetching process. Please cancel it first', { mapID: 'x' }],
  ['no-fetch-process', { mapID: 'x' }, 'Error: There are no fetching process of x', { mapID: 'x' }],
  ['cache-path-invalid', undefined, 'Error: "cache" api needs mapID, zoom, x, y settings', undefined],
  ['cannot-fetch-all', { mapID: 'x' }, 'Error: Map "x" cannot fetch all tiles', { mapID: 'x' }],
  ['fetch-busy', { mapID: 'x', count: 3, total: 21 }, 'Error: Another fetching process is running: "x" (3 / 21)', { mapID: 'x', count: '3', total: '21' }],
  ['api-not-found', { apiName: 'nope' }, 'Error: API nope not found', { apiName: 'nope' }],
];

describe('legacyMessage の文面の固定', () => {
  it('表は 16 行', () => {
    expect(LEGACY.length).toBe(16);
    expect(new Set(LEGACY.map(([code]) => code)).size).toBe(16);
  });

  it.each(LEGACY)('%s の文面は現行のまま', (code, params, text) => {
    expect(legacyMessage(code, params)).toBe(text);
  });
});

describe('WeiwudiError.from の往復', () => {
  it.each(LEGACY)('%s の文面から同じ code に戻る', (code, params, _text, detail) => {
    const e = WeiwudiError.from(legacyMessage(code, params));
    expect(e).toBeInstanceOf(WeiwudiError);
    expect(e.code).toBe(code);
    expect(e.message).toBe(legacyMessage(code, params));
    expect(e.detail).toEqual(detail);
  });

  it('差し込み値が detail に入る（map-not-found → { mapID }）', () => {
    expect(WeiwudiError.from('Error: MapID "x" not found').detail).toEqual({ mapID: 'x' });
  });
});

describe('WeiwudiError.from の例外名による分類', () => {
  it('Error: QuotaExceededError: … → quota', () => {
    expect(WeiwudiError.from('Error: QuotaExceededError: The quota has been exceeded.').code).toBe('quota');
  });

  it('Error: BlockedError: … → db-blocked', () => {
    expect(WeiwudiError.from('Error: BlockedError: Opening database "Weiwudi" is blocked by another connection').code).toBe('db-blocked');
  });

  it('Error: Foo → internal', () => {
    const e = WeiwudiError.from('Error: Foo');
    expect(e.code).toBe('internal');
    expect(e.message).toBe('Error: Foo');
  });

  it('DOMException(QuotaExceededError) → quota', () => {
    const e = WeiwudiError.from(new DOMException('over', 'QuotaExceededError'));
    expect(e.code).toBe('quota');
    expect(e.message).toBe('over');
  });

  it('name が BlockedError の Error → db-blocked', () => {
    const err = new Error('blocked');
    err.name = 'BlockedError';
    expect(WeiwudiError.from(err).code).toBe('db-blocked');
  });

  it('その他の Error → internal', () => {
    expect(WeiwudiError.from(new TypeError('x')).code).toBe('internal');
  });

  it('文字列でも Error でもない値 → String(value) で internal', () => {
    const e = WeiwudiError.from(42);
    expect(e.code).toBe('internal');
    expect(e.message).toBe('42');
  });
});

describe('WeiwudiError', () => {
  it('WeiwudiError を渡すと同じものが返る', () => {
    const e = new WeiwudiError('network', 'down');
    expect(WeiwudiError.from(e)).toBe(e);
  });

  it('Error の派生で、name・code・detail を持つ', () => {
    const e = new WeiwudiError('quota', 'full', { mapID: 'm' });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(WeiwudiError);
    expect(e.name).toBe('WeiwudiError');
    expect(e.code).toBe('quota');
    expect(e.message).toBe('full');
    expect(e.detail).toEqual({ mapID: 'm' });
  });
});

describe('別のコピーの WeiwudiError（#33 レビュー）', () => {
  it('errors.ts をもう一度読み込んだ別のクラスのインスタンスも、そのまま返し code・detail を保つ', async () => {
    vi.resetModules();
    const other = await import('../../src/errors');
    expect(other.WeiwudiError).not.toBe(WeiwudiError);
    const e = new other.WeiwudiError('map-not-found', 'Error: MapID "x" not found', { mapID: 'x' });
    expect(e instanceof WeiwudiError).toBe(false);
    const got = WeiwudiError.from(e);
    expect(got).toBe(e);
    expect(got.code).toBe('map-not-found');
    expect(got.detail).toEqual({ mapID: 'x' });
  });

  it('印が無くても、name が WeiwudiError で code が既知の Error は WeiwudiError と見なす', () => {
    const err = Object.assign(new Error('full'), { name: 'WeiwudiError', code: 'quota', detail: { mapID: 'm' } });
    const got = WeiwudiError.from(err);
    expect(got.code).toBe('quota');
    expect(got.detail).toEqual({ mapID: 'm' });
  });

  it('name が WeiwudiError でも code が未知なら internal', () => {
    const err = Object.assign(new Error('x'), { name: 'WeiwudiError', code: 'nope' });
    expect(WeiwudiError.from(err).code).toBe('internal');
  });
});

describe('Error でない object（#33 レビュー）', () => {
  it('name を持つだけの object は name で分類しない', () => {
    const e = WeiwudiError.from({ name: 'QuotaExceededError' });
    expect(e.code).toBe('internal');
    expect(e.message).toBe('[object Object]');
  });

  it('name が WeiwudiError で code が既知でも、Error でない object はそのまま返さない', () => {
    const fake = { name: 'WeiwudiError', code: 'quota', message: 'x' };
    const e = WeiwudiError.from(fake);
    expect(e).not.toBe(fake);
    expect(e.code).toBe('internal');
  });
});

describe('文面の照合順（#33 レビュー）', () => {
  // 各行の固定部分を、差し込み値に印の文字を入れた legacyMessage から取り出す（実装の内部を使わない）
  const MARK = '\u0000';
  const FIXED = new Map(LEGACY.map(([code, params]) => {
    const marked = Object.fromEntries(Object.keys(params ?? {}).map((k) => [k, MARK]));
    return [code, legacyMessage(code, marked).split(MARK)] as const;
  }));
  const ORDER = LEGACY.map(([code]) => code);
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // その文字列を作れる行（差し込み値をどう選んでも同じ文字列になるか）を正規表現で数える。試験だけの素朴な判定
  const producers = (text: string) => ORDER.filter((code) =>
    new RegExp(`^${FIXED.get(code)!.map(escape).join('[\\s\\S]*')}$`).test(text));
  // 規則: 先頭の固定部分が長い → 固定部分の総長が長い → 表の順
  const byRule = (codes: LegacyErrorCode[]) => [...codes].sort((a, b) => {
    const fa = FIXED.get(a)!, fb = FIXED.get(b)!;
    const total = (f: string[]) => f.reduce((n, p) => n + p.length, 0);
    return (fb[0].length - fa[0].length) || (total(fb) - total(fa)) || (ORDER.indexOf(a) - ORDER.indexOf(b));
  })[0];

  it('同じ文字列になる例: map-busy の mapID と sw-register-failed の error は区別できず、先頭の固定部分が長い sw-register-failed', () => {
    const a = legacyMessage('map-busy', { mapID: 'Service worker registration failed with x' });
    const b = legacyMessage('sw-register-failed', { error: 'x is under fetching process. Please cancel it first' });
    expect(a).toBe(b);
    expect(a).toBe('Error: Service worker registration failed with x is under fetching process. Please cancel it first');
    const e = WeiwudiError.from(a);
    expect(e.code).toBe('sw-register-failed');
    expect(e.detail).toEqual({ error: 'x is under fetching process. Please cancel it first' });
  });

  it('no-fetch-process の mapID に map-busy の後半を入れても no-fetch-process', () => {
    const text = legacyMessage('no-fetch-process', { mapID: 'x is under fetching process. Please cancel it first' });
    const e = WeiwudiError.from(text);
    expect(e.code).toBe('no-fetch-process');
    expect(e.detail).toEqual({ mapID: 'x is under fetching process. Please cancel it first' });
  });

  // 差し込み値を持つ各 code の、各差し込み値に、16 行すべての文面を入れる
  const MESSAGES = LEGACY.map(([code, params]) => legacyMessage(code, params));
  const NESTED = LEGACY.flatMap(([code, params]) =>
    Object.keys(params ?? {}).flatMap((name) =>
      MESSAGES.map((inner, i) => [code, name, LEGACY[i][0], { ...params, [name]: inner }] as const)));
  // 同じ文字列が複数の行から作れる組は、往復では区別できないので分ける
  const AMBIGUOUS = NESTED.filter(([, , , params], i) => producers(legacyMessage(NESTED[i][0], params)).length > 1);
  const UNIQUE = NESTED.filter((n) => !AMBIGUOUS.includes(n));

  it('組み合わせは 160 通りで、同じ文字列になる組を機械的に分けた', () => {
    expect(NESTED.length).toBe(10 * 16);
    expect(UNIQUE.length + AMBIGUOUS.length).toBe(160);
    // 同じ文字列になる組の一覧（どの行の差し込みに、どの行の文面を入れたか）
    expect(AMBIGUOUS.map(([code, name, inner]) => `${code}.${name} <- ${inner}`)).toEqual([
      'sw-register-failed.error <- map-busy',
      'no-fetch-process.mapID <- map-busy',
    ]);
  });

  it.each(UNIQUE)('%s の %s に %s の文面を入れても元の code に戻り、文面を作り直せる', (code, name, _inner, params) => {
    const text = legacyMessage(code, params);
    const e = WeiwudiError.from(text);
    expect(e.code).toBe(code);
    expect(legacyMessage(code, e.detail as Record<string, string>)).toBe(text);
    // 差し込みが 1 つの行は切れ目が一意なので、差し込み値もそのまま戻る
    if (Object.keys(params).length === 1) expect(e.detail?.[name]).toBe(String(params[name]));
  });

  it.each(AMBIGUOUS)('同じ文字列になる組: %s の %s に %s の文面 → 規則どおりの code', (code, _name, _inner, params) => {
    const text = legacyMessage(code, params);
    const expected = byRule(producers(text));
    const e = WeiwudiError.from(text);
    expect(e.code).toBe(expected);
    expect(legacyMessage(e.code as LegacyErrorCode, e.detail as Record<string, string>)).toBe(text);
  });
});

describe('照合の速さ（#33 レビュー）', () => {
  const fast = (text: string) => {
    const start = performance.now();
    const e = WeiwudiError.from(text);
    return { e, ms: performance.now() - start };
  };

  it('10 万字の当たらない文字列 → 50 ms 未満で internal', () => {
    const { e, ms } = fast('Error: ' + 'a'.repeat(100_000));
    expect(e.code).toBe('internal');
    expect(ms).toBeLessThan(50);
  });

  it('区切りだらけの 10 万字（fetch-busy の先頭と区切りを繰り返す）→ 50 ms 未満', () => {
    const text = 'Error: Another fetching process is running: "' + '" ( / '.repeat(17_000) + 'x';
    expect(text.length).toBeGreaterThan(100_000);
    const { e, ms } = fast(text);
    expect(e.code).toBe('internal');
    expect(ms).toBeLessThan(50);
  });

  it('区切りだらけで末尾も合う 10 万字 → 50 ms 未満で fetch-busy', () => {
    const text = 'Error: Another fetching process is running: "' + '" ( / '.repeat(17_000) + ')';
    const { e, ms } = fast(text);
    expect(e.code).toBe('fetch-busy');
    expect(legacyMessage('fetch-busy', e.detail as Record<string, string>)).toBe(text);
    expect(ms).toBeLessThan(50);
  });

  it.each(['map-not-found', 'map-busy', 'no-fetch-process', 'cannot-fetch-all', 'fetch-busy'] as const)(
    '正しい文面で mapID が 1 万字（%s）→ 50 ms 未満で当たる', (code) => {
      const mapID = 'm'.repeat(10_000);
      const text = legacyMessage(code, { mapID, count: 3, total: 21 });
      const { e, ms } = fast(text);
      expect(e.code).toBe(code);
      expect(e.detail?.mapID).toBe(mapID);
      expect(ms).toBeLessThan(50);
    });
});

describe('印の偽装（#33 レビュー）', () => {
  const BRAND = Symbol.for('@c4h/weiwudi/error');

  it('印だけの object → 新しく作り internal', () => {
    const fake = { [BRAND]: true };
    const e = WeiwudiError.from(fake);
    expect(e).not.toBe(fake);
    expect(e.code).toBe('internal');
  });

  it('印付きの { code: quota } → 新しく作り internal', () => {
    const fake = { [BRAND]: true, code: 'quota', name: 'WeiwudiError', message: 'x' };
    const e = WeiwudiError.from(fake);
    expect(e).not.toBe(fake);
    expect(e.code).toBe('internal');
  });

  it('Error を装う Proxy（instanceof も toString も Error に見せる）→ 新しく作り internal', () => {
    const fake = new Proxy({}, {
      getPrototypeOf: () => WeiwudiError.prototype,
      get: (_t, k) => (k === BRAND ? true : k === 'code' ? 'quota' : k === 'name' ? 'WeiwudiError'
        : k === Symbol.toStringTag ? 'Error' : undefined),
    });
    const e = WeiwudiError.from(fake);
    expect(e).not.toBe(fake);
    expect(e.code).toBe('internal');
  });

  it('本物の WeiwudiError はそのまま返る（印・Error・既知の code を満たす）', () => {
    const e = new WeiwudiError('quota', 'full');
    expect(WeiwudiError.from(e)).toBe(e);
  });
});

describe('旧実装（5256d9c）との比較（#33 レビュー）', () => {
  // 5256d9c の errors.ts で WeiwudiError.from を実行して得た code と detail（前置きあり／なし）
  const OLD: [string, string, Record<string, string> | null][] = [
    ['Error: Service worker is not supported', 'sw-unsupported', null],
    ['Error: Service worker registration failed with TypeError: bad', 'sw-register-failed', { error: 'TypeError: bad' }],
    ['Error: Service worker did not control this page within 10000 ms', 'sw-not-controlling', null],
    ['Weiwudi service worker is not implemented.', 'sw-not-implemented', null],
    ['MapID is necessary.', 'map-id-required', null],
    ['This instance is already released.', 'instance-released', null],
    ['Error: Attribute "width" is missing', 'attribute-missing', { target: 'width' }],
    ['Error: Attribute "cacheMaxBytes" is not a valid non-negative integer', 'attribute-invalid', null],
    ['Error: Unknown "type" value', 'unknown-type', null],
    ['Error: MapID "x" not found', 'map-not-found', { mapID: 'x' }],
    ['Error: x is under fetching process. Please cancel it first', 'map-busy', { mapID: 'x' }],
    ['Error: There are no fetching process of x', 'no-fetch-process', { mapID: 'x' }],
    ['Error: "cache" api needs mapID, zoom, x, y settings', 'cache-path-invalid', null],
    ['Error: Map "x" cannot fetch all tiles', 'cannot-fetch-all', { mapID: 'x' }],
    ['Error: Another fetching process is running: "x" (3 / 21)', 'fetch-busy', { mapID: 'x', count: '3', total: '21' }],
    ['Error: API nope not found', 'api-not-found', { apiName: 'nope' }],
    ['Error: QuotaExceededError: The quota has been exceeded.', 'quota', null],
    ['Error: QuotaExceededError', 'quota', null],
    ['Error: BlockedError: Opening database "Weiwudi" is blocked by another connection', 'db-blocked', null],
    ['Error: NotFoundError: x', 'internal', null],
    ['Error: [object Event]', 'internal', null],
    ['Error: Foo', 'internal', null],
    ['QuotaExceededError: x', 'internal', null],
    ['BlockedError: x', 'internal', null],
    ['MapID "x" not found', 'internal', null],
    ['Service worker is not supported', 'internal', null],
    ['x is under fetching process. Please cancel it first', 'internal', null],
    ['Error:QuotaExceededError', 'internal', null],
    ['', 'internal', null],
  ];

  it.each(OLD)('%j → %s（旧実装と同じ）', (text, code, detail) => {
    const e = WeiwudiError.from(text);
    expect(e.code).toBe(code);
    expect(e.detail ?? null).toEqual(detail);
  });
});

describe('新 API の code（#33 レビュー）', () => {
  it.each([
    'unsupported-template', 'invalid-style', 'opaque', 'sw-outdated',
    'credential-rejected', 'source-not-found', 'resource-conflict',
  ] as const)('%s で WeiwudiError を作れ、別のコピーの判定でも既知として扱う', (code) => {
    const err = Object.assign(new Error('x'), { name: 'WeiwudiError', code });
    expect(WeiwudiError.from(err).code).toBe(code);
    expect(new WeiwudiError(code, 'x').code).toBe(code);
  });
});

// ---- 第 3 回レビュー: Error.isError の有無・偽装・from が throw しないこと ----

type IsError = (v: unknown) => boolean;
const ORIGINAL_IS_ERROR = Object.getOwnPropertyDescriptor(Error, 'isError');
const realIsError = (Error as unknown as { isError?: IsError }).isError;

/** Error.isError を外す（undefined）か差し替えて fn を走らせ、元に戻す */
const withIsError = (impl: IsError | undefined, fn: () => void) => {
  if (impl === undefined) delete (Error as unknown as { isError?: IsError }).isError;
  else Object.defineProperty(Error, 'isError', { value: impl, configurable: true, writable: true });
  try {
    fn();
  } finally {
    if (ORIGINAL_IS_ERROR) Object.defineProperty(Error, 'isError', ORIGINAL_IS_ERROR);
    else delete (Error as unknown as { isError?: IsError }).isError;
  }
};

const BRAND_KEY = Symbol.for('@c4h/weiwudi/error');

// 「ある経路」は本物の Error.isError（node 24）。無い環境の試験なら、[[ErrorData]] の判定を真似た関数で代える
const PATHS: [string, IsError | undefined][] = [
  ['Error.isError がある経路', realIsError ?? ((v) => v instanceof Error && Object.prototype.toString.call(v) === '[object Error]')],
  ['Error.isError が無い経路（Node 22 相当）', undefined],
];

describe.each(PATHS)('%s', (_label, impl) => {
  it('前提: Error.isError の有無が切り替わっている', () => {
    withIsError(impl, () => {
      expect(typeof (Error as unknown as { isError?: IsError }).isError).toBe(impl ? 'function' : 'undefined');
    });
  });

  it('Symbol.toStringTag で Error を名乗り、name・code・印を付けた素の object → 作り直して internal', () => {
    withIsError(impl, () => {
      const fake = { [Symbol.toStringTag]: 'Error', name: 'WeiwudiError', code: 'quota', message: 'x', [BRAND_KEY]: true };
      const e = WeiwudiError.from(fake);
      expect(e).not.toBe(fake);
      expect(e.code).toBe('internal');
    });
  });

  it('印付きの { code: quota } → 作り直して internal', () => {
    withIsError(impl, () => {
      const fake = { [BRAND_KEY]: true, code: 'quota' };
      const e = WeiwudiError.from(fake);
      expect(e).not.toBe(fake);
      expect(e.code).toBe('internal');
    });
  });

  it('Error を装う Proxy（instanceof・toString・印・code）→ 作り直して internal', () => {
    withIsError(impl, () => {
      const fake = new Proxy({}, {
        getPrototypeOf: () => WeiwudiError.prototype,
        get: (_t, k) => (k === BRAND_KEY ? true : k === 'code' ? 'quota' : k === 'name' ? 'WeiwudiError'
          : k === Symbol.toStringTag ? 'Error' : undefined),
      });
      const e = WeiwudiError.from(fake);
      expect(e).not.toBe(fake);
      expect(e.code).toBe('internal');
    });
  });

  it('本物の WeiwudiError は同じものが返る', () => {
    withIsError(impl, () => {
      const e = new WeiwudiError('quota', 'full', { mapID: 'm' });
      expect(WeiwudiError.from(e)).toBe(e);
    });
  });

  it('別のコピーの WeiwudiError も同じものが返る（印は列挙されない自前のデータプロパティ）', async () => {
    vi.resetModules();
    const other = await import('../../src/errors');
    const e = new other.WeiwudiError('map-not-found', 'Error: MapID "x" not found', { mapID: 'x' });
    const desc = Object.getOwnPropertyDescriptor(e, BRAND_KEY);
    expect(desc).toMatchObject({ value: true, enumerable: false, writable: false });
    withIsError(impl, () => {
      expect(WeiwudiError.from(e)).toBe(e);
    });
  });

  it('本物の Error に印と code を後から列挙される形で付けたものは、そのまま返さない', () => {
    withIsError(impl, () => {
      const err = Object.assign(new Error('x'), { code: 'quota', [BRAND_KEY]: true });
      const e = WeiwudiError.from(err);
      expect(e).not.toBe(err);
      expect(e.code).toBe('internal');
    });
  });

  it('印が無くても、name が WeiwudiError で code が既知の Error は WeiwudiError と見なす（両経路）', () => {
    withIsError(impl, () => {
      const err = Object.assign(new Error('full'), { name: 'WeiwudiError', code: 'quota', detail: { mapID: 'm' } });
      const got = WeiwudiError.from(err);
      expect(got).toBe(err);
      expect(got.code).toBe('quota');
      expect(got.detail).toEqual({ mapID: 'm' });
    });
  });

  it.each([
    'unsupported-template', 'invalid-style', 'opaque', 'sw-outdated',
    'credential-rejected', 'source-not-found', 'resource-conflict',
  ] as const)('新 API の code %s を既知として扱う（両経路）', (code) => {
    withIsError(impl, () => {
      const err = Object.assign(new Error('x'), { name: 'WeiwudiError', code });
      expect(WeiwudiError.from(err).code).toBe(code);
      expect(new WeiwudiError(code, 'x').code).toBe(code);
    });
  });

  it('name が WeiwudiError でも、Error でない素の object は作り直して internal', () => {
    withIsError(impl, () => {
      const fake = { name: 'WeiwudiError', code: 'quota', message: 'x' };
      const e = WeiwudiError.from(fake);
      expect(e).not.toBe(fake);
      expect(e.code).toBe('internal');
    });
  });

  it('Object.create(WeiwudiError.prototype) で作り印と code を自前データで付けた object: Error.isError がある経路では作り直し、無い経路では素通りする（限界）', () => {
    withIsError(impl, () => {
      const crafted = Object.create(WeiwudiError.prototype) as object;
      Object.defineProperty(crafted, BRAND_KEY, { value: true, enumerable: false });
      Object.defineProperty(crafted, 'code', { value: 'quota', enumerable: true });
      const e = WeiwudiError.from(crafted);
      if (impl) {
        expect(e).not.toBe(crafted);
        expect(e.code).toBe('internal');
      } else {
        // Error.isError の無い環境では instanceof でしか本物の Error を見られない。文書に書いた限界
        expect(e).toBe(crafted);
        expect(e.code).toBe('quota');
      }
    });
  });

  it('DOMException(QuotaExceededError) → quota', () => {
    withIsError(impl, () => {
      expect(WeiwudiError.from(new DOMException('full', 'QuotaExceededError')).code).toBe('quota');
    });
  });

  it('どんな値でも from は throw しない（throw する trap・getter）', () => {
    withIsError(impl, () => {
      const boom = () => { throw new Error('boom'); };
      const proxy = new Proxy({}, { getPrototypeOf: boom, get: boom, getOwnPropertyDescriptor: boom, has: boom });
      const msgThrows = new Error('x');
      Object.defineProperty(msgThrows, 'message', { get: boom });
      const nameThrows = new Error('x');
      Object.defineProperty(nameThrows, 'name', { get: boom });
      const tagThrows = { get [Symbol.toStringTag]() { return boom(); }, toString: boom };
      const nullProto = Object.create(null);
      for (const value of [proxy, msgThrows, nameThrows, tagThrows, nullProto, Symbol('s'), undefined, null, 1n]) {
        let e: WeiwudiError | undefined;
        expect(() => { e = WeiwudiError.from(value); }).not.toThrow();
        expect(e).toBeInstanceOf(WeiwudiError);
        expect(e!.code).toBe('internal');
      }
    });
  });
});

describe('文字列にできない値（第 3 回レビュー）', () => {
  it('String が投げる値は [unprintable] になる', () => {
    const proxy = new Proxy({}, { get: () => undefined });
    expect(WeiwudiError.from(proxy).message).toBe('[unprintable]');
  });
});

describe('Error.isError(DOMException) が false の環境（Firefox・WebKit の想定）', () => {
  it('QuotaExceededError の DOMException も quota になる', () => {
    const base = realIsError ?? ((v: unknown) => v instanceof Error);
    withIsError((v) => !(v instanceof DOMException) && base(v), () => {
      expect((Error as unknown as { isError: IsError }).isError(new DOMException('x', 'QuotaExceededError'))).toBe(false);
      expect(WeiwudiError.from(new DOMException('full', 'QuotaExceededError')).code).toBe('quota');
    });
  });
});

describe('照合の速さ: apiName・target（第 3 回レビュー）', () => {
  it.each([
    ['api-not-found', 'apiName'],
    ['attribute-missing', 'target'],
  ] as const)('%s の %s が 10 万字 → 50 ms 未満で当たる', (code, name) => {
    const value = 'a'.repeat(100_000);
    const text = legacyMessage(code, { [name]: value });
    const start = performance.now();
    const e = WeiwudiError.from(text);
    const ms = performance.now() - start;
    expect(e.code).toBe(code);
    expect(e.detail?.[name]).toBe(value);
    expect(ms).toBeLessThan(50);
  });
});
