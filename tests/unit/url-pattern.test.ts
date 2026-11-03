// src/url_pattern.ts の試験（m2-t3・第 1 回 S5・C3・O-18）。仕様 §4.2・§5.1・§5.3、計画の m2-t3。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CREDENTIAL_PARAMS, MatchTable, absolutizeTemplate, compileTemplate, entryKey, matchUrl,
  normalizeTemplate, stripParams, templatesOverlap,
} from '../../src/url_pattern';
import { expandTileTemplate, tileKeySuffix } from '../../src/tile_math';
import { WeiwudiError } from '../../src/errors';

afterEach(() => {
  vi.restoreAllMocks();
});

const CP = DEFAULT_CREDENTIAL_PARAMS;

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof WeiwudiError ? e.code : `not WeiwudiError: ${String(e)}`;
  }
  return undefined;
};

describe('DEFAULT_CREDENTIAL_PARAMS', () => {
  it('仕様 §5.3 の 6 つ', () => {
    expect([...CP]).toEqual(['access_token', 'token', 'key', 'api_key', 'apikey', 'sku']);
  });
});

describe('照合と展開の往復（7 字句）', () => {
  const COORDS: [number, number, number][] = [[0, 0, 0], [1, 1, 0], [3, 3, 5], [10, 909, 403], [18, 232831, 103222]];
  it.each([
    ['{z}・{x}・{y}', 'https://a.example/tiles/{z}/{x}/{y}.png'],
    ['{-y}', 'https://a.example/tms/{z}/{x}/{-y}.png'],
    ['{quadkey}（z・x・y へ戻す）', 'https://t.example/tiles/a{quadkey}.jpeg?g=1'],
    ['{prefix}', 'https://p.example/{prefix}/{z}/{x}/{y}.png'],
    ['{ratio}', 'https://r.example/{z}/{x}/{y}{ratio}.png'],
    ['字句の重複', 'https://d.example/{z}/{x}/{y}.png?zz={z}'],
    ['WMTS KVP', 'https://w.example/wmts?TileMatrix={z}&TileCol={x}&TileRow={y}&layer=a'],
  ])('%s', (_label, template) => {
    const c = compileTemplate(template);
    for (const ratio of ['', '@2x']) {
      for (const [z, x, y] of COORDS) {
        const url = new URL(expandTileTemplate(template, z, x, y, { all: true, ratio }));
        const m = matchUrl(c, url);
        expect(m, url.href).not.toBeNull();
        expect([m!.z, m!.x, m!.y]).toEqual([z, x, y]);
        if (template.includes('{ratio}')) expect(m!.ratio ?? '').toBe(ratio);
      }
    }
  });

  it('グリフの 2 字句（{fontstack}・{range}）は照合だけ', () => {
    const c = compileTemplate('https://g.example/fonts/{fontstack}/{range}.pbf');
    const m = matchUrl(c, new URL('https://g.example/fonts/Open%20Sans%20Regular,Arial/256-511.pbf'));
    expect(m).not.toBeNull();
    expect(m!.fontstack).toBe('Open Sans Regular,Arial');
    expect(m!.range).toBe('256-511');
    expect(m!.z).toBeUndefined();
  });

  it('{prefix} が座標と合わなければ不一致', () => {
    const c = compileTemplate('https://p.example/{prefix}/{z}/{x}/{y}.png');
    expect(matchUrl(c, new URL('https://p.example/12/10/1/2.png'))).not.toBeNull();
    expect(matchUrl(c, new URL('https://p.example/00/10/1/2.png'))).toBeNull();
  });

  it('同じ座標を 2 か所から取るとき、食い違えば不一致', () => {
    const c = compileTemplate('https://d.example/{z}/{x}/{y}.png?zz={z}');
    expect(matchUrl(c, new URL('https://d.example/3/1/2.png?zz=3'))).not.toBeNull();
    expect(matchUrl(c, new URL('https://d.example/3/1/2.png?zz=4'))).toBeNull();
  });

  it('座標が 2^z の外なら不一致', () => {
    const c = compileTemplate('https://a.example/{z}/{x}/{y}.png');
    expect(matchUrl(c, new URL('https://a.example/1/1/1.png'))).not.toBeNull();
    expect(matchUrl(c, new URL('https://a.example/1/2/1.png'))).toBeNull();
    expect(matchUrl(c, new URL('https://a.example/1/1/2.png'))).toBeNull();
    expect(matchUrl(c, new URL('https://a.example/31/0/0.png'))).toBeNull();
  });

  it('オリジン・パス・拡張子が違えば不一致', () => {
    const c = compileTemplate('https://a.example/tiles/{z}/{x}/{y}.png');
    expect(matchUrl(c, new URL('https://b.example/tiles/1/0/0.png'))).toBeNull();
    expect(matchUrl(c, new URL('http://a.example/tiles/1/0/0.png'))).toBeNull();
    expect(matchUrl(c, new URL('https://a.example/tiles/1/0/0.jpg'))).toBeNull();
    expect(matchUrl(c, new URL('https://a.example/tiles/1/0/0.png/x'))).toBeNull();
    expect(matchUrl(c, new URL('https://a.example/x/tiles/1/0/0.png'))).toBeNull();
  });

  it('パスの字句以外の正規表現の記号は文字どおりに扱う', () => {
    const c = compileTemplate('https://a.example/t.(1)/{z}/{x}/{y}.png');
    expect(matchUrl(c, new URL('https://a.example/t.(1)/1/0/0.png'))).not.toBeNull();
    expect(matchUrl(c, new URL('https://a.example/tX(1)/1/0/0.png'))).toBeNull();
  });
});

