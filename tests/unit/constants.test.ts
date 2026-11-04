// constants.ts の値と store.ts の SourceRecord の補助が、m2 までの各ファイルの挙動と同じであることを確かめる（m3-t1・I5）
import { describe, expect, it } from 'vitest';
import { DAY_MS, LEGACY_PREFIX, PSEUDO_HOST, V2_PREFIX } from '../../src/constants';
import { isLegacyRecord, nextOrder, storedSpecOf, templatesOf, type SourceRecord } from '../../src/store';
import type { StoredSpec } from '../../src/spec';

const rec = (over: Partial<SourceRecord>): SourceRecord => ({
  id: 'a', kind: 'raster', spec: {}, order: 1, warnings: [], createdAt: 0, ...over,
});
const spec = { kind: 'raster', id: 'a', templates: ['https://t.example/{z}/{x}/{y}.png'] } as unknown as StoredSpec;

describe('constants', () => {
  it('値は m2 までの各ファイルの定数と同じ', () => {
    expect(PSEUDO_HOST).toBe('weiwudi.example.com');
    expect(LEGACY_PREFIX).toBe('map:');
    expect(DAY_MS).toBe(86400000);
    expect(V2_PREFIX).toBe('/v2/');
  });
});

describe('store の SourceRecord の補助', () => {
  it('isLegacyRecord は kind が legacy か id が map: で始まるとき', () => {
    expect(isLegacyRecord(rec({ kind: 'legacy', id: 'x' }))).toBe(true);
    expect(isLegacyRecord(rec({ id: 'map:x' }))).toBe(true);
    expect(isLegacyRecord(rec({ id: 'x' }))).toBe(false);
  });

  it('storedSpecOf・templatesOf は新 API の spec だけを読み、旧 API は undefined と空', () => {
    expect(storedSpecOf(rec({ spec }))).toBe(spec);
    expect(templatesOf(rec({ spec }))).toEqual(spec.templates);
    expect(storedSpecOf(rec({ kind: 'legacy', spec: {} }))).toBeUndefined();
    expect(storedSpecOf(rec({ kind: 'legacy', spec }))).toBeUndefined();
    expect(storedSpecOf(rec({ spec: {} }))).toBeUndefined();
    expect(templatesOf(rec({ kind: 'legacy', spec: {} }))).toEqual([]);
  });

  it('nextOrder は登録済みの最大 + 1（無ければ 1）', async () => {
    expect(await nextOrder({ listSources: async () => [] })).toBe(1);
    expect(await nextOrder({ listSources: async () => [rec({ order: 3 }), rec({ order: 7 }), rec({ order: 2 })] })).toBe(8);
  });
});
