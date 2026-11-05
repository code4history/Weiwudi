// 標準の提供元 mapbox（src/providers/mapbox.ts。m3-t5・#40・仕様 §10）。実ネットワーク・実トークンは使わない。
import { describe, expect, it } from 'vitest';
import { createMapboxProvider, MAPBOX_API } from '../../src/providers/mapbox';
import { appendQueryCredentials } from '../../src/upstream';
import { WeiwudiError } from '../../src/errors';

const mapbox = createMapboxProvider(appendQueryCredentials);

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof WeiwudiError ? e.code : 'thrown';
  }
};

// 計画の表の全行（F2 の 5 形）と、C-O3 で足した形（Studio の sprite の 3 区画・draft のスタイル）
const TABLE: [label: string, input: string, out: string][] = [
  ['スタイル', 'mapbox://styles/u1/s1', 'https://api.mapbox.com/styles/v1/u1/s1'],
  ['スタイル（draft。C-O3）', 'mapbox://styles/u1/s1/draft', 'https://api.mapbox.com/styles/v1/u1/s1/draft'],
  ['スプライト', 'mapbox://sprites/u1/s1', 'https://api.mapbox.com/styles/v1/u1/s1/sprite'],
  ['スプライト（Studio の 3 区画。C-O3）', 'mapbox://sprites/u1/s1/abc123hash', 'https://api.mapbox.com/styles/v1/u1/s1/abc123hash/sprite'],
  ['フォント（字句のまま）', 'mapbox://fonts/u1/{fontstack}/{range}.pbf', 'https://api.mapbox.com/fonts/v1/u1/{fontstack}/{range}.pbf'],
  ['フォント（具体の値）', 'mapbox://fonts/u1/Open%20Sans%20Regular/0-255.pbf', 'https://api.mapbox.com/fonts/v1/u1/Open%20Sans%20Regular/0-255.pbf'],
  ['タイル（字句のまま）', 'mapbox://tiles/mapbox.satellite/{z}/{x}/{y}.png', 'https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.png'],
  ['タイル（@2x）', 'mapbox://tiles/mapbox.satellite/{z}/{x}/{y}@2x.jpg90', 'https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90'],
  ['タイル（具体の値）', 'mapbox://tiles/u1.t1/3/1/2.vector.pbf', 'https://api.mapbox.com/v4/u1.t1/3/1/2.vector.pbf'],
  ['ソース（1 つ。F3）', 'mapbox://mapbox.mapbox-streets-v8', 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8.json?secure'],
  ['ソース（複合。F3）', 'mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2', 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2.json?secure'],
];

describe('resolve（計画の表）', () => {
  it.each(TABLE)('%s', (_l, input, out) => {
    expect(mapbox.matches(input)).toBe(true);
    expect(mapbox.resolve(input)).toBe(out);
  });

  it.each([
    'https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.png',
    'https://api.mapbox.com/styles/v1/u1/s1?fresh=true',
    'https://a.tiles.mapbox.com/v4/u1.t1/{z}/{x}/{y}.vector.pbf',
    'https://B.TILES.MAPBOX.COM/v4/u1.t1/{z}/{x}/{y}.vector.pbf',
  ])('https はそのまま: %s', (url) => {
    expect(mapbox.matches(url)).toBe(true);
    expect(mapbox.resolve(url)).toBe(url);
  });

  it('クエリはそのまま後ろに残す（資格情報の移し替えは登録の検査が行う）', () => {
    expect(mapbox.resolve('mapbox://styles/u1/s1?optimize=true')).toBe('https://api.mapbox.com/styles/v1/u1/s1?optimize=true');
    expect(mapbox.resolve('mapbox://a.b?x=1')).toBe('https://api.mapbox.com/v4/a.b.json?secure&x=1');
    expect(mapbox.resolve('mapbox://a.b?secure')).toBe('https://api.mapbox.com/v4/a.b.json?secure');
  });

  it('大文字のスキームも当たる', () => {
    expect(mapbox.matches('MAPBOX://styles/u1/s1')).toBe(true);
    expect(mapbox.resolve('MAPBOX://styles/u1/s1')).toBe('https://api.mapbox.com/styles/v1/u1/s1');
  });

  it('資格情報を足さない', () => {
    for (const [, input] of TABLE) expect(mapbox.resolve(input)).not.toContain('access_token');
  });

  it('MAPBOX_API は https://api.mapbox.com', () => {
    expect(MAPBOX_API).toBe('https://api.mapbox.com');
  });
});

describe('matches', () => {
  it.each([
    'https://example.com/v4/a.b/{z}/{x}/{y}.png',
    'http://api.mapbox.com/v4/a.b/{z}/{x}/{y}.png',
    'https://api.mapbox.com.evil.example/v4/a',
    'https://tiles.mapbox.com.evil.example/v4/a',
    'https://evil-tiles.mapbox.com.example/v4/a',
    'not a url',
  ])('当たらない: %s', (url) => {
    expect(mapbox.matches(url)).toBe(false);
  });
});

describe('解決できない mapbox:// は unsupported-template', () => {
  it.each([
    'mapbox://',
    'mapbox://styles/u1',
    'mapbox://styles/u1/s1/other',
    'mapbox://styles/u1/s1/draft/x',
    'mapbox://styles//s1',
    'mapbox://sprites/u1',
    'mapbox://sprites/u1/s1/h/x',
    'mapbox://fonts/u1/{fontstack}',
    'mapbox://fonts/u1/{fontstack}/{range}',
    'mapbox://tiles/a.b',
    'mapbox://tiles/a.b/{z}/{x}',
    'mapbox://unknown/a/b',
    'mapbox://nodot',
    'mapbox://a.b,',
    'mapbox://a.b/extra',
  ])('%s', (url) => {
    expect(codeOf(() => mapbox.resolve(url))).toBe('unsupported-template');
  });

  it('文面に URL を入れない', () => {
    expect.assertions(2);
    try {
      mapbox.resolve('mapbox://styles/secretuser');
    } catch (e) {
      expect((e as WeiwudiError).code).toBe('unsupported-template');
      expect((e as Error).message).not.toContain('secretuser');
    }
  });
});

describe('rewriteStyle', () => {
  const style = () => ({
    version: 8,
    name: 'n',
    sources: {
      composite: { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2' },
      sat: { type: 'raster', tiles: ['mapbox://tiles/mapbox.satellite/{z}/{x}/{y}.png', 'https://other.example/{z}/{x}/{y}.png'] },
      plain: { type: 'vector', url: 'https://other.example/tiles.json' },
      geo: { type: 'geojson', data: 'mapbox://not-touched' },
    },
    sprite: 'mapbox://sprites/u1/s1',
    glyphs: 'mapbox://fonts/u1/{fontstack}/{range}.pbf',
    layers: [{ id: 'l', type: 'background', metadata: { link: 'mapbox://styles/u1/s1' } }],
  });

  it('sources[*].url・sources[*].tiles[]・sprite・glyphs の mapbox:// を直し、それ以外は触らない', () => {
    const out = mapbox.rewriteStyle!(style()) as ReturnType<typeof style>;
    expect(out.sources.composite.url).toBe('https://api.mapbox.com/v4/mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2.json?secure');
    expect(out.sources.sat.tiles).toEqual(['https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.png', 'https://other.example/{z}/{x}/{y}.png']);
    expect(out.sources.plain.url).toBe('https://other.example/tiles.json');
    expect(out.sources.geo.data).toBe('mapbox://not-touched');
    expect(out.sprite).toBe('https://api.mapbox.com/styles/v1/u1/s1/sprite');
    expect(out.glyphs).toBe('https://api.mapbox.com/fonts/v1/u1/{fontstack}/{range}.pbf');
    expect(out.layers).toEqual(style().layers);
    expect(out.name).toBe('n');
  });

  it('sprite の {id, url}[] も直す', () => {
    const out = mapbox.rewriteStyle!({
      version: 8, sources: {}, layers: [],
      sprite: [{ id: 'default', url: 'mapbox://sprites/u1/s1' }, { id: 'x', url: 'https://other.example/sprite' }],
    }) as { sprite: { id: string; url: string }[] };
    expect(out.sprite).toEqual([
      { id: 'default', url: 'https://api.mapbox.com/styles/v1/u1/s1/sprite' },
      { id: 'x', url: 'https://other.example/sprite' },
    ]);
  });

  it('入力を書き換えず、新しい object を返す', () => {
    const input = style();
    const before = JSON.stringify(input);
    const sprite = [{ id: 'default', url: 'mapbox://sprites/u1/s1' }];
    const withArray = { ...style(), sprite };
    const out = mapbox.rewriteStyle!(input);
    mapbox.rewriteStyle!(withArray);
    expect(JSON.stringify(input)).toBe(before);
    expect(sprite[0].url).toBe('mapbox://sprites/u1/s1');
    expect(out).not.toBe(input);
    expect((out as ReturnType<typeof style>).sources).not.toBe(input.sources);
  });

  it('解決できない mapbox:// はそのまま残す（投げない）', () => {
    const out = mapbox.rewriteStyle!({ version: 8, sources: {}, layers: [], sprite: 'mapbox://sprites/u1' }) as { sprite: string };
    expect(out.sprite).toBe('mapbox://sprites/u1');
  });

  it('object でない値はそのまま返す', () => {
    expect(mapbox.rewriteStyle!(null)).toBeNull();
    expect(mapbox.rewriteStyle!('x')).toBe('x');
  });
});

describe('資格情報', () => {
  it('credentialParams は access_token', () => {
    expect(mapbox.credentialParams).toEqual(['access_token']);
  });

  it('validateCredentials: access_token が sk. なら credential-rejected', () => {
    expect(codeOf(() => mapbox.validateCredentials!({ query: { access_token: 'sk.secret' } }))).toBe('credential-rejected');
    expect(codeOf(() => mapbox.validateCredentials!({ query: { ACCESS_TOKEN: 'SK.secret' } }))).toBe('credential-rejected');
    expect(codeOf(() => mapbox.validateCredentials!({ query: { access_token: 'pk.public' } }))).toBeUndefined();
    expect(codeOf(() => mapbox.validateCredentials!({}))).toBeUndefined();
  });

  it('applyCredentials: access_token は要求に無いときだけ足す', () => {
    const a = new URL('https://api.mapbox.com/v4/a.b/1/0/0.png');
    mapbox.applyCredentials(a, { query: { access_token: 'pk.reg' } });
    expect(a.href).toBe('https://api.mapbox.com/v4/a.b/1/0/0.png?access_token=pk.reg');
    const b = new URL('https://api.mapbox.com/v4/a.b/1/0/0.png?ACCESS_TOKEN=pk.page');
    mapbox.applyCredentials(b, { query: { access_token: 'pk.reg' } });
    expect(b.href).toBe('https://api.mapbox.com/v4/a.b/1/0/0.png?ACCESS_TOKEN=pk.page');
  });

  it('applyCredentials は引数で受けた足し方の関数を使う（自前で組まない）', () => {
    const calls: [string, Record<string, string>][] = [];
    const p = createMapboxProvider((url, q) => { calls.push([url.href, q]); });
    const u = new URL('https://api.mapbox.com/v4/a.b/1/0/0.png');
    p.applyCredentials(u, { query: { access_token: 'pk.reg' }, headers: { 'x-h': 'v' } });
    expect(calls).toEqual([['https://api.mapbox.com/v4/a.b/1/0/0.png', { access_token: 'pk.reg' }]]);
    expect(u.href).toBe('https://api.mapbox.com/v4/a.b/1/0/0.png');
  });
});

// BeatBox 0.1.1 の toHttpUrl（code4history/BeatBox の src/index.ts。accessToken: 'pk.T' で作ったときの出力）を写した表。
// 依存は足さない（R15）。違うのは、TileJSON に ?secure を付ける点と、トークンを足さない点だけ
describe('BeatBox 0.1.1 の toHttpUrl との突き合わせ', () => {
  const BEATBOX: [input: string, beatbox: string][] = [
    ['mapbox://styles/u1/s1', 'https://api.mapbox.com/styles/v1/u1/s1?access_token=pk.T'],
    ['mapbox://sprites/u1/s1', 'https://api.mapbox.com/styles/v1/u1/s1/sprite?access_token=pk.T'],
    ['mapbox://fonts/u1/Open%20Sans%20Regular/0-255.pbf', 'https://api.mapbox.com/fonts/v1/u1/Open%20Sans%20Regular/0-255.pbf?access_token=pk.T'],
    ['mapbox://tiles/u1.t1/3/1/2.png', 'https://api.mapbox.com/v4/u1.t1/3/1/2.png?access_token=pk.T'],
    ['mapbox://tiles/u1.t1/3/1/2@2x.png', 'https://api.mapbox.com/v4/u1.t1/3/1/2@2x.png?access_token=pk.T'],
    ['mapbox://tiles/u1.t1/{z}/{x}/{y}.png', 'https://api.mapbox.com/v4/u1.t1/{z}/{x}/{y}.png?access_token=pk.T'],
    ['mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2', 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2.json?access_token=pk.T'],
  ];
  const normalize = (beatbox: string): string => {
    const u = beatbox.replace(/[?&]access_token=pk\.T$/, '');
    return u.endsWith('.json') ? `${u}?secure` : u;
  };

  it.each(BEATBOX)('%s', (input, beatbox) => {
    expect(mapbox.resolve(input)).toBe(normalize(beatbox));
  });
});
