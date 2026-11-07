// 保存の失敗と x-weiwudi-error・fetchAll の errors と stop の code（m2-t5。weiwudi-gw-logic.test.ts の :597〜:865 を移した）。
// 入出力の expect は変えない。変えてよいのは仕掛け（失敗させる要求の種類と expect(spy) の回数）だけ（計画「試験の振り分け」）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSwHarness, tileResponse } from './sw-harness';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 1024×1024（tileSize 256）→ maxZoom 2・x/y は 0〜3・totalTile 21（1 + 4 + 16）
const addTileMap = (h: ReturnType<typeof createSwHarness>, template: string, extra = '') =>
  h.request(`/api/add?mapID=m&type=xyz&url=${encodeURIComponent(template)}&width=1024&height=1024${extra}`);

const T0 = 1_760_000_000_000;

// ---- #33: タイルの応答の x-weiwudi-error と fetchAll の errors（追記のみ） ----
// 既存の行を変えないため、import はここに足す（import 宣言は巻き上げられる）
import { IDBObjectStore } from 'fake-indexeddb';

// put の元の呼び出しの成功イベントの後に、tx.error を指定の例外にして abort する（実物の容量超過と同じ順）。
// 成功より先に abort すると req.onerror が AbortError で走り、別の経路になる
const abortPutAfterSuccess = (name: string) => {
  const original = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const req = original.apply(this, args);
    const tx = this.transaction;
    req.addEventListener('success', () => {
      (tx as unknown as { error: DOMException }).error = new DOMException('simulated', name);
      tx.abort();
    });
    return req;
  });
};

// m4-t6（R16）: 容量超過は全体の 10% を退避して 1 回だけ再試行する。保存の 1 回ごとに entries の put は 1 回なので、
// entries の put だけを times 回まで abort する（再試行の put も数える）。他のストアの put はそのまま通す
const abortEntryPutsAfterSuccess = (name: string, times: number) => {
  const original = IDBObjectStore.prototype.put;
  let left = times;
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const req = original.apply(this, args);
    if (this.name !== 'entries' || left <= 0) return req;
    left--;
    const tx = this.transaction;
    req.addEventListener('success', () => {
      (tx as unknown as { error: DOMException }).error = new DOMException('simulated', name);
      tx.abort();
    });
    return req;
  });
};

/** entries への put の回数（保存を試みた回数） */
const entryPuts = (spy: { mock: { contexts: unknown[] } }) =>
  spy.mock.contexts.filter((c) => (c as IDBObjectStore).name === 'entries').length;

