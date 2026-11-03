// 旧 API の既知の変化（仕様 §9）と、載せ替えで決めた旧 API の扱い（m2-t5・仕様 §13・§8・§11）。
// golden（legacy-transcript.test.ts）の筋書きに入れない手を、1 件ずつここで確かめる。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBIndex } from 'fake-indexeddb';
import { createSwHarness, tileResponse, SW_ORIGIN } from './sw-harness';
import { addPlugin } from '../../src/plugins';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const T0 = 1_760_000_000_000;
const TEMPLATE = 'https://tile.example/{z}/{x}/{y}.png';
const DROPPED = ['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie'];
const STATUSES = ['out-of-range', 'hit', 'miss', 'refresh', 'stale', 'upstream-error', 'offline-miss'];

type H = ReturnType<typeof createSwHarness>;
const addTileMap = (h: H, template = TEMPLATE, extra = '') =>
  h.request(`/api/add?mapID=m&type=xyz&url=${encodeURIComponent(template)}&width=1024&height=1024${extra}`);
const statsOf = async (h: H) => (await h.request('/api/stats?mapID=m')).json();

/** 落とす 4 ヘッダを持つ上流の応答 */
const withDropped = (body: string, init: ResponseInit = {}) => {
  const res = new Response(body, init);
  res.headers.set('content-type', 'image/png');
  res.headers.set('content-encoding', 'gzip');
  res.headers.set('content-length', '999');
  res.headers.set('transfer-encoding', 'chunked');
  res.headers.set('set-cookie', 'a=b');
  res.headers.set('x-keep', 'kept');
  return res;
};

