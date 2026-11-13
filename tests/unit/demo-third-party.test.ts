// デモが第三者の配信元に依存する範囲を確かめる。
// - 入口（index.html）と demo/ の各ページの第三者の要素は integrity と crossorigin を持つ
// - ページごとの第三者の要素の数は決まっている（ページを足したら数え直す）
// - demo/ のページは vite.config.demo.js の input に入り、入口からリンクされている
// - デモの Service Worker は第三者から script を読まない（workbox はデモと一緒に配る）
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TAG = /<(script|link)\b[^>]*>/g;
const EXTERNAL = /\b(?:src|href)=["'](?:https?:)?\/\//;
const COPY_TIMEOUT_MS = 30_000;

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf-8');

/** 入口と demo/ の下の HTML（デモのページが増えても数え直す） */
const demoPages = (): string[] => [
  'index.html',
  ...readdirSync(new URL('../../demo', import.meta.url))
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((name) => `demo/${name}`),
];

/** ページごとの第三者の要素の数（増やすときは数え直す。入口には無い） */
const EXTERNAL_COUNTS: Record<string, number> = {
  'index.html': 0,
  'demo/migration.html': 2,
  'demo/raster.html': 2,
  'demo/vector.html': 2,
};

const externalsOf = (page: string): string[] =>
  (read(page).match(TAG) ?? []).filter(
    (tag) => EXTERNAL.test(tag) && !/\brel=["']preconnect["']/.test(tag),
  );

describe('デモの第三者への依存', () => {
  it('入口と demo/ のページが揃っている（表のページと同じ）', () => {
    expect([...demoPages()].sort()).toEqual(Object.keys(EXTERNAL_COUNTS).sort());
    for (const page of demoPages()) {
      expect(existsSync(new URL(`../../${page}`, import.meta.url)), page).toBe(true);
    }
  });

  it('デモのページの第三者の要素は integrity と crossorigin を持つ', () => {
    for (const page of demoPages()) {
      for (const tag of externalsOf(page)) {
        expect(tag, page).toMatch(/\bintegrity="sha384-[A-Za-z0-9+/=]+"/);
        expect(tag, page).toMatch(/\bcrossorigin="anonymous"/);
      }
    }
  });

  it('ページごとの第三者の要素の数は決まっている', () => {
    for (const page of demoPages()) {
      expect(externalsOf(page), page).toHaveLength(EXTERNAL_COUNTS[page]);
    }
  });

  it('demo/ のページはビルドの input に入り、入口からリンクされている', () => {
    const config = read('vite.config.demo.js');
    const index = read('index.html');
    expect(config, 'vite.config.demo.js').toContain("'./index.html'");
    for (const page of demoPages()) {
      if (page === 'index.html') continue;
      expect(config, `vite.config.demo.js に ${page}`).toContain(`'./${page}'`);
      expect(index, `index.html から ${page}`).toContain(`href="./${page}"`);
    }
  });

  it('デモの Service Worker は同じ場所の workbox だけを読む', () => {
    const sw = read('public/demo-sw.js');
    expect(sw).not.toContain('https://');
    expect(sw).toContain("importScripts('./workbox/workbox-sw.js');");
    expect(sw).toContain("workbox.setConfig({ modulePathPrefix: './workbox/' });");
  });

  it('copyWorkbox は workbox の一式を workbox/ の下に置く', async () => {
    const { copyWorkbox } = await import('../../scripts/vite-plugin-copy-workbox.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'weiwudi-workbox-'));
    try {
      await copyWorkbox(dir);
      await copyWorkbox(dir); // 二度目も失敗しない（前の一式を置き換える）
      expect(existsSync(join(dir, 'workbox', 'workbox-sw.js'))).toBe(true);
      expect(existsSync(join(dir, 'workbox', 'workbox-routing.prod.js'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, COPY_TIMEOUT_MS);
});