describe('クエリの照合（仕様 §4.2）', () => {
  const WMTS = 'https://w.example/wmts?TileMatrix={z}&TileCol={x}&TileRow={y}&layer=a';

  it('固定値の項目は一致を求める（layer=a と layer=b を分ける）', () => {
    const c = compileTemplate(WMTS);
    expect(matchUrl(c, new URL('https://w.example/wmts?layer=a&TileRow=1&TileCol=0&TileMatrix=1'))).not.toBeNull();
    expect(matchUrl(c, new URL('https://w.example/wmts?TileMatrix=1&TileCol=0&TileRow=1&layer=b'))).toBeNull();
    expect(matchUrl(c, new URL('https://w.example/wmts?TileMatrix=1&TileCol=0&TileRow=1'))).toBeNull();
  });

  it('座標の項目が無い・数でないなら不一致', () => {
    const c = compileTemplate(WMTS);
    expect(matchUrl(c, new URL('https://w.example/wmts?TileMatrix=1&TileCol=0&layer=a'))).toBeNull();
    expect(matchUrl(c, new URL('https://w.example/wmts?TileMatrix=1&TileCol=0&TileRow=x&layer=a'))).toBeNull();
  });

  it('テンプレートに無いクエリ項目は照合に使わない', () => {
    const c = compileTemplate('https://a.example/{z}/{x}/{y}.png');
    expect(matchUrl(c, new URL('https://a.example/1/0/0.png?access_token=x&v=3'))).not.toBeNull();
  });

  it('照合に使った項目の名前を返す', () => {
    const m = matchUrl(compileTemplate(WMTS), new URL('https://w.example/wmts?TileMatrix=1&TileCol=0&TileRow=1&layer=a&v=2'));
    expect([...m!.queryParams].sort()).toEqual(['TileCol', 'TileMatrix', 'TileRow', 'layer']);
  });
});

