// src/spec.ts の試験（m2-t3・第 1 回 S6・C3・C6、第 2 回 D1・D5、第 3 回 M5）。仕様 §5.1・§10・§12、計画の m2-t3。
import { describe, expect, it } from 'vitest';
import { copyRange, normalizeFetchOptions, normalizeMember, normalizeRange, normalizeSpec, type NormalizedSpec } from '../../src/spec';
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

  // m3-t7 で style・asset を受けるようになった（unsupported-kind はどの kind にも出ない。コードは union に残す）
  it('style を受ける: StyleSpec（url 1 つ・fonts・children は空・資格情報は spec に入れない）', () => {
    const n = normalizeSpec({
      kind: 'style', url: 'https://s.example/style.json?access_token=pk.T', fonts: ['Noto Sans'], cacheMaxBytes: 10,
    });
    expect(n.spec).toMatchObject({
      kind: 'style', id: 'https://s.example/style.json', url: 'https://s.example/style.json',
      templates: ['https://s.example/style.json'], fonts: ['Noto Sans'], cacheMaxBytes: 10, children: [],
    });
    expect(n.credentials).toEqual({ query: { access_token: 'pk.T' } });
    expect(JSON.stringify(n.spec)).not.toContain('pk.T');
  });

  it.each([
    ['url が配列', { url: ['https://s.example/a.json'] }],
    ['url が空', { url: '' }],
    ['fonts が配列でない', { url: 'https://s.example/a.json', fonts: 'Noto' }],
    ['fonts に空の文字列', { url: 'https://s.example/a.json', fonts: [''] }],
  ])('style の %s は attribute-invalid', (_l, over) => {
    expect(codeOf({ kind: 'style', ...over })).toBe('attribute-invalid');
  });

  it('style の URL も提供元の resolve を通す（mapbox://styles/…）', async () => {
    const { createMapboxProvider } = await import('../../src/providers/mapbox');
    const { appendQueryCredentials } = await import('../../src/upstream');
    const n = normalizeSpec({ kind: 'style', url: 'mapbox://styles/u/s' }, [createMapboxProvider(appendQueryCredentials)]);
    expect(n.spec).toMatchObject({ url: 'https://api.mapbox.com/styles/v1/u/s', provider: 'mapbox' });
  });

  it('asset を受ける: type は data・URL 配列はミラー（R8）・範囲を持たない', () => {
    const n = normalizeSpec({ kind: 'asset', url: ['https://a.example/x.png', 'https://b.example/x.png'], minZoom: 1, maxZoom: 3 });
    expect(n.spec).toMatchObject({ kind: 'asset', type: 'data', templates: ['https://a.example/x.png', 'https://b.example/x.png'] });
    expect((n.spec as NormalizedSpec['spec']).extent).toBeUndefined();
  });

  it('kind と資源の型の組が合わなければ internal（asset は data・raster・vector は tile だけ。t2 の申し送り）', () => {
    expect(() => normalizeMember('tile', [T], {}, { kind: 'asset' })).toThrow(/cannot hold/);
    expect(() => normalizeMember('data', ['https://d.example/a.json'], {}, { kind: 'raster' })).toThrow(/cannot hold/);
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
      url: [`${T}?access_token=pk.fromurl&sku=s1`, 'https://b.example/{z}/{x}/{y}.png?access_token=pk.fromurl&sku=pk.second'],
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

describe('m2-t3 水準 1 の指摘', () => {
  it.each([
    ['# の後ろに ?key=', `${T}#frag?key=SECRET`],
    ['# の後ろに access_token=sk.', `${T}#access_token=sk.SECRET`],
    ['# だけ', `${T}#`],
  ])('M1: # を含むテンプレート（%s）は unsupported-template で、文面に値を出さない', (_l, url) => {
    expect(codeOf({ kind: 'raster', url })).toBe('unsupported-template');
    expectNotLeaked({ kind: 'raster', url }, 'SECRET');
  });

  it('M2: テンプレートの ?KEY= と明示の key は小文字で 1 つにし、明示が勝つ', () => {
    const n = normalizeSpec({ kind: 'raster', url: `${T}?KEY=FROMURL`, credentials: { query: { key: 'EXPL' } } });
    expect(n.credentials).toEqual({ query: { key: 'EXPL' } });
  });

  it('M2: 明示の側が大文字（KEY）でテンプレートが小文字（?key=）でも 1 つにし、明示の綴りと値が勝つ', () => {
    const n = normalizeSpec({ kind: 'raster', url: `${T}?key=FROMURL`, credentials: { query: { KEY: 'EXPL' } } });
    expect(n.credentials).toEqual({ query: { KEY: 'EXPL' } });
  });

  it('M2: テンプレートの ?key=A&KEY=B は先の 1 つだけ', () => {
    const n = normalizeSpec({ kind: 'raster', url: `${T}?key=A&KEY=B` });
    expect(n.credentials).toEqual({ query: { key: 'A' } });
  });

  it('M2: 明示の credentials.query に小文字で同じ名前が 2 つあれば attribute-invalid', () => {
    expect(codeOf({ kind: 'raster', url: T, credentials: { query: { key: 'a', KEY: 'b' } } })).toBe('attribute-invalid');
  });

  it('M3: ?ACCESS_TOKEN=x は credentials.query へ移り、spec に残らない', () => {
    const n = normalizeSpec({ kind: 'raster', url: `${T}?ACCESS_TOKEN=pk.upper&v=1` });
    expect(n.credentials).toEqual({ query: { ACCESS_TOKEN: 'pk.upper' } });
    expect(JSON.stringify(n.spec)).not.toContain('pk.upper');
  });

  it.each([
    ['値の無い項目', `${T}?sk.SECRET`],
    ['名前が sk.', `${T}?sk.SECRET=1`],
    ['percent-encode した名前', `${T}?%73k.SECRET`],
  ])('I1: クエリ項目の名前の sk.（%s）も credential-rejected', (_l, url) => {
    expect(codeOf({ kind: 'raster', url })).toBe('credential-rejected');
    expectNotLeaked({ kind: 'raster', url }, 'SECRET');
  });
});

describe('normalizeMember: 型ごとの字句の許可（m3-t2）', () => {
  const member = (type: Parameters<typeof normalizeMember>[0], url: string) =>
    normalizeMember(type, [url], {}, { kind: 'child', internalId: 'p\u0000x', single: true });
  const memberCode = (type: Parameters<typeof normalizeMember>[0], url: string): string => {
    try {
      member(type, url);
    } catch (e) {
      if (e instanceof WeiwudiError) return e.code;
      throw e;
    }
    return 'accepted';
  };

  it.each([
    ['tile', T, 'accepted'],
    ['tile', 'https://a.example/{fontstack}/{z}/{x}/{y}.png', 'unsupported-template'],
    ['glyph', 'https://g.example/{fontstack}/{range}.pbf', 'accepted'],
    ['glyph', 'https://g.example/{fontstack}/{z}.pbf', 'unsupported-template'],
    ['glyph', 'https://g.example/{fontstack}/0-255.pbf', 'unsupported-template'],
    ['glyph', 'https://g.example/{z}/{x}/{y}.pbf', 'unsupported-template'],
    ['glyph', 'https://g.example/{fontstack}/{range}/{z}.pbf', 'unsupported-template'],
    ['sprite', 'https://s.example/sprite', 'accepted'],
    ['sprite', 'https://s.example/sprite{ratio}', 'unsupported-template'],
    ['style', 'https://s.example/style.json', 'accepted'],
    ['style', 'https://s.example/{z}/style.json', 'unsupported-template'],
    ['tilejson', 'https://s.example/tiles.json', 'accepted'],
    ['tilejson', 'https://s.example/tiles.json?v={range}', 'unsupported-template'],
    ['data', 'https://d.example/points.json', 'accepted'],
    ['data', 'https://d.example/{x}.json', 'unsupported-template'],
  ] as const)('%s: %s → %s', (type, url, want) => {
    expect(memberCode(type, url)).toBe(want);
  });

  it('テンプレートの検査は checkTemplate と共有する（data でも sk.・疑似ホスト・userinfo・# を拒否する）', () => {
    expect(memberCode('data', 'https://d.example/a.json?access_token=sk.x')).toBe('credential-rejected');
    expect(memberCode('data', 'https://weiwudi.example.com/a.json')).toBe('unsupported-template');
    expect(memberCode('data', 'https://u:p@d.example/a.json')).toBe('attribute-invalid');
    expect(memberCode('data', 'https://d.example/a.json#f')).toBe('unsupported-template');
  });

  it('内部の id は検査しない（\\0 を含む子の id）。type・logicalName を持ち、tile でなければ範囲と scheme を持たない', () => {
    const n = normalizeMember('glyph', ['https://g.example/{fontstack}/{range}.pbf'], { minZoom: 1, maxZoom: 3, scheme: 'tms' },
      { kind: 'child', internalId: 'p\u0000glyph:glyphs', single: true, logicalName: 'glyphs' });
    expect(n.spec).toMatchObject({ kind: 'child', type: 'glyph', id: 'p\u0000glyph:glyphs', logicalName: 'glyphs' });
    expect(n.spec.extent).toBeUndefined();
    expect(n.spec.scheme).toBeUndefined();
    expect(n.spec.encoding).toBeUndefined();
  });

  it('normalizeSpec の raster・vector は type: tile のまま（style・asset は m3-t7 で受ける）', () => {
    expect(normalizeSpec({ kind: 'raster', url: T }).spec).toMatchObject({ kind: 'raster', type: 'tile', scheme: 'xyz' });
    expect((normalizeSpec({ kind: 'raster', url: T }).spec as NormalizedSpec['spec']).encoding).toBeUndefined();
    expect(normalizeSpec({ kind: 'style', url: 'https://s.example/style.json' }).spec.kind).toBe('style');
    expect(normalizeSpec({ kind: 'asset', url: 'https://d.example/a.json' }).spec).toMatchObject({ kind: 'asset', type: 'data' });
  });
});

describe('normalizeRange・copyRange・normalizeFetchOptions（m4-t3・§7.2・R28・R30・R-tms）', () => {
  const rangeError = (fn: () => unknown): WeiwudiError => {
    try {
      fn();
    } catch (e) {
      if (e instanceof WeiwudiError) return e;
      throw e;
    }
    throw new Error('not rejected');
  };
  const XYZ = { scheme: 'xyz' as const };

  it('bounds は maxZoom の XYZ の box。緯度は ±85.0511 に丸める（R28）', () => {
    const n = normalizeRange({ bounds: [139.7, 35.6, 139.8, 35.7], minZoom: 10, maxZoom: 14 }, XYZ);
    expect(n).toEqual({
      kind: 'boxes', minZoom: 10, maxZoom: 14,
      boxes: [lngLatBoundsToTileBox({ minLng: 139.7, maxLng: 139.8, minLat: 35.6, maxLat: 35.7 }, 14)],
    });
    const pole = normalizeRange({ bounds: [-180, -90, 180, 90], minZoom: 0, maxZoom: 2 }, XYZ);
    expect(pole.boxes).toEqual([{ minX: 0, maxX: 3, minY: 0, maxY: 3 }]);
  });

  it('west > east は日付変更線をまたぐ 2 つの box', () => {
    const n = normalizeRange({ bounds: [170, -10, -170, 10], minZoom: 0, maxZoom: 3 }, XYZ);
    expect(n.boxes).toHaveLength(2);
    expect(n.boxes[0].maxX).toBe(7);
    expect(n.boxes[1].minX).toBe(0);
    expect(n.boxes[0].minX).toBeGreaterThan(n.boxes[1].maxX);
  });

  it('{ box } は Source の scheme の座標として読み、tms なら XYZ に直す（第 1 回 M9）', () => {
    const box = { minX: 1, maxX: 2, minY: 0, maxY: 1 };
    expect(normalizeRange({ box, minZoom: 0, maxZoom: 2 }, XYZ).boxes).toEqual([box]);
    expect(normalizeRange({ box, minZoom: 0, maxZoom: 2 }, { scheme: 'tms' }).boxes).toEqual([{ minX: 1, maxX: 2, minY: 2, maxY: 3 }]);
  });

  it("'all' は取得のときの Source の範囲（tms は XYZ へ）。範囲（box）が無ければ cannot-fetch-all（R30）", () => {
    const extent = { minZoom: 1, maxZoom: 3, box: { minX: 0, maxX: 2, minY: 0, maxY: 1 }, sourceId: 's' };
    expect(normalizeRange('all', { extent, scheme: 'xyz' })).toEqual({ kind: 'boxes', minZoom: 1, maxZoom: 3, boxes: [extent.box] });
    expect(normalizeRange('all', { extent, scheme: 'tms' }).boxes).toEqual([{ minX: 0, maxX: 2, minY: 6, maxY: 7 }]);
    expect(rangeError(() => normalizeRange('all', XYZ)).code).toBe('cannot-fetch-all');
    expect(rangeError(() => normalizeRange('all', { extent: { minZoom: 0, maxZoom: 3, sourceId: 's' } })).code).toBe('cannot-fetch-all');
  });

  it("'all' に複数の範囲（スタイルの子）を渡すと、最大の maxZoom で和にする（R-t3-2）", () => {
    const a = { extent: { minZoom: 0, maxZoom: 1, box: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, sourceId: 'a' } };
    const b = { extent: { minZoom: 2, maxZoom: 2, box: { minX: 3, maxX: 3, minY: 3, maxY: 3 }, sourceId: 'b' }, scheme: 'tms' as const };
    expect(normalizeRange('all', { all: [a, b] })).toEqual({
      kind: 'boxes', minZoom: 0, maxZoom: 2,
      boxes: [{ minX: 0, maxX: 1, minY: 0, maxY: 1 }, { minX: 3, maxX: 3, minY: 0, maxY: 0 }],
    });
    expect(rangeError(() => normalizeRange('all', { all: [] })).code).toBe('cannot-fetch-all');
    expect(rangeError(() => normalizeRange('all', { all: [a, { extent: undefined }] })).code).toBe('cannot-fetch-all');
  });

  it('ズームは 0〜30 の整数で minZoom <= maxZoom。不正な形は attribute-invalid', () => {
    const bad: unknown[] = [
      undefined, null, 'some', 3, [],
      { bounds: [0, 0, 1, 1], minZoom: 3, maxZoom: 2 },
      { bounds: [0, 0, 1, 1], minZoom: -1, maxZoom: 2 },
      { bounds: [0, 0, 1, 1], minZoom: 0, maxZoom: 31 },
      { bounds: [0, 0, 1, 1], minZoom: 0.5, maxZoom: 2 },
      { bounds: [0, 0, 1, 1], maxZoom: 2 },
      { bounds: [0, 0, 1], minZoom: 0, maxZoom: 2 },
      { bounds: [0, 0, 1, Number.NaN], minZoom: 0, maxZoom: 2 },
      { bounds: [0, 1, 1, 0], minZoom: 0, maxZoom: 2 },
      { bounds: [-181, 0, 1, 1], minZoom: 0, maxZoom: 2 },
      { box: { minX: 0, maxX: 4, minY: 0, maxY: 0 }, minZoom: 0, maxZoom: 2 },
      { box: { minX: 1, maxX: 0, minY: 0, maxY: 0 }, minZoom: 0, maxZoom: 2 },
      { box: { minX: 0, maxX: 0, minY: 0 }, minZoom: 0, maxZoom: 2 },
      { bounds: [0, 0, 1, 1], box: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, minZoom: 0, maxZoom: 2 },
    ];
    for (const r of bad) expect(rangeError(() => normalizeRange(r, XYZ)).code).toBe('attribute-invalid');
  });

  it('copyRange は決めた項目だけを写す（余分な項目・関数を写さない。第 1 回 L）', () => {
    const input = { bounds: [1, 2, 3, 4], minZoom: 1, maxZoom: 2, extra: 'x', fn: () => 1 };
    expect(copyRange(input)).toEqual({ bounds: [1, 2, 3, 4], minZoom: 1, maxZoom: 2 });
    const boxIn = { box: { minX: 0, maxX: 1, minY: 0, maxY: 1, z: 9 }, minZoom: 0, maxZoom: 1, y: 3 };
    expect(copyRange(boxIn)).toEqual({ box: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, minZoom: 0, maxZoom: 1 });
    expect(copyRange('all')).toBe('all');
  });

  it('normalizeFetchOptions: 既定は pin true・concurrency 5・ratio ""・glyphRanges common。範囲外は attribute-invalid', () => {
    expect(normalizeFetchOptions(undefined)).toEqual({ pin: true, concurrency: 5, ratio: '', glyphRanges: 'common', fonts: [] });
    expect(normalizeFetchOptions({ pin: false, concurrency: 20, ratio: '@2x', glyphRanges: ['0-255'], fonts: ['A,B'], other: 1 }))
      .toEqual({ pin: false, concurrency: 20, ratio: '@2x', glyphRanges: ['0-255'], fonts: ['A,B'] });
    for (const o of [
      { pin: 1 }, { concurrency: 0 }, { concurrency: 21 }, { concurrency: 1.5 }, { ratio: '@3x' },
      { glyphRanges: 'some' }, { glyphRanges: ['0_255'] }, { fonts: 'A' }, { fonts: [1] }, 'x',
    ]) {
      expect(rangeError(() => normalizeFetchOptions(o)).code).toBe('attribute-invalid');
    }
  });
});

describe('m4-t8 L8（R36）: 宣言の無い資格情報らしい値は warnings に credential-undeclared', () => {
  const U = 'https://a.example/{z}/{x}/{y}.png';

  it('?mytoken=pk.abc は credential-undeclared: mytoken を warnings に足し、値は書かない。登録は成功', () => {
    const n = normalizeSpec({ kind: 'raster', url: `${U}?mytoken=pk.abc` }) as NormalizedSpec & { warnings?: string[] };
    expect(n.warnings).toEqual(['credential-undeclared: mytoken']);
    expect(JSON.stringify(n.warnings)).not.toContain('pk.abc');
  });

  it('tk. も当たる。percent-encode した値も decode して見る。同じ名前は 1 回', () => {
    const n = normalizeSpec({ kind: 'raster', url: [`${U}?a=tk.x&b=%70k.y`, `https://b.example/{z}/{x}/{y}.png?a=tk.x`] }) as NormalizedSpec & { warnings?: string[] };
    expect(n.warnings).toEqual(['credential-undeclared: a', 'credential-undeclared: b']);
  });

  it('credentialParams: [\'mytoken\'] なら出ない。既定の access_token も出ない。当たらない値も出ない', () => {
    const declared = normalizeSpec({ kind: 'raster', url: `${U}?mytoken=pk.abc`, credentialParams: ['mytoken'] }) as NormalizedSpec & { warnings?: string[] };
    expect(declared.warnings).toBeUndefined();
    const def = normalizeSpec({ kind: 'raster', url: `${U}?access_token=pk.abc` }) as NormalizedSpec & { warnings?: string[] };
    expect(def.warnings).toBeUndefined();
    const plain = normalizeSpec({ kind: 'raster', url: `${U}?v=disk.1` }) as NormalizedSpec & { warnings?: string[] };
    expect(plain.warnings).toBeUndefined();
  });

  it('sk. は credential-rejected のまま（拒否が先）', () => {
    expect(codeOf({ kind: 'raster', url: `${U}?mytoken=sk.abc` })).toBe('credential-rejected');
  });

  it('isSecretToken の判定は url_pattern.isSecretValue（Bearer sk. の資格情報は今のとおり拒否）', () => {
    expect(codeOf({ kind: 'raster', url: U, credentials: { headers: { authorization: 'Bearer sk.eyJabc' } } })).toBe('credential-rejected');
    expect(codeOf({ kind: 'raster', url: U, credentials: { query: { q: 'Token  sk.x' } } })).toBe('credential-rejected');
  });
});

describe('m4-t8 PR #106 L1: 名前そのものがトークンの形なら warnings に書かない', () => {
  it('?pk.SECRETNAME=pk.x は名前を warnings に出さない', () => {
    const n = normalizeSpec({ kind: 'raster', url: 'https://a.example/{z}/{x}/{y}.png?pk.SECRETNAME=pk.x&tk.N=1' }) as NormalizedSpec & { warnings?: string[] };
    expect(JSON.stringify(n.warnings ?? [])).not.toContain('SECRETNAME');
    expect(n.warnings).toBeUndefined();
  });
});
