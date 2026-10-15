import { defineConfig } from 'vite';

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
            entry: './src/weiwudi_sw.ts',
            name: 'Weiwudi_SW',
            formats: ['umd'], // UMD only for importScripts/CDN usage
            fileName: () => `weiwudi-sw.umd.js`
        },
        rollupOptions: {
            // No external - expects self.workbox at runtime
        }
    },
    define: {
        REVISION: '"202501010000"',
        'process.env.NODE_ENV': '"production"'
    }
});
