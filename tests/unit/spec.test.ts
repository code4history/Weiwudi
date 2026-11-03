// src/spec.ts の試験（m2-t3・第 1 回 S6・C3・C6、第 2 回 D1・D5、第 3 回 M5）。仕様 §5.1・§10・§12、計画の m2-t3。
import { describe, expect, it } from 'vitest';
import { normalizeSpec, type NormalizedSpec } from '../../src/spec';
import { WeiwudiError } from '../../src/errors';
import { lngLatBoundsToTileBox } from '../../src/tile_math';
import { DEFAULT_CREDENTIAL_PARAMS } from '../../src/url_pattern';

const T = 'https://a.example/{z}/{x}/{y}.png';

const errorOf = (spec: unknown): WeiwudiError => {
  try {
    normalizeSpec(spec);
  } catch (e) {
    if (e instanceof WeiwudiError) return e;
    throw new Error(`not WeiwudiError: ${String(e)}`);
  }
  throw new Error('not rejected');
};

const codeOf = (spec: unknown): string => errorOf(spec).code;

/** 拒否の文面・detail に値が出ていない */
const expectNotLeaked = (spec: unknown, secret: string) => {
  const e = errorOf(spec);
  expect(e.message).not.toContain(secret);
  expect(JSON.stringify(e.detail ?? {})).not.toContain(secret);
};

describe('kind', () => {
  it.each(['raster', 'vector'] as const)('%s を受ける', (kind) => {
    expect(normalizeSpec({ kind, url: T }).spec.kind).toBe(kind);
  });

  it.each(['style', 'asset'])('%s は unsupported-kind（R18）', (kind) => {
    expect(codeOf({ kind, url: T })).toBe('unsupported-kind');
  });

  it.each([['未知の文字列', 'raster2'], ['無い', undefined], ['文字列でない', 1], ['legacy', 'legacy']])('%s は attribute-invalid', (_l, kind) => {
    expect(codeOf({ kind, url: T })).toBe('attribute-invalid');
  });

  it('object でない登録内容は attribute-invalid', () => {
    expect(codeOf(null)).toBe('attribute-invalid');
    expect(codeOf('x')).toBe('attribute-invalid');
    expect(codeOf([])).toBe('attribute-invalid');
  });
});

describe('id', () => {
  it('指定が無ければ先頭のテンプレートの normalizeTemplate', () => {
    expect(normalizeSpec({ kind: 'raster', url: ['https://B.example/{z}/{x}/{y}.png?b=1&a=2', T] }).spec.id)
      .toBe('https://b.example/{z}/{x}/{y}.png?a=2&b=1');
  });

  it('既定の id が資格情報を含まない（第 1 回 C3）', () => {
    const n = normalizeSpec({ kind: 'raster', url: `${T}?access_token=pk.secret&v=1` });
    expect(n.spec.id).toBe(`${T}?v=1`);
    expect(n.spec.id).not.toContain('access_token');
    expect(n.spec.id).not.toContain('pk.secret');
  });

  it('明示の id はそのまま', () => {
    expect(normalizeSpec({ kind: 'raster', id: 'my-map', url: T }).spec.id).toBe('my-map');
  });

  it.each([
    ['map: から始まる（第 1 回 S6）', 'map:x'],
    ['空文字（第 3 回 M5）', ''],
    ['\\0 を含む（第 3 回 M5）', 'a\0b'],
    ['文字列でない', 3],
  ])('%s は attribute-invalid', (_l, id) => {
    expect(codeOf({ kind: 'raster', id, url: T })).toBe('attribute-invalid');
  });
});

