// constants.ts の値と store.ts の SourceRecord の補助が、m2 までの各ファイルの挙動と同じであることを確かめる（m3-t1・I5）
import { describe, expect, it } from 'vitest';
import { DAY_MS, LEGACY_PREFIX, PSEUDO_HOST, V2_PREFIX } from '../../src/constants';
import { isLegacyRecord, nextOrder, storedSpecOf, templatesOf, type SourceRecord } from '../../src/store';
import type { StoredSpec } from '../../src/spec';

const rec = (over: Partial<SourceRecord>): SourceRecord => ({
  id: 'a', kind: 'raster', spec: {}, order: 1, warnings: [], createdAt: 0, ...over,
});
const spec = { kind: 'raster', type: 'tile', id: 'a', templates: ['https://t.example/{z}/{x}/{y}.png'] } as unknown as StoredSpec;

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

// ---- m4-t1（DROPPED_HEADERS・OWN_PREFIX を core.ts から移した。F24）。追記のみ ----
// 既存の行を変えないため、import はここに足す（import 宣言は巻き上げられる）
import { DROPPED_HEADERS, OWN_PREFIX } from '../../src/constants';

describe('constants（m4-t1）', () => {
  it('保存と合成で落とす 4 ヘッダと自前のヘッダの接頭辞は、m3 までの core.ts の値と同じ', () => {
    expect([...DROPPED_HEADERS]).toEqual(['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie']);
    expect(OWN_PREFIX).toBe('x-weiwudi-');
  });
});
