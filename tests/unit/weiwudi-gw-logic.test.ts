// src/weiwudi_gw_logic.ts のユニットテスト（Weiwudi#43・nov26-m1-t6）。
// Service Worker の環境は tests/unit/sw-harness.ts で差し替える。src/ は変えない。
// describe 名は設計書 §3.4 の表の「対象関数」に対応させている。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createSwHarness, tileResponse } from './sw-harness';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('前提: fake-indexeddb の Blob の往復', () => {
  it('Blob を put して get すると Blob のまま size も保たれる', async () => {
    const factory = new IDBFactory();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open('blob-roundtrip');
      req.onupgradeneeded = () => req.result.createObjectStore('s', { keyPath: 'k' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['s'], 'readwrite');
      tx.objectStore('s').put({ k: 'a', blob: new Blob([new Uint8Array(10)]) });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const got = await new Promise<{ k: string; blob: Blob }>((resolve, reject) => {
      const tx = db.transaction(['s'], 'readonly');
      const req = tx.objectStore('s').get('a');
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
    expect(got.blob).toBeInstanceOf(Blob);
    expect(got.blob.size).toBe(10);
  });
});

describe('Weiwudi_Internal の初期化', () => {
  it('registerRoute を 1 回呼び、捕捉の正規表現は weiwudi.example.com だけに当たる', () => {
    const h = createSwHarness();
    expect(h.registerRoute).toHaveBeenCalledTimes(1);
    expect(h.method).toBe('GET');
    expect(h.capture.test('https://weiwudi.example.com/api/ping')).toBe(true);
    expect(h.capture.test('https://example.com/')).toBe(false);
  });

  it('install・activate のハンドラを登録し、install は skipWaiting を waitUntil に渡す', () => {
    const h = createSwHarness();
    expect(Object.keys(h.listeners).sort()).toEqual(['activate', 'install']);
    const sentinel = Promise.resolve('skipped');
    h.self.skipWaiting.mockReturnValueOnce(sentinel);
    const waitUntil = vi.fn();
    h.listeners.install[0]({ waitUntil });
    expect(h.self.skipWaiting).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledWith(sentinel);
  });

  it('activate は clients.claim を waitUntil に渡す', () => {
    const h = createSwHarness();
    const sentinel = Promise.resolve('claimed');
    h.self.clients.claim.mockReturnValueOnce(sentinel);
    const waitUntil = vi.fn();
    h.listeners.activate[0]({ waitUntil });
    expect(waitUntil).toHaveBeenCalledWith(sentinel);
  });
});

describe('handlerCb', () => {
  it('/api/ping → 200・Implemented', async () => {
    const h = createSwHarness();
    const res = await h.request('/api/ping');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Implemented');
  });

  it('/api/ でないパス → 404・Not Found', async () => {
    const h = createSwHarness();
    const res = await h.request('/foo');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
  });

  it('未知の API → Error: API nope not found', async () => {
    const h = createSwHarness();
    const res = await h.request('/api/nope');
    expect(await res.text()).toBe('Error: API nope not found');
  });

  it('同名のクエリキーが 2 つ以上なら配列になる', async () => {
    const h = createSwHarness();
    const add = await h.request('/api/add?mapID=m&type=xyz&url=a&url=b&width=256&height=256');
    expect(add.status).toBe(200);
    const info = await (await h.request('/api/info?mapID=m')).json();
    expect(info.url).toEqual(['a', 'b']);
  });

  it('キーが 1 つなら文字列のまま', async () => {
    const h = createSwHarness();
    await h.request('/api/add?mapID=m&type=xyz&url=a&width=256&height=256');
    const info = await (await h.request('/api/info?mapID=m')).json();
    expect(info.url).toBe('a');
  });
});


describe('checkAttributes', () => {
  it('/api/info で mapID が無い → mapID が欠けている', async () => {
    const h = createSwHarness();
    expect(await (await h.request('/api/info')).text()).toBe('Error: Attribute "mapID" is missing');
  });

  it('add の検査の順は mapID・type・url', async () => {
    const h = createSwHarness();
    expect(await (await h.request('/api/add')).text()).toBe('Error: Attribute "mapID" is missing');
    expect(await (await h.request('/api/add?mapID=m')).text()).toBe('Error: Attribute "type" is missing');
    expect(await (await h.request('/api/add?mapID=m&type=xyz')).text()).toBe('Error: Attribute "url" is missing');
  });
});

describe('add xyz', () => {
  it('width=1000・height=500（tileSize 既定 256）→ maxZoom 2・maxX 3・maxY 1・totalTile 11', async () => {
    const h = createSwHarness();
    const res = await h.request('/api/add?mapID=m&type=xyz&url=u&width=1000&height=500');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const json = await res.json();
    expect(json).toMatchObject({
      mapID: 'm',
      tileSize: 256,
      width: 1000,
      height: 500,
      maxZoom: 2,
      minZoom: 0,
      minX: 0,
      minY: 0,
      maxX: 3,
      maxY: 1,
      totalTile: 11,
    });
  });

  it('xyz で width・height が無い → 欠けている属性のエラー', async () => {
    const h = createSwHarness();
    expect(await (await h.request('/api/add?mapID=m&type=xyz&url=u&height=500')).text())
      .toBe('Error: Attribute "width" is missing');
  });

  it('未知の type → Error: Unknown "type" value', async () => {
    const h = createSwHarness();
    expect(await (await h.request('/api/add?mapID=m&type=zzz&url=u')).text())
      .toBe('Error: Unknown "type" value');
  });
});

const WMTS_ADD = '/api/add?mapID=w&type=wmts&url=u&minLng=139.7&maxLng=139.8&minLat=35.6&maxLat=35.7&minZoom=10&maxZoom=12';

describe('add wmts', () => {
  it('経緯度の範囲から z12 のタイル範囲と totalTile を求める', async () => {
    const h = createSwHarness();
    const json = await (await h.request(WMTS_ADD)).json();
    expect(json).toMatchObject({
      minZoom: 10,
      maxZoom: 12,
      minX: 3637,
      maxX: 3638,
      minY: 1612,
      maxY: 1614,
      totalTile: 11,
    });
  });
});

describe('add cacheMaxBytes', () => {
  it.each(['12a', '-1', '1.5'])('wmts で cacheMaxBytes=%s → エラーになり設定を保存しない', async (raw) => {
    const h = createSwHarness();
    const res = await h.request(`${WMTS_ADD}&cacheMaxBytes=${encodeURIComponent(raw)}`);
    expect(await res.text()).toBe('Error: Attribute "cacheMaxBytes" is not a valid non-negative integer');
    expect(await (await h.request('/api/info?mapID=w')).text()).toBe('Error: MapID "w" not found');
  });

  it('wmts で cacheMaxBytes=1024 → 数の 1024 として保存する', async () => {
    const h = createSwHarness();
    const json = await (await h.request(`${WMTS_ADD}&cacheMaxBytes=1024`)).json();
    expect(json.cacheMaxBytes).toBe(1024);
    const info = await (await h.request('/api/info?mapID=w')).json();
    expect(info.cacheMaxBytes).toBe(1024);
  });
});

describe('info', () => {
  it('登録した地図 → 200・application/json・登録値', async () => {
    const h = createSwHarness();
    await h.request('/api/add?mapID=m&type=xyz&url=u&width=1000&height=500&cacheTtl=1000');
    const res = await h.request('/api/info?mapID=m');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toMatchObject({ mapID: 'm', type: 'xyz', url: 'u', cacheTtl: 1000, totalTile: 11 });
  });

  it('未登録 → Error: MapID "x" not found', async () => {
    const h = createSwHarness();
    expect(await (await h.request('/api/info?mapID=x')).text()).toBe('Error: MapID "x" not found');
  });
});

// 1024×1024（tileSize 256）→ maxZoom 2・x/y は 0〜3・totalTile 21（1 + 4 + 16）
const addTileMap = (h: ReturnType<typeof createSwHarness>, template: string, extra = '') =>
  h.request(`/api/add?mapID=m&type=xyz&url=${encodeURIComponent(template)}&width=1024&height=1024${extra}`);

const T0 = 1_760_000_000_000;

describe('getImage・extractTemplate', () => {
  it('{-y} を 2^z − y − 1 に展開して取得し、応答の本文と content-type をそのまま返す', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{-y}.png');
    h.fetch.mockImplementation(async () => new Response('tile-body', { headers: { 'content-type': 'image/webp' } }));
    const res = await h.request('/api/cache/m/2/1/0');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledWith('https://tile.example/2/1/3.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(await res.text()).toBe('tile-body');
  });

  it('{z}・{x}・{y} をそのまま展開する', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    h.fetch.mockImplementation(async () => tileResponse(4));
    await h.request('/api/cache/m/2/3/1');
    expect(h.fetch).toHaveBeenCalledWith('https://tile.example/2/3/1.png');
  });

  it('同じタイルの 2 回目はキャッシュから返し、cacheTtl を越えると取り直す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png', '&cacheTtl=1000');
    let n = 0;
    h.fetch.mockImplementation(async () => new Response(`body-${++n}`, { headers: { 'content-type': 'image/png' } }));

    expect(await (await h.request('/api/cache/m/2/1/0')).text()).toBe('body-1');
    expect(h.fetch).toHaveBeenCalledTimes(1);

    const cached = await h.request('/api/cache/m/2/1/0');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(cached.headers.get('content-type')).toBe('image/png');
    expect(await cached.text()).toBe('body-1');

    // ちょうど cacheTtl ではまだ有効（判定は「越えたら」）
    vi.setSystemTime(T0 + 1000);
    expect(await (await h.request('/api/cache/m/2/1/0')).text()).toBe('body-1');
    expect(h.fetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 1001);
    expect(await (await h.request('/api/cache/m/2/1/0')).text()).toBe('body-2');
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('未登録の地図 → Error: MapID not found', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    expect(await (await h.request('/api/cache/zz/0/0/0')).text()).toBe('Error: MapID "zz" not found');
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe('getImage の範囲外', () => {
  it('maxZoom を越える z → 404', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    const res = await h.request('/api/cache/m/3/0/0');
    expect(res.status).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('範囲外の x → 200・image/png・PNG の署名で始まる透明タイル（b64toBlob）', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    const res = await h.request('/api/cache/m/2/4/0');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe('getImage の取得失敗', () => {
  it('fetch が例外でキャッシュが無い → 404', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    h.fetch.mockRejectedValue(new TypeError('network down'));
    const res = await h.request('/api/cache/m/2/1/0');
    expect(res.status).toBe(404);
  });

  it('fetch が例外でキャッシュが有る（期限切れ）→ キャッシュの本文', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png', '&cacheTtl=1000');
    h.fetch.mockImplementationOnce(async () => new Response('old', { headers: { 'content-type': 'image/png' } }));
    await h.request('/api/cache/m/2/1/0');
    vi.setSystemTime(T0 + 5000);
    h.fetch.mockRejectedValueOnce(new TypeError('network down'));
    const res = await h.request('/api/cache/m/2/1/0');
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toBe('old');
  });

  it('fetch が ok: false（503）でキャッシュが無い → その status を返す', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    h.fetch.mockImplementation(async () => new Response('busy', { status: 503, statusText: 'Service Unavailable' }));
    const res = await h.request('/api/cache/m/2/1/0');
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('busy');
  });

  it('fetch が ok: false（503）でキャッシュが有る → キャッシュの本文', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png', '&cacheTtl=1000');
    h.fetch.mockImplementationOnce(async () => new Response('old', { headers: { 'content-type': 'image/png' } }));
    await h.request('/api/cache/m/2/1/0');
    vi.setSystemTime(T0 + 5000);
    h.fetch.mockImplementationOnce(async () => new Response('busy', { status: 503 }));
    const res = await h.request('/api/cache/m/2/1/0');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('old');
  });
});

const statsOf = async (h: ReturnType<typeof createSwHarness>, mapID = 'm') =>
  (await h.request(`/api/stats?mapID=${mapID}`)).json();

describe('putItemWithEviction', () => {
  it('cacheMaxBytes=20 に 10 バイトのタイルを 3 つ → 最も古い 1 つが消え count 2', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png', '&cacheMaxBytes=20');
    h.fetch.mockImplementation(async () => tileResponse(10));
    for (const [i, x] of [0, 1, 2].entries()) {
      vi.setSystemTime(T0 + i + 1);
      await h.request(`/api/cache/m/2/${x}/0`);
    }
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(await statsOf(h)).toMatchObject({ count: 2, size: 20 });

    // 最も古い 2/0/0 は消えている ∴ 取り直す。新しい 2/2/0 は残っている ∴ 取り直さない
    vi.setSystemTime(T0 + 10);
    await h.request('/api/cache/m/2/2/0');
    expect(h.fetch).toHaveBeenCalledTimes(3);
    await h.request('/api/cache/m/2/0/0');
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });

  it('上限より大きい 21 バイトのタイル → 応答は返るが保存しない（count は増えない）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png', '&cacheMaxBytes=20');
    h.fetch.mockImplementation(async () => tileResponse(10));
    vi.setSystemTime(T0 + 1);
    await h.request('/api/cache/m/2/0/0');
    vi.setSystemTime(T0 + 2);
    await h.request('/api/cache/m/2/1/0');
    expect(await statsOf(h)).toMatchObject({ count: 2, size: 20 });

    h.fetch.mockImplementation(async () => tileResponse(21));
    vi.setSystemTime(T0 + 3);
    const res = await h.request('/api/cache/m/2/2/0');
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(21);
    expect(await statsOf(h)).toMatchObject({ count: 2, size: 20 });
  });
});

