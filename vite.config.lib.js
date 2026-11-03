import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

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
    plugins: [
        dts({
            // weiwudi.d.ts が辿る先（errors・新 API の公開の型の spec・store・tile_math。#33・m2-t8）もすべて出す。
            // 辿れることは tests/dts/check-dts.mjs で確かめる
            include: ['src/weiwudi.ts', 'src/errors.ts', 'src/spec.ts', 'src/store.ts', 'src/tile_math.ts'],
            outDir: 'dist',
            insertTypesEntry: true
        })
    ]
});