describe('仕様 §9 の既知の変化', () => {
  it('差し込み口が受ける request.url は上流のタイルの URL（疑似ホストではない。第 2 回 S-5）', async () => {
    const h = createSwHarness();
    await addTileMap(h);
    const seen: string[] = [];
    addPlugin({
      async requestWillFetch({ request }) { seen.push(request.url); },
    });
    h.fetch.mockImplementation(async () => tileResponse(4));
    await h.request('/api/cache/m/2/1/0');
    expect(seen).toEqual(['https://tile.example/2/1/0.png']);
    // 差し込み口が要求を替えないときは fetch(URL の文字列) の 1 引数のまま（仕様 §4.5）
    expect(h.fetch.mock.calls).toEqual([['https://tile.example/2/1/0.png']]);
  });

  it('相対の url は差し込み口へ SW の場所で解決した URL を渡し、上流へは現行どおり相対の文字列で出す', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'tiles/{z}/{x}/{y}.png');
    const seen: string[] = [];
    addPlugin({ async requestWillFetch({ request }) { seen.push(request.url); } });
    h.fetch.mockImplementation(async () => tileResponse(4));
    await h.request('/api/cache/m/2/1/0');
    expect(seen).toEqual(['http://localhost:5173/tiles/2/1/0.png']);
    expect(h.fetch.mock.calls).toEqual([['tiles/2/1/0.png']]);
  });

  it('requestWillFetch が別の Request を返すと、fetch はその Request の 1 引数で呼ばれる（第 1 回 S8）', async () => {
    const h = createSwHarness();
    await addTileMap(h);
    addPlugin({
      async requestWillFetch({ request }) {
        return new Request(request, { headers: { 'x-api-key': 'k' } });
      },
    });
    h.fetch.mockImplementation(async () => tileResponse(4));
    await h.request('/api/cache/m/2/1/0');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const args = h.fetch.mock.calls[0];
    expect(args).toHaveLength(1);
    expect(args[0]).toBeInstanceOf(Request);
    expect((args[0] as Request).url).toBe('https://tile.example/2/1/0.png');
    expect((args[0] as Request).headers.get('x-api-key')).toBe('k');
  });

  it('未登録の地図の clean は map-not-found（stats と同じ文面）', async () => {
    const h = createSwHarness();
    expect(await (await h.request('/api/clean?mapID=x')).text()).toBe('Error: MapID "x" not found');
  });

  it('200 の text/html は保存せず、Entry が無ければ合成応答（upstream-error・upstream）', async () => {
    const h = createSwHarness();
    await addTileMap(h);
    h.fetch.mockImplementation(async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const res = await h.request('/api/cache/m/2/1/0');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>login</html>');
    expect(res.headers.get('x-weiwudi-status')).toBe('upstream-error');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    expect((await statsOf(h)).count).toBe(0);
  });

  it('200 の text/html は、Entry があれば古い本体を返す（stale・upstream）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const h = createSwHarness();
    await addTileMap(h, TEMPLATE, '&cacheTtl=1000');
    h.fetch.mockImplementationOnce(async () => new Response('old', { headers: { 'content-type': 'image/png' } }));
    await h.request('/api/cache/m/2/1/0');
    vi.setSystemTime(T0 + 5000);
    h.fetch.mockImplementationOnce(async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));
    const res = await h.request('/api/cache/m/2/1/0');
    expect(await res.text()).toBe('old');
    expect(res.headers.get('x-weiwudi-status')).toBe('stale');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
  });

  it('保存した応答から 4 ヘッダが落ち、他のヘッダは残る（miss と hit の両方）', async () => {
    const h = createSwHarness();
    await addTileMap(h);
    h.fetch.mockImplementation(async () => withDropped('tile'));
    const miss = await h.request('/api/cache/m/2/1/0');
    const hit = await h.request('/api/cache/m/2/1/0');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    for (const res of [miss, hit]) {
      for (const name of DROPPED) expect(res.headers.get(name)).toBeNull();
      expect(res.headers.get('x-keep')).toBe('kept');
      expect(await res.text()).toBe('tile');
    }
    expect(hit.headers.get('x-weiwudi-status')).toBe('hit');
  });

  it('合成した応答に x-weiwudi-status と access-control-expose-headers が付く（hit・miss・範囲外・失敗）', async () => {
    const h = createSwHarness();
    await addTileMap(h);
    h.fetch.mockImplementationOnce(async () => tileResponse(4));
    const seen: Record<string, string | null> = {};
    const check = async (label: string, path: string) => {
      const res = await h.request(path);
      seen[label] = res.headers.get('x-weiwudi-status');
      expect(STATUSES).toContain(seen[label]);
      expect(res.headers.get('access-control-expose-headers')).toBe('x-weiwudi-status, x-weiwudi-error');
    };
    await check('miss', '/api/cache/m/2/1/0');
    await check('hit', '/api/cache/m/2/1/0');
    await check('zoom', '/api/cache/m/3/0/0');
    await check('extent', '/api/cache/m/2/4/0');
    h.fetch.mockRejectedValueOnce(new TypeError('down'));
    await check('offline', '/api/cache/m/2/2/0');
    expect(seen).toEqual({ miss: 'miss', hit: 'hit', zoom: 'out-of-range', extent: 'out-of-range', offline: 'offline-miss' });
  });

  it('上流 500（4 ヘッダつき）で Entry が無いとき、4 ヘッダが残らず x-weiwudi-error: upstream が付く（第 4 回 S-1）', async () => {
    const h = createSwHarness();
    await addTileMap(h);
    h.fetch.mockImplementation(async () => withDropped('boom', { status: 500, statusText: 'Internal Server Error' }));
    const res = await h.request('/api/cache/m/2/1/0');
    expect(res.status).toBe(500);
    expect(res.statusText).toBe('Internal Server Error');
    expect(await res.text()).toBe('boom');
    for (const name of DROPPED) expect(res.headers.get(name)).toBeNull();
    expect(res.headers.get('x-keep')).toBe('kept');
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(res.headers.get('x-weiwudi-status')).toBe('upstream-error');
  });

  it('fetchAll のジョブは開始の FetchEvent の waitUntil に渡り、完了で解決する（第 1 回 S11）', async () => {
    const h = createSwHarness();
    await addTileMap(h);
    h.fetch.mockImplementation(async () => tileResponse(4));
    const client = { id: 'client-1', postMessage: vi.fn() };
    h.self.clients.get.mockResolvedValue(client);
    const res = await h.requestFromClient('/api/fetchAll?mapID=m', client);
    expect(await res.text()).toBe('Fetching task start: m');
    expect(h.waitUntilCalls).toHaveLength(1);
    await h.waitUntilCalls[0];
    const types = client.postMessage.mock.calls.map(([m]) => m.type);
    expect(types[types.length - 1]).toBe('finish');
    expect((await statsOf(h)).count).toBe(21);
  });
});

