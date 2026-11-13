// デモが第三者の配信元に依存する範囲を確かめる。
// - 入口（index.html）と demo/ の各ページの第三者の要素は integrity と crossorigin を持つ
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

describe('デモの第三者への依存', () => {
  it('入口と demo/ のページが揃っている', () => {
    for (const page of demoPages()) {
      expect(existsSync(new URL(`../../${page}`, import.meta.url)), page).toBe(true);
    }
  });

  it('デモのページの第三者の要素は integrity と crossorigin を持つ', () => {
    for (const page of demoPages()) {
      const externals = (read(page).match(TAG) ?? []).filter(
        (tag) => EXTERNAL.test(tag) && !/\brel=["']preconnect["']/.test(tag),
      );
      for (const tag of externals) {
        expect(tag, page).toMatch(/\bintegrity="sha384-[A-Za-z0-9+/=]+"/);
        expect(tag, page).toMatch(/\bcrossorigin="anonymous"/);
      }
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