describe('getImage の x-weiwudi-error（#33）', () => {
  it('fetch が例外で保存が無い → 404・network', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    h.fetch.mockRejectedValue(new TypeError('network down'));
    const res = await h.request('/api/cache/m/2/1/0');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-weiwudi-error')).toBe('network');
  });

  it('fetch が例外で保存が有る → 200・古い本体・network（保存の headers は書き換えない）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png', '&cacheTtl=1000');
    h.fetch.mockImplementationOnce(async () => new Response('old', { headers: { 'content-type': 'image/png' } }));
    await h.request('/api/cache/m/2/1/0');
    vi.setSystemTime(T0 + 5000);
    h.fetch.mockRejectedValueOnce(new TypeError('network down'));
    const res = await h.request('/api/cache/m/2/1/0');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('old');
    expect(res.headers.get('x-weiwudi-error')).toBe('network');
    // 保存のまま期限切れの経路でもう一度失敗させても、前回のヘッダは持ち越さず、保存の headers も汚れていない
    h.fetch.mockImplementationOnce(async () => new Response('busy', { status: 503 }));
    const again = await h.request('/api/cache/m/2/1/0');
    expect(await again.text()).toBe('old');
    expect(again.headers.get('x-weiwudi-error')).toBe('upstream');
    expect(again.headers.get('content-type')).toBe('image/png');
  });

  it('上流が 500 で保存が無い → 500・upstream', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    h.fetch.mockImplementation(async () => new Response('boom', { status: 500 }));
    const res = await h.request('/api/cache/m/2/1/0');
    expect(res.status).toBe(500);
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
  });

  it('上流が 503 で保存が有る → 200・古い本体・upstream', async () => {
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
    expect(res.headers.get('x-weiwudi-error')).toBe('upstream');
  });

  it('保存の abort が QuotaExceededError → 200・本体はそのまま・quota・保存されない', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    h.fetch.mockImplementation(async () => new Response('tile', { headers: { 'content-type': 'image/png' } }));
    // m4-t6: abort が 2 回続く形（再試行も失敗する）。結果の quota は変わらない（R16・m2 R15）
    const spy = abortEntryPutsAfterSuccess('QuotaExceededError', 2);
    try {
      const res = await h.request('/api/cache/m/2/1/0');
      expect(entryPuts(spy)).toBe(2);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('tile');
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('x-weiwudi-error')).toBe('quota');
    } finally {
      spy.mockRestore();
    }
    expect(await (await h.request('/api/stats?mapID=m')).json()).toMatchObject({ count: 0 });
  });

  it('保存の abort（QuotaExceededError）が 1 回なら、全体の 10% を退避した再試行で保存される（m4-t6・R16）', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    h.fetch.mockImplementation(async () => tileResponse(10));
    // 固定でない 10 byte を 2 枚置く（10% は ceil(20 × 0.1) = 2 byte で、古い 1 枚が消える）
    await h.request('/api/cache/m/2/0/0');
    await h.request('/api/cache/m/2/0/1');
    const spy = abortEntryPutsAfterSuccess('QuotaExceededError', 1);
    try {
      const res = await h.request('/api/cache/m/2/1/0');
      expect(entryPuts(spy)).toBe(2);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-weiwudi-error')).toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(await (await h.request('/api/stats?mapID=m')).json()).toMatchObject({ count: 2, size: 20 });
  });

  it('保存の abort がそれ以外の名前 → 200・storage', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    h.fetch.mockImplementation(async () => new Response('tile', { headers: { 'content-type': 'image/png' } }));
    const spy = abortPutAfterSuccess('UnknownError');
    try {
      const res = await h.request('/api/cache/m/2/1/0');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('tile');
      expect(res.headers.get('x-weiwudi-error')).toBe('storage');
    } finally {
      spy.mockRestore();
    }
  });

  it('保存できた取得には x-weiwudi-error が付かない', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    h.fetch.mockImplementation(async () => tileResponse(4));
    const res = await h.request('/api/cache/m/2/1/0');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weiwudi-error')).toBeNull();
  });
});

describe('fetchAll の errors（#33）', () => {
  it('finish に errors が入り、種類ごとの数を数える', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    h.fetch.mockImplementation(async (url: string) => {
      if (url === 'https://tile.example/2/1/1.png') throw new TypeError('network down');
      if (url === 'https://tile.example/2/2/2.png') return new Response('boom', { status: 500 });
      return tileResponse(4);
    });
    const client = { id: 'client-1', postMessage: vi.fn() };
    h.self.clients.get.mockResolvedValue(client);
    await h.requestFromClient('/api/fetchAll?mapID=m', client);
    await vi.waitFor(() => {
      expect(client.postMessage.mock.calls.some(([m]) => m.type === 'finish')).toBe(true);
    });
    const finish = client.postMessage.mock.calls.map(([m]) => m).find((m) => m.type === 'finish');
    expect(finish).toMatchObject({ error: 2, errors: { network: 1, upstream: 1, quota: 0, storage: 0 } });
    const proceed = client.postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === 'proceed');
    expect(proceed.length).toBeGreaterThan(0);
    expect(proceed[proceed.length - 1]).toMatchObject({ error: 2, errors: { network: 1, upstream: 1, quota: 0, storage: 0 } });
  });
});

// ---- #33 レビュー: 保存の失敗が Event ではなく例外で届くこと・stop の code（追記のみ） ----

// put・delete の要求を、指定の名前の例外で失敗させる（m2-t5 で仕掛けを替えた）。
// store.ts は個々の put・delete の要求に onerror を置かず、要求の失敗は tx の abort で受ける。偽の要求を返す旧の仕掛けは
// tx に届かないので、要求を出す呼び出しそのものを DOMException で失敗させる（store は tx を abort してその例外で reject する）
const failRequest = (method: 'put' | 'delete', name: string) =>
  vi.spyOn(IDBObjectStore.prototype, method).mockImplementationOnce(function () {
    throw new DOMException('simulated', name);
  });

// m4-t6: entries の put だけを times 回まで同期の例外で失敗させる（再試行の put も数える。R16）
const failEntryPut = (name: string, times: number) => {
  const original = IDBObjectStore.prototype.put;
  let left = times;
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'entries' && left > 0) {
      left--;
      throw new DOMException('simulated', name);
    }
    return original.apply(this, args);
  });
};

