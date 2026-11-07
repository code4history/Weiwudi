// src/style_body.ts の試験（m3-t6・仕様 §5.5・§10・R5・R28・R31・R32・C-S1・C-S4・X5・S-N1）。純粋関数だけを表で確かめる。
import { describe, expect, it } from 'vitest';
import {
  collectStyleRefs, collectTileJson, credentialTargetOf, parseStyle, rewriteStyleBody, rewriteTileJsonBody,
  type StripRule,
} from '../../src/style_body';
import { WeiwudiError } from '../../src/errors';

const BASE = 'https://a.example/styles/s/style.json';
const TJ_BASE = 'https://a.example/tiles/t.json';
const CP = ['access_token', 'key'];

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof WeiwudiError ? `${e.code}${e.detail?.type ? `:${String(e.detail.type)}` : ''}` : `not WeiwudiError: ${String(e)}`;
  }
  return undefined;
};

/** 登録した資格情報の値（除くのはこれと同じ値の項目だけ。§10 R32） */
const VALUES = { access_token: 'pk.T', key: 'k' };

/** a.example だけを資格情報の相手とする（R5 の判定） */
const stripA: StripRule = { credentialParams: CP, credentialValues: VALUES, shouldStrip: credentialTargetOf({ styleOrigin: 'https://a.example' }) };

const style = (over: Record<string, unknown> = {}) => ({ version: 8, sources: {}, layers: [], ...over });

describe('parseStyle（JSON で、version と object の sources を持つ）', () => {
  it.each([
    ['JSON でない（HTML のログイン画面）', '<html>login</html>'],
    ['sources が無い', JSON.stringify({ version: 8, layers: [] })],
    ['sources が配列', JSON.stringify({ version: 8, sources: [] })],
    ['version が無い', JSON.stringify({ sources: {} })],
    ['object でない', '[1,2]'],
    ['null', 'null'],
  ])('%s は invalid-style', (_label, text) => {
    expect(codeOf(() => parseStyle(text))).toBe('invalid-style:style');
  });

  it('読めるスタイルは object を返す', () => {
    expect(parseStyle(JSON.stringify(style()))).toEqual(style());
  });
});

