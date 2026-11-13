import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import dts from 'vite-plugin-dts';

// 上流へ送る User-Agent の Weiwudi/<version>（package.json と同じ。sw-es・sw-umd・vitest と同じ値）
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
    publicDir: false,
    build: {
        outDir: 'dist',
        sourcemap: true,
        lib: {
            entry: './src/weiwudi.ts',
            name: 'Weiwudi',
            formats: ['umd', 'es'],
            fileName: (format) => `weiwudi.${format}.js`
        }
    },
    define: {
        __WEIWUDI_VERSION__: JSON.stringify(version),
    },
    plugins: [
        dts({
            // weiwudi.d.ts が辿る先（errors・新 API の公開の型の spec・store・tile_math。#33・m2-t8）もすべて出す。
            // 辿れることは tests/dts/check-dts.mjs で確かめる
            include: ['src/weiwudi.ts', 'src/errors.ts', 'src/spec.ts', 'src/store.ts', 'src/tile_math.ts', 'src/user_agent.ts'],
            outDir: 'dist',
            insertTypesEntry: true
        })
    ]
});