describe('テンプレート', () => {
  it.each([
    ['weiwudi.example.com', 'https://weiwudi.example.com/{z}/{x}/{y}.png'],
    ['weiwudi.example.com（大文字）', 'https://WEIWUDI.example.com/{z}/{x}/{y}.png'],
    ['字句の誤り', 'https://a.example/{z}/{x}/{bbox}.png'],
    ['値の一部だけが字句', 'https://a.example/t?tile={z}_{x}_{y}'],
    ['相対', '/tiles/{z}/{x}/{y}.png'],
    ['http・https 以外', 'ftp://a.example/{z}/{x}/{y}.png'],
    ['座標が取れない', 'https://a.example/{z}/{x}.png'],
    ['グリフの字句は raster・vector に使えない', 'https://a.example/{z}/{x}/{y}/{fontstack}.png'],
    ['制御文字', 'https://a.example/{z}/{x}/{y}.png\0'],
  ])('%s は unsupported-template', (_l, url) => {
    expect(codeOf({ kind: 'raster', url })).toBe('unsupported-template');
  });

  it('2 つ目のミラーの誤りも拒否する', () => {
    expect(codeOf({ kind: 'vector', url: [T, 'https://weiwudi.example.com/{z}/{x}/{y}.pbf'] })).toBe('unsupported-template');
  });

  it.each([
    ['空の配列', []],
    ['空文字', ''],
    ['文字列でない', [T, 1]],
    ['無い', undefined],
  ])('url が %s なら attribute-invalid', (_l, url) => {
    expect(codeOf({ kind: 'raster', url })).toBe('attribute-invalid');
  });

  it('templates は正規化済み（資格情報なし・重複なし）。url は資格情報を除いた元の形と順', () => {
    const n = normalizeSpec({
      kind: 'raster',
      url: ['https://b.example/{z}/{x}/{y}.png?v=1&access_token=x', 'https://A.example/{z}/{x}/{y}.png', 'https://a.example/{z}/{x}/{y}.png'],
    });
    expect(n.spec.templates).toEqual(['https://b.example/{z}/{x}/{y}.png?v=1', 'https://a.example/{z}/{x}/{y}.png']);
    expect(n.spec.url).toEqual(['https://b.example/{z}/{x}/{y}.png?v=1', 'https://A.example/{z}/{x}/{y}.png', 'https://a.example/{z}/{x}/{y}.png']);
  });

  it('url が文字列なら url も文字列', () => {
    expect(normalizeSpec({ kind: 'raster', url: `${T}?key=k` }).spec.url).toBe(T);
  });
});

describe('userinfo（第 2 回 D1・第 3 回 推奨）', () => {
  it.each([
    ['user:pass@', 'https://user:pass@a.example/{z}/{x}/{y}.png'],
    ['user@ だけ', 'https://user@a.example/{z}/{x}/{y}.png'],
    [':pass@ だけ', 'https://:pass@a.example/{z}/{x}/{y}.png'],
  ])('%s は attribute-invalid', (_l, url) => {
    expect(codeOf({ kind: 'raster', url })).toBe('attribute-invalid');
  });

  it('userinfo つきの URL は id・テンプレート・文面のどこにも残らない（拒否されるので保存されない）', () => {
    const spec = { kind: 'raster', url: [T, 'https://alice:hunter2@b.example/{z}/{x}/{y}.png'] };
    expectNotLeaked(spec, 'hunter2');
    expectNotLeaked(spec, 'alice');
  });
});

describe('sk. の拒否（第 1 回 C6・第 2 回 D5・第 3 回 推奨）', () => {
  it.each([
    ['credentials.query の値の先頭', { credentials: { query: { access_token: 'sk.abc' } } }],
    ['credentials.headers の Bearer sk.', { credentials: { headers: { Authorization: 'Bearer sk.abc' } } }],
    ['credentials.headers の token sk.（小文字）', { credentials: { headers: { Authorization: 'token sk.abc' } } }],
    ['credentials.headers の BASIC と余分な空白', { credentials: { headers: { Authorization: '  BASIC   sk.abc' } } }],
    ['テンプレートの資格情報の項目', { url: `${T}?access_token=sk.abc` }],
    ['credentialParams に無いクエリ項目の値', { url: `${T}?foo=sk.x` }],
    ['percent-encode した値', { url: `${T}?foo=%73k.x` }],
    ['大文字の SK.', { url: `${T}?foo=SK.x` }],
    ['2 つ目のミラー', { url: [T, `https://b.example/{z}/{x}/{y}.png?access_token=sk.abc`] }],
  ])('%s は credential-rejected', (_l, over) => {
    expect(codeOf({ kind: 'raster', url: T, ...over })).toBe('credential-rejected');
  });

  it('拒否の文面に値を出さない', () => {
    expectNotLeaked({ kind: 'raster', url: T, credentials: { query: { access_token: 'sk.topsecret' } } }, 'topsecret');
    expectNotLeaked({ kind: 'raster', url: `${T}?access_token=sk.topsecret` }, 'topsecret');
  });

  it('崩れた % の値でも URIError にならない（第 4 回 O-3）', () => {
    expect(() => normalizeSpec({ kind: 'raster', url: `${T}?foo=%E0%A4%A&bar=%` })).not.toThrow();
  });

  it('sk. が値の途中にあるもの・pk. は通る', () => {
    expect(() => normalizeSpec({
      kind: 'raster', url: `${T}?foo=x.sk.y`, credentials: { query: { access_token: 'pk.abc' }, headers: { 'X-Note': 'ask.me' } },
    })).not.toThrow();
  });
});

