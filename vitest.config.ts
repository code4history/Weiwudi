import { defineConfig } from 'vitest/config';

// ユニットテストだけを収集する。tests/e2e/*.spec.js（Playwright）を巻き込まない（Weiwudi#43）
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
