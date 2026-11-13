import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// /v2/ping が返す版と、上流へ送る User-Agent の Weiwudi/<version>（package.json と同じ。m2-t8・第 1 回 S13）
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

// ユニットテストだけを収集する。tests/e2e/*.spec.js（Playwright）を巻き込まない（Weiwudi#43）
export default defineConfig({
  define: { __WEIWUDI_VERSION__: JSON.stringify(version) },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