describe('collectStyleRefs（全項目。相対 URL はスタイルの URL で解決）', () => {
  const s = style({
    sources: {
      tj: { type: 'vector', url: 'https://a.example/tiles/t.json' },
      vt: { type: 'vector', tiles: ['https://b.example/{z}/{x}/{y}.pbf', 'https://c.example/{z}/{x}/{y}.pbf'], scheme: 'tms', bounds: [130, 30, 140, 40], minzoom: 2, maxzoom: 14 },
      rt: { type: 'raster', tiles: ['../../r/{z}/{x}/{y}.png'] },
      dem: { type: 'raster-dem', tiles: ['https://d.example/{z}/{x}/{y}.webp'] },
      gj: { type: 'geojson', data: 'data/points.geojson' },
      inline: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      img: { type: 'image', url: 'https://i.example/a.png', coordinates: [] },
      vid: { type: 'video', urls: ['https://v.example/a.mp4'], coordinates: [] },
    },
    glyphs: 'fonts/{fontstack}/{range}.pbf',
    sprite: 'https://a.example/sprites/s',
  });

  it('url・tiles・raster-dem・geojson の文字列の data・image・video の skipped・glyphs・sprite・相対 URL', () => {
    const refs = collectStyleRefs(s, BASE);
    expect(refs.tilejson).toEqual([{ name: 'tj', url: 'https://a.example/tiles/t.json' }]);
    expect(refs.tiles).toEqual([
      {
        name: 'vt', encoding: 'vector', urls: ['https://b.example/{z}/{x}/{y}.pbf', 'https://c.example/{z}/{x}/{y}.pbf'],
        scheme: 'tms', bounds: [130, 30, 140, 40], minzoom: 2, maxzoom: 14,
      },
      { name: 'rt', encoding: 'raster', urls: ['https://a.example/r/{z}/{x}/{y}.png'] },
      { name: 'dem', encoding: 'raster', urls: ['https://d.example/{z}/{x}/{y}.webp'] },
    ]);
    expect(refs.data).toEqual([
      { name: 'gj', url: 'https://a.example/styles/s/data/points.geojson' },
      { name: 'img', url: 'https://i.example/a.png' },
    ]);
    expect(refs.skipped).toEqual([{ name: 'vid', reason: 'unsupported-source' }]);
    expect(refs.glyphs).toBe('https://a.example/styles/s/fonts/{fontstack}/{range}.pbf');
    expect(refs.sprites).toEqual(['https://a.example/sprites/s']);
  });

  it('object の data は登録しない（data にも skipped にも出ない）', () => {
    const refs = collectStyleRefs(s, BASE);
    expect(refs.data.map((d) => d.name)).not.toContain('inline');
    expect(refs.skipped.map((d) => d.name)).not.toContain('inline');
  });

  it('sprite の {id, url}[] は url を並べる', () => {
    const refs = collectStyleRefs(style({ sprite: [{ id: 'default', url: 'sprites/a' }, { id: 'x', url: 'https://x.example/b' }] }), BASE);
    expect(refs.sprites).toEqual(['https://a.example/styles/s/sprites/a', 'https://x.example/b']);
  });

  it('glyphs・sprite が無ければ glyphs は undefined・sprites は空', () => {
    const refs = collectStyleRefs(style(), BASE);
    expect(refs.glyphs).toBeUndefined();
    expect(refs.sprites).toEqual([]);
  });

  it('知らない type の source は skipped', () => {
    expect(collectStyleRefs(style({ sources: { c: { type: 'custom' } } }), BASE).skipped).toEqual([{ name: 'c', reason: 'unsupported-source' }]);
  });

  it('読めないスタイルの形は invalid-style', () => {
    expect(codeOf(() => collectStyleRefs({ version: 8 }, BASE))).toBe('invalid-style:style');
  });
});

describe('collectTileJson（tiles・bounds・scheme・相対）', () => {
  it('tiles を base で絶対化し、bounds・scheme・minzoom・maxzoom を写す', () => {
    const tj = JSON.stringify({ tilejson: '3.0.0', tiles: ['{z}/{x}/{y}.pbf', 'https://b.example/{z}/{x}/{y}.pbf'], bounds: [-10, -20, 10, 20], scheme: 'tms', minzoom: 1, maxzoom: 9 });
    expect(collectTileJson(tj, TJ_BASE)).toEqual({
      urls: ['https://a.example/tiles/{z}/{x}/{y}.pbf', 'https://b.example/{z}/{x}/{y}.pbf'],
      bounds: [-10, -20, 10, 20], scheme: 'tms', minzoom: 1, maxzoom: 9,
    });
  });

  it('無い項目は出さない', () => {
    expect(collectTileJson(JSON.stringify({ tiles: ['https://b.example/{z}/{x}/{y}.pbf'] }), TJ_BASE))
      .toEqual({ urls: ['https://b.example/{z}/{x}/{y}.pbf'] });
  });

  it.each([
    ['JSON でない', '<html></html>'],
    ['tiles が無い', '{}'],
    ['tiles が配列でない', '{"tiles":"x"}'],
    ['object でない', '[]'],
  ])('%s は undefined', (_l, text) => {
    expect(collectTileJson(text, TJ_BASE)).toBeUndefined();
  });
});

describe('credentialTargetOf（R5。子を作るときと本体の除去が共有する判定）', () => {
  it('スタイルの URL と同じオリジンか、提供元の matches に当たる URL だけが真', () => {
    const f = credentialTargetOf({ styleOrigin: 'https://a.example', providerMatches: (u) => u.startsWith('https://api.mapbox.com/') });
    expect(f('https://a.example/{z}/{x}/{y}.pbf')).toBe(true);
    expect(f('https://api.mapbox.com/v4/x/{z}/{x}/{y}.pbf')).toBe(true);
    expect(f('https://b.example/{z}/{x}/{y}.pbf')).toBe(false);
    expect(f('https://a.example:8443/x')).toBe(false);
    expect(f('not a url')).toBe(false);
  });

  it('matches が投げたら当たらないものとする', () => {
    const f = credentialTargetOf({ styleOrigin: 'https://a.example', providerMatches: () => { throw new Error('x'); } });
    expect(f('https://b.example/x')).toBe(false);
  });
});

