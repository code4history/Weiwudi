// 旧 DB が残っている・壊れているときの旧 API（m2-t5。weiwudi-gw-logic.test.ts の :500〜:585 を仕様 §13 の表どおりに移した）。
// 載せ替えの後の旧 API は単一 DB WeiwudiStore だけを使い、旧 DB（Weiwudi・Weiwudi_<mapID>）を開かない。
// - :526・:535 → 旧 Weiwudi が store を持たなくても add・info が通る（版の検査は退役。旧 DB を修復しない）
// - :544 → 未登録の clean は map-not-found（仕様 §9）。add の後に保存できる
// - :575 → 旧 Weiwudi_x を開いたままの接続があっても delete は Deleted: x
// - :553・:563 → t2 の store.test.ts（別の接続）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createSwHarness, tileResponse } from './sw-harness';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ADD = '/api/add?mapID=x&type=xyz&url=https://tile.example/{z}/{x}/{y}.png&width=256&height=256';

/** 古い版が残した、store の無い version 1 の DB を持つ factory を作る */
const brokenFactory = async (dbname: string): Promise<{ factory: IDBFactory; connection: IDBDatabase }> => {
  const factory = new IDBFactory();
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(dbname);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return { factory, connection };
};

/** factory の上で新しい Service Worker を起動したのと同じ状態を作る */
const startSw = (factory: IDBFactory) => {
  const h = createSwHarness();
  vi.stubGlobal('indexedDB', factory);
  return h;
};

const versionOf = async (factory: IDBFactory, dbname: string): Promise<number> => {
  const list = await factory.databases();
  return list.find(d => d.name === dbname)?.version ?? 0;
};

describe('旧 DB が残っているときの旧 API（仕様 §13・§14.2）', () => {
  it('store の無い旧 Weiwudi が残っていても、add に成功し、地図の情報が読める（旧 DB には触らない）', async () => {
    const { factory, connection } = await brokenFactory('Weiwudi');
    connection.close();
    const h = startSw(factory);
    expect(await (await h.request(ADD)).json()).toMatchObject({ mapID: 'x' });
    expect(await (await h.request('/api/info?mapID=x')).json()).toMatchObject({ mapID: 'x' });
    expect(await versionOf(factory, 'Weiwudi')).toBe(1);
  });

  it('次の Service Worker でも、旧 Weiwudi に関わらず地図の情報が読める', async () => {
    const { factory, connection } = await brokenFactory('Weiwudi');
    connection.close();
    await startSw(factory).request(ADD);
    const next = startSw(factory);
    expect(await (await next.request('/api/info?mapID=x')).json()).toMatchObject({ mapID: 'x' });
  });

  it('旧 Weiwudi を閉じない接続が残っていても、add・info は止まらずに通る', async () => {
    const { factory, connection } = await brokenFactory('Weiwudi');
    const h = startSw(factory);
    expect(await (await h.request(ADD)).json()).toMatchObject({ mapID: 'x' });
    expect(await (await h.request('/api/info?mapID=x')).json()).toMatchObject({ mapID: 'x' });
    connection.close();
  });

  it('未登録の地図の clean は map-not-found で、その後の add でタイルを保存できる（仕様 §9）', async () => {
    const h = createSwHarness();
    expect(await (await h.request('/api/clean?mapID=x')).text()).toBe('Error: MapID "x" not found');
    await h.request(ADD);
    h.fetch.mockImplementation(async () => tileResponse(5));
    expect((await h.request('/api/cache/x/0/0/0')).status).toBe(200);
    expect(await (await h.request('/api/stats?mapID=x')).json()).toMatchObject({ count: 1 });
  });

  it('旧 Weiwudi_x を閉じない接続が残るときも、delete は止まらず Deleted: x を返す（旧 DB の削除は次の起動へ回す）', async () => {
    const { factory, connection } = await brokenFactory('Weiwudi_x');
    const h = startSw(factory);
    await h.request(ADD);
    expect(await (await h.request('/api/delete?mapID=x')).text()).toBe('Deleted: x');
    expect(await (await h.request('/api/info?mapID=x')).text()).toBe('Error: MapID "x" not found');
    expect(await versionOf(factory, 'Weiwudi_x')).toBe(1);
    connection.close();
  });
});
