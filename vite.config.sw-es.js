import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

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