describe('rewriteStyleBody（本体の資格情報の除去は子の組の単位で絞る。R32）', () => {
  const body = (over: Record<string, unknown>) => JSON.stringify(style(over));

  it('strip も rewriteStyle も無ければ入力と同じ文字列（仕様 §10「登録が無ければ本体を変えない」）', () => {
    const text = `{ "version": 8, "sources": { "a": { "type": "raster", "tiles": ["https://a.example/{z}/{x}/{y}.png?key=k"] } } }`;
    expect(rewriteStyleBody(text, BASE, {})).toBe(text);
  });

  it('資格情報の項目だけを除き、字句と他のクエリを保つ（tiles・url・glyphs・sprite・data）', () => {
    const out = JSON.parse(rewriteStyleBody(body({
      sources: {
        t: { type: 'vector', tiles: ['https://a.example/{z}/{x}/{y}.pbf?v=2&access_token=pk.T&lang={ratio}'] },
        u: { type: 'vector', url: 'https://a.example/t.json?KEY=k&v=1' },
        g: { type: 'geojson', data: 'https://a.example/p.geojson?key=k' },
      },
      glyphs: 'https://a.example/fonts/{fontstack}/{range}.pbf?access_token=pk.T',
      sprite: 'https://a.example/sprites/s?access_token=pk.T&fresh=true',
    }), BASE, { strip: stripA }));
    expect(out.sources.t.tiles).toEqual(['https://a.example/{z}/{x}/{y}.pbf?v=2&lang={ratio}']);
    expect(out.sources.u.url).toBe('https://a.example/t.json?v=1');
    expect(out.sources.g.data).toBe('https://a.example/p.geojson');
    expect(out.glyphs).toBe('https://a.example/fonts/{fontstack}/{range}.pbf');
    expect(out.sprite).toBe('https://a.example/sprites/s?fresh=true');
    expect(out.version).toBe(8);
  });

  it('C-S1・X5: a.example のスタイルの中で b.example のタイルの ?key=k は残り、a.example のタイルの ?key=k だけが除かれる', () => {
    const out = JSON.parse(rewriteStyleBody(body({
      sources: {
        a: { type: 'raster', tiles: ['https://a.example/{z}/{x}/{y}.png?key=k'] },
        b: { type: 'raster', tiles: ['https://b.example/{z}/{x}/{y}.png?key=k'] },
      },
    }), BASE, { strip: stripA }));
    expect(out.sources.a.tiles).toEqual(['https://a.example/{z}/{x}/{y}.png']);
    expect(out.sources.b.tiles).toEqual(['https://b.example/{z}/{x}/{y}.png?key=k']);
  });

  it('S-N1: 組（1 つの子になる URL の全部）に偽の URL が 1 つでもあれば、その組の URL は 1 つも除かない', () => {
    const out = JSON.parse(rewriteStyleBody(body({
      sources: { m: { type: 'raster', tiles: ['https://a.example/{z}/{x}/{y}.png?key=k', 'https://c.example/{z}/{x}/{y}.png?key=k'] } },
    }), BASE, { strip: stripA }));
    expect(out.sources.m.tiles).toEqual(['https://a.example/{z}/{x}/{y}.png?key=k', 'https://c.example/{z}/{x}/{y}.png?key=k']);
  });

  it('sprite の配列は要素ごとの組', () => {
    const out = JSON.parse(rewriteStyleBody(body({
      sprite: [{ id: 'a', url: 'https://a.example/s?key=k' }, { id: 'b', url: 'https://b.example/s?key=k' }],
    }), BASE, { strip: stripA }));
    expect(out.sprite).toEqual([{ id: 'a', url: 'https://a.example/s' }, { id: 'b', url: 'https://b.example/s?key=k' }]);
  });

  it('子にならない URL（metadata.url・video の urls・object の data の中）の ?key= は残る', () => {
    const out = JSON.parse(rewriteStyleBody(body({
      metadata: { url: 'https://a.example/meta?key=k' },
      sources: {
        v: { type: 'video', urls: ['https://a.example/v.mp4?key=k'], coordinates: [] },
        o: { type: 'geojson', data: { url: 'https://a.example/x?key=k' } },
      },
    }), BASE, { strip: stripA }));
    expect(out.metadata.url).toBe('https://a.example/meta?key=k');
    expect(out.sources.v.urls).toEqual(['https://a.example/v.mp4?key=k']);
    expect(out.sources.o.data.url).toBe('https://a.example/x?key=k');
  });

  it('相対 URL（base が a.example）は絶対化して判定し、相対の形のまま項目だけ除かれる', () => {
    const out = JSON.parse(rewriteStyleBody(body({
      sources: { r: { type: 'vector', tiles: ['tiles/{z}/{x}/{y}.pbf?key=k&v=1'] } },
    }), BASE, { strip: stripA }));
    expect(out.sources.r.tiles).toEqual(['tiles/{z}/{x}/{y}.pbf?v=1']);
  });

  it('除く項目が無ければ入力と同じ文字列', () => {
    const text = body({ sources: { a: { type: 'raster', tiles: ['https://a.example/{z}/{x}/{y}.png?v=1'] } } });
    expect(rewriteStyleBody(text, BASE, { strip: stripA })).toBe(text);
  });

  it('rewriteStyle を先に当て、その結果の URL で除去を判定する（入力の object を書き換えない）', () => {
    let seen: unknown;
    const text = body({ sources: { m: { type: 'raster', tiles: ['mapbox://tiles/u.t/{z}/{x}/{y}.png?access_token=pk.T'] } } });
    const out = JSON.parse(rewriteStyleBody(text, BASE, {
      rewriteStyle: (s) => {
        seen = s;
        const copy = JSON.parse(JSON.stringify(s)) as { sources: { m: { tiles: string[] } } };
        copy.sources.m.tiles = ['https://api.mapbox.com/v4/u.t/{z}/{x}/{y}.png?access_token=pk.T'];
        return copy;
      },
      strip: { credentialParams: CP, credentialValues: VALUES, shouldStrip: credentialTargetOf({ styleOrigin: 'https://a.example', providerMatches: (u) => u.startsWith('https://api.mapbox.com/') }) },
    }));
    expect(out.sources.m.tiles).toEqual(['https://api.mapbox.com/v4/u.t/{z}/{x}/{y}.png']);
    expect((seen as { sources: { m: { tiles: string[] } } }).sources.m.tiles[0]).toContain('mapbox://');
  });

  it('§10 R32: 登録した資格情報と同じ値の項目だけを除き、違う値（子の固有のトークン）は残す', () => {
    const strip: StripRule = { ...stripA, credentialValues: { access_token: 'pk.PARENT' } };
    const out = JSON.parse(rewriteStyleBody(body({
      sources: {
        p: { type: 'raster', tiles: ['https://a.example/p/{z}/{x}/{y}.png?access_token=pk.PARENT&v=1'] },
        c: { type: 'raster', tiles: ['https://a.example/c/{z}/{x}/{y}.png?access_token=pk.CHILD&v=1'] },
        // 登録の無い名前（key）は子の固有の値なので残す
        k: { type: 'raster', tiles: ['https://a.example/k/{z}/{x}/{y}.png?key=own'] },
      },
      glyphs: 'https://a.example/fonts/{fontstack}/{range}.pbf?ACCESS_TOKEN=pk.PARENT',
      sprite: [{ id: 's1', url: 'https://a.example/sprites/s1?access_token=pk.CHILD' }],
    }), BASE, { strip }));
    expect(out.sources.p.tiles).toEqual(['https://a.example/p/{z}/{x}/{y}.png?v=1']);
    expect(out.sources.c.tiles).toEqual(['https://a.example/c/{z}/{x}/{y}.png?access_token=pk.CHILD&v=1']);
    expect(out.sources.k.tiles).toEqual(['https://a.example/k/{z}/{x}/{y}.png?key=own']);
    expect(out.glyphs).toBe('https://a.example/fonts/{fontstack}/{range}.pbf');
    expect(out.sprite).toEqual([{ id: 's1', url: 'https://a.example/sprites/s1?access_token=pk.CHILD' }]);
  });

  it('§10 R32: 値は percent-decode して比べる（符号化が違っても同じ値なら除く）', () => {
    const strip: StripRule = { ...stripA, credentialValues: { access_token: 'pk.A/B' } };
    const out = JSON.parse(rewriteStyleBody(body({
      sources: { m: { type: 'raster', tiles: ['https://a.example/{z}/{x}/{y}.png?access_token=pk.A%2FB'] } },
    }), BASE, { strip }));
    expect(out.sources.m.tiles).toEqual(['https://a.example/{z}/{x}/{y}.png']);
  });

  it('§10 R32: 登録の値が無ければ（ヘッダだけの資格情報など）本体の項目を除かない', () => {
    const text = body({ sources: { a: { type: 'raster', tiles: ['https://a.example/{z}/{x}/{y}.png?key=k'] } } });
    expect(rewriteStyleBody(text, BASE, { strip: { ...stripA, credentialValues: {} } })).toBe(text);
  });

  it('JSON でない・スタイルの形でない本体は invalid-style を投げる（strip が無くても）', () => {
    expect(codeOf(() => rewriteStyleBody('<html>login</html>', BASE, {}))).toBe('invalid-style:style');
    expect(codeOf(() => rewriteStyleBody('{"version":8}', BASE, { strip: stripA }))).toBe('invalid-style:style');
  });

  it('rewriteStyle の結果がスタイルの形でなければ invalid-style', () => {
    expect(codeOf(() => rewriteStyleBody(body({}), BASE, { rewriteStyle: () => 'x' }))).toBe('invalid-style:style');
  });
});

