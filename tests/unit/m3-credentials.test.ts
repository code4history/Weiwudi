// m3-t3: 資格情報の検査と行き先（I1・I2・I9。仕様 §5.1・§10）。仕様の文 1 つにつき 1 件。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createSwHarness } from './sw-harness';
import { createContext, type Context } from '../../src/context';
import { normalizeSpec } from '../../src/spec';
import { compileTemplate, entryKey, matchUrl } from '../../src/url_pattern';
import { createUpstream } from '../../src/upstream';
import type { Credentials, ResourceMeta } from '../../src/store';
import { WeiwudiError } from '../../src/errors';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const png = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });

const errorOf = (input: unknown): WeiwudiError | undefined => {
  try {
    normalizeSpec(input);
    return undefined;
  } catch (e) {
    if (e instanceof WeiwudiError) return e;
    throw e;
  }
};

/** credentials ストアの記録の数（fake-indexeddb を直に開く） */
const credentialCount = async (factory: IDBFactory): Promise<number> => {
  const db: IDBDatabase = await new Promise((res, rej) => {
    const q = factory.open('WeiwudiStore');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  const n: number = await new Promise((res, rej) => {
    const q = db.transaction('credentials').objectStore('credentials').count();
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  db.close();
  return n;
};

const A = 'https://a.t.example/{z}/{x}/{y}.png';
const B = 'https://b.t.example/{z}/{x}/{y}.png';

describe('I2（R22）: ミラーの間で資格情報の値が違えば attribute-invalid', () => {
  it('access_token の値が違う 2 つのミラー → attribute-invalid。文面に値が無い', () => {
    const e = errorOf({ kind: 'raster', url: [`${A}?access_token=AAA111`, `${B}?access_token=BBB222`] });
    expect(e?.code).toBe('attribute-invalid');
    expect(e?.message).toBe('URL templates carry different values for credential "access_token"; register each mirror as its own source');
    expect(e?.message).not.toContain('AAA111');
    expect(e?.message).not.toContain('BBB222');
  });

  it('名前の大文字小文字を問わない（ACCESS_TOKEN と access_token）', () => {
    expect(errorOf({ kind: 'raster', url: [`${A}?access_token=AAA111`, `${B}?ACCESS_TOKEN=BBB222`] })?.code).toBe('attribute-invalid');
  });

  it('SW: 拒否したとき credentials ストアに何も書かれない', async () => {
    const h = createSwHarness();
    h.fetch.mockImplementation(async () => png());
    // 先に資格情報つきの Source を 1 つ登録しておく（ストアを作り、数の比較を意味のあるものにする）
    const ok = await h.post('/v2/register', { kind: 'raster', id: 'ok', url: 'https://c.t.example/{z}/{x}/{y}.png?access_token=OK' });
    expect((await ok!.json()).ok).toBe(true);
    expect(await credentialCount(h.factory)).toBe(1);
    const reg = await h.post('/v2/register', { kind: 'raster', url: [`${A}?access_token=AAA111`, `${B}?access_token=BBB222`] });
    const j = await reg!.json();
    expect(j.ok).toBe(false);
    expect(j.error.code).toBe('attribute-invalid');
    expect(JSON.stringify(j)).not.toContain('AAA111');
    expect(await credentialCount(h.factory)).toBe(1);
  });

  it('同じ値なら通る', () => {
    const n = normalizeSpec({ kind: 'raster', url: [`${A}?access_token=SAME`, `${B}?access_token=SAME`] });
    expect(n.credentials).toEqual({ query: { access_token: 'SAME' } });
  });

  it('片方だけにあれば通る', () => {
    const n = normalizeSpec({ kind: 'raster', url: [`${A}?access_token=ONLY`, B] });
    expect(n.credentials).toEqual({ query: { access_token: 'ONLY' } });
  });

  it('明示の credentials.query があれば、その名前はテンプレートの値を見ない（明示が勝つ）', () => {
    const n = normalizeSpec({
      kind: 'raster', url: [`${A}?access_token=AAA111`, `${B}?access_token=BBB222`],
      credentials: { query: { access_token: 'EXPLICIT' } },
    });
    expect(n.credentials).toEqual({ query: { access_token: 'EXPLICIT' } });
  });
});

describe('I9（R23）: パスの区画は sk.eyJ だけを拒否する', () => {
  it('…/sk.osm/{z}/{x}/{y}.png は通る', () => {
    expect(errorOf({ kind: 'raster', url: 'https://t.example/sk.osm/{z}/{x}/{y}.png' })).toBeUndefined();
  });

  it.each([
    ['生の形', 'https://t.example/sk.eyJ1IjoiYSJ9/{z}/{x}/{y}.png'],
    ['decode した形', 'https://t.example/%73k.eyJ1IjoiYSJ9/{z}/{x}/{y}.png'],
  ])('%s の sk.eyJ は credential-rejected', (_l, url) => {
    expect(errorOf({ kind: 'raster', url })?.code).toBe('credential-rejected');
  });

  it('クエリ値は今の sk. のまま（?x=sk.osm も拒否）', () => {
    expect(errorOf({ kind: 'raster', url: 'https://t.example/{z}/{x}/{y}.png?x=sk.osm' })?.code).toBe('credential-rejected');
  });
});

describe('I9（R23）・X4: キーの残りのクエリから名前か値が sk. で始まる項目を除く', () => {
  const T = 'https://a.example/{z}/{x}/{y}.png';
  const keyOf = (u: string): string => {
    const url = new URL(u);
    const m = matchUrl(compileTemplate(T), url)!;
    return entryKey('R', 'tile', m, url, []);
  };

  it('?foo=sk.abc&b=1 のキーに sk.abc が無く ?b=1 が残る', () => {
    const k = keyOf('https://a.example/3/1/2.png?foo=sk.abc&b=1');
    expect(k).not.toContain('sk.abc');
    expect(k.endsWith('?b=1')).toBe(true);
  });

  it.each([
    ['decode した値', 'https://a.example/3/1/2.png?foo=%73k.abc&b=1'],
    ['名前', 'https://a.example/3/1/2.png?sk.abc=1&b=1'],
    ['値の無い名前（大文字）', 'https://a.example/3/1/2.png?SK.abc&b=1'],
  ])('%s', (_l, u) => {
    const k = keyOf(u);
    expect(k.endsWith('?b=1')).toBe(true);
    expect(k.toLowerCase()).not.toContain('sk.');
    expect(k.toLowerCase()).not.toContain('%73k');
  });

  it('?foo=disk.png は残る', () => {
    expect(keyOf('https://a.example/3/1/2.png?foo=disk.png').endsWith('?foo=disk.png')).toBe(true);
  });
});

describe('I1（R21）: 資格情報は差し込み口の後の要求が元と同じオリジンのときだけ足す', () => {
  const RID = 'https://t.example/{z}/{x}/{y}.png';
  const TILE = 'https://t.example/1/0/0.png';
  const CRED: Credentials = { query: { access_token: 'QTOKEN' }, headers: { 'x-api-key': 'HTOKEN' } };
  let ctx: Context;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    fetchMock = vi.fn(async () => png());
    vi.stubGlobal('fetch', fetchMock);
    ctx = createContext();
    const resource: ResourceMeta = {
      id: RID, type: 'tile', templates: [RID], sourceIds: ['s1'], count: 0, bytes: 0, pinnedBytes: 0,
      policy: { cacheTtl: 60_000, store: false, outOfRange: { extent: 'transparent', zoom: 'transparent' }, credentialParams: ['access_token'] },
    };
    await (await ctx.store()).createResource(resource);
  });

  const run = async (original: Request, request: Request, credentials: Credentials | undefined): Promise<Request> => {
    const up = createUpstream(ctx, { resourceId: RID, original, credentials, now: () => 0 });
    await up(request, { hasEntry: false, requestChanged: request !== original });
    return fetchMock.mock.calls[0][0] as Request;
  };

  it('差し込み口が別オリジンへ替えたとき、上流の要求にクエリもヘッダも付かない', async () => {
    const original = new Request(TILE);
    const sent = await run(original, new Request('https://other.example/1/0/0.png'), CRED);
    expect(new URL(sent.url).origin).toBe('https://other.example');
    expect(sent.url).not.toContain('QTOKEN');
    expect(sent.headers.get('x-api-key')).toBeNull();
  });

  it('同じオリジンへ替えたときは付く', async () => {
    const original = new Request(TILE);
    const sent = await run(original, new Request('https://t.example/1/0/0.png?v=2'), CRED);
    expect(sent.url).toContain('access_token=QTOKEN');
    expect(sent.headers.get('x-api-key')).toBe('HTOKEN');
  });

  it('ヘッダの資格情報を足した要求の redirect は error', async () => {
    const original = new Request(TILE);
    expect((await run(original, original, { headers: { 'x-api-key': 'HTOKEN' } })).redirect).toBe('error');
  });

  it('クエリの資格情報だけなら元の redirect のまま', async () => {
    const original = new Request(TILE, { redirect: 'follow' });
    expect((await run(original, original, { query: { access_token: 'QTOKEN' } })).redirect).toBe('follow');
  });

  it('資格情報なしなら元の redirect のまま', async () => {
    const original = new Request(TILE, { redirect: 'manual' });
    expect((await run(original, original, undefined)).redirect).toBe('manual');
  });

  it('リダイレクトで fetch が失敗したら network になる（§6 の 6・7）', async () => {
    fetchMock.mockImplementation(async (r: Request) => {
      if (r.redirect === 'error') throw new TypeError('redirect');
      return png();
    });
    const original = new Request(TILE);
    const up = createUpstream(ctx, { resourceId: RID, original, credentials: { headers: { 'x-api-key': 'HTOKEN' } }, now: () => 0 });
    expect((await up(original, { hasEntry: false, requestChanged: false })).kind).toBe('network');
  });
});
