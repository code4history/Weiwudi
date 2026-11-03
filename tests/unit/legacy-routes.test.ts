// 旧 API のルートの登録と、install・activate のリスナ（m2-t5。weiwudi-gw-logic.test.ts の :39〜:75 を移した）。
// 正規表現の試験はそのまま。「registerRoute を 1 回」は「旧 API のルートが 1 本」に直した（仕様 §13・§4.3）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSwHarness } from './sw-harness';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Weiwudi_Internal の初期化', () => {
  it('旧 API のルートは 1 本で、捕捉の正規表現は weiwudi.example.com だけに当たる', () => {
    const h = createSwHarness();
    const legacy = h.routes.filter((r) => r.capture instanceof RegExp && r.method === 'GET');
    expect(legacy).toHaveLength(1);
    expect(legacy[0].capture).toBe(h.capture);
    expect(h.method).toBe('GET');
    expect(h.capture.test('https://weiwudi.example.com/api/ping')).toBe(true);
    expect(h.capture.test('https://example.com/')).toBe(false);
  });

  it('捕捉の正規表現はホスト名の境界で止まり、似た名前のホストに当たらない', () => {
    const h = createSwHarness();
    expect(h.capture.test('https://weiwudi.example.com.evil.test/api/add')).toBe(false);
    expect(h.capture.test('https://weiwudiXexampleYcom/api/add')).toBe(false);
    expect(h.capture.test('https://weiwudi.example.com')).toBe(true);
    expect(h.capture.test('https://weiwudi.example.com?x=1')).toBe(true);
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

  it('/v2/ で始まるパスは旧 API へ渡さない。ping は control が答え、他は 404・Not Found（仕様 §3・計画 m2-t5・m2-t8）', async () => {
    const h = createSwHarness();
    expect((await (await h.dispatch('https://weiwudi.example.com/v2/ping'))!.json()).api).toBe(2);
    const res = await h.dispatch('https://weiwudi.example.com/v2/nope');
    expect(res?.status).toBe(404);
    expect(await res?.text()).toBe('Not Found');
    // /api/v2/… は旧 API の未知の API のまま
    expect(await (await h.request('/api/v2')).text()).toBe('Error: API v2 not found');
  });

  it('install・activate のほかにリスナを増やさず、Weiwudi_Internal の呼び出しで IndexedDB を開かない', async () => {
    const h = createSwHarness();
    const open = vi.spyOn(h.factory, 'open');
    expect(Object.keys(h.listeners).sort()).toEqual(['activate', 'install']);
    expect(open).not.toHaveBeenCalled();
    await h.request('/api/ping');
    expect(open).not.toHaveBeenCalled();
  });
});

// m2-t7: 照合ルートと門番を足した後も、旧 API のルートの形と経路は変わらない（仕様 §4.3）
describe('照合ルート・門番と旧 API のルート（m2-t7）', () => {
  it('旧 API の GET RegExp ルートはちょうど 1 本のまま。制御の POST（m2-t8）の後に、照合ルート（同期）と門番（microtask）が関数の捕捉で並ぶ', async () => {
    const h = createSwHarness();
    expect(h.routes).toHaveLength(3);
    await h.flushRoutes();
    expect(h.routes).toHaveLength(4);
    expect(h.routes[0].capture).toBe(h.capture);
    expect(h.routes[1].method).toBe('POST');
    expect(h.routes.slice(2).every((r) => typeof r.capture === 'function' && r.method === 'GET')).toBe(true);
    expect(h.routes.filter((r) => r.capture instanceof RegExp && r.method === 'GET')).toHaveLength(1);
  });

  it('疑似ホストの GET は門番より前の旧 API のルートが受け、照合表を読まない', async () => {
    const h = createSwHarness();
    const open = vi.spyOn(h.factory, 'open');
    await h.flushRoutes();
    expect(await (await h.dispatch('https://weiwudi.example.com/api/ping'))!.text()).toBe('Implemented');
    expect(open).not.toHaveBeenCalled();
  });

  it('旧 API の Range つきの要求のネットワーク失敗は、新 API の素通しと同じ形（404・offline-miss・network・expose）', async () => {
    const h = createSwHarness();
    await h.request(`/api/add?mapID=m&type=xyz&url=${encodeURIComponent('https://tile.example/{z}/{x}/{y}.png')}&width=1024&height=1024`);
    h.fetch.mockRejectedValue(new TypeError('down'));
    const res = await h.dispatch(new Request('https://weiwudi.example.com/api/cache/m/2/1/0', { headers: { range: 'bytes=0-1' } }));
    expect(res?.status).toBe(404);
    expect(res?.statusText).toBe('Not Found');
    expect(res?.headers.get('x-weiwudi-status')).toBe('offline-miss');
    expect(res?.headers.get('x-weiwudi-error')).toBe('network');
    expect(res?.headers.get('access-control-expose-headers')).toBe('x-weiwudi-status, x-weiwudi-error');
  });
});