describe('rewriteTileJsonBody（tiles の全体が 1 つの組）', () => {
  it('strip が無ければ入力と同じ文字列', () => {
    const text = '{"tiles":["https://a.example/{z}/{x}/{y}.pbf?key=k"]}';
    expect(rewriteTileJsonBody(text, TJ_BASE, {})).toBe(text);
  });

  it('全部が真なら資格情報の項目だけを除く（相対の形のまま）', () => {
    const out = JSON.parse(rewriteTileJsonBody(JSON.stringify({ tiles: ['https://a.example/{z}/{x}/{y}.pbf?key=k&v=1', '{z}/{x}/{y}.pbf?access_token=pk.T'], name: 'n?key=k' }), TJ_BASE, { strip: stripA }));
    expect(out.tiles).toEqual(['https://a.example/{z}/{x}/{y}.pbf?v=1', '{z}/{x}/{y}.pbf']);
    expect(out.name).toBe('n?key=k');
  });

  it('§10 R32: tiles の項目も、登録した資格情報と同じ値だけを除き、違う値（子の固有のトークン）は残す', () => {
    const strip: StripRule = { ...stripA, credentialValues: { access_token: 'pk.PARENT' } };
    const out = JSON.parse(rewriteTileJsonBody(JSON.stringify({
      tiles: ['https://a.example/{z}/{x}/{y}.pbf?access_token=pk.CHILD&v=1', '{z}/{x}/{y}.pbf?access_token=pk.PARENT'],
    }), TJ_BASE, { strip }));
    expect(out.tiles).toEqual(['https://a.example/{z}/{x}/{y}.pbf?access_token=pk.CHILD&v=1', '{z}/{x}/{y}.pbf']);
  });

  it('偽の URL が混ざれば 1 つも除かない（S-N1）', () => {
    const text = JSON.stringify({ tiles: ['https://a.example/{z}/{x}/{y}.pbf?key=k', 'https://b.example/{z}/{x}/{y}.pbf?key=k'] });
    expect(rewriteTileJsonBody(text, TJ_BASE, { strip: stripA })).toBe(text);
  });

  it.each([
    ['JSON でない', '<html></html>'],
    ['tiles が配列でない', '{"tiles":"x"}'],
    ['object でない', '[]'],
  ])('%s は invalid-style（detail.type: tilejson）', (_l, text) => {
    expect(codeOf(() => rewriteTileJsonBody(text, TJ_BASE, {}))).toBe('invalid-style:tilejson');
  });
});

