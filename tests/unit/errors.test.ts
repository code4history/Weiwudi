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
  it('map-busy の mapID が sw-register-failed の固定部分で始まっても map-busy', () => {
    const text = legacyMessage('map-busy', { mapID: 'Service worker registration failed with x' });
    const e = WeiwudiError.from(text);
    expect(e.code).toBe('map-busy');
    expect(e.detail).toEqual({ mapID: 'Service worker registration failed with x' });
  });

  // 差し込み値を持つ各 code の、各差し込み値に、16 行すべての文面を入れて往復させる
  const MESSAGES = LEGACY.map(([code, params]) => legacyMessage(code, params));
  const NESTED = LEGACY.flatMap(([code, params]) =>
    Object.keys(params ?? {}).flatMap((name) =>
      MESSAGES.map((inner, i) => [code, name, LEGACY[i][0], { ...params, [name]: inner }] as const)));

  it('組み合わせは 0 件でない', () => {
    expect(NESTED.length).toBe(10 * 16);
  });

  it.each(NESTED)('%s の %s に %s の文面を入れても元の code と差し込み値に戻る', (code, name, _inner, params) => {
    const e = WeiwudiError.from(legacyMessage(code, params));
    expect(e.code).toBe(code);
    expect(e.detail?.[name]).toBe(String(params[name]));
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
