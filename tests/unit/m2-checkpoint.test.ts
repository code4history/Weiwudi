// m2「新コア」の区切りのレビューの指摘の試験（全体レビュー M1・セキュリティ M-1・L-1・L-2）。
// 再現は区切りのレビューの scratchpad（m2review/tms-bounds.test.ts・m2sec/sec.test.ts の F1〜F3）から移した。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSwHarness } from './sw-harness';
import { createContext } from '../../src/context';
import { applyRegister } from '../../src/registry';
import { normalizeSpec } from '../../src/spec';
import { openStore } from '../../src/store';
import { WeiwudiError } from '../../src/errors';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const png = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });

/** IndexedDB に残る id・テンプレート・spec・Entry のキーを全部並べる */
const allKeys = async (factory: IDBFactory): Promise<string[]> => {
  vi.stubGlobal('indexedDB', factory);
  const store = await openStore();
  const out: string[] = [];
  for (const r of await store.listResources()) {
    out.push(`R:${r.id}`);
    r.templates.forEach((t) => out.push(`T:${t}`));
  }
  for (const s of await store.listSources()) {
    out.push(`S:${s.id}`);
    out.push(`SPEC:${JSON.stringify(s.spec)}`);
  }
  const db: IDBDatabase = await new Promise((res, rej) => {
    const q = factory.open('WeiwudiStore');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  const keys: IDBValidKey[] = await new Promise((res, rej) => {
    const q = db.transaction('entries').objectStore('entries').getAllKeys();
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  keys.forEach((k) => out.push(`E:${String(k)}`));
  db.close();
  return out;
};

describe('M1: scheme が tms のときの bounds（box は Source の scheme の座標）', () => {
  const TOKYO = [139, 35, 140, 36];
  const run = async (scheme: 'xyz' | 'tms', y: number) => {
    const h = createSwHarness();
    h.fetch.mockImplementation(async () => png());
    const ctx = createContext();
    await applyRegister(await ctx.store(), normalizeSpec({
      kind: 'raster', url: 'https://t.example/{z}/{x}/{y}.png', scheme, bounds: TOKYO, maxZoom: 10,
    }));
    await h.flushRoutes();
    const res = await h.dispatch(`https://t.example/10/909/${y}.png`);
    return { status: res!.headers.get('x-weiwudi-status'), fetched: h.fetch.mock.calls.length };
  };

  it('xyz: 東京（z10 x909 y403）は範囲の中', async () => {
    expect(await run('xyz', 403)).toEqual({ status: 'miss', fetched: 1 });
  });
  it('tms: 同じタイル（TMS の y は 1023-403=620）は範囲の中', async () => {
    expect(await run('tms', 620)).toEqual({ status: 'miss', fetched: 1 });
  });
  it('tms: y=403（TMS では地球の反対側の緯度）は範囲の外', async () => {
    expect((await run('tms', 403)).status).toBe('out-of-range');
  });
  it('tms の Source が xyz の Resource に範囲だけ加わると、XYZ の y で東京が範囲の中になる', async () => {
    const h = createSwHarness();
    h.fetch.mockImplementation(async () => png());
    const store = await createContext().store();
    // xyz の Resource は赤道付近だけ
    await applyRegister(store, normalizeSpec({
      kind: 'raster', id: 'X', url: 'https://t.example/{z}/{x}/{y}.png', bounds: [0, 0, 1, 1], maxZoom: 10,
    }));
    const r = await applyRegister(store, normalizeSpec({
      kind: 'raster', id: 'T', url: 'https://t.example/{z}/{x}/{y}.png', scheme: 'tms', bounds: TOKYO, maxZoom: 10,
    }));
    expect(r.warnings).toHaveLength(1);
    expect(r.resources[0].rangeOnlySourceIds).toEqual(['T']);
    await h.flushRoutes();
    expect((await h.dispatch('https://t.example/10/909/403.png'))!.headers.get('x-weiwudi-status')).toBe('miss');
    expect((await h.dispatch('https://t.example/10/909/620.png'))!.headers.get('x-weiwudi-status')).toBe('out-of-range');
  });
});

describe('M-1: 明示の credentials.query の名前は credentialParams に入る', () => {
  it('テンプレートの ?myKey=SECRET1 が id・templates・url に残らない', () => {
    const n = normalizeSpec({
      kind: 'raster',
      url: 'https://t.example/{z}/{x}/{y}.png?myKey=SECRET1',
      credentials: { query: { myKey: 'SECRET1' } },
    });
    expect(n.spec.id).not.toContain('SECRET1');
    expect(n.spec.templates[0]).not.toContain('SECRET1');
    expect(JSON.stringify(n.spec.url)).not.toContain('SECRET1');
    expect(n.spec.policy.credentialParams).toContain('myKey');
    expect(n.credentials).toEqual({ query: { myKey: 'SECRET1' } });
  });

  it('既にある名前は大文字小文字を問わずに足さない', () => {
    const n = normalizeSpec({
      kind: 'raster', url: 'https://t.example/{z}/{x}/{y}.png', credentialParams: ['mykey'],
      credentials: { query: { MyKey: 'v', ACCESS_TOKEN: 'w' } },
    });
    const lower = n.spec.policy.credentialParams.map((p) => p.toLowerCase());
    expect(lower.filter((p) => p === 'mykey')).toHaveLength(1);
    expect(lower.filter((p) => p === 'access_token')).toHaveLength(1);
  });

  it('SW: ページの要求の ?myKey=SECRET2 が Entry のキーに入らない', async () => {
    const h = createSwHarness();
    h.fetch.mockImplementation(async () => png());
    const reg = await h.post('/v2/register', {
      kind: 'raster', url: 'https://t.example/{z}/{x}/{y}.png', credentials: { query: { myKey: 'SECRET2' } },
    });
    expect((await reg!.json()).ok).toBe(true);
    await h.flushRoutes();
    const res = await h.dispatch('https://t.example/3/1/2.png?myKey=SECRET2');
    expect(res!.headers.get('x-weiwudi-status')).toBe('miss');
    const keys = await allKeys(h.factory);
    expect(keys.filter((k) => k.startsWith('E:'))).toHaveLength(1);
    expect(keys.some((k) => k.includes('SECRET2'))).toBe(false);
  });
});

describe('L-1: 合流でテンプレートの和を合成した credentialParams で正規化し直す', () => {
  it('B が宣言しなくても、A が宣言した foo の値は Resource の templates と A の resources に出ない', async () => {
    const h = createSwHarness();
    h.fetch.mockImplementation(async () => png());
    const a = await h.post('/v2/register', {
      kind: 'raster', id: 'A', url: 'https://t.example/{z}/{x}/{y}.png?foo=SECRET3', credentialParams: ['foo'],
    });
    expect((await a!.json()).ok).toBe(true);
    const b = await h.post('/v2/register', { kind: 'raster', id: 'B', url: 'https://t.example/{z}/{x}/{y}.png?foo=SECRET3' });
    const bj = await b!.json();
    expect(bj.ok).toBe(true);
    expect(JSON.stringify(bj.result.resources)).not.toContain('SECRET3');
    const ra = await (await h.post('/v2/source', { id: 'A' }))!.json();
    expect(ra.result.resources).toHaveLength(1);
    expect(JSON.stringify(ra.result.resources)).not.toContain('SECRET3');
    const keys = await allKeys(h.factory);
    expect(keys.filter((k) => k.startsWith('T:') && k.includes('SECRET3'))).toEqual([]);
  });
});

describe('L-2: パスの区画の sk. は credential-rejected', () => {
  const codeOf = (url: string): string | undefined => {
    try {
      normalizeSpec({ kind: 'raster', url });
      return undefined;
    } catch (e) {
      return e instanceof WeiwudiError ? e.code : 'thrown';
    }
  };
  it.each([
    ['生の形', 'https://t.example/sk.abcdef/{z}/{x}/{y}.png'],
    ['大文字', 'https://t.example/SK.abcdef/{z}/{x}/{y}.png'],
    ['decode した形', 'https://t.example/%73k.abcdef/{z}/{x}/{y}.png'],
    ['末尾の区画', 'https://t.example/{z}/{x}/{y}/sk.abc'],
  ])('%s', (_l, url) => {
    expect(codeOf(url)).toBe('credential-rejected');
  });
  it('区画の途中の sk. は拒否しない（disk.png など）', () => {
    expect(codeOf('https://t.example/disk.tiles/{z}/{x}/{y}.png')).toBeUndefined();
  });
});