describe('保存の形（仕様 §5.1・§5.3・§13）', () => {
  it('Source と Resource の id は map:<mapID>、Entry のキーは map:<mapID>\\0<z>_<x>_<y>（tileKeySuffix）', async () => {
    const h = createSwHarness();
    await addTileMap(h);
    h.fetch.mockImplementation(async () => tileResponse(4));
    await h.request('/api/cache/m/2/1/3');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = h.factory.open('WeiwudiStore');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const all = (name: string) => new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction([name], 'readonly').objectStore(name).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(await all('sources')).toEqual(['map:m']);
    expect(await all('resources')).toEqual(['map:m']);
    expect(await all('entries')).toEqual(['map:m\u00002_1_3']);
    expect((await h.factory.databases()).map((d) => d.name)).toEqual(['WeiwudiStore']);
    db.close();
  });
});

describe('現行の癖を保つ（golden の筋書きでは区別できない手）', () => {
  it('fetchAll は保存済みのタイルを鮮度に関わらず飛ばす（期限切れでも取り直さない）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const h = createSwHarness();
    await addTileMap(h, TEMPLATE, '&cacheTtl=1000');
    h.fetch.mockImplementation(async () => tileResponse(4));
    await h.request('/api/cache/m/2/1/0');
    vi.setSystemTime(T0 + 5000);
    const client = { id: 'client-1', postMessage: vi.fn() };
    h.self.clients.get.mockResolvedValue(client);
    await h.requestFromClient('/api/fetchAll?mapID=m', client);
    await h.waitUntilCalls[0];
    expect(h.fetch).toHaveBeenCalledTimes(21);
    expect(h.fetch.mock.calls.filter(([u]) => u === 'https://tile.example/2/1/0.png')).toHaveLength(1);
  });

  it('数でない cacheTtl（parseInt の NaN）の地図は、保存したタイルが期限切れにならない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const h = createSwHarness();
    await addTileMap(h, TEMPLATE, '&cacheTtl=abc');
    h.fetch.mockImplementation(async () => tileResponse(4));
    await h.request('/api/cache/m/2/1/0');
    vi.setSystemTime(T0 + 365 * 86400000);
    const res = await h.request('/api/cache/m/2/1/0');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(res.headers.get('x-weiwudi-status')).toBe('hit');
  });
});