describe('compileTemplate の拒否（unsupported-template）', () => {
  it.each([
    ['値の一部だけが字句', 'https://a.example/t?tile={z}-{x}-{y}'],
    ['値の一部だけが字句（前置き）', 'https://a.example/t/{z}/{x}/{y}?v=x{z}'],
    ['{bbox-epsg-3857}', 'https://a.example/wms?bbox={bbox-epsg-3857}'],
    ['未知の字句 {s}', 'https://{s}.a.example/{z}/{x}/{y}.png'],
    ['ホストに字句', 'https://{z}.a.example/{x}/{y}.png'],
    ['項目の名前に字句', 'https://a.example/t?{z}=1'],
    ['相対 URL', '/tiles/{z}/{x}/{y}.png'],
    ['http・https 以外', 'ftp://a.example/{z}/{x}/{y}.png'],
    ['{-y} に z が無い', 'https://a.example/{x}/{-y}.png'],
    ['{prefix} に x・y が無い', 'https://a.example/{prefix}/{z}.png'],
  ])('%s', (_label, t) => {
    expect(codeOf(() => compileTemplate(t))).toBe('unsupported-template');
  });

  it('拒否の文面にテンプレートの URL を入れない', () => {
    try {
      compileTemplate('https://a.example/t?tile={z}-{x}&access_token=secret');
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('secret');
      expect(JSON.stringify((e as WeiwudiError).detail ?? {})).not.toContain('secret');
    }
  });
});

describe('absolutizeTemplate（仕様 §4.2）', () => {
  it.each([
    ['相対', 'tiles/{z}/{x}/{y}.png', 'https://p.example/app/index.html', 'https://p.example/app/tiles/{z}/{x}/{y}.png'],
    ['../', '../tiles/{z}/{x}/{-y}.png', 'https://p.example/app/sub/', 'https://p.example/app/tiles/{z}/{x}/{-y}.png'],
    ['クエリつき', '/wmts?TileMatrix={z}&TileCol={x}&TileRow={y}', 'https://p.example/a/', 'https://p.example/wmts?TileMatrix={z}&TileCol={x}&TileRow={y}'],
    ['絶対（ホストの小文字は URL の解決による）', 'https://Q.example/{quadkey}{ratio}.png', 'https://p.example/', 'https://q.example/{quadkey}{ratio}.png'],
    ['未知の字句も符号化しない', 'x/{s}/{z}', 'https://p.example/', 'https://p.example/x/{s}/{z}'],
  ])('%s', (_label, t, base, expected) => {
    const abs = absolutizeTemplate(t, base);
    expect(abs).toBe(expected);
    expect(abs).not.toMatch(/%7B/i);
    expect(abs).not.toMatch(/%7D/i);
  });
});

describe('normalizeTemplate（仕様 §5.1。id の唯一の作り方）', () => {
  it('資格情報の項目を除き、残りを名前順にする', () => {
    expect(normalizeTemplate('https://a.example/{z}/{x}/{y}.png?access_token=x&b=1&a=2', CP))
      .toBe('https://a.example/{z}/{x}/{y}.png?a=2&b=1');
  });

  it('スキームとホストを小文字にし、パスの大文字は変えない', () => {
    expect(normalizeTemplate('HTTPS://A.Example.COM/Tiles/{z}/{x}/{y}.PNG', CP)).toBe('https://a.example.com/Tiles/{z}/{x}/{y}.PNG');
  });

  it('資格情報の項目だけなら ? も残さない', () => {
    expect(normalizeTemplate('https://a.example/{z}/{x}/{y}.png?access_token=x&sku=1', CP)).toBe('https://a.example/{z}/{x}/{y}.png');
  });

  it('資格情報の名前は大文字小文字を問わず除く', () => {
    expect(normalizeTemplate('https://a.example/t?Access_Token=x&KEY=y&z=1', CP)).toBe('https://a.example/t?z=1');
  });

  it('credentialParams で足した名前も除く', () => {
    expect(normalizeTemplate('https://a.example/t?sig=s&a=1', [...CP, 'sig'])).toBe('https://a.example/t?a=1');
  });

  it('字句・パスの符号化はそのまま（4 つの規則のほかは変えない）', () => {
    expect(normalizeTemplate('https://a.example/a%20b/{z}/{x}/{y}.png?l=a%2Cb', CP)).toBe('https://a.example/a%20b/{z}/{x}/{y}.png?l=a%2Cb');
  });

  it('同じクエリ名の値の並びは保つ', () => {
    expect(normalizeTemplate('https://a.example/t?b=2&a=1&b=1', CP)).toBe('https://a.example/t?a=1&b=2&b=1');
  });

  it('絶対でないテンプレートは unsupported-template', () => {
    expect(codeOf(() => normalizeTemplate('tiles/{z}/{x}/{y}.png', CP))).toBe('unsupported-template');
  });
});

