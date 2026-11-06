// src/control.ts の試験（m2-t8・仕様 §4.1・§5.6・§12）。ハーネスの post と dispatch で SW の外形から確かめる。
// context に触る試験（連続数・表の作り直しの失敗）だけは createControl を直接呼ぶ。
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSwHarness, type SwHarness } from './sw-harness';
import { createContext } from '../../src/context';
import { createControl } from '../../src/control';
import { installHook } from '../../src/hook';
import { credentialSourceFor } from '../../src/registry';
import { openStore, type Store } from '../../src/store';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const TPL = 'https://t.example/{z}/{x}/{y}.png';
const TILE = 'https://t.example/3/1/2.png';
const PKG_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;

const png = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });

const harness = (): SwHarness => {
  const h = createSwHarness();
  h.fetch.mockImplementation(async () => png());
  return h;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string; detail: Record<string, unknown> } };

const call = async (h: SwHarness, op: string, body: unknown = {}): Promise<Reply> => {
  const res = await h.post(`/v2/${op}`, body);
  expect(res!.status).toBe(200);
  expect(res!.headers.get('content-type')).toBe('application/json');
  return res!.json();
};

const ok = async (h: SwHarness, op: string, body: unknown = {}) => {
  const r = await call(h, op, body);
  expect(r).toMatchObject({ ok: true });
  return r.result;
};

const fails = async (h: SwHarness, op: string, body: unknown, code: string) => {
  const r = await call(h, op, body);
  expect(r.ok).toBe(false);
  expect(r.error!.code).toBe(code);
  expect(typeof r.error!.message).toBe('string');
  expect(typeof r.error!.detail).toBe('object');
  return r.error!;
};

/** 照合ルートでタイルを 1 枚取り、保存させる */
const fetchTile = async (h: SwHarness, url = TILE) => {
  const res = await h.dispatch(url);
  expect(res?.headers.get('x-weiwudi-status')).toBe('miss');
};

/** ハーネスの IndexedDB（大域の indexedDB はハーネスが差し替える） */
const storeOf = (_h: SwHarness): Promise<Store> => openStore();

describe('ping（GET /v2/ping。第 2 回 O12）', () => {
  it('疑似ホストの GET のルートの振り分けで control に届き、{ api: 2, version: package.json の版 }', async () => {
    const h = harness();
    const res = await h.dispatch('https://weiwudi.example.com/v2/ping');
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ api: 2, version: PKG_VERSION });
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('/v2/ の他の GET は 404・Not Found。/api/ping は旧 API の Implemented のまま', async () => {
    const h = harness();
    const res = await h.dispatch('https://weiwudi.example.com/v2/register');
    expect(res!.status).toBe(404);
    expect(await res!.text()).toBe('Not Found');
    expect(await (await h.request('/api/ping')).text()).toBe('Implemented');
  });
});

describe('POST の形（仕様 §9）', () => {
  it('未知の op は api-not-found、JSON でない本文は attribute-invalid（どちらも HTTP 200 の { ok: false }）', async () => {
    const h = harness();
    await fails(h, 'nope', {}, 'api-not-found');
    await fails(h, 'register', '{not json', 'attribute-invalid');
    await fails(h, 'source', { id: 3 }, 'attribute-invalid');
  });

  it('疑似ホストの /v2/ 以外への POST は制御のルートに当たらない', async () => {
    const h = harness();
    expect(await h.post('/api/add', {})).toBeUndefined();
  });
});