describe('countDB・stats', () => {
  it('2 タイルの後 → count 2・size は合計バイト・total は totalTile・percent は floor(count/total*100)', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    h.fetch.mockImplementationOnce(async () => tileResponse(7));
    await h.request('/api/cache/m/2/0/0');
    h.fetch.mockImplementationOnce(async () => tileResponse(13));
    await h.request('/api/cache/m/2/1/0');
    const res = await h.request('/api/stats?mapID=m');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ count: 2, size: 20, total: 21, percent: Math.floor((2 / 21) * 100) });
  });

  it('別の地図だけが登録済みで未登録の mapID → Error: MapID not found', async () => {
    // 地図を 1 つも登録していない DB では stats が開く 'Weiwudi' に mapSetting の store が無い
    // （708 行は getDB('Weiwudi') を table・key なしで呼ぶ）。その入力は一覧に入れない（task-state に記録）
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    expect(await (await h.request('/api/stats?mapID=x')).text()).toBe('Error: MapID "x" not found');
  });
});

describe('clean', () => {
  it('Cleaned: m を返し、その後 count 0', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    h.fetch.mockImplementation(async () => tileResponse(5));
    await h.request('/api/cache/m/2/0/0');
    expect((await statsOf(h)).count).toBe(1);
    expect(await (await h.request('/api/clean?mapID=m')).text()).toBe('Cleaned: m');
    expect((await statsOf(h)).count).toBe(0);
  });
});

describe('delete', () => {
  it('Deleted: m を返し、その後 info は not found', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    expect(await (await h.request('/api/delete?mapID=m')).text()).toBe('Deleted: m');
    expect(await (await h.request('/api/info?mapID=m')).text()).toBe('Error: MapID "m" not found');
  });
});

describe('cancel', () => {
  it('取得中でない地図 → Error: There are no fetching process of m', async () => {
    const h = createSwHarness();
    expect(await (await h.request('/api/cancel?mapID=m')).text()).toBe('Error: There are no fetching process of m');
  });
});

describe('cache', () => {
  it('座標が 3 つ揃わない → Error: "cache" api needs mapID, zoom, x, y settings', async () => {
    const h = createSwHarness();
    expect(await (await h.request('/api/cache/m/1/2')).text())
      .toBe('Error: "cache" api needs mapID, zoom, x, y settings');
  });
});

describe('fetchAll の入口', () => {
  it('client が無い（FetchEvent でない呼び出し）→ 何もせず 404', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    const res = await h.request('/api/fetchAll?mapID=m');
    expect(res.status).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