describe('templatesOverlap', () => {
  const A = 'https://a.example/{z}/{x}/{y}.png';
  const B = 'https://b.example/{z}/{x}/{y}.png';
  const C = 'https://c.example/{z}/{x}/{y}.png';

  it('ミラーの順を入れ替えても真', () => {
    expect(templatesOverlap([A, B], [B, A], CP)).toBe(true);
    expect(templatesOverlap([A, B], [C, B], CP)).toBe(true);
  });

  it('正規化した形で比べる（資格情報・クエリの順・ホストの大文字）', () => {
    expect(templatesOverlap([`${A}?access_token=1&b=1&a=2`], ['https://A.EXAMPLE/{z}/{x}/{y}.png?a=2&b=1'], CP)).toBe(true);
  });

  it('1 つも重ならなければ偽', () => {
    expect(templatesOverlap([A, B], [C], CP)).toBe(false);
    expect(templatesOverlap([A], ['https://a.example/{z}/{x}/{y}.jpg'], CP)).toBe(false);
  });
});

describe('stripParams', () => {
  it('指定の名前（大文字小文字を問わない）を除き、残りの順を保つ。元の URL は変えない', () => {
    const u = new URL('https://a.example/t?b=1&access_token=x&a=2&TOKEN=y');
    const s = stripParams(u, CP);
    expect(s.href).toBe('https://a.example/t?b=1&a=2');
    expect(u.href).toBe('https://a.example/t?b=1&access_token=x&a=2&TOKEN=y');
  });

  it('何も除かなければ search をそのまま保つ', () => {
    const u = new URL('https://a.example/t?q=a%20b');
    expect(stripParams(u, CP).href).toBe('https://a.example/t?q=a%20b');
  });

  it('全部除けば ? も残さない', () => {
    expect(stripParams(new URL('https://a.example/t?key=1'), CP).href).toBe('https://a.example/t');
  });
});

describe('entryKey（仕様 §5.3・R2）', () => {
  const T = 'https://a.example/{z}/{x}/{y}{ratio}.png';

  it('tile の suffix は tileKeySuffix と同じ。資格情報を除いた残りのクエリを名前順に ? で続ける', () => {
    const url = new URL('https://a.example/3/1/2.png?b=1&access_token=x&a=2');
    const m = matchUrl(compileTemplate(T), url)!;
    expect(entryKey('R', 'tile', m, url, CP)).toBe(`R\0${tileKeySuffix(3, 1, 2)}?a=2&b=1`);
    expect(entryKey('R', 'tile', m, url, CP)).toBe('R\x003_1_2?a=2&b=1');
  });

  it('クエリが残らなければ suffix は tileKeySuffix だけ。@2x も tileKeySuffix と同じ', () => {
    const url = new URL('https://a.example/3/1/2@2x.png?access_token=x&sku=abc');
    const m = matchUrl(compileTemplate(T), url)!;
    expect(entryKey('R', 'tile', m, url, CP)).toBe(`R\0${tileKeySuffix(3, 1, 2, '@2x')}`);
  });

  it('照合に使ったクエリ項目はキーに入れない（WMTS KVP）', () => {
    const t = 'https://w.example/wmts?TileMatrix={z}&TileCol={x}&TileRow={y}&layer=a';
    const url = new URL('https://w.example/wmts?TileMatrix=1&TileCol=0&TileRow=1&layer=a&v=2&apikey=k');
    const m = matchUrl(compileTemplate(t), url)!;
    expect(entryKey('W', 'tile', m, url, CP)).toBe('W\x001_0_1?v=2');
  });

  it('ミラーのどれで取っても同じキー', () => {
    const c1 = compileTemplate('https://a.example/{z}/{x}/{y}.png');
    const c2 = compileTemplate('https://b.example/t/{z}/{x}/{y}.png');
    const u1 = new URL('https://a.example/3/1/2.png');
    const u2 = new URL('https://b.example/t/3/1/2.png');
    expect(entryKey('R', 'tile', matchUrl(c1, u1)!, u1, CP)).toBe(entryKey('R', 'tile', matchUrl(c2, u2)!, u2, CP));
  });

  it('glyph の suffix は fontstack', () => {
    const url = new URL('https://g.example/fonts/Open%20Sans/0-255.pbf?access_token=x');
    const m = matchUrl(compileTemplate('https://g.example/fonts/{fontstack}/{range}.pbf'), url)!;
    expect(entryKey('G', 'glyph', m, url, CP)).toBe('G\0Open Sans');
  });

  it('style などは残りのクエリだけ（無ければ空）', () => {
    const c = compileTemplate('https://s.example/style.json');
    const u1 = new URL('https://s.example/style.json?access_token=x');
    const u2 = new URL('https://s.example/style.json?v=2&access_token=x');
    expect(entryKey('S', 'style', matchUrl(c, u1)!, u1, CP)).toBe('S\0');
    expect(entryKey('S', 'style', matchUrl(c, u2)!, u2, CP)).toBe('S\0?v=2');
  });
});