describe('保存の失敗の分類（#33 レビュー）', () => {
  it('putItem: put の要求の失敗（QuotaExceededError）→ 200・quota', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
    h.fetch.mockImplementation(async () => tileResponse(4));
    // m4-t6: 再試行の put も失敗させる（結果の quota は変わらない。R16）
    const spy = failEntryPut('QuotaExceededError', 2);
    try {
      const res = await h.request('/api/cache/m/2/1/0');
      expect(entryPuts(spy)).toBe(2);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-weiwudi-error')).toBe('quota');
    } finally {
      spy.mockRestore();
    }
  });

  it('putItemWithEviction: put の要求の失敗（QuotaExceededError）→ 200・quota', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png', '&cacheMaxBytes=100');
    h.fetch.mockImplementation(async () => tileResponse(4));
    // m4-t6: 再試行の put も失敗させる（結果の quota は変わらない。R16）
    const spy = failEntryPut('QuotaExceededError', 2);
    try {
      const res = await h.request('/api/cache/m/2/1/0');
      expect(entryPuts(spy)).toBe(2);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-weiwudi-error')).toBe('quota');
    } finally {
      spy.mockRestore();
    }
  });

  it('putItemWithEviction: 退避の delete の要求の失敗（UnknownError）→ 200・storage', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png', '&cacheMaxBytes=20');
    h.fetch.mockImplementation(async () => tileResponse(10));
    await h.request('/api/cache/m/2/0/0');
    await h.request('/api/cache/m/2/0/1');
    const spy = failRequest('delete', 'UnknownError');
    try {
      const res = await h.request('/api/cache/m/2/0/2');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-weiwudi-error')).toBe('storage');
    } finally {
      spy.mockRestore();
    }
  });

  it('putItemWithEviction: transaction の abort（tx.error が QuotaExceededError）→ 200・quota', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png', '&cacheMaxBytes=100');
    h.fetch.mockImplementation(async () => tileResponse(4));
    // m4-t6: abort が 2 回続く形（再試行も失敗する。R16）
    const spy = abortEntryPutsAfterSuccess('QuotaExceededError', 2);
    try {
      const res = await h.request('/api/cache/m/2/1/0');
      expect(entryPuts(spy)).toBe(2);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-weiwudi-error')).toBe('quota');
    } finally {
      spy.mockRestore();
    }
    expect(await (await h.request('/api/stats?mapID=m')).json()).toMatchObject({ count: 0 });
  });

  it('putItemWithEviction: transaction の abort（それ以外の名前）→ 200・storage', async () => {
    const h = createSwHarness();
    await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png', '&cacheMaxBytes=100');
    h.fetch.mockImplementation(async () => tileResponse(4));
    const spy = abortPutAfterSuccess('UnknownError');
    try {
      const res = await h.request('/api/cache/m/2/1/0');
      expect(res.headers.get('x-weiwudi-error')).toBe('storage');
    } finally {
      spy.mockRestore();
    }
  });

  it('add の保存の abort（QuotaExceededError）→ Error: QuotaExceededError で始まる文（Event ではない）', async () => {
    const h = createSwHarness();
    const spy = abortPutAfterSuccess('QuotaExceededError');
    try {
      const text = await (await h.request('/api/add?mapID=m&type=xyz&url=u&width=256&height=256')).text();
      expect(text).toMatch(/^Error: QuotaExceededError/);
      expect(text).not.toContain('[object Event]');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('fetchAll の stop の code（#33 レビュー）', () => {
  it('取得の途中の例外を WeiwudiError.from で分類し、stop に code を入れる', async () => {
    const cases: [unknown, string][] = [
      ['Error: MapID "x" not found', 'map-not-found'],
      [new DOMException('full', 'QuotaExceededError'), 'quota'],
      [new TypeError('boom'), 'internal'],
    ];
    for (const [thrown, code] of cases) {
      const h = createSwHarness();
      await addTileMap(h, 'https://tile.example/{z}/{x}/{y}.png');
      h.fetch.mockImplementation(async () => tileResponse(4));
      const client = { id: 'client-1', postMessage: vi.fn() };
      // 入口の client 取得（requestFromClient の Once）の後、取得中の生存確認で例外にする
      h.self.clients.get.mockImplementation(() => Promise.reject(thrown));
      await h.requestFromClient('/api/fetchAll?mapID=m', client);
      await vi.waitFor(() => {
        expect(client.postMessage.mock.calls.some(([m]) => m.type === 'stop')).toBe(true);
      });
      const stop = client.postMessage.mock.calls.map(([m]) => m).find((m) => m.type === 'stop');
      expect(stop.code).toBe(code);
      expect(stop.reason).toBe(thrown);
      vi.unstubAllGlobals();
    }
  });
});