describe('register（仕様 §5.6・§12）', () => {
  it('成功は SourceInfo。直後の要求から照合ルートで捕捉する（表の作り直し）', async () => {
    const h = harness();
    const info = await ok(h, 'register', { kind: 'raster', id: 's', url: `${TPL}?access_token=pk.x` });
    expect(info).toEqual({
      id: 's', kind: 'raster', url: TPL,
      resources: [{ id: TPL, type: 'tile', templates: [TPL], count: 0, bytes: 0 }],
      warnings: [],
    });
    await fetchTile(h);
  });

  it('冪等: 同じ登録を 2 度しても Resource は 1 つで、結果は同じ', async () => {
    const h = harness();
    const a = await ok(h, 'register', { kind: 'raster', url: TPL });
    const b = await ok(h, 'register', { kind: 'raster', url: TPL });
    expect(b).toEqual(a);
    expect(await (await storeOf(h)).listResources()).toHaveLength(1);
    expect(await ok(h, 'sources')).toHaveLength(1);
  });

  it('同時の 2 つの register は直列に通り、同じテンプレートは 1 つの Resource に合流する（m2-t6 の申し送り）', async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      call(h, 'register', { kind: 'raster', id: 'a', url: TPL }),
      call(h, 'register', { kind: 'raster', id: 'b', url: TPL }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const all = await (await storeOf(h)).listResources();
    expect(all).toHaveLength(1);
    expect(all[0].sourceIds.slice().sort()).toEqual(['a', 'b']);
  });

  it('S-I: 同じ id に credentialParams を足して再登録（自分の Resource に Entry あり）→ 成功し warnings に resource-conflict', async () => {
    const h = harness();
    await ok(h, 'register', { kind: 'raster', id: 's', url: TPL });
    await fetchTile(h);
    const info = await ok(h, 'register', { kind: 'raster', id: 's', url: TPL, credentialParams: ['foo'] });
    expect(info.warnings).toEqual([`resource-conflict: ${TPL}`]);
    // 写しが保存される（source() でも同じ）
    expect((await ok(h, 'source', { id: 's' })).warnings).toEqual([`resource-conflict: ${TPL}`]);
  });

  it('style・asset も受ける（m3-t7 で unsupported-kind は出なくなった）。知らない kind は attribute-invalid', async () => {
    const h = harness();
    h.fetch.mockImplementation(async () => new Response(JSON.stringify({ version: 8, sources: {}, layers: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    expect((await ok(h, 'register', { kind: 'style', url: 'https://s.example/style.json' })).kind).toBe('style');
    expect((await ok(h, 'register', { kind: 'asset', url: 'https://s.example/a.png' })).kind).toBe('asset');
    await fails(h, 'register', { kind: 'video', url: 'https://s.example/a.mp4' }, 'attribute-invalid');
  });

  it('sk. の資格情報は credential-rejected で、credentials ストアにも sources にも何も書かない（第 1 回 C6）', async () => {
    const h = harness();
    await fails(h, 'register', { kind: 'raster', id: 's', url: TPL, credentials: { query: { access_token: 'sk.secret' } } }, 'credential-rejected');
    await fails(h, 'register', { kind: 'raster', id: 's', url: `${TPL}?access_token=sk.secret` }, 'credential-rejected');
    const store = await storeOf(h);
    expect(await store.getCredentials('s')).toBeUndefined();
    expect(await store.listSources()).toEqual([]);
  });

  it('同じ要求に当たる別の照合の形（{x}/{y} と {y}/{x}）は、影になった側の warnings に template-shadowed を書いて保存する', async () => {
    const h = harness();
    const first = await ok(h, 'register', { kind: 'raster', id: 'a', url: TPL });
    const other = 'https://t.example/{z}/{y}/{x}.png';
    const second = await ok(h, 'register', { kind: 'raster', id: 'b', url: other });
    expect(first.warnings).toEqual([]);
    expect(second.warnings).toEqual([`template-shadowed: ${other}`]);
    expect((await ok(h, 'source', { id: 'b' })).warnings).toEqual([`template-shadowed: ${other}`]);
    expect((await ok(h, 'source', { id: 'a' })).warnings).toEqual([]);
    // 関わりの無い登録の warnings に他の Resource の影を入れない（m2-t7 の申し送り）
    expect((await ok(h, 'register', { kind: 'raster', id: 'c', url: 'https://c.example/{z}/{x}/{y}.png' })).warnings).toEqual([]);
  });
});

describe('旧 API の地図と新 API（第 1 回 S6・第 2 回 S-6・O1）', () => {
  const addLegacy = (h: SwHarness) =>
    h.request(`/api/add?mapID=m&type=xyz&url=${encodeURIComponent(TPL)}&width=1024&height=1024`);

  it('mapID が m の地図があるとき、id: m・同じテンプレートで登録しても、旧 API の cache・stats・info は変わらず、新 API は別の Resource', async () => {
    const h = harness();
    await addLegacy(h);
    expect((await h.request('/api/cache/m/2/1/0')).status).toBe(200);
    const stats = await (await h.request('/api/stats?mapID=m')).json();
    const info = await (await h.request('/api/info?mapID=m')).json();

    const src = await ok(h, 'register', { kind: 'raster', id: 'm', url: TPL });
    expect(src.resources.map((r: { id: string }) => r.id)).toEqual([TPL]);
    await fetchTile(h);

    expect(await (await h.request('/api/stats?mapID=m')).json()).toEqual(stats);
    expect(await (await h.request('/api/info?mapID=m')).json()).toEqual(info);
    h.fetch.mockClear();
    expect((await h.request('/api/cache/m/2/1/0')).headers.get('x-weiwudi-status')).toBe('hit');
    expect(h.fetch).not.toHaveBeenCalled();
    const ids = (await (await storeOf(h)).listResources()).map((r) => r.id).sort();
    expect(ids).toEqual([TPL, 'map:m'].sort());
  });

  it('旧 API の地図は source・sources に出ず、stats・update・clean・remove も source-not-found', async () => {
    const h = harness();
    await addLegacy(h);
    expect(await ok(h, 'sources')).toEqual([]);
    for (const op of ['source', 'stats', 'update', 'clean', 'remove']) {
      await fails(h, op, { id: 'map:m' }, 'source-not-found');
      await fails(h, op, { id: 'm' }, 'source-not-found');
    }
    expect((await h.request('/api/info?mapID=m')).status).toBe(200);
  });

  it('新 API で map: の id は attribute-invalid', async () => {
    const h = harness();
    await fails(h, 'register', { kind: 'raster', id: 'map:m', url: TPL }, 'attribute-invalid');
  });
});

describe('source・sources・stats', () => {
  it('source は SourceInfo、無ければ source-not-found（detail に sourceId）', async () => {
    const h = harness();
    await ok(h, 'register', { kind: 'raster', id: 's', url: [TPL, 'https://u.example/{z}/{x}/{y}.png'] });
    const info = await ok(h, 'source', { id: 's' });
    expect(info.url).toEqual([TPL, 'https://u.example/{z}/{x}/{y}.png']);
    const e = await fails(h, 'source', { id: 'x' }, 'source-not-found');
    expect(e.detail).toEqual({ sourceId: 'x' });
  });

  it('sources は登録順の SourceInfo の配列', async () => {
    const h = harness();
    await ok(h, 'register', { kind: 'raster', id: 'b', url: 'https://b.example/{z}/{x}/{y}.png' });
    await ok(h, 'register', { kind: 'vector', id: 'a', url: 'https://a.example/{z}/{x}/{y}.pbf' });
    const list = await ok(h, 'sources');
    expect(list.map((s: { id: string; kind: string }) => [s.id, s.kind])).toEqual([['b', 'raster'], ['a', 'vector']]);
  });

  it('stats は count・size・byResource。範囲の無い Source に total・percent は無い', async () => {
    const h = harness();
    await ok(h, 'register', { kind: 'raster', id: 's', url: TPL });
    await fetchTile(h);
    expect(await ok(h, 'stats', { id: 's' })).toEqual({ count: 1, size: 3, byResource: { [TPL]: { count: 1, bytes: 3 } } });
  });

  it('範囲が決まる Source は total（範囲の枚数）と percent', async () => {
    const h = harness();
    await ok(h, 'register', { kind: 'raster', id: 's', url: TPL, minZoom: 0, maxZoom: 1, box: { minX: 0, maxX: 1, minY: 0, maxY: 1 } });
    await h.dispatch('https://t.example/1/0/0.png');
    const s = await ok(h, 'stats', { id: 's' });
    expect(s).toMatchObject({ count: 1, total: 5, percent: 20 });
  });

  it('範囲だけの Resource も resources に rangeOnly: true で、byResource にも含める（仕様 §5.6）', async () => {
    const h = harness();
    await ok(h, 'register', { kind: 'raster', id: 'a', url: TPL });
    await fetchTile(h);
    // Entry のある Resource に credentialParams を広げて合流 → 拒否して範囲だけ足す
    const b = await ok(h, 'register', { kind: 'raster', id: 'b', url: TPL, credentialParams: ['foo'] });
    expect(b.warnings).toEqual([`resource-conflict: ${TPL}`]);
    expect(b.resources).toEqual([{ id: TPL, type: 'tile', templates: [TPL], count: 1, bytes: 3, rangeOnly: true }]);
    expect((await ok(h, 'stats', { id: 'b' })).byResource).toEqual({ [TPL]: { count: 1, bytes: 3 } });
  });
});

describe('clean・remove（仕様 §5.6。共有の Entry を残す）', () => {
  it('2 つの Source が共有する Resource の Entry は、片方の clean・remove で消えない。単独になれば clean で消える', async () => {
    const h = harness();
    await ok(h, 'register', { kind: 'raster', id: 'a', url: TPL });
    await ok(h, 'register', { kind: 'raster', id: 'b', url: TPL });
    await fetchTile(h);
    const count = async () => (await (await storeOf(h)).getResource(TPL))?.count;

    expect(await ok(h, 'clean', { id: 'a' })).toBeNull();
    expect(await count()).toBe(1);
    expect(await ok(h, 'remove', { id: 'a' })).toBeNull();
    expect(await count()).toBe(1);
    await fails(h, 'source', { id: 'a' }, 'source-not-found');

    await ok(h, 'clean', { id: 'b' });
    expect(await count()).toBe(0);
  });

  it('範囲だけで参照する Source の clean は Entry を消さない', async () => {
    const h = harness();
    await ok(h, 'register', { kind: 'raster', id: 'a', url: TPL });
    await fetchTile(h);
    await ok(h, 'register', { kind: 'raster', id: 'b', url: TPL, credentialParams: ['foo'] });
    await ok(h, 'clean', { id: 'b' });
    expect((await (await storeOf(h)).getResource(TPL))!.count).toBe(1);
  });

  it('remove の後は照合表から外れ、捕捉しない', async () => {
    const h = harness();
    await ok(h, 'register', { kind: 'raster', id: 'a', url: TPL });
    await ok(h, 'remove', { id: 'a' });
    expect(await h.dispatch(TILE)).toBeUndefined();
    expect(await (await storeOf(h)).listResources()).toEqual([]);
  });
});

// ---- context に触る試験（createControl を直接呼ぶ） ----

const direct = (open: () => Promise<Store> = openStore) => {
  createSwHarness();
  const ctx = createContext(open);
  installHook(ctx, () => undefined, { pickCredentialSource: credentialSourceFor });
  const control = createControl(ctx);
  const post = async (op: string, body: unknown): Promise<Reply> => {
    const url = new URL(`https://weiwudi.example.com/v2/${op}`);
    const request = new Request(url, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) });
    return (await control.post({ url, request, event: undefined } as never)).json();
  };
  return { ctx, post };
};

const putTile = async (store: Store, resourceId: string) => {
  const key = `${resourceId}\0` + '3_1_2';
  await store.putEntry({ key, resourceId, z: 3, x: 1, y: 2, size: 3, fetchedAt: 1, accessedAt: 1, pinned: 0 },
    { key, blob: new Blob([new Uint8Array([1, 2, 3])]), headers: {} }, []);
};

describe('update（仕様 §4.5・§5.6）', () => {
  it('corsOk・corslessUntil・corslessStreak を消し、count には触らない', async () => {
    const { ctx, post } = direct();
    expect((await post('register', { kind: 'raster', id: 's', url: TPL })).ok).toBe(true);
    const store = await ctx.store();
    await putTile(store, TPL);
    await store.patchResource(TPL, (m) => ({ ...m, corsOk: true, corslessUntil: Date.now() + 1000 }));
    ctx.corslessStreak.set(TPL, 2);
    const r = await post('update', { id: 's' });
    expect(r.ok).toBe(true);
    const m = await store.getResource(TPL);
    expect(m!.corsOk).toBeUndefined();
    expect(m!.corslessUntil).toBeUndefined();
    expect(m!.count).toBe(1);
    expect(ctx.corslessStreak.has(TPL)).toBe(false);
  });

  it('自分自身の update の衝突は resource-conflict（detail に resourceIds）で、何も変えない', async () => {
    const { ctx, post } = direct();
    await post('register', { kind: 'raster', id: 's', url: TPL });
    const store = await ctx.store();
    await store.patchResource(TPL, (m) => ({ ...m, corsOk: true }));
    ctx.corslessStreak.set(TPL, 2);
    // 同じテンプレートに重なる 2 つ目の Resource（2 つ以上の既存 Resource に重なると合流を拒否する）
    const other = (await store.getResource(TPL))!;
    await store.createResource({ ...other, id: `${TPL}#2`, sourceIds: ['x'] });
    const r = await post('update', { id: 's' });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('resource-conflict');
    expect((r.error!.detail.resourceIds as string[]).slice().sort()).toEqual([TPL, `${TPL}#2`].sort());
    expect((await store.getResource(TPL))!.corsOk).toBe(true);
    expect(ctx.corslessStreak.get(TPL)).toBe(2);
  });

  it('登録の資格情報を持ち越す', async () => {
    const { ctx, post } = direct();
    await post('register', { kind: 'raster', id: 's', url: TPL, credentials: { query: { key: 'pk.1' } } });
    expect((await post('update', { id: 's' })).ok).toBe(true);
    expect(await (await ctx.store()).getCredentials('s')).toEqual({ query: { key: 'pk.1' } });
  });

  it('無い Source は source-not-found', async () => {
    const { post } = direct();
    expect((await post('update', { id: 'x' })).error!.code).toBe('source-not-found');
  });
});

describe('照合表の作り直しの失敗（Ruling）', () => {
  it('登録は成功させ、古い表を捨てて門番に読み直させる', async () => {
    let failing = false;
    const { ctx, post } = direct(async () => {
      const s = await openStore();
      return {
        ...s,
        getCredentials: async (id: string) => {
          if (failing) throw new DOMException('read failed', 'UnknownError');
          return s.getCredentials(id);
        },
      };
    });
    expect((await post('register', { kind: 'raster', id: 'a', url: TPL })).ok).toBe(true);
    expect(ctx.table.current).toBeDefined();
    failing = true;
    const r = await post('register', { kind: 'raster', id: 'b', url: 'https://b.example/{z}/{x}/{y}.png' });
    expect(r.ok).toBe(true);
    expect(r.result.id).toBe('b');
    expect(ctx.table.current).toBeUndefined();
  });
});

describe('影の warnings の保存の失敗（PR #80）', () => {
  it('putSource が失敗しても登録は成功として返す（表の作り直しの失敗と同じ扱い）', async () => {
    let puts = 0;
    const { post } = direct(async () => {
      const s = await openStore();
      return {
        ...s,
        putSource: async (r: Parameters<Store['putSource']>[0]) => {
          puts++;
          // 2 つ目の登録の影の保存（2 つ目の登録の 2 回目の putSource）だけ失敗させる
          if (puts === 3) throw new DOMException('write failed', 'UnknownError');
          return s.putSource(r);
        },
      };
    });
    expect((await post('register', { kind: 'raster', id: 'a', url: TPL })).ok).toBe(true);
    const other = 'https://t.example/{z}/{y}/{x}.png';
    const r = await post('register', { kind: 'raster', id: 'b', url: other });
    expect(puts).toBe(3);
    expect(r.ok).toBe(true);
    expect(r.result.id).toBe('b');
  });
});

describe('直列の待ち行列', () => {
  it('前の op の失敗は次の op に持ち越さない', async () => {
    const { post } = direct();
    const [bad, good] = await Promise.all([
      post('register', { kind: 'nope', url: TPL }),
      post('register', { kind: 'raster', id: 'g', url: TPL }),
    ]);
    expect(bad.ok).toBe(false);
    expect(good.ok).toBe(true);
  });

  it('同時の register と remove は届いた順に処理する（remove が先に走って source-not-found にならない）', async () => {
    const { post } = direct();
    const [reg, rem] = await Promise.all([
      post('register', { kind: 'raster', id: 's', url: TPL }),
      post('remove', { id: 's' }),
    ]);
    expect(reg.ok).toBe(true);
    expect(rem.ok).toBe(true);
    expect((await post('source', { id: 's' })).error!.code).toBe('source-not-found');
  });
});


describe('子 Source は見せない（m3-t2）', () => {
  it('kind: child の記録は sources() に出ず、source・stats・update・clean・remove は source-not-found', async () => {
    const h = harness();
    await ok(h, 'register', { kind: 'raster', id: 'a', url: TPL });
    const store = await storeOf(h);
    const a = (await store.getSource('a'))!;
    const childId = 'p\u0000tile:base';
    await store.putSource({ ...a, id: childId, kind: 'child', parentId: 'p', spec: { ...a.spec, id: childId } });
    expect((await ok(h, 'sources')).map((s: { id: string }) => s.id)).toEqual(['a']);
    for (const op of ['source', 'stats', 'update', 'clean', 'remove']) await fails(h, op, { id: childId }, 'source-not-found');
    expect(await store.getSource(childId)).toBeDefined();
  });
});

describe('m2 の記録（spec.type なし）の update()（m3-t2 L1 M1）', () => {
  it('type の無い記録に update() をかけても成功し、scheme と範囲が残る', async () => {
    const h = harness();
    const box = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
    await ok(h, 'register', { kind: 'raster', id: 'old', url: TPL, scheme: 'tms', minZoom: 0, maxZoom: 1, box });
    const store = await storeOf(h);
    const rec = (await store.getSource('old'))!;
    const m2Spec: Record<string, unknown> = { ...rec.spec };
    delete m2Spec.type;
    await store.putSource({ ...rec, spec: m2Spec as typeof rec.spec });
    const info = await ok(h, 'update', { id: 'old' });
    expect(info.warnings).toEqual([]);
    const r = (await store.listResources())[0];
    expect(r).toMatchObject({ type: 'tile', scheme: 'tms', sourceIds: ['old'] });
    expect(r.extents).toEqual([{ minZoom: 0, maxZoom: 1, box, sourceId: 'old' }]);
    expect((await ok(h, 'stats', { id: 'old' })).total).toBe(5);
  });
});