describe('子として受けられない組（L1 Major-1・Minor-3）', () => {
  const body = (over: Record<string, unknown>) => JSON.stringify(style(over));

  it('WMS（{bbox-epsg-3857}）の tiles は子にならないので ?key=k を除かず、その source は skipped', () => {
    const s = style({ sources: { w: { type: 'raster', tiles: ['https://a.example/wms?bbox={bbox-epsg-3857}&key=k'] } } });
    const out = JSON.parse(rewriteStyleBody(JSON.stringify(s), BASE, { strip: stripA }));
    expect(out.sources.w.tiles).toEqual(['https://a.example/wms?bbox={bbox-epsg-3857}&key=k']);
    const refs = collectStyleRefs(s, BASE);
    expect(refs.tiles).toEqual([]);
    expect(refs.skipped).toEqual([{ name: 'w', reason: 'unsupported-source' }]);
  });

  it('座標の取れない tiles（{z} だけ）も子にならず、除かない', () => {
    const text = body({ sources: { z: { type: 'raster', tiles: ['https://a.example/{z}.png?key=k'] } } });
    expect(rewriteStyleBody(text, BASE, { strip: stripA })).toBe(text);
  });

  it('{range} の無い glyphs は子にならないので ?key=k を除かず、glyphs に出ない', () => {
    const s = style({ glyphs: 'https://a.example/fonts/{fontstack}.pbf?key=k' });
    const out = JSON.parse(rewriteStyleBody(JSON.stringify(s), BASE, { strip: stripA }));
    expect(out.glyphs).toBe('https://a.example/fonts/{fontstack}.pbf?key=k');
    expect(collectStyleRefs(s, BASE).glyphs).toBeUndefined();
  });

  it('子にできない glyphs・sprite は dropped に種類と論理名が残る（URL・トークンを入れない。仕様 §12）', () => {
    const refs = collectStyleRefs(style({
      glyphs: 'https://a.example/fonts/{fontstack}.pbf?key=SECRETG',
      sprite: [
        { id: 'bad', url: 'https://a.example/{z}/sprite?key=SECRETS' },
        { id: 'ok', url: 'https://a.example/sprites/ok' },
      ],
    }), BASE);
    expect(refs.glyphs).toBeUndefined();
    expect(refs.sprites).toEqual(['https://a.example/sprites/ok']);
    expect(refs.spriteIds).toEqual(['ok']);
    expect(refs.dropped).toEqual([{ slot: 'glyphs' }, { slot: 'sprite', spriteId: 'bad' }]);
    expect(JSON.stringify(refs.dropped)).not.toContain('SECRET');
  });

  it('子にできない文字列の sprite は dropped に spriteId なしの sprite として残る', () => {
    const refs = collectStyleRefs(style({ sprite: 'https://a.example/{z}/sprite?key=k' }), BASE);
    expect(refs.sprites).toEqual([]);
    expect(refs.dropped).toEqual([{ slot: 'sprite' }]);
  });

  it('字句のある data・TileJSON の url・sprite は子にならず、除かない', () => {
    const s = style({
      sources: {
        d: { type: 'geojson', data: 'https://a.example/{z}.json?key=k' },
        u: { type: 'vector', url: 'https://a.example/{x}.json?key=k' },
      },
      sprite: 'https://a.example/{z}/sprite?key=k',
    });
    const text = JSON.stringify(s);
    expect(rewriteStyleBody(text, BASE, { strip: stripA })).toBe(text);
    const refs = collectStyleRefs(s, BASE);
    expect(refs.data).toEqual([]);
    expect(refs.tilejson).toEqual([]);
    expect(refs.sprites).toEqual([]);
    expect(refs.skipped.map((x) => x.name).sort()).toEqual(['d', 'u']);
  });

  it('Minor-3: 1 つの source の組のどれかが受けられなければ、その source は skipped だけに出る（tiles・tilejson に出ず、除かない）', () => {
    const s = style({
      sources: { v: { type: 'vector', url: 'https://a.example/t.json?key=k', tiles: ['https://a.example/wms?bbox={bbox-epsg-3857}&key=k'] } },
    });
    const refs = collectStyleRefs(s, BASE);
    expect(refs.tilejson).toEqual([]);
    expect(refs.tiles).toEqual([]);
    expect(refs.skipped).toEqual([{ name: 'v', reason: 'unsupported-source' }]);
    const text = JSON.stringify(s);
    expect(rewriteStyleBody(text, BASE, { strip: stripA })).toBe(text);
  });

  it('TileJSON の tiles が子として受けられなければ除かない', () => {
    const text = JSON.stringify({ tiles: ['https://a.example/wms?bbox={bbox-epsg-3857}&key=k'] });
    expect(rewriteTileJsonBody(text, TJ_BASE, { strip: stripA })).toBe(text);
  });
});