describe('資格情報の分離（仕様 §10）', () => {
  it('credentials は spec に入らず、別の項目に分けて持つ', () => {
    const n = normalizeSpec({
      kind: 'raster', url: T, credentials: { query: { access_token: 'pk.q' }, headers: { 'X-Api-Key': 'h1' } },
    });
    expect(n.credentials).toEqual({ query: { access_token: 'pk.q' }, headers: { 'X-Api-Key': 'h1' } });
    expect('credentials' in n.spec).toBe(false);
    expect(JSON.stringify(n.spec)).not.toContain('pk.q');
    expect(JSON.stringify(n.spec)).not.toContain('h1');
  });

  it('テンプレートに載っていた資格情報の項目は credentials.query へ移す（明示の credentials が勝つ）', () => {
    const n = normalizeSpec({
      kind: 'raster',
      url: [`${T}?access_token=pk.fromurl&sku=s1`, 'https://b.example/{z}/{x}/{y}.png?access_token=pk.second'],
      credentials: { query: { sku: 'explicit' } },
    });
    expect(n.credentials).toEqual({ query: { access_token: 'pk.fromurl', sku: 'explicit' } });
    expect(JSON.stringify(n.spec)).not.toContain('pk.fromurl');
    expect(JSON.stringify(n.spec)).not.toContain('pk.second');
  });

  it('資格情報が無ければ credentials は undefined', () => {
    expect(normalizeSpec({ kind: 'raster', url: T }).credentials).toBeUndefined();
  });

  it('登録内容の未知の項目を spec に写さない', () => {
    const n = normalizeSpec({ kind: 'raster', url: T, secret: 'pk.extra', fonts: ['x'] } as unknown);
    expect(JSON.stringify(n.spec)).not.toContain('pk.extra');
  });

  it.each([
    ['credentials が object でない', { credentials: 'x' }],
    ['query の値が文字列でない', { credentials: { query: { a: 1 } } }],
    ['headers が配列', { credentials: { headers: ['x'] } }],
    ['credentialParams が配列でない', { credentialParams: 'sig' }],
    ['credentialParams に空文字', { credentialParams: [''] }],
  ])('%s は attribute-invalid', (_l, over) => {
    expect(codeOf({ kind: 'raster', url: T, ...over })).toBe('attribute-invalid');
  });
});

describe('方針の既定（仕様 §5.2・§6）', () => {
  it('raster: cacheTtl 24 時間・outOfRange は transparent・store false・credentialParams は既定', () => {
    const { spec } = normalizeSpec({ kind: 'raster', url: T });
    expect(spec.policy).toEqual({
      cacheTtl: 86_400_000,
      store: false,
      outOfRange: { extent: 'transparent', zoom: 'transparent' },
      credentialParams: [...DEFAULT_CREDENTIAL_PARAMS],
    });
    expect(spec.scheme).toBe('xyz');
    expect(spec.extent).toBeUndefined();
    expect(spec.cacheMaxBytes).toBeUndefined();
  });

  it('vector: outOfRange は empty', () => {
    expect(normalizeSpec({ kind: 'vector', url: T }).spec.policy.outOfRange).toEqual({ extent: 'empty', zoom: 'empty' });
  });

  it('指定を写す（cacheTtl・cacheRetention・cachePrivate・cacheMaxBytes・outOfRange の片方・scheme・tileSize）', () => {
    const { spec } = normalizeSpec({
      kind: 'vector', url: T, cacheTtl: 1000, cacheRetention: 5000, cachePrivate: true, cacheMaxBytes: 0,
      outOfRange: { zoom: 'not-found' }, scheme: 'tms', tileSize: 512,
    });
    expect(spec.policy).toMatchObject({ cacheTtl: 1000, cacheRetention: 5000, store: true, outOfRange: { extent: 'empty', zoom: 'not-found' } });
    expect(spec.cacheMaxBytes).toBe(0);
    expect(spec.scheme).toBe('tms');
    expect(spec.tileSize).toBe(512);
  });

  it('credentialParams は既定と和にする（重複なし）', () => {
    expect(normalizeSpec({ kind: 'raster', url: T, credentialParams: ['sig', 'key'] }).spec.policy.credentialParams)
      .toEqual([...DEFAULT_CREDENTIAL_PARAMS, 'sig']);
  });

  it('足した credentialParams の項目も id とテンプレートから除く', () => {
    const { spec } = normalizeSpec({ kind: 'raster', url: `${T}?sig=abc&v=1`, credentialParams: ['sig'] });
    expect(spec.id).toBe(`${T}?v=1`);
    expect(spec.templates).toEqual([`${T}?v=1`]);
  });

  it.each([
    ['cacheTtl が負', { cacheTtl: -1 }],
    ['cacheTtl が数でない', { cacheTtl: '1' }],
    ['cacheRetention が NaN', { cacheRetention: NaN }],
    ['cacheMaxBytes が小数', { cacheMaxBytes: 1.5 }],
    ['cachePrivate が真偽でない', { cachePrivate: 'yes' }],
    ['outOfRange の値が未知', { outOfRange: { extent: 'blank' } }],
    ['scheme が未知', { scheme: 'wmts' }],
    ['tileSize が 0', { tileSize: 0 }],
  ])('%s は attribute-invalid', (_l, over) => {
    expect(codeOf({ kind: 'raster', url: T, ...over })).toBe('attribute-invalid');
  });
});