describe('載せ替えで決めた旧 API の扱い（Ruling）', () => {
  it('Range つきの要求は serve に入れず素通しする: 上流のタイルの URL へ Range を付けて出し、そのまま返し、保存しない（仕様 §11）', async () => {
    const h = createSwHarness();
    await addTileMap(h);
    h.fetch.mockImplementation(async () => new Response('ab', { status: 206, headers: { 'content-range': 'bytes 0-1/10' } }));
    const res = await h.dispatch(new Request(`${SW_ORIGIN}/api/cache/m/2/1/0`, { headers: { range: 'bytes=0-1' } }));
    expect(res?.status).toBe(206);
    expect(await res?.text()).toBe('ab');
    expect(res?.headers.get('x-weiwudi-status')).toBeNull();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const sent = h.fetch.mock.calls[0][0] as Request;
    expect(sent).toBeInstanceOf(Request);
    expect(sent.url).toBe('https://tile.example/2/1/0.png');
    expect(sent.headers.get('range')).toBe('bytes=0-1');
    expect((await statsOf(h)).count).toBe(0);
  });

  it('Range つきの要求でも未登録の地図は map-not-found（上流へ出さない）', async () => {
    const h = createSwHarness();
    const res = await h.dispatch(new Request(`${SW_ORIGIN}/api/cache/x/0/0/0`, { headers: { range: 'bytes=0-1' } }));
    expect(await res?.text()).toBe('Error: MapID "x" not found');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('Range つきの要求の上流がネットワーク失敗なら 404・Not Found', async () => {
    const h = createSwHarness();
    await addTileMap(h);
    h.fetch.mockRejectedValue(new TypeError('down'));
    const res = await h.dispatch(new Request(`${SW_ORIGIN}/api/cache/m/2/1/0`, { headers: { range: 'bytes=0-1' } }));
    expect(res?.status).toBe(404);
  });

  it('容量の判定の読み出し（evictScopesFor）が失敗したら、包括の Error: の文を返す（現行の読み出しの失敗と同じ経路）', async () => {
    const h = createSwHarness();
    await addTileMap(h, TEMPLATE, '&cacheMaxBytes=100');
    h.fetch.mockImplementation(async () => tileResponse(4));
    // 退避の範囲は resourcesBySource（sourceIds の索引の getAll）で読む。そこを失敗させる
    const original = IDBIndex.prototype.getAll;
    vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex['getAll']>) {
      if (this.name === 'sourceIds') throw new DOMException('simulated', 'UnknownError');
      return original.apply(this, args);
    });
    const res = await h.request('/api/cache/m/2/1/0');
    expect(await res.text()).toBe('Error: UnknownError: simulated');
  });

  it('fetchAll は取得した本体を読み切る（noOutput の空読み）', async () => {
    const h = createSwHarness();
    await addTileMap(h);
    h.fetch.mockImplementation(async () => tileResponse(4));
    const client = { id: 'client-1', postMessage: vi.fn() };
    h.self.clients.get.mockResolvedValue(client);
    const read = vi.spyOn(Response.prototype, 'arrayBuffer');
    await h.requestFromClient('/api/fetchAll?mapID=m', client);
    await h.waitUntilCalls[0];
    expect(read).toHaveBeenCalledTimes(21);
  });

  it('fetchAll の途中でページが無くなったら、何も送らずに止め、次の fetchAll を受け付ける', async () => {
    const h = createSwHarness();
    await addTileMap(h);
    h.fetch.mockImplementation(async () => tileResponse(4));
    const client = { id: 'client-1', postMessage: vi.fn() };
    await h.requestFromClient('/api/fetchAll?mapID=m', client); // 以後の clients.get は undefined
    await h.waitUntilCalls[0];
    expect(client.postMessage).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    h.self.clients.get.mockResolvedValue(client);
    expect(await (await h.requestFromClient('/api/fetchAll?mapID=m', client)).text()).toBe('Fetching task start: m');
    await h.waitUntilCalls[1];
  });

  it('fetchAll の errors は、取得中のページからの要求の失敗を数えない（ジョブの要求だけを数える）', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://gate.example/{z}/{x}/{y}.png');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    h.fetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://gate.example/')) {
        await gate;
        return tileResponse(4);
      }
      throw new TypeError('down');
    });
    const client = { id: 'client-1', postMessage: vi.fn() };
    h.self.clients.get.mockResolvedValue(client);
    await h.request('/api/add?mapID=other&type=xyz&url=https://down.example/{z}/{x}/{y}.png&width=256&height=256');
    await h.requestFromClient('/api/fetchAll?mapID=m', client);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(5));
    expect((await h.request('/api/cache/other/0/0/0')).headers.get('x-weiwudi-error')).toBe('network');
    release();
    await h.waitUntilCalls[0];
    const finish = client.postMessage.mock.calls.map(([m]) => m).find((m) => m.type === 'finish');
    expect(finish).toMatchObject({ error: 0, errors: { network: 0, upstream: 0, quota: 0, storage: 0 } });
  });
});