describe('組の判定 accepts（m3-t7・t6 の申し送り: 子作りと本体の除去で同じ組を使う）', () => {
  const tiles = ['https://a.example/m/{z}/{x}/{y}.png?access_token=pk.T', 'https://a.example/n/{z}/{x}/{y}.png?access_token=pk.T'];
  const s = () => style({
    sources: { m: { type: 'raster', tiles, url: 'https://a.example/m.json' }, k: { type: 'raster', tiles: ['https://a.example/k/{z}/{x}/{y}.png?access_token=pk.T'] } },
    sprite: [{ id: 'default', url: 'https://a.example/sprites/s?access_token=pk.T' }],
  });
  /** m の tiles の組だけを受けない（R22 などで normalizeMember が拒否する組の代わり） */
  const rejectM = (_type: string, templates: string[]) => !templates.some((t) => t.includes('/m/'));

  it('collectStyleRefs: accepts が偽の組の source は丸ごと skipped（url の組も子にしない）。sprite の組はテンプレート（{spriteSuffix}）で渡す', () => {
    const seen: [string, string[]][] = [];
    const refs = collectStyleRefs(s(), BASE, (type, templates) => {
      seen.push([type, templates]);
      return rejectM(type, templates);
    });
    expect(refs.skipped).toEqual([{ name: 'm', reason: 'unsupported-source' }]);
    expect(refs.tilejson).toEqual([]);
    expect(refs.tiles.map((t) => t.name)).toEqual(['k']);
    expect(seen).toContainEqual(['sprite', ['https://a.example/sprites/s{spriteSuffix}?access_token=pk.T']]);
    expect(refs.spriteIds).toEqual(['default']);
  });

  it('rewriteStyleBody: accepts が偽の組からは除かない（受ける組からは除く）', () => {
    const out = JSON.parse(rewriteStyleBody(JSON.stringify(s()), BASE, { strip: { ...stripA, accepts: rejectM } }));
    expect(out.sources.m.tiles).toEqual(tiles);
    expect(out.sources.k.tiles).toEqual(['https://a.example/k/{z}/{x}/{y}.png']);
  });

  it('rewriteTileJsonBody: accepts が偽なら tiles を除かない', () => {
    const body = JSON.stringify({ tiles });
    expect(rewriteTileJsonBody(body, TJ_BASE, { strip: { ...stripA, accepts: rejectM } })).toBe(body);
    expect(JSON.parse(rewriteTileJsonBody(body, TJ_BASE, { strip: { ...stripA, accepts: () => true } })).tiles)
      .toEqual(['https://a.example/m/{z}/{x}/{y}.png', 'https://a.example/n/{z}/{x}/{y}.png']);
  });
});