describe('MatchTable（仕様 §4.2）', () => {
  const rule = (resourceId: string, template: string) => ({ resourceId, type: 'tile' as const, compiled: compileTemplate(template) });

  it('一致した規則の resourceId・type・m を返す。登録順で先のものが勝つ', () => {
    const table = new MatchTable([
      rule('A', 'https://a.example/{z}/{x}/{y}.png'),
      rule('B', 'https://a.example/{z}/{x}/{y}.png'),
      rule('C', 'https://c.example/{z}/{x}/{y}.png'),
    ]);
    const r = table.match(new URL('https://a.example/1/0/1.png'));
    expect(r).toMatchObject({ resourceId: 'A', type: 'tile', m: { z: 1, x: 0, y: 1 } });
    expect(table.match(new URL('https://c.example/1/0/1.png'))?.resourceId).toBe('C');
    expect(table.match(new URL('https://a.example/x.png'))).toBeNull();
  });

  it('add で後から足せる。size は規則の数', () => {
    const table = new MatchTable();
    expect(table.size).toBe(0);
    expect(table.match(new URL('https://a.example/1/0/1.png'))).toBeNull();
    table.add(rule('A', 'https://a.example/{z}/{x}/{y}.png'));
    expect(table.size).toBe(1);
    expect(table.match(new URL('https://a.example/1/0/1.png'))?.resourceId).toBe('A');
  });

  it('別オリジンの要求では正規表現を 1 つも実行しない（RegExp.prototype.exec の spy が 0 回）', () => {
    const table = new MatchTable([
      rule('A', 'https://a.example/{z}/{x}/{y}.png'),
      rule('W', 'https://w.example/wmts?TileMatrix={z}&TileCol={x}&TileRow={y}&layer=a'),
    ]);
    const url = new URL('https://unrelated.example/1/0/1.png?TileMatrix=1');
    const spy = vi.spyOn(RegExp.prototype, 'exec');
    const r = table.match(url);
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(r).toBeNull();
    expect(calls).toBe(0);
  });

  it('対照: 同じオリジンの要求では正規表現を実行する（spy が働いている）', () => {
    const table = new MatchTable([rule('A', 'https://a.example/{z}/{x}/{y}.png')]);
    const url = new URL('https://a.example/1/0/1.png');
    const spy = vi.spyOn(RegExp.prototype, 'exec');
    table.match(url);
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(calls).toBeGreaterThan(0);
  });
});
