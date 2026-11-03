import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import dts from 'vite-plugin-dts';

// /v2/ping が返す版（package.json と同じ。m2-t8・第 1 回 S13）
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
    publicDir: false,
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        sourcemap: true,
        lib: {
            entry: './src/weiwudi_gw.ts',
            name: 'Weiwudi_SW',
            formats: ['es'], // ES module only for import usage
            fileName: () => `weiwudi-sw.es.js`
        },
        rollupOptions: {
            external: ['workbox-routing', 'workbox-core'] // Workbox as peer dependency
        }
    },
    define: {
        REVISION: '"202501010000"',
        __WEIWUDI_VERSION__: JSON.stringify(version),
        'process.env.NODE_ENV': '"production"'
    },
    plugins: [
        dts({
            // 入口の d.ts が辿る先（addPlugin・WeiwudiPlugin・ResourceInfo。#36）もすべて出す。
            // 辿れることは tests/dts/check-dts.mjs で確かめる
            include: [
                'src/weiwudi_gw.ts', 'src/weiwudi_gw_logic.ts', 'src/plugins.ts',
                'src/store.ts', 'src/spec.ts', 'src/tile_math.ts',
            ],
            outDir: 'dist'
        })
    ]
});