describe('範囲（bounds は tile_math で extent にする）', () => {
  const extentOf = (over: Record<string, unknown>): NormalizedSpec['spec']['extent'] =>
    normalizeSpec({ kind: 'raster', id: 'm', url: T, ...over }).spec.extent;

  it('bounds は maxZoom の tile 範囲（lngLatBoundsToTileBox）', () => {
    const bounds = [139.7, 35.6, 139.8, 35.7];
    expect(extentOf({ bounds, minZoom: 10, maxZoom: 14 })).toEqual({
      minZoom: 10, maxZoom: 14, sourceId: 'm',
      box: lngLatBoundsToTileBox({ minLng: 139.7, minLat: 35.6, maxLng: 139.8, maxLat: 35.7 }, 14),
    });
  });

  it('全世界の bounds は 0〜2^z−1 に収める', () => {
    expect(extentOf({ bounds: [-180, -90, 180, 90], maxZoom: 2 })).toEqual({
      minZoom: 0, maxZoom: 2, sourceId: 'm', box: { minX: 0, maxX: 3, minY: 0, maxY: 3 },
    });
  });

  it('box はそのまま。zoom だけなら box なし。minZoom だけなら maxZoom は 30', () => {
    expect(extentOf({ box: { minX: 1, maxX: 2, minY: 0, maxY: 3 }, maxZoom: 2 }))
      .toEqual({ minZoom: 0, maxZoom: 2, sourceId: 'm', box: { minX: 1, maxX: 2, minY: 0, maxY: 3 } });
    expect(extentOf({ minZoom: 3, maxZoom: 9 })).toEqual({ minZoom: 3, maxZoom: 9, sourceId: 'm' });
    expect(extentOf({ minZoom: 3 })).toEqual({ minZoom: 3, maxZoom: 30, sourceId: 'm' });
  });

  it.each([
    ['bounds に maxZoom が無い', { bounds: [0, 0, 1, 1] }],
    ['box に maxZoom が無い', { box: { minX: 0, maxX: 0, minY: 0, maxY: 0 } }],
    ['bounds と box の両方', { bounds: [0, 0, 1, 1], box: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, maxZoom: 1 }],
    ['bounds が 4 つでない', { bounds: [0, 0, 1], maxZoom: 1 }],
    ['bounds の西が東より大きい', { bounds: [10, 0, 1, 1], maxZoom: 1 }],
    ['bounds の緯度が範囲外', { bounds: [0, -91, 1, 1], maxZoom: 1 }],
    ['box が 2^maxZoom の外', { box: { minX: 0, maxX: 4, minY: 0, maxY: 0 }, maxZoom: 2 }],
    ['box の min が max より大きい', { box: { minX: 2, maxX: 1, minY: 0, maxY: 0 }, maxZoom: 2 }],
    ['minZoom が maxZoom より大きい', { minZoom: 5, maxZoom: 4 }],
    ['maxZoom が 30 より大きい', { maxZoom: 31 }],
    ['minZoom が整数でない', { minZoom: 1.5 }],
  ])('%s は attribute-invalid', (_l, over) => {
    expect(codeOf({ kind: 'raster', url: T, ...over })).toBe('attribute-invalid');
  });
});
