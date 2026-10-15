import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
    publicDir: false,
    build: {
        // nov26-m9-t6 S3: base（vite 7）の解決値を明示して保つ（t6 §3.3）
        target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
        cssTarget: ['chrome107', 'edge107', 'firefox104', 'safari16'],
        minify: 'esbuild',
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
            include: ['src/weiwudi_gw.ts', 'src/weiwudi_gw_logic.ts'],
            outDir: 'dist'
        })
    ]
});
