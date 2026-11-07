// m4-t5: real store/control integration; every upstream response is local to the harness.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSwHarness, PAGE_CLIENT_ID } from './sw-harness';
import { createContext } from '../../src/context';
import { createControl } from '../../src/control';
import { installHook } from '../../src/hook';
import { credentialSourceFor } from '../../src/registry';
import type { RangeSpec } from '../../src/spec';
import type { RegionRecord } from '../../src/store';

const TPL = 'https://tiles.example/{z}/{x}/{y}.png';
const GLYPHS = 'https://fonts.example/{fontstack}/{range}.pbf';
const range = (minX: number, maxX = minX): RangeSpec => ({ box: { minX, maxX, minY: 0, maxY: 0 }, minZoom: 2, maxZoom: 2 });
const A = range(0, 1);
const B = range(1, 2);
const SOURCE = { kind: 'raster', id: 's', url: TPL, minZoom: 2, maxZoom: 2 };
const bin = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
const style = { version: 8, sources: { vt: { type: 'vector', tiles: [TPL] } }, glyphs: GLYPHS,
  layers: [{ id: 'label', type: 'symbol', source: 'vt', layout: { 'text-font': ['Noto Sans'] } }] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { ok: boolean; result?: any; error?: { code: string; detail: Record<string, unknown> } };

const setup = async () => {
  const h = createSwHarness();
  h.fetch.mockImplementation(async (req: Request | string) => {
    const url = typeof req === 'string' ? req : req.url;
    return url.endsWith('.json') ? new Response(JSON.stringify(style), { headers: { 'content-type': 'application/json' } }) : bin();
  });
  const ctx = createContext();
  installHook(ctx, () => undefined, { pickCredentialSource: credentialSourceFor });
  const store = await ctx.store();
  const control = createControl(ctx);
  const jobs: Promise<unknown>[] = [];
  const post = async (op: string, body: unknown): Promise<Reply> => {
    const url = new URL(`https://weiwudi.example.com/v2/${op}`);
    const request = new Request(url, { method: 'POST', body: JSON.stringify(body) });
    const event = { clientId: PAGE_CLIENT_ID, waitUntil: (p: Promise<unknown>) => { jobs.push(p); } };
    return (await control.post({ url, request, event } as never)).json();
  };
  const ok = async (op: string, body: unknown) => {
    const reply = await post(op, body);
    expect(reply).toMatchObject({ ok: true });
    return reply.result;
  };
  const settle = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
  const fetch = async (id: string, r: RangeSpec, options: unknown = {}) => {
    const info = await ok('fetchRange', { id, range: r, options });
    await settle();
    expect((await store.getRegion(info.id))!.status).toBe('complete');
    return info.id as string;
  };
  const entries = async (rid = TPL) => (await store.entriesOf(rid, 1000)).metas;
  const pins = async (rid = TPL) => (await entries(rid)).map((e) => [e.x, e.pinned]);
  return { h, ctx, store, post, ok, fetch, settle, entries, pins };
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('releaseRange: geometry and holders (R11/R12)', () => {
  it.each([false, true])('same-source overlap survives; keep=%s controls exclusive body deletion', async (keep) => {
    const e = await setup();
    await e.ok('register', SOURCE);
    const a = await e.fetch('s', A);
    const b = await e.fetch('s', B);
    await e.ok('releaseRange', { id: 's', regionId: a, options: { keep } });
    expect(await e.pins()).toEqual(keep ? [[0, 0], [1, 1], [2, 1]] : [[1, 1], [2, 1]]);
    expect(await e.store.getRegion(a)).toBeUndefined();
    expect(await e.store.getRegion(b)).toMatchObject({ status: 'complete', pinned: true });
  });

  it.each(['complete', 'partial', 'canceled'] as const)('another Source region (%s) protects overlap; shared exclusive-to-region tiles only unpin', async (status) => {
    const e = await setup();
    await e.ok('register', SOURCE);
    await e.ok('register', { ...SOURCE, id: 't' });
    const a = await e.fetch('s', A);
    const b = await e.fetch('t', B);
    await e.store.patchRegion(b, (r) => ({ ...r, status }));
    await e.ok('releaseRange', { id: 's', regionId: a });
    expect(await e.pins()).toEqual([[0, 0], [1, 1], [2, 1]]);
  });

  it('shared style children resolve to parents; the last shared glyph region unpins fontstack records', async () => {
    const e = await setup();
    await e.ok('register', { kind: 'style', id: 's', url: 'https://s.example/s.json' });
    await e.ok('register', { kind: 'style', id: 't', url: 'https://t.example/t.json' });
    const a = await e.fetch('s', A);
    const b = await e.fetch('t', B);
    const resource = (await e.store.getResource(TPL))!;
    expect(resource.sourceIds.every((id) => id !== 's' && id !== 't')).toBe(true);
    const glyph = (await e.store.listResources()).find((r) => r.type === 'glyph')!;
    expect((await e.entries(glyph.id)).map((m) => m.pinned)).toEqual([1]);
    await e.ok('releaseRange', { id: 's', regionId: a });
    expect(await e.pins()).toEqual([[0, 0], [1, 1], [2, 1]]);
    expect((await e.entries(glyph.id)).map((m) => m.pinned)).toEqual([1]);
    await e.ok('releaseRange', { id: 't', regionId: b });
    expect((await e.entries(glyph.id)).map((m) => m.pinned)).toEqual([0]);
    expect(await e.pins()).toEqual([[0, 0], [1, 0], [2, 0]]);
  });

  it.each([false, true])('non-tiles retain pins until last pinned region; pin:false does not protect (keep=%s)', async (keep) => {
    const e = await setup();
    await e.ok('register', { kind: 'style', id: 's', url: 'https://s.example/s.json' });
    const a = await e.fetch('s', A);
    const b = await e.fetch('s', B);
    const c = await e.fetch('s', range(3), { pin: false });
    const nonTiles = (await e.store.listResources()).filter((r) => r.type !== 'tile');
    expect(nonTiles.map((r) => r.type).sort()).toEqual(['glyph', 'style']);
    await e.ok('releaseRange', { id: 's', regionId: a, options: { keep } });
    for (const r of nonTiles) expect((await e.entries(r.id)).every((m) => m.pinned === 1)).toBe(true);
    await e.ok('releaseRange', { id: 's', regionId: b, options: { keep } });
    for (const r of nonTiles) expect((await e.entries(r.id)).map((m) => m.pinned)).toEqual(keep ? [0] : []);
    expect(await e.store.getRegion(c)).toMatchObject({ pinned: false });
  });

  it('TMS uses the same resource coordinates for released and remaining ranges', async () => {
    const e = await setup();
    await e.ok('register', { ...SOURCE, scheme: 'tms' });
    const a = await e.fetch('s', A);
    await e.fetch('s', B);
    expect((await e.entries()).every((m) => m.y === 0)).toBe(true);
    await e.ok('releaseRange', { id: 's', regionId: a });
    expect(await e.pins()).toEqual([[1, 1], [2, 1]]);
  });

  it('release writes at most 200 tile keys per batch', async () => {
    const e = await setup();
    await e.ok('register', { ...SOURCE, minZoom: 4, maxZoom: 4 });
    const a = await e.fetch('s', { box: { minX: 0, maxX: 15, minY: 0, maxY: 15 }, minZoom: 4, maxZoom: 4 });
    const remove = vi.spyOn(e.store, 'deleteEntries');
    await e.ok('releaseRange', { id: 's', regionId: a });
    expect(remove.mock.calls.map(([keys]) => keys.length)).toEqual([200, 56]);
    expect(await e.entries()).toEqual([]);
  });
});

describe('clean/remove and fetch-busy (P1/R47-R49)', () => {
  it('clean(range) deletes only unpinned exclusive tiles; force deletes pins and marks only overlapping own regions partial', async () => {
    const e = await setup();
    await e.ok('register', SOURCE);
    const a = await e.fetch('s', A);
    const b = await e.fetch('s', range(2));
    await e.fetch('s', range(3), { pin: false });
    await e.ok('clean', { id: 's', range: range(1, 3) });
    expect(await e.pins()).toEqual([[0, 1], [1, 1], [2, 1]]);
    await e.ok('clean', { id: 's', range: range(1), options: { force: true } });
    expect(await e.pins()).toEqual([[0, 1], [2, 1]]);
    expect(await e.store.getRegion(a)).toMatchObject({ status: 'partial' });
    expect(await e.store.getRegion(b)).toMatchObject({ status: 'complete' });
  });

  it('force preserves shared tiles, non-tile entries, and the other Source regions', async () => {
    const e = await setup();
    await e.ok('register', { kind: 'style', id: 's', url: 'https://s.example/s.json' });
    await e.ok('register', { kind: 'style', id: 't', url: 'https://t.example/t.json' });
    const a = await e.fetch('s', A);
    const b = await e.fetch('t', B);
    const before = await Promise.all((await e.store.listResources()).map((r) => e.entries(r.id)));
    await e.ok('clean', { id: 's', range: A, options: { force: true } });
    expect(await Promise.all((await e.store.listResources()).map((r) => e.entries(r.id)))).toEqual(before);
    expect(await e.store.getRegion(a)).toMatchObject({ status: 'partial' });
    expect(await e.store.getRegion(b)).toMatchObject({ status: 'complete' });
  });

  it.each(['clean', 'remove'])('%s releases own shared pins but preserves other regions and shared bodies', async (op) => {
    const e = await setup();
    await e.ok('register', SOURCE);
    await e.ok('register', { ...SOURCE, id: 't' });
    await e.fetch('s', A);
    await e.fetch('s', range(3));
    const b = await e.fetch('t', B);
    await e.ok(op, { id: 's' });
    expect(await e.store.listRegions('s')).toEqual([]);
    expect(await e.pins()).toEqual([[0, 0], [1, 1], [2, 1], [3, 0]]);
    expect(await e.store.getRegion(b)).toMatchObject({ status: 'complete' });
    if (op === 'remove') expect(await e.store.getSource('s')).toBeUndefined();
  });

  it('remove unpins range-only shared resources before unlinking owners', async () => {
    const e = await setup();
    await e.ok('register', SOURCE);
    await e.ok('register', { ...SOURCE, id: 't' });
    const resource = (await e.store.getResource(TPL))!;
    await e.store.patchResource(TPL, () => ({ ...resource, sourceIds: ['t'], rangeOnlySourceIds: ['s'] }));
    await e.fetch('s', A);
    await e.fetch('t', B);
    await e.ok('remove', { id: 's' });
    expect(await e.pins()).toEqual([[0, 0], [1, 1], [2, 1]]);
  });

  it('a range-only holder region protects the overlap when releasing the sourceIds holder (R12)', async () => {
    const e = await setup();
    await e.ok('register', SOURCE);
    await e.ok('register', { ...SOURCE, id: 't' });
    const resource = (await e.store.getResource(TPL))!;
    await e.store.patchResource(TPL, () => ({ ...resource, sourceIds: ['s'], rangeOnlySourceIds: ['t'] }));
    const a = await e.fetch('s', A);
    await e.fetch('t', B);
    await e.ok('releaseRange', { id: 's', regionId: a });
    expect(await e.pins()).toEqual([[0, 0], [1, 1], [2, 1]]);
  });

  it('clean() releases all regions and clears exclusive resources', async () => {
    const e = await setup();
    await e.ok('register', SOURCE);
    await e.fetch('s', A);
    await e.ok('clean', { id: 's' });
    expect(await e.entries()).toEqual([]);
    expect(await e.store.listRegions('s')).toEqual([]);
  });

  it('own job blocks releaseRange, both cleans and remove; another Source job permits them; cancel completion permits all', async () => {
    const e = await setup();
    await e.ok('register', SOURCE);
    await e.ok('register', { ...SOURCE, id: 't', url: 'https://t.example/{z}/{x}/{y}.png' });
    const old = await e.fetch('s', A);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    e.h.fetch.mockImplementation(async () => { await gate; return bin(); });
    const running = await e.ok('fetchRange', { id: 's', range: B, options: { concurrency: 1 } });
    await vi.waitFor(() => expect(e.ctx.job?.sourceId).toBe('s'));
    const operations = [['releaseRange', { regionId: old }], ['clean', {}], ['clean', { range: A }], ['remove', {}]] as const;
    for (const [op, extra] of operations) {
      expect(await e.post(op, { id: 's', ...extra })).toMatchObject({ ok: false, error: { code: 'fetch-busy' } });
    }
    await e.ok('clean', { id: 't', range: A });
    await e.ok('clean', { id: 't' });
    const tRegion: RegionRecord = { ...(await e.store.getRegion(old))!, id: 't-region', sourceId: 't' };
    await e.store.putRegion(tRegion);
    await e.ok('releaseRange', { id: 't', regionId: tRegion.id });
    await e.ok('remove', { id: 't' });
    expect(await e.ok('cancel', { id: 's' })).toEqual({ regionId: running.id });
    expect(await e.post('clean', { id: 's' })).toMatchObject({ ok: false, error: { code: 'fetch-busy' } });
    release();
    await e.settle();
    await e.ok('releaseRange', { id: 's', regionId: old, options: { keep: true } });
    await e.ok('clean', { id: 's', range: A });
    await e.ok('clean', { id: 's' });
    await e.ok('remove', { id: 's' });
  });

  it('invalid or foreign regionId is attribute-invalid, including while own job exists', async () => {
    const e = await setup();
    await e.ok('register', SOURCE);
    await e.ok('register', { ...SOURCE, id: 't' });
    const b = await e.fetch('t', B);
    e.ctx.job = { sourceId: 's', label: 's', count: 0, total: 1, error: 0, cancel: false };
    for (const regionId of [undefined, '', 4, 'missing', b]) {
      expect(await e.post('releaseRange', { id: 's', regionId })).toMatchObject({ ok: false,
        error: { code: 'attribute-invalid', detail: { attribute: 'regionId' } } });
    }
  });

  it('100 seeded fetch/release/clean operations preserve count, bytes and pinnedBytes aggregates', async () => {
    const e = await setup();
    await e.ok('register', SOURCE);
    let seed = 0x754312;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let i = 0; i < 100; i++) {
      const choice = random() % 4;
      const x = (random() >>> 8) % 4;
      const regions = await e.store.listRegions('s');
      if (choice < 2 || regions.length === 0) await e.fetch('s', range(x), { pin: (random() & 8) !== 0 });
      else if (choice === 2) await e.ok('releaseRange', { id: 's', regionId: regions[random() % regions.length].id, options: { keep: (random() & 8) !== 0 } });
      else await e.ok('clean', { id: 's', range: range(x), options: { force: (random() & 8) !== 0 } });
      const metas = await e.entries();
      expect(await e.store.getResource(TPL)).toMatchObject({ count: metas.length,
        bytes: metas.reduce((n, m) => n + m.size, 0), pinnedBytes: metas.reduce((n, m) => n + m.pinned * m.size, 0) });
    }
  });
});


describe('release/clean transaction boundaries', () => {
  it('unpins non-tile glyph entries in pages of 200 without skipping records', async () => {
    const e = await setup();
    await e.ok('register', { kind: 'style', id: 's', url: 'https://s.example/s.json' });
    const a = await e.fetch('s', A);
    const glyph = (await e.store.listResources()).find((r) => r.type === 'glyph')!;
    for (let i = 0; i < 201; i++) {
      const key = `${glyph.id}\0font-${i}`;
      await e.store.putEntry({ key, resourceId: glyph.id, size: 3, fetchedAt: 1, accessedAt: 1, pinned: 1 },
        { key, blob: new Blob([new Uint8Array([1, 2, 3])]), headers: {} }, []);
    }
    const pin = vi.spyOn(e.store, 'setPinned');
    await e.ok('releaseRange', { id: 's', regionId: a, options: { keep: true } });
    expect(pin.mock.calls.filter(([keys]) => keys[0]?.startsWith(`${glyph.id}\0`)).map(([keys]) => keys.length)).toEqual([200, 2]);
    expect((await e.entries(glyph.id)).map((m) => m.pinned)).toEqual(Array(202).fill(0));
  });

  it('clean(range) rechecks pins within deleteEntries even if a record became pinned after enumeration', async () => {
    const e = await setup();
    await e.ok('register', SOURCE);
    await e.fetch('s', A, { pin: false });
    const original = e.store.deleteEntries;
    vi.spyOn(e.store, 'deleteEntries').mockImplementationOnce(async (keys, opts) => {
      await e.store.setPinned(keys, 1);
      return original(keys, opts);
    });
    await e.ok('clean', { id: 's', range: A });
    expect(await e.pins()).toEqual([[0, 1], [1, 1]]);
    expect(e.store.deleteEntries).toHaveBeenCalledWith(expect.any(Array), { unpinnedOnly: true });
  });
});
