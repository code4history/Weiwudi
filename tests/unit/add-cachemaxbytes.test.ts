// add API の cacheMaxBytes の検査（Weiwudi#44・nov26-m1-t8）。
// xyz でも wmts と同じく、無効な cacheMaxBytes はエラーになり設定を保存しない（#29 の契約）。
// Service Worker の環境は t6 の tests/unit/sw-harness.ts で差し替える（harness は変えない）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSwHarness, tileResponse } from './sw-harness';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const TEMPLATE = encodeURIComponent('https://tile.example/{z}/{x}/{y}.png');
const ERROR_TEXT = 'Error: Attribute "cacheMaxBytes" is not a valid non-negative integer';

const TYPE_PARAMS: Record<'xyz' | 'wmts', string> = {
  xyz: '&width=512&height=512',
  wmts: '&minLng=139.7&maxLng=139.8&minLat=35.6&maxLat=35.7&minZoom=10&maxZoom=12',
};

const addPath = (mapID: string, type: 'xyz' | 'wmts', extra = '') =>
  `/api/add?mapID=${mapID}&type=${type}&url=${TEMPLATE}${TYPE_PARAMS[type]}${extra}`;

// info を引く前に DB と mapSetting の store を用意するため、正系の地図を 1 つ登録しておく
const setUp = async () => {
  const h = createSwHarness();
  const res = await h.request(addPath('base', 'xyz'));
  expect(res.status).toBe(200);
  return h;
};

describe('#44 add の無効な cacheMaxBytes（xyz・wmts）', () => {
  it.each([
    ['xyz', '-1'],
    ['xyz', '1.5'],
    ['xyz', '12a'],
    ['wmts', '-1'],
    ['wmts', '1.5'],
    ['wmts', '12a'],
  ] as const)('%s で cacheMaxBytes=%s → エラーになり設定を保存しない', async (type, raw) => {
    const h = await setUp();
    const mapID = `bad-${type}`;
    const res = await h.request(addPath(mapID, type, `&cacheMaxBytes=${encodeURIComponent(raw)}`));
    expect(await res.text()).toBe(ERROR_TEXT);
    expect(await (await h.request(`/api/info?mapID=${mapID}`)).text()).toBe(`Error: MapID "${mapID}" not found`);
  });

  it('xyz で cacheMaxBytes=1024 → 200・数の 1024 として保存する', async () => {
    const h = await setUp();
    const res = await h.request(addPath('ok', 'xyz', '&cacheMaxBytes=1024'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cacheMaxBytes).toBe(1024);
    const info = await (await h.request('/api/info?mapID=ok')).json();
    expect(info).toMatchObject({ mapID: 'ok', type: 'xyz', cacheMaxBytes: 1024 });
  });

  it('xyz で cacheMaxBytes を指定しない → 200・cacheMaxBytes を持たずに保存する', async () => {
    const h = await setUp();
    const res = await h.request(addPath('none', 'xyz'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).not.toHaveProperty('cacheMaxBytes');
    const info = await (await h.request('/api/info?mapID=none')).json();
    expect(info).toMatchObject({ mapID: 'none', type: 'xyz' });
    expect(info).not.toHaveProperty('cacheMaxBytes');
  });
});

// t6 の実装レビューの申し送り（MIN-1・M31）。cacheMaxBytes が効く保存の側の検出力の穴を埋める
const T0 = 1_760_000_000_000;
// 512 では maxZoom=1 になり z=2 が範囲外になる ∴ 1024（maxZoom=2）で登録する
const addLruMap = (extra: string) =>
  `/api/add?mapID=m&type=xyz&url=${TEMPLATE}&width=1024&height=1024${extra}`;

describe('#44 申し送り: cacheMaxBytes の LRU（t6 実装レビュー MIN-1・M31）', () => {
  it('古く取得したが最近読んだタイルは残り、読まれていないタイルが消える（hit で accessedAt を更新）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = createSwHarness();
    await h.request(addLruMap('&cacheMaxBytes=20'));
    h.fetch.mockImplementation(async () => tileResponse(10));
    vi.setSystemTime(T0 + 1);
    await h.request('/api/cache/m/2/0/0');
    vi.setSystemTime(T0 + 2);
    await h.request('/api/cache/m/2/1/0');
    expect(h.fetch).toHaveBeenCalledTimes(2);

    // 時刻 3 で 1 枚目を読む（hit・取り直さない）
    vi.setSystemTime(T0 + 3);
    await h.request('/api/cache/m/2/0/0');
    expect(h.fetch).toHaveBeenCalledTimes(2);

    // 時刻 4 で 3 枚目を取得 → 最も長く読まれていない 2 枚目が消える
    vi.setSystemTime(T0 + 4);
    await h.request('/api/cache/m/2/2/0');
    expect(h.fetch).toHaveBeenCalledTimes(3);

    vi.setSystemTime(T0 + 5);
    await h.request('/api/cache/m/2/0/0');
    expect(h.fetch).toHaveBeenCalledTimes(3);
    await h.request('/api/cache/m/2/1/0');
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });

  it('cacheMaxBytes=0 → 0 バイトのタイルでも保存しない（count 0・毎回取り直す）', async () => {
    // 10 バイト等では「上限を越えるので保存しない」と区別がつかない ∴ 0 バイトで「0 は保存しない」を見る
    const h = createSwHarness();
    await h.request(addLruMap('&cacheMaxBytes=0'));
    h.fetch.mockImplementation(async () => tileResponse(0));
    const res = await h.request('/api/cache/m/2/0/0');
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect(await (await h.request('/api/stats?mapID=m')).json()).toMatchObject({ count: 0, size: 0 });
    await h.request('/api/cache/m/2/0/0');
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});