describe('userinfo の組（L2 B: accepts が無くても子作りと除去で揃う）', () => {
  const ui = 'https://user:pass@a.example/u/{z}/{x}/{y}.png?access_token=pk.T';
  it('collectStyleRefs は userinfo の組の source を skipped にし、rewriteStyleBody・rewriteTileJsonBody はその組から除かない', () => {
    const s = style({ sources: { u: { type: 'raster', tiles: [ui] } } });
    expect(collectStyleRefs(s, BASE).skipped).toEqual([{ name: 'u', reason: 'unsupported-source' }]);
    expect(JSON.parse(rewriteStyleBody(JSON.stringify(s), BASE, { strip: stripA })).sources.u.tiles).toEqual([ui]);
    const tj = JSON.stringify({ tiles: [ui] });
    expect(rewriteTileJsonBody(tj, TJ_BASE, { strip: stripA })).toBe(tj);
  });
});

// ---- m4-t4（計画 docs/superpowers/plans/2026-11-07-m4-range-release-migration.md の m4-t4・R53）。追記のみ ----

import { collectFonts } from '../../src/style_body';

describe('collectFonts（m4-t4・R53）', () => {
  const styleWith = (layers: unknown[]) => ({ version: 8, sources: {}, layers });

  it('文字列の配列の text-font を , で結んで 1 つの fontstack にする', () => {
    const s = styleWith([
      { id: 'a', type: 'symbol', layout: { 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'] } },
      { id: 'b', type: 'symbol', layout: { 'text-font': ['Noto Sans Bold'] } },
    ]);
    expect(collectFonts(s)).toEqual(['Open Sans Regular,Arial Unicode MS Regular', 'Noto Sans Bold']);
  });

  it('["literal", [文字列…]] を読む', () => {
    const s = styleWith([{ id: 'a', type: 'symbol', layout: { 'text-font': ['literal', ['Noto Sans Regular', 'Noto Sans CJK JP Regular']] } }]);
    expect(collectFonts(s)).toEqual(['Noto Sans Regular,Noto Sans CJK JP Regular']);
  });

  it('式（先頭が演算子の配列）・関数の object・空の配列・文字列でない要素は飛ばす', () => {
    const s = styleWith([
      { id: 'a', type: 'symbol', layout: { 'text-font': ['get', 'font'] } },
      { id: 'b', type: 'symbol', layout: { 'text-font': ['case', ['has', 'x'], ['literal', ['A']], ['literal', ['B']]] } },
      { id: 'c', type: 'symbol', layout: { 'text-font': ['coalesce', ['get', 'f'], ['literal', ['C']]] } },
      { id: 'd', type: 'symbol', layout: { 'text-font': { stops: [[0, ['D']]] } } },
      { id: 'e', type: 'symbol', layout: { 'text-font': [] } },
      { id: 'f', type: 'symbol', layout: { 'text-font': ['E', 1] } },
      { id: 'g', type: 'symbol', layout: { 'text-font': ['literal', 'F'] } },
      { id: 'h', type: 'symbol', layout: { 'text-font': ['Kept Regular'] } },
    ]);
    expect(collectFonts(s)).toEqual(['Kept Regular']);
  });

  it('重複を除く（最初に現れた順）', () => {
    const s = styleWith([
      { id: 'a', type: 'symbol', layout: { 'text-font': ['B Regular'] } },
      { id: 'b', type: 'symbol', layout: { 'text-font': ['A Regular'] } },
      { id: 'c', type: 'symbol', layout: { 'text-font': ['literal', ['B Regular']] } },
    ]);
    expect(collectFonts(s)).toEqual(['B Regular', 'A Regular']);
  });

  it('layout の無い layer・layers の無いスタイル・object でない値は空', () => {
    expect(collectFonts(styleWith([{ id: 'a', type: 'background' }, { id: 'b', type: 'symbol', layout: null }, null, 'x']))).toEqual([]);
    expect(collectFonts({ version: 8, sources: {} })).toEqual([]);
    expect(collectFonts(null)).toEqual([]);
    expect(collectFonts('x')).toEqual([]);
  });
});
